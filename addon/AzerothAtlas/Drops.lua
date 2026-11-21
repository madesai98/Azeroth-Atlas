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
-- What is not done:
--   - nothing is added that the game does not show: a creature the game lists no quest of yours
--     under gets no line from this;
--   - nothing inside a dungeon or a raid, where the game keeps what is in a tooltip to itself,
--     and nothing with any value the game hands over as "secret": left alone, not worked around;
--   - no tooltip but the game's own.
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

-- The creature a tooltip is of: the game's number for it - or nothing (a player, a pet, something the game will not say).
local function CreatureOf(tooltip, unitType)
  local guid = nil
  local info = tooltip.processingInfo
  local data = open(info) and info.tooltipData or nil
  if open(data) then
    local kind = data.type
    if secret(kind) or kind ~= unitType then return nil end
    guid = data.guid
    if secret(guid) then return nil end
  elseif type(tooltip.GetUnit) == "function" then
    -- (a game whose tooltip does not say what it is being filled from: the unit it is of)
    local ok, _, unit = pcall(tooltip.GetUnit, tooltip)
    if not ok or secret(unit) or type(unit) ~= "string" or type(UnitGUID) ~= "function" then return nil end
    local got, v = pcall(UnitGUID, unit)
    if not got or secret(v) then return nil end
    guid = v
  end
  if type(guid) ~= "string" then return nil end
  local kind, _, _, _, _, id = strsplit("-", guid)
  if kind ~= "Creature" and kind ~= "Vehicle" then return nil end
  id = tonumber(id)
  if not id or id <= 0 then return nil end
  return id
end

-- The line of the tooltip the game has just written this text into, and what stands in it. The
-- game tells of a line straight after writing it, so it is the last line - unless somebody else
-- has added one of their own since: looked for from the bottom up, it is the first that reads
-- as the game's data says and has no figure yet. (Not gone by the number the game gives a line:
-- that counts the game's lines, not what others have put between them.) A line the game keeps
-- secret is not read.
local function Written(tooltip, text)
  local name = type(tooltip.GetName) == "function" and tooltip:GetName() or nil
  local count = type(tooltip.NumLines) == "function" and tooltip:NumLines() or nil
  if secret(count) or type(count) ~= "number" then return nil end
  if secret(name) or type(name) ~= "string" then name = nil end
  for index = count, 1, -1 do
    local line = (type(tooltip.GetLeftLine) == "function" and tooltip:GetLeftLine(index)) or (name and _G[name .. "TextLeft" .. index]) or nil
    if line and type(line.GetText) == "function" and type(line.SetText) == "function" then
      local shown = words(line:GetText())
      if shown and find(shown, text, 1, true) and not find(shown, MARK, 1, true) then return line, shown end
    end
  end
  return nil
end

local count = { shown = 0 }

-- A line of a quest's wants has been written into a tooltip.
local function Line(tooltip, lineData, unitType)
  if tooltip ~= GameTooltip or not shared.DropsOn() then return end
  if type(tooltip.IsForbidden) == "function" and tooltip:IsForbidden() then return end
  -- (inside a dungeon or a raid the game keeps what is in a tooltip to itself)
  if type(IsInInstance) == "function" then
    local ok, inside = pcall(IsInInstance)
    if not ok or secret(inside) or inside then return end
  end
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

local hooked = false
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
  end
end

do
  local d = Figures()
  if not hooked then shared.Log("drops: this game has no way for an addon to add to a line of its tooltip: no drop rates are shown")
  elseif d then shared.Log("drops: rates for " .. tostring(d.creatures) .. " creatures (" .. tostring(d.rates) .. " in all), as the 3D map wrote them from the Atlas database")
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
  say("where a creature's tooltip says what your quest wants of it, how often it drops that is put after it: figures for " .. tostring(d.creatures) .. " creatures, from the Atlas database as the 3D map last wrote it (" .. count.shown .. " shown since you logged in). Where none is known, the line is as the game wrote it. /atlas drops off turns it off.")
end
