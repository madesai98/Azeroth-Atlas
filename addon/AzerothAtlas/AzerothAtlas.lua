-- Azeroth Atlas
-- Shows your character (and your party), where you are heading and how you can travel to the
-- local "WoW Forever 3D Map" viewer.
--
-- Addons cannot talk to other programs, so the data is drawn as a thin strip of coloured
-- squares along the top-left edge of the game window, and the map's local server reads that
-- strip off the screen. Nothing is sent over the network and the game is not modified.
-- Type /atlas to turn the strip on or off (/atlas help lists what else it can be told).
--
-- Strip format (must match server/strip.js). Squares are BLOCK_W x BLOCK_H physical pixels and
-- each shows one base-8 digit as a colour: red = 4, green = 2, blue = 1 (black = 0, white = 7).
--   7 0 7 0 4 2 1     sync pattern + colour check
--   version(1) layout(1) seq(1) flags(5) map(5) x(8) y(8) facing(4) zoneMap(5) level(2) height(6)
--   [party]   4 x ( flags(1) x(7) y(7) )            when layout has 1
--   [target]  kind(1) map(5) x(8) y(8)              when layout has 4 (your current waypoint: kind 1
--                                                   your guide's step, 2 a journey of your own in
--                                                   Shortest Path Forever, 3 a pin on the game's map,
--                                                   4 a quick waypoint: a Shift-click on that map)
--   [text]    kind(1) key(2) part(1) 9 bytes(24)    when layout has 2 (names and travel facts, a piece per frame)
--   checksum(4)
--   0 7               end marker
-- The strip is only as long as it needs to be: 348 px wide when you are alone with no waypoint,
-- 676 px at most.

local PROTOCOL = 5
local BLOCK_W, BLOCK_H = 4, 6
local HEADER = { 7, 0, 7, 0, 4, 2, 1 }
local TRAILER = { 0, 7 }
local MAX_PARTY = 4
local MAX_BLOCKS = #HEADER + 46 + MAX_PARTY * 15 + 22 + 28 + 4 + #TRAILER

-- player flags
local F_WORLD = 1     -- x / y are world coordinates
local F_ZONE = 2      -- x / y are fractions of the zone map (fallback when world coords are hidden)
local F_INSTANCE = 4  -- inside a dungeon, raid or battleground
local F_DEAD = 8
local F_TAXI = 16
local F_FACING = 32   -- facing is valid
local F_HEIGHT = 64   -- height is valid (only if the game reports one)
local F_INDOORS = 128 -- the game considers you indoors (helps the map pick the right floor)
local F_HORDE = 256   -- your faction (unset = Alliance); decides which creatures count as hostile
-- How you are moving. The game does not report your height, so the map works it out, and these
-- tell it what cannot be seen from a map position: that you are in the air, or in the water.
local F_SWIMMING = 512   -- in water deep enough to swim
local F_FALLING = 1024   -- in the air: jumping or falling
local F_FLYING = 2048    -- flying under your own control (not a flight path: that is F_TAXI)
local F_SUBMERGED = 4096 -- under the surface
local F_MOUNTED = 8192
-- layout
local L_PARTY, L_TEXT, L_TARGET = 1, 2, 4
-- text kinds: a party member's name; your speeds and hearthstone; where your hearthstone is set
-- (its name, and the spot if this addon saw you bind there); the flight points you know;
-- the NPC whose window you last opened; and, a little at a time, your quests: the ones in your
-- log (kind 0) and the ones you have done (kind 1, running on into kind 0 from key 8)
-- (kind 7 has more than the NPC under its other keys: 1 the route mailboxes, 2 the level you
-- chose, 8 the server's clock and from 16 on a boat line each: see Route.lua and Transit.lua)
local T_PARTY, T_STATS, T_BIND, T_BINDPOS, T_FLIGHTS, T_TALK = 2, 3, 4, 5, 6, 7
local Q_LOG, Q_DONE = 0, 1
-- where the waypoint comes from: your guide's step, a journey of your own in Shortest Path
-- Forever, a pin on the game's map (Ctrl-click), a quick waypoint (Shift-click on the map)
local W_GUIDE, W_PATH, W_PIN, W_QUICK = 1, 2, 3, 4
local HEARTHSTONE = 6948

local floor = math.floor
local strbyte, strchar = string.byte, string.char
local TWO_PI = 2 * math.pi
local PARTY_UNITS = { "party1", "party2", "party3", "party4" }

local strip = CreateFrame("Frame", "AzerothAtlasStrip", WorldFrame)
strip:SetFrameStrata("TOOLTIP")
strip:SetFrameLevel(9000)

local squares, shown = {}, {}
for i = 1, MAX_BLOCKS do
  local t = strip:CreateTexture(nil, "OVERLAY")
  if t.SetSnapToPixelGrid then t:SetSnapToPixelGrid(false) end
  if t.SetTexelSnappingBias then t:SetTexelSnappingBias(0) end
  t:Hide()
  squares[i] = t
  shown[i] = -1
end

-- d = digit to show, or -1 to hide the square
local function Paint(i, d)
  if shown[i] == d then return end
  local t = squares[i]
  if d < 0 then
    t:Hide()
  else
    t:SetColorTexture(d >= 4 and 1 or 0, (d % 4) >= 2 and 1 or 0, d % 2, 1)
    if shown[i] < 0 then t:Show() end
  end
  shown[i] = d
end

-- Size the strip so that one unit inside it is exactly one physical screen pixel, whatever
-- the UI scale or window size is (the UI is always 768 units tall).
local function Layout()
  local _, physicalHeight = GetPhysicalScreenSize()
  local parentScale = WorldFrame:GetEffectiveScale()
  if not physicalHeight or physicalHeight <= 0 or not parentScale or parentScale <= 0 then return end
  strip:SetScale((768 / physicalHeight) / parentScale)
  strip:ClearAllPoints()
  strip:SetPoint("TOPLEFT", WorldFrame, "TOPLEFT", 0, 0)
  strip:SetSize(MAX_BLOCKS * BLOCK_W, BLOCK_H)
  for i = 1, MAX_BLOCKS do
    local t = squares[i]
    t:ClearAllPoints()
    t:SetPoint("TOPLEFT", strip, "TOPLEFT", (i - 1) * BLOCK_W, 0)
    t:SetSize(BLOCK_W, BLOCK_H)
  end
end

-- Some values are "secret" to addons in this client: they cannot be compared or used in maths.
-- These helpers turn anything unusable into nil / false instead of raising an error.
local function secret(v)
  return issecretvalue ~= nil and issecretvalue(v)
end
local function plain(v)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end
local function text(v)
  if v == nil or secret(v) or type(v) ~= "string" then return nil end
  return v
end
local function yes(v)
  if v == nil or secret(v) then return false end
  return v == true
end
local function clamp(v, max)
  v = floor(v + 0.5)
  if v < 0 then return 0 end
  if v > max then return max end
  return v
end

-- What this addon's other file (Route.lua, the route drawn in the game) reads and calls.
AzerothAtlas = AzerothAtlas or {}
local shared = AzerothAtlas

-- ---- what we know ---------------------------------------------------------------------------
-- (world, north, west: where you are in yards, for Route.lua; the rest is as the strip sends it)
local player = { flags = 0, map = 0, x = 0, y = 0, z = 0, facing = 0, zone = 0, level = 0, world = false, north = 0, west = 0 }
local party = {}     -- [slot] = { flags, x, y, name }
for i = 1, MAX_PARTY do party[i] = { flags = 0, x = 0, y = 0, name = nil } end
local partyPresent = false
local target = { kind = 0, map = 0, x = 0, y = 0 }
shared.player, shared.target = player, target

-- ---- where you are heading ----------------------------------------------------------------------
-- Four things can name the place you are going to:
--   path   the journey Shortest Path Forever is showing, for as long as that addon is still
--          installed: one of your own or the one it plans to your guide's step;
--   quick  a quick waypoint of this addon's own: a Shift-click on the world map (Guide.lua). It
--          is yours until you reach it, clear it, or something newer takes its place;
--   pin    a pin you put on the game's map yourself (Ctrl-click);
--   guide  the step your guide has you on: this addon's own guide (GuideSteps.lua), or, while
--          Guidelime is switched on, the step its arrow points at - when Shortest Path is not
--          following the guide for you.
-- Two of them are places of your own choosing, and there is only ever one such waypoint: a
-- quick waypoint takes the place of a pin, a pin of a quick waypoint (and a marker dropped on
-- the 3D map of either: Route.lua takes it up as a quick waypoint). A waypoint of your own
-- leads for as long as it is there - you put it there to go to it. Your guide's step leads
-- when you have none. Neither does away with the other: the 3D map sends the route to each,
-- and both are drawn (Route.lua), the one that leads being the one the arrow follows.
-- Clear the journey to a guide's step and there is nothing to head for until the guide moves
-- on, exactly as Shortest Path's own path stays cleared until then.
local GUIDE_OWNER = "Guidelime" -- the name Shortest Path's guide bridge plans its journeys under
local PATH_EVERY = 1            -- seconds between looks at a journey nobody announced a change to
local PATH_WAIT = 10            -- how long to wait for an answer that is "not ready yet"

local function Source(kind)
  return { kind = kind, on = false, map = 0, north = 0, west = 0, at = -1 }
end
-- (cleared: when you last said "clear my route"; what was there then no longer counts)
local heading = { path = Source(W_PATH), pin = Source(W_PIN), guide = Source(W_GUIDE), quick = Source(W_QUICK), waiting = nil, cleared = -1 }
function shared.ClearHeading() heading.cleared = GetTime() end

-- The quick waypoint: a spot in the world, kept through a /reload (and numbered, so that
-- clicking the same spot again counts as a new one).
-- (placed: when it counts as placed, by GetTime - before now for one that was put down on the
-- 3D map a while ago and has only just reached the game; nil for one placed this moment)
local quick = { on = false, map = 0, north = 0, west = 0, serial = 0, placed = nil }
function shared.Quick(map, north, west, placed)
  quick.on, quick.map, quick.north, quick.west, quick.serial, quick.placed = true, map, north, west, quick.serial + 1, placed
  if type(AzerothAtlasCharDB) == "table" then AzerothAtlasCharDB.quick = { map = map, north = north, west = west } end
  -- (one waypoint: a pin on the game's own map from before is done with)
  if C_Map and C_Map.GetUserWaypoint and C_Map.ClearUserWaypoint and C_Map.GetUserWaypoint() then
    pcall(C_Map.ClearUserWaypoint)
    if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, false) end
  end
end
-- When the waypoint of your own that you have now was placed (by GetTime); nil: you have none.
function shared.OwnAt()
  local h, at = heading, nil
  if h.quick.on then at = h.quick.at end
  if h.pin.on and (not at or h.pin.at > at) then at = h.pin.at end
  return at
end
-- Let go of the waypoint of your own, whichever it is.
function shared.OwnOff()
  if quick.on then shared.QuickOff() end
  if C_Map and C_Map.GetUserWaypoint and C_Map.ClearUserWaypoint and C_Map.GetUserWaypoint() then
    pcall(C_Map.ClearUserWaypoint)
    if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, false) end
  end
