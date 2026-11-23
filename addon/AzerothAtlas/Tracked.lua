-- Azeroth Atlas: the quests you track, all at once.
--
-- The game tracks a quest - its objectives stand in the list on the right of the screen - when
-- you tick it in the quest log, and it tracks or untracks all the quests of one zone at once (a
-- right-click on the zone's name in the quest log: "Track All", "Untrack All"). It has nothing
-- for the whole log. Asked for on 20 November 2026 ("a button that adds all completed quests to
-- the tracked list would be sick, and also an untrack all button"), this adds two:
--
--   Track All Completed Quests   the quests you track become those of your log that are ready to
--                                hand in (as many as the game has room for: it tracks 25 at most)
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
-- And, asked for on 22 November 2026:
--
--   Track Dungeon Quests         the quests you track become those of one dungeon, with the
--                                quests of your log that lead up to them (further down: a
--                                dungeon's quests, and the quests that lead up to them)
--
--   - Track All Completed Quests clears the list first, as the other two do ("the tracklog
--     should be cleared first then filled with completed quest");
--   - whatever one of the three tracks stands with the most rewarding quest at the top of the
--     list: by experience and then by gold (further down: what a quest gives, and the order
--     that makes).
--
-- They are in three of the game's own menus, after what the game has there: the quest log's
-- options (the button by its search box), the right-click on a zone's name in the quest log
-- (below the game's own two, which are for that zone only), and the right-click on a quest in
-- the list on the right. Typed, they are /atlas track, /atlas track here, /atlas track dungeon
-- (and a dungeon's name after it, for that one alone) and /atlas untrack. What was done is said
-- in chat.
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

-- ---- what a quest gives, and the order that makes ------------------------------------------------
-- Asked for on 22 November 2026: "When using any of the auto track buttons we made, the quests
-- should track so that the quest with the highest returns appear at the top of the track list
-- (last in). XP is prioritized first, once quests in the list reach less than half of the xp the
-- top quest gives prioritize gold after that. for gold, it should be based on total gold which is
-- gold rewarded plus the gold received from the highest vendor selling items offered in the quest".
--
-- So the quests one of the three entries tracks stand in this order, from the top of the list:
--   - first those that give at least half the experience of the one that gives most, by their
--     experience, the most first (of two that give the same, the one worth more gold);
--   - then the rest, by what they are worth in gold, the most first (of two alike, by experience).
-- With no experience to be had from any of them (at the highest level), all go by gold.
-- A quest's gold is the money it pays and what a vendor pays for what it hands you: everything
-- it gives outright, and of the things it lets you choose one of, the one a vendor pays most for.
--
-- What a quest gives is the game's own word, for your character as it is now (the experience a
-- quest gives falls as you outgrow it): GetQuestLogRewardXP and the calls beside it, as the
-- game's own tooltips use them. Where the game does not say - it has not been sent a quest's
-- rewards yet, or has not been shown an item and so has no price for it - the Atlas database
-- says: the 3D map writes what each quest gives and what a vendor pays for each thing as a small
-- addon of its own beside this one (AzerothAtlas_Quests: the map's server/questbook.js).
local BOOK = "AzerothAtlasQuests"
local function Book()
  local book = rawget(_G, BOOK)
  if type(book) == "table" then return book end
  return nil
end
local function Global(name)
  local fn = rawget(_G, name)
  if type(fn) == "function" then return fn end
  return nil
end
-- The things of a list as the book writes one ("item item*how many ..."): each handed to `each`.
local function Things(list, each)
  for item, many in string.gmatch(list, "(%d+)%*?(%d*)") do each(tonumber(item), tonumber(many) or 1) end
end
-- What a vendor pays for one of a thing, in copper: the game's word where it has one, else the book's.
local function Sell(item)
  local fn = type(C_Item) == "table" and C_Item.GetItemInfo or Global("GetItemInfo")
  if type(fn) == "function" then
    local ok, _, _, _, _, _, _, _, _, _, _, price = pcall(fn, item)
    price = ok and plain(price) or nil
    if price and price >= 0 then return price end
  end
  local book = Book()
  local price = book and type(book.sell) == "table" and plain(book.sell[item]) or nil
  return price or 0
end
-- What the book has a quest giving: experience, copper, and what its things fetch at a vendor - or nothing.
local function Said(id)
  local book = Book()
  local line = book and type(book.gives) == "table" and book.gives[id] or nil
  if type(line) ~= "string" then return nil end
  local xp, money, rest = string.match(line, "^(%d+) (%d+) ?(.*)$")
  if not xp then return nil end
  local goods = 0
  local given, choice = string.match(rest, "^([^|]*)|(.*)$")
  if given then
    local best = 0
    Things(given, function(item, many) goods = goods + Sell(item) * many end)
    Things(choice, function(item, many) local worth = Sell(item) * many if worth > best then best = worth end end)
    goods = goods + best
  end
  return tonumber(xp), tonumber(money), goods
end
-- What the game says a quest's things fetch at a vendor - or nothing, where it lists none.
local function Goods(id)
  local count, one, choices, choice = Global("GetNumQuestLogRewards"), Global("GetQuestLogRewardInfo"), Global("GetNumQuestLogChoices"), Global("GetQuestLogChoiceInfo")
  if not (count and one and choices and choice) then return nil end
  local n, m = plain(call(count, id)) or 0, plain(call(choices, id)) or 0
  if n + m <= 0 then return nil end
  local total, best = 0, 0
  for i = 1, math.min(n, 12) do
    local ok, _, _, many, _, _, item = pcall(one, i, id)
    item, many = ok and plain(item) or nil, ok and plain(many) or nil
    if not item or item <= 0 then return nil end  -- (a thing the game does not name yet: the book says)
    total = total + Sell(item) * math.max(1, many or 1)
  end
  for i = 1, math.min(m, 12) do
    local ok, _, _, many, _, _, item = pcall(choice, i, id)
    item, many = ok and plain(item) or nil, ok and plain(many) or nil
    if not item or item <= 0 then return nil end
    local worth = Sell(item) * math.max(1, many or 1)
    if worth > best then best = worth end
  end
  return total + best
end
-- Can your character still gain experience? (Not at the highest level: a quest's experience is nothing then.)
local function Learning()
  local rules = rawget(_G, "GameRulesUtil")
  local fn = type(rules) == "table" and rules.IsPlayerAtEffectiveMaxLevel or Global("IsPlayerAtEffectiveMaxLevel")
  if type(fn) == "function" then
    local ok, capped = pcall(fn)
    if ok and not secret(capped) then return capped ~= true end
  end
  return true
end
-- What a quest of your log gives: experience, and gold (in copper: its money, and what its things fetch).
local function Worth(id)
  local bookXp, bookMoney, bookGoods = Said(id)
  -- (the game's word counts where it has been sent what the quest gives: asked, where it can be)
  local have = Global("HaveQuestRewardData")
  local told = true
  if have then local ok, has = pcall(have, id) told = not ok or secret(has) or has ~= false end
  local xp, money, goods = nil, nil, nil
  if told then
    local fn = Global("GetQuestLogRewardXP")
    if fn then xp = plain(call(fn, id)) end
    fn = Global("GetQuestLogRewardMoney")
    if fn then money = plain(call(fn, id)) end
    goods = Goods(id)
  end
  if not xp or xp <= 0 then xp = Learning() and bookXp or 0 end
  if not money or (money <= 0 and not told) then money = bookMoney end
  if money == nil then money = 0 end
  if goods == nil then goods = bookGoods or 0 end
  return xp or 0, math.max(0, money) + goods
end

-- The quests in the order they are to stand from the top of the list (see above), and, for the
-- addon's notes, what each was taken to give.
local function Ranked(list)
  local rows, top = {}, 0
  for k, id in ipairs(list) do
    local xp, gold = Worth(id)
    rows[k] = { id = id, xp = xp, gold = gold, at = k }
    if xp > top then top = xp end
  end
  local half = top / 2
  table.sort(rows, function(a, b)
    local first, second = top > 0 and a.xp >= half, top > 0 and b.xp >= half
    if first ~= second then return first end
    if first then
      if a.xp ~= b.xp then return a.xp > b.xp end
      if a.gold ~= b.gold then return a.gold > b.gold end
    else
      if a.gold ~= b.gold then return a.gold > b.gold end
      if a.xp ~= b.xp then return a.xp > b.xp end
    end
    return a.at < b.at
  end)
  local order, words = {}, {}
  for k, row in ipairs(rows) do
    order[k] = row.id
    if k <= 30 then words[k] = format("%d (%d xp, %d copper)", row.id, row.xp, row.gold) end
  end
  return order, table.concat(words, ", ")
end

-- Which end of the game's list a newly tracked quest goes to. In this game the last one tracked
-- stands at the top (as the report has it: "(last in)"), so the quests are tracked from the
-- least rewarding to the most. That is not taken on trust: once they are tracked the game is
-- asked how they stand, and if it has them the other way round they are untracked and tracked
-- once more, the other way - and which way it was is kept, to be right at once the next time.
local function LastOnTop()
  local db = rawget(_G, "AzerothAtlasDB")
  return not (type(db) == "table" and db.trackedTop == "first")
end
local function SetLastOnTop(on)
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.trackedTop = on and "last" or "first"
end
-- Those of `list` that are tracked, as the game's list has them from its top.
local function Standing(list)
  local among, out = {}, {}
  for _, id in ipairs(list) do among[id] = true end
  for i = 1, Tracking() do
    local id = plain(call(Q.GetQuestIDForQuestWatchIndex, i))
    if id and among[id] then
      out[#out + 1] = id
      among[id] = nil
    end
  end
  return out
end
local function Alike(a, b, turned)
  if #a ~= #b then return false end
  for i = 1, #a do
    if a[i] ~= b[turned and (#b + 1 - i) or i] then return false end
  end
  return true
end
-- These quests - `order`, the most rewarding first - tracked so that they stand in that order
-- from the top of the game's list: as many as there is room for, the most rewarding of them.
-- Returns how many found no room, how many the game refused, and how they stand: true as asked,
-- false in an order of the game's own, nil where there were not two to tell by.
local function Arrange(order, most)
  local room = math.max(0, most - Tracking())
  local take, full = {}, 0
  for _, id in ipairs(order) do
    if not IsTracked(id) then
      if #take < room then take[#take + 1] = id else full = full + 1 end
    end
  end
  local function put(lastOnTop)
    for k = 1, #take do
      local id = take[lastOnTop and (#take + 1 - k) or k]
      if not IsTracked(id) then call(Q.AddQuestWatch, id) end
    end
  end
  -- (those the game took: as they stand, and as they should)
  local function taken()
    local got, has, want = Standing(take), {}, {}
    for _, id in ipairs(got) do has[id] = true end
    for _, id in ipairs(take) do
      if has[id] then want[#want + 1] = id end
    end
    return got, want
  end
  local last = LastOnTop()
  put(last)
  local got, want = taken()
  local stands = nil
  if #got >= 2 then
    if Alike(got, want) then
      stands = true
      SetLastOnTop(last)
    elseif Alike(got, want, true) and CanUntrack() then
      Drop(got)
      put(not last)
      got, want = taken()
      stands = #got >= 2 and Alike(got, want)
      if stands then SetLastOnTop(not last) end
      shared.Log(format("tracked: the game's list had them the other way round: tracked once more, %s; they %s", last and "the most rewarding first" or "the most rewarding last", stands and "stand as asked now" or "still do not stand as asked"))
    else
      stands = false
    end
  end
  return full, #take - #got, stands
end

-- The quests you track become these, the most rewarding at the top. Every quest you track is
-- untracked first: the others to make room (the game tracks 25 at most), and these to be tracked
-- again in their order. The quest the game focused is focused again if it is one of them (the
-- game lets go of it when it is untracked). What was done:
--   { order, worth (for the notes), added, already (tracked before, and still), gone (others
--     untracked), kept (others the game kept tracked), full, refused, stands, can (the game lets
--     quests be untracked), most }
local function Become(wanted)
  local order, worth = Ranked(wanted)
  local want, was = {}, {}
  for _, id in ipairs(order) do want[id] = true end
  local before = Tracked()
  for _, id in ipairs(before) do was[id] = true end
  local focus = C_SuperTrack and plain(call(C_SuperTrack.GetSuperTrackedQuestID)) or nil
  local can = CanUntrack()
  if can and #before > 0 then Drop(before) end
  local most = Most()
  local full, refused, stands = Arrange(order, most)
  if focus and focus > 0 and want[focus] and IsTracked(focus) and C_SuperTrack and (plain(call(C_SuperTrack.GetSuperTrackedQuestID)) or 0) == 0 then
    call(C_SuperTrack.SetSuperTrackedQuestID, focus)
  end
  local done = { order = order, worth = worth, added = 0, already = 0, gone = 0, kept = 0, full = full, refused = refused, stands = stands, can = can, most = most }
  for _, id in ipairs(order) do
    if IsTracked(id) then
      if was[id] then done.already = done.already + 1 else done.added = done.added + 1 end
    end
  end
  for _, id in ipairs(before) do
    if not want[id] then
      if IsTracked(id) then done.kept = done.kept + 1 else done.gone = done.gone + 1 end
    end
  end
  return done
end
-- What is said of it after "N quests ... tracked": their order, and what became of the others.
local function Rest(done)
  local out = ""
  if done.stands == true then out = out .. ", the most rewarding at the top"
  elseif done.stands == false then out = out .. " (the game put them in an order of its own)" end
  if done.gone > 0 then out = out .. format("; %s untracked", count(done.gone, "other quest", "other quests")) end
  if done.kept > 0 then out = out .. format("; the game kept %d tracked", done.kept) end
  if not done.can then out = out .. "; the game lets no quest be untracked yet" end
  if done.full > 0 then out = out .. format("; %d more could not be, as the game tracks %d quests at most", done.full, done.most) end
  if done.refused > 0 then out = out .. format("; the game would not track %d of them", done.refused) end
  return out
end
local function Noted(done)
  return format("%d tracked now, %d were, %d untracked, %d kept by the game, %d no room (%d at most), %d refused, order %s: %s",
    done.added, done.already, done.gone, done.kept, done.full, done.most, done.refused,
    done.stands == true and "as asked" or done.stands == false and "the game's own" or "not to be told", done.worth)
end

-- Track All Completed Quests. The list is cleared first (asked for on 22 November 2026: "When
-- clicking track completed quests, the tracklog should be cleared first then filled with
-- completed quest"): what you track becomes the quests ready to hand in, and nothing else.
-- With none ready, the list is left as it is: there is nothing to put in its place.
local function TrackReady()
  local ready = Quests(true)
  if #ready == 0 then
    say("no quest in your log is ready to hand in: the quests you track are left as they are.")
    shared.Log("tracked: none ready to hand in")
    return
  end
  local done = Become(ready)
  shared.Log(format("tracked: %d ready to hand in, %s", #ready, Noted(done)))
  local got = done.added + done.already
  if got == 0 then say(format("no quest ready to hand in could be tracked%s.", Rest(done))) return end
  say(format("%s ready to hand in tracked%s.", count(got, "quest", "quests"), Rest(done)))
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
  -- every quest untracked first (there is room for 25 at most), then these tracked, the most rewarding at the top
  local done = Become(here)
  shared.Log(format("tracked here: %s%s (maps %s): %d of %d quests (%d by the map's pins, %d by the map of the quest, %d by their heading), %s",
    place.name, place.dungeon and ", inside" or "", #place.maps > 0 and table.concat(place.maps, ",") or "none", #here, all, how.pin, how.map, how.heading, Noted(done)))
  local got = done.added + done.already
  if #here == 0 then
    local out = format("no quest in your log has anything to do in %s", place.name)
    if done.gone > 0 then out = out .. format("; %s untracked", count(done.gone, "quest", "quests")) end
    if done.kept > 0 then out = out .. format("; the game kept %d tracked", done.kept) end
    if not done.can then out = out .. "; the game lets no quest be untracked yet" end
    say(out .. ".")
  elseif got == 0 then
    say(format("no quest with something to do in %s could be tracked%s.", place.name, Rest(done)))
  else
    say(format("%s with something to do in %s tracked%s.", count(got, "quest", "quests"), place.name, Rest(done)))
  end
end

-- ---- a dungeon's quests, and the quests that lead up to them --------------------------------------
-- Asked for on 22 November 2026: "Add button to untrack all and track dungeon quests and their
-- prerequisite quests. I want to be able to track all my chain quests for a specific dungeon".
--
-- The quests of a dungeon are those the Atlas database files under it, and the quests that lead
-- up to them are those one of them asks for first, and so on back along the chain: both as the
-- 3D map writes them for the game (AzerothAtlas_Quests, see above; the map's server/questbook.js).
-- Of those, the ones in your quest log are tracked - the game tracks no quest you do not have.
-- And whatever stands under the dungeon's name in your quest log is the dungeon's too, whether
-- the database knows it or not.
local dungeons = nil  -- the dungeons of the book, as read once: { { name, plain, level, own = { [quest] = true }, up = { [quest] = true } } }
local function Dungeons()
  if dungeons then return dungeons end
  local book = Book()
  local list = book and book.dungeons
  if type(list) ~= "table" then return {} end
  dungeons = {}
  for _, d in ipairs(list) do
    local name = type(d) == "table" and text(d.name) or nil
    if name then
      local one = { name = name, plain = Plain(name), level = plain(d.level) or 0, own = {}, up = {} }
      if type(d.own) == "string" then Things(d.own, function(id) one.own[id] = true end) end
      if type(d.up) == "string" then Things(d.up, function(id) one.up[id] = true end) end
      dungeons[#dungeons + 1] = one
    end
  end
  return dungeons
end
-- The quests of your log that are a dungeon's or lead up to it, in the order of your log; how
-- many are its own, and how many lead up to it.
local function OfDungeonNow(d, list, under)
  local out, own, up = {}, 0, 0
  for _, id in ipairs(list) do
    if d.own[id] or under[id] == d.plain then
      out[#out + 1] = id
      own = own + 1
    elseif d.up[id] then
      out[#out + 1] = id
      up = up + 1
    end
  end
  return out, own, up
end
-- The dungeons your quest log has something for, in the book's order (by the level of their
-- quests): { { name, plain, quests, own, up } }; and your log, for whoever goes on with it.
local function Mine()
  local list, under = Quests(false)
  local out = {}
  for _, d in ipairs(Dungeons()) do
    local quests, own, up = OfDungeonNow(d, list, under)
    if #quests > 0 then out[#out + 1] = { name = d.name, plain = d.plain, quests = quests, own = own, up = up } end
  end
  return out, list, under
end
-- The dungeon meant by what was typed or chosen: the one of that name, else the one whose name
-- begins with it, else the one with it in its name - where that is one and no more.
local function Meant(words)
  local want = Plain(words)
  if want == "" then return nil end
  local all = Dungeons()
  for _, d in ipairs(all) do
    if d.plain == want then return d end
  end
  local found, several = nil, false
  for pass = 1, 2 do
    for _, d in ipairs(all) do
      local at = string.find(d.plain, want, 1, true)
      if at and (pass == 2 or at == 1) then
        if found and found ~= d then several = true end
        found = found or d
      end
    end
    if found then break end
  end
  if several then return nil, true end
  return found
end
-- `which`: a dungeon's name (or part of it); nothing: every dungeon your log has something for.
local function TrackDungeon(which)
  if #Dungeons() == 0 then
    say("which quests lead to which dungeon comes from the 3D map, and is not here yet: open Azeroth Atlas, press Check for updates there, and start the game again.")
    shared.Log("tracked dungeon: no book of quests (AzerothAtlas_Quests is not loaded)")
    return
  end
  local mine, list, under = Mine()
  local wanted, name, own, up = {}, nil, 0, 0
  if which and which ~= "" then
    local d, several = Meant(which)
    if not d then
      local names = {}
      for _, m in ipairs(mine) do names[#names + 1] = m.name end
      say(format(several and "more than one dungeon is called something like \"%s\"" or "no dungeon is called \"%s\"", which)
        .. (#names > 0 and (": your quest log has something for " .. table.concat(names, ", ") .. ".") or ": and your quest log has nothing for any dungeon."))
      shared.Log(format("tracked dungeon: \"%s\" is %s", which, several and "more than one dungeon" or "no dungeon"))
      return
    end
    name = d.name
    wanted, own, up = OfDungeonNow(d, list, under)
  else
    local seen = {}
    for _, m in ipairs(mine) do
      own, up = own + m.own, up + m.up
      for _, id in ipairs(m.quests) do
        if not seen[id] then seen[id] = true end
      end
    end
    -- (in the order of your log; a quest that leads up to two dungeons is one quest)
    for _, id in ipairs(list) do
      if seen[id] then wanted[#wanted + 1] = id end
    end
    name = #mine == 1 and mine[1].name or nil
  end
  local where = name or "a dungeon"
  if #wanted == 0 then
    say(format("no quest in your log is %s's or leads up to it: the quests you track are left as they are.", name or "a dungeon"))
    shared.Log(format("tracked dungeon: %s: none of %d quests", where, #list))
    return
  end
  local done = Become(wanted)
  shared.Log(format("tracked dungeon: %s: %d of %d quests (%d its own, %d leading up to it), %s", which and which ~= "" and where or "every dungeon", #wanted, #list, own, up, Noted(done)))
  local got = done.added + done.already
  local what = name and format("of %s and leading up to it", name) or "of your dungeons and leading up to them"
  if got == 0 then say(format("no quest %s could be tracked%s.", what, Rest(done))) return end
  say(format("%s %s tracked%s.", count(got, "quest", "quests"), what, Rest(done)))
end

-- ---- when ----------------------------------------------------------------------------------------
-- Now - or, in a fight, the moment it is over: what was asked for then is done in the order it
-- was asked (untracked all and then the ready ones tracked leaves those, the other way round
-- leaves none). And not in the very frames the height is being measured (Height.lua), which
-- points the game's marker at a flight master for a moment and then back at the quest it was on:
-- untracked in those frames, that quest would be focused again.
-- (what is asked for is a word: "track", "untrack", "here", or "dungeon" - every dungeon - or
-- "dungeon:" and a dungeon's name)
local function Do(what)
  if what == "track" then TrackReady()
  elseif what == "untrack" then UntrackAll()
  elseif what == "here" then TrackHere()
  else
    local which = string.match(what, "^dungeon:?(.*)$")
    if which then TrackDungeon(which) end
  end
end
local function Later(what)
  if what == "track" then return "in a fight: the quests ready to hand in are tracked, and the others untracked, the moment it is over." end
  if what == "untrack" then return "in a fight: your quests are untracked the moment it is over." end
  if what == "here" then return "in a fight: the quests with something to do where you are then are tracked, and the others untracked, the moment it is over." end
  return "in a fight: the dungeon's quests and those leading up to them are tracked, and the others untracked, the moment it is over."
end
local queue = {}  -- asked for in a fight, in order
local waiter = CreateFrame("Frame")
local function Go(list, waited)
  if InCombatLockdown and InCombatLockdown() then
    for _, what in ipairs(list) do
      if queue[#queue] ~= what then
        queue[#queue + 1] = what
        say(Later(what))
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
  for _, what in ipairs(list) do shared.Try("tracked: " .. what, Do, what) end
end
waiter:SetScript("OnEvent", function(self)
  self:UnregisterEvent("PLAYER_REGEN_ENABLED")
  local list = queue
  queue = {}
  if #list > 0 then shared.Try("tracked: after the fight", Go, list) end
end)

local function Unable() say("this game has no way for an addon to track or untrack quests.") end
-- /atlas track, /atlas track here, /atlas track dungeon [its name], /atlas untrack (and the menus)
function shared.TrackReady() if able then shared.Try("tracked: track", Go, { "track" }) else Unable() end end
function shared.UntrackAll() if able then shared.Try("tracked: untrack", Go, { "untrack" }) else Unable() end end
function shared.TrackHere() if able then shared.Try("tracked: here", Go, { "here" }) else Unable() end end
function shared.TrackDungeon(which)
  if not able then Unable() return end
  which = type(which) == "string" and string.gsub(string.gsub(which, "^%s+", ""), "%s+$", "") or ""
  shared.Try("tracked: dungeon", Go, { which ~= "" and ("dungeon:" .. which) or "dungeon" })
end
-- (for the tests: where you are, and which quests are taken to be of that place and why; the
-- dungeons your log has something for; what a quest is taken to give; and the order that makes)
function shared.TrackedPlace() local place = Where() local here, how = Takes(place) return place, here, how end
function shared.TrackedDungeons() return (Mine()) end
function shared.TrackedWorth(id) return Worth(id) end
function shared.TrackedOrder(list) return (Ranked(list)) end

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
local ORDER = " They stand with the most rewarding at the top: by experience, then - below half of what the best gives - by gold."
-- "Track Dungeon Quests": it opens a list of its own, and the list holds only the dungeons your
-- quest log has something for (a quest of the dungeon's, or one leading up to it) - a handful,
-- not every dungeon of the game - each with how many quests that is, and above them all of them
-- at once where there is more than one. With nothing for any dungeon, the entry says so and
-- does nothing.
local function AddDungeons(root)
  local mine = Mine()
  local entry = root:CreateButton("Track Dungeon Quests")
  Tip(entry, "Track Dungeon Quests",
    "The quests you track become those of one dungeon, with the quests of your log that lead up to them: every other quest is untracked. The dungeons listed are those your quest log has something for." .. ORDER .. " Azeroth Atlas; also /atlas track dungeon, and a dungeon's name after it.")
  if type(entry) ~= "table" or type(entry.CreateButton) ~= "function" then return end
  if #mine == 0 then
    local none = entry:CreateButton(#Dungeons() == 0 and "Not known yet: start the game again" or "Your quest log has nothing for a dungeon")
    if type(none) == "table" and type(none.SetEnabled) == "function" then pcall(none.SetEnabled, none, false) end
    return
  end
  if #mine > 1 then
    local all = {}
    for _, m in ipairs(mine) do
      for _, id in ipairs(m.quests) do all[id] = true end
    end
    local n = 0
    for _ in pairs(all) do n = n + 1 end
    entry:CreateButton(format("All of them (%d)", n), function() shared.TrackDungeon() end)
    if type(entry.CreateDivider) == "function" then entry:CreateDivider() end
  end
  for _, m in ipairs(mine) do
    local name = m.name
    Tip(entry:CreateButton(format("%s (%d)", name, #m.quests), function() shared.TrackDungeon(name) end), name,
      format("%s of your log: %d of the dungeon itself, %d leading up to it.", count(#m.quests, "quest", "quests"), m.own, m.up))
  end
end
local function Add(_, root)
  if type(root) ~= "table" or type(root.CreateButton) ~= "function" then return end
  if type(root.CreateDivider) == "function" then root:CreateDivider() end
  Tip(root:CreateButton("Track All Completed Quests", function() shared.TrackReady() end), "Track All Completed Quests",
    "The quests you track become those ready to hand in, in every zone: every other quest is untracked, and these are tracked - as many as there is room for (the game tracks " .. Most() .. " at most)." .. ORDER .. " Azeroth Atlas; also /atlas track.")
  local at = Where().name
  Tip(root:CreateButton("Track Location Quests", function() shared.TrackHere() end), "Track Location Quests",
    "The quests you track become those with something to do where you are" .. (at and (" - " .. at .. " just now") or "")
    .. ": every other quest is untracked, and these are tracked. Where a quest has something to do is as the game's own map pins it; a dungeon is a place of its own." .. ORDER .. " Azeroth Atlas; also /atlas track here.")
  AddDungeons(root)
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
  or hooked == 0 and "tracked: this game lets no addon add to its menus: /atlas track, /atlas track here, /atlas track dungeon and /atlas untrack only"
  or format("tracked: Track All Completed Quests, Track Location Quests, Track Dungeon Quests and Untrack All Quests added to %d of the game's menus", hooked))
do
  local book = Book()
  shared.Log(book and format("tracked: what %s quests give and the quests of %d dungeons, as the 3D map wrote them from the Atlas database", tostring(book.quests), type(book.dungeons) == "table" and #book.dungeons or 0)
    or "tracked: nothing from the 3D map of what quests give or which lead to which dungeon (AzerothAtlas_Quests is not loaded): quests are ordered by the game's word alone")
end
