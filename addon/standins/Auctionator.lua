-- Azeroth Atlas: the auction prices the 3D map keeps, for the addons that ask Auctionator.
--
-- Other addons ask Auctionator what an item costs at the auction house: a profession planner
-- costing a recipe, a bag addon pricing your loot, TradeSkillMaster's "AtrValue". The 3D map
-- keeps the prices of your auction house itself, read once an hour from the game's own auction
-- lists (its Auction prices page shows the same ones), so nobody has to scan the auction house
-- for those addons to have prices. This file hands them on, in one of two ways - it is the same
-- file in both, and finds out which by whether an Auctionator is there when it runs:
--
--   There is no Auctionator.  It is the file of a folder named Auctionator (put there by the
--       box "Auctionator" on the map's page), and answers in Auctionator's place. A stand-in
--       and no more: it has no auction window, sells nothing and scans nothing. It answers the
--       questions the installed addons were seen to ask, by the names they ask them under.
--
--   Auctionator itself is there.  It is the file of a small addon of the map's own beside it
--       (AzerothAtlas_Prices), loaded after Auctionator, and nothing of Auctionator's is
--       changed on the disk. Auctionator's four price questions are answered through: the
--       map's price is told where Auctionator has none, or where the map's was read no longer
--       ago than Auctionator last saw the item; otherwise Auctionator's own is. Its window,
--       its scans, its shopping lists and everything else are its own, as before. With that
--       small addon switched off, Auctionator is as its makers published it.
--
-- None of Auctionator's own code is in it: both ways go by the names other addons call.
--
-- The prices are not in this file. The map writes them into a file of their own (prices.lua,
-- beside this one), which the game loads first; they are as fresh as the last time the game
-- loaded its addons (when it started, or /reload) with the map running.
--
--   Auctionator.API.v1.GetAuctionPriceByItemID(caller, itemID)     copper for one, or nil
--   Auctionator.API.v1.GetAuctionPriceByItemLink(caller, link)     the same, by an item's link
--   Auctionator.API.v1.GetAuctionAgeByItemID / ...ByItemLink       days since the price was read
-- and, as the stand-in only:
--   Auctionator.API.v1.RegisterForDBUpdate(caller, fn)             fn() when the prices change
--   Auctionator.API.v1.ConvertToSearchString(caller, term)         a line of a shopping list
--   Auctionator.API.v1.CreateShoppingList(caller, name, lines)     kept, and said in the chat
--   Auctionator.SavedState.TimeOfLastBrowseScan                    when the prices were read
--
-- A price is the lowest anybody asked for one piece when the list was read: what Auctionator's
-- own would be straight after a scan. An item nobody was selling then has none.
--
--   /dump AzerothAtlasPricesState()      which of the two ways this is, and what it has
local ADDON = ...

local type, tonumber, tostring, pcall, error, floor = type, tonumber, tostring, pcall, error, math.floor

-- ---- which of the two ways ---------------------------------------------------------------------
local had = rawget(_G, "Auctionator")
local real = type(had) == "table" and not had.AzerothAtlasStandIn and had or nil
-- (run a second time, a folder of each kind being in the game for a moment: once is enough)
if real and real.AzerothAtlasRouted then return end

-- ---- the prices ------------------------------------------------------------------------------
-- AzerothAtlasPrices = { v, house, name, side, realm, t, low = { [item] = copper }, going = {...},
--                        names = { [item] = its name } }       (server/prices.js writes it)
local data = rawget(_G, "AzerothAtlasPrices")
if type(data) ~= "table" or type(data.low) ~= "table" or type(data.t) ~= "number" then data = nil end

-- Are they this character's auction house's? An auction house belongs to one side of one kind
-- of realm, and the map keeps the one you chose on its page. Asked of the game once it can say
-- (the side is not known before the character is in the world).
local REALMS = { ["PvP"] = true, ["Normal"] = true, ["Roleplay"] = true, ["Roleplay PvP"] = true }
local mine       -- true or false once known
local early      -- somebody asked before it was known
local function Mine()
  if mine ~= nil then return mine end
  if not data then mine = false return false end
  if data.side == "alliance" or data.side == "horde" then
    local side = UnitFactionGroup and UnitFactionGroup("player")
    if type(side) ~= "string" or side == "" then early = true return false end
    if side:lower() ~= data.side then mine = false return false end
  end
  -- (this game names its realms after their rules; where the name is something else, it says nothing)
  local realm = GetRealmName and GetRealmName()
  if type(data.realm) == "string" and type(realm) == "string" and REALMS[realm] and realm ~= data.realm then mine = false return false end
  mine = true
  return true
end

local function ItemOf(link)
  if type(link) == "number" then return link end
  if type(link) ~= "string" then return nil end
  return tonumber(link:match("item:(%d+)"))
end

local function Price(item)
  item = tonumber(item)
  if not item or not Mine() then return nil end
  local p = data.low[item]
  return type(p) == "number" and p > 0 and p or nil
end

local function Age(item)
  if not Price(item) then return nil end
  local now = time and time() or data.t
  return floor(math.max(0, now - data.t) / 86400)
end

local way = real and "through Auctionator" or "in Auctionator's place"
local routed
function AzerothAtlasPricesState()
  return { addon = ADDON, way = way, routed = routed, prices = data and true or false, house = data and data.house or nil, read = data and data.t or nil, yours = Mine() }
end

-- ---- through Auctionator itself ----------------------------------------------------------------
if real then
  -- The map's price for an item, where it is the one to tell: Auctionator has none (price: what
  -- it answered), or it cannot say how old its own is, or the map's was read no longer ago.
  local function Ours(item, price, age)
    local ours = Price(item)
    if not ours then return nil end
    local ourAge = Age(item)
    if type(price) ~= "number" or type(age) ~= "number" or ourAge <= age then return ours, ourAge end
    return nil
  end
  local function Their(fn, ...)
    if type(fn) ~= "function" then return false, nil end
    return pcall(fn, ...)
  end

  -- One pair of Auctionator's questions - what an item costs, and how old that price is -
  -- answered through. Whatever Auctionator says to a question the map has no price for is
  -- handed on as it is, a complaint of its own included.
  local function Through(api, priceName, ageName, toItem)
    local theirPrice, theirAge = api[priceName], api[ageName]
    api[priceName] = function(caller, what, ...)
      local ok, price = Their(theirPrice, caller, what, ...)
      local age
      if ok and type(price) == "number" then
        local did, a = Their(theirAge, caller, what)
        if did then age = a end
      end
      local ours = Ours(toItem(what), ok and price or nil, age)
      if ours then return ours end
      if not ok and type(theirPrice) == "function" then error(price, 0) end
      return price
    end
    api[ageName] = function(caller, what, ...)
      local ok, age = Their(theirAge, caller, what, ...)
      local did, price = Their(theirPrice, caller, what)
      local ours, ourAge = Ours(toItem(what), did and price or nil, ok and age or nil)
      if ours then return ourAge end
      if not ok and type(theirAge) == "function" then error(age, 0) end
      return age
    end
  end

  local function Route()
    if routed then return true end
    local api = type(real.API) == "table" and real.API.v1
    if type(api) ~= "table" or type(api.GetAuctionPriceByItemID) ~= "function" then return false end
    Through(api, "GetAuctionPriceByItemID", "GetAuctionAgeByItemID", tonumber)
    Through(api, "GetAuctionPriceByItemLink", "GetAuctionAgeByItemLink", ItemOf)
    real.AzerothAtlasRouted = 1
    routed = true
    return true
  end

  -- (an Auctionator that sets its questions up later than its files are read: tried again once the character is in the world)
  if not Route() and type(CreateFrame) == "function" then
    local frame = CreateFrame("Frame")
    frame:RegisterEvent("PLAYER_LOGIN")
    frame:SetScript("OnEvent", function(self)
      self:UnregisterAllEvents()
      Route()
    end)
  end
  return