end
function shared.QuickIs(map, north, west)
  return quick.on and quick.map == map and (quick.north - north) ^ 2 + (quick.west - west) ^ 2 < 1
end
function shared.QuickOff()
  quick.on = false
  if type(AzerothAtlasCharDB) == "table" then AzerothAtlasCharDB.quick = nil end
end

-- A source names a place. `a b c` are three numbers that identify the place; the time kept is
-- when they last changed, and that decides who leads.
local function Says(s, at, kind, map, north, west, a, b, c)
  if s.kind ~= kind or s.a ~= a or s.b ~= b or s.c ~= c then
    s.kind, s.a, s.b, s.c, s.at = kind, a, b, c, at
  end
  s.on, s.map, s.north, s.west = true, map, north, west
end
-- `forget`: naming the same place again later counts as new (a pin put back, a journey planned again)
local function Silent(s, forget)
  s.on = false
  if forget then s.a = nil end
end

-- The world position (map, north, west) of a spot on one of the game's maps, given as 0-1
-- fractions of that map. The last answer is kept, so asking about a spot that has not moved
-- costs nothing.
local function Spot()
  return { uiMap = nil, x = nil, y = nil, map = nil, north = 0, west = 0 }
end
local function World(m, uiMap, x, y)
  uiMap, x, y = plain(uiMap), plain(x), plain(y)
  if not (uiMap and x and y) then return nil end
  if m.map == nil or m.uiMap ~= uiMap or m.x ~= x or m.y ~= y then
    m.map = nil
    if not (C_Map and C_Map.GetWorldPosFromMapPos) then return nil end
    local map, pos = C_Map.GetWorldPosFromMapPos(uiMap, CreateVector2D and CreateVector2D(x, y) or { x = x, y = y })
    map = plain(map)
    if not (map and pos) then return nil end
    local north, west = pos:GetXY()
    north, west = plain(north), plain(west)
    if not (north and west) then return nil end
    m.uiMap, m.x, m.y, m.map, m.north, m.west = uiMap, x, y, map, north, west
  end
  return m.map, m.north, m.west
