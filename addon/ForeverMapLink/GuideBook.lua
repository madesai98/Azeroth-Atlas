-- Forever Map Link: the guides.
--
-- A leveling guide written for the Guidelime addon is plain text: one line is one step, and
-- codes in square brackets say what the step is - [QA123] accept a quest, [QT123] hand it in,
-- [G45.9,45.3 Wetlands] go there, [F Ironforge] fly, [XP30] reach a level. Guide packs hand their
-- guides over with Guidelime.registerGuide(text, group).
--
-- This file is the shelf those guides stand on and the reader of that text, so the same guides
-- run here when Guidelime itself is not loaded:
--   the shelf      Guidelime.registerGuide, under the same name, taking the same text;
--   the reader     every code Guidelime knows, read the way Guidelime reads it (a line is numbered
--                  and kept as Guidelime numbers and keeps it, so that what you have ticked off is
--                  the same list in both addons);
--   what is ticked kept in Guidelime's shape with this addon's own saved settings; while Guidelime
--                  runs the guides, what it has ticked is copied here, to go on from;
--   the quests     their names, who gives and takes them and where, from the QuestieDB addon.
--
-- A guide pack names Guidelime as the addon it needs, and the game loads no addon whose needed
-- addon is missing or switched off. The 3D map's page changes that line of a pack ("Convert guide
-- packs", server/addon.js): the pack then needs this addon, and loads after Guidelime if that is on.
--
-- GuideSteps.lua follows a guide through the game; GuideWindow.lua shows it.
-- While Guidelime is switched on this stays out of its way: it runs the guides then.

local shared = ForeverMapLink
if type(shared) ~= "table" then return end

local floor = math.floor
local lower, upper, gsub, match, find, sub = string.lower, string.upper, string.gsub, string.match, string.find, string.sub

local book = { guides = {}, names = {}, count = 0, foreign = false }
shared.Book = book

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
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
book.plain, book.text, book.yes = plain, text, yes

-- A name with nothing but its letters and digits, in small letters: "Two-Handed Maces" and
-- "TwoHanded Maces" are one.
local function Key(s) return (gsub(lower(s), "[^%w]", "")) end
book.Key = Key

-- ---- you ------------------------------------------------------------------------------------------
-- (asked again each time: your level changes, and so can the rest after a loading screen)
local RACES = { human = "Human", nightelf = "NightElf", dwarf = "Dwarf", gnome = "Gnome", orc = "Orc", troll = "Troll", tauren = "Tauren",
  undead = "Scourge", scourge = "Scourge", draenei = "Draenei", bloodelf = "BloodElf", worgen = "Worgen", goblin = "Goblin", pandaren = "Pandaren", skyborne = "Skyborne" }
local CLASSES = { warrior = "WARRIOR", rogue = "ROGUE", mage = "MAGE", warlock = "WARLOCK", hunter = "HUNTER", priest = "PRIEST", druid = "DRUID",
  paladin = "PALADIN", shaman = "SHAMAN", deathknight = "DEATHKNIGHT", monk = "MONK" }
local FLAVORS = { classic = "CLASSIC", classicera = "CLASSIC", vanilla = "CLASSIC", tbc = "TBC", wotlk = "WOTLK", wrath = "WOTLK", cata = "CATA",
  cataclysm = "CATA", mop = "MOP", mists = "MOP", forever = "FOREVER" }
-- (the towns and peoples a guide can ask your standing with, by the number the game knows them under)
local STANDINGS = { bootybay = 21, ironforge = 47, gnomeregan = 54, thoriumbrotherhood = 59, undercity = 68, darnassus = 69, syndicate = 70,
  stormwind = 72, orgrimmar = 76, thunderbluff = 81, bloodsailbuccaneers = 87, gelkisclancentaur = 92, magramclancentaur = 93, zandalartribe = 270,
  ravenholdt = 349, gadgetzan = 369, ratchet = 470, wildhammerclan = 471, leagueofarathor = 509, defilers = 510, argentdawn = 529,
  darkspeartrolls = 530, timbermawhold = 576, everlook = 577, wintersabertrainers = 589, cenarioncircle = 609, frostwolfclan = 729,
  stormpikeguard = 730, hydraxianwaterlords = 749, shendralar = 809, warsongoutriders = 889, silverwingsentinels = 890, darkmoonfaire = 909,
  broodofnozdormu = 910 }

-- (the skills a guide can name; any other word in an [A ...] is passed over)
local SKILLS = {}
for _, name in ipairs({ "alchemy", "blacksmithing", "cooking", "enchanting", "engineering", "firstaid", "fishing", "herbalism", "leatherworking",
  "mining", "skinning", "tailoring", "riding", "lockpicking", "poisons", "jewelcrafting", "inscription", "axes", "bows", "crossbows", "daggers",
  "guns", "maces", "polearms", "staves", "swords", "thrown", "wands", "fistweapons", "unarmed", "twohandedaxes", "twohandedmaces",
  "twohandedswords", "defense" }) do SKILLS[name] = true end

local me = { at = -1 }
local function Me()
  local now = GetTime and GetTime() or 0
  if me.at == now then return me end
  me.at = now
  local _, class, classId = UnitClass("player")
  local _, race, raceId = UnitRace("player")
  me.class, me.classId = text(class) and upper(class) or "", plain(classId)
  me.race, me.raceId = text(race) or "", plain(raceId)
  me.faction = text(UnitFactionGroup("player")) or ""
  me.level = plain(UnitLevel("player")) or 0
  me.xp = plain(UnitXP and UnitXP("player")) or 0
  me.xpMax = plain(UnitXPMax and UnitXPMax("player")) or 0
  local build = GetBuildInfo and plain(select(4, GetBuildInfo())) or 16001
  me.flavor = build < 16000 and "CLASSIC" or build < 20000 and "FOREVER" or build < 30000 and "TBC" or build < 40000 and "WOTLK" or build < 50000 and "CATA" or "MOP"
  me.hardcore = false
  if C_GameRules and C_GameRules.IsHardcoreActive then me.hardcore = yes(C_GameRules.IsHardcoreActive()) end
  return me
