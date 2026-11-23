-- Azeroth Atlas: what a vendor sells, what a trainer teaches, where the game's map puts a quest.
--
-- Much of this game is in no file: the game's server tells your game about a thing only when
-- you come to it. Three such things the game does say to an addon, and they are noted here and
-- kept in the addon's saved settings (AzerothAtlasDB.learned), which the game writes when you
-- log out or /reload. The 3D map reads them there and, where you let it share what it learns,
-- hands them on to the Atlas database, where everybody's are put together.
--
--   A vendor   when you open one: which creature it is, and of each thing on sale its item, the
--              copper one purchase costs, how many that gives, and whether its stock runs out.
--              (A price is the one shown to you: a better standing with a vendor's people lowers
--              it. The database goes by the highest anybody was shown.)
--   A trainer  half a second after you open one: which creature it is, and of each thing it
--              would teach you the spell, the copper it costs, the profession and skill it asks
--              for, and the level it asks for. Read with "available" and "unavailable" both
--              shown: one of them you have switched off is switched on for the read and off
--              again straight after, in the same moment.
--   A quest    where the game's own map shows a quest of your log: what is still to do ("o"),
--              or where to hand it in once it is done ("e"); and, where this game says it,
--              where a quest on offer starts ("s"). As the game's map and a place on it in per
--              cent. A pin is kept once it was seen twice, some seconds apart: the moment a
--              quest turns, the game may still show where it was a moment ago.
--
-- Nothing of you is in it: not who opened the vendor, where, or when; no name of anything.
--
-- What is not noted:
--   - a thing sold for something other than money alone (tokens, marks, another item);
--   - a spell you know already: of that the game no longer says from which level it is taught
--     (it answers 0), so it is left to a player who does not know it yet;
--   - a hunter's own Beast Training and the pet trainers: that window is a trainer's too, with
--     no creature behind it - or the wrong one, if you were talking to somebody - and what it
--     asks is training points, not copper;
--   - a trainer's thing whose spell the game does not say as a number (never by its name: a
--     name is in your language, the database is in none). A profession it asks for is found by
--     the game's own name for each profession; where that finds none, the skill is noted
--     without its profession (0);
--   - anything the game hands over as a "secret" value, as it does of some things in a fight or
--     inside a dungeon: left alone, not worked around;
--   - quests on offer the game has not been told of yet: the game asks its server for them when
--     you open its map, and this does no asking of its own.
--
-- shared.LearnedSay()   says how many vendors, trainers and quests are noted (for /atlas to call)
-- shared.AreasTest(rest)  /atlas areas: where the game's map shades the quests of your log, asked
--                       of the game itself - a test (see "the game's quest areas" below)
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor, min = math.floor, math.min
-- (how many are kept. No more than this of a kind in a list, and a list that is full at the first
-- note after a login starts afresh: the map has read it long since)
local VENDORS, GOODS = 600, 200     -- vendors, and things of one
local TRAINERS, LESSONS = 300, 400  -- trainers, and things one teaches
local QUESTS, PINS = 3000, 12       -- quests, and pins of one
local ID_MOST, COPPER_MOST = 16777215, 2e9

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
-- (a value as it is - or nothing, where the game keeps it secret)
local function plain(v)
  if v == nil or secret(v) then return nil end
  return v
end
-- (what a question of the game answers - or nothing: an error, no such question)
local function ask(f, ...)
  if type(f) ~= "function" then return nil end
  local ok, a, b, c = pcall(f, ...)
  if not ok then return nil end
  return a, b, c
end
-- (a whole number within bounds - or nothing)
local function whole(v, least, most)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  if v ~= floor(v) or v < least or v > most then return nil end
  return floor(v)
end
-- (a question the game keeps in one of its tables - or nothing, where this game has no such table)
local function from(space, name)
  local t = _G[space]
  if type(t) ~= "table" then return nil end
  return t[name]
end
-- (f in a while - or at once, in a game with no timers; a mistake in it stops nothing else)
local function Later(seconds, f)
  local function run() shared.Try("what the game shows", f) end
  local after = from("C_Timer", "After")
  if type(after) ~= "function" or not pcall(after, seconds, run) then run() end
end

-- ---- what is kept --------------------------------------------------------------------------------
-- AzerothAtlasDB.learned = { v = vendors, t = trainers, q = quests }, each { n = how many, of = {
--   [vendor]  = { [item]  = "copper,how many,1 where the stock runs out" },
--   [trainer] = { [spell] = "copper,profession,skill,level" },
--   [quest]   = { ["o:map:x:y" (whole per cents: a pin is kept once)] = "x,y" (per cents, two decimals) } } }
local looked = {}
local function Store(kind, most)
  if type(AzerothAtlasDB) ~= "table" then return nil end
  local all = AzerothAtlasDB.learned
  if type(all) ~= "table" then
    all = {}
    AzerothAtlasDB.learned = all
  end
  local list = all[kind]
  -- (a full list is one the map has read long since: it starts afresh, so it never grows without end)
  local full = not looked[kind] and type(list) == "table" and (tonumber(list.n) or 0) >= most
  looked[kind] = true
  if type(list) ~= "table" or type(list.of) ~= "table" or type(list.n) ~= "number" or full then
    list = { n = 0, of = {} }
    all[kind] = list
  end
  return list
end