end

-- For the 3D map, which draws a route to each: every place you could be heading for, said on its
-- own (the one that leads is still `target`). Your guide's step; your own waypoint - the newest
-- of a pin, a quick waypoint and a journey of your own; your body, while you are a ghost; and
-- the quest you are tracking.
local heads = {
  guide = { on = false, map = 0, north = 0, west = 0 }, way = { on = false, map = 0, north = 0, west = 0 },
  corpse = { on = false, map = 0, north = 0, west = 0 }, quest = 0,
}
local corpseSpot = Spot()
local function Corpse()
  if not (UnitIsGhost and yes(UnitIsGhost("player"))) then return nil end
  if not (C_DeathInfo and C_DeathInfo.GetCorpseMapPosition and C_Map and C_Map.GetBestMapForUnit) then return nil end
  local uiMap = plain(C_Map.GetBestMapForUnit("player"))
  if not uiMap then return nil end
  local pos = C_DeathInfo.GetCorpseMapPosition(uiMap)
  if type(pos) ~= "table" or type(pos.GetXY) ~= "function" then return nil end
  local x, y = pos:GetXY()
  return World(corpseSpot, uiMap, x, y)
end
local function TrackedQuest()
  local id = nil
  if C_SuperTrack and C_SuperTrack.GetSuperTrackedQuestID then id = plain(C_SuperTrack.GetSuperTrackedQuestID()) end
  if (not id or id == 0) and GetSuperTrackedQuestID then id = plain(GetSuperTrackedQuestID()) end
  if id and id > 0 and id < 16777216 then return id end
  return 0
end

