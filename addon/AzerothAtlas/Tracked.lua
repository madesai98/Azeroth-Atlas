-- Azeroth Atlas: the quests you track, all at once.
--
-- The game tracks a quest - its objectives stand in the list on the right of the screen - when
-- you tick it in the quest log, and it tracks or untracks all the quests of one zone at once (a
-- right-click on the zone's name in the quest log: "Track All", "Untrack All"). It has nothing
-- for the whole log. Asked for on 20 November 2026 ("a button that adds all completed quests to
-- the tracked list would be sick, and also an untrack all button"), this adds two:
--
--   Track All Completed Quests   every quest in your log that is ready to hand in is tracked
--                                (as many of them as the game has room for: it tracks 25 at most)
--   Untrack All Quests           every quest you track is untracked - and so none is focused,
--                                as the game itself has it when the quest it focuses is untracked
--
-- And a third, asked for on 21 November 2026 ("Track location quests": "This should
-- automatically clear tracked quests then add all quests that take place in the players current
-- zone to the tracking list. This means quests that actually have tasks in that zone, not a quest
-- that started in that zone but the task is actually in another zone. Dungeons count as their own
-- zone"):
--
--   Track Location Quests        the quests you track become those with something to do where
--                                you are - the zone, or the dungeon you are inside: every other
--                                quest is untracked, these are tracked
--
-- Where a quest has something to do, the game's own map says: it pins the quests of your log -
-- where their next objective is, or who takes them when they are done (C_QuestLog.GetQuestsOnMap).
-- A quest counts as being of the place you are in when
--   - the game's map of that place has a pin for it, in the place itself: a zone's map shows a
--     strip of its neighbours round its edges, and their pins with it (the Badlands' are on Loch
--     Modan's), so each pin is asked about - which map the game names as its own, and what the
--     game's map has at that spot (Elsewhere, below);
--   - or the map the game opens for the quest is of that place (GetQuestUiMapID);
--   - or the game has no place for it at all, and it stands under that place's name in your
--     quest log - the only thing left to go by.
-- A dungeon is a place of its own. The game pins a dungeon's quest to the dungeon's door for as
-- long as there is something to do inside (seen in what this addon noted of its pins: Nekrum's
-- Medallion at Zul'Farrak's door in Tanaris), so outside, a quest the game marks as a dungeon's
-- or a raid's is left out until it is ready to hand in - then its pin is whoever takes it.
-- Inside, the quests under the dungeon's name in your log count (those ready to hand in only
-- where the game knows of no place outside for them), and whatever the game pins to the
-- dungeon's own maps.
--
-- They are in three of the game's own menus, after what the game has there: the quest log's
-- options (the button by its search box), the right-click on a zone's name in the quest log
-- (below the game's own two, which are for that zone only), and the right-click on a quest in
-- the list on the right. Typed, they are /atlas track, /atlas track here and /atlas untrack.
-- What was done is said in chat.
--
-- What is not done:
--   - nothing in a fight. The game's list of tracked quests lays itself out again when one is
--     tracked or untracked, and it holds buttons (a quest's item) that an addon may not have
--     moved in a fight. Asked in a fight, it is done the moment the fight is over, and it says so;
--   - nothing untracked for a new player in the game's first quests, where the game lets no
--     quest be untracked (and it has no "Untrack" there either);
--   - world quests and bonus objectives are left as the game has them.
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local format = string.format

local MOST = 25   -- quests the game tracks at most, where it does not say (Constants.QuestWatchConsts)
local WAIT = 0.1  -- seconds to wait while the height is being measured (Height.lua points the game's marker elsewhere for a frame or three)
local WAITS = 10  -- ...at most this many times, then done anyway

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function plain(v)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end
local function yes(v)
  if v == nil or secret(v) then return false end
  return v == true
end
local function open(t)
  if t == nil or secret(t) or type(t) ~= "table" then return false end
  return not (issecrettable ~= nil and issecrettable(t))
end
local function call(fn, ...)
  if type(fn) ~= "function" then return nil end
  local ok, a, b = pcall(fn, ...)
  if ok then return a, b end
  return nil
end
local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end
local function count(n, one, many) return n .. " " .. (n == 1 and one or many) end

local Q = C_QuestLog
-- (what this needs of the game: without it, nothing is offered)
local able = type(Q) == "table" and type(Q.GetNumQuestLogEntries) == "function" and type(Q.GetInfo) == "function"
  and type(Q.AddQuestWatch) == "function" and type(Q.RemoveQuestWatch) == "function"
  and type(Q.GetNumQuestWatches) == "function" and type(Q.GetQuestIDForQuestWatchIndex) == "function"

local function Most()
  local c = type(Constants) == "table" and Constants.QuestWatchConsts
  return type(c) == "table" and plain(c.MAX_QUEST_WATCHES) or MOST
end
local function CanUntrack()
  if type(QuestUtil) == "table" and type(QuestUtil.CanRemoveQuestWatch) == "function" then
    local ok, can = pcall(QuestUtil.CanRemoveQuestWatch)
    return not ok or can ~= false
  end
  return true
end
local function Tracking() return plain(call(Q.GetNumQuestWatches)) or 0 end
local function IsTracked(id)
  if type(Q.GetQuestWatchType) == "function" then
    local ok, kind = pcall(Q.GetQuestWatchType, id)
    if ok then return kind ~= nil end
  end
  for i = 1, Tracking() do
    if plain(call(Q.GetQuestIDForQuestWatchIndex, i)) == id then return true end
  end
  return false
end
local function Ready(id)
  if Q.IsFailed and yes(call(Q.IsFailed, id)) then return false end
  if Q.IsComplete then return yes(call(Q.IsComplete, id)) end
  return yes(call(Q.ReadyForTurnIn, id))
end

local function text(v)
  if v == nil or secret(v) or type(v) ~= "string" or v == "" then return nil end
  return v
end
-- A place's name as names are held against each other: "The Deadmines" and "Deadmines" are one.
local function Plain(name)
  name = string.lower(name)
  name = string.gsub(name, "^the%s+", "")
  name = string.gsub(name, "[%s%p]", "")
  return name
end

-- The quests of your log, as its list shows them (not its headings, not what the game hides, not
-- world quests or bonus objectives) - all of them, or only those ready to hand in. Quests under
-- a heading you folded away are there all the same. And, for each, the heading it stands under
-- (as Plain has it).
local function Quests(ready)
  local list, under = {}, {}
  local n = plain(call(Q.GetNumQuestLogEntries)) or 0
  local heading = nil
  for i = 1, n do
    local info = call(Q.GetInfo, i)
    if open(info) and yes(info.isHeader) then
      local title = text(info.title)
      heading = title and Plain(title) or nil
    elseif open(info) and not yes(info.isHidden) and not yes(info.isTask) and not yes(info.isBounty) then
      local id = plain(info.questID)
      if id and id > 0 and (not ready or Ready(id)) then
        list[#list + 1] = id
        under[id] = heading
      end
    end
  end
  return list, under
end

-- The quests you track: as the game lists them, and any of your log it says is tracked besides.
local function Tracked()
  local list, seen = {}, {}
  for i = 1, Tracking() do
    local id = plain(call(Q.GetQuestIDForQuestWatchIndex, i))
    if id and id > 0 and not seen[id] then seen[id] = true list[#list + 1] = id end
  end
  for _, id in ipairs(Quests(false)) do
    if not seen[id] and IsTracked(id) then seen[id] = true list[#list + 1] = id end
  end
  return list
end

-- These quests, tracked: how many are tracked now, were already, found no room, and were refused.
local function Take(list, most)
  local added, already, full, refused = 0, 0, 0, 0
  for _, id in ipairs(list) do
    if IsTracked(id) then already = already + 1
    elseif Tracking() >= most then full = full + 1
    elseif yes(call(Q.AddQuestWatch, id)) or IsTracked(id) then added = added + 1
    else refused = refused + 1 end
  end
  return added, already, full, refused
end
-- These quests, untracked: how many are, and how many the game kept tracked.
local function Drop(list)
  local focus = C_SuperTrack and plain(call(C_SuperTrack.GetSuperTrackedQuestID)) or nil
  local gone, kept, focusGone = 0, 0, false
  for _, id in ipairs(list) do
    call(Q.RemoveQuestWatch, id)
    if IsTracked(id) then kept = kept + 1 else
      gone = gone + 1
      if id == focus then focusGone = true end
    end
  end
  -- (the game lets go of the quest it focuses when that quest is untracked; here once more,
  -- should it have heard of only one of so many at once)
  if focusGone and plain(call(C_SuperTrack.GetSuperTrackedQuestID)) == focus then call(C_SuperTrack.SetSuperTrackedQuestID, 0) end
  return gone, kept
end

local function TrackReady()
  local ready = Quests(true)
  if #ready == 0 then say("no quest in your log is ready to hand in.") shared.Log("tracked: none ready to hand in") return end
  local most = Most()
  local added, already, full, refused = Take(ready, most)
  shared.Log(format("tracked: %d ready to hand in, %d tracked now, %d were, %d no room (%d at most), %d refused", #ready, added, already, full, most, refused))
  local room = format("the game tracks %d quests at most (untrack some first: /atlas untrack untracks them all)", most)
  if added == 0 and refused == 0 and full == 0 then
    say(#ready == 1 and "the one quest ready to hand in is tracked already." or format("all %d quests ready to hand in are tracked already.", #ready))
  elseif added == 0 and refused == 0 then
    say(format("no room to track %s ready to hand in: %s.", count(full, "quest", "quests"), room))
  else
    local out = format("%s ready to hand in tracked", count(added, "quest", "quests"))
    if already > 0 then out = out .. format(", %d %s already", already, already == 1 and "was" or "were") end
    if full > 0 then out = out .. format("; %d more could not be, as %s", full, room) end
    if refused > 0 then out = out .. format("; the game would not track %d of them", refused) end
    say(out .. ".")
  end
end

local function UntrackAll()
  if not CanUntrack() then
    say("the game lets no quest be untracked yet: not in its first quests for a new player.")
    shared.Log("untracked: the game lets none be untracked (a new player's first quests)")
    return
  end
  local list = Tracked()
  if #list == 0 then say("no quest is tracked.") shared.Log("untracked: none was tracked") return end
  local gone, kept = Drop(list)
  shared.Log(format("untracked: %d of %d, %d kept by the game", gone, #list, kept))
  say(format("%s untracked", count(gone, "quest", "quests")) .. (kept > 0 and format("; the game kept %d tracked", kept) or "") .. ".")
end

-- ---- where you are, and the quests with something to do there ------------------------------------
local M = C_Map
local CONTINENT, ZONE, DUNGEON = 2, 3, 4  -- the kinds of map the game has (Enum.UIMapType): below a zone the continents and the world, above a dungeon the places within a zone - a cave, a town's quarter
local UP = 6         -- maps looked up through, from a map to the one it lies in
local PINS = 300     -- pins read of one map
local FLOORS = 20    -- maps read of one dungeon
-- the marks the game puts on a quest (Enum.QuestTag) that make it a dungeon's or a raid's
local INSIDE = { [62] = true, [81] = true, [85] = true, [88] = true, [89] = true }

local function MapInfo(id)
  if not id or id <= 0 or type(M) ~= "table" then return nil end
  local info = call(M.GetMapInfo, id)
  if not open(info) then return nil end
  return info
end
local function KindOf(id)
  local info = MapInfo(id)
  return info and plain(info.mapType) or nil, info
end
-- Is the map `id` the map `top`, or one that lies in it (a cave of the zone, a floor of the dungeon)?
local function In(id, top)
  for _ = 1, UP do
    if not id or id <= 0 then return false end
    if id == top then return true end
    local info = MapInfo(id)
    id = info and plain(info.parentMapID) or nil
  end
  return false
end
local function Among(maps, id)
  for _, top in ipairs(maps) do
    if In(id, top) then return true end
  end
  return false
end

-- Where you are: { name (as it is said), names (every name the place goes by, as Plain has
-- them), maps (the game's maps of it: the one you are on and, from a cave or a town's quarter, up
-- to the zone it lies in; of a dungeon every floor, and never the zone its door is in), dungeon
-- (true inside one: a dungeon, a raid, a battleground) }
local function Where()
  local place = { names = {}, maps = {}, dungeon = false }
  local function named(v, first)
    v = text(v)
    if not v then return end
    place.names[Plain(v)] = true
    if first or not place.name then place.name = v end
  end
  local inside, kind = call(IsInInstance)
  place.dungeon = yes(inside) and text(kind) ~= "none"
  local zone = text((call(GetRealZoneText)))
  local instance = place.dungeon and text((call(GetInstanceInfo))) or nil
  local best = type(M) == "table" and plain(call(M.GetBestMapForUnit, "player")) or nil
  local id = best
  for _ = 1, UP do
    local sort, info = KindOf(id)
    if not sort or sort < ZONE then break end
    local name = text(info.name)
    if place.dungeon and sort == ZONE then
      -- (inside, a zone's map only where it is the place itself, as a battleground's is: by name)
      local plainly = name and Plain(name) or nil
      if not plainly or (plainly ~= (zone and Plain(zone) or nil) and plainly ~= (instance and Plain(instance) or nil)) then break end
    end
    place.maps[#place.maps + 1] = id
    if sort == ZONE or (place.dungeon and sort == DUNGEON) then named(name, not place.dungeon) end
    if sort == ZONE then break end
    id = plain(info.parentMapID)
    -- (inside: from a floor to the dungeon it is a floor of, and no further)
    if place.dungeon and KindOf(id) ~= DUNGEON then break end
  end
  if place.dungeon and best and #place.maps > 0 then
    -- (the other floors)
    local group = plain(call(M.GetMapGroupID, best))
    local floors = group and group > 0 and call(M.GetMapGroupMembersInfo, group) or nil
    if open(floors) then
      for k = 1, math.min(#floors, FLOORS) do
        local floor = floors[k]
        local map = open(floor) and plain(floor.mapID) or nil
        if map and map > 0 and not Among(place.maps, map) then place.maps[#place.maps + 1] = map end
      end
    end
  end
  named(zone, place.dungeon)
  named(instance)
  if not place.dungeon then named((call(GetZoneText))) end
  return place
end

-- What the game's map has at a spot of the map `id`: the map there and its kind - or nothing,
-- where it does not say.
local function At(id, x, y)
  local info = call(M.GetMapInfoAtPosition, id, x, y)
  if not open(info) then return nil end
  return plain(info.mapID), plain(info.mapType)
end
-- ...and the same asked of the continent's map, which is where the game itself lets you click
-- on a zone: a zone's own map often says nothing of what is drawn at its edges.
local function AtWide(id, x, y)
  if type(CreateVector2D) ~= "function" then return nil end
  local top, continent = id, nil
  for _ = 1, UP do
    local sort, info = KindOf(top)
    if not sort then return nil end
    if sort < ZONE then
      if sort == CONTINENT then continent = top end
      break
    end
    top = plain(info.parentMapID)
  end
  if not continent or continent == id then return nil end
  top = continent
  local ok, spot = pcall(CreateVector2D, x, y)
  if not ok or spot == nil then return nil end
  local land, world = call(M.GetWorldPosFromMapPos, id, spot)
  if plain(land) == nil or world == nil or secret(world) then return nil end
  local _, wide = call(M.GetMapPosFromWorldPos, land, world, top)
  if not open(wide) then return nil end
  local wx, wy = plain(wide.x), plain(wide.y)
  if not wx or not wy then return nil end
  return At(top, wx, wy)
end
-- Does the game say of a spot that it is another place's - a neighbouring zone's, a town's?
local function Others(place, there, sort)
  return there ~= nil and there > 0 and sort ~= nil and sort >= ZONE and not Among(place.maps, there)
end
-- Which of the two ways of asking can be believed on the map `id`: each is tried on the spot you
-- stand on yourself, which is in this place whatever a map says. (A zone the continent's map
-- has no outline for would have every one of its pins put down to the zone round it.)
local function Believed(place, id)
  local pos = call(M.GetPlayerMapPosition, id, "player")
  if not open(pos) then return false, false end
  local x, y = plain(pos.x), plain(pos.y)
  if not x or not y or not (x > 0 and x < 1 and y > 0 and y < 1) then return false, false end
  return not Others(place, At(id, x, y)), not Others(place, AtWide(id, x, y))
end

-- A pin at (x, y) of the map `id` - a map of the place, of the kind `sort` - that the game says
-- is of the map `on`: is it another place's? A zone's map shows a strip of its neighbours round
-- its edges, and the towns within it, and the game puts their quests' pins on it too. Only where
-- the game says so; where it says nothing, the pin is this place's.
local function Elsewhere(place, id, sort, on, x, y, near, wide)
  if on and on > 0 and on ~= id then
    local kind = KindOf(on)
    if kind and kind >= ZONE then return not Among(place.maps, on) end
  end
  if sort ~= ZONE then return false end  -- (a cave's map, a dungeon's floor: nothing of a neighbour is on it)
  if near and Others(place, At(id, x, y)) then return true end
  if wide and Others(place, AtWide(id, x, y)) then return true end
  return false
end

-- The quests of yours (`mine`) that the game's map of the place pins in the place itself: into `found`.
local function Pinned(place, mine, found)
  if type(Q.GetQuestsOnMap) ~= "function" then return end
  for _, id in ipairs(place.maps) do
    local sort = KindOf(id)
    local list = call(Q.GetQuestsOnMap, id)
    if open(list) then
      local near, wide = false, false
      if sort == ZONE then near, wide = Believed(place, id) end
      for k = 1, math.min(#list, PINS) do
        local pin = list[k]
        if open(pin) then
          local quest, x, y = plain(pin.questID), plain(pin.x), plain(pin.y)
          -- (not a quest on offer, not one of the map's own signs; and a pin on the very edge of a map is one the game had no place for)
          if quest and mine[quest] and not found[quest] and x and y and x > 0 and x < 1 and y > 0 and y < 1
            and not yes(pin.isQuestStart) and not yes(pin.isMapIndicatorQuest)
            and not Elsewhere(place, id, sort, plain(pin.mapID), x, y, near, wide) then
            found[quest] = true
          end
        end
      end
    end
  end
end

-- Is the quest one the game marks as a dungeon's or a raid's?
local function OfDungeon(id)
  local tag = call(Q.GetQuestTagInfo, id)
  if not open(tag) then return false end
  local mark = plain(tag.tagID)
  return mark ~= nil and INSIDE[mark] == true
end

-- The quests of your log with something to do at the place, in the order of your log; how many
-- were found in each way; and how many quests your log has.
local function Takes(place)
  local list, under = Quests(false)
  local mine, pinned = {}, {}
  for _, id in ipairs(list) do mine[id] = true end
  Pinned(place, mine, pinned)
  local ask = rawget(_G, "GetQuestUiMapID")
  local here, how = {}, { pin = 0, map = 0, heading = 0 }
  for _, id in ipairs(list) do
    local way = nil
    local headed = under[id] ~= nil and place.names[under[id]] == true
    if pinned[id] then way = "pin" else
      -- (the map the game opens for the quest: this place's, another's - or none)
      local on = plain(call(ask, id))
      local sort = on and on > 0 and KindOf(on) or nil
      if sort and sort >= ZONE then
        if Among(place.maps, on) then way = "map"
        -- (inside a dungeon its quests are its own, though the game pins them to the door outside:
        -- but one that is done, and to be handed in out there, has nothing left to do in here)
        elseif place.dungeon and headed and not Ready(id) then way = "heading" end
      elseif headed then
        way = "heading"
      end
    end
    -- (outside, a dungeon's quest with something still to do is the dungeon's: the game pins it to the door)
    if way and not place.dungeon and OfDungeon(id) and not Ready(id) then way = nil end
    if way then
      here[#here + 1] = id
      how[way] = how[way] + 1
    end
  end
  return here, how, #list
end

local function TrackHere()
  local place = Where()
  if not place.name then
    say("the game does not say where you are just now.")
    shared.Log("tracked here: the game names no place")
    return
  end
  local here, how, all = Takes(place)
  local want = {}
  for _, id in ipairs(here) do want[id] = true end
  -- every other quest untracked first (there is room for 25 at most), then these tracked
  local can = CanUntrack()
  local gone, kept = 0, 0
  if can then
    local others = {}
    for _, id in ipairs(Tracked()) do
      if not want[id] then others[#others + 1] = id end
    end
    if #others > 0 then gone, kept = Drop(others) end
  end
  local most = Most()
  local added, already, full, refused = Take(here, most)
  shared.Log(format("tracked here: %s%s (maps %s): %d of %d quests (%d by the map's pins, %d by the map of the quest, %d by their heading), %d tracked now, %d were, %d untracked, %d kept by the game, %d no room (%d at most), %d refused",
    place.name, place.dungeon and ", inside" or "", #place.maps > 0 and table.concat(place.maps, ",") or "none", #here, all, how.pin, how.map, how.heading, added, already, gone, kept, full, most, refused))
  local out
  if #here == 0 then
    out = format("no quest in your log has anything to do in %s", place.name)
    if gone > 0 then out = out .. format("; %s untracked", count(gone, "quest", "quests")) end
  else
    out = format("%s with something to do in %s tracked", count(added + already, "quest", "quests"), place.name)
    if added + already == 0 then out = format("no quest with something to do in %s could be tracked", place.name) end
    if already > 0 and added > 0 then out = out .. format(" (%d %s already)", already, already == 1 and "was" or "were") end
    if gone > 0 then out = out .. format("; %s untracked", count(gone, "other quest", "other quests")) end
  end
  if kept > 0 then out = out .. format("; the game kept %d tracked", kept) end
  if not can then out = out .. "; the game lets no quest be untracked yet" end
  if full > 0 then out = out .. format("; %d more could not be, as the game tracks %d quests at most", full, most) end
  if refused > 0 then out = out .. format("; the game would not track %d of them", refused) end
  say(out .. ".")
end

-- ---- when ----------------------------------------------------------------------------------------
-- Now - or, in a fight, the moment it is over: what was asked for then is done in the order it
-- was asked (untracked all and then the ready ones tracked leaves those, the other way round
-- leaves none). And not in the very frames the height is being measured (Height.lua), which
-- points the game's marker at a flight master for a moment and then back at the quest it was on:
-- untracked in those frames, that quest would be focused again.
local DO = { track = TrackReady, untrack = UntrackAll, here = TrackHere }
local LATER = {
  track = "in a fight: the quests ready to hand in are tracked the moment it is over.",
  untrack = "in a fight: your quests are untracked the moment it is over.",
  here = "in a fight: the quests with something to do where you are then are tracked, and the others untracked, the moment it is over.",
}
local queue = {}  -- asked for in a fight, in order
local waiter = CreateFrame("Frame")
local function Go(list, waited)
  if InCombatLockdown and InCombatLockdown() then
    for _, what in ipairs(list) do
      if queue[#queue] ~= what then
        queue[#queue + 1] = what
        say(LATER[what])
      end
    end
    waiter:RegisterEvent("PLAYER_REGEN_ENABLED")
    return
  end
  waited = waited or 0
  if shared.measuring and waited < WAITS and C_Timer and C_Timer.After then
    C_Timer.After(WAIT, function() shared.Try("tracked: later", Go, list, waited + 1) end)
    return
  end
  for _, what in ipairs(list) do shared.Try("tracked: " .. what, DO[what]) end
end
waiter:SetScript("OnEvent", function(self)
  self:UnregisterEvent("PLAYER_REGEN_ENABLED")
  local list = queue
  queue = {}
  if #list > 0 then shared.Try("tracked: after the fight", Go, list) end
end)

local function Unable() say("this game has no way for an addon to track or untrack quests.") end
-- /atlas track, /atlas track here, /atlas untrack (and the menus)
function shared.TrackReady() if able then shared.Try("tracked: track", Go, { "track" }) else Unable() end end
function shared.UntrackAll() if able then shared.Try("tracked: untrack", Go, { "untrack" }) else Unable() end end
function shared.TrackHere() if able then shared.Try("tracked: here", Go, { "here" }) else Unable() end end
-- (for the tests: where you are, and which quests are taken to be of that place and why)
function shared.TrackedPlace() local place = Where() local here, how = Takes(place) return place, here, how end

-- ---- the game's menus ----------------------------------------------------------------------------
-- The game builds each of its menus anew when it opens, and then lets whoever asked add to it.
local MENUS = {
  "MENU_QUEST_MAP_FRAME_SETTINGS", -- the quest log's options (the button by its search box)
  "MENU_QUEST_MAP_FRAME",          -- a right-click on a zone's name in the quest log
  "MENU_QUEST_OBJECTIVE_TRACKER",  -- a right-click on a quest in the list of those you track
}
local function Tip(button, title, words)
  if type(button) == "table" and type(button.SetTitleAndTextTooltip) == "function" then pcall(button.SetTitleAndTextTooltip, button, title, words) end
end
local function Add(_, root)
  if type(root) ~= "table" or type(root.CreateButton) ~= "function" then return end
  if type(root.CreateDivider) == "function" then root:CreateDivider() end
  Tip(root:CreateButton("Track All Completed Quests", function() shared.TrackReady() end), "Track All Completed Quests",
    "Every quest in your log that is ready to hand in, in every zone, is tracked - as many as there is room for (the game tracks " .. Most() .. " at most). Azeroth Atlas; also /atlas track.")
  local at = Where().name
  Tip(root:CreateButton("Track Location Quests", function() shared.TrackHere() end), "Track Location Quests",
    "The quests you track become those with something to do where you are" .. (at and (" - " .. at .. " just now") or "")
    .. ": every other quest is untracked, and these are tracked. Where a quest has something to do is as the game's own map pins it; a dungeon is a place of its own. Azeroth Atlas; also /atlas track here.")
  if CanUntrack() then
    Tip(root:CreateButton("Untrack All Quests", function() shared.UntrackAll() end), "Untrack All Quests",
      "Every quest you track, in every zone, is untracked. Azeroth Atlas; also /atlas untrack.")
  end
end
local hooked = 0
if able and type(Menu) == "table" and type(Menu.ModifyMenu) == "function" then
  for _, tag in ipairs(MENUS) do
    if pcall(Menu.ModifyMenu, tag, function(owner, root) shared.Try("tracked: menu", Add, owner, root) end) then hooked = hooked + 1 end
  end
end
shared.Log(not able and "tracked: this game has no way for an addon to track or untrack quests"
  or hooked == 0 and "tracked: this game lets no addon add to its menus: /atlas track, /atlas track here and /atlas untrack only"
  or format("tracked: Track All Completed Quests, Track Location Quests and Untrack All Quests added to %d of the game's menus", hooked))
