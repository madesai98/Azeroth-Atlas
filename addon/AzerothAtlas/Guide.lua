-- Azeroth Atlas: following the route in the game.
--
-- Route.lua brings the 3D map's route into the game and draws it on the world map and the
-- minimap. This file is what you follow it by:
--   the arrow      in the middle of the screen: which way the route goes from where you stand,
--                  how far it is to the end of the step you are on, and what that step is;
--   the routes     listed, each as things to do, the one you are on first ("Walk to Sentinel
--                  Hill's flight master", "Fly to Stormwind", "Walk to your map pin"). The list
--                  hangs under Questie's quest list, in Questie's own letters, as a part of it:
--                  "Routes", a name for each route (a click on it folds its steps away), and
--                  beside the header your hearthstone, to leave it out of routes or not;
--   the question   where the spot you are heading for has more than one level (a street and
--                  the floor above it), which of them you mean. Put to you by itself only for
--                  a pin you set on the game's map with the mouse - not for one a guide or
--                  any other addon set, which is where that addon means it. Its window has a
--                  cross to close it by, goes where you drag it, and a box to tick so as
--                  never to be asked (/atlas ask, and the options, are that same switch);
--   Shift-click    on the world map: a quick waypoint there, no question asked - it goes to
--                  the level nearest your own height.
--
-- /atlas arrow, /atlas list   each on or off
-- /atlas arrow unlock, lock     the arrow can be dragged with the mouse at any time, or stays put (and clicks go through it)
-- /atlas pin                    the step list under Questie's quest list, or on its own
-- /atlas move                   drag the two where you want them (again: done)
-- /atlas reset                  back where they were
-- /atlas level                  the question about the level, again
-- /atlas ask                    whether that question is put by itself (for a pin of your own hand), or only when you ask

local shared = AzerothAtlas
if type(shared) ~= "table" or type(shared.Route) ~= "function" then return end

local floor, sqrt, abs, pi, exp = math.floor, math.sqrt, math.abs, math.pi, math.exp
local atan2 = math.atan2 or math.atan
local format = string.format

local BREAK = 8               -- (as in Route.lua) kind flag: this point starts a new stretch
local F_TAXI = 16             -- (as in AzerothAtlas.lua) player flag: on a flight path
local LOOK = 12               -- yards further along the route that the arrow points at
local RADIUS = 30             -- how far from the middle the arrow's head circles
local BEHIND, AHEAD = 120, 100 -- degrees off your facing: the head dims past the first, and brightens again within the second
local EASE = 14               -- how quickly the head swings round (per second)
local ROWS = 8                -- steps listed at most, of the route that leads
local OTHER_ROWS = 5          -- ...and of each of the others
local LIST_W = 270            -- how wide the step list may get where it stands on its own
-- (as Questie lays out its quest list: its header's mark and its lines from the left edge, and
-- the room it keeps on the right)
local HEAD_X, LINE_X, RIGHT = 6, 10, 10
local BESIDE = 8              -- the room between Questie's list and the step list where it has to stand beside it
local ARROW_AT = { "TOP", 0, -110 }
local LIST_AT = { "TOPRIGHT", -255, -250 }
local ASK_AT = { "TOP", 0, -240 } -- (the question about the level: until you drag it somewhere else)

local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end
local function Settings()
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  return AzerothAtlasDB
end
local function Clock(s)
  s = floor((s or 0) + 0.5)
  if s < 0 then s = 0 end
  if s >= 3600 then return format("%d:%02d:%02d", floor(s / 3600), floor(s / 60) % 60, s % 60) end
  return format("%d:%02d", floor(s / 60), s % 60)
end
local function Yards(d)
  if d < 0 then d = 0 end
  if d >= 1000 then return format("%.1fk yd", d / 1000) end
  return format("%d yd", floor(d + 0.5))
end

-- ---- where the frames sit, and moving them ----------------------------------------------------
local moving = false
local movers = {}
local function Place(f, key, default)
  f:ClearAllPoints()
  local at = Settings()[key]
  if type(at) == "table" and type(at[1]) == "number" and type(at[2]) == "number" then
    f:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", at[1], at[2])
  else
    f:SetPoint(default[1], UIParent, default[1], default[2], default[3])
  end
end
-- (f.free: it can be dragged at any time, with no /atlas move: the arrow, where you have unlocked
-- it in the options; the list of routes, where it is not pinned under Questie's quest list.
-- f.pinned: it is not to be dragged at all just now - the list, while it hangs under Questie's.
-- `hint`: what the pointer on it says while it is free, with a shade to show what can be dragged;
-- without one, nothing shows.)
local function Movable(f, key, default, hint)
  f:SetMovable(true)
  f:SetClampedToScreen(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self)
    if (moving or self.free) and not self.pinned then
      self.held = true
      self:StartMoving()
    end
  end)
  -- (only the left button is its own - to drag it by: turning the camera with the right one goes on through it)
  if f.SetPassThroughButtons then pcall(f.SetPassThroughButtons, f, "RightButton", "MiddleButton") end
  f:SetScript("OnDragStop", function(self)
    if not self.held then return end -- (it was not being dragged)
    self.held, self.letGo = nil, GetTime()
    self:StopMovingOrSizing()
    -- (where it stands is kept here, not by the game)
    if self.SetUserPlaced then pcall(self.SetUserPlaced, self, false) end
    local left, top = self:GetLeft(), self:GetTop()
    if left and top then
      Settings()[key] = { left, top }
      -- (held by its top left corner from here on, wherever the game hung it when it was let go:
      -- a list that gets longer then grows downwards, as it does after a /reload)
      Place(self, key, default)
    end
  end)
  -- (taken off the screen while it is being dragged: that is the end of the drag)
  f:SetScript("OnHide", function(self)
    if self.held then
      self.held = nil
      self:StopMovingOrSizing()
    end
  end)
  f:EnableMouse(moving) -- (clicks go through it to the game, except while it is being moved, or is free)
  local shade = f:CreateTexture(nil, "BACKGROUND")
  shade:SetAllPoints(f)
  shade:SetColorTexture(0.1, 0.3, 0.6, 0.45)
  if not moving then shade:Hide() end
  f:SetScript("OnEnter", function(self)
    if moving or not self.free or not hint then return end
    shade:SetAlpha(0.45)
    shade:Show()
    if GameTooltip then
      GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
      GameTooltip:AddLine("Drag to move it")
      GameTooltip:AddLine(hint, 1, 1, 1, true)
      GameTooltip:Show()
    end
  end)
  f:SetScript("OnLeave", function(self)
    if not hint then return end
    if GameTooltip then GameTooltip:Hide() end
    shade:SetAlpha(1)
    if not moving then shade:Hide() end
  end)
  f.shade, f.placeKey, f.placeDefault = shade, key, default
  movers[#movers + 1] = f
  Place(f, key, default)
end

-- A part of such a frame that takes the mouse itself (a line of the list that takes a click):
-- dragged, it drags the frame it is a part of. Only while that can be dragged (f.loose: see
-- Dragging) - otherwise a click on it is a click and nothing else, however the pointer moves.
local function Dragging(f, on)
  f.loose = on
  f:EnableMouse(on)
  for _, part in ipairs(f.parts or {}) do
    if on then part:RegisterForDrag("LeftButton") else pcall(part.RegisterForDrag, part) end
  end
end
local function DragBy(part, f)
  f.parts = f.parts or {}
  f.parts[#f.parts + 1] = part
  if f.loose then part:RegisterForDrag("LeftButton") end
  part:SetScript("OnDragStart", function()
    local go = f:GetScript("OnDragStart")
    if go then go(f) end
  end)
  part:SetScript("OnDragStop", function()
    local stop = f:GetScript("OnDragStop")
    if stop then stop(f) end
  end)
end
-- Letting go of what you dragged is not a click on the line you held it by.
local function Dragged(f)
  return f.held == true or (f.letGo ~= nil and GetTime() - f.letGo < 0.2)
end

-- A small gold diamond: the waypoint's own mark, as on the map.
local function Diamond(parent, size)
  local f = CreateFrame("Frame", nil, parent)
  f:SetSize(size, size)
  local edge = f:CreateTexture(nil, "BACKGROUND")
  edge:SetColorTexture(0, 0, 0, 0.85)
  edge:SetAllPoints(f)
  local fill = f:CreateTexture(nil, "ARTWORK")
  fill:SetColorTexture(1, 0.82, 0.1, 1)
  fill:SetPoint("TOPLEFT", f, "TOPLEFT", 2, -2)
  fill:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -2, 2)
  if edge.SetRotation then
    edge:SetRotation(pi / 4)
    fill:SetRotation(pi / 4)
  end
  return f
end

-- ---- the journey in numbers -------------------------------------------------------------------
-- Where a step's line begins: the end of the drawn step before it (or the start of the route).
local function StepStart(r, index)
  for i = index - 1, 1, -1 do
    local to = r.steps[i].to
    if to then return to end
  end
  return 1
end

-- Yards and seconds left of the step you are on (yards nil for a step with no line here).
local function StepLeft(r)
  local step = r.steps[r.cur]
  if not step then
    if r.bare then return nil, r.secs end
    local left = r.C[r.n] - r.along
    return left, r.secs
  end
  if not step.to or r.bare then return nil, step.secs end
  local from = StepStart(r, r.cur)
  local whole = r.C[step.to] - r.C[from]
  local left = r.C[step.to] - r.along
  if left < 0 then left = 0 end
  if left > whole then return left, step.secs end
  return left, whole > 0 and step.secs * left / whole or 0
end

-- A step that waits for a boat, zeppelin or tram, by what is known of that line this moment
-- (Transit.lua): the seconds the step still takes, and what to say of it ("leaves in 2:28";
-- once aboard, "arrives in 1:12"). nil for any other step, and while the line is not timed:
-- the step then keeps what the 3D map wrote when it planned the journey.
local function StepLive(step)
  local T = shared.Transit
  if not (step and step.line and T) then return nil end
  local L = T.lines[step.line]
  if not L then return nil end
  local now = T.Now()
  local riding, _, gets = T.Riding()
  if riding == L and gets then
    local left = gets - now
    if left < 0 then left = 0 end
    return left, "arrives in " .. Clock(left)
  end
  local note = T.Note(step.line, step.stop)
  local leaves = note and T.Next(L, step.stop, now)
  if not leaves then return nil end
  return leaves - now + (step.ride or 0), note
end

-- The spot LOOK yards further along the line from where you are on it: not past the end of the
-- step you are on, nor over a gap in the line.
local function AimPoint(r)
  local X, Y, K, C = r.X, r.Y, r.K, r.C
  local step = r.steps[r.cur]
  local last = step and step.to or r.n
  local i = r.at
  local want = r.along + LOOK
  -- (still at the end of the step before: from where this step's own line begins)
  local first = step and StepStart(r, r.cur) or 1
  if first < last and K[first + 1] >= BREAK then first = first + 1 end
  if i < first then i, want = first, C[first] + LOOK end
  if i >= last then return X[last], Y[last] end
  while i + 1 < last and C[i + 1] < want and K[i + 2] < BREAK do i = i + 1 end
  local a, b = C[i], C[i + 1]
  local t = b > a and (want - a) / (b - a) or 1
  if t > 1 then t = 1 elseif t < 0 then t = 0 end
  return X[i] + (X[i + 1] - X[i]) * t, Y[i] + (Y[i + 1] - Y[i]) * t
end

-- ---- the arrow ---------------------------------------------------------------------------------
local arrow = { frame = nil, angle = nil, behind = false, pointing = false, distance = "", words = "" }

-- The head, `angle` round from straight ahead (counter-clockwise, as the game counts facing).
local function DrawHead(f, angle)
  local sn, cs = math.sin(angle), math.cos(angle)
  if f.head then
    f.head:SetRotation(angle)
    f.head:ClearAllPoints()
    f.head:SetPoint("CENTER", f.mark, "CENTER", -sn * RADIUS, cs * RADIUS)
    f.head:Show()
    return
  end
  -- (a game without that picture: a chevron of two strokes)
  local tx, ty = -sn * (RADIUS + 6), cs * (RADIUS + 6)
  for side = 1, 2 do
    local a = angle + (side == 1 and 0.42 or -0.42)
    local bx, by = -math.sin(a) * (RADIUS - 8), math.cos(a) * (RADIUS - 8)
    for layer = 1, 2 do
      local line = f.wings[(side - 1) * 2 + layer]
      line:SetStartPoint("CENTER", f.mark, tx, ty)
      line:SetEndPoint("CENTER", f.mark, bx, by)
      line:Show()
    end
  end
end
local function HideHead(f)
  if f.head then f.head:Hide() end
  if f.wings then
    for i = 1, #f.wings do f.wings[i]:Hide() end
  end
end
local function HeadAlpha(f, alpha)
  if f.head then f.head:SetAlpha(alpha) end
  if f.wings then
    for i = 1, #f.wings do f.wings[i]:SetAlpha(alpha) end
  end
end

local function ArrowUpdate(f, dt)
  local r = shared.Follow()
  local p = shared.player
  if not r then
    HideHead(f)
    if moving then
      if arrow.distance ~= "move" then
        arrow.distance, arrow.words = "move", ""
        f.dist:SetText("the arrow")
        f.text:SetText("Drag it where you want it, then /atlas move again.")
      end
      DrawHead(f, 0)
      HeadAlpha(f, 1)
    end
    return
  end
  local step = r.steps[r.cur]
  local taxi = floor((p.flags or 0) / F_TAXI) % 2 == 1
  -- (a flight is not something to walk along: at the flight master, and in the air, there is no way to point)
  local pointing = not r.bare and p.world and p.map == r.map and (not step or (step.to ~= nil and not step.fly)) and not taxi
  local yards, secs = StepLeft(r)
  if pointing then
    local facing = GetPlayerFacing and GetPlayerFacing()
    if type(facing) ~= "number" or (issecretvalue and issecretvalue(facing)) then facing = nil end
    local tn, tw = AimPoint(r)
    local dn, dw = tn - p.north, tw - p.west
    if facing and dn * dn + dw * dw > 0.25 then
      -- (north is the first of the game's two numbers and west the second: an angle counted the way facing is)
      local want = (atan2(dw, dn) - facing + pi) % (2 * pi) - pi
      local now = arrow.angle or want
      local delta = (want - now + pi) % (2 * pi) - pi
      now = now + delta * (1 - exp(-EASE * (dt or 0.05)))
      arrow.angle = now
      DrawHead(f, now)
      local off = abs(want) * 180 / pi
      arrow.behind = off > BEHIND or (arrow.behind and off >= AHEAD)
      HeadAlpha(f, arrow.behind and 0.45 or 1)
    elseif not facing then
      HideHead(f)
    end
  else
    HideHead(f)
    arrow.angle = nil
  end
  arrow.pointing = pointing and true or false
  -- how far (or, for a ride, how long), and what the step is
  local distance
  if pointing and yards then
    distance = Yards(yards + (r.off > 3 and r.off or 0))
  else
    distance = Clock(secs)
  end
  local words = step and step.text or r.name or r.title or ""
  -- (a boat, zeppelin or tram that has been timed: counted down to as it really runs)
  local live, liveNote = StepLive(step)
  if live and not pointing then distance = Clock(live) end
  local note = liveNote or (step and step.note)
  if note and not pointing then words = words .. " (" .. note .. ")" end
  if distance ~= arrow.distance then
    arrow.distance = distance
    f.dist:SetText(distance)
  end
  if words ~= arrow.words then
    arrow.words = words
    f.text:SetText(words)
  end
end

local function EnsureArrow()
  if arrow.frame then return arrow.frame end
  local f = CreateFrame("Frame", "AzerothAtlasArrow", UIParent)
  f:SetSize(120, 120)
  f:SetFrameStrata("LOW")
  Movable(f, "arrowAt", ARROW_AT, "Lock it again under Esc > Options > AddOns > Azeroth Atlas (or /atlas arrow lock): clicks then go through it.")
  local mark = Diamond(f, 14)
  mark:SetPoint("CENTER", f, "CENTER", 0, 14)
  f.mark = mark
  -- the head: the game's own navigation arrow, turned; or two strokes where there is no such picture
  local head = f:CreateTexture(nil, "ARTWORK")
  local drawn = false
  if head.SetAtlas and head.SetRotation and C_Texture and C_Texture.GetAtlasInfo then
    local ok, info = pcall(C_Texture.GetAtlasInfo, "Navigation-Tracked-Arrow")
    if ok and info then drawn = pcall(head.SetAtlas, head, "Navigation-Tracked-Arrow", true) end
  end
  if drawn then
    f.head = head
  else
    head:Hide()
    f.wings = {}
    for i = 1, 4 do
      local under = i % 2 == 1
      local line = f:CreateLine(nil, under and "BACKGROUND" or "ARTWORK")
      if under then line:SetColorTexture(0, 0, 0, 0.7) else line:SetColorTexture(1, 0.82, 0.1, 1) end
      line:SetThickness(under and 6 or 3)
      line:Hide()
      f.wings[i] = line
    end
  end
  local dist = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  dist:SetPoint("TOP", mark, "CENTER", 0, -RADIUS - 14)
  f.dist = dist
  local text = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  text:SetPoint("TOP", dist, "BOTTOM", 0, -2)
  text:SetWidth(260)
  if text.SetMaxLines then text:SetMaxLines(2) end
  f.text = text
  f:SetScript("OnUpdate", function(self, dt)
    if not pcall(ArrowUpdate, self, dt) then arrow.distance, arrow.words = "", "" end
  end)
  f:Hide()
  arrow.frame = f
  return f
end

-- ---- the step list -----------------------------------------------------------------------------
-- Drawn as a part of Questie's quest list, and pinned right under it: a header in the letters of
-- Questie's own ("Routes"), and under it every route there is - the one that leads first - each
-- with its name as Questie writes a zone's, and under that its steps as Questie writes what a
-- quest asks for. A click on a route's name folds its steps away, as a click on a zone folds
-- its quests away in Questie; a click on the header folds everything away. Beside the header is
-- your hearthstone: a click on it leaves it out of every route (it is struck through then).
-- Without Questie the list stands where you put it (/atlas move). Not pinned (the options, or
-- /atlas pin) it is free: it stands on its own and is dragged with the mouse, by any part of it,
-- at any time - as Questie's own list is where that is not locked.
--
-- Questie's list is only ever asked where it is. Nothing here is anchored to it: a frame of
-- another addon's in its anchor family can leave Questie's own drag code nothing to read (as the
-- Forever addons' shared tracker column found: Questie/Questie#8076).
local list = { frame = nil, sig = "", look = nil, docked = false, place = "", tick = 0 }

local ShowAsk -- (below)

-- Questie's quest list, if the step list is to hang under it.
local function QuestieList()
  if Settings().pin == false then return nil end
  local q = rawget(_G, "Questie_BaseFrame")
  if type(q) ~= "table" or type(q.IsShown) ~= "function" or type(q.GetLeft) ~= "function" then return nil end
  return q
end

-- Where it is on the screen: left, right, top, bottom (in its own scale, from the screen's bottom
-- left corner). nil while it is not shown. Folded away, Questie's list is its header alone,
-- which stands a little above the bottom of a frame with no height left.
local function QuestieEdges(q)
  if not q:IsShown() then return nil end
  local left, right, top, bottom = q:GetLeft(), q:GetRight(), q:GetTop(), q:GetBottom()
  if left and right and top and bottom then return left, right, top, bottom end
  local head = rawget(_G, "Questie_HeaderFrame")
  if type(head) ~= "table" or type(head.GetLeft) ~= "function" or not head:IsShown() then return nil end
  left, right, top, bottom = head:GetLeft(), head:GetRight(), head:GetTop(), head:GetBottom()
  if left and right and top and bottom then return left, right, top, bottom - 5 end
  return nil
end

-- The letters Questie writes its list in, and how it lays a line out: read from its settings
-- each time, so a change made in Questie's options shows here too. The game's own where Questie
-- is not there.
local questieLayout
local function Look()
  local questie = rawget(_G, "Questie")
  local p = type(questie) == "table" and type(questie.db) == "table" and type(questie.db.profile) == "table" and questie.db.profile or {}
  local media = type(LibStub) == "table" and type(LibStub.GetLibrary) == "function" and LibStub:GetLibrary("LibSharedMedia-3.0", true) or nil
  local plain = STANDARD_TEXT_FONT or "Fonts\\FRIZQT__.TTF"
  local function font(key)
    local name = p[key]
    if media and type(name) == "string" and type(media.Fetch) == "function" then
      local ok, found = pcall(media.Fetch, media, "font", name)
      if ok and type(found) == "string" then return found end
    end
    return plain
  end
  local function number(key, default, least)
    local v = p[key]
    if type(v) ~= "number" or v < least then return default end
    return v
  end
  local look = {
    plain = plain,
    headFont = font("trackerFontHeader"), headSize = number("trackerFontSizeHeader", 12, 6),
    zoneFont = font("trackerFontZone"), zoneSize = number("trackerFontSizeZone", 12, 6),
    questFont = font("trackerFontQuest"), questSize = number("trackerFontSizeQuest", 10, 6),
    goalFont = font("trackerFontObjective"), goalSize = number("trackerFontSizeObjective", 10, 6),
    outline = type(p.trackerFontOutline) == "string" and p.trackerFontOutline or "",
    padding = number("trackerQuestPadding", 4, 0),
    ratio = number("trackerWidthRatio", 0.2, 0.05),
  }
  -- where a quest's name starts and where what it asks for does (Questie keeps room in front of
  -- them for its buttons, more or less of it as its list has them)
  look.quest = look.questSize + 5
  look.goal = look.quest + look.questSize
  if questieLayout == nil then
    -- (the part of Questie that knows, asked for once)
    questieLayout = false
    local loader = rawget(_G, "QuestieLoader")
    if type(loader) == "table" and type(loader.ImportModule) == "function" then
      local ok, layout = pcall(loader.ImportModule, loader, "TrackerLayout")
      if ok and type(layout) == "table" and type(layout.GetMargins) == "function" then questieLayout = layout end
    end
  end
  if questieLayout then
    local ok, m = pcall(questieLayout.GetMargins)
    if ok and type(m) == "table" and type(m.quest) == "number" and type(m.objective) == "number" then
      look.quest, look.goal = m.quest, m.objective
    end
  end
  -- (Questie's list on a dark ground: the same under the steps)
  local c = p.trackerBackdropColor
  if p.trackerBackdropEnabled and not p.trackerBackdropFader and type(c) == "table" then
    look.back = { tonumber(c.r) or 0, tonumber(c.g) or 0, tonumber(c.b) or 0, tonumber(c.a) or 1 }
  end
  look.sig = table.concat({ look.headFont, look.headSize, look.zoneFont, look.zoneSize, look.questFont, look.questSize, look.goalFont, look.goalSize, look.outline,
    look.padding, look.ratio, look.quest, look.goal, look.back and table.concat(look.back, ",") or "-" }, "|")
  return look
end

-- One line of the list: `words` in the letters given, `x` from the list's left edge and `y`
-- down from its top, wrapped where it would pass `limit`. Says how wide and how high it came out.
local function Line(f, row, words, font, size, look, x, y, limit, inset)
  local label = row.label
  local key = font .. "|" .. size .. "|" .. look.outline
  if row.font ~= key then
    row.font = key
    if not label:SetFont(font, size, look.outline) then label:SetFont(look.plain, size, look.outline) end
  end
  inset = inset or 0
  local room = limit - x - inset - RIGHT
  if room < 40 then room = 40 end
  label:SetWidth(room)
  label:SetText(words)
  local wide = (label.GetUnboundedStringWidth and label:GetUnboundedStringWidth()) or label:GetStringWidth() or room
  if wide > room then wide = room end
  local high = label:GetStringHeight() or size
  if high < size then high = size end
  row.x, row.y = x, y
  row:ClearAllPoints()
  row:SetPoint("TOPLEFT", f, "TOPLEFT", x, -y)
  row:SetSize(inset + wide, high)
  row:Show()
  return x + inset + wide, high
end

-- A line of the list: a frame with its words (a button, where it takes a click).
local function ListRow(f, button)
  local row = CreateFrame(button and "Button" or "Frame", nil, f)
  row:SetSize(10, 10)
  local label = row:CreateFontString(nil, "ARTWORK", "GameFontNormal")
  label:SetPoint("TOPLEFT", row, "TOPLEFT", 0, 0)
  label:SetJustifyH("LEFT")
  if label.SetJustifyV then label:SetJustifyV("TOP") end
  row.label = label
  row:Hide()
  return row
end

-- Which way a route goes from where you stand: an angle round from straight ahead (counter-
-- clockwise, as the game counts facing). nil where there is no way to point: the route is not on
-- your map, or the step you are on is not one to walk (a flight, a boat, your hearthstone), or
-- you are being flown, or the game does not say which way you face.
local function Heading(r)
  local p = shared.player
  if r.state ~= "route" or r.bare or r.n < 2 or not p.world or p.map ~= r.map then return nil end
  local step = r.steps[r.cur]
  if step and (step.to == nil or step.fly) then return nil end
  if floor((p.flags or 0) / F_TAXI) % 2 == 1 then return nil end
  local facing = GetPlayerFacing and GetPlayerFacing()
  if type(facing) ~= "number" or (issecretvalue and issecretvalue(facing)) then return nil end
  local tn, tw = AimPoint(r)
  local dn, dw = tn - p.north, tw - p.west
  if dn * dn + dw * dw <= 0.25 then return nil end
  return (atan2(dw, dn) - facing + pi) % (2 * pi) - pi
end

-- One route in the list: its name (a click on it folds its steps away, or brings them back),
-- its steps, and "+3 more" where there are more of them than are listed. Before the name, in
-- the colour its line has on the map: a small arrow that points the way that route goes from
-- where you stand (as the big arrow does for the one you follow) - or, where there is no way
-- to point, a small square.
local function ListGroup(f, rows)
  local g = { title = ListRow(f, true), rows = {}, more = ListRow(f) }
  local title = g.title
  title.mark = title:CreateTexture(nil, "ARTWORK")
  -- (the arrow: the game's own navigation arrow, its colour taken out so that it can be given the
  -- route's; a game without that picture, or that cannot do so, keeps the square)
  local point = title:CreateTexture(nil, "ARTWORK")
  local drawn = false
  if point.SetAtlas and point.SetRotation and point.SetVertexColor and point.SetDesaturated and C_Texture and C_Texture.GetAtlasInfo then
    local ok, info = pcall(C_Texture.GetAtlasInfo, "Navigation-Tracked-Arrow")
    if ok and info then drawn = pcall(point.SetAtlas, point, "Navigation-Tracked-Arrow") end
  end
  point:Hide()
  if drawn then
    point:SetDesaturated(true)
    title.arrow = point
  end
  title.label:ClearAllPoints()
  title:RegisterForClicks("LeftButtonUp")
  DragBy(title, f)
  title:SetScript("OnClick", function(self)
    if not self.key or Dragged(f) then return end
    local db = Settings()
    if type(db.shut) ~= "table" then db.shut = {} end
    db.shut[self.key] = (not db.shut[self.key]) or nil
    list.sig = ""
    if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
  end)
  for i = 1, rows do g.rows[i] = ListRow(f) end
  return g
end

-- What a waypoint with no route yet is listed as, by its kind (as AzerothAtlas.lua numbers them:
-- your guide's step, a journey of your own, a pin, a quick waypoint).
local KIND_HEAD = { "Guide step", "Journey", "Waypoint", "Waypoint" }
local KIND_KEY = { "guide", "waypoint", "waypoint", "waypoint" }

-- The arrows before the routes' names, each turned the way its route goes just now (or the
-- square shown in its place: see ListGroup). Looked at many times a second: you turn quickly.
local function ListPoint(f)
  local function one(g)
    local title = g.title
    if not title.key or not title:IsShown() then return end
    local angle = title.arrow and title.route and Heading(title.route) or nil
    if angle then
      title.arrow:SetRotation(angle)
      if title.pointing ~= true then
        title.pointing = true
        title.arrow:Show()
        title.mark:Hide()
      end
    elseif title.pointing ~= false then
      title.pointing = false
      if title.arrow then title.arrow:Hide() end
      title.mark:Show()
    end
  end
  one(f.lead)
  for _, g in ipairs(f.groups) do one(g) end
end

-- One route as the list shows it: { key, head, clock, colour, shut, rows = { { words, clock,
-- cur (the step you are on) } }, more, level, route (the route itself, for the arrow before its
-- name) }. `lead`: it is the one that leads; `limit`: steps listed at most.
local function GroupView(r, lead, limit)
  local db = Settings()
  local g = { key = r.key or (lead and (KIND_KEY[r.tk] or "waypoint")) or "route", colour = r.rc, rows = {}, route = r }
  g.shut = type(db.shut) == "table" and db.shut[g.key] == true
  -- (the quest you track, before the 3D map has said what it is called)
  g.head = r.head or r.title or (r.name and ("Journey to " .. r.name)) or (g.key == "quest" and "Tracked quest") or "Journey"
  if r.state ~= "route" then
    -- (one of the others, with no route: still being worked out, or there is no way)
    g.clock = ""
    g.rows[1] = { words = r.state == "pending" and "Working out the route..." or (r.text or "No way found."), clock = "", cur = false }
    return g
  end
  local steps = r.steps
  local count, cur = #steps, r.cur or 0
  if cur < 1 then cur = 1 end
  -- time and distance left: of the step you are on, and of the ones after it
  local secs = StepLive(steps[cur]) or select(2, StepLeft(r))
  local total = secs or 0
  for i = cur + 1, count do total = total + steps[i].secs end
  local far = nil
  if not r.bare then
    far = r.C[r.n] - (r.along or 0)
    if far < 0 then far = 0 end
  end
  g.clock = Clock(total) .. (far and (" · " .. Yards(far)) or "")
  local shown = 0
  for i = cur, count do
    if shown >= limit then break end
    shown = shown + 1
    local step = steps[i]
    -- (the step you are on, where it waits for a boat that has been timed: what is so this second)
    local note = (i == cur and select(2, StepLive(step))) or step.note
    g.rows[shown] = { words = step.text, clock = Clock(i == cur and secs or step.secs) .. (note and (" · " .. note) or ""), cur = i == cur }
  end
  local left = count - cur + 1 - shown
  if left > 0 then g.more = "+" .. left .. " more" end
  -- which level the waypoint is on, where there is a choice (click: choose again)
  if lead and r.lv then g.level = "Level: " .. (r.lv.list[r.lv.at] or "?") end
  return g
end

-- Everything the list has to say just now: { groups (the route that leads first - lead says
-- whether there is one - then the others), sig (words that change when any of it does) }.
local function ListView()
  local route, others = shared.Routes()
  local db = Settings()
  local view = { groups = {}, lead = false }
  if route then
    view.groups[1] = GroupView(route, true, ROWS)
    view.lead = true
  else
    -- a waypoint whose route is not there (yet): said, with why
    local why = shared.Waiting and shared.Waiting()
    if why then
      local kind = shared.target.kind
      local key = KIND_KEY[kind] or "waypoint"
      view.groups[1] = { key = key, head = KIND_HEAD[kind] or "Waypoint", clock = "", shut = type(db.shut) == "table" and db.shut[key] == true,
        rows = { { words = why, clock = "", cur = false } } }
      view.lead = true
    end
  end
  for _, o in ipairs(others) do
    -- (gone: the way to someone in your party who is no longer where it leads - Route.lua)
    if not o.gone then view.groups[#view.groups + 1] = GroupView(o, false, OTHER_ROWS) end
  end
  local parts = { tostring(db.listShut == true), tostring(shared.HearthOff ~= nil and shared.HearthOff() == true), tostring(view.lead) }
  for _, g in ipairs(view.groups) do
    parts[#parts + 1] = g.key .. "\1" .. g.head .. "\1" .. g.clock .. "\1" .. tostring(g.shut) .. "\1" .. tostring(g.colour) .. "\1" .. (g.more or "") .. "\1" .. (g.level or "")
    for _, row in ipairs(g.rows) do parts[#parts + 1] = row.words .. "\1" .. row.clock .. (row.cur and "*" or "") end
  end
  view.sig = table.concat(parts, "\2")
  return view
end

-- What the list says: the header ("Routes", and beside it your hearthstone: used in routes, or
-- struck through and left out of them), and under it - unless folded away - every route there
-- is: its name as Questie writes a zone's, its steps as Questie writes what a quest asks for.
-- `view`: from ListView (moving: nothing to list, and the list is shown to be dragged).
-- `limit`: how wide it may get, `least`: how wide it is at least.
local GOLD, WHITE, GREY, DIM, BLUE = "|cffffd100", "|cffeeeeee", "|cffc0c0c0", "|cffa0a0a0", "|cff80d4ff"
local function ListFill(f, view, look, limit, least, docked)
  local shut = Settings().listShut == true

  -- the header, and before it a mark (the waypoint's own) where Questie's header has Questie's,
  -- in a square as high as the letters
  local head = f.head
  local words = "Routes" .. (shut and " +" or "")
  head.words, head.shut = words, shut
  local cell = look.headSize
  local side = floor(cell * 0.55 + 0.5)
  head.fill:SetSize(side, side)
  head.edge:SetSize(side + 2, side + 2)
  head.fill:SetPoint("CENTER", head, "TOPLEFT", cell / 2, -cell / 2)
  head.edge:SetPoint("CENTER", head, "TOPLEFT", cell / 2, -cell / 2)
  head.label:SetPoint("TOPLEFT", head, "TOPLEFT", cell + 2, 0)
  -- (on its own dark ground the header keeps a little off its upper edge)
  local y = docked and 0 or 5
  local width = Line(f, head, GOLD .. words .. "|r", look.headFont, look.headSize, look, HEAD_X, y, limit, cell + 2)
  -- your hearthstone, right of the header's words
  local hearth = f.hearth
  local off = shared.HearthOff ~= nil and shared.HearthOff() == true
  hearth.off = off
  hearth:ClearAllPoints()
  hearth:SetPoint("TOPLEFT", f, "TOPLEFT", width + 7, 1 - y)
  hearth:SetSize(cell + 2, cell + 2)
  hearth.icon:SetAlpha(off and 0.6 or 1)
  if hearth.icon.SetDesaturated then hearth.icon:SetDesaturated(off) end
  if off then
    hearth.under:Show()
    hearth.bar:Show()
  else
    hearth.under:Hide()
    hearth.bar:Hide()
  end
  hearth:Show()
  width = width + 7 + cell + 2
  y = y + cell + 5

  for _, g in ipairs(f.every) do
    g.title:Hide()
    g.more:Hide()
    for i = 1, #g.rows do g.rows[i]:Hide() end
  end
  f.level:Hide()

  if not shut then
    local function add(row, text, font, size, x, gap, inset)
      local right, tall = Line(f, row, text, font, size, look, x, y, limit, inset)
      if right > width then width = right end
      y = y + tall + gap
    end
    if view.moving then
      local title = f.title
      title.key, title.words, title.clock, title.route = nil, "Drag the list of routes where you want it, then /atlas move again.", "", nil
      title.mark:Hide()
      if title.arrow then title.arrow:Hide() end
      title.label:SetPoint("TOPLEFT", title, "TOPLEFT", 0, 0)
      add(title, WHITE .. title.words .. "|r", look.questFont, look.questSize, LINE_X + look.quest, 4)
    end
    local spare = 0
    for i, v in ipairs(view.groups) do
      -- (the route that leads has the first group's lines; the others, one each of the rest)
      local g = i == 1 and view.lead and f.lead or nil
      if not g then
        spare = spare + 1
        g = f.groups[spare]
        if not g then
          g = ListGroup(f, OTHER_ROWS)
          f.groups[spare] = g
          f.every[#f.every + 1] = g
        end
      end
      -- its name, as Questie writes a zone's; before it, in the colour its line has on the map,
      -- the arrow that points the way it goes (ListPoint turns it, and shows the square in its
      -- place where there is no way to point)
      local title = g.title
      title.key, title.words, title.clock, title.route = v.key, v.head, v.clock, v.route
      local zs = look.zoneSize
      local ms = floor(zs * 0.5 + 0.5)
      local c = v.colour
      local cr, cg, cb = 1, 0.82, 0.1
      if c then cr, cg, cb = floor(c / 65536) % 256 / 255, floor(c / 256) % 256 / 255, c % 256 / 255 end
      title.mark:SetColorTexture(cr, cg, cb, 1)
      title.mark:SetSize(ms, ms)
      title.mark:SetPoint("CENTER", title, "TOPLEFT", zs / 2, -zs / 2)
      title.mark:Show()
      if title.arrow then
        title.arrow:SetVertexColor(cr, cg, cb)
        title.arrow:SetSize(zs + 4, zs + 4)
        title.arrow:SetPoint("CENTER", title, "TOPLEFT", zs / 2, -zs / 2)
        title.arrow:Hide()
      end
      title.pointing = false
      title.label:SetPoint("TOPLEFT", title, "TOPLEFT", zs + 3, 0)
      add(title, GREY .. v.head .. (v.shut and " +" or "") .. "|r" .. (v.clock ~= "" and ("  " .. DIM .. v.clock .. "|r") or ""), look.zoneFont, look.zoneSize, LINE_X, 3, zs + 3)
      if not v.shut then
        -- its steps, as Questie writes what a quest asks for: the one you are on bright
        for k, line in ipairs(v.rows) do
          local row = g.rows[k]
          if not row then break end
          row.words, row.clock, row.cur = line.words, line.clock, line.cur
          add(row, (line.cur and WHITE or GREY) .. line.words .. "|r" .. (line.clock ~= "" and ("  " .. DIM .. line.clock .. "|r") or ""), look.goalFont, look.goalSize, LINE_X + look.goal, 1)
        end
        if v.more then
          g.more.words = v.more
          add(g.more, DIM .. v.more .. "|r", look.goalFont, look.goalSize, LINE_X + look.goal, 1)
        end
        if v.level then
          f.level.words = v.level
          add(f.level, BLUE .. v.level .. "|r", look.goalFont, look.goalSize, LINE_X + look.goal, 1)
        end
        y = y + 2
      end
    end
    -- (the room Questie leaves under each quest)
    y = y + look.padding + 1
    ListPoint(f)
  end

  -- Under Questie's list: its ground, if it has one. On its own: a dark one, to be read over anything.
  local back = docked and look.back or (not docked and { 0, 0, 0, 0.38 }) or nil
  if back then
    f.back:SetColorTexture(back[1], back[2], back[3], back[4])
    f.back:Show()
  else
    f.back:Hide()
  end
  width = width + RIGHT
  if width < least then width = least end
  f:SetSize(width, y + (docked and 2 or 6))
end

-- Under Questie's list (over it, or beside it, where there is no room under it), or where you
-- put it. While Questie's list is off the screen the step list stays where it last hung.
local function ListPlace(f, q)
  local left, right, top, bottom
  if q then left, right, top, bottom = QuestieEdges(q) end
  if not left then
    if q and list.docked then return end
    if list.docked or list.docked == nil then
      list.docked, list.place = false, ""
      f:SetScale(1)
      Place(f, f.placeKey, f.placeDefault)
    end
    return
  end
  -- (dragged or sized by hand: Questie's list is followed to where it is let go)
  if (q.isMoving or q.isSizing) and list.docked then return end
  local scale = q:GetEffectiveScale() / UIParent:GetEffectiveScale()
  local w, h = f:GetWidth(), f:GetHeight()
  local place = table.concat({ scale, left, right, top, bottom, w, h }, "|")
  if list.docked and place == list.place then return end
  list.docked, list.place = true, place
  if f:GetScale() ~= scale then f:SetScale(scale) end
  local screenW, screenH = (UIParent:GetWidth() or 0) / scale, (UIParent:GetHeight() or 0) / scale
  local x, y = left, bottom
  if screenH > 0 and bottom - h < 0 then
    if top + h <= screenH then
      y = top + h
    else
      y = top
      x = left - BESIDE - w
      if x < 0 then x = right + BESIDE end
    end
  end
  if screenW > 0 and x + w > screenW then x = screenW - w end
  if x < 0 then x = 0 end
  f:ClearAllPoints()
  f:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", x, y)
end

-- How wide the list may get: as wide as Questie lets its own list get, and no further than the
-- screen's edge from where Questie's list begins (its lines are wrapped there, as Questie's are).
-- And how wide it is at least: as Questie's list, where both stand on a dark ground.
local function ListLimit(q, look)
  local left, right
  if q then left, right = QuestieEdges(q) end
  if not left then
    if q and list.docked then return list.limit, list.least end
    return LIST_W, 0
  end
  local scale = q:GetEffectiveScale() / UIParent:GetEffectiveScale()
  local screen = (UIParent:GetWidth() or 0) / scale
  local wide = right - left
  if screen > 0 then
    if screen * look.ratio > wide then wide = screen * look.ratio end
    if wide > screen - left - 2 then wide = screen - left - 2 end
  end
  if wide < 160 then wide = 160 end
  return wide, look.back and (right - left) or 0
end

local function ListUpdate(f)
  local q = QuestieList()
  -- (Questie's settings are looked at once a second)
  list.tick = list.tick + 1
  if not list.look or list.tick >= 5 then
    list.tick = 0
    local look = Look()
    if not list.look or look.sig ~= list.look.sig then list.sig = "" end
    list.look = look
  end
  local limit, least = ListLimit(q, list.look)
  local docked = q ~= nil and (list.docked == true or QuestieEdges(q) ~= nil)
  local view = ListView()
  -- (nothing to list: it is on show only to be dragged where you want it)
  if not view.groups[1] then view.moving = true end
  local sig = view.sig .. "\2" .. tostring(view.moving == true) .. ":" .. tostring(docked) .. ":" .. floor(limit) .. ":" .. floor(least)
  if sig ~= list.sig then
    list.sig, list.limit, list.least = sig, limit, least
    ListFill(f, view, list.look, limit, least, docked)
  else
    ListPoint(f)
  end
  ListPlace(f, q)
  -- It can be dragged with the mouse where it is free (not pinned under Questie's quest list: the
  -- options, or /atlas pin) - at any time, by any part of it - and, wherever it stands on its
  -- own, while the two are being moved. Never while it hangs under Questie's list. Where it
  -- cannot be dragged, clicks go through it (but for the lines that take one).
  local free = Settings().pin == false
  local hangs = list.docked and true or false
  f.free, f.pinned = free, hangs
  local loose = (moving or free) and not hangs
  if f.loose ~= loose then Dragging(f, loose) end
  local shaded = moving and not hangs
  if f.shaded ~= shaded then
    f.shaded = shaded
    if shaded then f.shade:Show() else f.shade:Hide() end
  end
end

local HEARTHSTONE = 6948
local function EnsureList()
  if list.frame then return list.frame end
  local f = CreateFrame("Frame", "AzerothAtlasSteps", UIParent)
  f:SetSize(LIST_W, 40)
  f:SetFrameStrata("MEDIUM") -- (as Questie's list)
  list.docked = nil -- (not placed yet)
  Movable(f, "listAt", LIST_AT)
  local back = f:CreateTexture(nil, "BACKGROUND")
  back:SetAllPoints(f)
  back:Hide()
  f.back = back
  -- the header: a click folds everything under it away, or brings it back
  local head = ListRow(f, true)
  -- (its mark: a small gold diamond with a dark rim, sized and placed with the letters)
  local edge = head:CreateTexture(nil, "BACKGROUND")
  edge:SetColorTexture(0, 0, 0, 0.85)
  local fill = head:CreateTexture(nil, "ARTWORK")
  fill:SetColorTexture(1, 0.82, 0.1, 1)
  if fill.SetRotation then
    edge:SetRotation(pi / 4)
    fill:SetRotation(pi / 4)
  end
  head.edge, head.fill = edge, fill
  head.label:ClearAllPoints()
  head:RegisterForClicks("LeftButtonUp")
  DragBy(head, f)
  head:SetScript("OnClick", function()
    if Dragged(f) then return end
    local db = Settings()
    db.listShut = not db.listShut
    list.sig = ""
    if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
  end)
  f.head = head
  -- Your hearthstone, beside the header: a click leaves it out of every route (a red line
  -- through it then), for those who would rather keep it; another click and it is used again.
  local hearth = CreateFrame("Button", "AzerothAtlasHearth", f)
  hearth:SetSize(14, 14)
  local icon = hearth:CreateTexture(nil, "ARTWORK")
  icon:SetAllPoints(hearth)
  local picture = nil
  if C_Item and C_Item.GetItemIconByID then picture = C_Item.GetItemIconByID(HEARTHSTONE) end
  if not picture and GetItemIcon then picture = GetItemIcon(HEARTHSTONE) end
  icon:SetTexture(picture or "Interface\\Icons\\INV_Misc_Rune_01")
  if icon.SetTexCoord then icon:SetTexCoord(0.07, 0.93, 0.07, 0.93) end
  hearth.icon = icon
  -- (the line through it: red, on a dark one so that it reads over the picture)
  local under = hearth:CreateLine(nil, "OVERLAY", nil, 1)
  under:SetColorTexture(0, 0, 0, 0.9)
  under:SetThickness(4.5)
  under:SetStartPoint("TOPLEFT", hearth, -1, 1)
  under:SetEndPoint("BOTTOMRIGHT", hearth, 1, -1)
  under:Hide()
  local bar = hearth:CreateLine(nil, "OVERLAY", nil, 2)
  bar:SetColorTexture(1, 0.1, 0.08, 1)
  bar:SetThickness(2.2)
  bar:SetStartPoint("TOPLEFT", hearth, -1, 1)
  bar:SetEndPoint("BOTTOMRIGHT", hearth, 1, -1)
  bar:Hide()
  hearth.under, hearth.bar = under, bar
  hearth:RegisterForClicks("LeftButtonUp")
  DragBy(hearth, f)
  hearth:SetScript("OnClick", function()
    if Dragged(f) then return end
    if shared.SetHearth and shared.HearthOff then shared.SetHearth(shared.HearthOff()) end
    list.sig = ""
    if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
  end)
  hearth:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
    if shared.HearthOff and shared.HearthOff() then
      GameTooltip:AddLine("Your hearthstone is left out of routes")
      GameTooltip:AddLine("Click to have it used again, wherever it is the quicker way.", 1, 1, 1, true)
    else
      GameTooltip:AddLine("Your hearthstone is used in routes")
      GameTooltip:AddLine("...wherever it is the quicker way. Click to leave it out of them.", 1, 1, 1, true)
    end
    GameTooltip:Show()
  end)
  hearth:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  hearth:Hide()
  f.hearth = hearth
  -- the routes: the one that leads has the first group of lines; the others get theirs as they come
  f.lead = ListGroup(f, ROWS)
  f.title, f.rows, f.more = f.lead.title, f.lead.rows, f.lead.more
  f.groups, f.every = {}, { f.lead }
  -- (with the header and the routes' names, the one part of the list that takes a click)
  local level = ListRow(f, true)
  level:RegisterForClicks("LeftButtonUp")
  DragBy(level, f)
  level:SetScript("OnClick", function()
    if Dragged(f) then return end
    local r = shared.Route()
    if r and r.lv then pcall(ShowAsk, r) end
  end)
  level:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
    GameTooltip:AddLine("There is more than one level at your waypoint's spot.")
    GameTooltip:AddLine("Click to choose another.", 1, 1, 1)
    GameTooltip:Show()
  end)
  level:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  f.level = level
  -- (the arrows before the routes' names turn with you: looked at some thirty times a second while the list is on show)
  local since = 0
  f:SetScript("OnUpdate", function(self, dt)
    since = since + (dt or 0)
    if since < 0.033 then return end
    since = 0
    pcall(ListPoint, self)
  end)
  f:Hide()
  list.frame = f
  return f
end

-- ---- the question: which level? ----------------------------------------------------------------
-- A window of its own, in the middle of things: so it is put there by itself only where the
-- answer is yours alone to give (a pin of your own hand: see ByHand, below), it can be closed
-- by its cross without closing anything else, dragged out of the way (where it is let go is
-- where it comes up from then on), and told not to come by itself at all. (Reported on 19
-- November 2026: it came up while the player stood reading, for a pin a guide addon had set;
-- stood in the middle of the screen; and Escape, the one way to be rid of it, closed every
-- other window with it.)
local ask = { frame = nil, key = nil, id = nil, at = nil }
local MAX_LEVELS = 6

local function EnsureAsk()
  if ask.frame then return ask.frame end
  local f = CreateFrame("Frame", "AzerothAtlasLevels", UIParent)
  f:SetSize(400, 100)
  f:SetFrameStrata("DIALOG")
  f:SetClampedToScreen(true)
  f:EnableMouse(true)
  -- where you last let it go, or under the top of the screen; dragged by anything of it that is not a button
  Place(f, "askAt", ASK_AT)
  f:SetMovable(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self)
    self.held = true
    self:StartMoving()
  end)
  f:SetScript("OnDragStop", function(self)
    if not self.held then return end
    self.held = nil
    self:StopMovingOrSizing()
    -- (where it stands is kept here, not by the game)
    if self.SetUserPlaced then pcall(self.SetUserPlaced, self, false) end
    local left, top = self:GetLeft(), self:GetTop()
    if left and top then
      Settings().askAt = { left, top }
      Place(self, "askAt", ASK_AT)
    end
  end)
  f:SetScript("OnHide", function(self)
    if self.held then
      self.held = nil
      self:StopMovingOrSizing()
    end
  end)
  local back = f:CreateTexture(nil, "BACKGROUND")
  back:SetAllPoints(f)
  back:SetColorTexture(0.03, 0.04, 0.06, 0.92)
  local rim = f:CreateTexture(nil, "BORDER")
  rim:SetColorTexture(1, 0.82, 0.1, 0.9)
  rim:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
  rim:SetPoint("TOPRIGHT", f, "TOPRIGHT", 0, 0)
  rim:SetHeight(2)
  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOP", f, "TOP", 0, -10)
  title:SetText("Which level is your waypoint on?")
  local sub = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  sub:SetPoint("TOP", title, "BOTTOM", 0, -3)
  sub:SetTextColor(0.7, 0.7, 0.7)
  sub:SetText("The route shown goes to the one marked. Closing this keeps it.")
  f.buttons = {}
  for i = 1, MAX_LEVELS do
    local b = CreateFrame("Button", nil, f)
    b:SetSize(380, 22)
    b:SetPoint("TOP", f, "TOP", 0, -24 - i * 24)
    local glow = b:CreateTexture(nil, "HIGHLIGHT")
    glow:SetAllPoints(b)
    glow:SetColorTexture(1, 1, 1, 0.14)
    local under = b:CreateTexture(nil, "BACKGROUND")
    under:SetAllPoints(b)
    under:SetColorTexture(1, 1, 1, 0.05)
    local words = b:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    words:SetPoint("LEFT", b, "LEFT", 8, 0)
    words:SetWidth(364)
    words:SetJustifyH("LEFT")
    if words.SetWordWrap then words:SetWordWrap(false) end
    b.text = words
    b:RegisterForClicks("LeftButtonUp")
    b:SetScript("OnClick", function()
      f:Hide()
      if shared.Choose then shared.Try("choose level", shared.Choose, i) end
      list.sig = ""
    end)
    b:Hide()
    f.buttons[i] = b
  end
  -- a cross in its corner: closes this window and nothing else (the game's own look for one, or a plain one)
  local okc, close = pcall(CreateFrame, "Button", nil, f, "UIPanelCloseButton")
  if not okc or type(close) ~= "table" then
    close = CreateFrame("Button", nil, f)
    local x = close:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    x:SetPoint("CENTER", close, "CENTER", 0, 0)
    x:SetText("x")
    local glow = close:CreateTexture(nil, "HIGHLIGHT")
    glow:SetAllPoints(close)
    glow:SetColorTexture(1, 1, 1, 0.2)
  end
  close:SetSize(24, 24)
  close:ClearAllPoints()
  close:SetPoint("TOPRIGHT", f, "TOPRIGHT", 1, 1)
  close:SetScript("OnClick", function() f:Hide() end)
  f.close = close
  -- a box to tick: never asked by itself again (the same switch as /atlas ask, and as the options).
  -- (A game that will not make the box leaves the window as it is without one.)
  pcall(function()
    local never = CreateFrame("CheckButton", nil, f)
    never:SetSize(22, 22)
    never:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 8, 5)
    never:SetNormalTexture("Interface\\Buttons\\UI-CheckBox-Up")
    never:SetPushedTexture("Interface\\Buttons\\UI-CheckBox-Down")
    never:SetHighlightTexture("Interface\\Buttons\\UI-CheckBox-Highlight", "ADD")
    never:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
    local words = never:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    words:SetPoint("LEFT", never, "RIGHT", 2, 1)
    words:SetTextColor(0.7, 0.7, 0.7)
    words:SetText("Do not ask me this again (\"Level\" in the list of routes still lets me choose)")
    never:SetScript("OnClick", function(self)
      local off = self:GetChecked() and true or false
      -- (ask: false where you are not to be asked; nothing where you are)
      if off then Settings().ask = false else Settings().ask = nil end
      if off then
        f:Hide()
        say("you will not be asked which level a pin of yours is on: its route goes to the level nearest your own. To choose another, click \"Level\" in the list of routes or type /atlas level. /atlas ask brings the question back.")
      end
    end)
    f.never = never
  end)
  -- (Escape closes it, as it does the game's own windows)
  if type(UISpecialFrames) == "table" then table.insert(UISpecialFrames, "AzerothAtlasLevels") end
  f:Hide()
  ask.frame = f
  return f
end

ShowAsk = function(r)
  local lv = r and r.lv
  if not lv then return false end
  local f = EnsureAsk()
  local count = #lv.list
  if count > MAX_LEVELS then count = MAX_LEVELS end
  for i = 1, MAX_LEVELS do
    local b = f.buttons[i]
    if i <= count then
      if i == lv.at then
        b.text:SetText("> " .. lv.list[i])
        b.text:SetTextColor(1, 0.82, 0.1)
      else
        b.text:SetText(lv.list[i])
        b.text:SetTextColor(1, 1, 1)
      end
      b:Show()
    else
      b:Hide()
    end
  end
  -- (room for the box under them, where there is one; it shows what is so now)
  f:SetHeight((f.never and 84 or 58) + count * 24)
  if f.never then f.never:SetChecked(Settings().ask == false) end
  ask.id, ask.at = lv.id, lv.at
  f:Show()
  return true
end

-- ---- Shift-click on the world map: a quick waypoint ----------------------------------------------
local hooked = false

local function ChatBoxOpen()
  local active = (ChatFrameUtil and ChatFrameUtil.GetActiveWindow) or ChatEdit_GetActiveWindow
  return active ~= nil and active() ~= nil
end

-- A spot on one of the game's maps (0-1 across and down) as a place in the world.
local function FromMap(uiMap, x, y)
  if type(uiMap) ~= "number" or type(x) ~= "number" or type(y) ~= "number" then return nil end
  if issecretvalue and (issecretvalue(uiMap) or issecretvalue(x) or issecretvalue(y)) then return nil end
  if x < 0 or x > 1 or y < 0 or y > 1 then return nil end
  if not (C_Map and C_Map.GetWorldPosFromMapPos and CreateVector2D) then return nil end
  -- (the whole world's map, or the cosmos: no place in particular)
  local info = C_Map.GetMapInfo and C_Map.GetMapInfo(uiMap)
  if type(info) == "table" and type(info.mapType) == "number" and info.mapType < 2 then return nil end
  local continent, pos = C_Map.GetWorldPosFromMapPos(uiMap, CreateVector2D(x, y))
  if type(continent) ~= "number" or not pos then return nil end
  local north, west = pos:GetXY()
  if type(north) ~= "number" or type(west) ~= "number" then return nil end
  return continent, north, west
end

-- The place in the world under the cursor on the world map. OpenMap (which shows every zone as
-- one seamless map) says through its public interface what is under the cursor on its own map.
local function CursorWorld(map)
  local api = OpenMapAPI
  if type(api) == "table" and api.major == 1 and type(api.IsStitched) == "function" then
    local okS, stitched = pcall(api.IsStitched)
    if okS and stitched == true then
      if type(api.CursorPosition) ~= "function" or type(api.MapAt) ~= "function" or type(api.MapFromWorld) ~= "function" then return nil end
      local ok, u, v = pcall(api.CursorPosition)
      if not (ok and type(u) == "number" and type(v) == "number") then return nil end
      local ok2, zone = pcall(api.MapAt, u, v)
      if not (ok2 and type(zone) == "number") then return nil end
      local ok3, x, y = pcall(api.MapFromWorld, zone, u, v)
      if not ok3 then return nil end
      return FromMap(zone, x, y)
    end
  end
  if not (map and map.GetMapID and map.GetNormalizedCursorPosition) then return nil end
  local x, y = map:GetNormalizedCursorPosition()
  return FromMap(map:GetMapID(), x, y)
end

-- (the map calls this for every click on its canvas; true = the click was ours, and does nothing else)
local function OnCanvasClick(map, button)
  if button ~= "LeftButton" or not IsShiftKeyDown() or ChatBoxOpen() then return false end
  local ok, continent, north, west = pcall(CursorWorld, map)
  if not (ok and continent) then return false end
  if not shared.Quick then return false end
  shared.Quick(continent, north, west)
  if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
  return true
end
shared.OnCanvasClick = OnCanvasClick -- (for the tests)

local function Hook()
  if hooked then return end
  if not (WorldMapFrame and WorldMapFrame.AddCanvasClickHandler) then return end
  hooked = true
  pcall(WorldMapFrame.AddCanvasClickHandler, WorldMapFrame, OnCanvasClick)
end

-- ---- a pin put on the map by hand ------------------------------------------------------------------
-- The question about the level is for a pin you put on the game's map yourself, with the mouse:
-- you know which level you meant, and nothing else does. A pin another addon sets - a guide's
-- next stop, a quest helper's quest giver - is that addon's, set when it pleases (while you
-- stand somewhere reading your mail), and you are not to be asked about it.
--
-- The game has one way of setting a pin, whoever does it: C_Map.SetUserWaypoint. Its own map
-- calls that for a Ctrl-click (and for a click with its "place a pin" button down), with the
-- spot the cursor is on; /way, a pin's link in chat and every addon that sets one call it too.
-- So it is listened to (a hook the game lets an addon hang behind one of its functions, which
-- changes nothing of what the function does), and a pin counts as put there by hand when, at
-- that moment, the world map is open and the cursor is on the very spot. OpenMap's map makes
-- its pins from the cursor as well, and says where that is.
-- (Where the game has no such hook, or does not say where the cursor is, nothing counts as put
-- there by hand, and the question is never put by itself: it can always be asked for.)
local W_PIN = 3      -- (as in AzerothAtlas.lua) the waypoint is a pin on the game's map
local HAND_NEAR = 6  -- yards from the cursor's spot within which a pin was put there with the mouse
local hand = { map = nil, north = nil, west = nil, hooked = false, said = nil }
local function PinSet(point)
  hand.map = nil
  local pos = type(point) == "table" and point.position
  if type(pos) ~= "table" then return end
  local map, north, west = FromMap(point.uiMapID, pos.x, pos.y)
  if not map then return end
  local by = "not by the mouse on the map"
  local shown = WorldMapFrame
  if shown and not (shown.IsShown and not shown:IsShown()) then
    local function under(ok, cMap, cNorth, cWest)
      return ok and cMap == map and type(cNorth) == "number" and type(cWest) == "number" and (cNorth - north) ^ 2 + (cWest - west) ^ 2 <= HAND_NEAR * HAND_NEAR
    end
    -- (where the cursor is as the map shown has it - OpenMap's, where that is what shows; and, failing
    -- that, as the game's own map underneath has it: whichever of the two made the pin made it from there)
    local mine = under(pcall(CursorWorld, shown))
    if not mine and shown.GetMapID and shown.GetNormalizedCursorPosition then
      mine = under(pcall(function()
        local x, y = shown:GetNormalizedCursorPosition()
        return FromMap(shown:GetMapID(), x, y)
      end))
    end
    if mine then
      hand.map, hand.north, hand.west = map, north, west
      by = "by the mouse on the map"
    end
  end
  -- (noted when it is another thing than the last: a guide may set its pin again and again)
  local saying = by .. ":" .. map .. ":" .. floor(north + 0.5) .. ":" .. floor(west + 0.5)
  if saying ~= hand.said then
    hand.said = saying
    if shared.Log then shared.Log("pin: set " .. by .. ", map " .. map .. " at " .. floor(north + 0.5) .. " " .. floor(west + 0.5) .. (hand.map and "" or " (its level is not asked about)")) end
  end
end
local function HookPin()
  if hand.hooked then return end
  if not (hooksecurefunc and C_Map and C_Map.SetUserWaypoint) then return end
  hand.hooked = true
  pcall(hooksecurefunc, C_Map, "SetUserWaypoint", function(point) pcall(PinSet, point) end)
end
-- Is the waypoint the game heads for (shared.target) a pin you put on its map with the mouse?
local function ByHand(t)
  if not hand.map or t.kind ~= W_PIN or t.map ~= hand.map then return false end
  local north, west = t.x / 128 - 32768, t.y / 128 - 32768
  return (north - hand.north) ^ 2 + (west - hand.west) ^ 2 <= 4
end

-- ---- five times a second (called by Route.lua once the route is up to date) ------------------------
local function SetMoving(on)
  moving = on
  for i = 1, #movers do
    local f = movers[i]
    -- (the step list: ListUpdate says whether it can be dragged)
    if f ~= list.frame then
      f:EnableMouse(on)
      f.shade:SetAlpha(1)
      if on then f.shade:Show() else f.shade:Hide() end
    end
  end
  -- (the arrow, unlocked, goes on taking the mouse: GuideScan sees to it)
  if arrow.frame then arrow.frame.free = nil end
  arrow.distance, arrow.words, list.sig = "", "", ""
end

function shared.GuideScan(now)
  Hook()
  HookPin()
  local r = shared.Route()
  local t = shared.target
  local db = Settings()

  -- the arrow (along the route you follow)
  if (shared.Follow() and db.arrow ~= false) or moving then
    local f = EnsureArrow()
    if not f:IsShown() then
      arrow.angle, arrow.distance, arrow.words = nil, "", ""
      f:Show()
    end
  elseif arrow.frame and arrow.frame:IsShown() then
    arrow.frame:Hide()
  end
  -- (unlocked in the options: it takes the mouse, and can be dragged where you want it at any
  -- time; locked, clicks go through it to the game)
  local af = arrow.frame
  if af then
    local free = db.arrowFree == true
    if af.free ~= free then
      af.free = free
      af:EnableMouse(free or moving)
      if not free and not moving then af.shade:Hide() end
    end
  end

  -- the list of routes: while there is one, or a waypoint whose route is not there yet (and while
  -- the two are being moved, also with nothing to list - unless it hangs under Questie's list)
  local _, others = shared.Routes()
  local any = r ~= nil or (shared.Waiting ~= nil and shared.Waiting() ~= nil)
  if not any then
    for _, o in ipairs(others) do
      if not o.gone then any = true break end
    end
  end
  if (any and db.list ~= false) or (moving and not (list.docked and QuestieList())) then
    local f = EnsureList()
    ListUpdate(f)
    if not f:IsShown() then f:Show() end
  elseif list.frame and list.frame:IsShown() then
    list.frame:Hide()
    list.sig = ""
  end

  -- the question about the level: once for each waypoint that has one to ask - where it is a
  -- pin of your own hand (ByHand), and you have not said that you are not to be asked
  local key = t.kind ~= 0 and (t.map .. ":" .. t.x .. ":" .. t.y) or nil
  if ask.key and ask.key ~= key then ask.key = nil end
  local shown = ask.frame and ask.frame:IsShown()
  if r and r.lv then
    if r.lv.ask and key and ask.key ~= key and r.tm == t.map and r.tx == t.x and r.ty == t.y then
      ask.key = key
      if db.ask ~= false and ByHand(t) then ShowAsk(r) end
    elseif shown and (ask.id ~= r.lv.id or ask.at ~= r.lv.at) then
      ShowAsk(r) -- (a newer delivery while it is open: show what is so now)
    end
  elseif shown then
    ask.frame:Hide()
  end
end

-- The list of routes pinned under Questie's quest list (as it is unless you say otherwise), or
-- free: standing on its own, to be dragged with the mouse wherever you want it. Set free for the
-- first time it stays where it hung, until you drag it; after that, it goes where you last put it.
function shared.SetPin(on)
  local db = Settings()
  on = on and true or false
  if not on and db.pin ~= false and type(db.listAt) ~= "table" then
    local f, left, top = list.frame, nil, nil
    if f and list.docked then
      local scale = f:GetScale() or 1
      left, top = f:GetLeft(), f:GetTop()
      if left and top then left, top = left * scale, top * scale end
    end
    if not (left and top) then
      -- (no list on the screen just now: where it would hang)
      local q = QuestieList()
      local l, _, _, b
      if q then l, _, _, b = QuestieEdges(q) end
      if l and b then
        local scale = q:GetEffectiveScale() / UIParent:GetEffectiveScale()
        left, top = l * scale, b * scale
      end
    end
    if left and top then db.listAt = { left, top } end
  end
  db.pin = on
  list.sig = ""
  if moving then SetMoving(false) end
end

-- ---- what you can tell it ------------------------------------------------------------------------
function shared.GuideCommand(word, rest)
  local db = Settings()
  if word == "arrow" and (rest == "unlock" or rest == "lock") then
    -- /atlas arrow unlock: drag it with the mouse, whenever you like; /atlas arrow lock: it stays, and clicks go through it
    db.arrowFree = rest == "unlock" or nil
    say(db.arrowFree and "the arrow is unlocked: drag it where you want it (/atlas arrow lock when it is there)." or "the arrow is locked where it is: clicks go through it.")
    return true
  end
  if word == "ask" then
    -- /atlas ask, /atlas ask on, /atlas ask off: whether the question about the level is put by itself
    if rest == "on" then db.ask = nil
    elseif rest == "off" then db.ask = false
    elseif db.ask == false then db.ask = nil
    else db.ask = false end
    say(db.ask == false and "you are not asked which level a pin of yours is on: its route goes to the level nearest your own. To choose another, click \"Level\" in the list of routes or type /atlas level."
      or "where a pin you put on the map with the mouse has more than one level under it, you are asked which you mean. (A pin another addon sets is never asked about.)")
    return true
  end
  if word == "level" then
    local r = shared.Route()
    if r and r.lv then
      ShowAsk(r)
    elseif r then
      say("there is only one level at your waypoint's spot.")
    else
      say("no route: there is nothing to choose a level for.")
    end
  elseif word == "arrow" then
    db.arrow = db.arrow == false
    say(db.arrow and "the arrow is on." or "the arrow is off.")
  elseif word == "list" or word == "steps" then
    db.list = db.list == false
    say(db.list and "the list of routes is on." or "the list of routes is off.")
  elseif word == "pin" then
    shared.SetPin(db.pin == false)
    say(db.pin and "the list of routes hangs under Questie's quest list again (where Questie shows one)."
      or "the list of routes stands on its own now: drag it with the mouse where you want it (/atlas pin hangs it under Questie's quest list again).")
  elseif word == "move" then
    SetMoving(not moving)
    local pinned = list.docked and QuestieList() ~= nil
    say(moving and ("drag the arrow" .. (pinned and "" or " and the list of routes") .. " where you want " .. (pinned and "it" or "them") .. ", then type /atlas move again."
      .. (pinned and " (The list of routes hangs under Questie's quest list: /atlas pin sets it free.)" or "")) or "the arrow and the list of routes stay where they are now.")
  elseif word == "reset" then
    db.arrowAt, db.listAt, db.askAt = nil, nil, nil
    for i = 1, #movers do
      if not (movers[i] == list.frame and list.docked) then Place(movers[i], movers[i].placeKey, movers[i].placeDefault) end
    end
    -- (and the question about the level, where it has been dragged somewhere)
    if ask.frame then Place(ask.frame, "askAt", ASK_AT) end
    say("the arrow and the list of routes are back where they started.")
  else
    return false
  end
  return true
end

-- (for the tests, and for a look from the game with /dump AzerothAtlas.GuidePeek())
function shared.GuidePeek()
  return { arrow = arrow, list = list, ask = ask, hand = hand, moving = moving, hooked = hooked, AimPoint = AimPoint, StepLeft = StepLeft, Look = Look }
end

-- ---- the options: Esc > Options > AddOns > Azeroth Atlas ------------------------------------------
-- Where the coded strip is (it can be moved out from under whatever another program draws over
-- the game), and the switches of the route in the game. Everything here can also be said in
-- words after /atlas (/atlas help lists them): this is the same, to be clicked.
--
-- The panel is put together the first time it is shown, piece by piece, so that a piece this
-- game does not know leaves the rest standing - and whatever goes wrong is said once, in chat.
-- (It is in this file, and not one of its own, because the game only finds a new file when it
-- starts: this way a /reload is enough to have it.)
do
  local NAME = "Azeroth Atlas"
  local WIDE = 560

  local function DB()
    if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
    return AzerothAtlasDB
  end
  local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end

  local panel = CreateFrame("Frame", "AzerothAtlasOptions")
  panel.name = NAME
  panel:Hide()
  local shows = {}  -- what each piece does when the panel is shown (or something has changed): show what is so now
  local function Refresh()
    for i = 1, #shows do pcall(shows[i]) end
  end

  -- ---- the pieces ----------------------------------------------------------------------------------
  local function Words(text, font, x, y, width)
    local s = panel:CreateFontString(nil, "ARTWORK", font)
    s:SetPoint("TOPLEFT", panel, "TOPLEFT", x, y)
    s:SetJustifyH("LEFT")
    if s.SetJustifyV then s:SetJustifyV("TOP") end
    if width then s:SetWidth(width) end
    s:SetText(text)
    return s
  end

  -- A box to tick: `get` says whether it is ticked, `set` is told when you tick or untick it.
  local function Check(text, x, y, get, set)
    local b = CreateFrame("CheckButton", nil, panel)
    b:SetSize(26, 26)
    b:SetPoint("TOPLEFT", panel, "TOPLEFT", x, y)
    b:SetNormalTexture("Interface\\Buttons\\UI-CheckBox-Up")
    b:SetPushedTexture("Interface\\Buttons\\UI-CheckBox-Down")
    b:SetHighlightTexture("Interface\\Buttons\\UI-CheckBox-Highlight", "ADD")
    b:SetCheckedTexture("Interface\\Buttons\\UI-CheckBox-Check")
    local label = b:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
    label:SetPoint("LEFT", b, "RIGHT", 2, 1)
    label:SetText(text)
    b:SetScript("OnClick", function(self)
      pcall(set, self:GetChecked() and true or false)
      Refresh()
    end)
    shows[#shows + 1] = function() b:SetChecked(get() and true or false) end
    return b
  end

  -- A button with words on it. Returns it (its words can be changed: SetText).
  local function Press(text, x, y, width, click)
    local ok, b = pcall(CreateFrame, "Button", nil, panel, "UIPanelButtonTemplate")
    if not ok or not b then
      -- (a game without that look: a plain dark button)
      b = CreateFrame("Button", nil, panel)
      local back = b:CreateTexture(nil, "BACKGROUND")
      back:SetAllPoints(b)
      back:SetColorTexture(0.15, 0.15, 0.18, 0.95)
      local glow = b:CreateTexture(nil, "HIGHLIGHT")
      glow:SetAllPoints(b)
      glow:SetColorTexture(1, 1, 1, 0.12)
      local label = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
      label:SetPoint("CENTER", b, "CENTER", 0, 0)
      b.SetText = function(_, words) label:SetText(words) end
    end
    b:SetSize(width, 22)
    b:SetPoint("TOPLEFT", panel, "TOPLEFT", x, y)
    b:SetText(text)
    b:SetScript("OnClick", function()
      pcall(click)
      Refresh()
    end)
    return b
  end

  -- A number to type, with a button either side of it to take a little off or add a little.
  local function Number(x, y, get, set, step, most)
    local ok, box = pcall(CreateFrame, "EditBox", nil, panel, "InputBoxTemplate")
    if not ok or not box then
      box = CreateFrame("EditBox", nil, panel)
      local back = box:CreateTexture(nil, "BACKGROUND")
      back:SetAllPoints(box)
      back:SetColorTexture(0, 0, 0, 0.6)
      if ChatFontNormal then box:SetFontObject(ChatFontNormal) end
    end
    box:SetAutoFocus(false)
    box:SetSize(56, 20)
    box:SetPoint("TOPLEFT", panel, "TOPLEFT", x + 30, y - 1)
    if box.SetJustifyH then box:SetJustifyH("CENTER") end
    if box.SetMaxLetters then box:SetMaxLetters(4) end
    if box.SetNumeric then box:SetNumeric(true) end
    local function take(v)
      v = floor((tonumber(v) or 0) + 0.5)
      if v < 0 then v = 0 elseif v > most then v = most end
      pcall(set, v)
      Refresh()
    end
    box:SetScript("OnEnterPressed", function(self) take(self:GetText()) self:ClearFocus() end)
    box:SetScript("OnEscapePressed", function(self) self:ClearFocus() Refresh() end)
    box:SetScript("OnEditFocusLost", function(self) take(self:GetText()) end)
    Press("-", x, y, 24, function() take(get() - step) end)
    Press("+", x + 94, y, 24, function() take(get() + step) end)
    shows[#shows + 1] = function()
      if not (box.HasFocus and box:HasFocus()) then box:SetText(tostring(get())) end
    end
    return box
  end

  -- ---- the panel -----------------------------------------------------------------------------------
  local CORNER_ORDER = { "TOPLEFT", "TOPRIGHT", "BOTTOMLEFT", "BOTTOMRIGHT" }
  local CORNER_WORDS = { TOPLEFT = "Top left", TOPRIGHT = "Top right", BOTTOMLEFT = "Bottom left", BOTTOMRIGHT = "Bottom right" }

  local built = false
  local function Build()
    if built then return end
    built = true
    local problems = {}
    local function piece(fn)
      local ok, err = pcall(fn)
      if not ok then problems[#problems + 1] = tostring(err) end
    end

    piece(function()
      Words(NAME, "GameFontNormalLarge", 16, -16)
      Words("Shows the 3D map where you are, and the 3D map's routes in the game. /atlas help lists what can be typed instead of clicked here.", "GameFontHighlightSmall", 16, -40, WIDE)
    end)

    -- the strip
    piece(function()
      Words("The coded strip", "GameFontNormal", 16, -72)
      Words("Your position reaches the 3D map as a thin strip of coloured squares in a corner of the game window. It is drawn over everything in the game's own interface. If another program draws over that corner - a frame-rate counter, a voice chat's overlay - the 3D map cannot read it: move it to a corner that is free. The 3D map finds it by itself.",
        "GameFontHighlightSmall", 16, -90, WIDE)
    end)
    piece(function()
      Check("Show the strip (the 3D map cannot follow you without it)", 14, -138,
        function() return shared.StripOn() end, function(on) shared.SetStrip(on) end)
    end)
    piece(function()
      Words("Corner", "GameFontHighlight", 20, -176)
      for i, corner in ipairs(CORNER_ORDER) do
        local b = Press(CORNER_WORDS[corner], 90 + (i - 1) * 112, -171, 106, function() shared.PlaceStrip(corner) end)
        shows[#shows + 1] = function()
          local at = shared.StripAt()
          -- (the corner it is in is the one that cannot be pressed)
          if at == corner then
            if b.Disable then b:Disable() end
          elseif b.Enable then
            b:Enable()
          end
        end
      end
    end)
    piece(function()
      Words("Pixels across", "GameFontHighlight", 20, -208)
      Number(120, -203, function() local _, x = shared.StripAt() return x end, function(v) shared.PlaceStrip(nil, v, nil) end, 10, 8000)
      local down = Words("Pixels down", "GameFontHighlight", 260, -208)
      Number(360, -203, function() local _, _, y = shared.StripAt() return y end, function(v) shared.PlaceStrip(nil, nil, v) end, 10, 8000)
      shows[#shows + 1] = function()
        local at = shared.StripAt()
        down:SetText((at == "BOTTOMLEFT" or at == "BOTTOMRIGHT") and "Pixels up" or "Pixels down")
      end
      Press("Back to the top left", 20, -236, 170, function() shared.PlaceStrip("TOPLEFT", 0, 0) end)
    end)
    -- the game's combat log, kept for the 3D map to read (AzerothAtlas.lua: KeepFights)
    piece(function()
      Check("Keep the game's combat log: the 3D map learns from it", 216, -234,
        function() return shared.FightsKept() end, function(on) shared.SetFights(on) end)
    end)

    -- the routes
    piece(function()
      Words("Routes in the game", "GameFontNormal", 16, -280)
      Check("Use my hearthstone in routes, where it is the quicker way (this character)", 14, -298,
        function() return not shared.HearthOff() end, function(on) shared.SetHearth(on) end)
      -- the arrow: shown or not at all; and unlocked (it can be dragged with the mouse at any time) or locked where it is
      Check("Show the arrow (the compass that points along the route you follow)", 14, -324, function() return DB().arrow ~= false end, function(on) DB().arrow = on end)
      Check("Unlock it: drag it with the mouse to where you want it (locked, clicks go through it)", 38, -350,
        function() return DB().arrowFree == true end, function(on) DB().arrowFree = on or nil end)
      -- the list: shown or not at all; and pinned under Questie's quest list, or free (it can be dragged with the mouse at any time)
      Check("Show the list of routes", 14, -376, function() return DB().list ~= false end, function(on) DB().list = on end)
      -- the question about the level: put by itself for a pin of your own hand, or only when you ask (/atlas level, "Level" in the list)
      Check("Ask which level a pin I set is on", 300, -376, function() return DB().ask ~= false end, function(on) if on then DB().ask = nil else DB().ask = false end end)
      Check("Pin it under Questie's quest list (unticked, it is free: drag it where you want it)", 38, -402,
        function() return DB().pin ~= false end, function(on) shared.SetPin(on) end)
    end)
    piece(function()
      local move
      move = Press("Move the arrow and the list", 20, -436, 220, function()
        if shared.GuideCommand then shared.GuideCommand("move") end
      end)
      Press("Put them back", 250, -436, 140, function()
        if shared.GuideCommand then shared.GuideCommand("reset") end
      end)
      shows[#shows + 1] = function()
        local peek = shared.GuidePeek and shared.GuidePeek()
        move:SetText(peek and peek.moving and "Done moving them" or "Move the arrow and the list")
      end
      Words("Or move both in one go, locked and pinned as they are: while they are being moved, drag each where you want it (close this window to see them), then press the button again. A list that hangs under Questie's quest list moves with that.",
        "GameFontHighlightSmall", 20, -466, WIDE)
    end)

    -- your guide: which guide addon the route follows (GuideSources.lua)
    piece(function()
      Words("Your guide", "GameFontNormal", 16, -510)
      local said = Words("", "GameFontHighlightSmall", 20, -556, WIDE)
      local picks = { { "auto", "Automatic" } }
      for _, s in ipairs(shared.GuideSources and shared.GuideSources() or {}) do picks[#picks + 1] = { s.key, s.name } end
      for i, pick in ipairs(picks) do
        local b = Press(pick[2], 20 + (i - 1) * 132, -528, 126, function() shared.SetGuideChoice(pick[1]) end)
        shows[#shows + 1] = function()
          -- (the one that is set is the one that cannot be pressed)
          if shared.GuideChoice() == pick[1] then
            if b.Disable then b:Disable() end
          elseif b.Enable then
            b:Enable()
          end
        end
      end
      shows[#shows + 1] = function()
        local running, follows = {}, nil
        for _, s in ipairs(shared.GuideSources()) do
          if s.loaded then running[#running + 1] = s.name end
          if s.followed then follows = s.name end
        end
        local now = follows and ("Following " .. follows .. " now.") or (#running > 0 and (table.concat(running, " and ") .. (#running == 1 and " is" or " are") .. " running, with no step to go to just now.") or "No guide addon is running.")
        said:SetText("The route goes to the step your guide addon has you on, and moves on as the guide does. Automatic follows the one that has a guide open. " .. now .. " The guide addon's own arrow can be switched off in its settings.")
      end
    end)

    if problems[1] then say("a part of the options could not be shown (" .. problems[1] .. "). Everything there can also be typed: /atlas help.") end
  end

  panel:SetScript("OnShow", function()
    local ok, err = pcall(Build)
    if not ok then say("the options could not be shown (" .. tostring(err) .. "). Everything there can also be typed: /atlas help.") end
    Refresh()
  end)

  -- ---- where the game lists it -----------------------------------------------------------------------
  -- (the game's own "Settings", asked for by name: in this file that word is the addon's saved settings)
  local category = nil
  local function Register()
    local game = rawget(_G, "Settings")
    if type(game) == "table" and game.RegisterCanvasLayoutCategory and game.RegisterAddOnCategory then
      local ok, made = pcall(game.RegisterCanvasLayoutCategory, panel, NAME)
      if ok and made then
        category = made
        pcall(game.RegisterAddOnCategory, made)
        return
      end
    end
    if InterfaceOptions_AddCategory then pcall(InterfaceOptions_AddCategory, panel) end
  end

  -- Open the game's options at this panel. False where that cannot be done from here.
  function shared.OpenOptions()
    local game = rawget(_G, "Settings")
    if category and type(game) == "table" and game.OpenToCategory then
      local id = (category.GetID and category:GetID()) or category.ID
      return (pcall(game.OpenToCategory, id))
    end
    if InterfaceOptionsFrame_OpenToCategory then
      -- (asked twice: the first time, some versions of the game only open the window)
      pcall(InterfaceOptionsFrame_OpenToCategory, panel)
      return (pcall(InterfaceOptionsFrame_OpenToCategory, panel))
    end
    return false
  end

  local waiter = CreateFrame("Frame")
  waiter:RegisterEvent("PLAYER_LOGIN")
  waiter:SetScript("OnEvent", function() pcall(Register) end)

  -- (for the tests)
  function shared.OptionsPeek() return { panel = panel, build = Build, refresh = Refresh, shows = shows } end
end
