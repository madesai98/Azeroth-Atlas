-- Azeroth Atlas: what to do with a thing you are getting rid of.
--
-- With the mouse on an item, one line is added to the game's own tooltip that says what to do
-- with it if you do not want it, in one of six words, each in a colour of its own: VENDOR,
-- AUCTION (your side's house, and for how many hours), NEUTRAL AUCTION, DISENCHANT VENDOR,
-- DISENCHANT AUCTION, DISENCHANT NEUTRAL AUCTION (disenchant it, and take what it gives there) -
-- whichever brings the most, of the ways that are safe enough by your own weights (below).
-- With Shift held, every way is listed with all that is known of it: for an auction the lowest
-- buyout and what lands with you if it sells (the price less the house's cut), then for 2, 8
-- and 24 hours how often it sells if you put it up now, the deposit at stake and what one
-- piece brings on average; how many sell in a day; what the chance rests on.
--
-- What a way brings, for one piece:
--
--   Vendor               what the game says a vendor pays.
--   An auction           on average: the going price less the house's cut, times how often the
--                        thing sells of the times it is put up - and for the times it does not,
--                        what a vendor pays less the deposit, which the house keeps. Reckoned for
--                        2, 8 and 24 hours (the deposit and the chance differ), the best is taken.
--                        The price is the lowest anybody asks: what you have to match. Things do
--                        not sell at the same pace all day, so the chance of a 2-hour and an
--                        8-hour auction is that of one put up NOW: by the hour of the world's
--                        clock, as the 3D map measured the hours of the day at the house (and
--                        for an item that sells at hours of its own, its own).
--   Disenchanting        what it gives on average, by the kind of thing it is (the tables below),
--                        each material taken to a vendor, or to either auction house as above.
--
-- "Safe enough" is a matter of weights, yours to set (Esc > Options > AddOns > Azeroth Atlas >
-- Getting rid of things, or /atlas advice): points for every per cent an auction pays over the
-- vendor if it sells, points off for every per cent of the times it does not sell - those
-- counted by how much is at stake, the deposit against that of 24 hours at your own house. An
-- auction is advised only where the points come out above nought - and only where it brings
-- enough more than the vendor on average to be worth the walk: 10 per cent, unless you say
-- otherwise. The weights it starts with (10 and 20) are the ones that
-- kept most of the profit there was to be had, tried on every item of an auction house.
--
-- The prices and how often things sell are not in this addon. The 3D map writes them, as it
-- last fetched them from the Atlas database, as a small addon of their own beside this one
-- (AzerothAtlas_Market: the map's server/market.js), which the game loads when it starts or on
-- /reload. Where they are not there, only the vendor and nothing else is known, and nothing is
-- said at all.
--
-- What is not done, and not known:
--   - how often a thing sells at the NEUTRAL house is known only from the map's own following
--     of that house, which began in November 2026: until there are readings for an item, its
--     auction there is listed with its price and "not known", and is never the advice;
--   - what disenchanting gives is the original game's tables, as published - nobody has checked
--     them for this game. What your own disenchanting gave is noted (in this addon's saved
--     settings), goes to the Atlas database with what the 3D map sends, and comes back put
--     together with everybody's: the tables are leaned on that more and more as it mounts up;
--   - a thing bound to you cannot be auctioned: said so, and left out;
--   - prices are for one piece, of a list read up to an hour before the game was last started.
--     What is asked is not what a thing sells for: the 3D map reckons a price at no more than
--     twice what the thing sells for, where that is known, and the list says where it did;
--   - what became of your own auctions - put up, sold, run out, taken down, and what the house
--     asked and kept - is noted by Sales.lua, shown with the item, and goes to the Atlas database;
--   - nothing with any value the game hands over as "secret": left alone, not worked around.
--
-- /atlas advice              whether it is on, the weights, and how old the prices are
-- /atlas advice off | on     the tooltip as the game writes it (and on, on)
-- /atlas advice gain 10      points for every per cent over the vendor
-- /atlas advice risk 20      points off for every per cent of the times it does not sell
-- /atlas advice least 10     per cent more than the vendor a way has to bring on average
-- /atlas advice reset        the weights it started with
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local match, gmatch, gsub, format, floor, sub = string.match, string.gmatch, string.gsub, string.format, math.floor, string.sub

local HEAD = "|cff7fd4ff"   -- (the addon's blue)
local GOOD = "|cff40e040"
local DIM = "|cff9a9b9c"
local GAIN, RISK = 10, 20   -- the weights it starts with
local WEIGHT_MOST = 999
local OLD = 3 * 86400       -- seconds: prices older than this are said to be old
local DURATIONS = { 2, 8, 24 }
local DISENCHANT = 13262    -- the spell, by the game's number for it
local LEAN = 20             -- the published table counts for as much as this many disenchantings of your own
local LEAST = 10            -- per cent more than the vendor a way has to bring on average to be advised over it, to start with

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function open(t)
  if t == nil or secret(t) or type(t) ~= "table" then return false end
  return not (issecrettable ~= nil and issecrettable(t))
end
local function DB()
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  return AzerothAtlasDB
end
local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end

-- ---- the switches ---------------------------------------------------------------------------------
local stamp = 0 -- (raised with every change of a setting: what was worked out before is worked out again)
function shared.AdviceOn() return DB().advice ~= false end
-- (something the advice shows has changed - your own auctions, say: worked out again the next time it is asked for)
function shared.AdviceStamp() stamp = stamp + 1 end
function shared.SetAdvice(on)
  if on then DB().advice = nil else DB().advice = false end
  stamp = stamp + 1
end
local function Weight(v, fallback)
  v = tonumber(v)
  if not v or v ~= v or v < 0 then return fallback end
  if v > WEIGHT_MOST then v = WEIGHT_MOST end
  return v
end
-- The weights: points for a per cent over the vendor, points off for a per cent of the times it does not sell.
function shared.AdviceWeights() return Weight(DB().adviceGain, GAIN), Weight(DB().adviceRisk, RISK) end
-- The least a way has to bring over the vendor on average, in per cent, to be advised over it.
function shared.AdviceLeast()
  local v = tonumber(DB().adviceLeast)
  if not v or v ~= v or v < 0 then return LEAST end
  if v > WEIGHT_MOST then v = WEIGHT_MOST end
  return v
end
function shared.SetAdviceLeast(v)
  v = tonumber(v)
  if not v or v ~= v or v < 0 then v = LEAST end
  if v > WEIGHT_MOST then v = WEIGHT_MOST end
  if v == LEAST then DB().adviceLeast = nil else DB().adviceLeast = v end
  stamp = stamp + 1
end
function shared.SetAdviceWeights(gain, risk)
  local d = DB()
  if gain ~= nil then gain = Weight(gain, GAIN) ; if gain == GAIN then d.adviceGain = nil else d.adviceGain = gain end end
  if risk ~= nil then risk = Weight(risk, RISK) ; if risk == RISK then d.adviceRisk = nil else d.adviceRisk = risk end end
  stamp = stamp + 1
end

-- ---- the prices -----------------------------------------------------------------------------------
-- As the 3D map wrote them - or nothing (none written yet, or written for another version of this).
local function Market()
  local m = rawget(_G, "AzerothAtlasMarket")
  if type(m) ~= "table" or m.v ~= 2 or type(m.of) ~= "table" or type(m.houses) ~= "table" then return nil end
  local own = m.houses[1]
  if type(own) ~= "table" or type(own.deposit) ~= "table" or type(own.cut) ~= "number" then return nil end
  return m
end

-- An item's line, a house each: { price (the lowest asked, as it is reckoned with), low (as it is
-- asked; 0: not for sale now), age, chance = { [2], [8], [24] }, from, n (auctions of the house
-- behind it), day (pieces sold a day; nothing: not known), dayFrom, sale (what it sells for; 0:
-- not known) } - or nothing for a house that has nothing of it.
local function RowsOf(m, item)
  local text = m.of[item]
  if type(text) ~= "string" then return nil end
  local out, k = {}, 0
  for part in gmatch(text .. "|", "(.-)|") do
    k = k + 1
    local price, low, age, c2, c8, c24, from, n, day, dayFrom, sale = match(part, "^(%d+) (%d+) (%d+) (%S+) (%S+) (%S+) (%d) (%d+) (%S+) (%d) (%d+)$")
    price = tonumber(price)
    if price and price > 0 then
      c2, c8, c24, day = tonumber(c2), tonumber(c8), tonumber(c24), tonumber(day)
      out[k] = { price = price, low = tonumber(low) or 0, age = tonumber(age) or 0, from = tonumber(from) or 0, n = tonumber(n) or 0,
        day = day and day / 10 or nil, dayFrom = tonumber(dayFrom) or 0, sale = tonumber(sale) or 0,
        chance = { [2] = c2 and c2 / 1000 or nil, [8] = c8 and c8 / 1000 or nil, [24] = c24 and c24 / 1000 or nil } }
    end
  end
  return out
end

-- How the hours ahead stand to the usual, for an auction of an item put up NOW at a house: 1 as
-- usual, 2 twice as fast. Things do not sell at the same pace all day: the 3D map writes, for
-- every hour of the world's clock, how the next 2 and the next 8 hours stand to the hours
-- auctions are usually up in - for the house, and for an item that sells at hours of its own.
-- (For 24 hours the hour makes no difference: every hour of the day is in them.)
local PACE_LEAST = 0.05
local function Pace(m, k, item, hours)
  if hours >= 24 then return 1 end
  local h = m.houses[k]
  if type(h) ~= "table" or type(time) ~= "function" then return 1 end
  local text = nil
  local own = type(m.hours) == "table" and m.hours[item] or nil
  if type(own) == "string" then
    local i = 0
    for part in gmatch(own .. "|", "(.-)|") do
      i = i + 1
      if i == k and #part == 48 then text = hours == 2 and sub(part, 1, 24) or sub(part, 25, 48) end
    end
  end
  if not text and type(h.pace) == "table" then text = h.pace[hours] end
  if type(text) ~= "string" or #text ~= 24 then return 1 end
  local hour = floor((time() - (tonumber(h.at) or 0)) / 3600) % 24
  local v = tonumber(sub(text, hour + 1, hour + 1), 36)
  if not v then return 1 end
  v = v / 10
  if v < PACE_LEAST then v = PACE_LEAST end
  return v
end

-- ---- what the game says of an item ------------------------------------------------------------------
-- { name, quality, level, stack, sell, class, sub, bind } - or nothing where the game has not heard of it yet.
local function Facts(item)
  local get = (C_Item and type(C_Item.GetItemInfo) == "function" and C_Item.GetItemInfo) or (type(GetItemInfo) == "function" and GetItemInfo) or nil
  if not get then return nil end
  local ok, name, _, quality, level, _, _, _, stack, _, _, sell, class, sub, bind = pcall(get, item)
  if not ok or name == nil or secret(name) or secret(quality) or secret(level) or secret(sell) or secret(class) or secret(bind) or secret(stack) then return nil end
  if type(name) ~= "string" then return nil end
  return {
    name = name, quality = tonumber(quality) or 0, level = tonumber(level) or 0, stack = tonumber(stack) or 1,
    sell = tonumber(sell) or 0, class = tonumber(class) or -1, sub = (not secret(sub)) and tonumber(sub) or -1, bind = tonumber(bind) or 0,
  }
end

-- Can you disenchant? true, false - or nothing where the game will not say.
local function Enchanter()
  if C_SpellBook and type(C_SpellBook.ContainsAnyDisenchantSpell) == "function" then
    local ok, v = pcall(C_SpellBook.ContainsAnyDisenchantSpell)
    if ok and v ~= nil and not secret(v) then return v and true or false end
  end
  for _, name in ipairs({ "IsPlayerSpell", "IsSpellKnown" }) do
    local known = rawget(_G, name)
    if type(known) == "function" then
      local ok, v = pcall(known, DISENCHANT)
      if ok and v ~= nil and not secret(v) then return v and true or false end
    end
  end
  return nil
end

-- ---- what disenchanting gives ------------------------------------------------------------------------
-- The original game's tables, as the Warcraft Wiki has them (warcraft.wiki.gg/wiki/
-- Disenchanting_tables, read 23 November 2026) - NOT checked for this game, whose own table of
-- what can be disenchanted (ItemDisenchantLoot) has the same kinds and the same bands of item
-- level but does not say what each gives. A band: from, to, then what may come of it, each
-- { the material, how often in per cent, the fewest, the most }.
local DUST1, DUST2, DUST3, DUST4, DUST5 = 10940, 11083, 11137, 11176, 16204                 -- Strange, Soul, Vision, Dream, Illusion Dust
local MAGIC1, MAGIC2, ASTRAL1, ASTRAL2, MYSTIC1, MYSTIC2 = 10938, 10939, 10998, 11082, 11134, 11135 -- Lesser / Greater Magic, Astral, Mystic Essence
local NETHER1, NETHER2, ETERNAL1, ETERNAL2 = 11174, 11175, 16202, 16203                      -- Lesser / Greater Nether, Eternal Essence
local GLIM1, GLIM2, GLOW1, GLOW2, RAD1, RAD2, BRIL1, BRIL2 = 10978, 11084, 11138, 11139, 11177, 11178, 14343, 14344 -- Small / Large Glimmering, Glowing, Radiant, Brilliant Shard
local NEXUS = 20725                                                                           -- Nexus Crystal
local ARMOR = {
  { 5, 15, { DUST1, 80, 1, 2 }, { MAGIC1, 20, 1, 2 } },
  { 16, 20, { DUST1, 75, 2, 3 }, { MAGIC2, 20, 1, 2 }, { GLIM1, 5, 1, 1 } },
  { 21, 25, { DUST1, 75, 4, 6 }, { ASTRAL1, 15, 1, 2 }, { GLIM1, 10, 1, 1 } },
  { 26, 30, { DUST2, 75, 1, 2 }, { ASTRAL2, 20, 1, 2 }, { GLIM2, 5, 1, 1 } },
  { 31, 35, { DUST2, 75, 2, 5 }, { MYSTIC1, 20, 1, 2 }, { GLOW1, 5, 1, 1 } },
  { 36, 40, { DUST3, 75, 1, 2 }, { MYSTIC2, 20, 1, 2 }, { GLOW2, 5, 1, 1 } },
  { 41, 45, { DUST3, 75, 2, 5 }, { NETHER1, 20, 1, 2 }, { RAD1, 5, 1, 1 } },
  { 46, 50, { DUST4, 75, 1, 2 }, { NETHER2, 20, 1, 2 }, { RAD2, 5, 1, 1 } },
  { 51, 55, { DUST4, 75, 2, 5 }, { ETERNAL1, 20, 1, 2 }, { BRIL1, 5, 1, 1 } },
  { 56, 60, { DUST5, 75, 1, 2 }, { ETERNAL2, 20, 1, 2 }, { BRIL2, 5, 1, 1 } },
  { 61, 99, { DUST5, 75, 2, 5 }, { ETERNAL2, 20, 2, 3 }, { BRIL2, 5, 1, 1 } },
}
local WEAPON = {
  { 5, 15, { DUST1, 20, 1, 2 }, { MAGIC1, 80, 1, 2 } },
  { 16, 20, { DUST1, 20, 2, 3 }, { MAGIC2, 75, 1, 2 }, { GLIM1, 5, 1, 1 } },
  { 21, 25, { DUST1, 15, 4, 6 }, { ASTRAL1, 75, 1, 2 }, { GLIM1, 10, 1, 1 } },
  { 26, 30, { DUST2, 20, 1, 2 }, { ASTRAL2, 75, 1, 2 }, { GLIM2, 5, 1, 1 } },
  { 31, 35, { DUST2, 20, 2, 5 }, { MYSTIC1, 75, 1, 2 }, { GLOW1, 5, 1, 1 } },
  { 36, 40, { DUST3, 20, 1, 2 }, { MYSTIC2, 75, 1, 2 }, { GLOW2, 5, 1, 1 } },
  { 41, 45, { DUST3, 20, 2, 5 }, { NETHER1, 75, 1, 2 }, { RAD1, 5, 1, 1 } },
  { 46, 50, { DUST4, 20, 1, 2 }, { NETHER2, 75, 1, 2 }, { RAD2, 5, 1, 1 } },
  { 51, 55, { DUST4, 22, 2, 5 }, { ETERNAL1, 75, 1, 2 }, { BRIL1, 3, 1, 1 } },
  { 56, 60, { DUST5, 22, 1, 2 }, { ETERNAL2, 75, 1, 2 }, { BRIL2, 3, 1, 1 } },
  { 61, 99, { DUST5, 22, 2, 5 }, { ETERNAL2, 75, 2, 3 }, { BRIL2, 3, 1, 1 } },
}
local RARE = {
  { 5, 25, { GLIM1, 100, 1, 1 } },
  { 26, 30, { GLIM2, 100, 1, 1 } },
  { 31, 35, { GLOW1, 100, 1, 1 } },
  { 36, 40, { GLOW2, 100, 1, 1 } },
  { 41, 45, { RAD1, 100, 1, 1 } },
  { 46, 50, { RAD2, 100, 1, 1 } },
  { 51, 55, { BRIL1, 100, 1, 1 } },
  { 56, 99, { BRIL2, 99.5, 1, 1 }, { NEXUS, 0.5, 1, 1 } },
}
local EPIC = {
  { 40, 45, { RAD1, 100, 2, 4 } },
  { 46, 50, { RAD2, 100, 2, 4 } },
  { 51, 55, { BRIL1, 100, 2, 4 } },
  { 56, 60, { NEXUS, 100, 1, 1 } },
  { 61, 99, { NEXUS, 100, 1, 2 } },
}

-- The band a thing falls in: its row of the tables, and the name its readings are kept under
-- ("weapon or armour : quality : the band's first level") - or nothing: not a thing that can be
-- disenchanted (as far as the tables say).
local function Band(facts)
  if facts.class ~= 2 and facts.class ~= 4 then return nil end
  local t = (facts.quality == 2 and (facts.class == 2 and WEAPON or ARMOR)) or (facts.quality == 3 and RARE) or (facts.quality == 4 and EPIC) or nil
  if not t then return nil end
  for i = 1, #t do
    local row = t[i]
    if facts.level >= row[1] and facts.level <= row[2] then return row, format("%d:%d:%d", facts.class, facts.quality, row[1]) end
  end
  return nil
end

-- What has been counted of a band: { n (times disenchanted), got = { [material] = pieces in all } }
-- - everybody's count as the 3D map wrote it from the Atlas database, or your own where that is
-- the larger (everybody's has yours in it once it has been sent and put together; until then
-- yours may be ahead). Nothing where neither has any.
local function Counted(key)
  local own = type(DB().yields) == "table" and DB().yields[key] or nil
  if not (type(own) == "table" and type(own.n) == "number" and own.n > 0 and type(own.got) == "table") then own = nil end
  local m = rawget(_G, "AzerothAtlasMarket")
  local text = type(m) == "table" and type(m.yields) == "table" and m.yields[key] or nil
  local all = nil
  if type(text) == "string" then
    local n = tonumber(match(text, "^(%d+)"))
    if n and n > 0 then
      all = { n = n, got = {} }
      for item, pieces in gmatch(text, "(%d+)=(%d+)") do all.got[tonumber(item)] = tonumber(pieces) end
    end
  end
  if all and (not own or all.n >= own.n) then return all end
  return own
end

-- What a band gives on average, a material each: { item, pieces for one disenchanting } - the
-- table's word, leaned on what has been counted of that band (Counted; see Disenchanted).
local function Yields(row, key)
  local each, order = {}, {}
  for i = 3, #row do
    local g = row[i]
    each[g[1]] = (each[g[1]] or 0) + g[2] / 100 * (g[3] + g[4]) / 2
    order[#order + 1] = g[1]
  end
  local seen = Counted(key)
  if seen then
    for item in pairs(seen.got) do if each[item] == nil and type(item) == "number" then each[item] = 0 ; order[#order + 1] = item end end
    for i = 1, #order do
      local item = order[i]
      each[item] = (LEAN * each[item] + (tonumber(seen.got[item]) or 0)) / (LEAN + seen.n)
    end
  end
  local out = {}
  for i = 1, #order do if each[order[i]] > 0 then out[#out + 1] = { item = order[i], each = each[order[i]] } end end
  return out, (seen and tonumber(seen.n)) or 0
end

-- ---- what an auction brings --------------------------------------------------------------------------
-- The deposit for one piece: so many per cent of what a vendor pays, never less than a copper.
local function Deposit(vendor, percent)
  local d = floor(vendor * percent / 100)
  if d < 1 then d = 1 end
  return d
end

-- Is an auction safe enough, by the weights? Points for every per cent it pays over the vendor
-- if it sells, points off for every per cent of the times it does not - counted by what is at
-- stake: the deposit against that of 24 hours at your own house (60 per cent of the vendor's).
local function Safe(net, vendor, chance, deposit, own24, gain, risk)
  local base = vendor > 0 and vendor or 1
  local over = (net / base - 1) * 100
  if over > 100000 then over = 100000 end
  local stake = deposit / Deposit(base, own24)
  return gain * over - risk * (1 - chance) * 100 * stake > 0
end

-- Does a way bring enough more than the vendor, on average, to be advised over it? (So many per cent more, and a copper at the least.)
local function Better(worth, vendor) return worth >= vendor * (1 + shared.AdviceLeast() / 100) and worth >= vendor + 1 end

-- An auction of one piece at a house: { price, low, net (what lands with you if it sells: the
-- price less the house's cut), cut, age, from, n, day, dayFrom, sale, house, lengths = { one for
-- 2, 8 and 24 hours: { hours, deposit, usual (how often it sells, whenever it is put up), pace
-- (how the hours ahead stand to the usual), chance (put up now), worth (on average), safe, good
-- (safe, and enough better than the vendor) } }, best (the length to put it up for: a good one
-- before a safe one before the rest, of two alike the one that brings more) and that length's
-- hours, chance, deposit, worth, safe, good }. Nothing where the house has no price for it; no
-- best and no worth where it is not known how often it sells.
local function Auction(m, k, item, row, vendor, gain, risk)
  local h = m.houses[k]
  if not row or type(h) ~= "table" or type(h.deposit) ~= "table" then return nil end
  local cut = tonumber(h.cut) or 0
  local net = row.price * (1 - cut / 100)
  local out = { price = row.price, low = row.low, net = net, cut = cut, age = row.age, from = row.from, n = row.n, day = row.day, dayFrom = row.dayFrom, sale = row.sale, house = k, lengths = {} }
  local own24 = tonumber(m.houses[1].deposit[24]) or 60
  local best = nil
  for i = 1, #DURATIONS do
    local hours = DURATIONS[i]
    local percent = tonumber(h.deposit[hours])
    if percent then
      local l = { hours = hours, deposit = Deposit(vendor, percent) }
      local usual = row.chance[hours]
      if usual then
        l.usual = usual
        l.pace = Pace(m, k, item, hours)
        l.chance = 1 - (1 - usual) ^ l.pace
        l.worth = l.chance * net + (1 - l.chance) * (vendor - l.deposit)
        l.safe = Safe(net, vendor, l.chance, l.deposit, own24, gain, risk)
        l.good = l.safe and Better(l.worth, vendor)
        if best == nil or (l.good and not best.good) or (l.good == best.good and ((l.safe and not best.safe) or (l.safe == best.safe and l.worth > best.worth))) then best = l end
      end
      out.lengths[#out.lengths + 1] = l
    end
  end
  if best then out.best, out.hours, out.chance, out.deposit, out.worth, out.safe, out.good = best, best.hours, best.chance, best.deposit, best.worth, best.safe, best.good end
  return out
end

-- ---- every way, and the best ---------------------------------------------------------------------------
-- The six ways, as the advice names them, each in a colour of its own.
local WAYS = {
  vendor = { "VENDOR", "|cffffd100" },
  auction = { "AUCTION", "|cff40e040" },
  neutral = { "NEUTRAL AUCTION", "|cffff9d3c" },
  dvendor = { "DISENCHANT VENDOR", "|cffc79cff" },
  dauction = { "DISENCHANT AUCTION", "|cffff6ec7" },
  dneutral = { "DISENCHANT NEUTRAL AUCTION", "|cff4fd8e8" },
}
local function Neutral(m, k) return type(m.houses[k]) == "table" and m.houses[k].side == "neutral" end

-- What to do with one piece of an item: { item, name, stack, ways = { ... }, best (one of the
-- ways, or nothing: there is nothing to go by), bound, credit, market, listed } - or nothing
-- where nothing is to be said (the game has not heard of the item, or there are no prices and no
-- vendor takes it).
-- A way: { kind ("vendor", "auction", "disenchant"), key (which of the six: WAYS), house (1 your
-- own, 2 the neutral; nothing: the vendor), worth (what it brings on average; nothing: not
-- known), sold (what it brings if everything sells), a (the auction: Auction), hours, chance,
-- safe, why (what keeps it from being the advice), gives (what disenchanting gives), parts (what
-- the game says of each material), mats (each material's auction) }.
local function Work(item, bound)
  local facts = Facts(item)
  if not facts then return nil end
  local m = Market()
  local gain, risk = shared.AdviceWeights()
  local vendor = facts.sell
  local cannot = bound or facts.bind == 1 or facts.bind == 4
  local ways = {}
  local whole = true -- (false: something was not known yet that the game will know in a moment - not kept)

  if vendor > 0 then ways[#ways + 1] = { kind = "vendor", key = "vendor", worth = vendor, sold = vendor, safe = true } end

  local rows = m and RowsOf(m, item) or nil
  if m then
    for k = 1, #m.houses do
      local a = rows and Auction(m, k, item, rows[k], vendor, gain, risk) or nil
      if a then
        local way = { kind = "auction", key = Neutral(m, k) and "neutral" or "auction", house = k, a = a, worth = a.worth, sold = a.net, hours = a.hours, chance = a.chance, safe = a.safe == true }
        if cannot then way.why = "bound to you"
        elseif a.worth == nil then way.why = "not known how often it sells"
        elseif not a.safe then way.why = "too risky by your weights"
        elseif not a.good then way.why = "no better than the vendor" end
        ways[#ways + 1] = way
      end
    end
  end

  local band, key = Band(facts)
  if band then
    local gives, read = Yields(band, key)
    local can = Enchanter()
    local why = (can == false and "needs an enchanter") or (can == nil and "not known whether you can") or nil
    -- to a vendor
    local sum, known = 0, true
    local parts = {}
    for i = 1, #gives do
      local f = Facts(gives[i].item)
      if not f then known = false ; whole = false else sum = sum + gives[i].each * f.sell ; parts[i] = f end
    end
    if known then ways[#ways + 1] = { kind = "disenchant", key = "dvendor", worth = sum, sold = sum, safe = true, why = why or (not Better(sum, vendor) and "no better than the vendor" or nil), gives = gives, parts = parts, read = read } end
    -- to each auction house
    if m and known then
      local own24 = tonumber(m.houses[1].deposit[24]) or 60
      for k = 1, #m.houses do
        local worth, sold, deposits, sure, priced, any = 0, 0, 0, 0, true, false
        local mats = {}
        for i = 1, #gives do
          local r = RowsOf(m, gives[i].item)
          local a = Auction(m, k, gives[i].item, r and r[k] or nil, parts[i].sell, gain, risk)
          mats[i] = a
          if not a then priced = false
          else
            any = true
            sold = sold + gives[i].each * a.net
            if a.worth == nil then worth = nil
            elseif worth ~= nil then
              worth = worth + gives[i].each * a.worth
              deposits = deposits + gives[i].each * a.deposit
              sure = sure + gives[i].each * a.net * a.chance
            end
          end
        end
        if any and priced then
          local way = { kind = "disenchant", key = Neutral(m, k) and "dneutral" or "dauction", house = k, worth = worth, sold = sold, gives = gives, parts = parts, mats = mats, read = read }
          if worth ~= nil then
            way.chance = sold > 0 and sure / sold or 0
            way.safe = Safe(sold, vendor, way.chance, deposits, own24, gain, risk)
          end
          way.why = why or (worth == nil and "not known how often it sells") or (not way.safe and "too risky by your weights") or (not Better(worth, vendor) and "no better than the vendor") or nil
          ways[#ways + 1] = way
        end
      end
    end
  end

  if #ways == 0 then return nil, whole end
  -- the best: of the ways nothing speaks against, the one that brings most - the vendor first among equals
  local best = nil
  for i = 1, #ways do
    local w = ways[i]
    if not w.why and w.worth ~= nil and (best == nil or w.worth > best.worth) then best = w end
  end
  return { item = item, name = facts.name, stack = facts.stack, ways = ways, best = best, bound = cannot, credit = m and m.credit == true, market = m, listed = m and m.houses[1].t or nil }, whole
end

-- ---- said in words --------------------------------------------------------------------------------------
local GOLD, SILVER, COPPER = "|cffffd100g|r", "|cffc7c7cfs|r", "|cffeda55fc|r"
-- An amount of copper as the game's coins: the two largest that are not nought.
local function Money(c)
  c = floor((tonumber(c) or 0) + 0.5)
  local minus = c < 0 and "-" or ""
  if c < 0 then c = -c end
  local g, s, k = floor(c / 10000), floor(c / 100) % 100, c % 100
  if g >= 100 then return minus .. format("%d", g) .. GOLD end
  if g > 0 then return minus .. format("%d", g) .. GOLD .. (s > 0 and (" " .. format("%d", s) .. SILVER) or "") end
  if s > 0 then return minus .. format("%d", s) .. SILVER .. (k > 0 and (" " .. format("%d", k) .. COPPER) or "") end
  return minus .. format("%d", k) .. COPPER
end
local function Percent(p) return format("%d%%", floor(p * 100 + 0.5)) end
local function Ago(seconds)
  if seconds < 5400 then return "an hour" end
  if seconds < 2 * 86400 then return format("%d hours", floor(seconds / 3600 + 0.5)) end
  return format("%d days", floor(seconds / 86400 + 0.5))
end
-- How many: to a tenth under ten, whole above, with commas from a thousand.
local function Count(v)
  if v < 9.95 then local text = format("%.1f", v) ; return (gsub(text, "%.0$", "")) end
  local text = format("%d", floor(v + 0.5))
  local out = ""
  while #text > 3 do out = "," .. sub(text, -3) .. out ; text = sub(text, 1, -4) end
  return text .. out
end
-- So many pieces of a material: "1.5", "0.05".
local function Pieces(v) return v >= 0.095 and format("%.1f", v) or format("%.2f", v) end

-- The advice in its colour: "AUCTION".
local function Verdict(w) local t = WAYS[w.key] or WAYS.vendor ; return t[2] .. t[1] .. "|r" end

-- What a way brings, as it is written at the right: "~ 1g 20s" on average, or "1g 60s if sold" where the chance is not known.
local function Brings(w)
  if w.worth == nil then return Money(w.sold) .. " if sold" end
  if w.kind == "vendor" then return Money(w.worth) end
  return "~ " .. Money(w.worth)
end

local FROM = {
  [2] = "How often: auctions followed at the region's houses",
  [3] = "How often: TradeSkillMaster's figure for the region",
  [4] = "How often: what became of players' own auctions",
}

-- The lines for a tooltip: { { left, right, r, g, b, wrap } ... } (right nothing: one text across).
-- `more`: every way, with all that is known of it; else the one line of advice.
local function Lines(a, more)
  local out = {}
  -- (a text across, with nothing at the right, is broken into lines where it is too long for the tooltip)
  local function add(left, right, shade, wrap)
    if wrap == nil then wrap = right == nil end
    out[#out + 1] = { left, right, shade or 1, shade or 1, shade or 1, wrap }
  end
  local m = a.market
  local best = a.best
  -- (how old the prices are: by the clock now, not when this was worked out)
  local age = a.listed and type(time) == "function" and (time() - a.listed) or nil
  local old = age and age > OLD and ("These prices are " .. Ago(age) .. " old: run Azeroth Atlas for new ones.") or nil
  if not more then
    if best then
      local hours = (best.kind == "auction" and best.hours) and format(" %d h", best.hours) or ""
      add(HEAD .. "Getting rid of it:|r " .. Verdict(best) .. hours, Brings(best) .. (a.stack > 1 and " each" or ""))
    else
      add(HEAD .. "Getting rid of it:|r " .. DIM .. "no vendor buys it, and no auction is safe to advise|r", nil, 1, true)
    end
    if old then add(old, nil, 0.6, true) end
    return out
  end

  add(HEAD .. "Getting rid of it|r" .. (a.stack > 1 and (" " .. DIM .. "(one piece)|r") or ""), nil, 1, false)
  local unchecked = false
  for i = 1, #a.ways do
    local w = a.ways[i]
    local mine = w == best
    local shade = (w.why and 0.6) or 1
    -- the way, and what it brings
    local head = (mine and (GOOD .. "> |r") or "") .. Verdict(w)
    if w.kind == "auction" and w.hours and not w.why then head = head .. format(" %d h", w.hours) end
    if w.why then head = head .. " " .. DIM .. "(" .. w.why .. ")|r" end
    add(head, mine and (GOOD .. Brings(w) .. "|r") or Brings(w), shade)

    if w.kind == "auction" then
      local x = w.a
      local h = m.houses[w.house]
      if type(h) == "table" and (tonumber(h.seen) or 0) == 0 then unchecked = true end
      local cut = format("%s%% cut", tostring(x.cut))
      -- the price, and what lands with you if it sells
      if x.low > 0 and x.low > x.price * 1.01 then
        add("   Lowest buyout " .. Money(x.low) .. (x.sale > 0 and (", but it sells for about " .. Money(x.sale)) or ", more than it sells for"), nil, 0.75)
        add("   Reckoned at " .. Money(x.price) .. ", less the " .. cut, Money(x.net), 0.9)
      elseif x.low > 0 then
        add("   Lowest buyout " .. Money(x.price) .. ", less the " .. cut, Money(x.net), 0.9)
      else
        add("   Last price " .. Money(x.price) .. format(" (%d day%s ago), less the ", x.age, x.age == 1 and "" or "s") .. cut, Money(x.net), 0.9)
      end
      -- each length: how often it sells put up now, the deposit at stake, what it brings on average
      local known = false
      for j = 1, #x.lengths do
        local l = x.lengths[j]
        if l.chance then
          known = true
          local chosen = l == x.best
          local left = format("   %s%d h: sells %s, deposit %s", chosen and "> " or "", l.hours, Percent(l.chance), Money(l.deposit))
          if not l.safe then left = left .. " " .. DIM .. "(too risky)|r" end
          if chosen and mine then add(GOOD .. left .. "|r", GOOD .. "~ " .. Money(l.worth) .. "|r", 1)
          else add(left, "~ " .. Money(l.worth), (l.safe and not w.why) and 0.9 or 0.6) end
        end
      end
      if not known then
        local d = {}
        for j = 1, #x.lengths do d[#d + 1] = Money(x.lengths[j].deposit) end
        add("   How often it sells here is not known yet. Deposit for 2, 8, 24 h: " .. table.concat(d, ", "), nil, 0.6, true)
      end
      -- how many a day, and for how much
      if x.day then
        add("   Sells about " .. Count(x.day) .. " a day" .. (x.dayFrom == 1 and " here" or " in the region (TradeSkillMaster)")
          .. ((x.sale > 0 and not (x.low > x.price * 1.01)) and (", for about " .. Money(x.sale)) or ""), nil, 0.75)
      elseif x.sale > 0 and not (x.low > x.price * 1.01) then
        add("   Sells for about " .. Money(x.sale), nil, 0.75)
      end
      -- what the chance rests on
      if known then
        if x.from == 1 then add(x.n > 0 and format("   How often: %d auctions followed at this house", x.n) or "   How often: auctions followed at this house", nil, 0.6)
        elseif FROM[x.from] then add("   " .. FROM[x.from], nil, 0.6) end
      end
      -- the hour of the day
      local fast = {}
      for j = 1, #x.lengths do
        local l = x.lengths[j]
        if l.pace and (l.pace >= 1.1 or l.pace <= 0.9) then fast[#fast + 1] = format("the next %d h at %.1f times the usual pace", l.hours, l.pace) end
      end
      if #fast > 0 then add("   Put up now: " .. table.concat(fast, ", "), nil, 0.75, true) end
      -- your own auctions of it
      local own = type(shared.SalesOf) == "function" and type(h) == "table" and shared.SalesOf(a.item, h.key) or nil
      if own and own.p > 0 then
        local done = own.s + own.x
        add(format("   Yours: %d put up", own.p) .. (done > 0 and format(", %d of %d sold", own.s, done) or "") .. (own.c > 0 and format(", %d taken down", own.c) or ""), nil, 0.75)
      end
    elseif w.kind == "disenchant" then
      for j = 1, #w.gives do
        local g, f = w.gives[j], w.parts and w.parts[j]
        local name = f and f.name or ("item " .. tostring(g.item))
        local x = w.mats and w.mats[j] or nil
        if not w.house then
          add("   " .. Pieces(g.each) .. " " .. name .. " at " .. Money(f and f.sell or 0), Money(g.each * (f and f.sell or 0)), shade < 1 and 0.6 or 0.9)
        elseif x and x.worth ~= nil then
          add("   " .. Pieces(g.each) .. " " .. name .. format(": %d h, sells %s, ", x.hours, Percent(x.chance)) .. Money(x.net) .. " after the cut", "~ " .. Money(g.each * x.worth), shade < 1 and 0.6 or 0.9)
        elseif x then
          add("   " .. Pieces(g.each) .. " " .. name .. ": " .. Money(x.net) .. " after the cut, not known how often", Money(g.each * x.net), 0.6)
        end
      end
      if not w.house then
        add((w.read or 0) > 0 and format("   What it gives: the original game's tables, leaned on %d disenchantings counted", w.read) or "   What it gives: the original game's tables, not checked for this game", nil, 0.6, true)
      end
    end
  end
  local foot = "~ is what one piece brings on average, put up many times: the price less the cut for the times it sells, what a vendor pays less the lost deposit for the times it does not."
  if age and age <= OLD then foot = foot .. " Prices of " .. Ago(age) .. " ago." end
  if a.credit then foot = foot .. " How often things sell: partly TradeSkillMaster's figures." end
  if unchecked then foot = foot .. " The houses' cut and deposits are the game files' figures: no auction of ours has checked them yet." end
  add(foot, nil, 0.6, true)
  if old then add(old, nil, 0.6, true) end
  return out
end

local function HouseName(m, k)
  local h = m.houses[k]
  return type(h) == "table" and type(h.name) == "string" and h.name or (k == 1 and "Your" or "Neutral")
end

-- ---- into the tooltip -------------------------------------------------------------------------------------
-- (what was last worked out: a tooltip is written anew several times a second)
local kept = { item = nil, bound = nil, stamp = nil, market = nil, advice = nil, tick = nil }
local function AdviceFor(item, bound)
  local m = rawget(_G, "AzerothAtlasMarket")
  -- (and by the clock, in steps of ten minutes: the chance of a short auction is that of one put up now)
  local tick = type(time) == "function" and floor(time() / 600) or 0
  if kept.item == item and kept.bound == bound and kept.stamp == stamp and kept.tick == tick and rawequal(kept.market, m) then return kept.advice end
  local advice, whole = Work(item, bound)
  if whole then kept.item, kept.bound, kept.stamp, kept.market, kept.advice, kept.tick = item, bound, stamp, m, advice, tick else kept.item = nil end
  return advice
end

-- Does the tooltip say the thing is bound to you (or to a quest)? What the game's own words for that are.
local BOUND = { "ITEM_SOULBOUND", "ITEM_ACCOUNTBOUND", "ITEM_BNETACCOUNTBOUND", "ITEM_BIND_QUEST", "ITEM_BIND_TO_ACCOUNT", "ITEM_BIND_TO_BNETACCOUNT" }
local function Bound(data)
  local lines = data.lines
  if not open(lines) then return false end
  for _, l in ipairs(lines) do
    if open(l) then
      local text = l.leftText
      if not secret(text) and type(text) == "string" then
        for i = 1, #BOUND do
          local words = rawget(_G, BOUND[i])
          if type(words) == "string" and text == words then return true end
        end
      end
    end
  end
  return false
end

local count = { shown = 0 }
local function Item(tooltip, data)
  if not shared.AdviceOn() then return end
  if tooltip ~= GameTooltip and tooltip ~= rawget(_G, "ItemRefTooltip") then return end
  if type(tooltip.IsForbidden) == "function" and tooltip:IsForbidden() then return end
  if not open(data) then return end
  local item = data.id
  if secret(item) or type(item) ~= "number" or item <= 0 then return end
  -- (with no prices from the 3D map there is only the vendor's word, which the game's own tooltip has already)
  if not Market() then return end
  local advice = AdviceFor(item, Bound(data))
  if not advice then return end
  local more = type(IsShiftKeyDown) == "function" and IsShiftKeyDown() and true or false
  local lines = Lines(advice, more)
  for i = 1, #lines do
    local l = lines[i]
    if l[2] then tooltip:AddDoubleLine(l[1], l[2], l[3], l[4], l[5], l[3], l[4], l[5])
    else tooltip:AddLine(l[1], l[3], l[4], l[5], l[6] or false) end
  end
  count.shown = count.shown + 1
end

local hooked = false
do
  local kinds = Enum and Enum.TooltipDataType
  if type(TooltipDataProcessor) == "table" and type(TooltipDataProcessor.AddTooltipPostCall) == "function" and type(kinds) == "table" and kinds.Item ~= nil then
    hooked = pcall(TooltipDataProcessor.AddTooltipPostCall, kinds.Item, function(tooltip, data)
      shared.Try("what to do with an item", Item, tooltip, data)
    end)
  end
end

-- ---- what your own disenchanting gave ------------------------------------------------------------------
-- The game says which spell you cast and at what (the thing's name), and then opens what came
-- of it as loot. Both are noted: the thing's band, and what it gave - kept in this addon's saved
-- settings (AzerothAtlasDB.yields: for each band, how many times, and how many pieces of each
-- material in all), and leaned on by the list above more and more as it mounts up.
local pending = nil -- { key, at }: a thing has been disenchanted, and what it gave has not been seen yet
local function Cast(unit, target, _, spell)
  if secret(unit) or unit ~= "player" or secret(spell) or spell ~= DISENCHANT then return end
  pending = nil
  if secret(target) or type(target) ~= "string" or target == "" then return end
  local facts = Facts(target)
  if not facts then return end
  local band, key = Band(facts)
  if band then pending = { key = key, at = type(GetTime) == "function" and GetTime() or 0 } end
end
local function Looted()
  local p = pending
  pending = nil
  if not p then return end
  local now = type(GetTime) == "function" and GetTime() or 0
  if now < p.at or now - p.at > 10 then return end
  if type(GetNumLootItems) ~= "function" or type(GetLootSlotLink) ~= "function" or type(GetLootSlotInfo) ~= "function" then return end
  local ok, n = pcall(GetNumLootItems)
  if not ok or secret(n) or type(n) ~= "number" or n < 1 or n > 8 then return end
  local got = {}
  for slot = 1, n do
    local okLink, link = pcall(GetLootSlotLink, slot)
    local okInfo, _, _, many = pcall(GetLootSlotInfo, slot)
    if not okLink or not okInfo or secret(link) or secret(many) or type(link) ~= "string" then return end
    local id = tonumber(match(link, "item:(%d+)"))
    many = tonumber(many)
    if not id or not many or many < 1 or many > 20 then return end
    got[id] = (got[id] or 0) + many
  end
  local d = DB()
  if type(d.yields) ~= "table" then d.yields = {} end
  local rec = d.yields[p.key]
  if type(rec) ~= "table" or type(rec.got) ~= "table" then rec = { n = 0, got = {} } ; d.yields[p.key] = rec end
  rec.n = (tonumber(rec.n) or 0) + 1
  for id, many in pairs(got) do rec.got[id] = (tonumber(rec.got[id]) or 0) + many end
  stamp = stamp + 1
end
do
  local frame = CreateFrame("Frame", "AzerothAtlasAdviceWatch")
  frame:SetScript("OnEvent", function(_, event, ...)
    if event == "UNIT_SPELLCAST_SENT" then shared.Try("disenchanting, noted", Cast, ...)
    elseif event == "LOOT_READY" or event == "LOOT_OPENED" then shared.Try("disenchanting, what it gave", Looted)
    elseif event == "MODIFIER_STATE_CHANGED" then
      -- (Shift pressed or let go over an item: the tooltip is written again, with the list or without)
      local tip = GameTooltip
      if hooked and shared.AdviceOn() and tip and type(tip.IsShown) == "function" and tip:IsShown() and type(tip.RefreshData) == "function" then pcall(tip.RefreshData, tip) end
    end
  end)
  -- (registered one at a time: a name this game does not have must not stop the rest)
  for _, event in ipairs({ "UNIT_SPELLCAST_SENT", "LOOT_READY", "LOOT_OPENED", "MODIFIER_STATE_CHANGED" }) do pcall(frame.RegisterEvent, frame, event) end
end

do
  local m = Market()
  if not hooked then shared.Log("advice: this game has no way for an addon to add to an item's tooltip: nothing is said of what to do with a thing")
  elseif m then shared.Log("advice: prices for " .. tostring(m.items) .. " items at " .. tostring(#m.houses) .. " auction house(s), as the 3D map wrote them")
  else shared.Log("advice: no prices to go by - the 3D map has not written them yet (AzerothAtlas_Market), or the game has not been started since it did") end
end

-- ---- /atlas advice ----------------------------------------------------------------------------------------
function shared.AdviceSay(words)
  words = type(words) == "string" and words or ""
  local word, value = match(words, "^%s*(%S*)%s*(%S*)")
  if word == "off" or word == "on" then shared.SetAdvice(word == "on")
  elseif word == "gain" and tonumber(value) then shared.SetAdviceWeights(tonumber(value), nil)
  elseif word == "risk" and tonumber(value) then shared.SetAdviceWeights(nil, tonumber(value))
  elseif word == "least" and tonumber(value) then shared.SetAdviceLeast(tonumber(value))
  elseif word == "reset" then shared.SetAdviceWeights(GAIN, RISK) ; shared.SetAdviceLeast(LEAST)
  elseif word ~= "" then say("/atlas advice, then: on, off, gain <points>, risk <points>, least <per cent>, or reset.") return end
  if not hooked then say("this game has no way for an addon to add to an item's tooltip: what to do with a thing cannot be said there.") return end
  if not shared.AdviceOn() then say("an item's tooltip does not say what to do with it (/atlas advice on makes it).") return end
  local gain, risk = shared.AdviceWeights()
  local m = Market()
  if not m then
    say("an item's tooltip says what to do with a thing you are getting rid of - but there are no prices to go by yet. The 3D map writes them beside this addon (AzerothAtlas_Market), once an auction house is chosen on its Prices page: run Azeroth Atlas, then start the game again. /atlas advice off turns it off.")
    return
  end
  local age = type(time) == "function" and type(m.houses[1].t) == "number" and (time() - m.houses[1].t) or nil
  local read, everybody = 0, 0
  if type(m.yields) == "table" then for _, text in pairs(m.yields) do everybody = everybody + (type(text) == "string" and tonumber(match(text, "^(%d+)")) or 0) end end
  if type(DB().yields) == "table" then for _, rec in pairs(DB().yields) do if type(rec) == "table" then read = read + (tonumber(rec.n) or 0) end end end
  say("an item's tooltip says what to do with a thing you are getting rid of - VENDOR, AUCTION, NEUTRAL AUCTION, or DISENCHANT and one of the three - whichever brings most of the ways that are safe enough. Hold Shift for every way, with the lowest buyout less the cut, how often it sells in 2, 8 and 24 hours put up now, and what it brings on average. Prices for " .. tostring(m.items) .. " items at the " .. HouseName(m, 1) .. " auction house"
    .. (m.houses[2] and " and the neutral one" or "") .. (age and (", " .. Ago(age) .. " old") or "") .. ". "
    .. format("Weights: %s points for every per cent an auction pays over the vendor, %s off for every per cent of the times it does not sell; and it has to bring %s per cent more than the vendor on average (/atlas advice gain %d, /atlas advice risk %d, /atlas advice least %d; reset puts those back). ", tostring(gain), tostring(risk), tostring(shared.AdviceLeast()), GAIN, RISK, LEAST)
    .. (read > 0 and (format("%d", read) .. " of your own disenchantings are counted in what disenchanting gives. ") or "")
    .. (everybody > 0 and (format("%d", everybody) .. " disenchantings counted by everybody's copies came with the prices. ") or "")
    .. (type(m.houses[1].pace) == "table" and "The hour of the day counts: the map has measured when things sell at your house. " or "The hour of the day does not count yet: the map has not followed the house for long enough to know when things sell. ")
    .. (type(shared.SalesSay) == "function" and shared.SalesSay() or "")
    .. "/atlas advice off turns it off.")
end

-- ---- the options: Esc > Options > AddOns > Azeroth Atlas > Getting rid of things -------------------------
-- A page of its own under the addon's (Guide.lua has that, and calls this when it is listed).
do
  local panel = nil
  local function Build()
    panel = CreateFrame("Frame", "AzerothAtlasAdviceOptions")
    panel.name = "Getting rid of things"
    panel.parent = "Azeroth Atlas"
    panel:Hide()
    local shows = {}
    local function Refresh() for i = 1, #shows do pcall(shows[i]) end end
    local function Words(text, font, x, y, width)
      local s = panel:CreateFontString(nil, "ARTWORK", font)
      s:SetPoint("TOPLEFT", panel, "TOPLEFT", x, y)
      s:SetJustifyH("LEFT")
      if width then s:SetWidth(width) end
      s:SetText(text)
      return s
    end
    local function Press(text, x, y, width, click)
      local ok, b = pcall(CreateFrame, "Button", nil, panel, "UIPanelButtonTemplate")
      if not ok or not b then
        b = CreateFrame("Button", nil, panel)
        local label = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        label:SetPoint("CENTER", b, "CENTER", 0, 0)
        b.SetText = function(_, words) label:SetText(words) end
      end
      b:SetSize(width, 22)
      b:SetPoint("TOPLEFT", panel, "TOPLEFT", x, y)
      b:SetText(text)
      b:SetScript("OnClick", function() pcall(click) ; Refresh() end)
      return b
    end
    local function Number(x, y, get, set)
      local ok, box = pcall(CreateFrame, "EditBox", nil, panel, "InputBoxTemplate")
      if not ok or not box then box = CreateFrame("EditBox", nil, panel) ; if ChatFontNormal then box:SetFontObject(ChatFontNormal) end end
      box:SetAutoFocus(false)
      box:SetSize(56, 20)
      box:SetPoint("TOPLEFT", panel, "TOPLEFT", x + 30, y - 1)
      if box.SetJustifyH then box:SetJustifyH("CENTER") end
      if box.SetMaxLetters then box:SetMaxLetters(3) end
      if box.SetNumeric then box:SetNumeric(true) end
      local function take(v)
        v = floor((tonumber(v) or 0) + 0.5)
        if v < 0 then v = 0 elseif v > WEIGHT_MOST then v = WEIGHT_MOST end
        pcall(set, v)
        Refresh()
      end
      box:SetScript("OnEnterPressed", function(self) take(self:GetText()) self:ClearFocus() end)
      box:SetScript("OnEscapePressed", function(self) self:ClearFocus() Refresh() end)
      box:SetScript("OnEditFocusLost", function(self) take(self:GetText()) end)
      Press("-", x, y, 24, function() take(get() - 1) end)
      Press("+", x + 94, y, 24, function() take(get() + 1) end)
      shows[#shows + 1] = function() if not (box.HasFocus and box:HasFocus()) then box:SetText(format("%d", floor(get() + 0.5))) end end
      return box
    end
    local built = false
    panel:SetScript("OnShow", function()
      if not built then
        built = true
        pcall(function()
          Words("Getting rid of things", "GameFontNormalLarge", 16, -16)
          Words("With the mouse on an item, its tooltip says what to do with it if you do not want it: VENDOR, AUCTION, NEUTRAL AUCTION, or DISENCHANT and one of those three - whichever brings most, of the ways that are safe enough. Hold Shift to see every way: the lowest buyout less the house's cut, how often it sells in 2, 8 and 24 hours if you put it up now, and what one piece brings on average.", "GameFontHighlightSmall", 16, -40, 560)
          local b = CreateFrame("CheckButton", nil, panel)
          b:SetSize(26, 26)
          b:SetPoint("TOPLEFT", panel, "TOPLEFT", 14, -84)
          b:SetNormalTexture("Interface\\Buttons\\UI-CheckBox-Up")
          b:SetPushedTexture("Interface\\Buttons\\UI-CheckBox-Down")
          b:SetHighlightTexture("Interface\\Buttons\\UI-CheckBox-Highlight", "ADD")
          b:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
          local label = b:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
          label:SetPoint("LEFT", b, "RIGHT", 2, 1)
          label:SetText("In an item's tooltip, say what to do with a thing I am getting rid of")
          b:SetScript("OnClick", function(self) shared.SetAdvice(self:GetChecked() and true or false) ; Refresh() end)
          shows[#shows + 1] = function() b:SetChecked(shared.AdviceOn()) end
          Words("How safe an auction has to be", "GameFontNormal", 16, -124)
          Words("An auction is advised only where its points come out above nought. More points off for not selling: fewer auctions, and surer ones. Only how the two stand to each other counts (10 and 20 is the same as 1 and 2).", "GameFontHighlightSmall", 16, -142, 560)
          Words("Points for every per cent it pays over the vendor, if it sells", "GameFontHighlight", 20, -186)
          Number(420, -181, function() return (shared.AdviceWeights()) end, function(v) shared.SetAdviceWeights(v, nil) end)
          Words("Points off for every per cent of the times it does not sell", "GameFontHighlight", 20, -214)
          Number(420, -209, function() local _, risk = shared.AdviceWeights() return risk end, function(v) shared.SetAdviceWeights(nil, v) end)
          Words("Per cent more than the vendor it has to bring on average, to be worth the walk", "GameFontHighlight", 20, -242)
          Number(420, -237, function() return shared.AdviceLeast() end, function(v) shared.SetAdviceLeast(v) end)
          Press("Back to 10, 20 and 10", 20, -272, 190, function() shared.SetAdviceWeights(GAIN, RISK) ; shared.SetAdviceLeast(LEAST) end)
          Words("The points off are counted by what is at stake: the deposit, against that of 24 hours at your own auction house. So a short auction, or one of a thing a vendor pays little for, is let through sooner; one at the neutral house, whose deposit is five times as high, later.", "GameFontHighlightSmall", 16, -308, 560)
          Words("Prices and how often things sell come from the 3D map (its Prices page: choose your auction house there), as fresh as the last time the game was started. What disenchanting gives is the original game's tables, corrected by what your own disenchanting gives.", "GameFontHighlightSmall", 16, -358, 560)
        end)
      end
      Refresh()
    end)
  end

  -- (for the tests)
  function shared.AdviceOptionsPeek() return panel end

  -- Listed under the addon's own page: `parent` is what the game gave for that (nothing: a game that lists pages by name).
  function shared.AdviceOptions(parent)
    if panel then return end
    local ok = pcall(Build)
    if not ok or not panel then return end
    local game = rawget(_G, "Settings")
    if parent and type(game) == "table" and game.RegisterCanvasLayoutSubcategory then
      if pcall(game.RegisterCanvasLayoutSubcategory, parent, panel, panel.name) then return end
    end
    if InterfaceOptions_AddCategory then pcall(InterfaceOptions_AddCategory, panel) end
  end
end

-- (for the tests, and for a look from the game: /dump AzerothAtlas.AdvicePeek(2589))
function shared.AdvicePeek(item, bound, more)
  local advice = Work(item, bound == true)
  if not advice then return nil end
  local lines = Lines(advice, more == true)
  return advice, lines
end
function shared.AdviceCount() return count.shown, hooked end