end

-- ---- in Auctionator's place ----------------------------------------------------------------------
local A = { AzerothAtlasStandIn = 1, API = { v1 = {} }, SavedState = {} }
_G.Auctionator = A
local api = A.API.v1
if data then A.SavedState.TimeOfLastBrowseScan = data.t end

function api.GetAuctionPriceByItemID(_, item) return Price(item) end
function api.GetAuctionPriceByItemLink(_, link) return Price(ItemOf(link)) end
function api.GetAuctionAgeByItemID(_, item) return Age(item) end
function api.GetAuctionAgeByItemLink(_, link) return Age(ItemOf(link)) end

-- ---- told when the prices change --------------------------------------------------------------
-- They change only when the game loads its addons anew, so there is little to tell: only whoever
-- asked before this character's side was known, and was told "no price" for that reason alone.
local listeners = {}
function api.RegisterForDBUpdate(_, fn)
  if type(fn) == "function" then listeners[#listeners + 1] = fn end
end
local function Tell()
  for i = 1, #listeners do pcall(listeners[i]) end
end

-- ---- shopping lists ----------------------------------------------------------------------------
-- There is no shopping window here. A list an addon sends is kept for as long as the game runs,
-- and said in the chat with what each thing costs, so that it is not lost on the way.
local SEP = "\031"
local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end

function api.ConvertToSearchString(_, term)
  if type(term) ~= "table" or type(term.searchString) ~= "string" or term.searchString == "" then return nil end
  local many = tonumber(term.quantity) or 0
  return term.searchString .. SEP .. (many > 0 and floor(many) or "")
end

local byName
local function ItemNamed(name)
  if not (data and type(data.names) == "table") then return nil end
  if not byName then
    byName = {}
    for item, n in pairs(data.names) do if type(n) == "string" then byName[n:lower()] = item end end
  end
  return byName[name:lower()]
end

local function Money(copper)
  copper = floor(copper + 0.5)
  if type(GetCoinTextureString) == "function" then
    local ok, text = pcall(GetCoinTextureString, copper)
    if ok and type(text) == "string" then return text end
  end
  local g, s, c = floor(copper / 10000), floor(copper / 100) % 100, copper % 100
  return (g > 0 and (g .. "g ") or "") .. ((g > 0 or s > 0) and (s .. "s ") or "") .. c .. "c"
end

local MOST = 12 -- lines of a list said in the chat
A.AzerothAtlasLists = {}
local explained
function api.CreateShoppingList(_, name, lines)
  if type(name) ~= "string" or type(lines) ~= "table" then return end
  local list, total, unpriced = {}, 0, 0
  for i = 1, #lines do
    local line = lines[i]
    if type(line) == "string" then
      local what, many = line:match("^(.-)" .. SEP .. "(%d*)$")
      what = what or line
      many = tonumber(many)
      local price = Price(ItemNamed(what))
      list[#list + 1] = { name = what, quantity = many, price = price }
      if price then total = total + price * (many or 1) else unpriced = unpriced + 1 end
    end
  end
  A.AzerothAtlasLists[name] = list
  if not explained then
    explained = true
    say("this is Azeroth Atlas answering in Auctionator's place: it gives prices, and has no shopping window. A list sent to it is said here instead.")
  end
  say(("\"%s\": %d %s%s"):format(name, #list, #list == 1 and "thing" or "things",
    total > 0 and (", about " .. Money(total) .. (unpriced > 0 and (" without the " .. unpriced .. " nobody is selling") or "")) or ""))
  for i = 1, math.min(#list, MOST) do
    local e = list[i]
    print(("   %s%s%s"):format(e.quantity and (e.quantity .. " x ") or "", e.name,
      e.price and ("  |cffaaaaaa" .. Money(e.price) .. " each|r") or "  |cffaaaaaa(none for sale when the prices were read)|r"))
  end
  if #list > MOST then print(("   ... and %d more"):format(#list - MOST)) end
end

-- ---- once the character is in the world ---------------------------------------------------------
if type(CreateFrame) == "function" then
  local frame = CreateFrame("Frame")
  frame:RegisterEvent("PLAYER_LOGIN")
  frame:SetScript("OnEvent", function(self)
    self:UnregisterAllEvents()
    local asked = early
    early = nil
    if asked and Mine() then Tell() end
  end)
end
