-- Azeroth Atlas: following a guide through the game.
--
-- GuideBook.lua reads the guides. This file follows the one you chose: which of its steps are
-- done, which you are on, and where that step sends you. The rules are Guidelime's, so a guide
-- behaves here as its writer saw it behave:
--   - a quest step is done when the game says so (the quest is in your log, its goals are met,
--     it is handed in); a level, a skill, a standing or an item to have likewise;
--   - a vendor, a trainer, an innkeeper or a new flight point is done when you open that window
--     (or tick the step); a flight when you take off; a hearthstone when you use it;
--   - a line of plain words is yours to tick off;
--   - you are on the first step that is not done, and on every optional one before it;
--   - a quest whose earlier quests you have not done, or which nothing has you accept, is out of
--     reach: its steps are passed over;
--   - steps for another class, race or faction are left out.
-- One thing is this addon's own: a step that sends you to a spot ([G...]) is reached where the
-- route to it ends, on the level it ends on - not when you stand under it on the floor below.
-- That is what the route in the game knows (Route.lua); with the 3D map not running there is
-- nothing to tell the level by, and the spot on the map decides, as it does in Guidelime.
--
-- The step you are on is your waypoint (AzerothAtlas.lua asks GuideGoal): the 3D map routes to
-- it, and the route, the arrow and the journey's steps lead you there.

local shared = AzerothAtlas
local book = type(shared) == "table" and shared.Book
if type(book) ~= "table" then return end

local Quest = book.Quest
local plain, text, yes = book.plain, book.text, book.yes
local floor, abs = math.floor, math.abs

-- what the game itself shows to be done; what is done by a window opening or a thing happening;
-- and, of those, what only that (or a tick) completes
local AUTO = { QA = true, QC = true, QT = true, XP = true, REP = true, LE = true, SK = true, CI = true }
local EVENT = { T = true, V = true, R = true, S = true, P = true, F = true, H = true, SP = true }
local HAND = { T = true, V = true, R = true, S = true, P = true }
local HEARTH_SPELL, RECALL_SPELL, HEARTHSTONE = 8690, 556, 6948
local TAXI_ICON = 132057

-- state: "wait" (not started), "foreign" (Guidelime is switched on and runs the guides), "on"
local run = { state = "wait", guide = nil, steps = {}, quests = {}, log = {}, now = {}, wide = {}, dirty = false, rev = 0, sig = "", goal = nil, goalStep = nil }
shared.Guide = run

local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end

-- ---- how you have it set ----------------------------------------------------------------------------
-- accept, turnin: "Off", "Current" (the quests of the steps you are on), "Guide" (every quest
-- the guide and the guides after it speak of), "All". The first time, as you had Guidelime set.
local MODES = { Off = true, Current = true, Guide = true, All = true }
local function Options()
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  local o = AzerothAtlasDB.guide
  if type(o) ~= "table" then
    o = {}
    AzerothAtlasDB.guide = o
  end
  -- (taken over once, the first time Guidelime's settings are there to be read - unless you have
  -- set something here yourself by then)
  if not o.seeded and (type(GuidelimeData) == "table" or type(GuidelimeDataChar) == "table") then
    o.seeded = true
    local theirs, char = GuidelimeData, GuidelimeDataChar
    local function mode(v) return v == false and "Off" or (MODES[v] and v) or "Current" end
    if type(theirs) == "table" then
      o.accept, o.turnin = mode(theirs.autoAcceptQuests), mode(theirs.autoTurnInQuests)
      o.flight, o.cutscenes = theirs.autoSelectFlight == true, theirs.skipCutscenes == true
    end
    if type(char) == "table" then
      o.showDone, o.showOut, o.showLater = char.showCompletedSteps == true, char.showUnavailableSteps ~= false, char.showUpcomingSteps ~= false
      o.shown = char.mainFrameShowing ~= false
    end
  end
  if not MODES[o.accept] then o.accept = "Current" end
  if not MODES[o.turnin] then o.turnin = "Current" end
  if o.flight == nil then o.flight = false end
  if o.cutscenes == nil then o.cutscenes = false end
  if o.showDone == nil then o.showDone = false end
  if o.showOut == nil then o.showOut = true end
  if o.showLater == nil then o.showLater = true end
  if o.buttons == nil then o.buttons = true end
  return o
