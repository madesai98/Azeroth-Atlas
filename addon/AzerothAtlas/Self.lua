-- Azeroth Atlas: who your character is, for the 3D map to tell which quests are open to you.
--
-- A quest giver in the game shows its "!" only for a quest you can be given: of your race and
-- class, with the profession it asks for taken far enough, where you stand well enough with the
-- faction it asks about, and so on. The map knows what each quest asks for (QuestieDB says); what
-- it cannot know by itself is you. So this says it, through the strip, a little at a time:
--
--   your class and race        by the game's numbers for them
--   your professions           of each one some quest asks for: how far you are, and how far
--                              the rank you have learned goes (0 and 0: you do not have it)
--   your standings             with each faction some quest asks about: the game's own number
--                              for it (0 is the first step of neutral; nothing where you have
--                              not met them)
--   what you have learned      of each spell some quest asks after - a profession's
--                              specialisations among them - whether you know it
--
-- Which professions, factions and spells quests ask after is a list (QuestAsks.lua, made from
-- QuestieDB): the game answers such questions one at a time, by number. Nothing else of you is
-- said - no name, no realm, nothing of what you carry.
--
-- It is one account, in a few dozen bytes for each kind of thing, sent as messages of the kind
-- the travel facts go by (AzerothAtlas.lua: T_STATS), from key 8 on: each names the edition
-- of the account it belongs to and how many messages that has, so that the map takes a new one
-- only when it has all of it. Looked at again every half minute, and at once when the game says
-- that a skill, a standing or what you know has changed; said again only when it is another.
--
--   the account:  1 (how it is laid out), class, race,
--                 how many skills, then of each: its number (2 bytes), how far you are (2), how far it goes (2)
--                 how many factions, then of each: its number (2), your standing + 8388608 (3; 0: not met)
--                 how many spells, then of each: its number (3 bytes), with 8388608 added where you know it
--   (255 for "how many": the game would not say)
--
-- shared.SelfReport()   the next messages of the account: { { key, bytes }, ... } (two a round)
-- shared.SelfSay()      says what is known of you, for /atlas to call
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor = math.floor
local strchar = string.char
local LAYOUT = 1
local PER_MESSAGE = 34          -- bytes of the account in one message (two more before them: the edition, and how many messages)
local FIRST_KEY, MOST = 8, 48   -- the messages' keys, and how many of them at most
local A_ROUND = 2               -- messages handed over for one round of the strip
local EVERY = 30                -- seconds between looks
local NOT_SAID = 255
local KNOWN = 8388608

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
-- (a number as it is - or nothing, where it is none, or the game keeps it secret)
local function number(v)
  if v == nil or secret(v) or type(v) ~= "number" or v ~= v then return nil end
  return v
end
-- (what a question of the game answers - or nothing: an error, no such question)
local function ask(f, ...)
  if type(f) ~= "function" then return nil end
  local ok, a, b, c, d, e, g, h = pcall(f, ...)
  if ok then return a, b, c, d, e, g, h end
  return nil
end
local function from(space, name)
  local t = rawget(_G, space)
  return type(t) == "table" and t[name] or nil
end
-- (a whole number from 0 to most, or nothing)
local function whole(v, most)
  v = number(v)
  if not v then return nil end
  v = floor(v + 0.5)
  if v < 0 or v > most then return nil end
  return v
end
local function Byte2(v) return strchar(floor(v / 256) % 256, v % 256) end
local function Byte3(v) return strchar(floor(v / 65536) % 256, floor(v / 256) % 256, v % 256) end
local function asked(kind)
  local asks = shared.QuestAsks
  local list = type(asks) == "table" and asks[kind]
  return type(list) == "table" and list or {}
end

-- ---- reading ------------------------------------------------------------------------------------
local function Class()
  local _, id = ask(rawget(_G, "UnitClassBase"), "player")
  id = whole(id, 254)
  if not id or id == 0 then
    local _, _, n = ask(rawget(_G, "UnitClass"), "player")
    id = whole(n, 254)
  end
  return id or 0
end
local function Race()
  local _, _, id = ask(rawget(_G, "UnitRace"), "player")
  return whole(id, 254) or 0
end