-- One thing noted of one of a kind (kind: "v", "t" or "q"; id: the vendor, trainer or quest).
-- Returns true where it is new.
local function Keep(kind, most, each, id, key, value)
  local list = Store(kind, most)
  if not list then return false end
  local rec = list.of[id]
  if type(rec) ~= "table" then
    if list.n >= most then return false end
    rec = {}
    list.of[id] = rec
    list.n = list.n + 1
  end
  if rec[key] == value then return false end
  if rec[key] == nil then
    local count = 0
    for _ in pairs(rec) do count = count + 1 end
    if count >= each then return false end
  end
  rec[key] = value
  return true
end
local function Kept(kind, id, key)
  local all = type(AzerothAtlasDB) == "table" and AzerothAtlasDB.learned or nil
  local list = type(all) == "table" and all[kind] or nil
  local rec = type(list) == "table" and type(list.of) == "table" and list.of[id] or nil
  return type(rec) == "table" and rec[key] ~= nil
end

-- The creature you are talking to, as its number - or nothing: nobody, a player, an object.
local function Npc()
  local guid = ask(UnitGUID, "npc")
  if guid == nil or secret(guid) or type(guid) ~= "string" or type(strsplit) ~= "function" then return nil end
  local kind, _, _, _, _, id = strsplit("-", guid)
  if kind ~= "Creature" then return nil end
  return whole(tonumber(id), 1, ID_MOST)
end

-- ---- a vendor ------------------------------------------------------------------------------------
-- One thing on sale, as the game shows it: its item, the copper one purchase costs, how many
-- that gives, and 1 where its stock runs out (0: it never does). Nothing for a thing with a
-- price other than money, or one the game does not say in full.
local function Good(i)
  local price, per, stock, other, token
  local info = from("C_MerchantFrame", "GetItemInfo")
  if type(info) == "function" then
    local ok, t = pcall(info, i)
    if not ok or t == nil or secret(t) or type(t) ~= "table" then return nil end
    price, per, stock, other, token = t.price, t.stackCount, t.numAvailable, t.hasExtendedCost, t.currencyID
  elseif type(GetMerchantItemInfo) == "function" then
    -- (the same, as games before this one said it: name, picture, price, how many, stock, ..., another price, a currency)
    local ok, _, _, p, n, s, _, _, x, c = pcall(GetMerchantItemInfo, i)
    if not ok then return nil end
    price, per, stock, other, token = p, n, s, x, c
  else
    return nil
  end
  if secret(other) or secret(token) then return nil end
  if (other ~= nil and other ~= false and other ~= 0) or (type(token) == "number" and token > 0) then return nil end
  local costs = ask(GetMerchantItemCostInfo, i)
  if secret(costs) or (type(costs) == "number" and costs > 0) then return nil end
  price, per, stock = whole(price, 0, COPPER_MOST), whole(per, 1, 10000), whole(stock, -1, 1e9)
  if not price or not per or not stock then return nil end
  local item = whole(ask(GetMerchantItemID, i), 1, ID_MOST)
  if not item then
    local link = plain(ask(GetMerchantItemLink, i))
    if type(link) == "string" then item = whole(tonumber(link:match("|Hitem:(%d+)")), 1, ID_MOST) end
  end
  if not item then return nil end
  return item, price, per, (stock >= 0) and 1 or 0
end

-- The vendor whose window is open: everything it has on sale. Returns true where something new was noted.
function shared.LearnGoods()
  local npc = Npc()
  if not npc then return false end
  local n = whole(ask(GetMerchantNumItems), 1, 2000)
  if not n then return false end
  local new = false
  for i = 1, n do
    local item, price, per, limited = Good(i)
    if item and Keep("v", VENDORS, GOODS, npc, item, price .. "," .. per .. "," .. limited) then new = true end
  end
  return new
end

