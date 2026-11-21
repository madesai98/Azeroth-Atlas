-- Azeroth Atlas: what the Atlas database knows beyond QuestieDB, laid over QuestieDB in the game.
--
-- The 3D map is built from QuestieDB with the Atlas database laid over it: creatures and quests
-- QuestieDB does not have, where somebody stands that it does not place, a level it has as 0,
-- the name the game's own server gives (extractor/atlas.js says what is believed over what).
-- This does the same for QuestieDB as the game has it, so that whatever reads QuestieDB there -
-- Questie itself, a guide pack, a map addon - is told what the map shows.
--
-- QuestieDB has a way in for exactly this: a "correction" is a table of rows, { [id] = { field =
-- value } }, that an addon registers under its own name, and QuestieDB lays the rows over what it
-- reads. Nothing of QuestieDB's is changed on the disk; with this addon off, QuestieDB is as its
-- makers published it. QuestieDB's own layer is under ours, and Questie's (which it adds when it
-- starts, from what your character is and has done) is over it.
--
-- The rows are not in this file: the map writes them beside it (facts.lua), worked out against
-- the very QuestieDB that is in the game - a row is only there for a field QuestieDB says
-- nothing of, or where the game's own word is another. So they hold for that QuestieDB alone:
-- for another one (it was updated since, and the map has not run yet) nothing is laid over
-- until the map has written them anew.
--
--   /dump AzerothAtlasFactsState      what was laid over, or why nothing was
local OWNER = "AzerothAtlas"
local SLOT = "atlas"
local type, pairs, next, pcall, rawget = type, pairs, next, pcall, rawget

local state = { laid = {} }
_G.AzerothAtlasFactsState = state

local facts = rawget(_G, "AzerothAtlasFacts")
local lib = rawget(_G, "LibQuestieDB")
if type(facts) ~= "table" or facts.v ~= 1 then state.why = "the map has written no facts yet" return end
if type(lib) ~= "table" or type(lib.RegisterRuntimeCorrection) ~= "function" or type(lib.ApplyRegisteredCorrections) ~= "function"
  or type(lib.Meta) ~= "table" then state.why = "this QuestieDB takes no corrections" return end
if type(lib.RequireContract) == "function" and type(facts.contract) == "number" then
  local called, ok = pcall(lib.RequireContract, facts.contract)
  if not called or not ok then state.why = "this QuestieDB is laid out differently from the one the facts were made for" return end
end

-- Is this the QuestieDB the rows were worked out against?
local said = C_AddOns and C_AddOns.GetAddOnMetadata or rawget(_G, "GetAddOnMetadata")
local name = type(lib.addonName) == "string" and lib.addonName or "QuestieDB"
local function Says(key)
  if type(said) ~= "function" then return nil end
  local ok, value = pcall(said, name, key)
  return ok and type(value) == "string" and value ~= "" and value or nil
end
local base = type(facts.base) == "table" and facts.base or {}
state.questiedb = { version = Says("Version"), commit = Says("X-BUILD-COMMIT") }
if (base.version and state.questiedb.version and base.version ~= state.questiedb.version)
  or (base.commit and state.questiedb.commit and base.commit ~= state.questiedb.commit) then
  state.why = "made for QuestieDB " .. tostring(base.version) .. ", and this is " .. tostring(state.questiedb.version) .. ": laid over again once the map has run"
  return
end

-- A name the game's own server gives in place of QuestieDB's is in the map's language (English):
-- laid over only where the game speaks it too, so that a translated name is never undone.
local locale = type(GetLocale) == "function" and GetLocale() or "enUS"
local english = type(locale) == "string" and locale:sub(1, 2) == "en"

-- The rows of one kind, by QuestieDB's own numbers for the fields (asked of QuestieDB, by name:
-- a field it does not know is left out).
local function Rows(kind, Kind)
  local keys = type(lib.Meta[Kind]) == "table" and lib.Meta[Kind].keys
  if type(keys) ~= "table" then return nil end
  local rows = {}
  local function take(from)
    if type(from) ~= "table" then return end
    for id, fields in pairs(from) do
      if type(id) == "number" and type(fields) == "table" then
        local row = rows[id]
        for field, value in pairs(fields) do
          local index = keys[field]
          if index and value ~= nil then
            if not row then row = {}; rows[id] = row end
            row[index] = value
          end
        end
      end
    end
  end
  take(facts[kind])
  if english and type(facts.named) == "table" then take(facts.named[kind]) end
  return next(rows) and rows or nil
end

local corrections = type(lib.Corrections) == "table" and lib.Corrections or {}
local KINDS = { npc = "Npc", object = "Object", quest = "Quest" }
-- (the rows are made anew whenever QuestieDB asks for them: it keeps a copy of its own, and none is kept here)
local function Register(kind, Kind)
  return pcall(lib.RegisterRuntimeCorrection, OWNER, Kind, SLOT, function() return Rows(kind, Kind) end)
end
local function Withdraw(Kind)
  if type(corrections.UnregisterCorrection) == "function" then pcall(corrections.UnregisterCorrection, OWNER, Kind, SLOT) end
end

local counts = {}
for kind, Kind in pairs(KINDS) do
  local rows = Rows(kind, Kind)
  if rows then
    local many = 0
    for _ in pairs(rows) do many = many + 1 end
    if Register(kind, Kind) then counts[Kind] = many end
  end
end
if next(counts) then
  local ok = pcall(lib.ApplyRegisteredCorrections, OWNER)
  if ok then
    state.laid = counts
  else
    -- QuestieDB refused something. Nothing of ours may stay in the way of QuestieDB or of
    -- Questie when they lay their own: all of it is taken out, and each kind tried alone.
    for _, Kind in pairs(KINDS) do Withdraw(Kind) end
    pcall(lib.ApplyRegisteredCorrections, OWNER)
    for kind, Kind in pairs(KINDS) do
      if counts[Kind] then
        local did, why = Register(kind, Kind)
        if did then did, why = pcall(lib.ApplyRegisteredCorrections, OWNER) end
        if did then
          state.laid[Kind] = counts[Kind]
        else
          state.failed = state.failed or {}
          state.failed[Kind] = tostring(why)
          Withdraw(Kind)
          pcall(lib.ApplyRegisteredCorrections, OWNER)
        end
      end
    end
  end
end
state.rev = facts.rev
