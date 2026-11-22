-- Azeroth Atlas
-- Shows your character (and your party), where you are heading and how you can travel to the
-- local "WoW Forever 3D Map" viewer.
--
-- Addons cannot talk to other programs, so the data is drawn as a thin strip of coloured
-- squares in a corner of the game window - the top-left one, unless you choose another
-- (Esc > Options > AddOns > Azeroth Atlas, or /atlas strip): the map's local server finds the
-- strip wherever it is and reads it off the screen. Nothing is sent over the network and the
-- game is not modified.
-- Type /atlas to turn the strip on or off (/atlas help lists what else it can be told).
--
-- Strip format (must match server/strip.js). Squares are BLOCK_W x BLOCK_H physical pixels and
-- each shows one base-8 digit as a colour: red = 4, green = 2, blue = 1 (black = 0, white = 7).
--   7 0 7 0 4 2 1     sync pattern + colour check
--   version(1) layout(2) seq(1) flags(6) map(5) x(8) y(8) facing(4) zoneMap(5) level(2) height(6) speed(4) place(5)
--   [party]   4 x ( flags(1) x(7) y(7) )            when layout has 1
--   [target]  kind(1) map(5) x(8) y(8)              when layout has 4 (your current waypoint: kind 1
--                                                   your guide's step, 2 a journey of your own in
--                                                   Shortest Path Forever, 3 a pin on the game's map,
--                                                   4 a quick waypoint: a Shift-click on that map)
--   [text]    kind(1) key(2) part(1) 9 bytes(24)    when layout has 2 (names and travel facts, a piece per frame)
--   (layout has 16: you are in a fight - nothing follows for it)
--   [fix]     seq(1) 2 x ( kind(1) id(5) h(5) d(4) ) when layout has 8 (your height as the game measured it:
--                                                   Height.lua. For each of two places - kind 1 a flight
--                                                   master, 2 a landmark, 0 none, and 4 more where your
--                                                   spot was had finely; id the game's number for
--                                                   it - h is how far above or below it you are, in 16ths
--                                                   of a yard, and d how far off it is, in 8 yards. Drawn
--                                                   for three seconds after each fix; seq counts them, 1 to 7)
--   checksum(4)
--   0 7               end marker
-- The strip is only as long as it needs to be: 392 px wide when you are alone with no waypoint
-- (516 px for the three seconds after a fix), 844 px at most.
-- (speed: how fast the game says you are moving, in 32nds of a yard a second; place: what the
-- game calls the place you stand in - the words over its minimap - boiled down to a number,
-- 0 for none. Both, the fix and the second digit of the layout are there since version 6, for
-- the 3D map to tell how high you are by.)