-- ---- a trainer -----------------------------------------------------------------------------------
-- The professions (and the like) a trainer may ask for, by the number the game's data has for
-- each. A trainer names the one it asks for, in your language; the game's own name for each of
-- these, asked by number, says which it is.
local SKILLS = { 164, 165, 171, 182, 185, 186, 197, 202, 333, 393, 129, 356, 755, 773, 762, 633, 40 }
local function SkillNames()
  local names, ids = {}, {}
  for k = 1, #SKILLS do ids[k] = SKILLS[k] end
  local more = plain(ask(from("C_TradeSkillUI", "GetAllProfessionTradeSkillLines")))
  if type(more) == "table" then
    for k = 1, min(#more, 200) do
      local id = whole(more[k], 1, ID_MOST)
      if id then ids[#ids + 1] = id end
    end
  end
  local shown, byNumber = from("C_TradeSkillUI", "GetTradeSkillDisplayName"), from("C_SkillInfo", "GetSkillLineInfoByID")
  for k = 1, #ids do
    local name = plain(ask(shown, ids[k]))
    if type(name) ~= "string" or name == "" then
      local info = plain(ask(byNumber, ids[k]))
      name = type(info) == "table" and plain(info.name) or nil
    end
    if type(name) == "string" and name ~= "" and names[name] == nil then names[name] = ids[k] end
  end
  return names
end

-- One thing a trainer would teach you, as the game shows it: the spell, the copper it costs,
-- the profession (0: none, or one the game's names do not give) and skill it asks for, the level
-- it asks for (0: none). Nothing for a line that is no such thing (a heading, a spell you know),
-- or one the game does not say in full. `names`: { the professions by name }, filled when first needed.
local STATE = { available = true, unavailable = true, used = true, header = true }
local function Lesson(i, spellOf, names)
  -- (name, state, picture, level, ...; or, as games before this one said it: name, rank, state)
  local ok, _, a, b, c = pcall(GetTrainerServiceInfo, i)
  if not ok then return nil end
  local hidden = secret(c)
  a, b, c = plain(a), plain(b), plain(c)
  local state, said = a, true   -- said: the line itself says the level
  if not STATE[a] and STATE[b] then state, said = b, false end
  if state ~= "available" and state ~= "unavailable" then return nil end
  local level
  if said and not hidden and c ~= nil then
    level = whole(c, 0, 99)
    if not level then return nil end
  else
    level = whole(ask(GetTrainerServiceLevelReq, i), 0, 99)
    if not level then
      if hidden or not said then return nil end
      level = 0   -- (a line that names no level asks for none: so the game's own window takes it)
    end
  end
  if level <= 1 then level = 0 end
  -- the spell: what the game would show in the line's tooltip is of a spell, and says which
  local tip = plain(ask(spellOf, i))
  if type(tip) ~= "table" then return nil end
  local kinds = from("Enum", "TooltipDataType")
  if plain(tip.type) ~= (type(kinds) == "table" and kinds.Spell or 1) then return nil end
  local spell = whole(tip.id, 1, ID_MOST)
  local cost = whole(ask(GetTrainerServiceCost, i), 0, COPPER_MOST)
  if not spell or not cost then return nil end
  local ok2, skill, rank = pcall(GetTrainerServiceSkillReq, i)
  if not ok2 or secret(skill) or secret(rank) then return nil end
  local line = 0
  if skill == nil or skill == "" then
    rank = 0
  else
    if type(skill) ~= "string" then return nil end
    rank = whole(rank, 0, 1000)
    if not rank then return nil end
    if not names.of then names.of = SkillNames() end
    line = names.of[skill] or 0
    if line == 0 and rank == 0 then return nil end
  end
  return spell, cost, line, rank, level
end

-- The trainer whose window is open: everything it would teach you. Returns true where something
-- new was noted, and how many lines its list had.
local SHOWN = { "available", "unavailable" }
function shared.LearnLessons()
  local npc = Npc()
  if not npc then return false, 0 end
  local spellOf, kindOf = from("C_TooltipInfo", "GetTrainerService"), from("C_Trainer", "GetTrainerType")
  if type(GetNumTrainerServices) ~= "function" or type(GetTrainerServiceInfo) ~= "function" or type(GetTrainerServiceCost) ~= "function"
    or type(GetTrainerServiceSkillReq) ~= "function" or type(spellOf) ~= "function" or type(kindOf) ~= "function" then return false, 0 end
  -- (the game's kinds of trainer: 0 a class's or any other, 2 a profession's; 3 is a hunter's pet's)
  local kind = whole(ask(kindOf), 0, 3)
  if kind ~= 0 and kind ~= 2 then return false, 0 end
  -- what you have switched off of the list is switched on for the read (not in a fight)...
  local off = {}
  if type(GetTrainerServiceTypeFilter) == "function" and type(SetTrainerServiceTypeFilter) == "function"
    and not (type(InCombatLockdown) == "function" and plain(ask(InCombatLockdown)) ~= false) then
    for k = 1, #SHOWN do
      local on = plain(ask(GetTrainerServiceTypeFilter, SHOWN[k]))
      if (on == false or on == 0) and pcall(SetTrainerServiceTypeFilter, SHOWN[k], true) then off[#off + 1] = SHOWN[k] end
    end
  end
  local ok, new, lines = shared.Try("a trainer's list", function()
    local n = whole(ask(GetNumTrainerServices), 1, 2000)
    if not n then return false, 0 end
    local names, any = {}, false
    for i = 1, n do
      local spell, cost, line, rank, level = Lesson(i, spellOf, names)
      if spell and Keep("t", TRAINERS, LESSONS, npc, spell, cost .. "," .. line .. "," .. rank .. "," .. level) then any = true end
    end
    return any, n
  end)
  -- ...and off again, whatever became of the read
  for k = 1, #off do pcall(SetTrainerServiceTypeFilter, off[k], false) end
  if not ok then return false, 0 end
  return new, lines
end

-- A trainer's list is not all there the moment its window opens (and may be empty then): it is
-- read half a second on, once a visit - and, where it was empty still, after the next the game
-- says of it, three times at most. Whose list it is, is settled as the window opens: a read
-- finding you with somebody else by then notes nothing.
local teaching = { open = false, read = false, waiting = false, tries = 0, who = nil }
local function Teach()
  teaching.waiting = false
  if not teaching.open or teaching.read or teaching.who == nil or Npc() ~= teaching.who then return end
  teaching.tries = teaching.tries + 1
  local ok, _, lines = shared.Try("a trainer's lessons", shared.LearnLessons)
  if (ok and (lines or 0) > 0) or teaching.tries >= 3 then teaching.read = true end
end
local function TeachSoon()
  if teaching.waiting or teaching.read or not teaching.open then return end
  teaching.waiting = true
  Later(0.5, Teach)
end

-- ---- a quest on the game's map -------------------------------------------------------------------
-- How a quest stands: "o" in your log with something still to do, "e" in your log and ready to
-- hand in, false not in your log - or nothing: failed, or the game does not say.
local function Stage(id)
  local index, done, failed = from("C_QuestLog", "GetLogIndexForQuestID"), from("C_QuestLog", "IsComplete"), from("C_QuestLog", "IsFailed")
  if type(index) ~= "function" or type(done) ~= "function" then return nil end
  local ok, at = pcall(index, id)
  if not ok or secret(at) then return nil end
  if at == nil or at == 0 then return false end
  if not whole(at, 1, 10000) then return nil end
  if type(failed) == "function" then
    local ok2, bad = pcall(failed, id)
    if not ok2 or secret(bad) or bad == true then return nil end
  end
  local ok3, ready = pcall(done, id)
  if not ok3 or secret(ready) or type(ready) ~= "boolean" then return nil end
  return ready and "e" or "o"
end

local MAPS = 8          -- maps asked about in one look
local WAIT, AGAIN = 3, 5  -- seconds from the game saying something of quests to the look, and to the second look at what was new
local function Follow(maps, id)
  id = whole(id, 1, ID_MOST)
  if not id or #maps >= MAPS then return end
  for k = 1, #maps do
    if maps[k] == id then return end
  end
  maps[#maps + 1] = id
end

-- One pin as the game gives it, of the map `here`: taken into `found` where it is sound.
-- offer: it is of the game's list of quests on offer (else of the pins of your log).
local function Pin(found, maps, entry, here, offer)
  local quest, x, y = whole(entry.questID, 1, ID_MOST), entry.x, entry.y
  if not quest or x == nil or y == nil or secret(x) or secret(y) or type(x) ~= "number" or type(y) ~= "number" then return end
  -- (a pin on the very edge of a map, or at its corner, is one the game had no place for)
  if not (x > 0 and x < 1 and y > 0 and y < 1) then return end
  local letter, on
  if offer then
    local busy = entry.inProgress
    if secret(busy) or busy == true or Stage(quest) ~= false then return end
    letter, on = "s", entry.startMapID
  else
    local mark, start = entry.isMapIndicatorQuest, entry.isQuestStart
    if secret(mark) or mark == true or secret(start) then return end
    if start == true then
      if Stage(quest) ~= false then return end
      letter = "s"
    else
      letter = Stage(quest)
      if letter ~= "o" and letter ~= "e" then return end
    end
    on = entry.mapID
  end
  -- A pin of another map (a town within this one, a cave) is shown on this map too: that map is
  -- asked as well, and what it says of the quest counts for more than this.
  if secret(on) then return end
  local own = not (type(on) == "number" and on > 0 and on ~= here)
  if not own then Follow(maps, on) end
  local was = found[quest]
  if was and was.own and not own then return end
  found[quest] = { letter = letter, map = here, x = floor(x * 10000 + 0.5), y = floor(y * 10000 + 0.5), own = own }
end

-- One look at the game's map: every pin it has now, on the map you are on and the one its quest
-- pins are set to (the one you have open), and on those their pins belong to. A pin seen a
-- second time is noted. Returns true where one was seen for the first time: look again.
local seen, seens = {}, 0   -- "quest:pin" -> 1 seen once, 2 dealt with (noted, or no room for it)
function shared.LearnPins()
  local ofLog, onOffer = from("C_QuestLog", "GetQuestsOnMap"), from("C_QuestLine", "GetAvailableQuestLines")
  if type(ofLog) ~= "function" and type(onOffer) ~= "function" then return false end
  local maps, found = {}, {}
  Follow(maps, (ask(from("C_Map", "GetBestMapForUnit"), "player")))
  Follow(maps, (ask(from("C_QuestLog", "GetMapForQuestPOIs"))))
  local at = 1
  while at <= #maps do
    local here = maps[at]
    at = at + 1
    -- (the pins of your log first, then the quests on offer)
    for pass = 1, 2 do
      local question = ofLog
      if pass == 2 then question = onOffer end
      local list = plain(ask(question, here))
      if type(list) == "table" then
        for k = 1, min(#list, 300) do
          local entry = plain(list[k])
          if type(entry) == "table" then Pin(found, maps, entry, here, pass == 2) end
        end
      end
    end
  end
  local again = false
  for quest, p in pairs(found) do
    -- (hundredths of a per cent, whole: the pin's name to the nearest per cent, its place to two decimals)
    local key = p.letter .. ":" .. p.map .. ":" .. floor((p.x + 50) / 100) .. ":" .. floor((p.y + 50) / 100)
    local name = quest .. ":" .. key
    if seen[name] ~= 2 and not Kept("q", quest, key) then
      if seen[name] == 1 then
        seen[name] = 2
        Keep("q", QUESTS, PINS, quest, key, string.format("%d.%02d,%d.%02d", floor(p.x / 100), p.x % 100, floor(p.y / 100), p.y % 100))
      else
        if seens >= 2000 then seen, seens = {}, 0 end
        seen[name] = 1
        seens = seens + 1
        again = true
      end
    end
  end
  return again
end

local looking = false
local function Look()
  looking = false
  local ok, again = shared.Try("the game map's quest pins", shared.LearnPins)
  if ok and again and not looking then
    looking = true
    Later(AGAIN, Look)
  end
end

-- ---- the game's quest areas: a test (/atlas areas) -----------------------------------------------
-- The game's map shades where a quest of your log has something to do: its quest areas. They are
-- in no file of the game - its server sends them as you play - and the game hands them to no
-- addon. But its own map asks the frame that draws them which quest's area is under the mouse
-- (QuestBlobDataProvider.lua: UpdateMouseOverTooltip, with the place as fractions of the map, and
-- GetTooltipIndex for each of that quest's areas there). Whether the frame answers as well for a
-- place the mouse is not at, nobody knows yet: this tries it. /atlas areas takes the quests of
-- your log - first those the game's map pins on the map you are on - and, one quest at a time,
-- has a frame of its own draw that quest's areas, unseen, and asks it about places all over the
-- map (a coarse grid), then finely where it found something and round the quest's pin. The ways
-- the frame may be drawn are tried in turn until one answers. It takes a few milliseconds a
-- frame, so the game goes on as smoothly, and never runs in a fight: one that begins stops it,
-- as /atlas areas stop does, and what it found by then is kept.
--
-- What it found is in AzerothAtlasDB.areaTest (the game writes it when you /reload or log out):
--   { v = 1, at = when, map = the map, corners = { "x,y" of the world at the map's top left, at
--     its bottom right }, me = "x,y" where you were on the map, log = how many quests your log
--     has, pinned = how many of them the map pins, look = the way of drawing that answered (1 the
--     frame unseen, 2 the frame shown and its areas see-through, 3 the areas all but see-through),
--     asked = places asked about, ms = how long that took, looked = quests gone through,
--     done = true once it got to the end, else why it stopped,
--     quests = { [quest] = {
--       pin = "x,y" where the map pins it; inside = whether the game says you stand in one of its
--       areas; first = how many of 25 places round its pin answered in the very frame it was
--       drawn; atPin, atMe = which of its areas the frame says are at its pin, and at you;
--       coarse = places of the coarse grid that answered for it, other = for another quest;
--       box = "x0,y0,step,columns,rows" of the fine grid;
--       areas = { [the game's number for the area, "a" where it gives none] = { "row:from-to,...", ... } };
--       goals = { [that number] = "finished,type,text" as the game's map says that area's objective };
--       wants = { "type,done/needed,finished,text" of each objective of the quest } } } }
-- (places are fractions of the map, across and down, as the game's map has them)
local AREAS = {
  coarse = 40,        -- the coarse grid: places across and down
  finest = 1 / 400,   -- the fine grid's step at its finest, of the map's width and height...
  most = 16000,       -- ...coarser where the box is so large that it would be more places than this
  around = 0.03,      -- round a quest's pin the box always reaches this far
  slice = 5,          -- milliseconds a frame
  batch = 3000,       -- places asked about in one frame, at most
  longest = 240,      -- seconds, at most
}
-- the ways of drawing, tried until one answers: { the frame's alpha, the areas' alpha (0-255) }
local LOOKS = { { 0, 0 }, { 1, 0 }, { 1, 1 } }
local areaFrames = {}   -- way of drawing -> its frame (false: none could be made)
local probe = nil       -- the test under way

local function Say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end
-- (milliseconds, as finely as the game says them)
local function Clock()
  local ms = plain(ask(_G.debugprofilestop))
  if type(ms) == "number" then return ms end
  return (plain(ask(GetTime)) or 0) * 1000
end

-- A frame of the kind the game's map draws quest areas with, drawn the given way - or nothing,
-- where this game has no such frame for an addon.
local function AreaFrame(look)
  local f = areaFrames[look]
  if f ~= nil then return f or nil end
  areaFrames[look] = false
  local ok, made = pcall(CreateFrame, "QuestPOIFrame", nil, UIParent)
  if not ok or type(made) ~= "table" then return nil end
  for _, name in ipairs({ "DrawBlob", "DrawNone", "SetMapID", "UpdateMouseOverTooltip", "GetTooltipIndex" }) do
    if type(made[name]) ~= "function" then return nil end
  end
  local alpha, fill = LOOKS[look][1], LOOKS[look][2]
  -- (the game's own look for them, as QuestBlobDataProvider.lua sets it - see-through here)
  pcall(made.SetFillTexture, made, "Interface\\WorldMap\\UI-QuestBlob-Inside")
  pcall(made.SetBorderTexture, made, "Interface\\WorldMap\\UI-QuestBlob-Outside")
  pcall(made.SetFillAlpha, made, fill)
  pcall(made.SetBorderAlpha, made, fill)
  pcall(made.SetFrameStrata, made, "BACKGROUND")
  pcall(made.EnableMouse, made, false)
  pcall(made.SetSize, made, 600, 400)
  pcall(made.SetPoint, made, "CENTER", UIParent, "CENTER", 0, 0)
  pcall(made.SetAlpha, made, alpha)
  pcall(made.Hide, made)
  areaFrames[look] = made
  return made
end

-- What the frame says is at (x, y) of its map: the quest whose area is there, and which of its
-- areas they are ("a" where it gives no number) - or nothing.
local function Under(f, x, y)
  local ok, quest, n = pcall(f.UpdateMouseOverTooltip, f, x, y)
  if not ok then return nil end
  quest = whole(quest, 1, ID_MOST)
  if not quest then return nil end
  local keys = {}
  for i = 1, whole(n, 0, 64) or 0 do
    local ok2, k = pcall(f.GetTooltipIndex, f, i)
    k = ok2 and whole(k, -1, 1000) or nil
    if k then keys[#keys + 1] = tostring(k) end
  end
  if #keys == 0 then keys[1] = "a" end
  return quest, keys
end

-- The same, asked as part of the test: once this frame's share of time is used up, the rest
-- waits for the next frame. (The test waits only here and in LookAt, never inside a pcall: the
-- game's Lua cannot wait inside one.)
local function Ask(x, y)
  local run = probe
  run.asked, run.slice = run.asked + 1, run.slice + 1
  if run.slice % 32 == 0 and (run.slice >= AREAS.batch or Clock() - run.from > AREAS.slice) then coroutine.yield() end
  return Under(run.f, x, y)
end

-- Which of the quest's areas the frame says are at (x, y): their numbers, "none", or the other quest there.
local function Which(quest, x, y)
  local q, keys = Under(probe.f, x, y)
  if q == quest then return table.concat(keys, " ") end
  return q and ("quest " .. q) or "none"
end

-- The coarse grid over the whole map: how many places answered for the quest, and the box round
-- them, a place wider on each side (nothing where none answered).
local function Coarse(rec, quest)
  local n = AREAS.coarse
  local hits, other, c0, r0, c1, r1 = 0, 0, n, n, -1, -1
  for r = 0, n - 1 do
    for c = 0, n - 1 do
      local q = Ask((c + 0.5) / n, (r + 0.5) / n)
      if q == quest then
        hits = hits + 1
        if c < c0 then c0 = c end
        if c > c1 then c1 = c end
        if r < r0 then r0 = r end
        if r > r1 then r1 = r end
      elseif q then
        other = other + 1
      end
    end
  end
  rec.coarse, rec.other = hits, other
  if hits == 0 then return nil end
  return math.max(0, (c0 - 1) / n), math.max(0, (r0 - 1) / n), math.min(1, (c1 + 2) / n), math.min(1, (r1 + 2) / n)
end

-- The fine grid over a box of the map: the quest's areas found there, each as runs of columns in
-- each row. Returns true where it found any.
local function Fine(rec, quest, x0, y0, x1, y1)
  local step = math.max(AREAS.finest, math.sqrt((x1 - x0) * (y1 - y0) / AREAS.most))
  local cols, rows = math.max(1, math.ceil((x1 - x0) / step)), math.max(1, math.ceil((y1 - y0) / step))
  rec.box = string.format("%.5f,%.5f,%.6f,%d,%d", x0, y0, step, cols, rows)
  -- (filled row by row: a test stopped half way keeps the rows it got to)
  local areas, any = {}, false
  rec.areas = areas
  for r = 0, rows - 1 do
    local y = y0 + (r + 0.5) * step
    local open, runs = {}, {}   -- area -> the column its run began at; area -> its runs in this row
    for c = 0, cols do
      local here = nil
      if c < cols then
        local q, keys = Ask(x0 + (c + 0.5) * step, y)
        if q == quest then
          here = {}
          for k = 1, #keys do here[keys[k]] = true end
        end
      end
      for key, began in pairs(open) do
        if not (here and here[key]) then
          local list = runs[key]
          if not list then list = {} runs[key] = list end
          list[#list + 1] = began .. "-" .. (c - 1)
          open[key] = nil
        end
      end
      if here then
        for key in pairs(here) do
          if open[key] == nil then open[key] = c end
        end
      end
    end
    for key, list in pairs(runs) do
      local rowsOf = areas[key]
      if not rowsOf then rowsOf = {} areas[key] = rowsOf end
      rowsOf[#rowsOf + 1] = r .. ":" .. table.concat(list, ",")
      any = true
    end
  end
  return any
end

-- What the game says of the quest's objectives, and of the objective of each area found (as its own map says it).
local function Goals(rec, quest)
  local list = plain(ask(from("C_QuestLog", "GetQuestObjectives"), quest))
  if type(list) == "table" then
    rec.wants = {}
    for i = 1, min(#list, 20) do
      local o = plain(list[i])
      if type(o) == "table" then
        rec.wants[#rec.wants + 1] = tostring(plain(o.type)) .. "," .. tostring(plain(o.numFulfilled)) .. "/" .. tostring(plain(o.numRequired)) .. "," .. tostring(plain(o.finished)) .. "," .. tostring(plain(o.text))
      end
    end
  end
  local index = whole(ask(from("C_QuestLog", "GetLogIndexForQuestID"), quest), 1, 10000)
  local board = _G.GetQuestPOILeaderBoard
  if not rec.areas or not index or type(board) ~= "function" then return end
  rec.goals = {}
  for key in pairs(rec.areas) do
    local k = tonumber(key)
    if k then
      local ok, text, kind, finished = pcall(board, k, index)
      if ok then rec.goals[key] = tostring(plain(finished)) .. "," .. tostring(plain(kind)) .. "," .. tostring(plain(text)) end
    end
  end
end

-- One quest, with the frame in use: its areas drawn, and the frame asked about them. Returns what
-- was found, and whether the frame answered for the quest at all.
local function LookAt(quest)
  local run = probe
  local f, pin = run.f, run.pins[quest]
  local rec = { pin = pin and string.format("%.4f,%.4f", pin[1], pin[2]) or nil }
  -- (kept at once, and filled as it goes: a test stopped half way keeps what it got to)
  run.out.quests[quest] = rec
  local inside = plain(ask(from("C_Minimap", "IsInsideQuestBlob"), quest))
  if type(inside) == "boolean" then rec.inside = inside end
  pcall(f.DrawNone, f)
  if not pcall(f.DrawBlob, f, quest, true) then
    rec.drawn = false
    return rec, false
  end
  -- (in the very frame it was drawn: the places round its pin)
  local first = 0
  if pin then
    for dy = -2, 2 do
      for dx = -2, 2 do
        if Under(f, pin[1] + dx * 0.004, pin[2] + dy * 0.004) == quest then first = first + 1 end
      end
    end
  end
  rec.first = first
  -- (the rest in the frames after it)
  coroutine.yield()
  if pin then rec.atPin = Which(quest, pin[1], pin[2]) end
  if run.me then rec.atMe = Which(quest, run.me[1], run.me[2]) end
  local x0, y0, x1, y1 = Coarse(rec, quest)
  if pin then
    local a = AREAS.around
    x0, y0 = math.min(x0 or 1, math.max(0, pin[1] - a)), math.min(y0 or 1, math.max(0, pin[2] - a))
    x1, y1 = math.max(x1 or 0, math.min(1, pin[1] + a)), math.max(y1 or 0, math.min(1, pin[2] + a))
  end
  local found = x0 ~= nil and Fine(rec, quest, x0, y0, x1, y1)
  Goals(rec, quest)
  return rec, found or rec.coarse > 0 or first > 0
end

-- The frame drawn the given way put to use: shown, on the test's map. False where there is none.
local function Use(look)
  local f = AreaFrame(look)
  if not f then return false end
  local was = probe.f
  if was and was ~= f then
    pcall(was.DrawNone, was)
    pcall(was.Hide, was)
  end
  probe.f = f
  pcall(f.Show, f)
  pcall(f.SetMapID, f, probe.map)
  return true
end

-- The test itself, a frame's share at a time (a coroutine: Drive takes it on each frame).
local function Body()
  local run = probe
  local tries = 0   -- quests the map pins here that every way of drawing was tried on, none answering
  for i = 1, #run.list do
    local quest = run.list[i]
    local rec, found
    local first, last = 1, 1
    if run.look then
      first, last = run.look, run.look
    elseif run.pins[quest] and tries < 3 then
      last = #LOOKS
    end
    for look = first, last do
      if Use(look) then
        rec, found = LookAt(quest)
        rec.look = look
        if found then
          run.look = look
          break
        end
      end
    end
    if not run.look and last > first then tries = tries + 1 end
    run.out.quests[quest] = rec or { drawn = false }
    run.out.looked = i
  end
end

-- The test's end: the frame cleared and hidden, and how it went said.
local function Finish(why)
  local run = probe
  if not run then return end
  probe = nil
  if run.f then
    pcall(run.f.DrawNone, run.f)
    pcall(run.f.Hide, run.f)
  end
  local out = run.out
  out.asked, out.ms, out.look, out.done = run.asked, floor(run.ms + 0.5), run.look, why or true
  local looked, answered = 0, 0
  for _, rec in pairs(out.quests) do
    looked = looked + 1
    if (rec.coarse or 0) > 0 or (rec.first or 0) > 0 or (rec.areas and next(rec.areas)) then answered = answered + 1 end
  end
  local said
  if answered > 0 then
    said = string.format("quest areas: the game showed where %d of the %d quests looked at have an area on this map (%d places asked about, in %.1f s).", answered, looked, run.asked, run.ms / 1000)
  else
    said = string.format("quest areas: the game showed no area for any of the %d quests looked at (%d places asked about).", looked, run.asked)
  end
  if why then said = said .. " It stopped early: " .. why .. "." end
  Say(said .. " Type /reload to keep what it found.")
end

-- Each frame: the test's next share - unless a fight has begun, or it has gone on too long.
local function Drive()
  local run = probe
  if not run then return end
  if plain(ask(InCombatLockdown)) == true then Finish("a fight began") return end
  if (plain(ask(GetTime)) or 0) - run.started > AREAS.longest then Finish("it took too long") return end
  run.slice, run.from = 0, Clock()
  local ok, err = coroutine.resume(run.co)
  run.ms = run.ms + (Clock() - run.from)
  if probe ~= run then return end
  if not ok then
    shared.Log("ERROR the game's quest areas: " .. tostring(err))
    Finish("something went wrong (" .. tostring(err) .. ")")
    return
  end
  if coroutine.status(run.co) == "dead" then Finish() return end
  Later(0, Drive)
end

-- "x,y" of the world at a place of the map (fractions across and down) - or nothing.
local function Corner(map, x, y)
  local make, toWorld = _G.CreateVector2D, from("C_Map", "GetWorldPosFromMapPos")
  if type(make) ~= "function" or type(toWorld) ~= "function" then return nil end
  local ok, v = pcall(make, x, y)
  if not ok or type(v) ~= "table" then return nil end
  local ok2, _, pos = pcall(toWorld, map, v)
  if not ok2 or type(pos) ~= "table" then return nil end
  local px, py = plain(pos.x), plain(pos.y)
  if type(px) ~= "number" or type(py) ~= "number" then return nil end
  return string.format("%.1f,%.1f", px, py)
end

-- The quests of your log (no headings, none the game hides), and where the map pins them on `map`.
local function LogAndPins(map)
  local log, have, pins = {}, {}, {}
  local info = from("C_QuestLog", "GetInfo")
  for i = 1, whole(ask(from("C_QuestLog", "GetNumQuestLogEntries")), 0, 200) or 0 do
    local e = plain(ask(info, i))
    if type(e) == "table" and plain(e.isHeader) ~= true and plain(e.isHidden) ~= true then
      local q = whole(e.questID, 1, ID_MOST)
      if q and not have[q] then
        have[q] = true
        log[#log + 1] = q
      end
    end
  end
  local list = plain(ask(from("C_QuestLog", "GetQuestsOnMap"), map))
  if type(list) == "table" then
    for k = 1, min(#list, 300) do
      local e = plain(list[k])
      if type(e) == "table" then
        local q, x, y = whole(e.questID, 1, ID_MOST), plain(e.x), plain(e.y)
        if q and have[q] and not pins[q] and type(x) == "number" and type(y) == "number" and x > 0 and x < 1 and y > 0 and y < 1
          and plain(e.isQuestStart) ~= true and plain(e.isMapIndicatorQuest) ~= true then pins[q] = { x, y } end
      end
    end
  end
  return log, pins
end

-- /atlas areas (rest "stop": stops it)
function shared.AreasTest(rest)
  if rest == "stop" then
    if probe then Finish("you stopped it") else Say("quest areas: nothing is being looked at.") end
    return
  end
  if probe then Say("quest areas: already looking (/atlas areas stop stops it).") return end
  if plain(ask(InCombatLockdown)) == true then Say("quest areas: not in a fight - try again once it is over.") return end
  local map = whole(ask(from("C_Map", "GetBestMapForUnit"), "player"), 1, ID_MOST)
  if not map then Say("quest areas: the game does not say which map you are on here.") return end
  if not AreaFrame(1) then Say("quest areas: this game has no frame an addon can draw quest areas with, so there is nothing to look at.") return end
  local log, pins = LogAndPins(map)
  if #log == 0 then Say("quest areas: there are no quests in your log to look at.") return end
  local list, pinned = {}, 0
  for _, q in ipairs(log) do
    if pins[q] then
      list[#list + 1] = q
      pinned = pinned + 1
    end
  end
  for _, q in ipairs(log) do if not pins[q] then list[#list + 1] = q end end
  local me = nil
  local pos = plain(ask(from("C_Map", "GetPlayerMapPosition"), map, "player"))
  if type(pos) == "table" and type(pos.GetXY) == "function" then
    local ok, x, y = pcall(pos.GetXY, pos)
    x, y = ok and plain(x) or nil, ok and plain(y) or nil
    if type(x) == "number" and type(y) == "number" then me = { x, y } end
  end
  local out = { v = 1, at = plain(ask(time)), map = map, corners = { Corner(map, 0, 0), Corner(map, 1, 1) },
    me = me and string.format("%.4f,%.4f", me[1], me[2]) or nil, log = #log, pinned = pinned, looked = 0, done = false, quests = {} }
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.areaTest = out
  probe = { map = map, list = list, pins = pins, me = me, out = out, asked = 0, ms = 0, slice = 0, from = 0, started = plain(ask(GetTime)) or 0 }
  probe.co = coroutine.create(Body)
  Say(string.format("quest areas: looking at the %d quests of your log (%d pinned on this map). It takes some seconds; play on as you like, but a fight stops it.", #list, pinned))
  Later(0, Drive)
end

-- ---- how many, and when --------------------------------------------------------------------------
function shared.LearnedCount()
  local all = type(AzerothAtlasDB) == "table" and AzerothAtlasDB.learned or nil
  local function count(kind)
    local list = type(all) == "table" and all[kind] or nil
    return type(list) == "table" and tonumber(list.n) or 0
  end
  return count("v"), count("t"), count("q")
end

function shared.LearnedSay()
  local vendors, trainers, quests = shared.LearnedCount()
  print("|cff7fd4ffAzeroth Atlas|r: " .. vendors .. " vendors, " .. trainers .. " trainers and " .. quests .. " quests noted (what a vendor sells and for how much, what a trainer teaches and what it asks, where the game's map puts a quest) from the vendors and trainers you opened and the quests of your log. The 3D map reads them when you log out or /reload.")
end

local frame = CreateFrame("Frame", "AzerothAtlasLearned")
local QUEST = { QUEST_LOG_UPDATE = true, QUEST_POI_UPDATE = true, QUESTLINE_UPDATE = true, ZONE_CHANGED_NEW_AREA = true, PLAYER_ENTERING_WORLD = true }
local seller = nil   -- the vendor whose window is open
local function Heard(event)
  if event == "MERCHANT_SHOW" then
    seller = Npc()
    shared.Try("a vendor's goods", shared.LearnGoods)
  elseif event == "MERCHANT_UPDATE" then
    -- (its stock has changed: read again, if it is still the one whose window opened)
    if seller ~= nil and Npc() == seller then shared.Try("a vendor's goods", shared.LearnGoods) end
  elseif event == "MERCHANT_CLOSED" then
    seller = nil
  elseif event == "TRAINER_SHOW" then
    teaching.open, teaching.read, teaching.tries, teaching.who = true, false, 0, Npc()
    TeachSoon()
  elseif event == "TRAINER_UPDATE" then
    TeachSoon()
  elseif event == "TRAINER_CLOSED" then
    teaching.open = false
  elseif QUEST[event] and not looking then
    looking = true
    Later(WAIT, Look)
  end
end
frame:SetScript("OnEvent", function(_, event) shared.Try("what the game shows", Heard, event) end)
-- (registered one at a time: a name this game does not have must not stop the rest)
for _, event in ipairs({ "MERCHANT_SHOW", "MERCHANT_UPDATE", "MERCHANT_CLOSED", "TRAINER_SHOW", "TRAINER_UPDATE", "TRAINER_CLOSED",
  "QUEST_LOG_UPDATE", "QUEST_POI_UPDATE", "QUESTLINE_UPDATE", "ZONE_CHANGED_NEW_AREA", "PLAYER_ENTERING_WORLD" }) do pcall(frame.RegisterEvent, frame, event) end
