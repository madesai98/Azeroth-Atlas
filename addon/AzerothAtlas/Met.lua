-- Azeroth Atlas: who you meet.
--
-- Much of this game is in no file: the game's server tells your game about a creature only when
-- you meet it, and what it tells is kept in no place a map could read - how high its level is,
-- how much health it has, whether it is a friend of your side or after you. The game does say
-- all three to an addon, of anyone you have targeted, have the mouse on, or see a name plate of.
-- So they are noted here, a creature a line, and kept in the addon's saved settings
-- (AzerothAtlasDB.met), which the game writes when you log out or /reload. The 3D map reads them
-- there and, where you let it share what it learns, hands them on to the Atlas database, where
-- everybody's are put together: "a creature of this kind has this much health at this level",
-- "it is hostile to this side". Nothing of you is in it: not who met it, where, or when.
--
-- What is not noted: players, and their pets and guardians (they stand nowhere and are nobody's
-- to look up); a creature whose level the game will not say (a skull); and anything the game
-- hands over as a "secret" value, as it does of some things in a fight or inside a dungeon -
-- those are left alone, not worked around. (What a fight itself shows, the game's combat log
-- says, and the map reads that: see /atlas fights.)
--
-- /atlas met   how many creatures are noted
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor = math.floor
local MOST = 4000   -- creatures kept: with more than this at the first meeting after a login, the list starts afresh (the map has read it long since)
local LEVELS = 12   -- levels kept of one creature (one that grows with you has many)

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
-- (what a question of the game answers, as a plain number - or nothing: an error, a secret, no such question)
local function number(f, ...)
  if type(f) ~= "function" then return nil end
  local ok, v = pcall(f, ...)
  if not ok or v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end
local function truth(f, ...)
  if type(f) ~= "function" then return nil end
  local ok, v = pcall(f, ...)
  if not ok or v == nil or secret(v) then return nil end
  return v == true
end

local looked = false
local function Store()
  if type(AzerothAtlasDB) ~= "table" then return nil end
  local met = AzerothAtlasDB.met
  -- (a long list is one the map has read long since: it starts afresh, so it never grows without end)
  local long = not looked and type(met) == "table" and (tonumber(met.n) or 0) > MOST
  looked = true
  if type(met) ~= "table" or type(met.of) ~= "table" or type(met.n) ~= "number" or long then
    met = { n = 0, of = {} }
    AzerothAtlasDB.met = met
  end
  return met
end

-- Which side you are on, as the map counts them: "A", "H", or nothing (a side of neither).
local function MySide()
  if type(UnitFactionGroup) ~= "function" then return nil end
  local ok, group = pcall(UnitFactionGroup, "player")
  if not ok or group == nil or secret(group) then return nil end
  return (group == "Alliance" and "A") or (group == "Horde" and "H") or nil
end

-- One creature, as the game shows it now. Returns true where something new was noted.
function shared.Meet(unit)
  if type(UnitGUID) ~= "function" then return false end
  local ok, guid = pcall(UnitGUID, unit)
  if not ok or guid == nil or secret(guid) or type(guid) ~= "string" then return false end
  local kind, _, _, _, _, id = strsplit("-", guid)
  if kind ~= "Creature" and kind ~= "Vehicle" then return false end
  id = tonumber(id)
  if not id or id <= 0 or id > 16777215 then return false end
  -- (someone's pet or guardian is a creature too; and one a player has charmed is not itself just now)
  if truth(UnitPlayerControlled, unit) ~= false then return false end
  if truth(UnitIsCharmed, unit) == true then return false end
  local met = Store()
  if not met then return false end
  local rec = met.of[id]
  if not rec then
    if met.n >= MOST * 1.25 then return false end
    rec = {}
    met.of[id] = rec
    met.n = met.n + 1
  end
  local new = false
  -- its health at this level (a creature with no level to show - a skull - is left out)
  local level, health = number(UnitLevel, unit), number(UnitHealthMax, unit)
  if level and health and level >= 1 and level <= 99 and health >= 1 and health < 2e9 and level == floor(level) then
    health = floor(health + 0.5)
    if type(rec.hp) ~= "table" then rec.hp = {} end
    if rec.hp[level] ~= health then
      local count = 0
      for _ in pairs(rec.hp) do count = count + 1 end
      if rec.hp[level] ~= nil or count < LEVELS then rec.hp[level] = health; new = true end
    end
  end
  -- how it stands towards your side: the game's eight steps, as the map's three. (The third,
  -- "unfriendly", will not talk to you and will not go for you either: to the map, which asks
  -- who attacks on sight, that is neutral.)
  local side, how = MySide(), number(UnitReaction, unit, "player")
  if side and how and how >= 1 and how <= 8 then
    local stand = (how >= 5 and 1) or (how >= 3 and 0) or -1
    if rec[side] ~= stand then rec[side] = stand; new = true end
  end
  return new
end

function shared.MetCount()
  local met = type(AzerothAtlasDB) == "table" and AzerothAtlasDB.met or nil
  return type(met) == "table" and tonumber(met.n) or 0
end

function shared.MetSay()
  print("|cff7fd4ffAzeroth Atlas|r: " .. shared.MetCount() .. " creatures noted (level, health, and how they stand towards your side) from those you targeted, had the mouse on or saw a name plate of. The 3D map reads them when you log out or /reload.")
end

local frame = CreateFrame("Frame", "AzerothAtlasMet")
local UNIT = { PLAYER_TARGET_CHANGED = "target", UPDATE_MOUSEOVER_UNIT = "mouseover" }
frame:SetScript("OnEvent", function(_, event, unit)
  local who = UNIT[event] or (event == "NAME_PLATE_UNIT_ADDED" and type(unit) == "string" and unit) or nil
  if who then shared.Try("meeting", shared.Meet, who) end
end)
-- (registered one at a time: a name this game does not have must not stop the rest)
for _, event in ipairs({ "PLAYER_TARGET_CHANGED", "UPDATE_MOUSEOVER_UNIT", "NAME_PLATE_UNIT_ADDED" }) do pcall(frame.RegisterEvent, frame, event) end
