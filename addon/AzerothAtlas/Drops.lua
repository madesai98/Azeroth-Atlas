-- Azeroth Atlas: how often a creature drops what your quest wants.
--
-- With the mouse on a creature, the game's own tooltip lists the quests of yours it has
-- something for, and under each what is still wanted of it: "0/15 Bloodscalp Ear". Where the
-- Atlas database knows how often this creature drops that item, the figure is put after it:
-- "0/15 Bloodscalp Ear (22%)". Where it knows none, the line is left as the game wrote it.
--
-- The figures are not in this addon. The 3D map writes them, from the Atlas database as it
-- last fetched it, as a small addon of their own beside this one (AzerothAtlas_Drops: the map's
-- server/drops.js), which the game loads when it starts or on /reload: for each creature the
-- items, each with a rate in per cent, and what each item is called.
--
-- The game's tooltip names the item and gives no number for it. So the line is told by the
-- name: what is left of "0/15 Bloodscalp Ear" without its count has to be, to the letter, the
-- name of an item this creature has a figure for - as the 3D map's data has the name, or as
-- the game itself gives it for the item's number. A line about anything else (a kill to make,
-- a thing to use) is the name of no such item, and is left alone.
--
-- And what the game does not list is added. The game lists a quest under a creature only where
-- its own word on that creature names the item; the database knows of more (a Bloodscalp Hunter
-- drops the pages of The Green Hills of Stranglethorn, one time in a hundred each, and the game
-- says nothing of them under it). So when the tooltip has been written, your quest log is gone
-- through: whatever a quest of yours still wants that this creature has a figure for, and that
-- the game did not list, is written under it as the game would have - the quest's name, and
-- under it the line of your log with its figure: "- 0/1 Green Hills of Stranglethorn - Page 1
-- (0.92%)". Under the game's own lines of that quest where those end the tooltip, else under
-- the quest's name written once more. Only what is still wanted: a thing you have all of is
-- not added.
--
-- What is not done:
--   - nothing inside a dungeon or a raid, where the game keeps what is in a tooltip to itself,
--     and nothing with any value the game hands over as "secret": left alone, not worked around.
--     A tooltip of which any line is kept secret gets no lines of ours either: what the game
--     has listed there cannot be told, and nothing is to stand twice;
--   - no tooltip but the game's own, and none but a creature's;
--   - nothing for a creature the database has no figure for, whatever else drops from it.
--
-- /atlas drops         whether it is on, and how many creatures there are figures for
-- /atlas drops off     the tooltip as the game writes it (and on, on)
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local find, match, lower, format, gsub, gmatch = string.find, string.match, string.lower, string.format, string.gsub, string.gmatch