local PROTOCOL = 6
local BLOCK_W, BLOCK_H = 4, 6
local HEADER = { 7, 0, 7, 0, 4, 2, 1 }
local TRAILER = { 0, 7 }
local MAX_PARTY = 4
local MAX_BLOCKS = #HEADER + 57 + MAX_PARTY * 15 + 22 + 28 + 31 + 4 + #TRAILER

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
-- (since version 6: the strip has room for 18 such flags)
local F_JUMPED = 16384   -- in the air, and it began with a jump (a fall that began with a step off a ledge does not have it)
local F_ASCEND = 32768   -- the key that takes you up is held down (in water: you are rising)
local F_DESCEND = 65536  -- the key that takes you down is held down (in water: you are sinking)
local F_SPEED = 131072   -- speed is valid: the game says how fast you are moving
-- layout
local L_PARTY, L_TEXT, L_TARGET, L_FIX = 1, 2, 4, 8
-- (One thing in the layout is not about what follows: you are in a fight. The eighteen flags are
-- all taken, the layout's second digit has room, and a map from before this - which looks in
-- the layout for the four above and nothing else - simply does not see it. Said for the map's
-- overlays over the game, which fade and let clicks through while you fight.)
local L_COMBAT = 16
-- text kinds: a party member's name; your speeds and hearthstone (and, from key 8 of that kind
-- on, who your character is - class, race, professions, standings: Self.lua); where your hearthstone is set
-- (its name, and the spot if this addon saw you bind there); the flight points you know;
-- the NPC whose window you last opened; and, a little at a time, your quests: the ones in your
-- log (kind 0; under its keys 4 to 7, how far those of them have got that are part done: see
-- quests.Goals) and the ones you have done (kind 1, running on into kind 0 from key 8)
-- (kind 7 has more than the NPC under its other keys: 1 the route mailboxes, 2 the level you
-- chose, 8 the server's clock and from 16 on a boat line each: see Route.lua and Transit.lua;
-- 9 where the game's minimap is on the screen: see MinimapReport; 10 the quests you have just
-- handed in: see HandedBytes; 11 to 14 where the game's interface is on the screen: Windows.lua)
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
-- Over everything else the game's interface draws: in the topmost layer there is, at the top
-- of it (said again every couple of seconds, should anything else have a say in it). What is
-- drawn over the game from outside it - another program's overlay - cannot be got on top of:
-- for that the strip can be moved (see Placement).
local TOP_LEVEL = 10000 -- (the highest a frame can be given; a game that will not have it is given the next best)
local function OnTop()
  if strip:GetFrameStrata() ~= "TOOLTIP" then strip:SetFrameStrata("TOOLTIP") end
  if strip:GetFrameLevel() ~= TOP_LEVEL then
    if not pcall(strip.SetFrameLevel, strip, TOP_LEVEL) then
      TOP_LEVEL = 9000
      strip:SetFrameLevel(TOP_LEVEL)
    end
  end
end
strip:SetFrameStrata("TOOLTIP")
OnTop()

local squares, shown = {}, {}
for i = 1, MAX_BLOCKS do
  local t = strip:CreateTexture(nil, "OVERLAY", nil, 7)
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

-- Where the strip is: a corner of the game window, and how many screen pixels in from it
-- (across, and down or up). The top-left corner unless you have chosen otherwise.
local CORNERS = { TOPLEFT = "top left", TOPRIGHT = "top right", BOTTOMLEFT = "bottom left", BOTTOMRIGHT = "bottom right" }
local function Placement()
  local at = type(AzerothAtlasDB) == "table" and type(AzerothAtlasDB.strip) == "table" and AzerothAtlasDB.strip or nil
  local corner = at and type(at.corner) == "string" and CORNERS[at.corner] and at.corner or "TOPLEFT"
  local x, y = floor((at and tonumber(at.x) or 0) + 0.5), floor((at and tonumber(at.y) or 0) + 0.5)
  if x < 0 then x = 0 end
  if y < 0 then y = 0 end
  return corner, x, y
end

-- Size the strip so that one unit inside it is exactly one physical screen pixel, whatever
-- the UI scale or window size is (the UI is always 768 units tall).
local function Layout()
  local physicalWidth, physicalHeight = GetPhysicalScreenSize()
  local parentScale = WorldFrame:GetEffectiveScale()
  if not physicalHeight or physicalHeight <= 0 or not parentScale or parentScale <= 0 then return end
  strip:SetScale((768 / physicalHeight) / parentScale)
  -- (no further in from its corner than leaves all of it on the screen)
  local corner, x, y = Placement()
  local wide, high = MAX_BLOCKS * BLOCK_W, BLOCK_H
  if physicalWidth and physicalWidth > wide and x > physicalWidth - wide then x = physicalWidth - wide end
  if physicalHeight > high and y > physicalHeight - high then y = physicalHeight - high end
  local right, low = corner == "TOPRIGHT" or corner == "BOTTOMRIGHT", corner == "BOTTOMLEFT" or corner == "BOTTOMRIGHT"
  strip:ClearAllPoints()
  strip:SetPoint(corner, WorldFrame, corner, right and -x or x, low and y or -y)
  strip:SetSize(wide, high)
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

-- ---- its own notes ----------------------------------------------------------------------------
-- What the addon did and why, a short line each: a mailbox opened and what was in it, the route
-- taken or not, the quest you track moving on, anything that went wrong. The last few hundred
-- are kept with what the addon saves for the character (AzerothAtlasCharDB.log), which the game
-- writes to the disk when you log out or type /reload. Nobody reads them but "Report a
-- problem" on the 3D map, which packs them for whoever looks into what went wrong.
-- A line: the time of day (as this computer's clock has it, in seconds), the game's own clock,
-- and what happened. /atlas log shows the last of them.
local LOG_MAX = 400
local logged = nil   -- AzerothAtlasCharDB.log, once what the addon saved has been read: { at (where the next line goes), [1..LOG_MAX] }
local early = {}     -- what was noted before that
function shared.Log(what)
  local line = time() .. " " .. string.format("%.1f", GetTime()) .. " " .. string.sub(tostring(what), 1, 240)
  if not logged then
    if #early < 60 then early[#early + 1] = line end
    return
  end
  local at = tonumber(logged.at) or 1
  if at < 1 or at > LOG_MAX then at = 1 end
  logged[at] = line
  logged.at = at % LOG_MAX + 1
end
-- (once what the addon saved is there: the notes go on where they were, and what was noted before goes in first)
local function OpenLog()
  if logged or type(AzerothAtlasCharDB) ~= "table" then return end
  if type(AzerothAtlasCharDB.log) ~= "table" then AzerothAtlasCharDB.log = { at = 1 } end
  logged = AzerothAtlasCharDB.log
  for _, line in ipairs(early) do
    local at = tonumber(logged.at) or 1
    if at < 1 or at > LOG_MAX then at = 1 end
    logged[at] = line
    logged.at = at % LOG_MAX + 1
  end
  early = {}
end
-- The last lines, the oldest first (/atlas log).
function shared.LastLog(count)
  local out = {}
  if not logged then return early end
  local at = tonumber(logged.at) or 1
  for i = LOG_MAX - 1, 0, -1 do
    local line = logged[(at - 1 - i - 1) % LOG_MAX + 1]
    if type(line) == "string" then out[#out + 1] = line end
  end
  while #out > count do table.remove(out, 1) end
  return out
end

-- Much of what the addon does is done so that a mistake in it cannot stop the rest (pcall). A
-- mistake caught that way is seen by nobody - the route simply stays as it was. So it is noted:
-- the first time it happens, and again at the tenth, the hundredth, the thousandth.
local wrong, wrongs = {}, 0
local function Caught(what, ok, ...)
  if not ok then
    local key = what .. ": " .. tostring((...))
    local n = wrong[key]
    if not n and wrongs >= 40 then return ok, ... end -- (enough kinds of mistake noted: no list without end)
    if not n then wrongs = wrongs + 1 end
    n = (n or 0) + 1
    wrong[key] = n
    if n == 1 or n == 10 or n == 100 or n == 1000 then shared.Log("ERROR " .. (n > 1 and ("(" .. n .. " times) ") or "") .. key) end
  end
  return ok, ...
end
-- As pcall: f(...) run, true and what it gave back - or false and what went wrong, noted under `what`.
function shared.Try(what, f, ...) return Caught(what, pcall(f, ...)) end

-- ---- what we know ---------------------------------------------------------------------------
-- (world, north, west: where you are in yards, for Route.lua; the rest is as the strip sends it)
local player = { flags = 0, map = 0, x = 0, y = 0, z = 0, facing = 0, zone = 0, level = 0, speed = 0, place = 0, world = false, north = 0, west = 0 }

-- The keys that take you up and down. The game does not say how high you are, and the 3D map
-- works it out: for that it helps to know that a spell in the air began with a jump (you rise
-- before you fall), and, in water, whether you are holding the key that takes you up or the one
-- that takes you down. Nothing is done with the keys: they are only seen going down and up, the
-- way the game lets any addon see them.
local keys = { jumpAt = -100, up = false, down = false, air = false, jumped = false }
do
  local function see(name, fn)
    if hooksecurefunc and type(_G[name]) == "function" then pcall(hooksecurefunc, name, fn) end
  end
  see("JumpOrAscendStart", function() keys.jumpAt = GetTime(); keys.up = true end)
  see("AscendStop", function() keys.up = false end)
  see("SitStandOrDescendStart", function() keys.down = true end)
  see("DescendStop", function() keys.down = false end)
end

-- What the game calls the place you stand in, as a number from 1 to 32749 (0: it says nothing).
-- The 3D map works the same number out for every room it knows (server/strip.js, placeNumber).
local placeText, placeNumber = nil, 0
local function Place()
  local name = GetMinimapZoneText and GetMinimapZoneText() or nil
  if name == nil or (issecretvalue ~= nil and issecretvalue(name)) or type(name) ~= "string" then name = "" end
  if name ~= placeText then
    local h = 0
    for i = 1, #name do h = (h * 31 + string.byte(name, i)) % 32749 end
    placeText, placeNumber = name, (#name > 0) and (h + 1) or 0
  end
  return placeNumber
end
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
--   guide  the step your guide has you on: the guide addon you run - Guidelime or RestedXP -
--          as GuideSources.lua reads it, when Shortest Path is not following the guide for you.
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
  -- ghost: you are one, whether or not the game says where your body is (in a dungeon new to
  -- this game it does not: the 3D map then leads to the dungeon's door all the same)
  ghost = false,
  -- how far that quest has got (see QuestProgress): qsaid, the game says so; qstate: 0 under way,
  -- 1 ready to hand in, 2 failed; qn: how many things it asks for; qdone: which of them are done
  -- (a bit each, the first the lowest); qkinds: what each is (two bits each)
  qsaid = false, qstate = 0, qn = 0, qdone = 0, qkinds = 0,
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
local trackedLast = 0
local function TrackedQuest()
  -- (while the game's marker is pointed elsewhere for a moment, to measure your height by - Height.lua -
  -- the quest you track is the one it was on, and will be on again)
  if shared.measuring then return trackedLast end
  local id = nil
  if C_SuperTrack and C_SuperTrack.GetSuperTrackedQuestID then id = plain(C_SuperTrack.GetSuperTrackedQuestID()) end
  if (not id or id == 0) and GetSuperTrackedQuestID then id = plain(GetSuperTrackedQuestID()) end
  trackedLast = id and id > 0 and id < 16777216 and id or 0
  return trackedLast
end
-- How far a quest in your log has got, as the game's own list of what it asks for has it:
-- whether it is ready to hand in (1) or failed (2), how many things it asks for, which of them
-- are done (a bit each, the first the lowest) and what kind each is (two bits each: 1 a
-- creature, 2 an item, 3 an object, 0 anything else). The 3D map leads you to what is still to
-- do, not to what is done. Nothing is returned where the game does not say (or the quest asks
-- for more than eight things): the 3D map then goes by the quest log alone, as it did.
local GOAL_KIND = { monster = 1, item = 2, object = 3 }
local GOALS_MAX = 8
local function QuestProgress(id)
  local state, n, done, kinds = 0, 0, 0, 0
  local function goal(kind, finished)
    if yes(finished) then done = done + 2 ^ n end
    kinds = kinds + (GOAL_KIND[text(kind) or ""] or 0) * 4 ^ n
    n = n + 1
  end
  if C_QuestLog and C_QuestLog.GetQuestObjectives then
    if C_QuestLog.IsFailed and yes(C_QuestLog.IsFailed(id)) then state = 2
    elseif C_QuestLog.IsComplete and yes(C_QuestLog.IsComplete(id)) then state = 1 end
    local goals = C_QuestLog.GetQuestObjectives(id)
    if type(goals) ~= "table" then return nil end
    if #goals > GOALS_MAX then return nil end
    for k = 1, #goals do
      local o = goals[k]
      if type(o) ~= "table" then return nil end
      goal(o.type, o.finished)
    end
  elseif GetQuestLogIndexByID and GetNumQuestLeaderBoards and GetQuestLogLeaderBoard and GetQuestLogTitle then
    local index = plain(GetQuestLogIndexByID(id))
    if not index or index < 1 then return nil end
    local _, _, _, _, _, complete = GetQuestLogTitle(index)
    complete = plain(complete)
    state = complete == 1 and 1 or complete == -1 and 2 or 0
    local count = plain(GetNumQuestLeaderBoards(index)) or 0
    if count > GOALS_MAX then return nil end
    for k = 1, count do
      local _, kind, finished = GetQuestLogLeaderBoard(k, index)
      goal(kind, finished)
    end
  else
    return nil
  end
  return state, n, done, kinds
end

-- The guide's step: where it is, and the three numbers that name the place. It is the step the
-- guide addon you run has you on (GuideSources.lua: Guidelime or RestedXP, read from the arrow
-- each points at its step's spot). The name is the one Shortest Path gives a step - its map and
-- its position to a tenth of a percent - so a step Shortest Path would not plan to again is not
-- a new one here either.
local function GuideStep()
  if not shared.GuideGoal then return nil end
  local ok, map, north, west, a, b, c = shared.Try("guide goal", shared.GuideGoal)
  if ok and map and north and west then return map, north, west, a, b, c end
  return nil
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
  hd.ghost = UnitIsGhost ~= nil and yes(UnitIsGhost("player"))
  if hd.corpse.on then hd.corpse.map, hd.corpse.north, hd.corpse.west = cMap, cNorth, cWest end
  local okq, quest = pcall(TrackedQuest)
  hd.quest = okq and quest or 0
  local okp, state, n, done, kinds = false, nil, nil, nil, nil
  if hd.quest > 0 then okp, state, n, done, kinds = pcall(QuestProgress, hd.quest) end
  hd.qsaid = okp and state ~= nil
  if hd.qsaid then hd.qstate, hd.qn, hd.qdone, hd.qkinds = state, n, done, kinds else hd.qstate, hd.qn, hd.qdone, hd.qkinds = 0, 0, 0, 0 end

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

-- ---- where the game's minimap is on the screen ------------------------------------------------
-- Inside a dungeon the game tells an addon which dungeon it is and nothing of where you are in
-- it. Its minimap shows that all the same, and the 3D map reads it off the picture of the game
-- window, as it reads the strip (server/minimap.js). For that it has to know where on the
-- screen the minimap is, to a pixel. So it is said here: the middle of the minimap's own frame
-- and half its width and height, in pixels of the screen counted from the top left corner; how
-- far it is zoomed in, and how many yards it shows from its middle to its edge; whether it
-- turns with you; whether it is round. All of it is only read: nothing about the minimap is
-- changed.
--
-- Nobody could try this in the game before it was sent out, so it is written to do no harm:
-- every call into the game is made so that a refusal cannot stop the strip (pcall), and what
-- the game hands out as a "secret" - it does, of some things, in a fight and in a dungeon - is
-- left alone. Where the frame is on the screen is only asked outside a fight; in one, and
-- wherever the game will not say, the last figures that were good are said again. (The 3D map
-- does not take them on trust either: it looks for the minimap's rim on the picture.)
-- Nine bytes twice over: what is said (128 said at all, 1 where it is, 2 it turns with you,
-- 4 it is round, 8 its shape is known, 16 it is shown, 32 its zoom, 64 whether it turns), the
-- middle across and down (eighths of a pixel), half the width and half the height (32nds), the
-- zoom (and how many steps of it there are, times 16), the yards to its edge (16ths), the
-- screen's width and height in pixels, a spare byte, and 1.
shared.minimap = { known = false, cx = 0, cy = 0, hw = 0, hh = 0, zoom = -1, levels = 0, reach = 0, round = true, shown = false, sw = 0, sh = 0 }
function shared.MinimapReport()
  local m = shared.minimap
  local map = _G.Minimap
  local frame = type(map) == "table" and map or nil
  local fighting = false
  if InCombatLockdown then
    local ok, v = pcall(InCombatLockdown)
    fighting = not (ok and not secret(v) and v == false)
  end
  if frame and not fighting then
    local sw, sh, left, bottom, width, height
    if GetPhysicalScreenSize then
      local ok, a, b = pcall(GetPhysicalScreenSize)
      if ok then sw, sh = plain(a), plain(b) end
    end
    -- (as the screen has it: the frame's own figures times its scale)
    if type(frame.GetScaledRect) == "function" then
      local ok, a, b, c, d = pcall(frame.GetScaledRect, frame)
      if ok then left, bottom, width, height = plain(a), plain(b), plain(c), plain(d) end
    end
    if not (left and bottom and width and height) and type(frame.GetRect) == "function" and type(frame.GetEffectiveScale) == "function" then
      local ok, a, b, c, d = pcall(frame.GetRect, frame)
      local ok2, scale = pcall(frame.GetEffectiveScale, frame)
      scale = ok2 and plain(scale) or nil
      a, b, c, d = plain(a), plain(b), plain(c), plain(d)
      if ok and scale and a and b and c and d then left, bottom, width, height = a * scale, b * scale, c * scale, d * scale end
    end
    if sw and sh and sh > 0 and left and bottom and width and height and width > 0 and height > 0 then
      -- (the interface is 768 units high whatever the screen is: so many pixels to a unit)
      local k = sh / 768
      m.known = true
      m.cx, m.cy = (left + width / 2) * k, sh - (bottom + height / 2) * k
      m.hw, m.hh = width / 2 * k, height / 2 * k
      m.sw, m.sh = sw, sh
    end
  end
  if frame then
    if type(frame.GetZoom) == "function" then
      local ok, v = pcall(frame.GetZoom, frame)
      v = ok and plain(v) or nil
      if v and v >= 0 then m.zoom = v end
    end
    if type(frame.GetZoomLevels) == "function" then
      local ok, v = pcall(frame.GetZoomLevels, frame)
      v = ok and plain(v) or nil
      if v and v >= 0 then m.levels = v end
    end
    if type(frame.IsVisible) == "function" then
      local ok, v = pcall(frame.IsVisible, frame)
      if ok and not secret(v) then m.shown = v == true end
    end
  end
  if C_Minimap and C_Minimap.GetViewRadius then
    local ok, v = pcall(C_Minimap.GetViewRadius)
    v = ok and plain(v) or nil
    if v and v > 0 then m.reach = v end
  end
  -- whether it turns with you: the game's own setting (and its say on whether that is heeded here)
  local setting = (C_CVar and C_CVar.GetCVar) or GetCVar
  if setting then
    local ok, v = pcall(setting, "rotateMinimap")
    v = ok and text(v) or nil
    if v then m.turns = v == "1" end
  end
  if m.turns and C_Minimap and C_Minimap.IsRotateMinimapIgnored then
    local ok, v = pcall(C_Minimap.IsRotateMinimapIgnored)
    if ok and yes(v) then m.turns = false end
  end
  -- its shape: round, as the game draws it - unless an addon that reshapes it says otherwise (the way such addons say it)
  m.round = true
  if type(GetMinimapShape) == "function" then
    local ok, v = pcall(GetMinimapShape)
    v = ok and text(v) or nil
    if v then m.round = v == "ROUND" end
  end
  local said = 128 + 8 + (m.known and 1 or 0) + (m.turns and 2 or 0) + (m.round and 4 or 0) + (m.shown and 16 or 0) + (m.zoom >= 0 and 32 or 0) + (m.turns ~= nil and 64 or 0)
  return strchar(said) .. Byte2(m.cx * 8) .. Byte2(m.cy * 8) .. Byte2(m.hw * 32) .. Byte2(m.hh * 32)
    .. strchar(clamp(m.zoom >= 0 and m.zoom or 0, 15) + clamp(m.levels, 15) * 16) .. Byte2(m.reach * 16) .. Byte2(m.sw) .. Byte2(m.sh) .. strchar(0, 1)
end

-- ---- who you are talking to ---------------------------------------------------------------------
-- When a window opens that only an NPC (or a quest object) opens - a quest, gossip, a shop, a
-- trainer, a flight map, the bank - you are standing next to it. Its id goes to the map, which
-- then knows where it stands, height included: yours. Only the id of a creature or an object is
-- read; never a player or a pet, and nothing the game marks as restricted.
-- (object: 0 a creature whose window you opened, 1 an object, 2 a creature you fought - see Fought)
local talk = { id = 0, object = 0, seq = 0, at = -100 }
-- Who a unit is - or, with no unit, who the game's own name for something (its GUID) says it is.
local function WhoIs(unit, guid)
  if unit then
    if not UnitGUID then return nil end
    local ok, got = pcall(UnitGUID, unit)
    guid = ok and got or nil
  end
  guid = text(guid)
  if not guid then return nil end
  local kind, _, _, _, _, id = strsplit("-", guid)
  if kind ~= "Creature" and kind ~= "Vehicle" and kind ~= "GameObject" then return nil end
  id = tonumber(id)
  if not id or id <= 0 or id > 16777215 then return nil end
  if unit and kind ~= "GameObject" and UnitPlayerControlled then
    -- (someone's pet or guardian is a creature too, but not one that stands anywhere)
    local ok2, theirs = pcall(UnitPlayerControlled, unit)
    if not ok2 or secret(theirs) or theirs then return nil end
  end
  return id, kind == "GameObject" and 1 or 0
end
local messagesAt = -100

-- ---- who you are fighting -----------------------------------------------------------------------
-- A creature you fight opens no window, and the map guesses which level of a cave or a
-- building it is on as it does for anyone. But there are moments when you are as surely beside
-- it as beside someone you talk to: while you loot it; when it lies dead within the game's ten
-- yards of you as the fight ends; and while it is on you (you are what it is after) that near.
-- Then its id goes to the map too, marked as fought. That counts for less than a talk - a
-- creature is fought where it was chased to, ten yards is not arm's reach - and the map only
-- lets it move someone whose level was the map's own guess (viewer/js/npcs.js).
-- @param looting  true: only what you are looting; false: only what you have targeted
local function Fought(looting)
  if looting then
    if not (GetNumLootItems and GetLootSourceInfo) then return nil end
    local ok, n = pcall(GetNumLootItems)
    n = ok and plain(n) or 0
    local thing = nil
    for slot = 1, n do
      local ok2, guid = pcall(GetLootSourceInfo, slot)
      local id, object = WhoIs(nil, ok2 and guid or nil)
      if id and object == 0 then return id end
      if id and object == 1 and not thing then thing = id end
    end
    -- What you are taking things out of is no creature but an object: a chest, a herb, a vein of
    -- ore. You are standing at it, as surely as at someone you talk to: it is said as an object
    -- whose window you opened (the second answer: 1). Not what you fish out of the water: that
    -- comes out of your own float, which is an object of yours and stands nowhere.
    if thing then
      local okF, fishing = false, false
      if IsFishingLoot then okF, fishing = pcall(IsFishingLoot) end
      if not (okF and yes(fishing)) then return thing, 1 end
    end
    return nil
  end
  -- (how near something is, the game does not say in every version while a fight is on: then this
  -- says nothing until the fight is over, or you loot)
  if not (UnitExists and CheckInteractDistance) then return nil end
  local ok, there = pcall(UnitExists, "target")
  if not (ok and yes(there)) then return nil end
  local id, object = WhoIs("target")
  if not id or object ~= 0 then return nil end
  local okN, near = pcall(CheckInteractDistance, "target", 3)
  if not (okN and yes(near)) then return nil end
  local okD, dead = pcall(UnitIsDead, "target")
  if okD and yes(dead) then return id end
  local okA, foe = pcall(UnitCanAttack, "player", "target")
  local okT, onYou = pcall(UnitIsUnit, "targettarget", "player")
  if okA and yes(foe) and okT and yes(onYou) then return id end
  return nil
end

local function Talking()
  -- (what you are looting first: the game may well call that "npc" too, and it is no talk)
  -- (a creature you loot is one you fought: 2; an object you take things out of is said as an object: 1)
  local id, looted = Fought(true)
  local object = looted or 2
  if not id then
    id, object = WhoIs("npc")
    if not id then id, object = WhoIs("questnpc") end
    if not id then id, object = Fought(false), 2 end
  end
  if not id then return end
  local now = GetTime()
  if object == 2 then
    -- (a fight goes on for a while and ends in looting: all of it one meeting. And it does not take
    -- the place of a window you opened a moment ago)
    if (id == talk.id and talk.object == 2 and now - talk.at < 20) or (talk.object ~= 2 and now - talk.at < 5) then return end
  -- (one conversation often opens several windows in a row: that is still one meeting)
  elseif id == talk.id and object == talk.object and now - talk.at < 5 then talk.at = now; return end
  talk.id, talk.object, talk.at = id, object, now
  talk.seq = talk.seq % 255 + 1
  messagesAt = -100 -- send it in the next round
end
local TALK_EVENTS = {
  GOSSIP_SHOW = true, QUEST_GREETING = true, QUEST_DETAIL = true, QUEST_PROGRESS = true, QUEST_COMPLETE = true,
  MERCHANT_SHOW = true, TRAINER_SHOW = true, BANKFRAME_OPENED = true, AUCTION_HOUSE_SHOW = true,
  PET_STABLE_SHOW = true, GUILD_REGISTRAR_SHOW = true, PETITION_SHOW = true, BATTLEFIELDS_SHOW = true,
  -- (and the moments of a fight: see Fought)
  LOOT_OPENED = true, LOOT_READY = true, PLAYER_REGEN_ENABLED = true, PLAYER_REGEN_DISABLED = true, PLAYER_TARGET_CHANGED = true,
}

-- ---- your quests --------------------------------------------------------------------------------
-- Which quests are in your log (and whether each is ready to hand in) and which you have done,
-- so the map can show what is open to you rather than everything for your level. That is a lot
-- of numbers for a strip a few pixels high, so they go out a little at a time: two "bulk"
-- messages a round, the log first, and the list of quests done packed as the steps between
-- their numbers. Each message says which edition of its list it belongs to and how long that
-- is, so the map only believes a list once every piece of one edition has arrived.
--
-- What you have just done is said at once, though: when your log changes, the round of messages
-- starts again with the whole log (QUEST_ACCEPTED, QUEST_TURNED_IN and QUEST_REMOVED start it
-- there and then), and a quest you hand in is named in a message of its own at the head of every
-- round for two minutes (HandedBytes) - the list of quests done is long, and takes a while to
-- come round again in full. The map counts a quest so named as done from the moment it arrives.
--
-- And of a quest in your log that is part done, which part: you have killed the eight raiders it
-- asks for and not yet the shadowmancers, and the map is to show you the shadowmancers and not
-- the raiders. So with the log goes, for each quest of it that has something done and is not
-- ready to hand in, how far it has got (quests.Goals: what QuestProgress says of it, as it is
-- said of the quest you track). It is short - seven bytes a quest - and is said afresh, with
-- the log, the moment a thing a quest asks for is done.
local quests = { bulk = {}, at = 0, log = nil, logSig = "", logGen = 0, done = nil, doneGen = 0, dirty = true, retry = 3, readAt = -1000,
  logFresh = false, handed = {}, counting = {}, goals = nil, goalsGen = 0 }
local HANDED_FOR, HANDED_MOST, COUNT_FOR = 120, 5, 60
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

-- How far the quests of your log have got, for those with something done that are not ready to
-- hand in (of the others there is nothing to say: all of it is still to do, or none): of each
-- its number (3 bytes), how many things it asks for, which of them are done (a bit each, the
-- first the lowest) and what kind each is (2 bytes: see QuestProgress). Sixteen quests at the
-- most; of one left out the map shows everything, as it did of all of them before.
function quests.Goals(log)
  local out = {}
  for i = 1, #log do
    local state = log[i] % 4
    if state == 0 and #out < 16 then
      local id = (log[i] - state) / 4
      local _, n, done, kinds = QuestProgress(id)
      if n and n > 0 and done and done > 0 then out[#out + 1] = Byte3(id) .. strchar(n, done, floor(kinds / 256), kinds % 256) end
    end
  end
  return table.concat(out)
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
  -- (how far the part-done ones have got, right after the log and under the keys it leaves free -
  -- 4 to 7: which edition, how many quests, then four of them to a message)
  local goals = quests.goals
  if goals then
    local count = #goals / 7
    for chunk = 0, math.max(0, floor((count - 1) / 4)) do
      bulk[#bulk + 1] = { Q_LOG, 4 + chunk, strchar(quests.goalsGen, count) .. string.sub(goals, chunk * 28 + 1, (chunk + 1) * 28) }
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
  -- (a quest handed in: the done list is read again once the game counts it - or after a minute,
  -- for one it never counts, as it does not count a quest that can be done again)
  for id, since in pairs(quests.counting) do
    local counted = C_QuestLog and C_QuestLog.IsQuestFlaggedCompleted and yes(C_QuestLog.IsQuestFlaggedCompleted(id))
    if counted or now - since > COUNT_FOR then
      quests.counting[id] = nil
      if quests.retry < 1 then quests.retry = 1 end
    end
  end
  if not quests.dirty and quests.retry < 1 then return end
  quests.dirty = false
  local changed = false
  local ok, log = pcall(ReadQuestLog)
  if ok and log then
    local sig = table.concat(log, ",")
    if sig ~= quests.logSig or not quests.log then
      quests.log, quests.logSig = log, sig
      quests.logGen = quests.logGen % 255 + 1
      quests.logFresh = true
      changed = true
    end
    -- (how far each has got, where a part of it is done: another the moment a thing a quest asks
    -- for is finished - and then said at once, with the log, like the log itself)
    local ok3, goals = pcall(quests.Goals, log)
    if ok3 and type(goals) == "string" and goals ~= quests.goals then
      quests.goals = goals
      quests.goalsGen = quests.goalsGen % 255 + 1
      quests.logFresh = true
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

-- A quest you have just handed in (QUEST_TURNED_IN names it): kept for HANDED_FOR seconds, the
-- newest last, HANDED_MOST at most.
local function Handed(id)
  id = plain(id)
  if not id or id <= 0 or id >= 16777216 then return end
  local list = quests.handed
  for i = #list, 1, -1 do if list[i].id == id then table.remove(list, i) end end
  list[#list + 1] = { id = id, at = GetTime() }
  while #list > HANDED_MOST do table.remove(list, 1) end
  quests.counting[id] = GetTime()
end
-- ...said as: how many (1 to HANDED_MOST), then each quest's number in three bytes; nil when
-- there is none to say.
local function HandedBytes()
  local now, out = GetTime(), {}
  local list = quests.handed
  for i = #list, 1, -1 do if now - list[i].at > HANDED_FOR then table.remove(list, i) end end
  if #list == 0 then return nil end
  for i = 1, #list do out[#out + 1] = Byte3(list[i].id) end
  return strchar(#list) .. table.concat(out)
end

-- A place you could be heading for, as nine bytes: said (128), there is one (1), its map, north and west.
local function HeadBytes(s)
  if not s.on then return strchar(128, 0, 0, 0, 0, 0, 0, 0, 0) end
  return strchar(129) .. Byte2(s.map) .. Byte3((s.north + 32768) * 128) .. Byte3((s.west + 32768) * 128)
end

-- The messages to send this round: { kind, key, bytes }.
local messages = {}
local function BuildMessages()
  local list = {}
  -- your quests, first of all where they have changed: the whole log, and what you have just handed in
  shared.Try("quests", RefreshQuests)
  local handed = HandedBytes()
  if handed then list[#list + 1] = { T_TALK, 10, handed } end
  if quests.logFresh then
    -- (the bulk begins with the log's pieces: it carries on after them, with the quests done; and
    -- the round starts again here, at its head, where this list may be made in the middle of one)
    quests.logFresh, quests.head = false, true
    local sent = 0
    for i, m in ipairs(quests.bulk) do
      if m[1] == Q_LOG and m[2] < 8 then list[#list + 1] = m; sent = i end
    end
    if sent > 0 and #quests.bulk > sent then quests.at = sent end
  end
  -- where the game's own interface is on the screen (Windows.lua), for the map drawn over the game
  -- to make room for it: all of it when it has changed, else a piece of it a round
  if shared.WindowsReport then
    local ok, reports = shared.Try("windows report", shared.WindowsReport)
    if ok and type(reports) == "table" then
      for _, r in ipairs(reports) do list[#list + 1] = { T_TALK, r[1], r[2] } end
    end
  end
  -- the level you chose for a waypoint with more than one under it (Route.lua), first: the 3D map is waiting for it
  if shared.ChoiceReport then
    local ok, bytes = shared.Try("choice report", shared.ChoiceReport)
    if ok and type(bytes) == "string" then list[#list + 1] = { T_TALK, 2, bytes } end
  end
  -- how the route's way into the game is doing (Route.lua): which delivery comes next, which one is showing
  if shared.MailReport then
    local ok, bytes = shared.Try("mail report", shared.MailReport)
    if ok and type(bytes) == "string" then list[#list + 1] = { T_TALK, 1, bytes } end
  end
  -- every place you could be heading for (the 3D map draws a route to each): your guide's step,
  -- your own waypoint, your body, and the quest you are tracking
  list[#list + 1] = { T_TALK, 3, HeadBytes(heads.guide) }
  list[#list + 1] = { T_TALK, 4, HeadBytes(heads.way) }
  list[#list + 1] = { T_TALK, 5, HeadBytes(heads.corpse) }
  -- (the quest: said 128, there is one 1, how far it has got is said as well 2; its number; then
  -- how it stands and how many things it asks for, which of them are done, and what kind each is)
  local q = heads
  local progress = q.quest > 0 and q.qsaid
  list[#list + 1] = { T_TALK, 6, strchar(128 + (q.quest > 0 and 1 or 0) + (progress and 2 or 0)) .. Byte3(q.quest)
    .. (progress and strchar(q.qstate + q.qn * 4, q.qdone, floor(q.qkinds / 256), q.qkinds % 256, 1) or strchar(0, 0, 0, 0, 1)) }
  -- when the boats, zeppelins and tram run, as far as known (Transit.lua): a few lines a round, in turn
  if shared.TransitReport then
    local ok, reports = shared.Try("transit report", shared.TransitReport)
    if ok and type(reports) == "table" then
      for _, r in ipairs(reports) do list[#list + 1] = { T_TALK, r[1], r[2] } end
    end
  end
  -- where the game's minimap is on the screen (the 3D map finds you on it inside a dungeon: MinimapReport)
  if shared.MinimapReport then
    local ok, bytes = shared.Try("minimap report", shared.MinimapReport)
    if ok and type(bytes) == "string" then list[#list + 1] = { T_TALK, 9, bytes } end
  end
  -- the NPC you just met, or the creature you just fought (and how many seconds ago), repeated for half a minute so that it is sure to arrive
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
  -- (2 with it: you have said that routes are to leave your hearthstone out - see shared.SetHearth)
  if shared.HearthOff() then has = has + 2 end
  list[#list + 1] = { T_STATS, 0, Byte2(run * 100) .. Byte2(swim * 100) .. Byte2(cooldown) .. strchar(has) .. Byte2(#flights) }
  local bind = GetBindLocation and text(GetBindLocation())
  if bind then
    list[#list + 1] = { T_BIND, 0, bind }
    local saved = AzerothAtlasCharDB and AzerothAtlasCharDB.bind
    local known = type(saved) == "table" and saved.name == bind and saved.x and saved.y
    if known then
      list[#list + 1] = { T_BINDPOS, 0, Byte2(saved.map or 0) .. Byte3((saved.x + 32768) * 128) .. Byte3((saved.y + 32768) * 128) .. strchar(1) }
    end
    -- (noted when it is another place: the game gives the name, the spot is known only where you set it with this addon running)
    local now = bind .. (known and " (the spot is known)" or " (only the name is known)")
    if now ~= shared.bindSaid then
      shared.bindSaid = now
      shared.Log("hearthstone is set to " .. now)
    end
  end
  for chunk = 0, floor((#flights - 1) / 18) do
    local bytes = {}
    for i = chunk * 18 + 1, math.min(#flights, chunk * 18 + 18) do bytes[#bytes + 1] = Byte2(flights[i]) end
    if #bytes > 0 and chunk < 64 then list[#list + 1] = { T_FLIGHTS, chunk, table.concat(bytes) } end
  end
  -- your quests: two pieces a round, in turn (read again at the head of this round)
  local bulk = quests.bulk
  for _ = 1, math.min(2, #bulk) do
    quests.at = quests.at % #bulk + 1
    list[#list + 1] = bulk[quests.at]
  end
  -- who your character is, for the 3D map to tell which quests are open to you (Self.lua): two pieces a round, in turn
  if shared.SelfReport then
    local ok, reports = shared.Try("self report", shared.SelfReport)
    if ok and type(reports) == "table" then
      for _, r in ipairs(reports) do list[#list + 1] = { T_STATS, r[1], r[2] } end
    end
  end
  -- your pet (and where it is, should the game say) and what your minimap tracks: the 3D map names
  -- the dots it reads off the minimap by it (Yours.lua, which says under which keys)
  if shared.YoursReport then
    local ok, reports = shared.Try("yours report", shared.YoursReport)
    if ok and type(reports) == "table" then
      for _, r in ipairs(reports) do list[#list + 1] = { r[1], r[2], r[3] } end
    end
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
  local swimming = IsSwimming and yes(IsSwimming())
  local falling = IsFalling and yes(IsFalling())
  if swimming then p.flags = p.flags + F_SWIMMING end
  if falling then p.flags = p.flags + F_FALLING end
  -- (in the air: did it begin with a jump? Said for as long as you are up there)
  if falling then
    if not keys.air then keys.air, keys.jumped = true, GetTime() - keys.jumpAt < 0.5 end
    if keys.jumped then p.flags = p.flags + F_JUMPED end
  else
    keys.air = false
  end
  -- (in water: the keys that take you up and down; a key let go while the game was not looking is not held for ever)
  if swimming then
    if keys.up and keys.down then keys.up, keys.down = false, false end
    if keys.up then p.flags = p.flags + F_ASCEND end
    if keys.down then p.flags = p.flags + F_DESCEND end
  else
    keys.down = false
    if not falling then keys.up = false end
  end
  -- how fast the game says you are moving (on a boat that is nothing at all, while the boat moves you)
  p.speed = 0
  if GetUnitSpeed then
    local now = plain((GetUnitSpeed("player")))
    if now then
      p.flags = p.flags + F_SPEED
      p.speed = clamp(now * 32, 4095)
    end
  end
  p.place = Place()
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
-- (textFresh: something the 3D map is waiting for has changed - the quest you track has got
-- further - so the round begins again from its first message, where such things are said,
-- as soon as the message being sent is through)
local textCursor, textPart, textFresh = 0, 0, false
-- (for the addon's other files: what they have to say has changed, and the 3D map is waiting for it)
function shared.SayNow() textFresh = true end
local function NextText()
  local now = GetTime()
  if textPart == 0 and textFresh then textFresh, textCursor, messagesAt = false, #messages, -100 end
  if textPart == 0 and (now - messagesAt > 1 or textCursor >= #messages) then
    -- a fresh round once the last one is through (and at most once a second)
    if textCursor >= #messages then textCursor = 0 end
    if now - messagesAt > 1 then
      messagesAt = now
      BuildMessages()
      if textCursor >= #messages or quests.head then textCursor, quests.head = 0, false end
    end
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
local questSaid = "" -- the quest you track and how far it has got, as last said to the 3D map
local function Update(scan)
  ReadPlayer()
  if scan then
    ReadParty()
    ReadTarget()
    -- (the 3D map works the quest's route out anew from this, and the game waits for that route: said at once)
    local quest = heads.quest .. "." .. heads.qstate .. "." .. heads.qdone
    if quest ~= questSaid then questSaid, textFresh = quest, true end
    -- the route in the game (Route.lua); whatever goes wrong there must not stop the strip
    if shared.Scan then shared.Try("route", shared.Scan, GetTime()) end
  end

  local layout = partyPresent and L_PARTY or 0
  if target.kind > 0 then layout = layout + L_TARGET end
  local kind, key, part, name, offset = NextText()
  if kind then layout = layout + L_TEXT end
  -- (your height as the game measured it, for three seconds after each time it has: Height.lua)
  local fix = shared.FixNow and shared.FixNow(GetTime()) or nil
  if fix then layout = layout + L_FIX end
  -- (in a fight, as the game itself counts it)
  if UnitAffectingCombat and yes(UnitAffectingCombat("player")) then layout = layout + L_COMBAT end

  local p = player
  local n = 0
  n = put(n, PROTOCOL, 1)
  n = put(n, layout, 2)
  n = put(n, 0, 1)             -- sequence number, filled in below
  n = put(n, p.flags, 6)
  n = put(n, p.map, 5)
  n = put(n, p.x, 8)
  n = put(n, p.y, 8)
  n = put(n, p.facing, 4)
  n = put(n, p.zone, 5)
  n = put(n, p.level, 2)
  n = put(n, p.z, 6)
  n = put(n, p.speed, 4)
  n = put(n, p.place, 5)
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
  if fix then
    n = put(n, fix.seq, 1)
    for i = 1, 2 do
      local g = fix.refs[i]
      if g then
        n = put(n, g.kind + (g.fine and 4 or 0), 1)
        n = put(n, g.id, 5)
        n = put(n, clamp(g.h * 16, 32767), 5)
        n = put(n, clamp(g.d / 8, 4095), 4)
      else
        n = put(n, 0, 15)
      end
    end
  end

  -- Skip the repaint when nothing changed since the last frame.
  local sum = 0
  for i = 1, n do sum = (sum * 31 + digits[i] + 1) % 4093 end
  if sum == lastSum and n == lastCount then return end
  lastSum, lastCount = sum, n

  seq = (seq + 1) % 8
  digits[4] = seq
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
  if tick % 40 == 0 then pcall(OnTop) end
  -- position every frame; party five times a second
  local ok = shared.Try("strip", Update, tick % 4 == 1)
  if not ok then lastSum = -1 end
end)

local function Apply()
  if AzerothAtlasDB.enabled then
    pcall(OnTop)
    Layout()
    lastSum = -1
    strip:Show()
  else
    strip:Hide()
  end
end

-- ---- what the options are set through (Options.lua's panel, and the words after /atlas) ------------
-- The strip: on or off.
function shared.StripOn() return type(AzerothAtlasDB) == "table" and AzerothAtlasDB.enabled ~= false end
function shared.SetStrip(on)
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.enabled = on and true or false
  Apply()
end
-- ...and where it is: the corner ("TOPLEFT", "TOPRIGHT", "BOTTOMLEFT", "BOTTOMRIGHT") and the
-- pixels in from it. (The 3D map finds it by itself: nothing has to be told there.)
shared.StripAt = Placement
shared.CORNERS = CORNERS
function shared.PlaceStrip(corner, x, y)
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  local was, wx, wy = Placement()
  corner = type(corner) == "string" and CORNERS[string.upper(corner)] and string.upper(corner) or was
  x, y = tonumber(x) or wx, tonumber(y) or wy
  if x < 0 then x = 0 elseif x > 8000 then x = 8000 end
  if y < 0 then y = 0 elseif y > 8000 then y = 8000 end
  if corner == "TOPLEFT" and x == 0 and y == 0 then AzerothAtlasDB.strip = nil
  else AzerothAtlasDB.strip = { corner = corner, x = floor(x + 0.5), y = floor(y + 0.5) } end
  if AzerothAtlasDB.enabled ~= false then Apply() end
end

-- Your hearthstone: used in routes wherever it is the quicker way (as ever), or left out of
-- them - for those who keep it for something else. Kept for each character.
function shared.HearthOff() return type(AzerothAtlasCharDB) == "table" and AzerothAtlasCharDB.noHearth == true end
function shared.SetHearth(use)
  if type(AzerothAtlasCharDB) ~= "table" then AzerothAtlasCharDB = {} end
  local off = not use
  if off == shared.HearthOff() then return end
  AzerothAtlasCharDB.noHearth = off or nil
  -- (said to the 3D map in the next round of messages, and the routes are fetched anew once it has them: Route.lua)
  messagesAt = -100
  shared.Log(off and "hearthstone: left out of routes from now on" or "hearthstone: used in routes again")
  if shared.HearthChanged then shared.Try("hearth changed", shared.HearthChanged) end
end

-- The game's combat log. The game can write down every blow of a fight in a file made for
-- programs outside it to read (Logs\WoWCombatLog-....txt): /combatlog switches that on and
-- off, and it is off again at every login. The 3D map reads the file for what it says of the
-- creatures you fight - where each was, which level, how much health - and, inside a dungeon,
-- for where you are, which the game tells an addon nowhere. So the addon asks the game to keep
-- the log each time you enter the world, unless you have said not to (the options, or
-- /atlas fights). It never switches off a log that it did not switch on itself.
function shared.FightsKept() return not (type(AzerothAtlasDB) == "table" and AzerothAtlasDB.noFights == true) end
function shared.KeepFights()
  if not shared.FightsKept() or type(LoggingCombat) ~= "function" then return end
  local ok, on = pcall(LoggingCombat)
  if not ok or yes(on) then return end
  if pcall(LoggingCombat, true) then
    shared.fightsByUs = true
    shared.Log("the game's combat log: switched on, for the 3D map")
  end
end
function shared.SetFights(keep)
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.noFights = (not keep) or nil
  if keep then
    shared.KeepFights()
  elseif shared.fightsByUs and type(LoggingCombat) == "function" then
    pcall(LoggingCombat, false)
    shared.fightsByUs = nil
    shared.Log("the game's combat log: switched off again")
  end
end

-- What else you could be heading for (for Route.lua, which asks for the routes there when it
-- changes): the places said to the 3D map, your party, and which edition of your quest log this is.
function shared.Heads() return heads, party, quests.logGen end

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
strip:SetScript("OnEvent", function(_, event, ...)
  if event == "PLAYER_LOGIN" then
    pcall(ClaimSlash)
    if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
    if AzerothAtlasDB.enabled == nil then AzerothAtlasDB.enabled = true end
    -- (what the height probes of November 2026 kept there: read long since, and only a weight to load at every login)
    AzerothAtlasDB.probe, AzerothAtlasDB.probe2, AzerothAtlasDB.probe3 = nil, nil, nil
    if type(AzerothAtlasCharDB) ~= "table" then AzerothAtlasCharDB = {} end
    -- (its notes go on where they were; and this login is the first of the new ones)
    OpenLog()
    shared.Try("login note", function()
      local meta = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
      local version, build, _, interface = "?", "?", nil, "?"
      if GetBuildInfo then version, build, _, interface = GetBuildInfo() end
      shared.Log("LOGIN addon " .. tostring(meta and meta("AzerothAtlas", "Version") or "?") .. ", game " .. tostring(version) .. " build " .. tostring(build) .. " interface " .. tostring(interface)
        .. ", level " .. tostring(UnitLevel and plain(UnitLevel("player")) or "?") .. ", strip " .. (AzerothAtlasDB.enabled and "on" or "off"))
    end)
    -- the quick waypoint you had before the /reload
    local q = AzerothAtlasCharDB.quick
    if type(q) == "table" and type(q.map) == "number" and type(q.north) == "number" and type(q.west) == "number" then
      quick.on, quick.map, quick.north, quick.west, quick.serial = true, q.map, q.north, q.west, 1
    end
  elseif event == "TAXIMAP_OPENED" then
    shared.Try("flight master", ScanFlightMaster)
    messagesAt = -100
    shared.Try("talking", Talking)
    return
  elseif TALK_EVENTS[event] then
    shared.Try("talking", Talking)
    return
  elseif QUEST_EVENTS[event] then
    quests.dirty = true
    if event == "QUEST_TURNED_IN" then quests.retry = 6; Handed(...) end
    -- (not for every QUEST_LOG_UPDATE: those come many a second while you loot and kill, and the
    -- round would never get past its head; the log is read again at the head of every round anyway)
    if event ~= "QUEST_LOG_UPDATE" then textFresh = true end
    return
  elseif event == "HEARTHSTONE_BOUND" then
    -- you set your hearthstone here: remember the spot under the inn's name
    local x, y, _, map = UnitPosition("player")
    x, y, map = plain(x), plain(y), plain(map)
    local name = GetBindLocation and text(GetBindLocation())
    if x and y and name and type(AzerothAtlasCharDB) == "table" then
      AzerothAtlasCharDB.bind = { name = name, map = map or 0, x = x, y = y }
    end
    shared.Log("hearthstone set here: " .. tostring(name) .. " map " .. tostring(map) .. " " .. tostring(x and floor(x)) .. " " .. tostring(y and floor(y)))
    messagesAt = -100
    return
  end
  if event == "PLAYER_ENTERING_WORLD" then
    quests.dirty = true; quests.retry = 3
    shared.Log("entering the world (a login, a /reload or a loading screen)")
    -- (the game's combat log is off again at every login: asked for anew, where you let it)
    shared.Try("combat log", shared.KeepFights)
  end
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
  local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end
  if word == "strip" then
    -- /atlas strip                  where it is
    -- /atlas strip topright 0 40    a corner (topleft, topright, bottomleft, bottomright), and the pixels in from it
    -- /atlas strip reset            back in the top-left corner
    local corner, x, y = string.match(string.lower(msg), "^%s*strip%s+(%a+)%s*(%d*)%s*(%d*)")
    if corner == "reset" then
      shared.PlaceStrip("TOPLEFT", 0, 0)
    elseif corner and CORNERS[string.upper(corner)] then
      shared.PlaceStrip(corner, tonumber(x) or 0, tonumber(y) or 0)
    elseif corner then
      say("/atlas strip topleft, topright, bottomleft or bottomright - and, after it, how many pixels in from that corner: across, then down (or up). /atlas strip reset puts it back.")
      return
    end
    local at, ax, ay = Placement()
    say("the coded strip is in the " .. CORNERS[at] .. " corner" .. ((ax > 0 or ay > 0) and (", " .. ax .. " px across and " .. ay .. " px " .. ((at == "TOPLEFT" or at == "TOPRIGHT") and "down" or "up")) or "") .. ". The 3D map finds it by itself.")
    return
  elseif word == "hearth" or word == "hearthstone" then
    shared.SetHearth(shared.HearthOff())
    say(shared.HearthOff() and "your hearthstone is left out of routes." or "your hearthstone is used in routes again, where it is the quicker way.")
    return
  elseif word == "options" or word == "config" or word == "settings" then
    if not (shared.OpenOptions and shared.OpenOptions()) then say("the options are under Esc > Options > AddOns > Azeroth Atlas.") end
    return
  elseif word == "fights" or word == "combatlog" then
    -- /atlas fights: whether the game is asked to keep its combat log for the 3D map
    shared.SetFights(not shared.FightsKept())
    say(shared.FightsKept() and "the game is asked to keep its combat log (Logs\\WoWCombatLog...txt): the 3D map reads it for the creatures you fight, and for where you are inside a dungeon."
      or "the game is no longer asked to keep its combat log. (/combatlog is the game's own switch for it.)")
    return
  end
  if word == "met" then
    -- /atlas met: how many creatures' level, health and side are noted for the 3D map (Met.lua)
    if shared.MetSay then shared.MetSay() else say("this copy of the addon does not note who you meet: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "me" or word == "self" then
    -- /atlas me: what the 3D map is told of your character, to tell which quests are open to you (Self.lua)
    if shared.SelfSay then shared.SelfSay() else say("this copy of the addon does not say who your character is: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "windows" or word == "interface" then
    -- /atlas windows, /atlas windows off, /atlas windows on: where the game's interface is on the
    -- screen, said to the 3D map for the map drawn behind it (Windows.lua)
    if shared.WindowsSay then shared.WindowsSay(rest) else say("this copy of the addon does not say where the game's interface is: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "pet" or word == "yours" then
    -- /atlas pet: what the 3D map is told of your pet and of what you track (Yours.lua)
    if shared.YoursSay then shared.YoursSay() else say("this copy of the addon does not say anything of your pet: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "learned" then
    -- /atlas learned: how many vendors, trainers and quests are noted for the 3D map (Learned.lua)
    if shared.LearnedSay then shared.LearnedSay() else say("this copy of the addon does not note vendors, trainers and quest pins: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "measure" then
    -- /atlas measure, /atlas measure off, /atlas measure on: your height as the game measures it (Height.lua)
    if shared.MeasureSay then shared.MeasureSay(rest) else say("this copy of the addon does not measure your height: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "drops" or word == "droprates" then
    -- /atlas drops, /atlas drops off, /atlas drops on: how often a creature drops what your quest wants, in its tooltip (Drops.lua)
    if shared.DropsSay then shared.DropsSay(rest) else say("this copy of the addon does not show drop rates: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "track" or word == "untrack" then
    -- /atlas track: every quest ready to hand in is tracked; /atlas track here: the quests you track become those with
    -- something to do where you are; /atlas untrack: every quest is untracked (Tracked.lua)
    local run = shared.UntrackAll
    if word == "track" then
      run = shared.TrackReady
      if rest == "here" or rest == "location" or rest == "zone" then run = shared.TrackHere end
    end
    if run then run() else say("this copy of the addon cannot track or untrack all your quests at once: update it from the 3D map, and start the game again.") end
    return
  end
  if word == "log" then
    -- /atlas log: the last of the addon's own notes (all of them go into a report made on the 3D map, after a /reload)
    for _, line in ipairs(shared.LastLog(tonumber(rest) or 15)) do
      local at, what = string.match(line, "^(%d+) [%d%.%-]+ (.*)$")
      print("|cff888888" .. (at and date and date("%H:%M:%S", tonumber(at)) or "") .. "|r " .. (what or line))
    end
    say("its notes, the last of them. To hand them on: type /reload, then press Report a problem in Azeroth Atlas.")
    return
  end
  if word ~= "" then
    shared.Log("/atlas " .. word .. (rest ~= "" and (" " .. rest) or ""))
    if shared.Command then shared.Try("/atlas " .. word, shared.Command, word, rest) end
    return
  end
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.enabled = not AzerothAtlasDB.enabled
  Apply()
  say(AzerothAtlasDB.enabled and "on - your position is shown to the 3D map" or "off")
end
