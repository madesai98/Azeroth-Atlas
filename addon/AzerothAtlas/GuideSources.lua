-- Azeroth Atlas: your guide.
--
-- A leveling guide tells you, step by step, where to go and what to do there. This addon has no
-- guide of its own. It follows the guide addon you run - Guidelime or RestedXP - and the step
-- that addon has you on is your waypoint: the 3D map routes to it (AzerothAtlas.lua asks
-- GuideGoal), and the route moves on by itself as the guide does.
--
--   where it looks   each guide addon points an arrow of its own at the spot its step sends you
--                    to, and the thing that arrow points at says where that is:
--                      Guidelime   GuidelimeArrow.element   (a frame anyone can see; the addon's
--                                                            own tables are its own)
--                      RestedXP    RXP.arrowFrame.element   (RXP is its addon table, in the open)
--                    Nothing of theirs is written to, and nothing of theirs is called but one
--                    thing (see Nudge).
--   which of them    set in the options, or typed (/atlas guide): Automatic - the one that has a
--                    guide open and a step to go to; with both, the one whose step changed last -
--                    or one of them by name. Kept for each character.
--   a step is open   for as long as the guide has you on it - not for as long as its spot is
--                    "not reached". Under the quest giver's balcony both addons count the spot
--                    as reached, on the flat map, and the step still waits for the quest to be
--                    taken: the way up to the balcony stays. The spot is done with when you are
--                    at the end of the route to it, on the level it ends on (Route.lua: There),
--                    and is your waypoint again when you walk off without doing what the step asks.
--   Arrived          a step that is ONLY a spot the guide addon ticks off itself, on the flat
--                    map. The 3D map's page can teach it to ask here first (server/guidepatch.js
--                    changes one line of the addon): AzerothAtlas.Arrived(element) is false until
--                    you are at the end of the route to the spot, on its level. Not taught - or
--                    with the 3D map not running, when there is nothing to tell the level by -
--                    the guide addon decides as it always did.
--
-- /atlas guide                             which guide addon is followed, and how that is set
-- /atlas guide auto | guidelime | restedxp   set it

local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor = math.floor

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function plain(v)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end
local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end

local REACH = 6        -- yards: how wide a spot is that does not say (as wide as Guidelime takes one to be)
local LOOK_EVERY = 0.2 -- seconds between looks at whether a guide addon is to be told you have arrived

-- Where you are: map, north, west.
local function Where()
  if not UnitPosition then return nil end
  local north, west, _, map = UnitPosition("player")
  north, west, map = plain(north), plain(west), plain(map)
  if not (north and west and map) then return nil end
  return map, north, west
end

-- The spot a step's element names: map, north, west, and three numbers that name the place (the
-- map it is given on and its position there to a tenth of a percent, where it says; so that a
-- spot moved a hair by the guide addon's own arithmetic is not a new one). Both addons keep the
-- world position the way the map library they share does: "wx" runs west and "wy" north.
local function Spot(e, zone)
  local north, west, map = plain(e.wy), plain(e.wx), plain(e.instance)
  if not (north and west and map) then return nil end
  local x, y = plain(e.x), plain(e.y)
  zone = plain(zone)
  if zone and x and y then return map, north, west, zone, floor(x * 10 + 0.5), floor(y * 10 + 0.5) end
  return map, north, west, map, floor(north + 0.5), floor(west + 0.5)
end