-- (the figure's colour: a grey of its own, which also says "this line has its figure already")
local MARK = "|cff9a9b9c"

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
-- (a table of the game's that may be read: not one it keeps to itself)
local function open(t)
  if t == nil or secret(t) or type(t) ~= "table" then return false end
  return not (issecrettable ~= nil and issecrettable(t))
end
-- (a text as it is - or nothing, where it is none or the game keeps it secret)
local function words(v)
  if v == nil or secret(v) or type(v) ~= "string" then return nil end
  return v
end

function shared.DropsOn() return type(AzerothAtlasDB) ~= "table" or AzerothAtlasDB.drops ~= false end
function shared.SetDrops(on)
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  if on then AzerothAtlasDB.drops = nil else AzerothAtlasDB.drops = false end
end

-- The figures, as the 3D map wrote them - or nothing (none written yet, or written for another version of this).
local function Figures()
  local d = rawget(_G, "AzerothAtlasDrops")
  if type(d) ~= "table" or d.v ~= 1 or type(d.of) ~= "table" then return nil end
  return d
end

-- How a rate is written: whole above ten in a hundred, finer the rarer it is.
local function Percent(p)
  if p >= 99.5 then return "100%" end
  if p >= 10 then return format("%.0f%%", p) end
  if p >= 1 then return (gsub(format("%.1f", p), "%.0$", "")) .. "%" end
  if p >= 0.01 then return (gsub(format("%.2f", p), "0$", "")) .. "%" end
  return "<0.01%"
end

-- What a creature drops, by the figures: { item, per cent, item, per cent, ... } - the last creature asked about is kept.
local last = { id = nil, list = nil, of = nil }
local function DropsOf(d, id)
  if last.id == id and last.of == d then return last.list end
  local list = nil
  local row = d.of[id]
  if type(row) == "string" then
    list = {}
    for item, pct in gmatch(row, "(%d+)=([%d%.]+)") do
      item, pct = tonumber(item), tonumber(pct)
      if item and pct and pct > 0 then list[#list + 1] = item; list[#list + 1] = pct end
    end
    if #list == 0 then list = nil end
  end
  last.id, last.list, last.of = id, list, d
  return list
end

-- What the game calls an item, by its number (nothing where it has not heard of it yet). An
-- answer is kept; an item the game had no name for is asked after again two seconds on, not
-- with every line of a tooltip the game writes anew several times a second.
local gameNames, askedAt = {}, {}
local function GameName(item)
  local known = gameNames[item]
  if known then return known end
  local now = type(GetTime) == "function" and GetTime() or 0
  if askedAt[item] and now - askedAt[item] < 2 and now >= askedAt[item] then return nil end
  askedAt[item] = now
  local name = nil
  if C_Item and type(C_Item.GetItemNameByID) == "function" then
    local ok, v = pcall(C_Item.GetItemNameByID, item)
    if ok then name = words(v) end
  end
  if not name and type(GetItemInfo) == "function" then
    local ok, v = pcall(GetItemInfo, item)
    if ok then name = words(v) end
  end
  if name then gameNames[item] = name end
  return name
end

-- What a line is about: "0/15 Bloodscalp Ear" and "Bloodscalp Ear: 0/15" are both about
-- "Bloodscalp Ear" - with or without a dash, a tick or a colour of the game's before it.
local function Subject(text)
  text = gsub(gsub(text, "|c%x%x%x%x%x%x%x%x", ""), "|r", "")
  local after = match(text, "%d+%s*/%s*%d+%s+(.-)%s*$")
  if after and after ~= "" then return after end
  text = gsub(gsub(text, "|[TA].-|[ta]", ""), "^[%s%-]+", "")
  return match(text, "^(.-)%s*:%s*%d+%s*/%s*%d+%s*$") or match(text, "^(.-)%s*$")
end

-- How often this creature drops the thing a line is about - or nothing. (Two items of one name,
-- as a quest of each side may have its own: the likelier.)
local function RateFor(d, list, subject)
  local plain = lower(subject)
  local best = nil
  local names = type(d.names) == "table" and d.names or nil
  for i = 1, #list, 2 do
    local item, pct = list[i], list[i + 1]
    local name = names and names[item]
    local is = type(name) == "string" and (name == subject or lower(name) == plain)
    if not is then
      -- (the game's own name for it, where the map's data has none or another: a game in another language than the map's data)
      local said = GameName(item)
      is = said ~= nil and (said == subject or lower(said) == plain)
    end
    if is and (not best or pct > best) then best = pct end
  end
  return best
end

-- The creature the game names by this: its number - or nothing (a player, a pet, something the game will not say).
local function CreatureBy(guid)
  if guid == nil or secret(guid) or type(guid) ~= "string" then return nil end
  local kind, _, _, _, _, id = strsplit("-", guid)
  if kind ~= "Creature" and kind ~= "Vehicle" then return nil end
  id = tonumber(id)
  if not id or id <= 0 then return nil end
  return id
end

-- The creature a tooltip is being filled for, while the game fills it - or nothing.
local function CreatureOf(tooltip, unitType)
  local info = tooltip.processingInfo
  local data = open(info) and info.tooltipData or nil
  if open(data) then
    local kind = data.type
    if secret(kind) or kind ~= unitType then return nil end
    return CreatureBy(data.guid)
  elseif type(tooltip.GetUnit) == "function" then
    -- (a game whose tooltip does not say what it is being filled from: the unit it is of)
    local ok, _, unit = pcall(tooltip.GetUnit, tooltip)
    if not ok or secret(unit) or type(unit) ~= "string" or type(UnitGUID) ~= "function" then return nil end
    local got, v = pcall(UnitGUID, unit)
    if not got then return nil end
    return CreatureBy(v)
  end
  return nil
end

-- Whether a tooltip is one to write into just now: the game's own, not one it forbids, and not
-- inside a dungeon or a raid (where the game keeps what is in a tooltip to itself).
local function Ours(tooltip)
  if tooltip ~= GameTooltip or not shared.DropsOn() then return false end
  if type(tooltip.IsForbidden) == "function" and tooltip:IsForbidden() then return false end
  if type(IsInInstance) == "function" then
    local ok, inside = pcall(IsInInstance)
    if not ok or secret(inside) or inside then return false end
  end
  return true
end

-- A line of the tooltip, by its number - or nothing.
local function LineAt(tooltip, name, index)
  local line = (type(tooltip.GetLeftLine) == "function" and tooltip:GetLeftLine(index)) or (name and _G[name .. "TextLeft" .. index]) or nil
  if line and type(line.GetText) == "function" and type(line.SetText) == "function" then return line end
  return nil
end
-- How many lines a tooltip has, and the name its lines go by - or nothing.
local function Lines(tooltip)
  local name = type(tooltip.GetName) == "function" and tooltip:GetName() or nil
  local count = type(tooltip.NumLines) == "function" and tooltip:NumLines() or nil
  if secret(count) or type(count) ~= "number" then return nil end
  if secret(name) or type(name) ~= "string" then name = nil end
  return count, name
end

-- The line of the tooltip the game has just written this text into, and what stands in it. The
-- game tells of a line straight after writing it, so it is the last line - unless somebody else
-- has added one of their own since: looked for from the bottom up, it is the first that reads
-- as the game's data says and has no figure yet. (Not gone by the number the game gives a line:
-- that counts the game's lines, not what others have put between them.) A line the game keeps
-- secret is not read.
local function Written(tooltip, text)
  local count, name = Lines(tooltip)
  if not count then return nil end
  for index = count, 1, -1 do
    local line = LineAt(tooltip, name, index)
    local shown = line and words(line:GetText())
    if shown and find(shown, text, 1, true) and not find(shown, MARK, 1, true) then return line, shown end
  end
  return nil
end

local count = { shown = 0, added = 0 }

-- A line of a quest's wants has been written into a tooltip.
local function Line(tooltip, lineData, unitType)
  if not Ours(tooltip) then return end
  if not open(lineData) then return end
  local text = words(lineData.leftText)
  if not text or text == "" then return end
  local d = Figures()
  if not d then return end
  local id = CreatureOf(tooltip, unitType)
  local list = id and DropsOf(d, id)
  if not list then return end
  local subject = Subject(text)
  if not subject or subject == "" then return end
  local pct = RateFor(d, list, subject)
  if not pct then return end
  -- (a line that has its figure already is not given it twice: such a one is not found)
  local line, shown = Written(tooltip, text)
  if not line then return end
  line:SetText(shown .. " " .. MARK .. "(" .. Percent(pct) .. ")|r")
  count.shown = count.shown + 1
end

-- ---- what the game does not list ---------------------------------------------------------------
-- What your quests still want, a line of your log each: { quest, title, text (as your log has
-- it: "0/1 Bloodscalp Tusk"), subject (what it is about, in small letters) }. Read again when
-- the game says the log has changed, and every few seconds besides - not with every tooltip.
local wants = { list = {}, dirty = true, at = -100 }
local function Wanted()
  local now = type(GetTime) == "function" and GetTime() or 0
  if not wants.dirty and now >= wants.at and now - wants.at < 5 then return wants.list end
  local list = {}
  local Q = C_QuestLog
  if type(Q) == "table" and type(Q.GetNumQuestLogEntries) == "function" and type(Q.GetInfo) == "function" and type(Q.GetQuestObjectives) == "function" then
    local ok, n = pcall(Q.GetNumQuestLogEntries)
    if not ok or secret(n) or type(n) ~= "number" then n = 0 end
    for i = 1, math.min(n, 200) do
      local got, info = pcall(Q.GetInfo, i)
      if got and open(info) then
        local header, hidden, id, title = info.isHeader, info.isHidden, info.questID, words(info.title)
        local said = not secret(header) and not secret(hidden) and not secret(id)
        if said and not header and not hidden and type(id) == "number" and id > 0 and title and title ~= "" then
          local had, goals = pcall(Q.GetQuestObjectives, id)
          if had and open(goals) then
            for _, goal in ipairs(goals) do
              if open(goal) then
                local text, finished = words(goal.text), goal.finished
                -- (only what is still wanted; one the game will not say is done or not is left out)
                if text and text ~= "" and not secret(finished) and finished ~= true then
                  local subject = Subject(text)
                  if subject and subject ~= "" then list[#list + 1] = { quest = id, title = title, text = text, subject = lower(subject) } end
                end
              end
            end
          end
        end
      end
    end
  end
  wants.list, wants.dirty, wants.at = list, false, now
  return list
end

-- (the tooltip lines were last added to: told of the same writing of a tooltip twice, they are added once)
local done = { data = nil, lines = nil }

-- A creature's tooltip has been written, every line of it: what your quests still want of the
-- creature that the game did not list is written under it (see the top of this file).
local function Unit(tooltip, data, types, unitType)
  if not Ours(tooltip) or not open(data) then return end
  local kind = data.type
  if secret(kind) or kind ~= unitType then return end
  if rawequal(done.data, data) and done.lines == (Lines(tooltip)) then return end
  local d = Figures()
  if not d then return end
  local id = CreatureBy(data.guid)
  local list = id and DropsOf(d, id)
  if not list then return end
  local wanted = Wanted()
  if #wanted == 0 then return end
  -- What the game has listed already, by what each of its lines is about - and the quest whose
  -- own lines (yours, not a companion's, which follow their name) are the last thing it wrote.
  -- With anything of it kept secret that cannot be told, and nothing is added.
  local listed, quest, mine, lastQuest, lastText = {}, nil, true, nil, nil
  local lines = data.lines
  if lines ~= nil then
    if not open(lines) then return end
    for _, l in ipairs(lines) do
      if not open(l) then return end
      local t, text = l.type, l.leftText
      if secret(t) or secret(text) then return end
      if t == types.QuestTitle then
        local q = l.id
        if secret(q) then return end
        quest, mine = (type(q) == "number" and q or nil), true
        lastQuest, lastText = quest, (type(text) == "string" and text or nil)
      elseif types.QuestPlayer ~= nil and t == types.QuestPlayer then
        mine, lastQuest, lastText = false, nil, nil
      elseif t == types.QuestObjective then
        if type(text) == "string" and mine then
          local s = Subject(text)
          if s and s ~= "" then listed[lower(s)] = true end
          lastQuest, lastText = quest, text
        else
          lastQuest, lastText = nil, nil
        end
      else
        quest, mine, lastQuest, lastText = nil, true, nil, nil
      end
    end
  end
  -- (the game's own lines of a quest still end the tooltip: a line of ours for that quest goes straight under them)
  local block = nil
  if lastQuest and lastText then
    local n, name = Lines(tooltip)
    local line = n and n >= 1 and LineAt(tooltip, name, n) or nil
    local shown = line and words(line:GetText())
    if shown and find(shown, lastText, 1, true) then block = lastQuest end
  end
  local dash = words(rawget(_G, "QUEST_DASH")) or "- "
  local added = 0
  local function consider(w)
    if listed[w.subject] then return end
    local pct = RateFor(d, list, w.subject)
    if not pct then return end
    -- (the quest's name, as the game writes one: in its yellow)
    if w.quest ~= block then tooltip:AddLine(w.title, 1, 0.82, 0); block = w.quest end
    tooltip:AddLine(dash .. w.text .. " " .. MARK .. "(" .. Percent(pct) .. ")|r", 1, 1, 1, true)
    listed[w.subject] = true
    added = added + 1
  end
  -- (first what belongs under the lines the game ended on, then the rest, quest by quest as your log has them)
  local first = block
  if first then for _, w in ipairs(wanted) do if w.quest == first then consider(w) end end end
  for _, w in ipairs(wanted) do if w.quest ~= first then consider(w) end end
  if added > 0 then
    count.added = count.added + added
    done.data, done.lines = data, (Lines(tooltip))
  end
end

local hooked, adding = false, false
do
  local types = Enum and Enum.TooltipDataLineType
  local kinds = Enum and Enum.TooltipDataType
  if type(TooltipDataProcessor) == "table" and type(TooltipDataProcessor.AddLinePostCall) == "function"
    and type(types) == "table" and types.QuestObjective ~= nil and type(kinds) == "table" and kinds.Unit ~= nil then
    local unitType = kinds.Unit
    local ok = pcall(TooltipDataProcessor.AddLinePostCall, types.QuestObjective, function(tooltip, lineData)
      shared.Try("drop rates", Line, tooltip, lineData, unitType)
    end)
    hooked = ok
    if ok and type(TooltipDataProcessor.AddTooltipPostCall) == "function" and types.QuestTitle ~= nil then
      adding = pcall(TooltipDataProcessor.AddTooltipPostCall, unitType, function(tooltip, data)
        shared.Try("drop rates, lines of its own", Unit, tooltip, data, types, unitType)
      end)
    end
  end
end

-- (your quest log has changed: what it still wants is read again with the next tooltip. The
-- frame's name is not the figures' - AzerothAtlasDrops: the game makes a frame's name a word of
-- its own, and it would stand where the figures stood.)
do
  local frame = CreateFrame("Frame", "AzerothAtlasDropsWatch")
  frame:SetScript("OnEvent", function() wants.dirty = true end)
  -- (registered one at a time: a name this game does not have must not stop the rest)
  for _, event in ipairs({ "QUEST_LOG_UPDATE", "QUEST_ACCEPTED", "QUEST_REMOVED", "QUEST_TURNED_IN", "UNIT_QUEST_LOG_CHANGED", "PLAYER_ENTERING_WORLD" }) do pcall(frame.RegisterEvent, frame, event) end
end

do
  local d = Figures()
  if not hooked then shared.Log("drops: this game has no way for an addon to add to a line of its tooltip: no drop rates are shown")
  elseif d then shared.Log("drops: rates for " .. tostring(d.creatures) .. " creatures (" .. tostring(d.rates) .. " in all), as the 3D map wrote them from the Atlas database" .. (adding and "" or "; this game has no way for an addon to add lines to a creature's tooltip, so only the game's own lines get a rate"))
  else shared.Log("drops: no rates to show - the 3D map has not written them yet (AzerothAtlas_Drops), or the game has not been started since it did") end
end

-- /atlas drops: off and on, and what there is
function shared.DropsSay(word)
  local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end
  if word == "off" or word == "on" then shared.SetDrops(word == "on") end
  if not hooked then say("this game has no way for an addon to add to a line of its tooltip: drop rates cannot be shown.") return end
  if not shared.DropsOn() then say("drop rates are not shown in a creature's tooltip (/atlas drops on shows them).") return end
  local d = Figures()
  if not d then
    say("drop rates are shown in a creature's tooltip, after what your quest wants of it - but there are none to show yet. The 3D map writes them, from the Atlas database, beside this addon (AzerothAtlas_Drops): run Azeroth Atlas once, then start the game again. /atlas drops off turns it off.")
    return
  end
  say("where a creature's tooltip says what your quest wants of it, how often it drops that is put after it: figures for " .. tostring(d.creatures) .. " creatures, from the Atlas database as the 3D map last wrote it (" .. count.shown .. " shown since you logged in). Where none is known, the line is as the game wrote it. "
    .. (adding and ("What a quest of yours still wants of a creature and the game does not list is added under it, with its figure (" .. count.added .. " lines added). ") or "")
    .. "/atlas drops off turns it off.")
end
