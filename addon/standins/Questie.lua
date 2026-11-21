-- Azeroth Atlas, answering for Questie.
--
-- Some addons ask Questie for what it knows: a map addon for where the vendors and trainers
-- stand and which quests a dungeon has, a guide addon for what a quest is called. They do not
-- need Questie's own icons or its quest list for that, only its answers - and those all come
-- out of QuestieDB, the database Questie itself reads. Where there is no Questie, this hands
-- that database on under the names those addons ask by, so they need no Questie installed.
--
-- It is in the folder Questie itself would be in (put there by the box "Questie" on the map's
-- page), so that every addon that names Questie finds it: one that will not load without
-- Questie loads, and one that loads after Questie where it is there does so. It is not Questie
-- all the same: it draws nothing, tracks nothing, has no settings, and none of Questie's own
-- code is in it. There is no `Questie` here and no frame of Questie's name, so an addon that
-- looks for those (to leave something to Questie) goes on doing its own work. An addon that
-- asks the game whether an addon named Questie is loaded is told yes, though, and may leave its
-- quest icons to a Questie that draws none: the map's page says so beside the box.
--
-- With a real Questie this file is not in the game at all: the real one is in this folder then,
-- and answers for itself, out of the same QuestieDB.
--
-- What is answered (as the installed addons were seen to ask):
--
--   QuestieLoader:ImportModule(name)       a module by name; one nobody has made is an empty one
--   "QuestieDB"   QueryNPCSingle / QueryQuestSingle / QueryObjectSingle / QueryItemSingle (id, field)
--                 QueryNPC / QueryQuest / QueryObject / QueryItem (id, fields)
--                 NPCPointers, QuestPointers, ObjectPointers, ItemPointers      every id there is
--                 npcFlags, classKeys, factionIDs, factionTemplate
--                 GetQuest(id), :GetNPC(id), :GetObject(id), :GetItem(id), IsDoable(id)
--   "ZoneDB"      :GetUiMapIdByAreaId, :GetAreaIdByUiMapId, :GetAreaIdByName, :GetDungeons,
--                 :GetParentZoneId, .IsDungeonZone, :GetDungeonLocation, :GetLocalizedDungeonName
--   "Townsfolk"   .GetMailboxes(), .GetFactionSpecificMailboxes()
--
-- The data is QuestieDB's (the Questie team's and its contributors'), with what the Atlas
-- database knows beyond it laid over (AzerothAtlas_Facts does that, for Questie and for this).
local type, pairs, ipairs, tonumber, pcall, rawget = type, pairs, ipairs, tonumber, pcall, rawget

-- ---- is there anything to do? ------------------------------------------------------------------
-- (somebody has the name already: Questie itself, loaded first)
if rawget(_G, "QuestieLoader") ~= nil then return end
local lib = rawget(_G, "LibQuestieDB")
if type(lib) ~= "table" or type(lib.Npc) ~= "table" or type(lib.Quest) ~= "table" or type(lib.Object) ~= "table" or type(lib.Item) ~= "table"
  or type(lib.Npc.Get) ~= "function" or type(lib.Npc.GetAll) ~= "function" or type(lib.Npc.GetAllIds) ~= "function" then return end
-- (written against this layout of QuestieDB; one that no longer speaks it is left unanswered rather than answered wrongly)
local CONTRACT = 4
if type(lib.RequireContract) == "function" then
  local called, ok = pcall(lib.RequireContract, CONTRACT)
  if not called or not ok then return end
end

-- ---- the modules -------------------------------------------------------------------------------
local modules = {}
local Loader = { _modules = modules, AzerothAtlasStandIn = 1 }
function Loader:ImportModule(name)
  local m = modules[name]
  if not m then m = { private = {} }; modules[name] = m end
  return m
end
Loader.CreateModule = Loader.ImportModule
_G.QuestieLoader = Loader

local Quest, Npc, Object, Item = lib.Quest, lib.Npc, lib.Object, lib.Item
local support = function(name)
  local s = type(lib.Support) == "table" and type(lib.Support.Get) == "function" and lib.Support.Get(name)
  return type(s) == "table" and s or {}
