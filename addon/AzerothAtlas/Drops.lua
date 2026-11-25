-- Azeroth Atlas: what a creature gives, and how often - counted as you loot, and shown in its tooltip.
--
-- With the mouse on a creature, the game's own tooltip lists the quests of yours it has
-- something for, and under each what is still wanted of it: "0/15 Bloodscalp Ear". How often
-- this creature gives that thing is put after it: "0/15 Bloodscalp Ear (22%)". Where nothing is
-- known of it, the line is left as the game wrote it.
--
-- And what the game does not list is added. The game lists a quest under a creature only where
-- its own word on that creature names the item; more is known (a Bloodscalp Hunter drops the
-- pages of The Green Hills of Stranglethorn, one time in a hundred each, and the game says
-- nothing of them under it). So when the tooltip has been written, your quest log is gone
-- through: whatever a quest of yours still wants that this creature gives, and that the game
-- did not list, is written under it as the game would have - the quest's name, and under it
-- the line of your log with its figure: "- 0/1 Green Hills of Stranglethorn - Page 1 (0.92%)".
-- Under the game's own lines of that quest where those end the tooltip, else under the quest's
-- name written once more. Only what is still wanted: a thing you have all of is not added.
--
-- Under all that, everything else the creature can give you just now, the likeliest first:
--
--     Drops
--     Silk Cloth               29%
--     Wild Hog Shank          4.7%
--     ...
--
-- A thing one of your quests still wants stands under that quest, whatever kind of thing it
-- is, and not in this list. A thing of the game's "quest" kind that no quest of yours wants is
-- not shown at all: it would not be in the corpse. The list is short (LIST_SHORT); with Shift
-- held down it is all there is, each thing with what its figure rests on.
--
-- Where the figures come from:
--
--   the 3D map        writes what the Atlas database has as a small addon of their own beside
--                     this one (AzerothAtlas_Drops: the map's server/drops.js), which the game
--                     loads when it starts or on /reload: of each creature what it gives - the
--                     original game's rate for it, and in how many of the corpses that the
--                     players of the map looted it was.
--   your own looting  every corpse you loot is counted here, once, with everything in it
--                     (AzerothAtlasDB.loot), and the tooltip goes by it from that moment: no
--                     reload, no map. It is also said to the 3D map through the strip at once
--                     (shared.LootReport), which sends it on to the Atlas database for everybody
--                     else's figures.
--
-- How a figure is made of them. A rate out of a handful of corpses is a poor rate: one corpse
-- with the thing in it is not "every time". So a count is leaned on something to start from,
-- and outweighs it as it grows (a Bayesian average):
--
--     rate = (found in + weight x first guess) / (corpses + weight)
--
--   with a figure of the original game for the thing: that is the first guess, and it weighs
--     as much as ten corpses - or as many as it takes to find the thing twice at that rate,
--     where that is more (a thing found once in a hundred is not struck off by fifty corpses
--     without it), four hundred at the most;
--   with none: one corpse in ten for a thing that drops for anybody, three in ten for one that
--     drops only with its quest, each weighing as much as five corpses.
--
-- What is counted, and how:
--   - a corpse counts once, the first time its loot is seen, with everything that was in it;
--   - only what you loot alone: in a group the game shows each player a part of what there is;
--   - not what a spell of yours brought out (skinning, picking a pocket, mining a corpse): that
--     is another list than the corpse's own;
--   - a thing that drops for anybody: in how many of the creature's corpses it was;
--   - a thing of the "quest" kind is only in a corpse while a quest of yours wants it. So it is
--     counted on its own: the corpses looted while your log asked for it (by its name), and
--     those of them it was in. Before it has ever been found on a creature those corpses are
--     counted under the name alone, and made over to the thing when it first turns up: so the
--     first find is not "one of one".
--
-- What is not done:
--   - nothing is written inside a dungeon or a raid, where the game keeps what is in a tooltip
--     to itself, and nothing with any value the game hands over as "secret": left alone, not
--     worked around. A tooltip of which any line is kept secret gets no lines of ours either:
--     what the game has listed there cannot be told, and nothing is to stand twice;
--   - no tooltip but the game's own, and none but a creature's;
--   - nothing for a creature of which nothing is known.
--
-- /atlas drops         whether it is on, and how much there is
-- /atlas drops off     the tooltip as the game writes it (and on, on)
-- /atlas drops list    the list of everything else a creature gives: off, and on again
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local find, match, lower, format, gsub, gmatch = string.find, string.match, string.lower, string.format, string.gsub, string.gmatch
local floor, strchar = math.floor, string.char

-- (the figure's colour: a grey of its own, which also says "this line has its figure already")
local MARK = "|cff9a9b9c"
local LIST_SHORT, LIST_LONG = 6, 30   -- things in the list of what else a creature gives: as a rule, and with Shift held down
local QUEST_CLASS = 12                -- the game's kind of item that is of a quest
-- (how a count is leaned on a first guess: see the top of this file)
local WEIGHT_LEAST, WEIGHT_MOST, FINDS = 10, 400, 2
local GUESS, GUESS_QUEST, GUESS_WEIGHT = 0.10, 0.30, 5

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
local function Now() return type(GetTime) == "function" and GetTime() or 0 end

local function DB()
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  return AzerothAtlasDB
end
function shared.DropsOn() return type(AzerothAtlasDB) ~= "table" or AzerothAtlasDB.drops ~= false end
function shared.SetDrops(on)
  if on then DB().drops = nil else DB().drops = false end
end
function shared.DropsListOn() return type(AzerothAtlasDB) ~= "table" or AzerothAtlasDB.dropsList ~= false end
function shared.SetDropsList(on)
  if on then DB().dropsList = nil else DB().dropsList = false end
end

-- The figures, as the 3D map wrote them - or nothing (none written yet, or written for another version of this).
local function Figures()
  local d = rawget(_G, "AzerothAtlasDrops")
  if type(d) ~= "table" or d.v ~= 1 or type(d.of) ~= "table" then return nil end
  return d
end
-- (...and whether they are laid out with the counts: a 3D map from before it handed any on has `of` alone)
local function Counted(d) return d ~= nil and d.f == 2 and type(d.all) == "table" end

-- How a rate is written: whole above ten in a hundred, finer the rarer it is.
local function Percent(p)
  if p >= 99.5 then return "100%" end
  if p >= 10 then return format("%.0f%%", p) end
  if p >= 1 then return (gsub(format("%.1f", p), "%.0$", "")) .. "%" end
  if p >= 0.01 then return (gsub(format("%.2f", p), "0$", "")) .. "%" end
  return "<0.01%"
end

-- What the game calls an item, by its number (nothing where it has not heard of it yet). An
-- answer is kept; an item the game had no name for is asked after again two seconds on, not
-- with every line of a tooltip the game writes anew several times a second.
local gameNames, askedAt = {}, {}
local function GameName(item)
  local known = gameNames[item]
  if known then return known end
  local now = Now()
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

-- Whether the game counts an item among those of a quest (its kind), as far as it says: true,
-- false - or nothing, where it does not say. Kept: an item's kind does not change.
local gameKinds = {}
local function GameQuest(item)
  local known = gameKinds[item]
  if known ~= nil then return known end
  local instant = (C_Item and C_Item.GetItemInfoInstant) or rawget(_G, "GetItemInfoInstant")
  if type(instant) ~= "function" then return nil end
  local ok, _, _, _, _, _, class = pcall(instant, item)
  if not ok or secret(class) or type(class) ~= "number" then return nil end
  gameKinds[item] = class == QUEST_CLASS
  return gameKinds[item]
end

-- ---- your own count -----------------------------------------------------------------------------
-- AzerothAtlasDB.loot = { v = 1, id = a number made up once for these saved settings (by which the
--   3D map tells one game's count from another's on the same computer; it says nothing of you),
--   of = { [creature] = { n = corpses looted, got = { [item] = in how many it was },
--                         tried = { [item] = corpses looted while a quest wanted it } (a thing that drops only with its quest),
--                         on = { [a name, in small letters] = the same, of a thing never yet found on this creature } } } }
local TAG_MOST = 65535
local PENDING_MOST = 8   -- names kept waiting for their thing, of one creature
-- (goes up whenever the count changes: what was worked out for a tooltip is worked out again)
local stamp = 0
local function Loot()
  local d = DB()
  local l = d.loot
  if type(l) ~= "table" or type(l.of) ~= "table" then l = { v = 1, of = {} } ; d.loot = l end
  local id = tonumber(l.id)
  if not id or id < 1 or id > TAG_MOST or id ~= floor(id) then
    l.id = (type(math.random) == "function" and math.random(1, TAG_MOST)) or ((floor(Now() * 1000) + (type(time) == "function" and time() or 0)) % TAG_MOST + 1)
  end
  return l
end
-- One creature's count - or nothing, where there is none and none is to be begun.
local function Own(creature, begin)
  local d = type(AzerothAtlasDB) == "table" and AzerothAtlasDB.loot
  if not begin and (type(d) ~= "table" or type(d.of) ~= "table") then return nil end
  local l = begin and Loot() or d
  local rec = l.of[creature]
  if type(rec) ~= "table" then
    if not begin then return nil end
    rec = { n = 0, got = {} }
    l.of[creature] = rec
  end
  if type(rec.got) ~= "table" then rec.got = {} end
  rec.n = tonumber(rec.n) or 0
  return rec
end

-- ---- what is known of a creature -----------------------------------------------------------------
-- A row of the 3D map's ("<corpses> <item>=<per cent>/<k>/<t> ..."), read into `into`:
-- into[item] = { pct, k, t } (t nothing: of the corpses). @returns the corpses
local function ReadRow(row, into)
  if type(row) ~= "string" then return 0 end
  for item, pct, k, t in gmatch(row, "(%d+)=([%d%.]*)/?(%d*)/?(%d*)") do
    item = tonumber(item)
    if item then into[item] = { pct = tonumber(pct), k = tonumber(k) or 0, t = tonumber(t) } end
  end
  return tonumber(match(row, "^(%d+)%s")) or tonumber(match(row, "^(%d+)$")) or 0
end

-- Everything known of what a creature gives: { n = corpses looted (everybody's and yours),
-- list = { { item, pct (the original game's rate, or nothing), k (found in so many), t (of so
-- many: nothing where it is of the n corpses), quest (it drops only with its quest) }, ... } } -
-- or nothing. The last creature asked about is kept, until the count or the figures change.
local last = { id = nil, of = nil, stamp = nil, row = nil }
local function Known(d, id)
  if last.id == id and last.of == d and last.stamp == stamp then return last.row end
  local by, n = {}, 0
  local kinds = d and type(d.kinds) == "table" and d.kinds or nil
  if Counted(d) then
    n = ReadRow(d.all[id], by)
  elseif d then
    -- (a 3D map from before it handed counts on: the things quests want, with the original game's rates)
    local row = d.of[id]
    if type(row) == "string" then
      for item, pct in gmatch(row, "(%d+)=([%d%.]+)") do
        item, pct = tonumber(item), tonumber(pct)
        if item and pct and pct > 0 then by[item] = { pct = pct, k = 0 } end
      end
    end
  end
  for item, e in pairs(by) do
    if e.pct and not (e.pct > 0) then e.pct = nil end
    e.quest = e.t ~= nil or (kinds ~= nil and (tonumber(kinds[item]) or 0) >= 10)
  end
  -- your own count: what of it the 3D map's row has in it already is not counted twice
  local own = Own(id)
  if own then
    local had, hadN = {}, 0
    local l = AzerothAtlasDB.loot
    local mine = Counted(d) and type(d.mine) == "table" and d.mine[l.id]
    if type(mine) == "table" then hadN = ReadRow(mine[id], had) end
    n = n + math.max(0, own.n - hadN)
    local tried = type(own.tried) == "table" and own.tried or nil
    local function add(item)
      if type(item) ~= "number" then return end
      local e = by[item]
      local t = tried and tonumber(tried[item]) or nil
      if not e then e = { k = 0, quest = t ~= nil } ; by[item] = e end
      local was = had[item]
      local k = math.max(0, (tonumber(own.got[item]) or 0) - (was and was.k or 0))
      if t then
        -- (counted here as a thing of a quest: by its own corpses, whatever the row said of it)
        if not e.quest or e.t == nil then e.quest, e.t, e.k = true, 0, 0 end
        e.t = e.t + math.max(0, t - (was and was.t or 0))
        e.k = e.k + k
      elseif not e.quest then
        e.k = e.k + k
      end
    end
    for item in pairs(own.got) do add(item) end
    if tried then for item in pairs(tried) do if own.got[item] == nil then add(item) end end end
  end
  local list = {}
  for item, e in pairs(by) do
    e.item = item
    -- (a thing of a quest by the game's own word, of which the row had only the original game's figure)
    if not e.quest and e.t == nil and e.k == 0 and GameQuest(item) then e.quest = true end
    if e.quest and e.t == nil then e.t = 0 end
    list[#list + 1] = e
  end
  local row = nil
  if #list > 0 or n > 0 then
    table.sort(list, function(a, b) return a.item < b.item end)
    row = { n = n, list = list }
  end
  last.id, last.of, last.stamp, last.row = id, d, stamp, row
  return row
end

-- How often a creature gives a thing, in per cent, by what is known of it - or nothing.
-- @returns the rate, in how many corpses it was found, of how many
local function Rate(e, n)
  local t = e.quest and (e.t or 0) or n
  local k = e.k or 0
  if k > t then k = t end
  if e.pct then
    -- (nothing counted: the original game's figure as it is)
    if t <= 0 then return e.pct, 0, 0 end
    local guess = e.pct / 100
    local weight = FINDS / guess
    if weight < WEIGHT_LEAST then weight = WEIGHT_LEAST elseif weight > WEIGHT_MOST then weight = WEIGHT_MOST end
    return (k + weight * guess) / (t + weight) * 100, k, t
  end
  if t <= 0 then return nil end
  return (k + GUESS_WEIGHT * (e.quest and GUESS_QUEST or GUESS)) / (t + GUESS_WEIGHT) * 100, k, t
end
shared.DropRate = Rate -- (for whoever wants to check the reckoning)

-- What an item is called: as the 3D map's data has it, or as the game itself says.
local function NameOf(d, item)
  local names = d and type(d.names) == "table" and d.names or nil
  local name = names and names[item]
  if type(name) == "string" then return name end
  return GameName(item)
end
-- (is this what a line calls its thing?)
local function Is(d, item, subject, plain)
  local names = d and type(d.names) == "table" and d.names or nil
  local name = names and names[item]
  if type(name) == "string" and (name == subject or lower(name) == plain) then return true end
  -- (the game's own name for it, where the map's data has none or another: a game in another language than the map's data)
  local said = GameName(item)
  return said ~= nil and (said == subject or lower(said) == plain)
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
local function RateFor(d, row, subject)
  local plain = lower(subject)
  local best = nil
  for i = 1, #row.list do
    local e = row.list[i]
    if Is(d, e.item, subject, plain) then
      local pct = Rate(e, row.n)
      if pct and pct > 0 and (not best or pct > best) then best = pct end
    end
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

local count = { shown = 0, added = 0, listed = 0 }

-- A line of a quest's wants has been written into a tooltip.
local function Line(tooltip, lineData, unitType)
  if not Ours(tooltip) then return end
  if not open(lineData) then return end
  local text = words(lineData.leftText)
  if not text or text == "" then return end
  local d = Figures()
  local id = CreatureOf(tooltip, unitType)
  local row = id and Known(d, id)
  if not row then return end
  local subject = Subject(text)
  if not subject or subject == "" then return end
  local pct = RateFor(d, row, subject)
  if not pct then return end
  -- (a line that has its figure already is not given it twice: such a one is not found)
  local line, shown = Written(tooltip, text)
  if not line then return end
  line:SetText(shown .. " " .. MARK .. "(" .. Percent(pct) .. ")|r")
  count.shown = count.shown + 1
end

-- ---- what the game does not list ---------------------------------------------------------------
-- What your quests still want, a line of your log each: { quest, title, text (as your log has
-- it: "0/1 Bloodscalp Tusk"), subject (what it is about, in small letters), thing (it is a thing
-- to have, as far as the game says: not a kill to make) }. Read again when the game says the log
-- has changed, and every few seconds besides - not with every tooltip.
local wants = { list = {}, dirty = true, at = -100 }
local function Wanted()
  local now = Now()
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
                local text, finished, kind = words(goal.text), goal.finished, goal.type
                -- (only what is still wanted; one the game will not say is done or not is left out)
                if text and text ~= "" and not secret(finished) and finished ~= true then
                  local subject = Subject(text)
                  -- (a kill, a spot to find, a standing to reach is no thing: what the game does not name the kind of may be one)
                  local thing = secret(kind) or type(kind) ~= "string" or kind == "item"
                  if subject and subject ~= "" then list[#list + 1] = { quest = id, title = title, text = text, subject = lower(subject), thing = thing } end
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

-- The colour the game writes an item's name in, by its quality.
local QUALITY = { [0] = "|cff9d9d9d", "|cffffffff", "|cff1eff00", "|cff0070dd", "|cffa335ee", "|cffff8000" }
local function Coloured(d, item, name)
  local kinds = d and type(d.kinds) == "table" and d.kinds or nil
  local quality = kinds and tonumber(kinds[item])
  if quality then quality = quality % 10
  elseif C_Item and type(C_Item.GetItemQualityByID) == "function" then
    local ok, q = pcall(C_Item.GetItemQualityByID, item)
    if ok and not secret(q) and type(q) == "number" then quality = q end
  end
  return (QUALITY[quality or 1] or QUALITY[1]) .. name .. "|r"
end

-- (the tooltip lines were last added to: told of the same writing of a tooltip twice, they are added once)
local done = { data = nil, lines = nil }

-- A creature's tooltip has been written, every line of it: what your quests still want of the
-- creature that the game did not list is written under it, and under that everything else it
-- gives (see the top of this file).
local function Unit(tooltip, data, types, unitType)
  if not Ours(tooltip) or not open(data) then return end
  local kind = data.type
  if secret(kind) or kind ~= unitType then return end
  if rawequal(done.data, data) and done.lines == (Lines(tooltip)) then return end
  local d = Figures()
  local id = CreatureBy(data.guid)
  local row = id and Known(d, id)
  if not row then return end
  local wanted = Wanted()
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
    local pct = RateFor(d, row, w.subject)
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
  count.added = count.added + added

  -- Everything else it gives. Not what stands under a quest already (whatever kind of thing it
  -- is: what a quest of yours wants is that quest's), and nothing of the quest kind that no
  -- quest of yours wants - it would not be in the corpse.
  if shared.DropsListOn() and type(tooltip.AddDoubleLine) == "function" then
    local rest = {}
    for i = 1, #row.list do
      local e = row.list[i]
      if not e.quest then
        local name = NameOf(d, e.item)
        local pct, k, t = Rate(e, row.n)
        if name and pct and pct > 0 and not listed[lower(name)] then rest[#rest + 1] = { name = name, pct = pct, k = k, t = t, item = e.item } end
      end
    end
    if #rest > 0 then
      table.sort(rest, function(a, b) if a.pct ~= b.pct then return a.pct > b.pct end return a.name < b.name end)
      local more = type(IsShiftKeyDown) == "function" and IsShiftKeyDown() and true or false
      local most = more and LIST_LONG or LIST_SHORT
      tooltip:AddLine("Drops", 0.5, 0.83, 1)
      for i = 1, math.min(#rest, most) do
        local r = rest[i]
        local right = Percent(r.pct)
        -- (with Shift: what the figure rests on - found in so many of so many corpses, or the original game's figure alone)
        if more then right = right .. "  " .. MARK .. (r.t > 0 and (r.k .. "/" .. r.t) or "-") .. "|r" end
        tooltip:AddDoubleLine(Coloured(d, r.item, r.name), right, 1, 1, 1, 1, 1, 1)
      end
      if #rest > most then
        tooltip:AddLine(MARK .. "+" .. (#rest - most) .. " rarer" .. (more and "" or " (hold Shift)") .. "|r", 0.6, 0.61, 0.61)
      elseif more then
        tooltip:AddLine(MARK .. "found in so many of the corpses looted; -: the original game's figure|r", 0.6, 0.61, 0.61, true)
      end
      added = added + 1
      count.listed = count.listed + 1
    end
  end
  if added > 0 then done.data, done.lines = data, (Lines(tooltip)) end
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

-- ---- counting what a corpse gives ------------------------------------------------------------------
-- (a spell of yours that brings something out of a creature - skinning it, picking its pocket -
-- opens a list of its own: when one has just been cast, what opens is not the corpse's)
local CAST_FOR = 1.5
local TAKING = { [921] = true }  -- spells that take with no time to cast: Pick Pocket
local cast = { began = nil, at = -100 }
local tally = { counted = 0, passed = 0 }

-- The corpses whose loot has been seen: each counts once (its loot seen again - what you left in
-- it - is not another corpse).
local seen, ring, ringAt = {}, {}, 0
local SEEN_MOST = 400
local function See(guid)
  ringAt = ringAt % SEEN_MOST + 1
  if ring[ringAt] then seen[ring[ringAt]] = nil end
  ring[ringAt] = guid
  seen[guid] = true
end

-- Are you alone? (In a group the game shows each player a part of what a corpse has.) Nothing: the game will not say.
local function Alone()
  if type(IsInGroup) == "function" then
    local ok, grouped = pcall(IsInGroup)
    if not ok or secret(grouped) then return nil end
    if grouped then return false end
  end
  if type(IsInRaid) == "function" then
    local ok, raid = pcall(IsInRaid)
    if not ok or secret(raid) then return nil end
    if raid then return false end
  end
  if type(IsInGroup) ~= "function" and type(GetNumGroupMembers) == "function" then
    local ok, n = pcall(GetNumGroupMembers)
    if not ok or secret(n) or type(n) ~= "number" then return nil end
    return n == 0
  end
  return true
end

-- What the loot that has just opened is of: { [what it came out of] = { id = the creature (nothing:
-- no creature), items = { [item] = { name, quest (the game marks it as of a quest) } } } }, and
-- those in the order met - or nothing, where the game keeps any of it secret or it cannot be told
-- which thing came out of which.
local function Opened()
  if type(GetNumLootItems) ~= "function" or type(GetLootSourceInfo) ~= "function" or type(GetLootSlotLink) ~= "function" then return nil end
  local ok, n = pcall(GetNumLootItems)
  if not ok or secret(n) or type(n) ~= "number" or n < 0 or n > 200 then return nil end
  local by, order, loose = {}, {}, {}
  for slot = 1, n do
    local okLink, link = pcall(GetLootSlotLink, slot)
    if not okLink or secret(link) then return nil end
    local item, name, marked = nil, nil, false
    if type(link) == "string" then
      item = tonumber(match(link, "item:(%d+)"))
      name = match(link, "|h%[(.-)%]|h")
    end
    if item and type(GetLootSlotInfo) == "function" then
      local okInfo, _, said, _, _, _, _, isQuest = pcall(GetLootSlotInfo, slot)
      if okInfo then
        if not name then name = words(said) end
        marked = not secret(isQuest) and isQuest == true
      end
    end
    local from = { pcall(GetLootSourceInfo, slot) }
    if not from[1] then return nil end
    local some = false
    for i = 2, #from, 2 do
      local guid = from[i]
      if secret(guid) then return nil end
      if type(guid) == "string" and guid ~= "" then
        some = true
        local c = by[guid]
        if not c then c = { id = CreatureBy(guid), items = {} } ; by[guid] = c ; order[#order + 1] = guid end
        if item then c.items[item] = { name = name, quest = marked } end
      end
    end
    if item and not some then loose[#loose + 1] = { item = item, name = name, quest = marked } end
  end
  -- (a thing the game names no corpse for: the one corpse there is - or, with several, nobody's, and nothing is counted)
  if #loose > 0 then
    if #order ~= 1 then return nil end
    for _, l in ipairs(loose) do by[order[1]].items[l.item] = { name = l.name, quest = l.quest } end
  end
  return by, order
end

-- ---- said to the 3D map --------------------------------------------------------------------------
-- A creature's figures, the moment they have grown: as a message of the kind the travel facts go
-- by (AzerothAtlas.lua: T_STATS), under key 7 (server/strip.js: readLoot). Whole in itself:
--   the number these saved settings go by (2 bytes), the creature (3), its corpses (3), a check (1),
--   then up to three things, each: the item (3), in how many corpses it was (3), and of how many
--   looted while a quest wanted it (3; 0: a thing that drops for anybody - of the corpses above)
-- The check is of the whole message: one put together from the pieces of two does not add up.
-- Each is said SAY_TIMES rounds running (nothing answers; what is missed all the same is in the
-- saved settings, which the 3D map reads when the game has written them).
local LOOT_KEY, SAY_TIMES, A_ROUND, QUEUE_MOST = 7, 3, 2, 60
local queue = {} -- { creature, items = { item, ... three at most }, left }
local function Byte2(v) return strchar(floor(v / 256) % 256, v % 256) end
local function Byte3(v)
  if v > 16777215 then v = 16777215 end
  return strchar(floor(v / 65536) % 256, floor(v / 256) % 256, v % 256)
end
local function Say(creature, items)
  local open2 = nil
  local function has(u, item) for i = 1, #u.items do if u.items[i] == item then return true end end return false end
  for _, item in ipairs(items) do
    local put = false
    for _, u in ipairs(queue) do
      if u.creature == creature and has(u, item) then u.left = SAY_TIMES ; put = true ; break end
    end
    if not put then
      if not open2 or #open2.items >= 3 then
        open2 = nil
        for _, u in ipairs(queue) do if u.creature == creature and #u.items < 3 then open2 = u ; break end end
        if not open2 then open2 = { creature = creature, items = {}, left = SAY_TIMES } ; queue[#queue + 1] = open2 end
      end
      open2.items[#open2.items + 1] = item
      open2.left = SAY_TIMES
    end
  end
  -- (a corpse with nothing in it: the creature's corpses are said all the same)
  if #items == 0 then
    local any = false
    for _, u in ipairs(queue) do if u.creature == creature then u.left = SAY_TIMES ; any = true end end
    if not any then queue[#queue + 1] = { creature = creature, items = {}, left = SAY_TIMES } end
  end
  while #queue > QUEUE_MOST do table.remove(queue, 1) end
end
local function Message(u)
  local l = Loot()
  local rec = Own(u.creature)
  if not rec then return nil end
  local body = {}
  for i = 1, #u.items do
    local item = u.items[i]
    local t = type(rec.tried) == "table" and tonumber(rec.tried[item]) or 0
    body[#body + 1] = Byte3(item) .. Byte3(tonumber(rec.got[item]) or 0) .. Byte3(t)
  end
  local head, tail = Byte2(l.id) .. Byte3(u.creature) .. Byte3(rec.n), table.concat(body)
  local sum = 0
  for i = 1, #head do sum = sum + string.byte(head, i) * ((i - 1) % 7 + 1) end
  -- (the check stands ninth: what follows it is counted from the tenth place on)
  for i = 1, #tail do sum = sum + string.byte(tail, i) * ((i + 8) % 7 + 1) end
  return head .. strchar(1 + sum % 250) .. tail
end
function shared.LootReport()
  local out = {}
  for _ = 1, math.min(A_ROUND, #queue) do
    local u = table.remove(queue, 1)
    local bytes = Message(u)
    if bytes then out[#out + 1] = { LOOT_KEY, bytes } end
    u.left = u.left - 1
    if bytes and u.left > 0 then queue[#queue + 1] = u end
  end
  return out
end

-- Is this the name of a thing that drops for anybody? (As far as the 3D map's data says: of
-- the things it names, which are of no quest. Read out once for each file the map writes.)
local plainNames = { of = nil, by = nil }
local function Ordinary(d, subject)
  if not d or type(d.names) ~= "table" or type(d.kinds) ~= "table" then return false end
  if plainNames.of ~= d then
    local by = {}
    for item, name in pairs(d.names) do
      local kind = tonumber(d.kinds[item])
      if type(name) == "string" and kind and kind < 10 then by[lower(name)] = true end
    end
    plainNames.of, plainNames.by = d, by
  end
  return plainNames.by[subject] == true
end

-- One corpse of a creature, with what was in it, is counted.
local function Count(creature, items)
  local d = Figures()
  local rec = Own(creature, true)
  rec.n = rec.n + 1
  local changed, questThings = {}, {}
  for item, info in pairs(items) do
    -- (what the corpse calls a thing is its name from now on: the game may not say it by its number yet)
    if info.name and not gameNames[item] then gameNames[item] = info.name end
    -- (of a quest: by the game's own word on the item's kind; where it has none, by how it marks the thing in the corpse)
    local quest = GameQuest(item)
    if quest == nil then quest = info.quest end
    if quest then
      questThings[item] = info
    else
      rec.got[item] = (tonumber(rec.got[item]) or 0) + 1
      changed[#changed + 1] = item
    end
  end
  -- What drops only with its quest: this corpse counts for each thing your log asked for while
  -- you looted it - found or not. By the thing's name, which is all your log says of it.
  local live, any = {}, false
  for _, w in ipairs(Wanted()) do if w.thing then live[w.subject] = true ; any = true end end
  if any then
    local known = Known(d, creature)
    local tried = type(rec.tried) == "table" and rec.tried or nil
    for subject in pairs(live) do
      -- which thing that is: one in this corpse, or one known of this creature already
      local item, found, ordinary = nil, false, false
      for it, info in pairs(questThings) do
        local name = info.name or NameOf(d, it)
        if name and lower(name) == subject then item, found = it, true ; break end
      end
      if not item and known then
        for i = 1, #known.list do
          local e = known.list[i]
          if Is(d, e.item, subject, subject) then
            if e.quest then item = e.item ; break else ordinary = true end
          end
        end
      end
      if not item and not ordinary then
        for it, info in pairs(items) do if not questThings[it] and info.name and lower(info.name) == subject then ordinary = true end end
        -- (a thing that drops for anybody, whatever gives it: its corpses are all of a creature's, and nothing waits under its name)
        if not ordinary then ordinary = Ordinary(d, subject) end
      end
      if item then
        if not tried then tried = {} ; rec.tried = tried end
        local waited = type(rec.on) == "table" and tonumber(rec.on[subject]) or 0
        tried[item] = (tonumber(tried[item]) or 0) + 1 + waited
        if waited > 0 then rec.on[subject] = nil end
        if found then rec.got[item] = (tonumber(rec.got[item]) or 0) + 1 end
        changed[#changed + 1] = item
      elseif not ordinary then
        -- (never yet found on this creature: counted under its name, until it turns up)
        if type(rec.on) ~= "table" then rec.on = {} end
        if rec.on[subject] == nil then
          local names, least, which = 0, nil, nil
          for s, t in pairs(rec.on) do names = names + 1 ; if not least or t < least then least, which = t, s end end
          if names >= PENDING_MOST and which then rec.on[which] = nil end
        end
        rec.on[subject] = (tonumber(rec.on[subject]) or 0) + 1
      end
    end
  end
  stamp = stamp + 1
  tally.counted = tally.counted + 1
  Say(creature, changed)
end

-- Loot has opened.
local function Looted()
  local by, order = Opened()
  if not by then return end
  local now = Now()
  local alone = Alone()
  local afterSpell = now >= cast.at and now - cast.at < CAST_FOR
  local fishing = false
  if type(IsFishingLoot) == "function" then
    local ok, f = pcall(IsFishingLoot)
    fishing = ok and not secret(f) and f == true
  end
  -- (what you have targeted and is alive: its pocket is being picked - no corpse, and its corpse may still come)
  local living = nil
  if type(UnitGUID) == "function" and type(UnitIsDead) == "function" and type(UnitExists) == "function" then
    local okE, there = pcall(UnitExists, "target")
    if okE and not secret(there) and there then
      local okG, guid = pcall(UnitGUID, "target")
      local okD, dead = pcall(UnitIsDead, "target")
      if okG and okD and not secret(guid) and not secret(dead) and type(guid) == "string" and not dead then living = guid end
    end
  end
  for _, guid in ipairs(order) do
    local c = by[guid]
    if c.id and guid ~= living and not seen[guid] then
      See(guid)
      if alone == true and not afterSpell and not fishing then Count(c.id, c.items) else tally.passed = tally.passed + 1 end
    end
  end
end

-- (your quest log has changed: what it still wants is read again with the next tooltip. The
-- frame's name is not the figures' - AzerothAtlasDrops: the game makes a frame's name a word of
-- its own, and it would stand where the figures stood.)
do
  local frame = CreateFrame("Frame", "AzerothAtlasDropsWatch")
  local LOG = { QUEST_LOG_UPDATE = true, QUEST_ACCEPTED = true, QUEST_REMOVED = true, QUEST_TURNED_IN = true, UNIT_QUEST_LOG_CHANGED = true, PLAYER_ENTERING_WORLD = true }
  frame:SetScript("OnEvent", function(_, event, unit, _, spell)
    if LOG[event] then wants.dirty = true
    elseif event == "LOOT_READY" or event == "LOOT_OPENED" then shared.Try("what a corpse gave", Looted)
    elseif event == "MODIFIER_STATE_CHANGED" then
      -- (Shift pressed or let go over a creature: the tooltip is written again, with the whole list or the short one)
      local tip = GameTooltip
      if adding and shared.DropsOn() and shared.DropsListOn() and tip and type(tip.IsShown) == "function" and tip:IsShown()
        and type(tip.GetUnit) == "function" and type(tip.RefreshData) == "function" then
        local ok, _, shownUnit = pcall(tip.GetUnit, tip)
        if ok and shownUnit ~= nil and not secret(shownUnit) then pcall(tip.RefreshData, tip) end
      end
    elseif secret(unit) or unit ~= "player" then
      -- (somebody else's spell)
    elseif event == "UNIT_SPELLCAST_START" then cast.began = Now()
    elseif event == "UNIT_SPELLCAST_SUCCEEDED" then
      -- (a spell that took time to cast, or one known to take from a creature in no time)
      local now = Now()
      if (cast.began and now >= cast.began and now - cast.began < 15) or (not secret(spell) and type(spell) == "number" and TAKING[spell]) then cast.at = now end
      cast.began = nil
    else
      cast.began = nil -- (stopped, failed, interrupted)
    end
  end)
  -- (registered one at a time: a name this game does not have must not stop the rest)
  for _, event in ipairs({ "QUEST_LOG_UPDATE", "QUEST_ACCEPTED", "QUEST_REMOVED", "QUEST_TURNED_IN", "UNIT_QUEST_LOG_CHANGED", "PLAYER_ENTERING_WORLD",
    "LOOT_READY", "LOOT_OPENED", "MODIFIER_STATE_CHANGED",
    "UNIT_SPELLCAST_START", "UNIT_SPELLCAST_SUCCEEDED", "UNIT_SPELLCAST_FAILED", "UNIT_SPELLCAST_INTERRUPTED" }) do pcall(frame.RegisterEvent, frame, event) end
end

-- How much you have counted yourself: creatures, corpses.
local function Counts()
  local l = type(AzerothAtlasDB) == "table" and AzerothAtlasDB.loot
  local creatures, corpses = 0, 0
  if type(l) == "table" and type(l.of) == "table" then
    for _, rec in pairs(l.of) do
      if type(rec) == "table" then creatures = creatures + 1 ; corpses = corpses + (tonumber(rec.n) or 0) end
    end
  end
  return creatures, corpses
end

do
  local d = Figures()
  if not hooked then shared.Log("drops: this game has no way for an addon to add to a line of its tooltip: no drop rates are shown")
  elseif d then
    shared.Log("drops: rates for " .. tostring(d.creatures) .. " creatures (" .. tostring(d.rates) .. " in all), as the 3D map wrote them from the Atlas database" .. (adding and "" or "; this game has no way for an addon to add lines to a creature's tooltip, so only the game's own lines get a rate"))
    shared.Log(Counted(d) and ("drops: " .. tostring(d.things) .. " things creatures give, " .. tostring(d.looted) .. " corpses counted, in what the 3D map wrote") or "drops: written by a 3D map from before it handed any counts on")
  else shared.Log("drops: no rates to show - the 3D map has not written them yet (AzerothAtlas_Drops), or the game has not been started since it did") end
  if type(GetLootSourceInfo) ~= "function" then shared.Log("drops: this game does not say which corpse a thing came out of: what you loot is not counted") end
end

-- /atlas drops: off and on, and what there is
function shared.DropsSay(word)
  local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end
  if word == "off" or word == "on" then shared.SetDrops(word == "on") end
  if word == "list" then shared.SetDropsList(not shared.DropsListOn()) end
  if not hooked then say("this game has no way for an addon to add to a line of its tooltip: drop rates cannot be shown.") return end
  if not shared.DropsOn() then say("drop rates are not shown in a creature's tooltip (/atlas drops on shows them).") return end
  local creatures, corpses = Counts()
  local own = "You have looted " .. corpses .. " corpses of " .. creatures .. " creatures that were counted (" .. tally.counted .. " since you logged in, " .. tally.passed
    .. " passed over: looted in a group, or brought out by a spell): the tooltip goes by them at once, and the 3D map sends them on to the Atlas database. "
  local d = Figures()
  if not d then
    say("drop rates are shown in a creature's tooltip, after what your quest wants of it - but there are none to show yet. The 3D map writes them, from the Atlas database, beside this addon (AzerothAtlas_Drops): run Azeroth Atlas once, then start the game again. " .. own .. "/atlas drops off turns it off.")
    return
  end
  say("where a creature's tooltip says what your quest wants of it, how often it drops that is put after it: figures for " .. tostring(d.creatures) .. " creatures, from the Atlas database as the 3D map last wrote it (" .. count.shown .. " shown since you logged in). Where none is known, the line is as the game wrote it. "
    .. (adding and ("What a quest of yours still wants of a creature and the game does not list is added under it, with its figure (" .. count.added .. " lines added). ") or "")
    .. (adding and (shared.DropsListOn() and ("Under that stands everything else the creature gives, the likeliest first; hold Shift for all of it and what each figure rests on (/atlas drops list leaves the list out). ")
      or "The list of everything else a creature gives is left out (/atlas drops list shows it). ") or "")
    .. own .. "/atlas drops off turns it off.")
end