-- The guide's step: where it is, and the three numbers that name the place. This addon's own
-- guide says so itself. Guidelime shows it as the arrow it draws from: its "wx" runs west and
-- its "wy" north (its map library's convention). The name is the one Shortest Path gives the
-- step - its map and its position to a tenth of a percent - so a step Shortest Path would not
-- plan to again is not a new one here either.
local function GuideStep()
  if shared.GuideGoal then
    local ok, map, north, west, a, b, c = pcall(shared.GuideGoal)
    if ok and map ~= false then
      if map and north and west then return map, north, west, a, b, c end
      return nil
    end
  end
  local arrow = GuidelimeArrow
  local e = type(arrow) == "table" and arrow.element
  if type(e) ~= "table" or e.completed then return nil end
  local north, west, map = plain(e.wy), plain(e.wx), plain(e.instance)
  if not (north and west and map) then return nil end
  local zone, x, y = plain(e.mapID), plain(e.x), plain(e.y)
  if zone and x and y then
    return map, north, west, zone, floor(x * 10 + 0.5), floor(y * 10 + 0.5)
  end
  return map, north, west, map, floor(north + 0.5), floor(west + 0.5)
end

-- The pin on the game's own map, unless Shortest Path put it there: while it leads you it moves
-- that pin from bend to bend of its path, and notes the one it wrote in its saved settings.
local pinSpot, bendSpot = Spot(), Spot()
local function MapPin()
  if not (C_Map and C_Map.GetUserWaypoint) then return nil end
  local point = C_Map.GetUserWaypoint()
  local pos = type(point) == "table" and point.position
  if type(pos) ~= "table" then return nil end
  local uiMap, x, y = plain(point.uiMapID), plain(pos.x), plain(pos.y)
  local map, north, west = World(pinSpot, uiMap, x, y)
  if not map then return nil end
  local bend = type(ShortestPathForeverCharDB) == "table" and ShortestPathForeverCharDB.guideWaypoint
  if type(bend) == "table" then
    local bMap, bNorth, bWest = World(bendSpot, bend.uiMapID, bend.x, bend.y)
    if bMap == map and (bNorth - north) ^ 2 + (bWest - west) ^ 2 <= 2.25 then return nil end
  end
  return map, north, west, uiMap, x, y
end

-- Shortest Path Forever, asked through its public API (ShortestPathForever.API, version 2):
--   Active()            it is leading you now
--   CurrentStop(owner)  the journey under way is the one that addon asked for
--   Ended(owner)        why that addon's last journey ended: "cleared", "replaced", "cancelled", "arrived"
--   Journey()           the journey under way: its goal as a map and 0-1 fractions, and whose it is
--   Subscribe(fn)       told when any of that changes
local path = {
  heard = nil,      -- the API whose changes are being listened for
  told = true,      -- Shortest Path said something changed (or it has not been asked yet)
  readAt = -100,    -- when Journey() was last asked
  state = "none",   -- "none"; "guide": the journey is the one to your guide's step; "known": another
                    -- journey, to map/north/west; "planning": a journey whose goal cannot be read yet
  map = 0, north = 0, west = 0,
  began = nil,      -- when the journey now being planned was first seen
  guiding = false,
  led = false,      -- the journey is another guide's (Shortest Path lets that one lead over Guidelime)
  -- the guide step whose journey you cleared, or replaced with one of your own
  dropAt = nil, da = nil, db = nil, dc = nil,
  goal = Spot(),
}
local function PathChanged() path.told = true end

-- Returns false when Shortest Path is not there to ask.
local function ReadPath(now, ga, gb, gc)
  local p = path
  local api = type(ShortestPathForever) == "table" and ShortestPathForever.API
  if type(api) ~= "table" or type(api.Journey) ~= "function" or type(api.CurrentStop) ~= "function" then
    return false
  end
  if p.heard ~= api then
    p.heard, p.told = api, true
    if type(api.Subscribe) == "function" then pcall(api.Subscribe, PathChanged) end
  end
  p.guiding = type(api.Active) == "function" and api.Active() == true
  local owned = api.CurrentStop(GUIDE_OWNER) ~= nil

  -- A guide step whose journey you cleared, or replaced with your own, is not planned to again
  -- until the guide moves on to another place. A journey Shortest Path ended itself (combat, the
  -- guide between two steps) says nothing about the step.
  if owned then
    p.dropAt, p.da = nil, nil
  elseif type(api.Ended) == "function" then
    local reason, at = api.Ended(GUIDE_OWNER)
    if reason == "cleared" or reason == "replaced" then
      at = at or 0
      if p.dropAt ~= at then p.dropAt, p.da, p.db, p.dc = at, ga, gb, gc end
    else
      p.dropAt, p.da = nil, nil
    end
  end
  if p.da ~= nil and ga ~= nil and not (p.da == ga and p.db == gb and p.dc == gc) then p.da = nil end

  -- (as a ghost the journey under way is the run to your corpse, whoever asked for the one behind it)
  if owned and not yes(UnitIsDeadOrGhost("player")) then
    p.state, p.began, p.led, p.told = "guide", nil, false, true
    return true
  end
  if p.told or p.state == "planning" or now - p.readAt >= PATH_EVERY then
    p.told, p.readAt = false, now
    local journey, why = api.Journey()
    local goal = type(journey) == "table" and journey.goal
    local map, north, west
    if type(goal) == "table" then map, north, west = World(p.goal, goal.map, goal.x, goal.y) end
    local owner = map and text(journey.owner)
    p.led = owner == "RestedXP" or owner == "AdventureGuideForever"
    if owner == GUIDE_OWNER then
      p.state, p.began = "guide", nil
    elseif map then
      p.state, p.map, p.north, p.west = "known", map, north, west
    elseif journey == nil and why == "loading" then
      if p.state ~= "planning" then p.state, p.began = "planning", p.began or now end
    else
      p.state, p.began = "none", nil
    end
  end
  return true
end

local function ReadTarget()
  local now = GetTime()
  local h, p, t = heading, path, target
  local gMap, gNorth, gWest, ga, gb, gc = GuideStep()

  local ok, there = pcall(ReadPath, now, ga, gb, gc)
  if not (ok and there) then
    -- no Shortest Path (or it cannot be asked): the pin and the guide speak for themselves
    p.state, p.began, p.guiding, p.led, p.dropAt, p.da, p.told = "none", nil, false, false, nil, nil, true
  end

  -- the journey
  local wait = false
  if p.state == "guide" then
    if gMap then Says(h.path, now, W_GUIDE, gMap, gNorth, gWest, ga, gb, gc) else wait = true end
  elseif p.state == "known" then
    -- (timed from when it was asked for, not from when its plan was ready)
    Says(h.path, p.began or now, W_PATH, p.map, p.north, p.west, p.map, floor(p.north + 0.5), floor(p.west + 0.5))
    p.began = nil
  elseif p.state == "planning" then
    wait = true
  else
    Silent(h.path, true)
  end
  -- While Shortest Path has a journey it cannot name yet, what was last said stands - but not for ever.
  if wait then
    h.waiting = h.waiting or now
    if now - h.waiting >= PATH_WAIT then
      wait = false
      Silent(h.path, true)
    end
  else
    h.waiting = nil
  end

  -- your own pin: while Shortest Path leads, the game's pin is the one it writes (or an older
  -- one of yours it is about to move), and placing one yourself stops it leading
  local pinned, wMap, wNorth, wWest, wa, wb, wc = false, nil, nil, nil, nil, nil, nil
  if not p.guiding then pinned, wMap, wNorth, wWest, wa, wb, wc = pcall(MapPin) end
  if pinned and wMap then Says(h.pin, now, W_PIN, wMap, wNorth, wWest, wa, wb, wc) else Silent(h.pin, true) end

  -- your quick waypoint
  if quick.on then Says(h.quick, quick.placed or now, W_QUICK, quick.map, quick.north, quick.west, quick.serial, 0, 0) else Silent(h.quick, true) end

  -- the guide's step, when no journey stands for it
  local dropped = p.da ~= nil and p.da == ga and p.db == gb and p.dc == gc
  if gMap and p.state ~= "guide" and not dropped and not (p.led and p.state == "known") then
    Says(h.guide, now, W_GUIDE, gMap, gNorth, gWest, ga, gb, gc)
  else
    Silent(h.guide)
  end

  -- (for the 3D map's routes: each place on its own, whichever of them leads)
  local hd = heads
  hd.guide.on = gMap ~= nil
  if gMap then hd.guide.map, hd.guide.north, hd.guide.west = gMap, gNorth, gWest end
  local own = nil
  if h.quick.on and h.quick.at > h.cleared then own = h.quick end
  if h.pin.on and h.pin.at > h.cleared and (not own or h.pin.at > own.at) then own = h.pin end
  if h.path.on and h.path.kind == W_PATH and h.path.at > h.cleared and (not own or h.path.at > own.at) then own = h.path end
  hd.way.on = own ~= nil
  if own then hd.way.map, hd.way.north, hd.way.west = own.map, own.north, own.west end
  local okc, cMap, cNorth, cWest = pcall(Corpse)
  hd.corpse.on = okc and cMap ~= nil and cNorth ~= nil and cWest ~= nil
  if hd.corpse.on then hd.corpse.map, hd.corpse.north, hd.corpse.west = cMap, cNorth, cWest end
  local okq, quest = pcall(TrackedQuest)
  hd.quest = okq and quest or 0

  if wait then return end
  -- A waypoint of your own leads while it is there: the newest of them (a journey of your own
  -- that Shortest Path shows counts as one). Your guide's step - or the journey Shortest Path
  -- plans to it - leads when you have none.
  local best, since = nil, h.cleared
  if h.path.on and h.path.kind == W_PATH and h.path.at > since then best = h.path end
  if h.quick.on and h.quick.at > since and (not best or h.quick.at > best.at) then best = h.quick end
  if h.pin.on and h.pin.at > since and (not best or h.pin.at > best.at) then best = h.pin end
  -- (one waypoint: a quick one that a newer pin or journey of yours has taken the place of is gone for good)
  if quick.on and best and best ~= h.quick then shared.QuickOff() end
  if not best then
    if h.path.on and h.path.at > since then best = h.path end
    if h.guide.on and h.guide.at > since and (not best or h.guide.at > best.at) then best = h.guide end
  end
  if not best then
    t.kind = 0
    return
  end
  t.kind, t.map = best.kind, clamp(best.map, 32767)
  t.x, t.y = clamp((best.north + 32768) * 128, 16777215), clamp((best.west + 32768) * 128, 16777215)
end

-- ---- travel facts (sent a piece at a time on the text channel) -----------------------------------
-- Flight points are only listed by the game while a flight master's map is open, so they are
-- learned there and kept (per character); ShortestPathForever's own list is used as well.
local function KnownFlights()
  local ids, seen = {}, {}
  local function add(list)
    if type(list) ~= "table" then return end
    for id, known in pairs(list) do
      if known and type(id) == "number" and id > 0 and id < 65536 and not seen[id] then
        seen[id] = true
        ids[#ids + 1] = id
      end
    end
  end
  add(AzerothAtlasCharDB and AzerothAtlasCharDB.taxi)
  add(type(ShortestPathForeverCharDB) == "table" and ShortestPathForeverCharDB.taxi)
  table.sort(ids)
  return ids
end

local function ScanFlightMaster()
  if not (C_TaxiMap and C_TaxiMap.GetAllTaxiNodes and GetTaxiMapID and NumTaxiNodes and TaxiNodeGetType) then return end
  local uiMap = GetTaxiMapID()
  local nodes = uiMap and C_TaxiMap.GetAllTaxiNodes(uiMap)
  if type(nodes) ~= "table" or type(AzerothAtlasCharDB) ~= "table" then return end
  AzerothAtlasCharDB.taxi = AzerothAtlasCharDB.taxi or {}
  local count = NumTaxiNodes()
  for _, node in ipairs(nodes) do
    local slot, id = node.slotIndex, node.nodeID
    if type(slot) == "number" and type(id) == "number" and slot >= 1 and slot <= count then
      -- a point you have is CURRENT (where you stand) or REACHABLE; DISTANT means not discovered
      local kind = TaxiNodeGetType(slot)
      if kind == "CURRENT" or kind == "REACHABLE" then AzerothAtlasCharDB.taxi[id] = true end
    end
  end
end

local function Byte2(v)
  v = clamp(v, 65535)
  return strchar(floor(v / 256), v % 256)
end
local function Byte3(v)
  v = clamp(v, 16777215)
  return strchar(floor(v / 65536), floor(v / 256) % 256, v % 256)
end

-- ---- who you are talking to ---------------------------------------------------------------------
-- When a window opens that only an NPC (or a quest object) opens - a quest, gossip, a shop, a
-- trainer, a flight map, the bank - you are standing next to it. Its id goes to the map, which
-- then knows where it stands, height included: yours. Only the id of a creature or an object is
-- read; never a player or a pet, and nothing the game marks as restricted.
local talk = { id = 0, object = 0, seq = 0, at = -100 }
local function WhoIs(unit)
  if not UnitGUID then return nil end
  local ok, guid = pcall(UnitGUID, unit)
  guid = ok and text(guid) or nil
  if not guid then return nil end
  local kind, _, _, _, _, id = strsplit("-", guid)
  if kind ~= "Creature" and kind ~= "Vehicle" and kind ~= "GameObject" then return nil end
  id = tonumber(id)
  if not id or id <= 0 or id > 16777215 then return nil end
  if kind ~= "GameObject" and UnitPlayerControlled then
    -- (someone's pet or guardian is a creature too, but not one that stands anywhere)
    local ok2, theirs = pcall(UnitPlayerControlled, unit)
    if not ok2 or secret(theirs) or theirs then return nil end
  end
  return id, kind == "GameObject" and 1 or 0
end
local messagesAt = -100
local function Talking()
  local id, object = WhoIs("npc")
  if not id then id, object = WhoIs("questnpc") end
  if not id then return end
  local now = GetTime()
  -- (one conversation often opens several windows in a row: that is still one meeting)
  if id == talk.id and object == talk.object and now - talk.at < 5 then talk.at = now; return end
  talk.id, talk.object, talk.at = id, object, now
  talk.seq = talk.seq % 255 + 1
  messagesAt = -100 -- send it in the next round
end
local TALK_EVENTS = {
  GOSSIP_SHOW = true, QUEST_GREETING = true, QUEST_DETAIL = true, QUEST_PROGRESS = true, QUEST_COMPLETE = true,
  MERCHANT_SHOW = true, TRAINER_SHOW = true, BANKFRAME_OPENED = true, AUCTION_HOUSE_SHOW = true,
  PET_STABLE_SHOW = true, GUILD_REGISTRAR_SHOW = true, PETITION_SHOW = true, BATTLEFIELDS_SHOW = true,
}

-- ---- your quests --------------------------------------------------------------------------------
-- Which quests are in your log (and whether each is ready to hand in) and which you have done,
-- so the map can show what is open to you rather than everything for your level. That is a lot
-- of numbers for a strip a few pixels high, so they go out a little at a time: two "bulk"
-- messages a round, the log first, and the list of quests done packed as the steps between
-- their numbers. Each message says which edition of its list it belongs to and how long that
-- is, so the map only believes a list once every piece of one edition has arrived.
local quests = { bulk = {}, at = 0, log = nil, logSig = "", logGen = 0, done = nil, doneGen = 0, dirty = true, retry = 3, readAt = -1000 }
local LOG_PER_MESSAGE, LOG_MAX, DONE_PER_MESSAGE, DONE_MESSAGES = 11, 44, 34, 120

local function ReadQuestLog()
  local list = {}
  if C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo then
    local n = plain(C_QuestLog.GetNumQuestLogEntries()) or 0
    for i = 1, n do
      local info = C_QuestLog.GetInfo(i)
      if type(info) == "table" and not yes(info.isHeader) and not yes(info.isHidden) then
        local id = plain(info.questID)
        if id and id > 0 and id < 4194304 then
          local state = 0 -- in progress; 1 = ready to hand in; 2 = failed
          if C_QuestLog.IsFailed and yes(C_QuestLog.IsFailed(id)) then state = 2
          elseif C_QuestLog.IsComplete and yes(C_QuestLog.IsComplete(id)) then state = 1 end
          list[#list + 1] = id * 4 + state
        end
      end
    end
  elseif GetNumQuestLogEntries and GetQuestLogTitle then
    local n = plain(GetNumQuestLogEntries()) or 0
    for i = 1, n do
      local _, _, _, isHeader, _, isComplete, _, id = GetQuestLogTitle(i)
      id = plain(id)
      if not yes(isHeader) and id and id > 0 and id < 4194304 then
        isComplete = plain(isComplete)
        list[#list + 1] = id * 4 + (isComplete == 1 and 1 or isComplete == -1 and 2 or 0)
      end
    end
  else
    return nil
  end
  table.sort(list)
  return list
end

-- The quests you have done, as one string: each number as its step up from the one before, in
-- 7-bit pieces, lowest first, the top bit of a byte saying another piece follows.
local function ReadDone()
  local ids
  if C_QuestLog and C_QuestLog.GetAllCompletedQuestIDs then
    ids = C_QuestLog.GetAllCompletedQuestIDs()
  elseif GetQuestsCompleted then
    local t = GetQuestsCompleted()
    if type(t) == "table" then
      ids = {}
      for id, done in pairs(t) do if done then ids[#ids + 1] = id end end
    end
  end
  if type(ids) ~= "table" then return nil end
  local sorted = {}
  for i = 1, #ids do
    local id = plain(ids[i])
    if id and id > 0 and id < 4194304 then sorted[#sorted + 1] = id end
  end
  table.sort(sorted)
  local out, prev = {}, 0
  for i = 1, #sorted do
    local step = sorted[i] - prev
    if step > 0 then
      prev = sorted[i]
      while step >= 128 do
        out[#out + 1] = strchar(128 + step % 128)
        step = floor(step / 128)
      end
      out[#out + 1] = strchar(step)
    end
  end
  return table.concat(out)
end

local function BuildBulk()
  local bulk = {}
  local log = quests.log
  if log then
    local count = math.min(#log, LOG_MAX)
    for chunk = 0, math.max(0, floor((count - 1) / LOG_PER_MESSAGE)) do
      local bytes = { strchar(quests.logGen), strchar(count) }
      for i = chunk * LOG_PER_MESSAGE + 1, math.min(count, (chunk + 1) * LOG_PER_MESSAGE) do bytes[#bytes + 1] = Byte3(log[i]) end
      bulk[#bulk + 1] = { Q_LOG, chunk, table.concat(bytes) }
    end
  end
  local done = quests.done
  if done then
    local n = floor((#done + DONE_PER_MESSAGE - 1) / DONE_PER_MESSAGE)
    if n < 1 then n = 1 end
    if n > DONE_MESSAGES then n = DONE_MESSAGES end
    for chunk = 0, n - 1 do
      local kind, key = Q_DONE, chunk
      if chunk >= 64 then kind, key = Q_LOG, chunk - 64 + 8 end
      bulk[#bulk + 1] = { kind, key, strchar(quests.doneGen) .. strchar(n) .. string.sub(done, chunk * DONE_PER_MESSAGE + 1, (chunk + 1) * DONE_PER_MESSAGE) }
    end
  end
  quests.bulk, quests.at = bulk, 0
end

-- Read your quests again if something has happened to them (and the done list now and then anyway).
local function RefreshQuests()
  local now = GetTime()
  if now - quests.readAt > 300 then quests.dirty = true; if quests.retry < 1 then quests.retry = 1 end end
  if not quests.dirty and quests.retry < 1 then return end
  quests.dirty = false
  local changed = false
  local ok, log = pcall(ReadQuestLog)
  if ok and log then
    local sig = table.concat(log, ",")
    if sig ~= quests.logSig or not quests.log then
      quests.log, quests.logSig = log, sig
      quests.logGen = quests.logGen % 255 + 1
      changed = true
    end
  end
  if quests.retry > 0 then
    -- (asked for a few seconds running after a quest is handed in: the game takes a moment to count it)
    quests.retry = quests.retry - 1
    quests.readAt = now
    local ok2, done = pcall(ReadDone)
    if ok2 and done and done ~= quests.done then
      quests.done = done
      quests.doneGen = quests.doneGen % 255 + 1
      changed = true
    end
  end
  if changed then BuildBulk() end
end
local QUEST_EVENTS = { QUEST_LOG_UPDATE = true, QUEST_ACCEPTED = true, QUEST_REMOVED = true, QUEST_TURNED_IN = true }

-- A place you could be heading for, as nine bytes: said (128), there is one (1), its map, north and west.
local function HeadBytes(s)
  if not s.on then return strchar(128, 0, 0, 0, 0, 0, 0, 0, 0) end
  return strchar(129) .. Byte2(s.map) .. Byte3((s.north + 32768) * 128) .. Byte3((s.west + 32768) * 128)
end

-- The messages to send this round: { kind, key, bytes }.
local messages = {}
local function BuildMessages()
  local list = {}
  -- the level you chose for a waypoint with more than one under it (Route.lua), first: the 3D map is waiting for it
  if shared.ChoiceReport then
    local ok, bytes = pcall(shared.ChoiceReport)
    if ok and type(bytes) == "string" then list[#list + 1] = { T_TALK, 2, bytes } end
  end
  -- how the route's way into the game is doing (Route.lua): which delivery comes next, which one is showing
  if shared.MailReport then
    local ok, bytes = pcall(shared.MailReport)
    if ok and type(bytes) == "string" then list[#list + 1] = { T_TALK, 1, bytes } end
  end
  -- every place you could be heading for (the 3D map draws a route to each): your guide's step,
  -- your own waypoint, your body, and the quest you are tracking
  list[#list + 1] = { T_TALK, 3, HeadBytes(heads.guide) }
  list[#list + 1] = { T_TALK, 4, HeadBytes(heads.way) }
  list[#list + 1] = { T_TALK, 5, HeadBytes(heads.corpse) }
  list[#list + 1] = { T_TALK, 6, strchar(heads.quest > 0 and 129 or 128) .. Byte3(heads.quest) .. strchar(0, 0, 0, 0, 1) }
  -- when the boats, zeppelins and tram run, as far as known (Transit.lua): a few lines a round, in turn
  if shared.TransitReport then
    local ok, reports = pcall(shared.TransitReport)
    if ok and type(reports) == "table" then
      for _, r in ipairs(reports) do list[#list + 1] = { T_TALK, r[1], r[2] } end
    end
  end
  -- the NPC you just met (and how many seconds ago), repeated for half a minute so that it is sure to arrive
  if talk.id > 0 and GetTime() - talk.at < 30 then
    list[#list + 1] = { T_TALK, 0, Byte3(talk.id) .. strchar(talk.seq) .. strchar(talk.object) .. strchar(clamp(GetTime() - talk.at, 255)) }
  end
  if partyPresent then
    for i = 1, MAX_PARTY do
      if party[i].name then list[#list + 1] = { T_PARTY, i, party[i].name } end
    end
  end
  -- speeds (hundredths of a yard per second), hearthstone cooldown (seconds), how many flight points
  local run, swim = 0, 0
  if GetUnitSpeed then
    local _, r, _, w = GetUnitSpeed("player")
    run, swim = plain(r) or 0, plain(w) or 0
  end
  local has, cooldown = 0, 65535
  local count = (C_Item and C_Item.GetItemCount and C_Item.GetItemCount(HEARTHSTONE)) or (GetItemCount and GetItemCount(HEARTHSTONE))
  if plain(count) and count > 0 then
    has = 1
    local start, duration
    if C_Item and C_Item.GetItemCooldown then start, duration = C_Item.GetItemCooldown(HEARTHSTONE)
    elseif C_Container and C_Container.GetItemCooldown then start, duration = C_Container.GetItemCooldown(HEARTHSTONE)
    elseif GetItemCooldown then start, duration = GetItemCooldown(HEARTHSTONE) end
    start, duration = plain(start), plain(duration)
    if start and duration then
      cooldown = duration > 0 and math.max(0, start + duration - GetTime()) or 0
    end
  end
  local flights = KnownFlights()
  list[#list + 1] = { T_STATS, 0, Byte2(run * 100) .. Byte2(swim * 100) .. Byte2(cooldown) .. strchar(has) .. Byte2(#flights) }
  local bind = GetBindLocation and text(GetBindLocation())
  if bind then
    list[#list + 1] = { T_BIND, 0, bind }
    local saved = AzerothAtlasCharDB and AzerothAtlasCharDB.bind
    if type(saved) == "table" and saved.name == bind and saved.x and saved.y then
      list[#list + 1] = { T_BINDPOS, 0, Byte2(saved.map or 0) .. Byte3((saved.x + 32768) * 128) .. Byte3((saved.y + 32768) * 128) .. strchar(1) }
    end
  end
  for chunk = 0, floor((#flights - 1) / 18) do
    local bytes = {}
    for i = chunk * 18 + 1, math.min(#flights, chunk * 18 + 18) do bytes[#bytes + 1] = Byte2(flights[i]) end
    if #bytes > 0 and chunk < 64 then list[#list + 1] = { T_FLIGHTS, chunk, table.concat(bytes) } end
  end
  -- your quests: two pieces a round, in turn
  pcall(RefreshQuests)
  local bulk = quests.bulk
  for _ = 1, math.min(2, #bulk) do
    quests.at = quests.at % #bulk + 1
    list[#list + 1] = bulk[quests.at]
  end
  messages = list
end

local function ReadPlayer()
  local p = player
  p.flags, p.x, p.y, p.z, p.facing, p.zone = 0, 0, 0, 0, 0, 0

  local _, instanceType, _, _, _, _, _, instanceID = GetInstanceInfo()
  p.map = plain(instanceID) or 0
  if text(instanceType) and instanceType ~= "none" then p.flags = p.flags + F_INSTANCE end

  local uiMap = C_Map and C_Map.GetBestMapForUnit and plain(C_Map.GetBestMapForUnit("player"))
  if uiMap then p.zone = clamp(uiMap, 32767) end

  -- World position: X runs north, Y runs west (the same axes the 3D map uses).
  local px, py, pz, positionMap = UnitPosition("player")
  px, py, pz = plain(px), plain(py), plain(pz)
  p.world = false
  if px and py then
    p.world, p.north, p.west = true, px, py
    p.flags = p.flags + F_WORLD
    p.x = clamp((px + 32768) * 128, 16777215)
    p.y = clamp((py + 32768) * 128, 16777215)
    p.map = plain(positionMap) or p.map
    -- Many versions of the game always report a height of exactly 0; only send a real one.
    if pz and pz ~= 0 then
      p.flags = p.flags + F_HEIGHT
      p.z = clamp((pz + 8192) * 8, 262143)
    end
  elseif uiMap and C_Map.GetPlayerMapPosition then
    local pos = C_Map.GetPlayerMapPosition(uiMap, "player")
    if pos then
      local mx, my = pos:GetXY()
      mx, my = plain(mx), plain(my)
      if mx and my then
        p.flags = p.flags + F_ZONE
        p.x = clamp(mx * 16777215, 16777215)
        p.y = clamp(my * 16777215, 16777215)
      end
    end
  end
  p.map = clamp(p.map, 32767)

  local f = plain(GetPlayerFacing())
  if f then
    p.flags = p.flags + F_FACING
    p.facing = floor(f / TWO_PI * 4096 + 0.5) % 4096
  end
  if yes(UnitIsDeadOrGhost("player")) then p.flags = p.flags + F_DEAD end
  if yes(UnitOnTaxi("player")) then p.flags = p.flags + F_TAXI end
  if IsIndoors and yes(IsIndoors()) then p.flags = p.flags + F_INDOORS end
  if IsSwimming and yes(IsSwimming()) then p.flags = p.flags + F_SWIMMING end
  if IsFalling and yes(IsFalling()) then p.flags = p.flags + F_FALLING end
  if IsFlying and yes(IsFlying()) then p.flags = p.flags + F_FLYING end
  if IsSubmerged and yes(IsSubmerged()) then p.flags = p.flags + F_SUBMERGED end
  if IsMounted and yes(IsMounted()) then p.flags = p.flags + F_MOUNTED end
  if UnitFactionGroup and text(UnitFactionGroup("player")) == "Horde" then p.flags = p.flags + F_HORDE end
  p.level = clamp(plain(UnitLevel("player")) or 0, 63)
end

-- Party members: the game shares their position with you, so they can be shown on the map.
local function ReadParty()
  partyPresent = false
  for i = 1, MAX_PARTY do
    local unit, m = PARTY_UNITS[i], party[i]
    m.flags, m.x, m.y = 0, 0, 0
    if yes(UnitExists(unit)) then
      partyPresent = true
      m.flags = 1
      m.name = text(UnitName(unit))
      local x, y, _, map = UnitPosition(unit)
      x, y = plain(x), plain(y)
      -- only meaningful when they are on the same map as you
      if x and y and plain(map) == player.map then
        m.flags = m.flags + 2
        m.x = clamp((x + 32768) * 16, 2097151)
        m.y = clamp((y + 32768) * 16, 2097151)
      end
      if yes(UnitIsDeadOrGhost(unit)) then m.flags = m.flags + 4 end
    else
      m.name = nil
    end
  end
end

-- ---- encoding -------------------------------------------------------------------------------
local digits = {}
local function put(pos, value, count)
  for i = count, 1, -1 do
    local d = value % 8
    digits[pos + i] = d
    value = (value - d) / 8
  end
  return pos + count
end

-- Text channel: one 9-byte piece of one message per frame, cycling through them all.
local textCursor, textPart = 0, 0
local function NextText()
  local now = GetTime()
  if textPart == 0 and (now - messagesAt > 1 or textCursor >= #messages) then
    -- a fresh round once the last one is through (and at most once a second)
    if textCursor >= #messages then textCursor = 0 end
    if now - messagesAt > 1 then messagesAt = now; BuildMessages(); if textCursor >= #messages then textCursor = 0 end end
  end
  if #messages == 0 then return nil end
  if textPart == 0 then textCursor = textCursor % #messages + 1 end
  local m = messages[textCursor]
  local bytes = m[3]
  local len = #bytes
  if len > 36 then len = 36 end
  local parts = floor((len + 8) / 9)
  if parts < 1 then parts = 1 end
  local part = textPart
  local last = part + 1 >= parts
  textPart = last and 0 or part + 1
  return m[1], m[2], part + (last and 4 or 0), bytes, part * 9
end
local seq, lastSum, lastCount, usedBlocks = 0, -1, -1, 0
local function Update(scan)
  ReadPlayer()
  if scan then
    ReadParty()
    ReadTarget()
    -- the route in the game (Route.lua); whatever goes wrong there must not stop the strip
    if shared.Scan then pcall(shared.Scan, GetTime()) end
  end

  local layout = partyPresent and L_PARTY or 0
  if target.kind > 0 then layout = layout + L_TARGET end
  local kind, key, part, name, offset = NextText()
  if kind then layout = layout + L_TEXT end

  local p = player
  local n = 0
  n = put(n, PROTOCOL, 1)
  n = put(n, layout, 1)
  n = put(n, 0, 1)             -- sequence number, filled in below
  n = put(n, p.flags, 5)
  n = put(n, p.map, 5)
  n = put(n, p.x, 8)
  n = put(n, p.y, 8)
  n = put(n, p.facing, 4)
  n = put(n, p.zone, 5)
  n = put(n, p.level, 2)
  n = put(n, p.z, 6)
  if partyPresent then
    for i = 1, MAX_PARTY do
      local m = party[i]
      n = put(n, m.flags, 1)
      n = put(n, m.x, 7)
      n = put(n, m.y, 7)
    end
  end
  if target.kind > 0 then
    n = put(n, target.kind, 1)
    n = put(n, target.map, 5)
    n = put(n, target.x, 8)
    n = put(n, target.y, 8)
  end
  if kind then
    n = put(n, kind, 1)
    n = put(n, key, 2)
    n = put(n, part, 1)
    for g = 0, 2 do
      local b1, b2, b3 = strbyte(name, offset + g * 3 + 1, offset + g * 3 + 3)
      n = put(n, (b1 or 0) * 65536 + (b2 or 0) * 256 + (b3 or 0), 8)
    end
  end

  -- Skip the repaint when nothing changed since the last frame.
  local sum = 0
  for i = 1, n do sum = (sum * 31 + digits[i] + 1) % 4093 end
  if sum == lastSum and n == lastCount then return end
  lastSum, lastCount = sum, n

  seq = (seq + 1) % 8
  digits[3] = seq
  sum = 0
  for i = 1, n do sum = (sum * 31 + digits[i] + 1) % 4093 end
  n = put(n, sum, 4)

  local at = 0
  for i = 1, #HEADER do at = at + 1; Paint(at, HEADER[i]) end
  for i = 1, n do at = at + 1; Paint(at, digits[i]) end
  for i = 1, #TRAILER do at = at + 1; Paint(at, TRAILER[i]) end
  for i = at + 1, usedBlocks do Paint(i, -1) end
  usedBlocks = at
end

local elapsed, tick = 0, 0
strip:SetScript("OnUpdate", function(_, dt)
  elapsed = elapsed + dt
  if elapsed < 0.05 then return end
  elapsed = 0
  tick = tick + 1
  -- position every frame; party five times a second
  local ok = pcall(Update, tick % 4 == 1)
  if not ok then lastSum = -1 end
end)

local function Apply()
  if AzerothAtlasDB.enabled then
    Layout()
    lastSum = -1
    strip:Show()
  else
    strip:Hide()
  end
end

-- /atlas is a short word, and another addon may have it (there is an old and well-known one
-- called Atlas). /azatlas and /azerothatlas are this addon's whatever else is installed; /atlas
-- is taken as well once every addon has loaded, unless another has it - and then it is said, once.
local function ClaimSlash()
  if type(SlashCmdList) ~= "table" then return end
  for name in pairs(SlashCmdList) do
    if name ~= "AZEROTHATLAS" then
      local i = 1
      while true do
        local word = _G["SLASH_" .. tostring(name) .. i]
        if type(word) ~= "string" then break end
        if string.lower(word) == "/atlas" then
          print("|cff7fd4ffAzeroth Atlas|r: another addon uses /atlas. Type /azatlas instead wherever /atlas is named.")
          return
        end
        i = i + 1
      end
    end
  end
  SLASH_AZEROTHATLAS3 = "/atlas"
end

strip:RegisterEvent("PLAYER_LOGIN")
strip:RegisterEvent("PLAYER_ENTERING_WORLD")
strip:RegisterEvent("DISPLAY_SIZE_CHANGED")
strip:RegisterEvent("UI_SCALE_CHANGED")
strip:RegisterEvent("TAXIMAP_OPENED")
strip:RegisterEvent("HEARTHSTONE_BOUND")
-- (registered one at a time: a name this game does not have must not stop the rest)
for event in pairs(TALK_EVENTS) do pcall(strip.RegisterEvent, strip, event) end
for event in pairs(QUEST_EVENTS) do pcall(strip.RegisterEvent, strip, event) end
strip:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" then
    pcall(ClaimSlash)
    if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
    if AzerothAtlasDB.enabled == nil then AzerothAtlasDB.enabled = true end
    if type(AzerothAtlasCharDB) ~= "table" then AzerothAtlasCharDB = {} end
    -- the quick waypoint you had before the /reload
    local q = AzerothAtlasCharDB.quick
    if type(q) == "table" and type(q.map) == "number" and type(q.north) == "number" and type(q.west) == "number" then
      quick.on, quick.map, quick.north, quick.west, quick.serial = true, q.map, q.north, q.west, 1
    end
  elseif event == "TAXIMAP_OPENED" then
    pcall(ScanFlightMaster)
    messagesAt = -100
    pcall(Talking)
    return
  elseif TALK_EVENTS[event] then
    pcall(Talking)
    return
  elseif QUEST_EVENTS[event] then
    quests.dirty = true
    if event == "QUEST_TURNED_IN" then quests.retry = 6 end
    return
  elseif event == "HEARTHSTONE_BOUND" then
    -- you set your hearthstone here: remember the spot under the inn's name
    local x, y, _, map = UnitPosition("player")
    x, y, map = plain(x), plain(y), plain(map)
    local name = GetBindLocation and text(GetBindLocation())
    if x and y and name and type(AzerothAtlasCharDB) == "table" then
      AzerothAtlasCharDB.bind = { name = name, map = map or 0, x = x, y = y }
    end
    messagesAt = -100
    return
  end
  if event == "PLAYER_ENTERING_WORLD" then quests.dirty = true; quests.retry = 3 end
  if AzerothAtlasDB then Apply() end
end)

-- (sends the next round of messages straight away: Route.lua calls it when its report changes)
function shared.Tell() messagesAt = -100 end

SLASH_AZEROTHATLAS1, SLASH_AZEROTHATLAS2 = "/azatlas", "/azerothatlas" -- (and /atlas: see ClaimSlash)
SlashCmdList["AZEROTHATLAS"] = function(msg)
  -- /atlas clear, /atlas route, /atlas status: the route in the game (Route.lua)
  local word, rest = "", ""
  if type(msg) == "string" then
    word, rest = string.match(string.lower(msg), "^%s*(%S*)%s*(%S*)")
    word, rest = word or "", rest or ""
  end
  if word ~= "" then
    if shared.Command then pcall(shared.Command, word, rest) end
    return
  end
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.enabled = not AzerothAtlasDB.enabled
  Apply()
  print("|cff7fd4ffAzeroth Atlas|r: " .. (AzerothAtlasDB.enabled and "on - your position is shown to the 3D map" or "off"))
end
