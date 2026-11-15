-- Azeroth Atlas: following the route in the game.
--
-- Route.lua brings the 3D map's route into the game and draws it on the world map and the
-- minimap. This file is what you follow it by:
--   the arrow      in the middle of the screen: which way the route goes from where you stand,
--                  how far it is to the end of the step you are on, and what that step is;
--   the step list  the journey as things to do, the one you are on first ("Walk to Sentinel
--                  Hill's flight master", "Fly to Stormwind", "Walk to your map pin"). It hangs
--                  under Questie's quest list, in Questie's own letters, as a part of it:
--                  "Current Route: 2/5", and a click on that folds the steps away;
--   the question   where the spot you are heading for has more than one level (a street and
--                  the floor above it), which of them you mean;
--   Shift-click    on the world map: a quick waypoint there, no question asked - it goes to
--                  the level nearest your own height.
--
-- /atlas arrow, /atlas list   each on or off
-- /atlas pin                    the step list under Questie's quest list, or on its own
-- /atlas move                   drag the two where you want them (again: done)
-- /atlas reset                  back where they were
-- /atlas level                  the question about the level, again

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
local ROWS = 8                -- steps listed at most
local LIST_W = 270            -- how wide the step list may get where it stands on its own
-- (as Questie lays out its quest list: its header's mark and its lines from the left edge, and
-- the room it keeps on the right)
local HEAD_X, LINE_X, RIGHT = 6, 10, 10
local BESIDE = 8              -- the room between Questie's list and the step list where it has to stand beside it
local ARROW_AT = { "TOP", 0, -110 }
local LIST_AT = { "TOPRIGHT", -255, -250 }

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
local function Movable(f, key, default)
  f:SetMovable(true)
  f:SetClampedToScreen(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) if moving then self:StartMoving() end end)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local left, top = self:GetLeft(), self:GetTop()
    if left and top then Settings()[key] = { left, top } end
  end)
  f:EnableMouse(moving) -- (clicks go through it to the game, except while it is being moved)
  local shade = f:CreateTexture(nil, "BACKGROUND")
  shade:SetAllPoints(f)
  shade:SetColorTexture(0.1, 0.3, 0.6, 0.45)
  if not moving then shade:Hide() end
  f.shade, f.placeKey, f.placeDefault = shade, key, default
  movers[#movers + 1] = f
  Place(f, key, default)
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
  local r = shared.Route()
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
  Movable(f, "arrowAt", ARROW_AT)
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
-- Questie's own ("Current Route: 2/5": the step you are on, of how many), under it the journey's
-- name as Questie writes a quest's, and its steps as Questie writes what a quest asks for. A click
-- on the header folds the steps away, as a click on Questie's header folds its quests away.
-- Without Questie (or with /atlas pin off) the list stands where you put it.
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
  look.sig = table.concat({ look.headFont, look.headSize, look.questFont, look.questSize, look.goalFont, look.goalSize, look.outline,
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

-- What the list says: the header, and under it (unless folded away) the journey and its steps.
-- `r` nil: the list as it shows while it is being moved. `limit`: how wide it may get, `least`:
-- how wide it is at least. `secs`: left of the step you are on, `total`: of the journey, `far`:
-- yards left of it (nil where none of it is drawn here).
local GOLD, YELLOW, WHITE, GREY, DIM, BLUE = "|cffffd100", "|cffffff00", "|cffeeeeee", "|cffc0c0c0", "|cffa0a0a0", "|cff80d4ff"
local function ListFill(f, r, look, limit, least, docked, secs, total, far)
  local shut = Settings().listShut == true
  local steps = r and r.steps or {}
  local count, cur = #steps, r and r.cur or 0
  if cur < 1 then cur = 1 end

  -- the header: the count, and before it a mark (the waypoint's own) where Questie's header has
  -- Questie's, in a square as high as the letters
  local head = f.head
  local words = "Current Route" .. (count > 0 and (": " .. cur .. "/" .. count) or "") .. (shut and " +" or "")
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
  y = y + cell + 5
  f.title:Hide()
  f.more:Hide()
  f.level:Hide()
  for i = 1, ROWS do f.rows[i]:Hide() end

  if not shut then
    local function add(row, text, font, size, x, gap)
      local right, tall = Line(f, row, text, font, size, look, x, y, limit)
      if right > width then width = right end
      y = y + tall + gap
    end
    if r then
      -- the journey, as Questie writes a quest's name
      local title = f.title
      title.words = r.title or (r.name and ("Journey to " .. r.name)) or "Journey"
      title.clock = Clock(total) .. (far and (" · " .. Yards(far)) or "")
      add(title, YELLOW .. title.words .. "|r  " .. GREY .. title.clock .. "|r", look.questFont, look.questSize, LINE_X + look.quest, 4)
      -- its steps, as Questie writes what a quest asks for: the one you are on bright
      local shown = 0
      for i = cur, count do
        if shown >= ROWS then break end
        shown = shown + 1
        local row, step = f.rows[shown], steps[i]
        row.words, row.cur = step.text, i == cur
        -- (the step you are on, where it waits for a boat that has been timed: what is so this second)
        local note = (i == cur and select(2, StepLive(step))) or step.note
        row.clock = Clock(i == cur and secs or step.secs) .. (note and (" · " .. note) or "")
        add(row, (row.cur and WHITE or GREY) .. row.words .. "|r  " .. DIM .. row.clock .. "|r", look.goalFont, look.goalSize, LINE_X + look.goal, 1)
      end
      local left = count - cur + 1 - shown
      if left > 0 then
        f.more.words = "+" .. left .. " more"
        add(f.more, DIM .. f.more.words .. "|r", look.goalFont, look.goalSize, LINE_X + look.goal, 1)
      end
      -- which level the waypoint is on, where there is a choice (click: choose again)
      if r.lv then
        f.level.words = "Level: " .. (r.lv.list[r.lv.at] or "?")
        add(f.level, BLUE .. f.level.words .. "|r", look.goalFont, look.goalSize, LINE_X + look.goal, 1)
      end
    else
      f.title.words, f.title.clock = "Drag the step list where you want it, then /atlas move again.", ""
      add(f.title, WHITE .. f.title.words .. "|r", look.questFont, look.questSize, LINE_X + look.quest, 4)
    end
    -- (the room Questie leaves under each quest)
    y = y + look.padding + 1
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

local function ListUpdate(f, r)
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
  -- time and distance left: of the step you are on, and of the ones after it
  local secs, total, far
  local sig = "move"
  if r then
    local cur = r.cur < 1 and 1 or r.cur
    secs = StepLive(r.steps[cur]) or select(2, StepLeft(r))
    total = secs or 0
    for i = cur + 1, #r.steps do total = total + r.steps[i].secs end
    if not r.bare then
      far = r.C[r.n] - r.along
      if far < 0 then far = 0 end
    end
    sig = (select(2, shared.Route())) .. ":" .. cur .. ":" .. floor(total) .. ":" .. (far and floor(far) or "-") .. ":" .. (r.lv and r.lv.at or 0)
  end
  sig = sig .. ":" .. tostring(Settings().listShut == true) .. ":" .. tostring(docked) .. ":" .. floor(limit) .. ":" .. floor(least)
  if sig ~= list.sig then
    list.sig, list.limit, list.least = sig, limit, least
    ListFill(f, r, list.look, limit, least, docked, secs, total, far)
  end
  ListPlace(f, q)
  -- it can be dragged while the two are being moved, unless it hangs under Questie's list
  local loose = moving and not list.docked
  if f.loose ~= loose then
    f.loose = loose
    f:EnableMouse(loose)
    if loose then f.shade:Show() else f.shade:Hide() end
  end
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
  -- the header: a click folds the steps away, or brings them back
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
  head:SetScript("OnClick", function()
    local db = Settings()
    db.listShut = not db.listShut
    list.sig = ""
    if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON) end
  end)
  f.head = head
  f.title = ListRow(f)
  f.rows = {}
  for i = 1, ROWS do f.rows[i] = ListRow(f) end
  f.more = ListRow(f)
  -- (with the header, the one part of the list that takes a click)
  local level = ListRow(f, true)
  level:RegisterForClicks("LeftButtonUp")
  level:SetScript("OnClick", function()
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
  f:Hide()
  list.frame = f
  return f
end

-- ---- the question: which level? ----------------------------------------------------------------
local ask = { frame = nil, key = nil, id = nil, at = nil }
local MAX_LEVELS = 6

local function EnsureAsk()
  if ask.frame then return ask.frame end
  local f = CreateFrame("Frame", "AzerothAtlasLevels", UIParent)
  f:SetSize(400, 100)
  f:SetFrameStrata("DIALOG")
  f:SetPoint("TOP", UIParent, "TOP", 0, -240)
  f:SetClampedToScreen(true)
  f:EnableMouse(true)
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
  sub:SetText("The route shown goes to the one marked. Esc keeps it.")
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
      if shared.Choose then pcall(shared.Choose, i) end
      list.sig = ""
    end)
    b:Hide()
    f.buttons[i] = b
  end
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
  f:SetHeight(58 + count * 24)
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

-- ---- five times a second (called by Route.lua once the route is up to date) ------------------------
local function SetMoving(on)
  moving = on
  for i = 1, #movers do
    local f = movers[i]
    -- (the step list: ListUpdate says whether it can be dragged)
    if f ~= list.frame then
      f:EnableMouse(on)
      if on then f.shade:Show() else f.shade:Hide() end
    end
  end
  arrow.distance, arrow.words, list.sig = "", "", ""
end

function shared.GuideScan(now)
  Hook()
  local r = shared.Route()
  local t = shared.target
  local db = Settings()

  -- the arrow
  if (r and db.arrow ~= false) or moving then
    local f = EnsureArrow()
    if not f:IsShown() then
      arrow.angle, arrow.distance, arrow.words = nil, "", ""
      f:Show()
    end
  elseif arrow.frame and arrow.frame:IsShown() then
    arrow.frame:Hide()
  end

  -- the step list (while the two are being moved: also with no route, unless it hangs under Questie's list)
  if (r and db.list ~= false) or (moving and not (list.docked and QuestieList())) then
    local f = EnsureList()
    ListUpdate(f, r)
    if not f:IsShown() then f:Show() end
  elseif list.frame and list.frame:IsShown() then
    list.frame:Hide()
    list.sig = ""
  end

  -- the question about the level: once for each waypoint that has one to ask
  local key = t.kind ~= 0 and (t.map .. ":" .. t.x .. ":" .. t.y) or nil
  if ask.key and ask.key ~= key then ask.key = nil end
  local shown = ask.frame and ask.frame:IsShown()
  if r and r.lv then
    if r.lv.ask and key and ask.key ~= key and r.tm == t.map and r.tx == t.x and r.ty == t.y then
      ask.key = key
      ShowAsk(r)
    elseif shown and (ask.id ~= r.lv.id or ask.at ~= r.lv.at) then
      ShowAsk(r) -- (a newer delivery while it is open: show what is so now)
    end
  elseif shown then
    ask.frame:Hide()
  end
end

-- ---- what you can tell it ------------------------------------------------------------------------
function shared.GuideCommand(word)
  local db = Settings()
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
    say(db.list and "the step list is on." or "the step list is off.")
  elseif word == "pin" then
    db.pin = db.pin == false
    list.sig = ""
    if moving then SetMoving(false) end
    say(db.pin and "the step list hangs under Questie's quest list (where Questie shows one)." or "the step list stands on its own: /atlas move lets you drag it.")
  elseif word == "move" then
    SetMoving(not moving)
    local pinned = list.docked and QuestieList() ~= nil
    say(moving and ("drag the arrow" .. (pinned and "" or " and the step list") .. " where you want " .. (pinned and "it" or "them") .. ", then type /atlas move again."
      .. (pinned and " (The step list hangs under Questie's quest list: /atlas pin sets it free.)" or "")) or "the arrow and the step list stay where they are now.")
  elseif word == "reset" then
    db.arrowAt, db.listAt = nil, nil
    for i = 1, #movers do
      if not (movers[i] == list.frame and list.docked) then Place(movers[i], movers[i].placeKey, movers[i].placeDefault) end
    end
    say("the arrow and the step list are back where they started.")
  else
    return false
  end
  return true
end

-- (for the tests, and for a look from the game with /dump AzerothAtlas.GuidePeek())
function shared.GuidePeek()
  return { arrow = arrow, list = list, ask = ask, moving = moving, hooked = hooked, AimPoint = AimPoint, StepLeft = StepLeft, Look = Look }
end