end
book.Me = Me

local function Has(list, value)
  for i = 1, #list do
    if list[i] == value then return true end
  end
  return false
end

-- Is this guide, or this step, for a character like yours? (cond: what its [GA ...] or [A ...] asks)
local function Fits(cond)
  if not cond then return true end
  local m = Me()
  if cond.classes and not Has(cond.classes, m.class) then return false end
  if cond.races and not Has(cond.races, m.race) then return false end
  if cond.faction and cond.faction ~= m.faction then return false end
  if cond.flavors and not Has(cond.flavors, m.flavor) then return false end
  if cond.hardcore ~= nil and cond.hardcore ~= m.hardcore then return false end
  return true
end
book.Fits = Fits

-- ---- what you have, know and are thought of ----------------------------------------------------
local function ItemCount(id)
  local count
  if C_Item and C_Item.GetItemCount then count = C_Item.GetItemCount(id) elseif GetItemCount then count = GetItemCount(id) end
  return plain(count) or 0
end
book.ItemCount = ItemCount

-- Your standing with a people, as the game counts it (0 is the start of Neutral, 3000 of Friendly).
local function Standing(id)
  if C_Reputation and C_Reputation.GetFactionDataByID then
    local data = C_Reputation.GetFactionDataByID(id)
    if type(data) == "table" then return plain(data.currentStanding) end
    return nil
  end
  if GetFactionInfoByID then
    local _, _, _, _, _, value = GetFactionInfoByID(id)
    return plain(value)
  end
  return nil
end

-- A skill of yours by its English name: how far you are in it, and how far you can get as trained.
local function Skill(key)
  if not (GetNumSkillLines and GetSkillLineInfo) then return nil end
  local count = plain(GetNumSkillLines()) or 0
  for i = 1, count do
    local name, header, _, rank, _, _, max = GetSkillLineInfo(i)
    name = text(name)
    if name and not yes(header) and Key(name) == key then return plain(rank) or 0, plain(max) or 0 end
  end
  return nil
end
book.Skill = Skill

local function Knows(spell)
  if IsPlayerSpell and yes(IsPlayerSpell(spell)) then return true end
  if IsSpellKnown and yes(IsSpellKnown(spell)) then return true end
  return false
end
book.Knows = Knows

-- What a step asks of you before it can be done (it waits, greyed, until then).
local function Meets(cond)
  if not cond then return true end
  if cond.rep then
    local value = Standing(cond.rep)
    if value then
      if cond.repMin and value < cond.repMin then return false end
      if cond.repMax and value >= cond.repMax then return false end
    end
  end
  if cond.skill then
    local rank = Skill(cond.skill) or 0
    if cond.skillMin and rank < cond.skillMin then return false end
    if cond.skillMax and rank >= cond.skillMax then return false end
  end
  if cond.spell then
    local known = Knows(cond.spell)
    if cond.spellNot then
      if known then return false end
    elseif not known then
      return false
    end
  end
  if cond.item then
    local count = ItemCount(cond.item)
    if cond.itemMin and not (count > cond.itemMin) then return false end
    if cond.itemMax and not (count < cond.itemMax) then return false end
  end
  return true
end
book.Meets = Meets