-- Of each skill asked after: { its number, how far you are, how far it goes }. Asked of the game
-- by number, and of its list of your professions, and the better of the two taken: a profession
-- you have is never said to be one you lack because one of the two would not say.
-- Nothing: the game has neither way of asking.
local function Skills()
  local byNumber, slots, slot = from("C_SkillInfo", "GetSkillLineInfoByID"), rawget(_G, "GetProfessions"), rawget(_G, "GetProfessionInfo")
  local listed = type(slots) == "function" and type(slot) == "function"
  if type(byNumber) ~= "function" and not listed then return nil end
  local mine = {}
  local function note(id, rank, most)
    id, rank, most = whole(id, 65535), whole(rank, 65535) or 0, whole(most, 65535) or 0
    if not id or id == 0 then return end
    local had = mine[id]
    if not had then mine[id] = { rank, most }
    else
      if rank > had[1] then had[1] = rank end
      if most > had[2] then had[2] = most end
    end
  end
  if listed then
    local s = { ask(slots) }
    for i = 1, 7 do
      local index = number(s[i])
      if index then
        local _, _, rank, most, _, _, line = ask(slot, index)
        note(line, rank, most)
      end
    end
  end
  local out = {}
  for _, id in ipairs(asked("skills")) do
    local info = ask(byNumber, id)
    if type(info) == "table" and not secret(info) then note(id, info.rank, info.maxRank) end
    local got = mine[id] or { 0, 0 }
    out[#out + 1] = { id, got[1], got[2] }
  end
  return out
end

-- Of each faction asked about: { its number, your standing - or nothing, where you have not met them }.
local function Standings()
  local data, old = from("C_Reputation", "GetFactionDataByID"), rawget(_G, "GetFactionInfoByID")
  if type(data) ~= "function" and type(old) ~= "function" then return nil end
  local out = {}
  for _, id in ipairs(asked("factions")) do
    local standing
    if type(data) == "function" then
      local d = ask(data, id)
      if type(d) == "table" and not secret(d) then standing = number(d.currentStanding) end
    else
      -- (as games before this one said it: name, description, standing, the bar's ends, the bar's value)
      local _, _, _, _, _, value = ask(old, id)
      standing = number(value)
    end
    if standing then
      standing = floor(standing + 0.5)
      if standing < -KNOWN + 1 or standing > KNOWN - 1 then standing = nil end
    end
    out[#out + 1] = { id, standing }
  end
  return out
end

-- Of each spell asked after: { its number, whether you know it }.
local function Spells()
  local known = from("C_SpellBook", "IsSpellKnown") or rawget(_G, "IsPlayerSpell") or rawget(_G, "IsSpellKnown")
  if type(known) ~= "function" then return nil end
  local out = {}
  for _, id in ipairs(asked("spells")) do
    local ok, yes = pcall(known, id)
    if not ok then return nil end
    out[#out + 1] = { id, yes ~= nil and not secret(yes) and yes == true }
  end
  return out
end

-- The account, as one string of bytes.
local function Account()
  local out = { strchar(LAYOUT, Class(), Race()) }
  local function put(list, most, one)
    if not list then out[#out + 1] = strchar(NOT_SAID) return end
    local n = math.min(#list, most)
    out[#out + 1] = strchar(n)
    for i = 1, n do out[#out + 1] = one(list[i]) end
  end
  put(Skills(), 60, function(s) return Byte2(s[1]) .. Byte2(s[2]) .. Byte2(s[3]) end)
  put(Standings(), 120, function(f) return Byte2(f[1]) .. Byte3(f[2] and (f[2] + KNOWN) or 0) end)
  put(Spells(), 200, function(s) return Byte3(s[1] % KNOWN + (s[2] and KNOWN or 0)) end)
  return table.concat(out)
end

-- ---- telling ------------------------------------------------------------------------------------
local said = { account = nil, edition = 0, messages = {}, at = 0, readAt = -1000, dirty = true }

local function Refresh()
  local now = GetTime()
  if not said.dirty and now - said.readAt < EVERY then return end
  said.dirty, said.readAt = false, now
  local account = Account()
  if account == said.account then return end
  said.account = account
  said.edition = said.edition % 255 + 1
  local n = math.min(MOST, math.max(1, floor((#account + PER_MESSAGE - 1) / PER_MESSAGE)))
  local messages = {}
  for chunk = 0, n - 1 do
    messages[#messages + 1] = { FIRST_KEY + chunk, strchar(said.edition) .. strchar(n) .. string.sub(account, chunk * PER_MESSAGE + 1, (chunk + 1) * PER_MESSAGE) }
  end
  said.messages, said.at = messages, 0
end

function shared.SelfReport()
  Refresh()
  local out, messages = {}, said.messages
  for _ = 1, math.min(A_ROUND, #messages) do
    said.at = said.at % #messages + 1
    out[#out + 1] = messages[said.at]
  end
  return out
end

-- Looked at again at once when the game says something of it has changed.
if type(CreateFrame) == "function" then
  local frame = CreateFrame("Frame")
  for _, event in ipairs({ "PLAYER_ENTERING_WORLD", "SKILL_LINES_CHANGED", "UPDATE_FACTION", "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB", "TRADE_SKILL_LIST_UPDATE" }) do
    pcall(frame.RegisterEvent, frame, event) -- (an event this game does not have is not waited for)
  end
  frame:SetScript("OnEvent", function() said.dirty = true end)
end

function shared.SelfSay()
  local function count(list, has) if not list then return "not said by the game" end local n = 0 for i = 1, #list do if has(list[i]) then n = n + 1 end end return n .. " of " .. #list end
  local skills, standings, spells = Skills(), Standings(), Spells()
  print("|cff7fd4ffAzeroth Atlas|r: what the 3D map is told of your character, to tell which quests are open to you: class " .. Class() .. ", race " .. Race()
    .. "; professions quests ask for that you have: " .. count(skills, function(s) return s[2] > 0 or s[3] > 0 end)
    .. "; factions quests ask about that you have met: " .. count(standings, function(f) return f[2] ~= nil end)
    .. "; spells quests ask after that you know: " .. count(spells, function(s) return s[2] end)
    .. ". Said in " .. #said.messages .. " messages (edition " .. said.edition .. ").")
end
