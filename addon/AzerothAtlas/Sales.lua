-- Azeroth Atlas: what becomes of your own auctions.
--
-- The lists of auctions the 3D map goes by cannot tell an auction that was bought from one its
-- seller took down, and what a house asks as a deposit and keeps of a sale is in the game's
-- files for nobody to check. Your own auctions say both. So this notes, of every auction you
-- put up while it is loaded:
--
--   put up        the item, how many, for how long, the price asked, the deposit the game asked
--                 for it (its own figure, as the auction house's window shows it), what a vendor
--                 pays for the thing, and at which house: your side's or the neutral one
--   what became   sold (the game says so: in your list of auctions, in a notice, or in the
--   of it         invoice that comes by mail - which also says what the house kept), run out,
--                 or taken down by you. Nothing is made of an auction that is simply gone:
--                 only of what the game says. One nothing is heard of for days is "not known".
--
-- Kept in this addon's saved settings (AzerothAtlasDB.sales), counted by house, item and length:
-- so many put up, sold, run out, taken down; and what the houses took - the deposits against
-- what a vendor pays, the cut against the price paid. The item's tooltip shows your own count
-- (Advice.lua, with Shift), /atlas advice says what the houses took of you, and the 3D map
-- sends the counts to the Atlas database with everything else it sends (atlasdb/sales.js): no
-- names, no times - "of this item, at this house, so many were put up for 24 hours and so many
-- sold". There they are put together with everybody's, and come back in the prices: as how
-- often a thing really sells, and as the cut and the deposits the tooltip reckons with.
--
-- Nothing here presses a button or puts anything up: it only listens. Nothing with any value
-- the game hands over as "secret" is used: left alone, not worked around.
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local match, format, floor, gsub = string.match, string.format, math.floor, string.gsub

local HOURS = { 2, 8, 24 }        -- the lengths an auction can be put up for, as the game numbers them (1, 2, 3)
local WAIT = 20                   -- seconds a post waits for the game to say the auction is there
local GIVE_UP = 4 * 86400         -- seconds after its time ran out that an auction nothing was heard of is "not known"
local OPEN_MOST = 500             -- auctions kept as "still up"
local DEPOSIT_LEAST = 100         -- a deposit under a silver says little of the rate (it is rounded down to the copper)
local LEAST = 5                   -- auctions (or sales) before a rate is said

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function plain(v) if v == nil or secret(v) then return nil end return v end
local function DB()
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  return AzerothAtlasDB
end
local function Now() return type(time) == "function" and time() or 0 end

-- What is kept: { v = 1, up = { [the auction's number] = { item, q, hours, price (a piece), deposit,
-- vendor (a piece), t, side ("own", "neutral" or "?"), house (the 3D map's name for it, or ""), who,
-- name } }, n = { ["us-110:2589:24"] = { p, s, x, c, u, ask, got, dep } }, cost = { ["own:24"] =
-- { n, dep, ven }, ["own:cut"] = { n, cut, bid } }, mail = { [what a letter is told by] = when it goes } }
local function Sales()
  local d = DB()
  local s = d.sales
  if type(s) ~= "table" or s.v ~= 1 then s = { v = 1 } ; d.sales = s end
  if type(s.up) ~= "table" then s.up = {} end
  if type(s.n) ~= "table" then s.n = {} end
  if type(s.cost) ~= "table" then s.cost = {} end
  if type(s.mail) ~= "table" then s.mail = {} end
  return s
end

local function Who()
  local name = type(UnitName) == "function" and plain(UnitName("player")) or nil
  local realm = type(GetRealmName) == "function" and plain(GetRealmName()) or nil
  return (type(name) == "string" and name or "?") .. "-" .. (type(realm) == "string" and realm or "?")
end

-- What the game says of an item: its name and what a vendor pays for one.
local function Facts(item)
  local get = (C_Item and type(C_Item.GetItemInfo) == "function" and C_Item.GetItemInfo) or (type(GetItemInfo) == "function" and GetItemInfo) or nil
  if not get then return nil, 0 end
  local ok, name, _, _, _, _, _, _, _, _, _, sell = pcall(get, item)
  if not ok or secret(name) or secret(sell) then return nil, 0 end
  return type(name) == "string" and name or nil, tonumber(sell) or 0
end

-- ---- which house ------------------------------------------------------------------------------------
-- Your side's house or the neutral one: by where you stand (your side's cities are "friendly"
-- ground, the towns of the neutral houses are not), and where the game will not say, by the
-- deposit - the neutral houses ask several times as much. With it the 3D map's name for the
-- house (its prices file has both), where your side is the one that file was written for.
local function Side(deposit, vendor, q, hours)
  local kind = nil
  if C_PvP and type(C_PvP.GetZonePVPInfo) == "function" then local ok, v = pcall(C_PvP.GetZonePVPInfo) ; if ok then kind = plain(v) end end
  if kind == nil and type(GetZonePVPInfo) == "function" then local ok, v = pcall(GetZonePVPInfo) ; if ok then kind = plain(v) end end
  if kind == "friendly" then return "own", kind end
  if kind == "contested" or kind == "sanctuary" then return "neutral", kind end
  -- by the deposit: nearer to which house's, as the 3D map has them
  local m = rawget(_G, "AzerothAtlasMarket")
  if type(m) == "table" and type(m.houses) == "table" and deposit and vendor and vendor > 0 and deposit >= 20 then
    local rate = deposit / (vendor * q) * 100
    local best, gap = nil, nil
    for k = 1, 2 do
      local h = m.houses[k]
      local asked = type(h) == "table" and type(h.deposit) == "table" and tonumber(h.deposit[hours]) or nil
      if asked and asked > 0 then
        local off = math.abs(math.log(rate / asked))
        if not gap or off < gap then best, gap = (h.side == "neutral") and "neutral" or "own", off end
      end
    end
    if best then return best, "deposit" end
  end
  return "?", tostring(kind)
end
local function HouseKey(side)
  local m = rawget(_G, "AzerothAtlasMarket")
  if type(m) ~= "table" or type(m.houses) ~= "table" then return "" end
  local own = m.houses[1]
  if type(own) ~= "table" or type(own.key) ~= "string" then return "" end
  -- (the file was written for one side: another character's auctions are not of its houses)
  local mine = type(UnitFactionGroup) == "function" and plain(UnitFactionGroup("player")) or nil
  if own.side ~= "neutral" and (type(mine) ~= "string" or string.lower(mine) ~= own.side) then return "" end
  if side == "own" and own.side ~= "neutral" then return own.key end
  if side == "neutral" then
    if own.side == "neutral" then return own.key end
    local other = m.houses[2]
    if type(other) == "table" and other.side == "neutral" and type(other.key) == "string" then return other.key end
  end
  return ""
end

-- ---- counting ---------------------------------------------------------------------------------------
local function Tally(a, what, more)
  if type(a.house) ~= "string" or a.house == "" then return end
  local s = Sales()
  local key = a.house .. ":" .. tostring(a.item) .. ":" .. tostring(a.hours)
  local rec = s.n[key]
  if type(rec) ~= "table" then rec = { p = 0, s = 0, x = 0, c = 0, u = 0, ask = 0, got = 0, dep = 0 } ; s.n[key] = rec end
  rec[what] = (tonumber(rec[what]) or 0) + 1
  for k, v in pairs(more or {}) do rec[k] = (tonumber(rec[k]) or 0) + v end
end
local function Took(side, what, n, a, b)
  if side ~= "own" and side ~= "neutral" then return end
  local s = Sales()
  local key = side .. ":" .. tostring(what)
  local rec = s.cost[key]
  if type(rec) ~= "table" then rec = { n = 0 } ; s.cost[key] = rec end
  rec.n = (tonumber(rec.n) or 0) + 1
  rec[n] = (tonumber(rec[n]) or 0) + a
  local other = n == "cut" and "bid" or "ven"
  rec[other] = (tonumber(rec[other]) or 0) + b
end

-- What became of an auction: "s" sold, "x" run out, "c" taken down, "u" not known. Once.
local function Done(id, what, got)
  local s = Sales()
  local a = s.up[id]
  if type(a) ~= "table" then return false end
  s.up[id] = nil
  local price = (tonumber(a.price) or 0) * (tonumber(a.q) or 1)
  Tally(a, what, what == "s" and { got = tonumber(got) or price } or nil)
  if shared.AdviceStamp then shared.AdviceStamp() end
  return true
end

-- ---- an auction put up ------------------------------------------------------------------------------
local pending = {} -- posts sent to the game and not answered yet, in the order sent
local function Posted(byPiece, where, length, quantity, a4, a5)
  if not (C_Item and type(C_Item.GetItemID) == "function") then return end
  local ok, item = pcall(C_Item.GetItemID, where)
  item = ok and plain(item) or nil
  length, quantity = tonumber(plain(length)), tonumber(plain(quantity))
  local hours = length and HOURS[length] or nil
  if type(item) ~= "number" or not hours or not quantity or quantity < 1 then return end
  -- (a post put up by the piece asks a price for one; an auction a buyout for each thing in it)
  local price = tonumber(plain(byPiece and a4 or a5)) or 0
  local deposit = nil
  if C_AuctionHouse then
    local okD, d
    if byPiece and type(C_AuctionHouse.CalculateCommodityDeposit) == "function" then okD, d = pcall(C_AuctionHouse.CalculateCommodityDeposit, item, length, quantity)
    elseif not byPiece and type(C_AuctionHouse.CalculateItemDeposit) == "function" then okD, d = pcall(C_AuctionHouse.CalculateItemDeposit, where, length, quantity) end
    if okD then deposit = tonumber(plain(d)) end
  end
  local name, vendor = Facts(item)
  local now = type(GetTime) == "function" and GetTime() or 0
  -- (a post the game never answered is not waited for behind a new one)
  for i = #pending, 1, -1 do if now - pending[i].at > WAIT then table.remove(pending, i) end end
  pending[#pending + 1] = { item = item, name = name, each = byPiece and quantity or 1, left = byPiece and 1 or quantity, count = byPiece and 1 or quantity, hours = hours, price = price, deposit = deposit, vendor = vendor, at = now }
end

local function Created(id)
  id = plain(id)
  if type(id) ~= "number" then return end
  local now = type(GetTime) == "function" and GetTime() or 0
  while pending[1] and now - pending[1].at > WAIT do table.remove(pending, 1) end
  local p = pending[1]
  if not p then return end
  p.left = p.left - 1
  if p.left <= 0 then table.remove(pending, 1) end
  local s = Sales()
  if type(s.up[id]) == "table" then return end
  local deposit = p.deposit and floor(p.deposit / p.count + 0.5) or 0
  local side, how = Side(p.deposit and p.deposit / p.count or nil, p.vendor, p.each, p.hours)
  local a = { item = p.item, name = p.name, q = p.each, hours = p.hours, price = p.price, deposit = deposit, vendor = p.vendor, t = Now(), side = side, how = how, house = HouseKey(side), who = Who() }
  -- (no more kept than a player can have up: the oldest go first)
  local n, oldest, oldestId = 0, nil, nil
  for key, rec in pairs(s.up) do n = n + 1 ; local t = type(rec) == "table" and tonumber(rec.t) or 0 ; if not oldest or t < oldest then oldest, oldestId = t, key end end
  if n >= OPEN_MOST and oldestId then s.up[oldestId] = nil end
  s.up[id] = a
  Tally(a, "p", { ask = a.price * a.q, dep = deposit })
  -- what the house asked: the deposit against what a vendor pays for the things
  if deposit >= DEPOSIT_LEAST and a.vendor > 0 then Took(side, a.hours, "dep", deposit, a.vendor * a.q) end
  if shared.AdviceStamp then shared.AdviceStamp() end
end

-- ---- what the game says became of it ------------------------------------------------------------------
local function Notice(kind, _, id)
  kind, id = plain(kind), plain(id)
  local e = Enum and Enum.AuctionHouseNotification
  if type(e) ~= "table" or type(id) ~= "number" or kind == nil then return end
  if kind == e.AuctionSold then Done(id, "s")
  elseif kind == e.AuctionExpired then Done(id, "x")
  elseif kind == e.AuctionRemoved then Done(id, "c") end
end

-- Your auctions, as the auction house lists them: one marked as sold is sold.
local function Owned()
  if not (C_AuctionHouse and type(C_AuctionHouse.GetOwnedAuctions) == "function") then return end
  local ok, list = pcall(C_AuctionHouse.GetOwnedAuctions)
  if not ok or type(list) ~= "table" or secret(list) or (issecrettable ~= nil and issecrettable(list)) then return end
  local sold = Enum and Enum.AuctionStatus and Enum.AuctionStatus.Sold
  local s = Sales()
  for i = 1, #list do
    local info = list[i]
    if type(info) == "table" then
      local id, status = plain(info.auctionID), plain(info.status)
      local a = type(id) == "number" and s.up[id] or nil
      if type(a) == "table" then
        if sold ~= nil and status == sold then
          local paid = tonumber(plain(info.buyoutAmount)) or tonumber(plain(info.bidAmount))
          Done(id, "s", paid and paid > 0 and paid or nil)
        end
      end
    end
  end
end

-- A letter is told by what it says and when it goes (the game gives letters no numbers): true
-- the first time one is seen, false ever after. Letters that have gone are forgotten.
local function Letter(sign, daysLeft)
  local s = Sales()
  local now = Now()
  local goes = now + (tonumber(daysLeft) or 0) * 86400
  for key, list in pairs(s.mail) do
    if type(list) ~= "table" then s.mail[key] = nil
    else
      for i = #list, 1, -1 do if type(list[i]) ~= "number" or list[i] < now - 86400 then table.remove(list, i) end end
      if #list == 0 then s.mail[key] = nil end
    end
  end
  local list = s.mail[sign]
  if type(list) ~= "table" then list = {} ; s.mail[sign] = list end
  for i = 1, #list do if math.abs(list[i] - goes) < 900 then return false end end
  list[#list + 1] = floor(goes)
  return true
end

-- The oldest of your auctions still noted as up of a thing of that name (and, where given, at that price for all of it).
local function Open(name, paid, ended)
  local s = Sales()
  local me = Who()
  local found, foundId = nil, nil
  for pass = 1, 2 do
    for id, a in pairs(s.up) do
      if type(a) == "table" and a.who == me and a.name == name
        and (pass == 2 or not paid or (tonumber(a.price) or 0) * (tonumber(a.q) or 1) == paid)
        and (not ended or Now() >= (tonumber(a.t) or 0) + (tonumber(a.hours) or 0) * 3600 - 300)
        and (not found or (tonumber(a.t) or 0) < (tonumber(found.t) or 0)) then found, foundId = a, id end
    end
    if found then break end
  end
  return found, foundId
end

-- A pattern out of one of the game's own texts with a "%s" in it: what stands for the %s is caught.
local function Catch(text)
  if type(text) ~= "string" or not string.find(text, "%s", 1, true) then return nil end
  local pattern = gsub(text, "[%^%$%(%)%.%[%]%*%+%-%?%%]", "%%%0")
  pattern = gsub(pattern, "%%%%s", "(.+)", 1)
  return "^" .. pattern .. "$"
end

-- The letters in your box: an invoice of a sale says what was paid and what the house kept; a
-- letter that an auction ran out says that.
local function Mail()
  if type(GetInboxNumItems) ~= "function" or type(GetInboxHeaderInfo) ~= "function" then return end
  local ok, count = pcall(GetInboxNumItems)
  count = ok and tonumber(plain(count)) or 0
  local expired = Catch(rawget(_G, "AUCTION_EXPIRED_MAIL_SUBJECT"))
  for i = 1, math.min(count, 100) do
    local okH, _, _, _, subject, _, _, daysLeft = pcall(GetInboxHeaderInfo, i)
    subject, daysLeft = okH and plain(subject) or nil, okH and plain(daysLeft) or nil
    local invoice = nil
    if type(GetInboxInvoiceInfo) == "function" then
      local okI, kind, name, _, bid, _, deposit, cut = pcall(GetInboxInvoiceInfo, i)
      if okI and plain(kind) == "seller" and type(plain(name)) == "string" then invoice = { name = name, bid = tonumber(plain(bid)) or 0, deposit = tonumber(plain(deposit)) or 0, cut = tonumber(plain(cut)) or 0 } end
    end
    if invoice and invoice.bid > 0 and type(daysLeft) == "number" then
      if Letter(format("s:%s:%d:%d", invoice.name, invoice.bid, invoice.cut), daysLeft) then
        local a, id = Open(invoice.name, invoice.bid, false)
        if a then
          Done(id, "s", invoice.bid - invoice.cut)
          -- what the house kept of the sale
          if invoice.cut > 0 and invoice.bid >= 100 then Took(a.side, "cut", "cut", invoice.cut, invoice.bid) end
        end
      end
    elseif expired and type(subject) == "string" and type(daysLeft) == "number" then
      local name = match(subject, expired)
      if name and Letter("x:" .. name, daysLeft) then
        local a, id = Open(name, nil, true)
        if a then Done(id, "x") end
      end
    end
  end
end

-- Auctions nothing was heard of long after their time ran out: not known.
local function GiveUp()
  local s = Sales()
  local now = Now()
  for id, a in pairs(s.up) do
    if type(a) ~= "table" or now > (tonumber(a.t) or 0) + (tonumber(a.hours) or 0) * 3600 + GIVE_UP then
      if type(a) == "table" then Done(id, "u") else s.up[id] = nil end
    end
  end
end

do
  local frame = CreateFrame("Frame", "AzerothAtlasSalesWatch")
  frame:SetScript("OnEvent", function(_, event, ...)
    if event == "AUCTION_HOUSE_AUCTION_CREATED" then shared.Try("an auction of yours, put up", Created, ...)
    elseif event == "AUCTION_CANCELED" then local id = plain((...)) ; if type(id) == "number" then shared.Try("an auction of yours, taken down", Done, id, "c") end
    elseif event == "AUCTION_HOUSE_AUCTIONS_EXPIRED" then local id = plain((...)) ; if type(id) == "number" then shared.Try("an auction of yours, run out", Done, id, "x") end
    elseif event == "AUCTION_HOUSE_SHOW_FORMATTED_NOTIFICATION" then shared.Try("an auction of yours, a notice", Notice, ...)
    elseif event == "OWNED_AUCTIONS_UPDATED" then shared.Try("your auctions, as the house lists them", Owned)
    elseif event == "MAIL_INBOX_UPDATE" or event == "MAIL_SHOW" then shared.Try("your auctions, by mail", Mail)
    elseif event == "PLAYER_LOGIN" then shared.Try("your auctions, the old ones", GiveUp) end
  end)
  -- (registered one at a time: a name this game does not have must not stop the rest)
  for _, event in ipairs({ "AUCTION_HOUSE_AUCTION_CREATED", "AUCTION_CANCELED", "AUCTION_HOUSE_AUCTIONS_EXPIRED", "AUCTION_HOUSE_SHOW_FORMATTED_NOTIFICATION", "OWNED_AUCTIONS_UPDATED", "MAIL_INBOX_UPDATE", "MAIL_SHOW", "PLAYER_LOGIN" }) do pcall(frame.RegisterEvent, frame, event) end
end

-- What you put up is told from the calls the auction house's window makes (they are only
-- listened to: the hook runs after the game's own function, and changes nothing of it).
local hooked = false
if type(hooksecurefunc) == "function" and type(C_AuctionHouse) == "table" then
  local one = type(C_AuctionHouse.PostItem) == "function" and pcall(hooksecurefunc, C_AuctionHouse, "PostItem", function(...) shared.Try("an auction of yours, sent", Posted, false, ...) end)
  local two = type(C_AuctionHouse.PostCommodity) == "function" and pcall(hooksecurefunc, C_AuctionHouse, "PostCommodity", function(...) shared.Try("a listing of yours, sent", Posted, true, ...) end)
  hooked = (one or two) and true or false
end
shared.Log(hooked and "sales: your own auctions are noted as you put them up" or "sales: this game has no way for an addon to see an auction being put up: your own are not noted")

-- ---- for the tooltip, and /atlas advice ----------------------------------------------------------------
-- Your own auctions of an item at a house, all lengths together: { p, s, x, c } - or nothing.
function shared.SalesOf(item, house)
  local sales = DB().sales
  if type(sales) ~= "table" or type(sales.n) ~= "table" or type(house) ~= "string" then return nil end
  local out = nil
  for i = 1, #HOURS do
    local rec = sales.n[house .. ":" .. tostring(item) .. ":" .. tostring(HOURS[i])]
    if type(rec) == "table" then
      out = out or { p = 0, s = 0, x = 0, c = 0 }
      out.p, out.s, out.x, out.c = out.p + (tonumber(rec.p) or 0), out.s + (tonumber(rec.s) or 0), out.x + (tonumber(rec.x) or 0), out.c + (tonumber(rec.c) or 0)
    end
  end
  return out
end

-- In a sentence or two: how many of your auctions are counted, and what the houses took of you.
function shared.SalesSay()
  local sales = DB().sales
  if type(sales) ~= "table" then return hooked and "Your own auctions are noted as you put them up (none yet). " or "" end
  local p, s, x, c, up = 0, 0, 0, 0, 0
  for _, rec in pairs(type(sales.n) == "table" and sales.n or {}) do
    if type(rec) == "table" then p, s, x, c = p + (tonumber(rec.p) or 0), s + (tonumber(rec.s) or 0), x + (tonumber(rec.x) or 0), c + (tonumber(rec.c) or 0) end
  end
  for _ in pairs(type(sales.up) == "table" and sales.up or {}) do up = up + 1 end
  if p == 0 and up == 0 then return hooked and "Your own auctions are noted as you put them up (none yet). " or "" end
  local text = format("Your own auctions: %d put up, %d sold, %d run out, %d taken down, %d still up. ", p, s, x, c, up)
  local parts = {}
  for _, side in ipairs({ "own", "neutral" }) do
    local name = side == "own" and "your side's house" or "the neutral house"
    for i = 1, #HOURS do
      local rec = type(sales.cost) == "table" and sales.cost[side .. ":" .. tostring(HOURS[i])] or nil
      if type(rec) == "table" and (tonumber(rec.n) or 0) >= LEAST and (tonumber(rec.ven) or 0) > 0 then parts[#parts + 1] = format("%s asked %.0f%% of the vendor's price as the deposit for %d h", name, rec.dep / rec.ven * 100, HOURS[i]) end
    end
    local rec = type(sales.cost) == "table" and sales.cost[side .. ":cut"] or nil
    if type(rec) == "table" and (tonumber(rec.n) or 0) >= LEAST and (tonumber(rec.bid) or 0) > 0 then parts[#parts + 1] = format("%s kept %.1f%% of a sale", name, rec.cut / rec.bid * 100) end
  end
  if #parts > 0 then text = text .. "Seen so far: " .. table.concat(parts, "; ") .. ". " end
  return text
end

-- (for the tests)
function shared.SalesPeek() return Sales(), pending, hooked end