-- "Alliance,Hunter" or "Warlock" or "IT5956<1" or "Stormwind>3000": who a guide or a step is
-- for, and what it asks. Words nobody knows are passed over rather than turning the guide away.
local function Conditions(tag, into)
  local c = into or {}
  for word in string.gmatch(tag, "[^,]+") do
    local name, v1, less, v2 = match(gsub(word, "%s", ""), "^([^%d%-<>]+)(%d*)([<>]?)(%-?%d*)$")
    if name then
      local key = Key(name)
      local value = tonumber(v1 ~= "" and v1 or v2)
      if CLASSES[key] then
        c.classes = c.classes or {}
        c.classes[#c.classes + 1] = CLASSES[key]
      elseif RACES[key] then
        c.races = c.races or {}
        c.races[#c.races + 1] = RACES[key]
      elseif key == "alliance" or key == "horde" then
        c.faction = key == "alliance" and "Alliance" or "Horde"
      elseif FLAVORS[key] then
        c.flavors = c.flavors or {}
        c.flavors[#c.flavors + 1] = FLAVORS[key]
      elseif key == "hardcore" or key == "softcore" then
        c.hardcore = key == "hardcore"
      elseif key == "sp" and v1 ~= "" then
        c.spell, c.spellNot = tonumber(v1), less == "<"
      elseif key == "it" and v1 ~= "" then
        c.item = tonumber(v1)
        -- (more than, fewer than: not "at least")
        if less == "<" then c.itemMax = tonumber(v2) or 1 elseif less == ">" then c.itemMin = tonumber(v2) or 0 else c.itemMin = 0 end
      elseif STANDINGS[gsub(key, "^the", "")] then
        c.rep = STANDINGS[gsub(key, "^the", "")]
        if less == "<" then c.repMax = value else c.repMin = value or 3000 end
      elseif SKILLS[key] then
        c.skill = key
        if less == "<" then c.skillMax = value else c.skillMin = value or 1 end
      end
    end
  end
  return c
end

-- ---- the zones ------------------------------------------------------------------------------------
-- A guide names a zone in English ("Wetlands", "The Barrens", "Stormwind City") and the game
-- knows it by a number. The ones every guide uses are listed; any other is asked of the game.
local ZONES = {
  [1411] = "Durotar", [1412] = "Mulgore", [1413] = "The Barrens", [1416] = "Alterac Mountains", [1417] = "Arathi Highlands", [1418] = "Badlands",
  [1419] = "Blasted Lands", [1420] = "Tirisfal Glades", [1421] = "Silverpine Forest", [1422] = "Western Plaguelands", [1423] = "Eastern Plaguelands",
  [1424] = "Hillsbrad Foothills", [1425] = "The Hinterlands", [1426] = "Dun Morogh", [1427] = "Searing Gorge", [1428] = "Burning Steppes",
  [1429] = "Elwynn Forest", [1430] = "Deadwind Pass", [1431] = "Duskwood", [1432] = "Loch Modan", [1433] = "Redridge Mountains",
  [1434] = "Stranglethorn Vale", [1435] = "Swamp of Sorrows", [1436] = "Westfall", [1437] = "Wetlands", [1438] = "Teldrassil", [1439] = "Darkshore",
  [1440] = "Ashenvale", [1441] = "Thousand Needles", [1442] = "Stonetalon Mountains", [1443] = "Desolace", [1444] = "Feralas",
  [1445] = "Dustwallow Marsh", [1446] = "Tanaris", [1447] = "Azshara", [1448] = "Felwood", [1449] = "Un'Goro Crater", [1450] = "Moonglade",
  [1451] = "Silithus", [1452] = "Winterspring", [1453] = "Stormwind City", [1454] = "Orgrimmar", [1455] = "Ironforge", [1456] = "Thunder Bluff",
  [1457] = "Darnassus", [1458] = "Undercity", [1459] = "Alterac Valley", [1460] = "Warsong Gulch", [1461] = "Arathi Basin",
  [2482] = "Mount Hyjal", [2521] = "Zephras Isle", [2524] = "Darkspear Islands", [2548] = "Riverglades", [2652] = "Shen'dralas",
}
local function ZoneKey(name)
  return (gsub(Key(name), "^the", ""))
end
local zoneIds, asked = {}, false
for id, name in pairs(ZONES) do zoneIds[ZoneKey(name)] = id end

local function Zone(name)
  local key = ZoneKey(name)
  if key == "" then return nil end
  local id = zoneIds[key]
  if id or asked then return id end
  -- not one of those: every zone map the game has, once
  asked = true
  if C_Map and C_Map.GetMapInfo then
    for uiMap = 1, 3000 do
      local info = C_Map.GetMapInfo(uiMap)
      local n = type(info) == "table" and plain(info.mapType) == 3 and text(info.name)
      if n and zoneIds[ZoneKey(n)] == nil then zoneIds[ZoneKey(n)] = uiMap end
    end
  end
  return zoneIds[key]
end
book.Zone = Zone
function book.ZoneName(id) return ZONES[id] end

-- A spot on a zone's map (0-100 across and down) as a place in the world: map, north, west.
local function World(uiMap, x, y)
  if not (C_Map and C_Map.GetWorldPosFromMapPos and CreateVector2D) then return nil end
  local map, pos = C_Map.GetWorldPosFromMapPos(uiMap, CreateVector2D(x / 100, y / 100))
  map = plain(map)
  if not (map and pos) then return nil end
  local north, west = pos:GetXY()
  north, west = plain(north), plain(west)
  if not (north and west) then return nil end
  return map, north, west
end
book.World = World

-- ---- reading a guide --------------------------------------------------------------------------------
-- The codes, longest first where one begins another ("NX" before "N", "TAR" before "T").
local CODES = {}
for _, code in ipairs({ "N", "NX", "LI", "D", "DL", "GA", "A", "O", "OC", "C", "Q", "QA", "QC", "QT", "QS", "QP", "QW", "G", "L", "XP", "H", "F", "T",
  "S", "P", "V", "R", "GG", "GL", "CI", "REP", "UI", "GI", "GT", "TAR", "SP", "LE", "SK" }) do CODES[code] = true end

-- What stands in a pair of brackets: its code, and the rest with the blanks before it gone.
local function Code(inner)
  for n = 3, 1, -1 do
    local code = sub(inner, 1, n)
    if #code == n and CODES[code] then return code, (gsub(sub(inner, n + 1), "^%s*", "")) end
  end
  return nil
end

-- "30-31 Wetlands" (or "30-31Wetlands", or just "Wetlands"): a level range and a name, as one
-- name the way Guidelime writes it ("30-31 Wetlands").
local function Ranged(tag)
  local a, b, title = match(tag, "^%s*(%d*%.?%d*)%s*%-?%s*(%d*%.?%d*)%s*(.*)$")
  local min, max = tonumber(a), tonumber(b)
  local name = title or ""
  if min or max then name = (min or "") .. "-" .. (max or "") .. " " .. name end
  return name, min, max, title or ""
end

-- The lines of a guide, numbered and kept exactly as Guidelime numbers and keeps them: a line
-- ending in two backslashes runs on into the next, empty lines count but are no steps, and
-- everything from "--" on is a remark.
local function Lines(source)
  local out, n = {}, 1
  local rest = gsub(gsub(source, "\\\\[\n\r]", "\\\\"), "([^\n\r]-)[\n\r]", function(line)
    if line ~= "" then out[#out + 1] = { raw = line, line = n } end
    n = n + 1
    return ""
  end)
  if rest ~= "" then
    out[#out + 1] = { raw = rest, line = n }
    n = n + 1
  end
  for i = 1, #out do
    out[i].text = gsub(gsub(out[i].raw, "\\\\", " \n"), "%-%-.*", "")
    out[i].raw = nil
  end
  return out, n
end

-- What a guide says of itself: its name, the levels it is for, who it is for, what comes after.
local function Header(g)
  local lines, count = Lines(g.source)
  g.lines, g.lineCount, g.source = lines, count, nil
  g.next = {}
  for i = 1, #lines do
    for inner in string.gmatch(lines[i].text, "%[(.-)%]") do
      local code, tag = Code(inner)
      if code == "N" then
        local _, min, max, title = Ranged(tag)
        g.min, g.max, g.title = min, max, title
      elseif code == "NX" then
        g.next[#g.next + 1] = (Ranged(tag))
      elseif code == "GA" then
        g.cond = Conditions(tag, g.cond)
      elseif code == "D" then
        g.details = tag
      end
    end
  end
  local name = g.title or ""
  if g.min or g.max then name = (g.min or "") .. "-" .. (g.max or "") .. " " .. name end
  if g.group then name = g.group .. " " .. name end
  g.name = name
end

-- One piece of a step: plain words, or what a code says.
local function Words(els, s)
  if s == "" then return end
  -- (*these words* stand out; ** is a star)
  local shown = gsub(gsub(s, "%*([^\n\r%*]-)%*", function(w) return w == "" and "\1" or "|cffffd100" .. w .. "|r" end), "\1", "*")
  els[#els + 1] = { t = "TEXT", text = shown, blank = match(s, "^%s*$") ~= nil }
end
local function Shown(tag)
  if tag == "" or tag == "-" then return nil end
  return tag
end

local QuestZone -- (below, with the quests)

-- Reads one line into its pieces. g.zone is the zone the guide last named, or the zone of the
-- quest it last spoke of: a spot with no zone of its own is in that one.
local function Step(g, step)
  local els = {}
  step.els = els
  local s = step.text
  local at = 1
  local lastDo, optionalDo, plainDo = nil, 0, 0 -- the last thing to do that a following [O] would make optional
  while true do
    local a, b, inner = find(s, "%[(.-)%]", at)
    if not a then break end
    Words(els, sub(s, at, a - 1))
    at = b + 1
    local code, tag = Code(inner)
    if not code then
      Words(els, "[" .. inner .. "]")
    elseif code == "N" or code == "NX" or code == "D" or code == "DL" or code == "GA" then
      -- (said of the whole guide: read by Header)
    elseif code == "GG" or code == "GL" or code == "GI" or code == "GT" then
      local on = Key(tag) ~= "off"
      if code == "GG" then g.autoGoto = on elseif code == "GT" then g.autoTarget = on elseif code == "GI" then g.autoItem = on end
    elseif code == "A" then
      step.cond = Conditions(tag, step.cond)
      els[#els + 1] = { t = "A" }
    elseif code == "O" or code == "OC" or code == "C" then
      if code ~= "O" then step.withNext = true end
      if code == "OC" then
        step.optional = true
      elseif code == "O" then
        if lastDo and not lastDo.optional then
          lastDo.optional = true
          optionalDo = optionalDo + 1
        elseif not lastDo then
          step.optional = true
        end
      end
      if Shown(tag) then Words(els, tag) end
    elseif code == "Q" or code == "QA" or code == "QC" or code == "QT" or code == "QS" or code == "QP" or code == "QW" then
      local id, objective, title = match(tag, "^(%d+),?(%d*)%s*(.-)%s*$")
      if id then
        local e = { t = code, quest = tonumber(id), objective = tonumber(objective) }
        if code == "QP" then e.t = "QA" elseif code == "Q" then e.t = "QC" elseif code == "QW" then e.t = "QC"; step.optional = true end
        if title == "-" then e.title = "" elseif title ~= "" then e.title = title end
        els[#els + 1] = e
        g.zone = QuestZone(e.quest) or g.zone
        if e.t ~= "QS" then
          lastDo = e
          plainDo = plainDo + 1
        end
      else
        Words(els, "[" .. inner .. "]")
      end
    elseif code == "G" or code == "L" then
      local x, y, radius, zone = match(tag, "^(%d+%.?%d*)%s?,%s?(%d+%.?%d*)%s?,?%s?(%d*%.?%d*)%s?(.*)$")
      if x then
        if code == "L" and radius ~= "" then radius = "" end
        if zone ~= "" then g.zone = Zone(zone) or g.zone end
        local e = { t = code, x = tonumber(x), y = tonumber(y), radius = tonumber(radius), uiMap = g.zone, typed = true }
        if not e.radius or e.radius == 0 then e.radius = 6 end
        els[#els + 1] = e
      else
        Words(els, "[" .. inner .. "]")
      end
    elseif code == "XP" then
      local level, how, amount, words = match(tag, "^(%d+)([%+%-%.]?)(%d*)%s*(.*)$")
      if level then
        local e = { t = "XP", level = tonumber(level), text = Shown(words) }
        if how == "+" then e.xp = tonumber(amount)
        elseif how == "-" then e.left, e.level = tonumber(amount), e.level - 1
        elseif how == "." then e.part = tonumber("0." .. amount) end
        if not e.text then e.label = "level " .. level .. how .. amount end
        els[#els + 1] = e
        lastDo = e
        plainDo = plainDo + 1
      else
        Words(els, "[" .. inner .. "]")
      end
    elseif code == "REP" then
      local name, less, value, words = match(tag, "^([^%d%-<>]+)%s*([<>]?)%s*(%-?%d*)%s*(.*)$")
      local id = name and STANDINGS[gsub(Key(name), "^the", "")]
      if id then
        local e = { t = "REP", rep = id, text = Shown(words) or (match(name, "^%s*(.-)%s*$")) }
        if less == "<" then e.repMax = tonumber(value) else e.repMin = tonumber(value) or 3000 end
        els[#els + 1] = e
        lastDo = e
        plainDo = plainDo + 1
      elseif Shown(tag) then
        Words(els, tag)
      end
    elseif code == "LE" or code == "SK" then
      -- [LE SP27683 1] a spell by its number; [LE Fishing 150-] a skill trained to that; [SK Fishing 50] a skill worked up to that
      local spell, rank, words = match(tag, "^[Ss][Pp]%s*(%d+)%s*(%d*)%s*(.*)$")
      if code == "LE" and spell then
        els[#els + 1] = { t = "LE", spell = tonumber(spell), text = Shown(words) }
      else
        local name, value, words2 = match(tag, "^([^,%d%-]+)%s*(%d*)%s*(.*)$")
        if name and Key(name) ~= "" then
          local label = match(name, "^%s*(.-)%s*$")
          local e = { t = code, skill = Key(name), text = Shown(words2) or label, label = label }
          if code == "LE" and e.skill ~= "riding" then e.trained = tonumber(value) or 1 else e.rank = tonumber(value) or 1 end
          els[#els + 1] = e
        else
          Words(els, "[" .. inner .. "]")
        end
      end
      if els[#els] and (els[#els].t == "LE" or els[#els].t == "SK") then
        lastDo = els[#els]
        plainDo = plainDo + 1
      end
    elseif code == "CI" then
      local id, count, title = match(tag, "^(%d+),?(%d*)%s*(.-)%s*$")
      if id then
        local e = { t = "CI", item = tonumber(id), count = tonumber(count) or 1 }
        if title == "-" then e.title = "" elseif title ~= "" then e.title = title end
        els[#els + 1] = e
        lastDo = e
        plainDo = plainDo + 1
      end
    elseif code == "UI" then
      local id, npc, title = match(tag, "^(%d+)%s*,?%s*(%d*)%s*(.-)%s*$")
      if id then
        local e = { t = "UI", item = tonumber(id), npc = tonumber(npc), typed = true }
        if title == "-" then e.title = "" elseif title ~= "" then e.title = title end
        els[#els + 1] = e
      end
    elseif code == "TAR" then
      local id, title = match(tag, "^(%d+)%s*(.-)%s*$")
      if id then
        local e = { t = "TAR", npc = tonumber(id), typed = true }
        if title == "-" then e.title = "" elseif title ~= "" then e.title = title end
        els[#els + 1] = e
      end
    elseif code == "SP" then
      local id, npc, title = match(tag, "^(%d+)%s*,?%s*(%d*)%s*(.-)%s*$")
      if id then
        local e = { t = "SP", spell = tonumber(id), npc = tonumber(npc) }
        if title == "-" then e.title = "" elseif title ~= "" then e.title = title end
        els[#els + 1] = e
      elseif Shown(tag) then
        Words(els, tag)
      end
    elseif code == "LI" then
      local name = Ranged(tag)
      els[#els + 1] = { t = "LI", guide = name, text = name }
    else
      -- H hearth, F fly, T train, S set your hearthstone, P take a flight point, V vendor, R repair
      els[#els + 1] = { t = code, text = Shown(tag), place = Shown(tag) }
    end
  end
  Words(els, sub(s, at))
  -- (every thing to do in the line marked optional: the line is)
  if plainDo > 0 and optionalDo == plainDo then step.optional = true end
end

-- Reads the whole guide (once): every line into its pieces.
local function Read(g)
  if g.read then return g end
  g.read = true
  g.zone, g.autoGoto, g.autoTarget, g.autoItem = nil, true, true, true
  g.quests = {}
  for i = 1, #g.lines do
    local step = g.lines[i]
    local ok = pcall(Step, g, step)
    if not ok then
      -- (a line that cannot be read is shown as it is written)
      step.els = { { t = "TEXT", text = step.text } }
      book.unread = (book.unread or 0) + 1
    end
    -- (as things stood at this line: a later [GG OFF] does not reach back)
    step.autoGoto = g.autoGoto
    for _, e in ipairs(step.els) do
      if e.quest then g.quests[e.quest] = true end
    end
  end
  return g
end
book.Read = Read

-- ---- the shelf ----------------------------------------------------------------------------------
-- What a guide pack calls for each of its guides: the text, and the name of the pack. The text may
-- also come as a table holding it (Guidelime takes both).
local function Register(guide, group)
  local source = type(guide) == "table" and guide.text or guide
  if type(source) ~= "string" then return nil end
  local g = { source = source }
  if type(group) == "string" and group ~= "" then
    g.group = sub(group, 1, 10) == "Guidelime_" and sub(group, 11) or group
  end
  local ok = pcall(Header, g)
  if not ok or not g.title or g.title == "" then return nil end
  if not book.guides[g.name] then
    book.count = book.count + 1
    book.names[#book.names + 1] = g.name
  end
  book.guides[g.name] = g
  book.changed = true
  return g
end
book.Register = Register

-- Guidelime's own name for it: guide packs call Guidelime.registerGuide. It is taken here unless
-- Guidelime itself has loaded already. Should Guidelime load after this, it sets up its own
-- table under that name, and the guide packs load after it (a converted pack still names it as
-- an addon to load after): every guide then goes to Guidelime, and this table is never called.
if not (type(Guidelime) == "table" and type(Guidelime.registerGuide) == "function") then
  local api = type(Guidelime) == "table" and Guidelime or {}
  api.registerGuide = Register
  api.ForeverMapLink = true
  Guidelime = api
  book.api = api
end

-- Is Guidelime itself here (then the guides are its to run)? Known for sure once everything has loaded.
function book.Foreign()
  book.foreign = not book.api or Guidelime ~= book.api or type(Guidelime.registerGuide) ~= "function" or Guidelime.registerGuide ~= Register
  return book.foreign
end

-- Guide packs that are installed and switched on, but which the game did not load: they name
-- Guidelime as the addon they need, and Guidelime is not installed or is switched off. (The 3D
-- map's page changes that one line of theirs: "Convert guide packs".)
function book.Waiting()
  local a = C_AddOns
  local out = {}
  if not (a and a.GetNumAddOns and a.GetAddOnInfo and a.GetAddOnDependencies and a.IsAddOnLoaded) then return out end
  local who = UnitGUID and UnitGUID("player") or nil
  for i = 1, tonumber(a.GetNumAddOns()) or 0 do
    local needs = false
    for _, dep in ipairs({ a.GetAddOnDependencies(i) }) do
      if type(dep) == "string" and lower(dep) == "guidelime" then needs = true end
    end
    if needs and not a.IsAddOnLoaded(i) then
      -- (one you switched off yourself is not waiting for anything)
      local on = true
      if a.GetAddOnEnableState then
        local ok, state = pcall(a.GetAddOnEnableState, i, who)
        if ok and type(state) == "number" then on = state > 0 end
      end
      if on then out[#out + 1] = text((a.GetAddOnInfo(i))) or "?" end
    end
  end
  return out
end

-- The guide that follows `name` in its pack: the first of those it names that is on the shelf and for you.
function book.Next(g)
  local out = {}
  for _, name in ipairs(g.next or {}) do
    local full = (g.group and (g.group .. " ") or "") .. name
    local other = book.guides[full]
    if other and Fits(other.cond) and Meets(other.cond) then out[#out + 1] = full end
  end
  return out
end

-- Every quest a guide and the guides after it speak of (for "accept the guide's quests for me").
function book.QuestsFrom(g)
  local seen, quests, todo = {}, {}, { g }
  while #todo > 0 and #todo < 60 do
    local at = table.remove(todo)
    if at and not seen[at] then
      seen[at] = true
      for i = 1, #at.lines do
        for inner in string.gmatch(at.lines[i].text, "%[Q[ACTPW]?%s*(%d+)") do quests[tonumber(inner)] = true end
      end
      for _, name in ipairs(at.next or {}) do
        todo[#todo + 1] = book.guides[(at.group and (at.group .. " ") or "") .. name]
      end
    end
  end
  return quests
end

-- ---- what is ticked off -----------------------------------------------------------------------------
-- Kept with this addon's own saved settings, per character, in Guidelime's shape:
-- progress[guide name][line] = { stepText, skip, completed } and currentGuide.
function book.Store()
  if book.store then return book.store end
  if type(ForeverMapLinkCharDB) ~= "table" then ForeverMapLinkCharDB = {} end
  if type(ForeverMapLinkCharDB.guide) ~= "table" then ForeverMapLinkCharDB.guide = {} end
  local s = ForeverMapLinkCharDB.guide
  if type(s.progress) ~= "table" then s.progress = {} end
  book.store = s
  return s
end

-- While Guidelime runs the guides, the guide it has open and what it has ticked are copied here
-- (when you log in and when you leave), so that this addon goes on from there on the day
-- Guidelime is switched off. Guidelime's saved file can only be read while Guidelime is loaded.
function book.Mirror()
  local theirs = GuidelimeDataChar
  if type(theirs) ~= "table" then return false end
  local mine = book.Store()
  if type(theirs.currentGuide) == "string" then mine.currentGuide = theirs.currentGuide end
  if type(theirs.progress) == "table" then
    local copy = {}
    for name, lines in pairs(theirs.progress) do
      if type(lines) == "table" then
        local marks = {}
        for line, mark in pairs(lines) do
          if type(mark) == "table" then marks[line] = { stepText = mark.stepText, skip = mark.skip, completed = mark.completed } end
        end
        copy[name] = marks
      end
    end
    mine.progress = copy
  end
  return true
end

-- The marks of one guide, by line. A mark whose line now reads differently (the guide was edited)
-- goes to the line that reads as it did, or is dropped.
function book.Marks(g)
  local s = book.Store()
  local marks = s.progress[g.name]
  if type(marks) ~= "table" then
    marks = {}
    s.progress[g.name] = marks
    return marks
  end
  local byLine, stale = {}, nil
  for i = 1, #g.lines do byLine[g.lines[i].line] = g.lines[i].text end
  for line, mark in pairs(marks) do
    if type(mark) ~= "table" or (mark.stepText ~= nil and mark.stepText ~= byLine[line]) then stale = true break end
  end
  if stale then
    local kept = {}
    for _, mark in pairs(marks) do
      if type(mark) == "table" then
        for i = 1, #g.lines do
          if g.lines[i].text == mark.stepText then kept[g.lines[i].line] = mark end
        end
      end
    end
    marks = kept
    s.progress[g.name] = marks
  end
  return marks
end

-- ---- the quests ---------------------------------------------------------------------------------------
-- Names, givers, takers and what is asked for come from the QuestieDB addon (LibQuestieDB), the
-- same data the 3D map is built from. Without it a quest still has the name the game or the guide
-- gives it; only the way to a step that names no spot is missing.
local Quest = { names = {} }
book.Quest = Quest

local function Data()
  local db = LibQuestieDB
  if type(db) == "table" and type(db.Quest) == "table" and type(db.Npc) == "table" then return db end
  return nil
end
local function Ask(entity, field, id)
  local f = entity and entity[field]
  if type(f) ~= "function" then return nil end
  local ok, value = pcall(f, id)
  if ok then return value end
  return nil
end

function Quest.Name(id)
  local name = Quest.names[id]
  if name then return name end
  if C_QuestLog and C_QuestLog.GetTitleForQuestID then name = text(C_QuestLog.GetTitleForQuestID(id)) end
  if not name or name == "" then
    local db = Data()
    name = db and text(Ask(db.Quest, "name", id))
  end
  if name and name ~= "" then
    Quest.names[id] = name
    return name
  end
  return nil
end

function Quest.Done(id)
  if C_QuestLog and C_QuestLog.IsQuestFlaggedCompleted then return yes(C_QuestLog.IsQuestFlaggedCompleted(id)) end
  if IsQuestFlaggedCompleted then return yes(IsQuestFlaggedCompleted(id)) end
  return false
end

-- Your quest log: [id] = { index, ready (to hand in), failed, goals = { { text, done } } }.
function Quest.Log()
  local log = {}
  if not (C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo) then
    if not (GetNumQuestLogEntries and GetQuestLogTitle) then return log end
    for i = 1, plain(GetNumQuestLogEntries()) or 0 do
      local name, _, _, header, _, complete, _, id = GetQuestLogTitle(i)
      id = plain(id)
      if id and id > 0 and not yes(header) then
        local q = { index = i, ready = plain(complete) == 1, failed = plain(complete) == -1, goals = {}, name = text(name) }
        local count = GetNumQuestLeaderBoards and plain(GetNumQuestLeaderBoards(i)) or 0
        for k = 1, count do
          local words, _, done = GetQuestLogLeaderBoard(k, i)
          q.goals[k] = { text = text(words) or "", done = yes(done) }
        end
        if count == 0 then q.ready = true end
        log[id] = q
      end
    end
    return log
  end
  for i = 1, plain(C_QuestLog.GetNumQuestLogEntries()) or 0 do
    local info = C_QuestLog.GetInfo(i)
    local id = type(info) == "table" and not yes(info.isHeader) and plain(info.questID)
    if id and id > 0 then
      local q = { index = i, ready = C_QuestLog.IsComplete ~= nil and yes(C_QuestLog.IsComplete(id)), failed = C_QuestLog.IsFailed ~= nil and yes(C_QuestLog.IsFailed(id)), goals = {}, name = text(info.title) }
      local goals = C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(id)
      if type(goals) == "table" then
        for k = 1, #goals do
          local o = goals[k]
          if type(o) == "table" then q.goals[#q.goals + 1] = { text = text(o.text) or "", done = yes(o.finished) } end
        end
      end
      -- (nothing asked for: a quest that only wants handing in)
      if #q.goals == 0 and not q.failed then q.ready = true end
      if q.name then Quest.names[id] = q.name end
      log[id] = q
    end
  end
  return log
end

-- Is the quest one a character like yours can have at all? (nil: not known)
function Quest.ForYou(id)
  local db = Data()
  if not db or not bit then return nil end
  local m = Me()
  local races = plain(Ask(db.Quest, "requiredRaces", id))
  local mask = m.raceId and type(db.Enum) == "table" and type(db.Enum.raceMaskById) == "table" and plain(db.Enum.raceMaskById[m.raceId])
  if races and races ~= 0 and mask and bit.band(races, mask) == 0 then return false end
  local classes = plain(Ask(db.Quest, "requiredClasses", id))
  if classes and classes ~= 0 and m.classId and m.classId <= 24 and bit.band(classes, 2 ^ (m.classId - 1)) == 0 then return false end
  return true
end

-- The quests that must be done before this one can be had and are not: `done(id)` says which are
-- (handed in, or to be handed in by an earlier step).
function Quest.Missing(id, done)
  local db = Data()
  local out = {}
  if not db then return out end
  local all = Ask(db.Quest, "preQuestGroup", id)
  if type(all) == "table" then
    for _, pre in ipairs(all) do
      pre = plain(pre)
      if pre and pre > 0 and not done(pre) then out[#out + 1] = pre end
    end
  end
  local one = Ask(db.Quest, "preQuestSingle", id)
  if type(one) == "table" and #one > 0 then
    local any, first = false, nil
    for _, pre in ipairs(one) do
      pre = plain(pre)
      if pre and pre > 0 then
        first = first or pre
        if done(pre) then any = true end
      end
    end
    if not any and first then out[#out + 1] = first end
  end
  return out
end

function Quest.NpcName(id)
  local db = Data()
  return db and text(Ask(db.Npc, "name", id)) or nil
end

-- ---- where a step is, when it names no spot -----------------------------------------------------------
local areas = nil
-- QuestieDB gives a spot as a zone (by the game's area number) and 0-100 across and down its map.
local function AreaMap(area)
  if areas == nil then
    areas = false
    local db = Data()
    local zones = db and type(db.Support) == "table" and type(db.Support.Get) == "function" and db.Support.Get("ZoneDB")
    local kept = type(zones) == "table" and zones.private
    if type(kept) == "table" then
      local t = {}
      for _, name in ipairs({ "areaIdToUiMapId", "areaIdToUiMapIdOverride" }) do
        local part = kept[name]
        -- (kept as text to be read when wanted)
        if type(part) == "string" and loadstring then
          local f = loadstring(part)
          local ok, made = pcall(f or error)
          part = ok and made or nil
        end
        if type(part) == "table" then
          for k, v in pairs(part) do t[k] = v end
        end
      end
      areas = t
    end
  end
  return areas and plain(areas[area]) or nil
end

-- The zone a quest belongs to, where the quest database files it under one.
QuestZone = function(id)
  local db = Data()
  local area = db and plain(Ask(db.Quest, "zoneOrSort", id))
  if not area or area <= 0 then return nil end
  local uiMap = AreaMap(area)
  if uiMap and uiMap > 0 and ZONES[uiMap] then return uiMap end
  return nil
end

local MAX_SPOTS = 240
local function Gather(out, spawns)
  if type(spawns) ~= "table" then return end
  for area, points in pairs(spawns) do
    local uiMap = AreaMap(area)
    if uiMap and uiMap > 0 and type(points) == "table" then
      for _, p in ipairs(points) do
        if #out >= MAX_SPOTS then return end
        local x, y = type(p) == "table" and plain(p[1]), type(p) == "table" and plain(p[2])
        if x and y and x >= 0 and y >= 0 then
          local map, north, west = World(uiMap, x, y)
          if map then out[#out + 1] = { map, north, west } end
        end
      end
    end
  end
end
local function GatherAll(out, entity, ids, limit)
  if type(ids) ~= "table" then return end
  for i = 1, math.min(#ids, limit or 12) do
    local id = plain(ids[i])
    if id then Gather(out, Ask(entity, "spawns", id)) end
  end
end

-- Of many spots, the one to head for: the nearest (someone you talk to), or the middle of the
-- thickest patch of them (things to kill or pick up), nearest first among equals.
local function Choose(spots, thick, map, north, west)
  if #spots == 0 then return nil end
  local function far(s)
    if not map then return 0 end
    if s[1] ~= map then return 1e12 end
    return (s[2] - north) ^ 2 + (s[3] - west) ^ 2
  end
  local best, bestScore, bestFar = nil, -1, 0
  local stride = thick and math.max(1, floor(#spots / 80)) or 1
  for i = 1, #spots, stride do
    local s = spots[i]
    local score = 0
    if thick then
      for j = 1, #spots do
        local o = spots[j]
        if o[1] == s[1] and (o[2] - s[2]) ^ 2 + (o[3] - s[3]) ^ 2 <= 6400 then score = score + 1 end
      end
      -- (a patch on another continent than yours is not where you are sent while there is one here)
      if map and s[1] ~= map then score = score / 1000 end
    end
    local d = far(s)
    if score > bestScore or (score == bestScore and d < bestFar) then best, bestScore, bestFar = s, score, d end
  end
  if thick and bestScore > 1 then
    -- the spot of the patch nearest its middle (a place something stands, so a place you can stand)
    local n, sn, sw = 0, 0, 0
    for j = 1, #spots do
      local o = spots[j]
      if o[1] == best[1] and (o[2] - best[2]) ^ 2 + (o[3] - best[3]) ^ 2 <= 6400 then n, sn, sw = n + 1, sn + o[2], sw + o[3] end
    end
    sn, sw = sn / n, sw / n
    local near, nearD = best, 1e12
    for j = 1, #spots do
      local o = spots[j]
      local d = o[1] == best[1] and (o[2] - sn) ^ 2 + (o[3] - sw) ^ 2 or 1e12
      if d < nearD then near, nearD = o, d end
    end
    best = near
  end
  return best[1], best[2], best[3]
end

-- What a quest asks for, in the order its log lists it: creatures, objects, items.
local function Goals(db, id)
  local goals = {}
  local o = Ask(db.Quest, "objectives", id)
  if type(o) ~= "table" then return goals end
  for kind = 1, 3 do
    if type(o[kind]) == "table" then
      for _, row in ipairs(o[kind]) do
        local what = type(row) == "table" and plain(row[1])
        if what then goals[#goals + 1] = { kind = kind, ids = { what } } end
      end
    end
  end
  if type(o[5]) == "table" then
    for _, row in ipairs(o[5]) do
      if type(row) == "table" and type(row[1]) == "table" then goals[#goals + 1] = { kind = 1, ids = row[1] } end
    end
  end
  return goals
end

local function ItemSpots(db, out, item)
  if type(db.Item) ~= "table" then return end
  GatherAll(out, db.Npc, Ask(db.Item, "vendors", item), 6)
  if #out > 0 then return end
  GatherAll(out, db.Npc, Ask(db.Item, "npcDrops", item), 10)
  if type(db.Object) == "table" then GatherAll(out, db.Object, Ask(db.Item, "objectDrops", item), 10) end
end

-- Who the piece `e` of a step has you look for: the quest's giver or taker, or the creatures
-- it asks for (their numbers, a few at most).
function book.Npcs(e)
  local db = Data()
  local out = {}
  if not db or not e.quest then return out end
  if e.t == "QA" or e.t == "QT" then
    local who = Ask(db.Quest, e.t == "QA" and "startedBy" or "finishedBy", e.quest)
    if type(who) == "table" and type(who[1]) == "table" then
      for i = 1, math.min(2, #who[1]) do out[#out + 1] = plain(who[1][i]) end
    end
  elseif e.t == "QC" then
    for i, goal in ipairs(Goals(db, e.quest)) do
      if goal.kind == 1 and (e.objective == nil or e.objective == i) then
        for k = 1, math.min(2, #goal.ids) do
          if #out < 3 then out[#out + 1] = plain(goal.ids[k]) end
        end
      end
    end
  end
  return out
end

-- Where the piece `e` of a step is done, seen from where you are: map, north, west - or nil.
-- log: your quest log (what is already done of a quest is not gone to).
function book.Spot(e, log, map, north, west)
  local db = Data()
  if not db then return nil end
  local spots, thick = {}, false
  if e.t == "QA" or e.t == "QT" then
    local who = Ask(db.Quest, e.t == "QA" and "startedBy" or "finishedBy", e.quest)
    if type(who) == "table" then
      GatherAll(spots, db.Npc, who[1])
      if type(db.Object) == "table" then GatherAll(spots, db.Object, who[2]) end
    end
  elseif e.t == "QC" then
    thick = true
    local goals = Goals(db, e.quest)
    local inLog = log and log[e.quest]
    local only = e.objective and goals[e.objective] and e.objective or nil
    for i, goal in ipairs(goals) do
      local wanted = only == nil or only == i
      -- (only when the log lists them one for one can a goal be known to be done)
      if wanted and only == nil and inLog and #inLog.goals == #goals and inLog.goals[i].done then wanted = false end
      if wanted then
        if goal.kind == 1 then GatherAll(spots, db.Npc, goal.ids)
        elseif goal.kind == 2 and type(db.Object) == "table" then GatherAll(spots, db.Object, goal.ids)
        elseif goal.kind == 3 then ItemSpots(db, spots, goal.ids[1]) end
      end
    end
    if #spots == 0 then
      -- a place to find or a thing to do there
      local trigger = Ask(db.Quest, "triggerEnd", e.quest)
      if type(trigger) == "table" then Gather(spots, trigger[2]) end
    end
  elseif e.t == "TAR" then
    Gather(spots, Ask(db.Npc, "spawns", e.npc))
  elseif e.t == "CI" then
    thick = true
    ItemSpots(db, spots, e.item)
  end
  return Choose(spots, thick, map, north, west)
end
