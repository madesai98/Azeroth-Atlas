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
-- They are in three of the game's own menus, after what the game has there: the quest log's
-- options (the button by its search box), the right-click on a zone's name in the quest log
-- (below the game's own two, which are for that zone only), and the right-click on a quest in
-- the list on the right. Typed, they are /atlas track and /atlas untrack. What was done is said
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

-- The quests of your log, as its list shows them (not its headings, not what the game hides, not
-- world quests or bonus objectives) - all of them, or only those ready to hand in. Quests under
-- a heading you folded away are there all the same.
local function Quests(ready)
  local list = {}
  local n = plain(call(Q.GetNumQuestLogEntries)) or 0
  for i = 1, n do
    local info = call(Q.GetInfo, i)
    if open(info) and not yes(info.isHeader) and not yes(info.isHidden) and not yes(info.isTask) and not yes(info.isBounty) then
      local id = plain(info.questID)
      if id and id > 0 and (not ready or Ready(id)) then list[#list + 1] = id end
    end
  end
  return list
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

local function TrackReady()
  local ready = Quests(true)
  if #ready == 0 then say("no quest in your log is ready to hand in.") shared.Log("tracked: none ready to hand in") return end
  local most = Most()
  local added, already, full, refused = 0, 0, 0, 0
  for _, id in ipairs(ready) do
    if IsTracked(id) then already = already + 1
    elseif Tracking() >= most then full = full + 1
    elseif yes(call(Q.AddQuestWatch, id)) or IsTracked(id) then added = added + 1
    else refused = refused + 1 end
  end
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
  shared.Log(format("untracked: %d of %d, %d kept by the game", gone, #list, kept))
  say(format("%s untracked", count(gone, "quest", "quests")) .. (kept > 0 and format("; the game kept %d tracked", kept) or "") .. ".")
end

-- ---- when ----------------------------------------------------------------------------------------
-- Now - or, in a fight, the moment it is over: what was asked for then is done in the order it
-- was asked (untracked all and then the ready ones tracked leaves those, the other way round
-- leaves none). And not in the very frames the height is being measured (Height.lua), which
-- points the game's marker at a flight master for a moment and then back at the quest it was on:
-- untracked in those frames, that quest would be focused again.
local DO = { track = TrackReady, untrack = UntrackAll }
local queue = {}  -- asked for in a fight, in order
local waiter = CreateFrame("Frame")
local function Go(list, waited)
  if InCombatLockdown and InCombatLockdown() then
    for _, what in ipairs(list) do
      if queue[#queue] ~= what then
        queue[#queue + 1] = what
        say(what == "track" and "in a fight: the quests ready to hand in are tracked the moment it is over." or "in a fight: your quests are untracked the moment it is over.")
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
-- /atlas track, /atlas untrack (and the menus)
function shared.TrackReady() if able then shared.Try("tracked: track", Go, { "track" }) else Unable() end end
function shared.UntrackAll() if able then shared.Try("tracked: untrack", Go, { "untrack" }) else Unable() end end

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
  or hooked == 0 and "tracked: this game lets no addon add to its menus: /atlas track and /atlas untrack only"
  or format("tracked: Track All Completed Quests and Untrack All Quests added to %d of the game's menus", hooked))