end
shared.GuideOptions = Options

-- ---- the guide you follow ---------------------------------------------------------------------------
local marks = {}
local function Mark(s)
  local m = marks[s.line]
  if type(m) ~= "table" then
    m = { stepText = s.text }
    marks[s.line] = m
  end
  return m
end

-- Does a line have anything to show or to do?
local function Worth(line)
  for _, e in ipairs(line.els) do
    if e.t ~= "TEXT" and e.t ~= "A" then return true end
    if e.t == "TEXT" and not e.blank then return true end
  end
  return false
end

local function Load(name)
  local g = type(name) == "string" and book.guides[name] or nil
  run.guide, run.steps, run.quests, run.goal, run.goalStep, run.sig = g, {}, {}, nil, nil, ""
  run.now, run.wide, run.hasItems = {}, {}, false
  run.rev = run.rev + 1
  if not g then return false end
  book.Store().currentGuide = g.name
  book.Read(g)
  marks = book.Marks(g)
  run.wide = book.QuestsFrom(g)
  for _, line in ipairs(g.lines) do
    local mine = book.Fits(line.cond) and Worth(line)
    if mine then
      -- (a quest only another race or class can have: the step is theirs)
      for _, e in ipairs(line.els) do
        if e.quest and e.t ~= "QS" and Quest.ForYou(e.quest) == false then mine = false break end
      end
    end
    if mine then
      local s = { line = line.line, text = line.text, cond = line.cond, optional = line.optional == true, withNext = line.withNext == true,
        autoGoto = line.autoGoto ~= false, index = #run.steps + 1, els = {}, done = false, active = false, available = true }
      for _, src in ipairs(line.els) do
        local e = {}
        for k, v in pairs(src) do e[k] = v end
        e.done, e.out, e.reached = false, false, false
        s.els[#s.els + 1] = e
        if AUTO[e.t] then s.auto = true end
        if EVENT[e.t] then s.event = true end
        if HAND[e.t] then s.hand = true end
        if e.t == "G" then s.gotos = (s.gotos or 0) + 1 end
        if e.t == "CI" then s.items = true end
        if e.t == "TAR" then s.named = true end
        if e.quest and e.t ~= "QS" then run.quests[e.quest] = run.quests[e.quest] or { done = false } end
      end
      if s.items or (s.cond and s.cond.item) then run.hasItems = true end
      local m = marks[s.line]
      s.skip = type(m) == "table" and (m.skip == true or m.completed == true) or false
      run.steps[#run.steps + 1] = s
    end
  end
  run.dirty = true
  return true
end

-- ---- what is done ---------------------------------------------------------------------------------------
local doneBefore = {}
local function WasDone(id)
  if doneBefore[id] then return true end
  if Quest.Done(id) then
    doneBefore[id] = true
    return true
  end
  return false
end

local function ReadQuests()
  local log = Quest.Log()
  -- (a quest you failed is one you do not have)
  for id, q in pairs(log) do
    if q.failed then log[id] = nil end
  end
  run.log = log
  for id, q in pairs(run.quests) do
    if not q.done then q.done = WasDone(id) end
  end
end

local function PieceDone(e)
  local t = e.t
  if e.quest then
    local q, l = run.quests[e.quest], run.log[e.quest]
    if q and q.done then return true end
    if t == "QA" then return l ~= nil end
    if t == "QC" then
      if not l then return false end
      if l.ready then return true end
      local goal = e.objective and l.goals[e.objective]
      return goal ~= nil and goal ~= false and goal.done == true
    end
    return false
  elseif t == "XP" then
    local m = book.Me()
    if m.level > e.level then return true end
    if m.level < e.level then return false end
    if e.left then return m.xpMax - m.xp <= e.left end
    if e.part then return m.xpMax > 0 and m.xp / m.xpMax >= e.part end
    if e.xp then return m.xp >= e.xp end
    return true
  elseif t == "REP" then
    local c = { rep = e.rep, repMin = e.repMin, repMax = e.repMax }
    return book.Meets(c)
  elseif t == "LE" or t == "SK" then
    if e.spell then return book.Knows(e.spell) end
    local rank, max = book.Skill(e.skill)
    if not rank then return false end
    if e.trained then return max >= e.trained end
    return rank >= (e.rank or 1)
  elseif t == "CI" then
    local have = book.ItemCount(e.item)
    if e.count > 0 then return have >= e.count end
    return have == 0
  end
  return false
end

-- A step with nothing the game shows to be done is finished for good by what happens: kept, so
-- that it stays done after a /reload.
local function Finish(s)
  if s.skip then return end
  Mark(s).completed = true
  s.skip = true
  run.dirty = true
end

-- Such a step, after one of its pieces was done or its spot reached: is that all of it?
local function Loose(s)
  if s.auto or s.skip then return end
  local events, spots = true, true
  for _, e in ipairs(s.els) do
    if EVENT[e.t] and not e.done then events = false end
    if e.t == "G" and not e.reached then spots = false end
  end
  if (s.event and events) or (s.gotos and spots and not s.hand) then Finish(s) end
end

local function Evaluate()
  local steps = run.steps
  ReadQuests()
  local accept, turnin = {}, {} -- the quests an earlier step you have not ticked off has you accept, and hand in
  local function settled(id)
    local q = run.quests[id]
    if (q and q.done) or turnin[id] then return true end
    -- (a quest only someone else can have stands in nobody's way)
    return WasDone(id) or Quest.ForYou(id) == false
  end
  for i = 1, #steps do
    local s = steps[i]
    s.missing, s.lacking = nil, nil
    if s.skip then
      s.done, s.available = false, true
    else
      local all, hand, open, reach = true, true, false, false
      for _, e in ipairs(s.els) do
        if AUTO[e.t] then
          e.done = PieceDone(e)
          e.out = false
          if not e.done then
            all, open = false, true
            if e.t == "QA" then
              local missing = Quest.Missing(e.quest, settled)
              if #missing > 0 then
                e.out = true
                s.missing = s.missing or {}
                for _, id in ipairs(missing) do s.missing[#s.missing + 1] = id end
              end
            elseif e.quest and not accept[e.quest] and not run.log[e.quest] then
              -- (a quest you do not have, and no step before this one has you take it)
              e.out = true
              s.lacking = s.lacking or {}
              s.lacking[#s.lacking + 1] = e.quest
            end
            if not e.out then reach = true end
          end
          if e.quest and not e.out then
            if e.t == "QA" then accept[e.quest] = true elseif e.t == "QT" then turnin[e.quest] = true end
          end
        elseif HAND[e.t] and not e.done then
          hand = false
        end
      end
      s.done = s.auto == true and all and hand
      s.available = not open or reach or (s.hand == true and not s.done)
    end
  end
  -- a step that is done along with the one after it
  for i = #steps - 1, 1, -1 do
    local s, after = steps[i], steps[i + 1]
    if s.withNext and not s.skip and not s.done and (after.done or after.skip or not after.available) then s.done = true end
  end
  -- the steps you are on
  local blocked, sig, now = false, {}, {}
  run.first = nil
  for i = 1, #steps do
    local s = steps[i]
    local open = not s.done and not s.skip and s.available and book.Meets(s.cond)
    local was = s.active
    s.active = open and not blocked
    if open and not s.optional then blocked = true end
    if s.active then
      if not run.first and (not s.optional or s.withNext) then run.first = i end
      for _, e in ipairs(s.els) do
        if (e.t == "QA" or e.t == "QT") and not e.done then now[e.quest] = true end
      end
    elseif was and s.done and s.items then
      -- (what you gathered once is not asked for again should you part with it)
      Mark(s).completed = true
      s.skip = true
    end
    sig[#sig + 1] = s.skip and "s" or s.done and "d" or s.active and "a" or s.available and "." or "x"
    if s.active then
      for _, e in ipairs(s.els) do
        sig[#sig + 1] = e.done and "1" or e.out and "o" or "0"
        local l = e.quest and run.log[e.quest]
        if l and (e.t == "QC" or e.t == "QT") then
          for _, goal in ipairs(l.goals) do sig[#sig + 1] = goal.text end
        end
        if e.t == "CI" then sig[#sig + 1] = book.ItemCount(e.item) end
      end
    end
  end
  run.now = now
  local joined = table.concat(sig, "|")
  if joined ~= run.sig then
    run.sig = joined
    run.rev = run.rev + 1
  end
end

-- ---- where the step you are on sends you ---------------------------------------------------------------
local function Where()
  if not UnitPosition then return nil end
  local north, west, _, map = UnitPosition("player")
  north, west, map = plain(north), plain(west), plain(map)
  if not (north and west and map) then return nil end
  return map, north, west
end

-- The world position of a spot the guide names (worked out once).
local function Typed(e)
  if e.map == nil then
    e.map = false
    if e.uiMap then
      local map, north, west = book.World(e.uiMap, e.x, e.y)
      if map then e.map, e.north, e.west = map, north, west end
    end
  end
  return e.map ~= false
end

-- The piece of step `s` to head for: the first spot the guide names there that you have not
-- reached; in a step that names none, where the first thing still to do in it is done (the
-- quest's giver or taker, what it asks for, the NPC named).
local function Heading(s)
  if s.gotos then
    for _, e in ipairs(s.els) do
      if e.t == "G" and not e.reached and Typed(e) then return e end
    end
    return nil
  end
  if s.optional or not s.autoGoto then return nil end
  for _, e in ipairs(s.els) do
    local t = e.t
    -- (something to buy from someone the step names: it is them you go to)
    if not e.done and not e.out and (t == "QA" or t == "QT" or t == "QC" or t == "TAR" or (t == "CI" and not s.named)) then
      if e.map == nil then
        e.map = false
        local ok, map, north, west = pcall(book.Spot, e, run.log, Where())
        if ok and map then e.map, e.north, e.west = map, north, west end
      end
      if e.map then return e end
    end
  end
  return nil
end

local function FindGoal()
  for pass = 1, 2 do
    for _, s in ipairs(run.steps) do
      if s.active and (pass == 1) == (not s.optional) then
        local e = Heading(s)
        if e then return e, s end
      end
    end
  end
  return nil
end

-- Your waypoint, for AzerothAtlas.lua: map, north, west, and three numbers that name the place.
-- false: no guide is being followed here (Guidelime's own arrow is looked at instead).
function shared.GuideGoal()
  if run.state ~= "on" or not run.guide then return false end
  local e = run.goal
  if not e or not e.map then return nil end
  if e.t == "G" then return e.map, e.north, e.west, e.uiMap, floor(e.x * 10 + 0.5), floor(e.y * 10 + 0.5) end
  return e.map, e.north, e.west, e.map, floor(e.north + 0.5), floor(e.west + 0.5)
end

-- Are you at the spot the guide names? Where the route to it ends, on the level it ends on, when
-- the route in the game can tell; else within the spot's reach on the map.
local function AtSpot(e)
  if yes(UnitIsDeadOrGhost("player")) then return false end
  local map, north, west = Where()
  if not map or map ~= e.map then return false end
  local away = (north - e.north) ^ 2 + (west - e.west) ^ 2
  local there = nil
  if shared.There then
    local ok, answer = shared.Try("there", shared.There, e.radius, e.map, e.north, e.west)
    if ok then there = answer end
  end
  if there == nil then return away <= e.radius * e.radius end
  return there
end

-- Five times a second: have you reached the spot you are heading for?
local function Walk()
  local e, s = run.goal, run.goalStep
  if e and s and e.t == "G" and s.active and not e.reached and AtSpot(e) then
    e.reached = true
    Loose(s)
    run.dirty = true
  end
  -- a spot of a quest step that you walked away from again without doing what the step asks
  for _, step in ipairs(run.steps) do
    if step.active and step.auto and step.gotos then
      local last = nil
      for _, piece in ipairs(step.els) do
        if piece.t == "G" then last = piece end
      end
      if last and last.reached and last.map then
        local map, north, west = Where()
        local reach = last.radius * 2 + 6
        if map and (map ~= last.map or (north - last.north) ^ 2 + (west - last.west) ^ 2 > reach * reach) then
          last.reached = false
          run.dirty = true
        end
      end
    end
  end
end

local function Settle()
  if run.dirty then
    run.dirty = false
    Evaluate()
    -- (finishing a step can open the next: until nothing changes)
    local guard = 0
    while run.dirty and guard < 4 do
      run.dirty = false
      guard = guard + 1
      Evaluate()
    end
  end
  local e, s = FindGoal()
  if e ~= run.goal then
    run.goal, run.goalStep = e, s
    run.rev = run.rev + 1
  end
end

-- ---- what you tick -----------------------------------------------------------------------------------------
-- Tick a step off (or take the tick away: it is then judged afresh).
function shared.GuideTick(index, value)
  local s = run.steps[index]
  if not s then return end
  local m = Mark(s)
  s.skip = value and true or false
  m.skip = s.skip
  m.completed = m.completed and s.skip or nil
  if not s.skip then
    for _, e in ipairs(s.els) do
      if not AUTO[e.t] then e.done, e.reached = false, false end
    end
  end
  run.dirty = true
  run.rev = run.rev + 1
end

function shared.GuideSkipNow()
  local any = false
  for i, s in ipairs(run.steps) do
    if s.active then
      shared.GuideTick(i, true)
      any = true
    end
  end
  return any
end

-- Take every tick of this guide away (what the game shows to be done stays done).
function shared.GuideReset()
  for i, s in ipairs(run.steps) do
    local m = marks[s.line]
    if type(m) == "table" then m.skip, m.completed = nil, nil end
    if s.skip then shared.GuideTick(i, false) end
  end
  run.dirty = true
end

function shared.GuideLoad(name)
  if run.state ~= "on" then return false end
  local ok, loaded = pcall(Load, name)
  if not (ok and loaded) then
    run.guide, run.steps = nil, {}
    run.rev = run.rev + 1
    return false
  end
  return true
end

-- ---- what happens ------------------------------------------------------------------------------------------
-- A window opened, a flight taken, a spell cast: the first open piece of that kind in the steps
-- you are on is done.
local function Happened(kind, test)
  for _, s in ipairs(run.steps) do
    if s.active then
      for _, e in ipairs(s.els) do
        if e.t == kind and not e.done and (not test or test(e)) then
          e.done = true
          Loose(s)
          run.dirty = true
          return e
        end
      end
    end
  end
  return nil
end
local function Open(kind)
  for _, s in ipairs(run.steps) do
    if s.active then
      for _, e in ipairs(s.els) do
        if e.t == kind and not e.done then return e end
      end
    end
  end
  return nil
end

local function Later(seconds, fn)
  if C_Timer and C_Timer.After then C_Timer.After(seconds, function() pcall(fn) end) else pcall(fn) end
end

-- Is this quest one to accept (or hand in) for you, as you have it set?
local function Wanted(id, mode)
  if mode == "All" then return true end
  if not id or not run.guide then return false end
  if mode == "Current" then return run.now[id] == true end
  if mode == "Guide" then return run.wide[id] == true end
  return false
end
-- The same for a quest known only by its name (an NPC's own list of quests).
local function WantedByName(name, mode)
  if mode == "All" then return true end
  if not name or not run.guide then return false end
  local set = mode == "Current" and run.now or mode == "Guide" and run.wide or nil
  if not set then return false end
  for id in pairs(set) do
    if Quest.Name(id) == name then return true end
  end
  return false
end
local function Held() return IsShiftKeyDown ~= nil and IsShiftKeyDown() end

local function OnGossip()
  if Held() or not (C_GossipInfo and C_GossipInfo.GetActiveQuests) then return end
  local o = Options()
  if o.turnin ~= "Off" then
    for _, q in ipairs(C_GossipInfo.GetActiveQuests() or {}) do
      local id = type(q) == "table" and plain(q.questID)
      if id and yes(q.isComplete) and Wanted(id, o.turnin) then
        Later(0.05, function() C_GossipInfo.SelectActiveQuest(id) end)
        return
      end
    end
  end
  if o.accept ~= "Off" and C_GossipInfo.GetAvailableQuests then
    for _, q in ipairs(C_GossipInfo.GetAvailableQuests() or {}) do
      local id = type(q) == "table" and plain(q.questID)
      if id and Wanted(id, o.accept) then
        Later(0.05, function() C_GossipInfo.SelectAvailableQuest(id) end)
        return
      end
    end
  end
  if o.flight and C_GossipInfo.GetOptions and (Open("F") or Open("P")) then
    for _, option in ipairs(C_GossipInfo.GetOptions() or {}) do
      if type(option) == "table" and plain(option.icon) == TAXI_ICON and option.gossipOptionID then
        local pick = option.gossipOptionID
        Later(0.05, function() C_GossipInfo.SelectOption(pick) end)
        return
      end
    end
  end
end

local function OnGreeting()
  if Held() or not (GetNumActiveQuests and GetActiveTitle) then return end
  local o = Options()
  if o.turnin ~= "Off" then
    for i = 1, plain(GetNumActiveQuests()) or 0 do
      local name, complete = GetActiveTitle(i)
      local id = GetActiveQuestID and plain(GetActiveQuestID(i))
      if complete ~= false and (id and Wanted(id, o.turnin) or not id and WantedByName(text(name), o.turnin)) then
        Later(0.05, function() SelectActiveQuest(i) end)
        return
      end
    end
  end
  if o.accept ~= "Off" and GetNumAvailableQuests and GetAvailableTitle then
    for i = 1, plain(GetNumAvailableQuests()) or 0 do
      local id = GetAvailableQuestInfo and plain((select(5, GetAvailableQuestInfo(i))))
      if id and Wanted(id, o.accept) or not id and WantedByName(text(GetAvailableTitle(i)), o.accept) then
        Later(0.05, function() SelectAvailableQuest(i) end)
        return
      end
    end
  end
end

local function OfferedQuest()
  return GetQuestID and plain(GetQuestID()) or nil
end

-- A flight point by the name a guide gives it ("Ironforge", "Menethil Harbor"): the one node of
-- the open flight map whose name begins with it, or else the one that has it somewhere in it.
local function TaxiNode(place)
  if not (NumTaxiNodes and TaxiNodeName) then return nil end
  local key = book.Key(place)
  if key == "" then return nil end
  local starts, has, startCount, hasCount = nil, nil, 0, 0
  for i = 1, plain(NumTaxiNodes()) or 0 do
    local name = text(TaxiNodeName(i))
    local at = name and string.find(book.Key(name), key, 1, true)
    if at == 1 then starts, startCount = i, startCount + 1 end
    if at then has, hasCount = i, hasCount + 1 end
  end
  if startCount == 1 then return starts end
  if startCount == 0 and hasCount == 1 then return has end
  return nil
end

local function OnTaxiMap()
  -- the flight point of where you stand is yours now
  Happened("P", function(e)
    if not e.place then return true end
    local node = TaxiNode(e.place)
    return node ~= nil and TaxiNodeGetType ~= nil and TaxiNodeGetType(node) == "CURRENT"
  end)
  local o = Options()
  if not o.flight or Held() or not TakeTaxiNode then return end
  local e = Open("F")
  local node = e and e.place and TaxiNode(e.place)
  if node and TaxiNodeGetType and TaxiNodeGetType(node) == "REACHABLE" then
    Later(0.4, function() TakeTaxiNode(node) end)
  end
end

local frame = CreateFrame("Frame", "AzerothAtlasGuideEvents", UIParent)
local handlers = {}

local function Dirty() run.dirty = true end
handlers.PLAYER_ENTERING_WORLD = Dirty
handlers.QUEST_LOG_UPDATE = Dirty
handlers.QUEST_ACCEPTED = Dirty
handlers.QUEST_REMOVED = Dirty
handlers.PLAYER_LEVEL_UP = function() Later(0.2, Dirty) end
handlers.PLAYER_XP_UPDATE = Dirty
handlers.UPDATE_FACTION = Dirty
handlers.SKILL_LINES_CHANGED = Dirty
handlers.LEARNED_SPELL_IN_SKILL_LINE = Dirty
handlers.SPELLS_CHANGED = Dirty
handlers.BAG_UPDATE_DELAYED = function() if run.hasItems then run.dirty = true end end
handlers.QUEST_TURNED_IN = function()
  -- (the game takes a moment to count a quest as done)
  run.dirty = true
  Later(0.5, Dirty)
  Later(1.5, Dirty)
end
handlers.MERCHANT_SHOW = function()
  Happened("V")
  if CanMerchantRepair and yes(CanMerchantRepair()) then Happened("R") end
end
handlers.TRAINER_SHOW = function() Happened("T") end
handlers.HEARTHSTONE_BOUND = function() Happened("S") end
handlers.UI_INFO_MESSAGE = function(_, message)
  message = text(message)
  if message and ERR_NEWTAXIPATH and message == ERR_NEWTAXIPATH then Happened("P") end
end
handlers.TAXIMAP_OPENED = OnTaxiMap
handlers.PLAYER_CONTROL_LOST = function()
  Later(1, function()
    if UnitOnTaxi and yes(UnitOnTaxi("player")) then Happened("F") end
  end)
end
handlers.UNIT_SPELLCAST_SUCCEEDED = function(unit, _, spell)
  if text(unit) ~= "player" then return end
  spell = plain(spell)
  if not spell then return end
  if spell == HEARTH_SPELL or spell == RECALL_SPELL then Happened("H") end
  Happened("SP", function(e) return e.spell == spell end)
end
handlers.GOSSIP_SHOW = OnGossip
handlers.QUEST_GREETING = OnGreeting
handlers.QUEST_DETAIL = function()
  local id = OfferedQuest()
  if not Held() and Wanted(id, Options().accept) and AcceptQuest then Later(0.05, AcceptQuest) end
end
handlers.QUEST_PROGRESS = function()
  local id = OfferedQuest()
  if not Held() and Wanted(id, Options().turnin) and IsQuestCompletable and yes(IsQuestCompletable()) and CompleteQuest then Later(0.05, CompleteQuest) end
end
handlers.QUEST_COMPLETE = function()
  local id = OfferedQuest()
  if Held() or not Wanted(id, Options().turnin) or not (GetNumQuestChoices and GetQuestReward) then return end
  -- (a reward to choose is yours to choose)
  local choices = plain(GetNumQuestChoices()) or 0
  if choices <= 1 then Later(0.05, function() GetQuestReward(choices) end) end
end
handlers.CINEMATIC_START = function()
  if Options().cutscenes and StopCinematic then StopCinematic() end
end

-- ---- starting, and the round ---------------------------------------------------------------------------------
local function Start()
  if book.Foreign() then
    -- (Guidelime is switched on: the guides are its to run. How you have it set, the guide it
    -- has open and what it has ticked are kept here too, for the day it is switched off.)
    run.state = "foreign"
    Options()
    pcall(book.Mirror)
    pcall(frame.RegisterEvent, frame, "PLAYER_LOGOUT")
    return
  end
  run.state = "on"
  Options()
  local store = book.Store()
  local name = store.currentGuide
  if type(name) == "string" and book.guides[name] then
    if not pcall(Load, name) then run.guide, run.steps = nil, {} end
  end
  -- (registered one at a time: a name this game does not have must not stop the rest)
  for event in pairs(handlers) do
    if event == "UNIT_SPELLCAST_SUCCEEDED" and frame.RegisterUnitEvent then
      pcall(frame.RegisterUnitEvent, frame, event, "player")
    else
      pcall(frame.RegisterEvent, frame, event)
    end
  end
  run.dirty = true
  run.rev = run.rev + 1
end

frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function(_, event, ...)
  if event == "PLAYER_LOGIN" then
    pcall(Start)
    return
  elseif event == "PLAYER_LOGOUT" then
    if run.state == "foreign" then pcall(book.Mirror) end
    return
  end
  local h = handlers[event]
  if h and run.state == "on" and run.guide then pcall(h, ...) end
end)

local since, shownRev = 0, -1
frame:SetScript("OnUpdate", function(_, dt)
  since = since + (dt or 0)
  if since < 0.2 then return end
  since = 0
  if run.state == "on" and run.guide then
    pcall(Walk)
    pcall(Settle)
  end
  -- the window (GuideWindow.lua), when what it shows has changed
  if shared.GuideShow and shownRev ~= run.rev then
    shownRev = run.rev
    shared.Try("guide window", shared.GuideShow)
  end
end)

-- (for the tests, and for a look from the game with /dump AzerothAtlas.GuideState())
function shared.GuideState()
  return { run = run, Evaluate = Evaluate, Settle = Settle, Walk = Walk, Load = Load, Happened = Happened, Wanted = Wanted, TaxiNode = TaxiNode, handlers = handlers, Start = Start }
end