-- ---- the guide addons -----------------------------------------------------------------------------
-- Each: key (what it is called when typed), name, Loaded() - the addon is running -, and
-- Element() - the element its arrow points at while its step is open, the map its position is
-- given on, whether the addon itself counts the spot as reached, and how wide the spot is.
-- Kept by this file for each: e (the element last seen), reached, at (when its spot last
-- changed), a b c (the spot's name), asked (the element it was told "not yet" about: see Arrived).

local lime = { key = "guidelime", name = "Guidelime" }
function lime.Loaded() return type(GuidelimeFrame) == "table" end
function lime.Element()
  local arrow = GuidelimeArrow
  local e = type(arrow) == "table" and arrow.element
  if type(e) ~= "table" then return nil end
  -- (its window shut, Guidelime follows nothing: what its arrow last pointed at stays behind)
  local win = GuidelimeWindow
  if type(win) == "table" and type(win.IsShown) == "function" and not win:IsShown() then return nil end
  local step = e.step
  if type(step) == "table" then
    if step.completed or step.skip or step.active == false then return nil end
  elseif e.completed then
    return nil
  end
  return e, e.mapID, e.completed == true, plain(e.radius)
end
-- Guidelime looks at a spot once, as you cross into its reach. Told "not yet" then, it is asked
-- to look again when you are there: its own two lines for "your experience changed", which do
-- nothing but that.
function lime.Nudge()
  local f = GuidelimeFrame
  if type(f) == "table" and type(f.PLAYER_XP_UPDATE) == "function" then pcall(f.PLAYER_XP_UPDATE, f) end
end

local rxp = { key = "restedxp", name = "RestedXP" }
function rxp.Loaded() return type(RXP) == "table" and type(RXP.arrowFrame) == "table" end
function rxp.Element()
  local R = RXP
  local arrow = type(R) == "table" and R.arrowFrame
  local e = type(arrow) == "table" and arrow.element
  if type(e) ~= "table" then return nil end
  -- (RestedXP never clears what its arrow pointed at last: only an element of a step it has you
  -- on counts - which the arrow to your body, while you are a ghost, is not)
  local step = e.step
  if type(step) ~= "table" or step.active ~= true or e.skip or R.hideArrow == true then return nil end
  local parent = e.parent
  if type(parent) == "table" and (parent.completed or parent.skip) and not parent.textOnly then return nil end
  local radius = plain(e.radius)
  -- (a spot to get AWAY from has its reach written below nought: no place to be led to)
  if radius and radius < 0 then return nil end
  return e, e.zone, false, radius
end

local SOURCES = { lime, rxp }
local BY_KEY = { guidelime = lime, lime = lime, restedxp = rxp, rxp = rxp, rxpguides = rxp }

-- ---- which of them --------------------------------------------------------------------------------
local function Saved()
  if type(AzerothAtlasCharDB) ~= "table" then AzerothAtlasCharDB = {} end
  return AzerothAtlasCharDB
end
-- "auto", or the key of a guide addon.
function shared.GuideChoice()
  local v = type(AzerothAtlasCharDB) == "table" and AzerothAtlasCharDB.guideSource
  if type(v) == "string" and BY_KEY[v] then return BY_KEY[v].key end
  return "auto"
end
function shared.SetGuideChoice(key)
  local s = type(key) == "string" and BY_KEY[key:lower()]
  Saved().guideSource = s and s.key or nil
  return s and s.key or "auto"
end

-- The step a guide addon has you on, if it has one for you to go to: its element and its spot.
-- Nothing while the spot is done with (see "a step is open" above).
local function Open(s, now)
  local ok, e, zone, counted, radius = pcall(s.Element)
  if not ok or type(e) ~= "table" then
    s.e, s.reached = nil, false
    return nil
  end
  local map, north, west, a, b, c = Spot(e, zone)
  if not map then
    s.e, s.reached = nil, false
    return nil
  end
  if s.e ~= e then s.e, s.reached, s.asked = e, false, nil end
  if s.a ~= a or s.b ~= b or s.c ~= c then s.a, s.b, s.c, s.at = a, b, c, now end
  local there = nil
  if shared.There then
    local fine, answer = shared.Try("there", shared.There, radius, map, north, west)
    if fine then there = answer end
  end
  -- (about the spot: within twice its reach and a few yards, on the flat map. The end of the
  -- route as it is drawn is not the spot where the journey goes on by boat: that is the pier.)
  local pm, pn, pw = Where()
  local reach = (radius or REACH) * 2 + REACH
  local about = pm == map and (pn - north) ^ 2 + (pw - west) ^ 2 <= reach * reach
  if not s.reached then
    -- at the end of the route to it, on its level - or, with nothing to tell that by, where the
    -- guide addon itself says so
    if about and (there == true or (there == nil and counted)) then s.reached = true end
  elseif pm and not about then
    -- walked off again without doing what the step asks: it is where you are to go once more
    s.reached = false
  end
  if s.reached then return nil end
  return map, north, west, a, b, c
end

-- The guide addon that is followed now (nil: none has a step to go to), and its step's spot.
local followed = nil
local Look -- (see "asked by a guide addon")
local function Follow()
  local now = GetTime()
  if Look then pcall(Look, now) end
  local choice = shared.GuideChoice()
  local best, bMap, bNorth, bWest, ba, bb, bc = nil, nil, nil, nil, nil, nil, nil
  for _, s in ipairs(SOURCES) do
    if choice == "auto" or choice == s.key then
      local map, north, west, a, b, c = Open(s, now)
      -- (of two that each have a step for you: the one whose step changed last is the one you follow)
      if map and (not best or (s.at or 0) > (best.at or 0)) then best, bMap, bNorth, bWest, ba, bb, bc = s, map, north, west, a, b, c end
    else
      s.e, s.reached = nil, false
    end
  end
  followed = best
  return bMap, bNorth, bWest, ba, bb, bc
end

-- Your waypoint, for AzerothAtlas.lua: map, north, west, and three numbers that name the place.
-- Nothing: no guide addon has a step for you to go to.
function shared.GuideGoal() return Follow() end

-- For the options and /atlas guide: every guide addon known here - { key, name, loaded, followed }.
function shared.GuideSources()
  local out = {}
  for _, s in ipairs(SOURCES) do
    local ok, there = pcall(s.Loaded)
    out[#out + 1] = { key = s.key, name = s.name, loaded = ok and there == true, followed = followed == s }
  end
  return out
end

-- ---- asked by a guide addon -----------------------------------------------------------------------
-- A guide addon that has been taught to (the 3D map's page: one line of it changed) asks, at the
-- moment it would tick a spot off: are you there? false: not yet - you are within the spot's reach
-- on the map and not at the end of the route to it (on the floor below, under the bridge). true:
-- you are. Nothing: there is nothing to tell by (it is not the spot you are led to, or the 3D map
-- is not sending routes), and the guide addon decides as it always did.
local function Asked(e)
  if type(e) ~= "table" or not shared.There then return nil end
  for _, s in ipairs(SOURCES) do
    if s.e == e and followed == s then
      local map, north, west = Spot(e)
      local radius = plain(e.radius)
      if not map or (radius and radius < 0) then return nil end
      local there = shared.There(radius, map, north, west)
      if there == false then s.asked = e end
      return there
    end
  end
  return nil
end
function shared.Arrived(e)
  local ok, answer = pcall(Asked, e)
  if ok and (answer == true or answer == false) then return answer end
  return nil
end

-- A guide addon that was told "not yet", and only looks once (Guidelime), is asked to look again
-- when the answer is no longer that. (Looked at as often as the waypoint is: see GuideGoal.)
local lookedAt = -1
Look = function(now)
  if now - lookedAt < LOOK_EVERY then return end
  lookedAt = now
  for _, s in ipairs(SOURCES) do
    local e = s.asked
    if e then
      if s.e ~= e then
        s.asked = nil
      elseif shared.Arrived(e) ~= false then
        s.asked = nil
        if s.Nudge then pcall(s.Nudge) end
      end
    end
  end
end

-- ---- typed ------------------------------------------------------------------------------------------
local function Names()
  local out = {}
  for _, s in ipairs(SOURCES) do out[#out + 1] = s.name end
  return table.concat(out, " or ")
end
function shared.GuideWord(word, rest)
  if word ~= "guide" and word ~= "guides" then return false end
  rest = type(rest) == "string" and rest:lower():gsub("%s+", "") or ""
  if rest == "auto" or rest == "automatic" then
    shared.SetGuideChoice(nil)
  elseif BY_KEY[rest] then
    shared.SetGuideChoice(rest)
  elseif rest ~= "" then
    say("/atlas guide auto, /atlas guide guidelime, /atlas guide restedxp: which guide addon the route follows.")
    return true
  end
  local choice = shared.GuideChoice()
  local running = {}
  for _, s in ipairs(shared.GuideSources()) do
    if s.loaded then running[#running + 1] = s.name end
  end
  local how = choice == "auto" and "the guide addon is chosen for you" or ("set to " .. BY_KEY[choice].name)
  if #running == 0 then
    say("no guide addon is running (" .. Names() .. "). The route follows the step of the one you run; " .. how .. ".")
  elseif followed then
    say("following " .. followed.name .. ": the route goes to the step it has you on (" .. how .. "; /atlas guide auto, guidelime or restedxp changes that).")
  else
    say(table.concat(running, " and ") .. (#running == 1 and " is" or " are") .. " running, with no step for you to go to just now (" .. how .. ").")
  end
  return true
end

-- (for the tests, and for a look from the game with /dump AzerothAtlas.GuideSourcePeek())
function shared.GuideSourcePeek()
  local out = { choice = shared.GuideChoice(), followed = followed and followed.key or nil }
  for _, s in ipairs(SOURCES) do out[s.key] = { reached = s.reached == true, asked = s.asked ~= nil, at = s.at, a = s.a, b = s.b, c = s.c } end
  return out
end
