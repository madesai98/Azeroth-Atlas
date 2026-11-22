-- Azeroth Atlas: where the game's own interface is on the screen.
--
-- The 3D map can be drawn over the game (the application's overlays). Drawn so, it lies over
-- everything: your bags, your action bars, the window of a merchant. It can be set to lie
-- BEHIND the game's interface instead - which no window can really do, being another program's:
-- what it does is leave open every part of itself where the game's interface is, so that the
-- interface shows through and takes its clicks. For that it has to know where the interface
-- is, and that is what is said here, through the strip: the rectangles of the screen in which
-- the game draws its interface - its bars and frames, the minimap, the chat, and every window
-- that is open (the game's own and other addons' alike).
--
-- How they are found. Everything of the interface hangs under one frame (UIParent). What hangs
-- there is looked at, a few times a second: what is not shown, or faded out, is passed over;
-- a thing that takes the mouse, or draws something of its own, or is no plain frame (the chat,
-- the minimap), is a rectangle of the interface, as it lies on the screen; a plain frame that
-- only holds others is looked into, three deep. A thing that fills most of the screen is looked
-- into too, and taken whole only where it is a window (it takes the mouse and draws: the
-- game's map made big). Tooltips are left out: they are gone before the map could make room.
-- Rectangles that touch or lie over one another are made one where that wastes little, the
-- two dozen biggest are said, and only what was found the same twice running: a window still
-- sliding open is said where it comes to rest.
--
-- Everything here is only read - which frames there are, whether they are shown, where they
-- lie. Nothing of the interface is touched, every question is put so that a refusal cannot stop
-- the strip, and what the game keeps secret is left alone.
--
-- As messages of the kind the NPC you met goes by (AzerothAtlas.lua: T_TALK), under keys 11 to
-- 14, which a 3D map from before does not read: which edition (1 to 255), how many rectangles
-- (255: not said - you have switched it off), then six rectangles to a message, each its left,
-- top, right and bottom edge as 1023rds of the screen's width and height (ten bits each: five
-- bytes).
--
-- shared.WindowsReport()   the messages to send this round: { { key, bytes }, ... }
-- shared.WindowsSay(arg)   says what is said, or switches it ("off", "on"), for /atlas to call
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor, ceil, min, max = math.floor, math.ceil, math.min, math.max
local strchar = string.char
local EVERY = 0.4        -- seconds from one look to the next
local DEPTH = 3          -- how deep a frame that only holds others is looked into
local LEAST = 20         -- pixels: nothing narrower or lower than this is said
local BIG = 0.45         -- of the screen: a thing this big is looked into rather than taken whole
local LOOKED_MOST = 2500 -- frames looked at in one look, at the most
local FOUND_MOST = 150   -- rectangles made one of, at the most (the biggest)
local SAID_MOST = 24     -- rectangles said
local PER_MESSAGE = 6
local FIRST_KEY = 11
local STEPS = 1023       -- an edge is said as so many 1023rds of the screen
local NEAR = 3           -- ...and two rectangles this many of them apart, or less, may be made one
local WASTE = 1.3        -- ...where the one is no more than this many times the two together
local NOT_SAID = 255

local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function number(v)
  if v == nil or secret(v) or type(v) ~= "number" or v ~= v then return nil end
  return v
end
local function yes(v) return v ~= nil and not secret(v) and (v == true or v == 1) end

local screenW, screenH, unit = 0, 0, 1
local found, looked = {}, 0

-- Where something lies on the screen, in pixels from its top left corner: left, top, right,
-- bottom - or nothing (it has no place, or the game keeps it secret).
local function Place(o)
  if type(o.GetScaledRect) ~= "function" then return nil end
  local l, b, w, h = o:GetScaledRect()
  l, b, w, h = number(l), number(b), number(w), number(h)
  if not (l and b and w and h) or w <= 0 or h <= 0 then return nil end
  local x1, x2 = max(0, l * unit), min(screenW, (l + w) * unit)
  local y1, y2 = max(0, screenH - (b + h) * unit), min(screenH, screenH - b * unit)
  if x2 <= x1 or y2 <= y1 then return nil end
  return x1, y1, x2, y2
end

-- Is it to be seen: shown, and not faded out?
local function Seen(o)
  if not yes(o:IsVisible()) then return false end
  local alpha
  if type(o.GetEffectiveAlpha) == "function" then alpha = number(o:GetEffectiveAlpha())
  elseif type(o.GetAlpha) == "function" then alpha = number(o:GetAlpha()) end
  return alpha == nil or alpha > 0.1
end

-- Does a frame draw something of its own: a texture or a text of it that is to be seen?
local function Draws(frame)
  if type(frame.GetRegions) ~= "function" then return false end
  local regions = { frame:GetRegions() }
  for i = 1, #regions do
    local r = regions[i]
    if type(r) == "table" and Seen(r) then return true end
  end
  return false
end

local function Add(x1, y1, x2, y2)
  if x2 - x1 < LEAST or y2 - y1 < LEAST then return end
  found[#found + 1] = { max(0, floor(x1 / screenW * STEPS)), max(0, floor(y1 / screenH * STEPS)), min(STEPS, ceil(x2 / screenW * STEPS)), min(STEPS, ceil(y2 / screenH * STEPS)) }
end

local Look
local function Into(frame, depth)
  if depth >= DEPTH or type(frame.GetChildren) ~= "function" then return end
  local kids = { frame:GetChildren() }
  for i = 1, #kids do
    if looked > LOOKED_MOST then return end
    -- (one frame that will not be asked about does not stop the look at the others)
    if type(kids[i]) == "table" then pcall(Look, kids[i], depth + 1) end
  end
end
Look = function(frame, depth)
  looked = looked + 1
  if type(frame.IsForbidden) == "function" and frame:IsForbidden() then return end
  if not Seen(frame) then return end
  local kind = type(frame.GetObjectType) == "function" and frame:GetObjectType() or "Frame"
  if kind == "GameTooltip" then return end
  local x1, y1, x2, y2 = Place(frame)
  -- (a frame with no place of its own may still hold things that have one)
  if not x1 then return Into(frame, depth) end
  local mouse = type(frame.IsMouseEnabled) == "function" and yes(frame:IsMouseEnabled())
  local solid = mouse or kind ~= "Frame" or Draws(frame)
  local big = (x2 - x1) * (y2 - y1) > BIG * screenW * screenH
  if solid and not big then
    Add(x1, y1, x2, y2)
    return
  end
  -- (a window that fills the screen: it takes the mouse, and it draws)
  if big and mouse and (kind ~= "Frame" or Draws(frame)) then
    Add(x1, y1, x2, y2)
    return
  end
  Into(frame, depth)
end

local function Area(r) return (r[3] - r[1]) * (r[4] - r[2]) end
local function Bigger(a, b) return Area(a) > Area(b) end
local function Before(a, b)
  if a[2] ~= b[2] then return a[2] < b[2] end
  if a[1] ~= b[1] then return a[1] < b[1] end
  if a[4] ~= b[4] then return a[4] < b[4] end
  return a[3] < b[3]
end

-- The rectangles found, fewer: those that touch or lie over one another made one, where the one
-- is not much more than the two; then the biggest of them, in the order they lie on the screen.
local function Fewer(list)
  table.sort(list, Bigger)
  while #list > FOUND_MOST do list[#list] = nil end
  local changed, passes = true, 0
  while changed and passes < 4 do
    changed, passes = false, passes + 1
    local i = 1
    while i <= #list do
      local a = list[i]
      local j = i + 1
      while j <= #list do
        local b = list[j]
        local one = false
        if b[1] <= a[3] + NEAR and a[1] <= b[3] + NEAR and b[2] <= a[4] + NEAR and a[2] <= b[4] + NEAR then
          local x1, y1, x2, y2 = min(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4])
          if (x2 - x1) * (y2 - y1) <= (Area(a) + Area(b)) * WASTE then
            a[1], a[2], a[3], a[4] = x1, y1, x2, y2
            one = true
          end
        end
        if one then table.remove(list, j); changed = true else j = j + 1 end
      end
      i = i + 1
    end
  end
  table.sort(list, Bigger)
  while #list > SAID_MOST do list[#list] = nil end
  table.sort(list, Before)
  return list
end

-- A rectangle as five bytes: four edges of ten bits each, one after the other. (Byte by byte,
-- in small numbers: all forty bits in one number would be more than some Luas count whole.)
local function Bytes(r)
  local a, b, c, d = r[1], r[2], r[3], r[4]
  return strchar(floor(a / 4), (a % 4) * 64 + floor(b / 16), (b % 16) * 16 + floor(c / 64), (c % 64) * 4 + floor(d / 256), d % 256)
end

local function Off() return type(AzerothAtlasDB) == "table" and AzerothAtlasDB.noWindows == true end

-- ---- looked at, a few times a second ---------------------------------------------------------------
local state = { last = nil, said = nil, gen = 0, count = 0, at = 0, freshAt = -100, messages = {}, turn = 0, fresh = false, looked = 0, error = nil }

local function Build()
  local out, said, n = {}, state.said or "", state.count
  for chunk = 0, max(0, floor((n - 1) / PER_MESSAGE)) do
    out[#out + 1] = { FIRST_KEY + chunk, strchar(state.gen, n) .. string.sub(said, chunk * PER_MESSAGE * 5 + 1, (chunk + 1) * PER_MESSAGE * 5) }
  end
  state.messages = out
end

local function LookNow()
  local sw, sh
  if GetPhysicalScreenSize then sw, sh = GetPhysicalScreenSize() end
  sw, sh = number(sw), number(sh)
  local root = _G.UIParent
  if not (sw and sh and sw > 0 and sh > 0) or type(root) ~= "table" then return end
  -- (the interface is 768 units high whatever the screen is: so many pixels to a unit)
  screenW, screenH, unit = sw, sh, sh / 768
  found, looked = {}, 0
  Into(root, 0)
  state.looked = looked
  local list = Fewer(found)
  local parts = {}
  for i = 1, #list do parts[i] = Bytes(list[i]) end
  local now = table.concat(parts)
  -- (said only where it was found the same twice running: a window sliding open is said once it has stopped)
  if now == state.last and now ~= state.said then
    state.said, state.count = now, #list
    state.gen = state.gen % 250 + 1
    state.fresh = true
    Build()
    -- (the map is waiting for it: the round of the strip begins again, with this at its head - once a second at the most)
    local t = GetTime()
    if shared.SayNow and t - state.freshAt >= 1 then state.freshAt = t; shared.SayNow() end
  end
  state.last = now
end

if type(CreateFrame) == "function" then
  local frame = CreateFrame("Frame")
  frame:SetScript("OnUpdate", function(_, elapsed)
    state.at = state.at + (number(elapsed) or 0)
    if state.at < EVERY then return end
    state.at = 0
    if Off() then return end
    local ok, err = pcall(LookNow)
    if not ok and err ~= state.error then
      state.error = err
      if shared.Log then shared.Log("where the game's interface is could not be looked at: " .. tostring(err)) end
    end
  end)
end

function shared.WindowsReport()
  if Off() then return { { FIRST_KEY, strchar(0, NOT_SAID) } } end
  local messages = state.messages
  if #messages == 0 then return nil end
  -- (another edition: all of it, now. Otherwise a message of it a round, in turn - for a map that has just begun to listen)
  if state.fresh then
    state.fresh = false
    return messages
  end
  state.turn = state.turn % #messages + 1
  return { messages[state.turn] }
end

function shared.WindowsSay(arg)
  arg = type(arg) == "string" and string.lower(arg) or ""
  if arg == "off" or arg == "on" then
    if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
    AzerothAtlasDB.noWindows = (arg == "off") or nil
    state.last, state.said, state.count, state.messages = nil, nil, 0, {}
  end
  local words
  if Off() then
    words = "where the game's interface is on the screen is not said to the 3D map (/atlas windows on says it again). A map drawn behind the interface then lies over it."
  elseif not state.said then
    words = "where the game's interface is on the screen is said to the 3D map, for the map drawn behind it; nothing has been found yet (it is looked for every " .. EVERY .. " seconds)."
  else
    words = "where the game's interface is on the screen is said to the 3D map, for the map drawn behind it: " .. state.count .. " rectangles just now, of " .. state.looked .. " frames looked at (/atlas windows off stops it)."
  end
  print("|cff7fd4ffAzeroth Atlas|r: " .. words)
end