end
local enum = type(lib.Enum) == "table" and lib.Enum or {}
-- Which of two sets of marks are in both. (Worked out here, and not by the game's own bit.band:
-- that one knows 32 marks, and QuestieDB's set of races has more.)
local function band(a, b)
  local r, p = 0, 1
  while a >= 1 and b >= 1 do
    local x, y = a % 2, b % 2
    if x >= 1 and y >= 1 then r = r + p end
    a, b, p = (a - x) / 2, (b - y) / 2, p * 2
  end
  return r
end

-- ---- "QuestieDB" -------------------------------------------------------------------------------
local DB = Loader:ImportModule("QuestieDB")
DB.QueryQuestSingle, DB.QueryNPCSingle, DB.QueryObjectSingle, DB.QueryItemSingle = Quest.Get, Npc.Get, Object.Get, Item.Get
DB.QueryQuest, DB.QueryNPC, DB.QueryObject, DB.QueryItem = Quest.GetAll, Npc.GetAll, Object.GetAll, Item.GetAll
DB.npcFlags, DB.classKeys, DB.factionIDs = enum.npcFlags or {}, enum.classKeys or {}, enum.factionIDs or {}
DB.factionTemplate = support("QuestieDB").factionTemplate or {}

-- Every id there is. Taken again once the character is in the world: what is laid over
-- QuestieDB by then (the Atlas database's own creatures and quests) is in it too.
local function Bind()
  local ok
  ok, DB.QuestPointers = pcall(Quest.GetAllIds, true); if not ok or type(DB.QuestPointers) ~= "table" then DB.QuestPointers = {} end
  ok, DB.NPCPointers = pcall(Npc.GetAllIds, true); if not ok or type(DB.NPCPointers) ~= "table" then DB.NPCPointers = {} end
  ok, DB.ObjectPointers = pcall(Object.GetAllIds, true); if not ok or type(DB.ObjectPointers) ~= "table" then DB.ObjectPointers = {} end
  ok, DB.ItemPointers = pcall(Item.GetAllIds, true); if not ok or type(DB.ItemPointers) ~= "table" then DB.ItemPointers = {} end
end
Bind()

-- One thing whole: every field QuestieDB has of it, under the field's own name.
local function Whole(entity, kind, id)
  if type(id) ~= "number" then return nil end
  local name = entity.Get(id, "name")
  if name == nil then return nil end
  local meta = type(lib.Meta) == "table" and lib.Meta[kind]
  local out = { id = id, Id = id, name = name }
  if type(meta) == "table" and type(meta.keys) == "table" then
    for field in pairs(meta.keys) do
      if out[field] == nil then out[field] = entity.Get(id, field) end
    end
  end
  return out
end

function DB:GetNPC(id)
  local n = Whole(Npc, "Npc", id)
  if n then n.type = "monster" end
  return n
end
function DB:GetObject(id)
  local o = Whole(Object, "Object", id)
  if o then o.type = "object" end
  return o
end
function DB:GetItem(id)
  return Whole(Item, "Item", id)
end

-- A quest whole, with what it asks for as one list: { Type = "monster" | "object" | "item" |
-- "reputation" | "killcredit" | "spell", Id, Text }, in that order (the game may list them in
-- another: where that matters, ask the game).
function DB.GetQuest(id)
  local q = Whole(Quest, "Quest", id)
  if not q then return nil end
  q.Level, q.level = q.questLevel, q.questLevel
  q.Zone = (type(q.zoneOrSort) == "number" and q.zoneOrSort > 0) and q.zoneOrSort or 0
  q.IsRepeatable = type(q.specialFlags) == "number" and q.specialFlags % 2 == 1 or false
  q.Description = q.objectivesText
  local s, f = q.startedBy or {}, q.finishedBy or {}
  q.Starts = { NPC = s[1], GameObject = s[2], Item = s[3] }
  q.Ends = { NPC = f[1], GameObject = f[2] }
  local list, o = {}, q.objectives
  if type(o) == "table" then
    for group, kind in ipairs({ "monster", "object", "item" }) do
      if type(o[group]) == "table" then
        for _, row in ipairs(o[group]) do
          if type(row) == "table" and type(row[1]) == "number" then list[#list + 1] = { Type = kind, Id = row[1], Text = row[2], Icon = row[3] } end
        end
      end
    end
    if type(o[4]) == "table" and type(o[4][1]) == "number" then list[#list + 1] = { Type = "reputation", Id = o[4][1], RequiredRepValue = o[4][2] } end
    if type(o[5]) == "table" then
      for _, row in ipairs(o[5]) do
        if type(row) == "table" and type(row[1]) == "table" then list[#list + 1] = { Type = "killcredit", IdList = row[1], RootId = row[2], Text = row[3], Icon = row[4] } end
      end
    end
    if type(o[6]) == "table" then
      for _, row in ipairs(o[6]) do
        if type(row) == "table" and type(row[1]) == "number" then list[#list + 1] = { Type = "spell", Id = row[1], Text = row[2], ItemSourceId = row[3] } end
      end
    end
  end
  q.ObjectiveData = list
  return q
end

local function Done(id)
  if C_QuestLog and C_QuestLog.IsQuestFlaggedCompleted then return C_QuestLog.IsQuestFlaggedCompleted(id) and true or false end
  local f = rawget(_G, "IsQuestFlaggedCompleted")
  return type(f) == "function" and f(id) and true or false
end
local function InLog(id)
  if C_QuestLog and C_QuestLog.IsOnQuest then return C_QuestLog.IsOnQuest(id) and true or false end
  if C_QuestLog and C_QuestLog.GetLogIndexForQuestID then return C_QuestLog.GetLogIndexForQuestID(id) ~= nil end
  return false
end

-- Can this character be given the quest now? By what QuestieDB says of it and the game says of
-- the character: not done yet, old enough, of a race and class it is for, with the quests before
-- it done and none taken that rules it out. Standing with a faction, a profession's skill and
-- what is on at the moment are not looked at: a quest that hangs on those is said to be doable.
function DB.IsDoable(id)
  if type(id) ~= "number" or Quest.Get(id, "name") == nil then return false end
  if Done(id) then return false end
  local level = UnitLevel and UnitLevel("player") or 0
  local need, most = Quest.Get(id, "requiredLevel"), Quest.Get(id, "requiredMaxLevel")
  if type(need) == "number" and level < need then return false end
  if type(most) == "number" and most > 0 and level > most then return false end
  local races = Quest.Get(id, "requiredRaces")
  if type(races) == "number" and races > 0 and UnitRace then
    local _, _, race = UnitRace("player")
    local mask = type(race) == "number" and (type(enum.raceMaskById) == "table" and enum.raceMaskById[race] or 2 ^ (race - 1))
    if mask and band(races, mask) == 0 then return false end
  end
  local classes = Quest.Get(id, "requiredClasses")
  if type(classes) == "number" and classes > 0 and UnitClass then
    local _, _, class = UnitClass("player")
    if type(class) == "number" and band(classes, 2 ^ (class - 1)) == 0 then return false end
  end
  local all = Quest.Get(id, "preQuestGroup")
  if type(all) == "table" then
    for _, q in ipairs(all) do if type(q) == "number" and q > 0 and not Done(q) then return false end end
  end
  local any = Quest.Get(id, "preQuestSingle")
  if type(any) == "table" and #any > 0 then
    local one = false
    for _, q in ipairs(any) do if type(q) == "number" and q > 0 and Done(q) then one = true break end end
    if not one then return false end
  end
  local never = Quest.Get(id, "exclusiveTo")
  if type(never) == "table" then
    for _, q in ipairs(never) do if type(q) == "number" and (Done(q) or InLog(q)) then return false end end
  end
  return true
end

-- ---- "ZoneDB" ----------------------------------------------------------------------------------
-- QuestieDB keeps which area is which map as the text of a table (it is long, and seldom asked
-- for): read once, here, with nothing for it to reach but itself.
local Zones = Loader:ImportModule("ZoneDB")
local zoneData = support("ZoneDB")
local zonePrivate = type(zoneData.private) == "table" and zoneData.private or {}
Zones.zoneIDs = zoneData.zoneIDs or enum.zoneIDs or {}
Zones.instanceIdToAreaId = zoneData.instanceIdToAreaId or {}

local function Table(v)
  if type(v) == "table" then return v end
  if type(v) ~= "string" then return {} end
  local load = rawget(_G, "loadstring") or rawget(_G, "load")
  local f = type(load) == "function" and load(v)
  if not f then return {} end
  if type(setfenv) == "function" then setfenv(f, {}) end
  local ok, t = pcall(f)
  return ok and type(t) == "table" and t or {}
end
local function Merged(base, over)
  local out = {}
  for k, v in pairs(Table(base)) do out[k] = v end
  for k, v in pairs(Table(over)) do out[k] = v end
  return out
end
local areaToMap, mapToArea, parentOf, dungeons, altDungeon
local function Maps()
  if areaToMap then return end
  areaToMap = Merged(zonePrivate.areaIdToUiMapId, zonePrivate.areaIdToUiMapIdOverride)
  mapToArea = Merged(zonePrivate.uiMapIdToAreaId, zonePrivate.uiMapIdToAreaIdOverride)
  parentOf = Merged(zonePrivate.subZoneToParentZone, zonePrivate.subZoneToParentZoneOverride)
  dungeons = type(zonePrivate.dungeons) == "table" and zonePrivate.dungeons or {}
  altDungeon = {}
  for area, entry in pairs(dungeons) do
    if type(entry) == "table" and type(entry[2]) == "table" then
      for _, other in ipairs(entry[2]) do altDungeon[other] = area end
    end
  end
end

function Zones:GetDungeons() Maps() return dungeons end
function Zones:GetUiMapIdByAreaId(area) Maps() return areaToMap[area] end
function Zones:GetAreaIdByUiMapId(map)
  Maps()
  local area = mapToArea[map]
  if area then return area end
  -- (by its name, where the tables do not say: the map's name is the area's)
  local info = C_Map and C_Map.GetMapInfo and C_Map.GetMapInfo(map)
  if info and info.name and C_Map.GetAreaInfo then
    for id in pairs(areaToMap) do
      if C_Map.GetAreaInfo(id) == info.name then return id end
    end
  end
  return nil
end
local byName
function Zones:GetAreaIdByName(name)
  Maps()
  if not byName then
    byName = {}
    if C_Map and C_Map.GetAreaInfo then
      for id in pairs(areaToMap) do
        local n = C_Map.GetAreaInfo(id)
        -- (a place inside a zone can have the zone's name: the zone is the lower number)
        if n and (not byName[n] or id < byName[n]) then byName[n] = id end
      end
    end
  end
  return byName[name]
end
function Zones:GetParentZoneId(area) Maps() return altDungeon[area] or parentOf[area] end
function Zones.IsDungeonZone(area) Maps() return dungeons[area] ~= nil or altDungeon[area] ~= nil end
function Zones:GetDungeonLocation(area)
  Maps()
  local d = dungeons[area] or dungeons[altDungeon[area] or 0]
  return d and d[4] or nil
end
function Zones:GetLocalizedDungeonName(area)
  Maps()
  local d = dungeons[area]
  if not d and altDungeon[area] then area = altDungeon[area]; d = dungeons[area] end
  if not d then return nil end
  return (C_Map and C_Map.GetAreaInfo and C_Map.GetAreaInfo(area)) or d[1]
end

-- ---- "Townsfolk" -------------------------------------------------------------------------------
-- The mailboxes: the Atlas layer names them (the map finds them when it writes the layer);
-- whose side each is for is the game's own table of who is whose enemy, which QuestieDB carries.
local Folk = Loader:ImportModule("Townsfolk")
local function Mailboxes()
  local facts = rawget(_G, "AzerothAtlasFacts")
  local list = type(facts) == "table" and facts.mailboxes
  return type(list) == "table" and list or {}
end
function Folk.GetMailboxes()
  local out = {}
  for _, id in ipairs(Mailboxes()) do
    if type(id) == "number" and Object.Get(id, "name") ~= nil then out[#out + 1] = id end
  end
  return out
end
function Folk.GetFactionSpecificMailboxes()
  local alliance, horde = {}, {}
  for _, id in ipairs(Folk.GetMailboxes()) do
    local enemies = DB.factionTemplate[Object.Get(id, "factionID") or 0]
    enemies = type(enemies) == "number" and enemies or 0
    -- (2: the Alliance is its enemy; 4: the Horde is)
    if band(enemies, 2) == 0 then alliance[#alliance + 1] = id end
    if band(enemies, 4) == 0 then horde[#horde + 1] = id end
  end
  return alliance, horde
end

-- ---- once the character is in the world ---------------------------------------------------------
if type(CreateFrame) == "function" then
  local frame = CreateFrame("Frame")
  frame:RegisterEvent("PLAYER_LOGIN")
  frame:SetScript("OnEvent", function(self)
    self:UnregisterAllEvents()
    Bind()
  end)
end
