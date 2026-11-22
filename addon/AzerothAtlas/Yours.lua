-- Azeroth Atlas: your pet, and what your minimap is set to track.
--
-- The 3D map shows the dots of the game's minimap: what you track, your target, your pet. It
-- reads them off the picture of the minimap, as it reads the strip - the game tells an addon
-- nothing of where a dot is. What a dot IS the picture does not say, and that is what is said
-- here, through the strip, for the map to put the two together:
--
--   your pet           that you have one (a hunter's pet, a warlock's demon: whatever the game
--                      calls "pet"), its name, whether it is dead - and where it is, should
--                      the game say. It says so of you and your party, and may not of a pet:
--                      then the map goes by the pet's blue dot on the minimap.
--   what you track     the spells your minimap's tracking is set to: Track Beasts, Find Herbs.
--                      So that the map can say what its dots are.
--
-- Nothing is asked for that the game does not hand out freely; every question is put so that
-- a refusal cannot stop the strip, and what the game keeps secret is left alone.
--
-- As messages of the kind the hearthstone's spot goes by (AzerothAtlas.lua: T_BINDPOS, key 0),
-- under keys of their own, which a 3D map from before simply does not read:
--   key 1         128 + (1 you have a pet, 2 it is dead, 4 where it is follows), how many
--                 things are tracked (three at most), the pet's map (2 bytes), north and west
--                 (3 each, as everywhere: yards + 32768, times 128), and 1
--   keys 2 to 4   what is tracked: the spell (3 bytes), and 1
-- and their names as text, the way the hearthstone's inn is named (T_BIND), under the same keys.
--
-- shared.YoursReport()   the messages to send this round: { { kind, key, bytes }, ... }
-- shared.YoursSay()      says what is known, for /atlas to call
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor = math.floor
local strchar = string.char
local NAMES, SPOTS = 4, 5     -- the kinds of message (AzerothAtlas.lua: T_BIND, T_BINDPOS)
local PET, TRACKED = 1, 1     -- keys: the pet's; a tracked thing's is this plus which it is
local TRACKED_MOST = 3

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function number(v)
  if v == nil or secret(v) or type(v) ~= "number" or v ~= v then return nil end
  return v
end
local function text(v)
  if v == nil or secret(v) or type(v) ~= "string" or v == "" then return nil end
  return v
end
local function yes(v) return v ~= nil and not secret(v) and (v == true or v == 1) end
-- (what a question of the game answers - or nothing: an error, no such question)
local function ask(f, ...)
  if type(f) ~= "function" then return nil end
  local ok, a, b, c, d, e, g, h = pcall(f, ...)
  if ok then return a, b, c, d, e, g, h end
  return nil
end
local function clamp(v, most)
  v = floor(v + 0.5)
  if v < 0 then return 0 end
  if v > most then return most end
  return v
end
local function Byte2(v) v = clamp(v, 65535) return strchar(floor(v / 256), v % 256) end
local function Byte3(v) v = clamp(v, 16777215) return strchar(floor(v / 65536), floor(v / 256) % 256, v % 256) end
local function Spot(map, north, west) return Byte2(map) .. Byte3((north + 32768) * 128) .. Byte3((west + 32768) * 128) end
local NOWHERE = strchar(0, 0, 0, 0, 0, 0, 0, 0)

-- Where a unit is: its map, yards north, yards west - or nothing (the game does not say: a
-- dungeon, or a unit it does not tell of).
local function Where(unit)
  local north, west, _, map = ask(UnitPosition, unit)
  north, west, map = number(north), number(west), number(map)
  if north and west and map and not (north == 0 and west == 0) then return map, north, west end
  return nil
end

-- ---- your pet ---------------------------------------------------------------------------------
local pet = { has = false }
local function ReadPet()
  pet.has = yes(ask(UnitExists, "pet"))
  pet.name, pet.dead, pet.map, pet.north, pet.west = nil, false, nil, nil, nil
  if not pet.has then return end
  pet.name = text((ask(UnitName, "pet")))
  pet.dead = yes(ask(UnitIsDead, "pet"))
  pet.map, pet.north, pet.west = Where("pet")
end

-- ---- what your minimap is set to track ----------------------------------------------------------
local tracked = {}  -- { { spell, name }, ... }
local function ReadTracked()
  local list = {}
  local M = C_Minimap
  local n = M and number(ask(M.GetNumTrackingTypes)) or 0
  for i = 1, n do
    if #list >= TRACKED_MOST then break end
    -- (as one table in the game as it is now; as a row of answers in an older one)
    local a, _, active, kind, _, spell = ask(M.GetTrackingInfo, i)
    local name = a
    if type(a) == "table" and not secret(a) then name, active, kind, spell = a.name, a.active, a.type, a.spellID end
    spell = number(spell)
    -- (a spell that tracks: not the game's own switches for innkeepers, mailboxes and the like)
    if yes(active) and spell and spell > 0 and text(kind) == "spell" then list[#list + 1] = { spell, text(name) } end
  end
  tracked = list
end

-- ---- said --------------------------------------------------------------------------------------
function shared.YoursReport()
  -- (looked at afresh for every round of the strip: your pet moves)
  ReadPet()
  ReadTracked()
  local out = {}
  local known = pet.has and pet.map ~= nil
  out[#out + 1] = { SPOTS, PET, strchar(128 + (pet.has and 1 or 0) + (pet.dead and 2 or 0) + (known and 4 or 0), #tracked)
    .. (known and Spot(pet.map, pet.north, pet.west) or NOWHERE) .. strchar(1) }
  if pet.has and pet.name then out[#out + 1] = { NAMES, PET, pet.name } end
  for i = 1, #tracked do
    out[#out + 1] = { SPOTS, TRACKED + i, Byte3(tracked[i][1]) .. strchar(1) }
    if tracked[i][2] then out[#out + 1] = { NAMES, TRACKED + i, tracked[i][2] } end
  end
  return out
end

function shared.YoursSay()
  ReadPet()
  ReadTracked()
  local what = {}
  for i = 1, #tracked do what[#what + 1] = tracked[i][2] or ("spell " .. tracked[i][1]) end
  local said = "tracking: " .. (#what > 0 and table.concat(what, ", ") or "nothing (by a spell)") .. "; "
  if pet.has then
    said = said .. "your pet" .. (pet.name and (" " .. pet.name) or "") .. (pet.dead and " (dead)" or "")
      .. (pet.map and (": the game says where it is (" .. floor(pet.north + 0.5) .. " north, " .. floor(pet.west + 0.5) .. " west)")
        or ": the game does not say where it is (the 3D map goes by its blue dot on the minimap)")
  else
    said = said .. "no pet"
  end
  print("|cff7fd4ffAzeroth Atlas|r: what the 3D map is told of your pet and your tracking: " .. said .. ".")
end
