-- Azeroth Atlas: the guide's window.
--
-- GuideSteps.lua follows your guide. This file shows it:
--   the window    the guide's steps, the ones you are on bright and scrolled into view, each with
--                 a box to tick it off yourself (or to take the tick away); under a quest step
--                 what the quest still asks for; at the end, the guide that comes next;
--   the list      every guide the installed packs bring, the ones for your character first:
--                 click one to follow it. How quests are accepted for you is set there too;
--   the buttons   beside the window: target who the step is about, use the item it names (keys
--                 can be bound to the first of each).
--
-- /atlas guide            the window, shown or hidden      (/lime does the same when Guidelime is not switched on)
-- /atlas guides           the list of guides
-- /atlas guide skip       tick off the steps you are on
-- /atlas guide reset      take every tick of this guide away
-- Drag the window by its title; drag its corner to size it.

local shared = AzerothAtlas
local book = type(shared) == "table" and shared.Book
local run = type(shared) == "table" and shared.Guide
if type(book) ~= "table" or type(run) ~= "table" then return end

local Quest = book.Quest
local plain, text = book.plain, book.text
local floor, max, min = math.floor, math.max, math.min

local PAD, BOX, GAP, TITLE_H = 6, 14, 4, 20
local SIDE = 30               -- the size of a button beside the window
local SIDE_COUNT = 4          -- of each kind
local PICK_ROWS, PICK_H, PICK_W = 20, 16, 380
local GOLD, BLUE, GREY, DIM = "|cffffd100", "|cff7fb8ff", "|cff9a9a9a", "|cff6e6e6e"
local ICON = {
  QA = "Interface\\GossipFrame\\AvailableQuestIcon", QT = "Interface\\GossipFrame\\ActiveQuestIcon", QC = "Interface\\GossipFrame\\BattleMasterGossipIcon",
  QS = "Interface\\GossipFrame\\IncompleteQuestIcon", F = "Interface\\GossipFrame\\TaxiGossipIcon", P = "Interface\\GossipFrame\\TaxiGossipIcon",
  T = "Interface\\GossipFrame\\TrainerGossipIcon", LE = "Interface\\GossipFrame\\TrainerGossipIcon", V = "Interface\\GossipFrame\\VendorGossipIcon",
  CI = "Interface\\GossipFrame\\VendorGossipIcon", S = "Interface\\GossipFrame\\BinderGossipIcon", H = "Interface\\Icons\\INV_Misc_Rune_01",
  R = "Interface\\Icons\\Trade_BlackSmithing",
}
local TARGET_ICON = "Interface\\Icons\\Ability_Hunter_Snipershot"
local MODES = { "Off", "Current", "Guide", "All" }
local MODE_WORDS = { Off = "no", Current = "those of the step you are on", Guide = "any the guide speaks of", All = "every quest" }

local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end
local function Options() return shared.GuideOptions() end
local function Char()
  if type(AzerothAtlasCharDB) ~= "table" then AzerothAtlasCharDB = {} end
  return AzerothAtlasCharDB
end
local function Fighting() return InCombatLockdown ~= nil and InCombatLockdown() end

local function ItemName(id)
  local name
  if C_Item and C_Item.GetItemNameByID then name = C_Item.GetItemNameByID(id) elseif GetItemInfo then name = GetItemInfo(id) end
  return text(name)
end
local function ItemIcon(id)
  local icon
  if C_Item and C_Item.GetItemIconByID then icon = C_Item.GetItemIconByID(id) elseif GetItemIcon then icon = GetItemIcon(id) end
  return icon
end

-- ---- a step in words -------------------------------------------------------------------------------
local function Pic(path) return "|T" .. path .. ":0|t" end

-- lit: the step is one you are on (names stand out, and what a quest still asks for is listed)
local function StepText(s, lit)
  local parts = {}
  local function add(str) if str and str ~= "" then parts[#parts + 1] = str end end
  local function name(str, colour)
    if not str or str == "" then return end
    add(lit and (colour .. str .. "|r") or str)
  end
  for _, e in ipairs(s.els) do
    local t = e.t
    if t == "TEXT" then
      add(lit and e.text or (string.gsub(string.gsub(e.text, "|c%x%x%x%x%x%x%x%x", ""), "|r", "")))
    elseif e.quest then
      add(Pic(ICON[t] or ICON.QC))
      if e.title ~= "" then name(e.title or Quest.Name(e.quest) or ("quest " .. e.quest), e.out and GREY or GOLD) end
    elseif t == "XP" then
      name(e.text or e.label, BLUE)
    elseif t == "CI" then
      add(Pic(ICON.CI))
      if e.title ~= "" then name(e.title or ItemName(e.item) or ("item " .. e.item), GOLD) end
      if lit and e.count > 1 then add(" (" .. min(book.ItemCount(e.item), e.count) .. "/" .. e.count .. ")") end
    elseif t == "UI" then
      if e.title ~= "" then name(e.title or ItemName(e.item) or ("item " .. e.item), GOLD) end
    elseif t == "TAR" then
      if e.title ~= "" then name(e.title or Quest.NpcName(e.npc) or "", GOLD) end
    elseif t == "SP" then
      name(e.title, GOLD)
    elseif t == "LE" or t == "SK" then
      add(Pic(ICON.LE))
      name(e.text or (e.spell and "a new spell") or "", BLUE)
      if lit and e.skill and e.text == e.label then
        local rank, top = book.Skill(e.skill)
        if rank then add(" (" .. (e.trained and top or rank) .. "/" .. (e.trained or e.rank) .. ")") end
      end
    elseif t == "REP" then
      name(e.text, BLUE)
    elseif t == "LI" then
      name(e.text, BLUE)
    elseif ICON[t] then
      add(Pic(ICON[t]))
      name(e.text, BLUE)
    end
  end
  local words = table.concat(parts)
  if lit then
    -- what the quests of this step still ask for
    local listed = {}
    for _, e in ipairs(s.els) do
      local l = (e.t == "QC" or e.t == "QT") and not e.done and run.log[e.quest]
      if l then
        listed[e.quest] = listed[e.quest] or {}
        for i, goal in ipairs(l.goals) do
          if (e.objective == nil or e.objective == i or e.t == "QT") and not goal.done and goal.text ~= "" and not listed[e.quest][i] then
            listed[e.quest][i] = true
            words = words .. "\n    - " .. goal.text
          end
        end
      end
    end
  elseif (s.missing or s.lacking) and not s.done and not s.skip then
    -- why it is out of reach
    local needs = {}
    local list = s.missing or s.lacking
    for i = 1, min(2, #list) do needs[#needs + 1] = Quest.Name(list[i]) or ("quest " .. list[i]) end
    words = words .. "\n    (" .. (s.missing and "not yet: first " or "not in your quest log: ") .. table.concat(needs, ", ") .. ")"
  end
  return words
end

-- ---- the window ---------------------------------------------------------------------------------------
local win = { frame = nil, rows = {}, shownRows = 0, first = nil, layoutW = 0 }
local pick = { frame = nil, rows = {}, list = {}, at = 0, all = false }
local side = { holder = nil, targets = {}, items = {}, late = false, sig = "" }
local ShowPicker, SideUpdate -- (below)

local function Label(parent, font, size)
  local fs = parent:CreateFontString(nil, "OVERLAY", font or "GameFontHighlightSmall")
  if size and fs.SetFont and STANDARD_TEXT_FONT then pcall(fs.SetFont, fs, STANDARD_TEXT_FONT, size, "") end
  fs:SetJustifyH("LEFT")
  if fs.SetJustifyV then fs:SetJustifyV("TOP") end
  return fs
end
local function TextButton(parent, words, onClick)
  local b = CreateFrame("Button", nil, parent)
  local fs = Label(b)
  fs:SetPoint("LEFT", b, "LEFT", 0, 0)
  fs:SetText(words)
  fs:SetTextColor(0.5, 0.72, 1)
  b.text = fs
  b:SetSize(max(20, (fs.GetStringWidth and fs:GetStringWidth() or 40) + 2), 14)
  b:RegisterForClicks("LeftButtonUp")
  b:SetScript("OnClick", function() pcall(onClick) end)
  return b
end

local function SavePlace(f)
  local left, top = f:GetLeft(), f:GetTop()
  if left and top then Char().guideWin = { left, top, f:GetWidth(), f:GetHeight() } end
end

local function Row(i)
  local f = win.frame
  local row = win.rows[i]
  if row then return row end
  row = CreateFrame("Frame", nil, f.child)
  local box = CreateFrame("Button", nil, row)
  box:SetSize(BOX, BOX)
  box:SetPoint("TOPLEFT", row, "TOPLEFT", 0, 0)
  local edge = box:CreateTexture(nil, "BACKGROUND")
  edge:SetAllPoints(box)
  edge:SetTexture("Interface\\Buttons\\UI-CheckBox-Up")
  local tick = box:CreateTexture(nil, "OVERLAY")
  tick:SetAllPoints(box)
  tick:SetTexture("Interface\\Buttons\\UI-CheckBox-Check")
  tick:Hide()
  box:RegisterForClicks("LeftButtonUp")
  box:SetScript("OnClick", function()
    local s = row.index and run.steps[row.index]
    if s then
      -- (a step the game shows to be done has no tick to take away)
      if s.done and not s.skip then return end
      shared.GuideTick(row.index, not s.skip)
    elseif row.link then
      if shared.GuideLoad(row.link) then say("now following " .. row.link .. ".") end
    end
  end)
  box:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    local s = row.index and run.steps[row.index]
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    if row.link then GameTooltip:AddLine("Follow this guide next.")
    elseif s and s.skip then GameTooltip:AddLine("Ticked off. Click to take the tick away.")
    elseif s and s.done then GameTooltip:AddLine("Done.")
    else GameTooltip:AddLine("Click to tick this step off yourself.") end
    GameTooltip:Show()
  end)
  box:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  local words = Label(row, "GameFontHighlight", Options().fontSize)
  words:SetPoint("TOPLEFT", row, "TOPLEFT", BOX + 4, -1)
  if words.SetWordWrap then words:SetWordWrap(true) end
  if words.SetNonSpaceWrap then words:SetNonSpaceWrap(true) end
  row.box, row.tick, row.words = box, tick, words
  win.rows[i] = row
  return row
end

-- What to list: the steps (those done, out of reach or still to come only if you have them
-- shown), then the guides that come next.
local function Listed()
  local o = Options()
  local out = {}
  for i, s in ipairs(run.steps) do
    local keep = s.active
    if not keep then
      if s.skip or s.done then keep = o.showDone
      elseif not s.available then keep = o.showOut
      else keep = o.showLater end
    end
    if keep then out[#out + 1] = { index = i } end
  end
  if run.guide then
    for _, name in ipairs(book.Next(run.guide)) do out[#out + 1] = { link = name } end
  end
  return out
end

-- Guide packs the game did not load, because they still name Guidelime as the addon they need
-- (looked up once: the game reads its addon list when it starts).
local waiting
local function Waiting()
  if not waiting then
    local ok, list = pcall(book.Waiting)
    waiting = ok and type(list) == "table" and list or {}
  end
  return waiting
end
local function WaitingWords(list)
  local which = #list == 1 and ("The guide pack " .. list[1] .. " is installed, but the game did not load it")
    or (#list .. " guide packs are installed, but the game did not load them")
  return which .. ": a guide pack names Guidelime as the addon it needs, and Guidelime is not switched on. On the 3D map's page press \"Convert guide packs\", then restart the game (leave it altogether, not /reload)."
end

local function Message()
  if run.state == "foreign" then return "Guidelime is switched on and runs your guides. Switch it off in the game's addon list to use this window instead." end
  if not run.guide then
    if book.count == 0 then
      if #Waiting() > 0 then return WaitingWords(Waiting()) end
      return "No guide pack is installed. Guide packs made for Guidelime work here: install one, then press \"Convert guide packs\" on the 3D map's page."
    end
    return "No guide chosen. Click Guides to pick one."
  end
  if not run.first then
    for _, s in ipairs(run.steps) do
      if s.active then return nil end
    end
    return "This guide is done."
  end
  return nil
end

local function Fill()
  local f = win.frame
  if not f or not f:IsShown() then return end
  local width = max(60, f:GetWidth() - PAD * 2 - 4)
  local g = run.guide
  f.title:SetText(g and ((g.min or g.max) and ((g.min or "") .. "-" .. (g.max or "") .. " ") or "") .. (g.title or "") or "Guide")
  f.title:SetWidth(max(40, f:GetWidth() - 90))
  local y = 0
  local note = Message()
  if note then
    f.note:SetWidth(width)
    f.note:SetText(note)
    f.note:Show()
    y = (f.note.GetStringHeight and f.note:GetStringHeight() or 14) + GAP * 2
  else
    f.note:Hide()
  end
  local listed = g and Listed() or {}
  local firstTop = nil
  for n, item in ipairs(listed) do
    local row = Row(n)
    local s = item.index and run.steps[item.index]
    row.index, row.link = item.index, item.link
    local words
    if s then
      words = StepText(s, s.active)
      if s.active then row.words:SetTextColor(1, 1, 1)
      elseif s.skip or s.done then row.words:SetTextColor(0.45, 0.45, 0.45)
      elseif not s.available then row.words:SetTextColor(0.5, 0.42, 0.42)
      else row.words:SetTextColor(0.66, 0.66, 0.66) end
      if s.skip or s.done then row.tick:Show() else row.tick:Hide() end
      if s.active and firstTop == nil and (item.index == run.first or not run.first) then firstTop = y end
    else
      words = "Continue with " .. item.link
      row.words:SetTextColor(0.5, 0.72, 1)
      row.tick:Hide()
    end
    row.words:SetWidth(width - BOX - 4)
    if row.shown ~= words then
      row.shown = words
      row.words:SetText(words)
    end
    local height = max(BOX, (row.words.GetStringHeight and row.words:GetStringHeight() or BOX) + 2)
    row:ClearAllPoints()
    row:SetPoint("TOPLEFT", f.child, "TOPLEFT", 0, -y)
    row:SetSize(width, height)
    row:Show()
    y = y + height + GAP
  end
  for n = #listed + 1, win.shownRows do
    win.rows[n]:Hide()
  end
  win.shownRows = #listed
  f.child:SetSize(width, max(1, y))
  -- the step you are on, into view when it has changed
  local range = max(0, y - f.scroll:GetHeight())
  if win.first ~= run.first or win.guide ~= g then
    win.first, win.guide = run.first, g
    f.scroll:SetVerticalScroll(min(range, max(0, (firstTop or 0) - 22)))
  elseif f.scroll:GetVerticalScroll() > range then
    f.scroll:SetVerticalScroll(range)
  end
end

local function EnsureWindow()
  if win.frame then return win.frame end
  local o = Options()
  local f = CreateFrame("Frame", "AzerothAtlasGuide", UIParent)
  f:SetFrameStrata("LOW")
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  if f.SetResizable then f:SetResizable(true) end
  if f.SetResizeBounds then f:SetResizeBounds(200, 110) elseif f.SetMinResize then f:SetMinResize(200, 110) end
  local at = Char().guideWin
  local theirs = type(GuidelimeDataChar) == "table" and GuidelimeDataChar or {}
  if type(at) == "table" and plain(at[1]) and plain(at[2]) then
    f:SetSize(max(200, plain(at[3]) or 340), max(110, plain(at[4]) or 380))
    f:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", at[1], at[2])
  else
    -- (the first time: as wide and tall as you had Guidelime's)
    f:SetSize(max(200, plain(theirs.mainFrameWidth) or 340), max(110, plain(theirs.mainFrameHeight) or 380))
    f:SetPoint("RIGHT", UIParent, "RIGHT", -30, 40)
  end
  if o.fontSize == nil then o.fontSize = min(18, max(9, plain(theirs.mainFrameFontSize) or 12)) end
  local back = f:CreateTexture(nil, "BACKGROUND")
  back:SetAllPoints(f)
  back:SetColorTexture(0, 0, 0, 0.5)
  -- the title: drag it to move the window
  local bar = CreateFrame("Frame", nil, f)
  bar:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
  bar:SetPoint("TOPRIGHT", f, "TOPRIGHT", 0, 0)
  bar:SetHeight(TITLE_H)
  bar:EnableMouse(true)
  bar:RegisterForDrag("LeftButton")
  bar:SetScript("OnDragStart", function() if not Options().lock then f:StartMoving() end end)
  bar:SetScript("OnDragStop", function()
    f:StopMovingOrSizing()
    SavePlace(f)
    side.sig = ""
  end)
  local shade = bar:CreateTexture(nil, "BACKGROUND")
  shade:SetAllPoints(bar)
  shade:SetColorTexture(0.1, 0.16, 0.26, 0.85)
  local title = Label(bar, "GameFontNormal")
  title:SetPoint("LEFT", bar, "LEFT", PAD, 0)
  if title.SetWordWrap then title:SetWordWrap(false) end
  f.title = title
  local close = TextButton(bar, "x", function() shared.GuideWindow(false) end)
  close:SetPoint("RIGHT", bar, "RIGHT", -4, 0)
  local guides = TextButton(bar, "Guides", function() ShowPicker(not (pick.frame and pick.frame:IsShown())) end)
  guides:SetPoint("RIGHT", close, "LEFT", -8, 0)
  -- the steps
  local scroll = CreateFrame("ScrollFrame", nil, f)
  scroll:SetPoint("TOPLEFT", f, "TOPLEFT", PAD, -TITLE_H - 4)
  scroll:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -PAD, PAD)
  local child = CreateFrame("Frame", nil, scroll)
  child:SetSize(100, 1)
  scroll:SetScrollChild(child)
  scroll:EnableMouseWheel(true)
  scroll:SetScript("OnMouseWheel", function(self, delta)
    local range = max(0, child:GetHeight() - self:GetHeight())
    self:SetVerticalScroll(min(range, max(0, self:GetVerticalScroll() - delta * 40)))
  end)
  f.scroll, f.child = scroll, child
  local note = Label(child, "GameFontHighlight")
  note:SetPoint("TOPLEFT", child, "TOPLEFT", 0, -2)
  note:SetTextColor(0.8, 0.8, 0.8)
  if note.SetWordWrap then note:SetWordWrap(true) end
  note:Hide()
  f.note = note
  -- the corner: drag it to size the window
  local grip = CreateFrame("Button", nil, f)
  grip:SetSize(14, 14)
  grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", 0, 0)
  local mark = grip:CreateTexture(nil, "OVERLAY")
  mark:SetAllPoints(grip)
  mark:SetColorTexture(1, 1, 1, 0.18)
  grip:SetScript("OnMouseDown", function() if not Options().lock and f.StartSizing then f:StartSizing("BOTTOMRIGHT") end end)
  grip:SetScript("OnMouseUp", function()
    f:StopMovingOrSizing()
    SavePlace(f)
    side.sig = ""
    for _, row in pairs(win.rows) do row.shown = nil end
    pcall(Fill)
  end)
  f:SetScript("OnSizeChanged", function()
    if win.layoutW ~= f:GetWidth() then
      win.layoutW = f:GetWidth()
      pcall(Fill)
    end
  end)
  f:Hide()
  win.frame = f
  return f
end

-- Show the window, or hide it (and remember which).
function shared.GuideWindow(on)
  local o = Options()
  o.shown = on and true or false
  if on then
    local f = EnsureWindow()
    f:Show()
    win.first = false -- (scroll to the step you are on)
    pcall(Fill)
  elseif win.frame then
    win.frame:Hide()
    if pick.frame then pick.frame:Hide() end
  end
  side.sig = ""
  pcall(SideUpdate)
end

-- ---- the buttons beside the window ------------------------------------------------------------------------
-- They do what only a key or a click of yours may do (target someone, use an item), so the game
-- lets them be changed only while you are not in a fight: what a step brings waits until then.
local function SideButton(kind, i)
  local b = CreateFrame("Button", "AzerothAtlasGuide" .. kind .. i, side.holder, "SecureActionButtonTemplate")
  b:SetSize(SIDE, SIDE)
  b:RegisterForClicks("AnyUp", "AnyDown")
  local icon = b:CreateTexture(nil, "ARTWORK")
  icon:SetAllPoints(b)
  b.icon = icon
  local glow = b:CreateTexture(nil, "HIGHLIGHT")
  glow:SetAllPoints(b)
  glow:SetColorTexture(1, 1, 1, 0.2)
  b:SetScript("OnEnter", function(self)
    if not GameTooltip or not self.tip then return end
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    GameTooltip:AddLine(self.tip)
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  b:Hide()
  return b
end

-- Who the steps you are on are about, and what they have you use.
local function SideWanted()
  local targets, items, seen = {}, {}, {}
  local g = run.guide
  if not g or run.state ~= "on" then return targets, items end
  local function target(name)
    if name and name ~= "" and not seen[name] and #targets < SIDE_COUNT then
      seen[name] = true
      targets[#targets + 1] = name
    end
  end
  local function item(id)
    if id and not seen[id] and #items < SIDE_COUNT and book.ItemCount(id) > 0 then
      seen[id] = true
      items[#items + 1] = id
    end
  end
  for _, s in ipairs(run.steps) do
    if s.active then
      for _, e in ipairs(s.els) do
        if e.t == "TAR" then target(Quest.NpcName(e.npc) or (e.title ~= "" and e.title) or nil)
        elseif e.t == "UI" then item(e.item)
        elseif e.t == "H" and g.autoItem ~= false then item(6948) end
      end
      if g.autoTarget ~= false then
        for _, e in ipairs(s.els) do
          if e.quest and not e.done and not e.out and (e.t == "QA" or e.t == "QT" or e.t == "QC") then
            for _, npc in ipairs(book.Npcs(e)) do target(Quest.NpcName(npc)) end
          end
        end
      end
    end
  end
  return targets, items
end

SideUpdate = function()
  local f = win.frame
  local on = f and f:IsShown() and Options().buttons and run.state == "on"
  local targets, items = {}, {}
  if on then targets, items = SideWanted() end
  local left, top = f and f:GetLeft(), f and f:GetTop()
  local sig = (on and "1" or "0") .. ":" .. floor(left or 0) .. ":" .. floor(top or 0) .. ":" .. table.concat(targets, "\1") .. ":" .. table.concat(items, ",")
  if sig == side.sig then return end
  if Fighting() then
    side.late = true
    return
  end
  side.sig, side.late = sig, false
  if not side.holder then
    if not on then return end
    side.holder = CreateFrame("Frame", "AzerothAtlasGuideButtons", UIParent)
    side.holder:SetSize(SIDE, SIDE)
    for i = 1, SIDE_COUNT do
      side.targets[i] = SideButton("Target", i)
      side.items[i] = SideButton("Item", i)
    end
  end
  local holder = side.holder
  if not on or (#targets == 0 and #items == 0) then
    holder:Hide()
    return
  end
  -- to the left of the window, or to its right where there is no room
  local x = (left or 0) - SIDE - 4
  if x < 0 then x = (left or 0) + f:GetWidth() + 4 end
  holder:ClearAllPoints()
  holder:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", x, (top or 0) - TITLE_H)
  local n = 0
  for i = 1, SIDE_COUNT do
    local b, name = side.targets[i], targets[i]
    if name then
      b:SetAttribute("type", "macro")
      b:SetAttribute("macrotext", "/cleartarget\n/targetexact " .. name .. "\n/cleartarget [dead]")
      b.icon:SetTexture(TARGET_ICON)
      b.tip = "Target " .. name
      b:ClearAllPoints()
      b:SetPoint("TOPLEFT", holder, "TOPLEFT", 0, -n * (SIDE + 2))
      b:Show()
      n = n + 1
    else
      b:Hide()
    end
  end
  for i = 1, SIDE_COUNT do
    local b, id = side.items[i], items[i]
    if id then
      b:SetAttribute("type", "item")
      b:SetAttribute("item", "item:" .. id)
      b.icon:SetTexture(ItemIcon(id) or "Interface\\Icons\\INV_Misc_QuestionMark")
      b.tip = "Use " .. (ItemName(id) or "the item")
      b:ClearAllPoints()
      b:SetPoint("TOPLEFT", holder, "TOPLEFT", 0, -n * (SIDE + 2))
      b:Show()
      n = n + 1
    else
      b:Hide()
    end
  end
  holder:Show()
end

-- ---- the list of guides ---------------------------------------------------------------------------------------
local function PickList()
  local list, groups = {}, {}
  for _, name in ipairs(book.names) do
    local g = book.guides[name]
    if g and (pick.all or book.Fits(g.cond)) then
      local group = g.group or "Other guides"
      if not groups[group] then
        groups[group] = {}
        groups[#groups + 1] = group
      end
      table.insert(groups[group], g)
    end
  end
  table.sort(groups)
  for _, group in ipairs(groups) do
    list[#list + 1] = { header = group }
    table.sort(groups[group], function(a, b)
      local la, lb = a.min or a.max or 999, b.min or b.max or 999
      if la ~= lb then return la < lb end
      return a.name < b.name
    end)
    for _, g in ipairs(groups[group]) do list[#list + 1] = { guide = g } end
  end
  pick.list = list
end

local function PickFill()
  local f = pick.frame
  if not f or not f:IsShown() then return end
  local o = Options()
  local top = max(0, #pick.list - PICK_ROWS)
  if pick.at > top then pick.at = top end
  local level = book.Me().level
  for i = 1, PICK_ROWS do
    local row, item = pick.rows[i], pick.list[pick.at + i]
    row.item = item
    if not item then
      row:Hide()
    else
      if item.header then
        row.text:SetText(item.header)
        row.text:SetTextColor(1, 0.82, 0.1)
      else
        local g = item.guide
        local range = (g.min or g.max) and ((g.min or "") .. "-" .. (g.max or "") .. "  ") or ""
        row.text:SetText("   " .. (g == run.guide and "> " or "") .. range .. (g.title or ""))
        if g == run.guide then row.text:SetTextColor(0.5, 1, 0.5)
        elseif g.min and g.max and level >= g.min and level <= g.max then row.text:SetTextColor(1, 1, 1)
        else row.text:SetTextColor(0.7, 0.7, 0.7) end
      end
      row:Show()
    end
  end
  f.all.text:SetText(pick.all and "Showing every guide (click: only those for my character)" or "Showing the guides for my character (click: every guide)")
  f.accept.text:SetText("Accept quests for me: " .. MODE_WORDS[o.accept])
  f.turnin.text:SetText("Hand quests in for me: " .. MODE_WORDS[o.turnin])
  f.flight.text:SetText("Take the flight a step names: " .. (o.flight and "yes" or "no"))
  f.done.text:SetText("List steps already done: " .. (o.showDone and "yes" or "no"))
  f.side.text:SetText("Buttons to target and to use items: " .. (o.buttons and "yes" or "no"))
  f.count:SetText(book.count .. " guides installed. Hold Shift at an NPC to accept or hand in nothing.")
end

local function EnsurePicker()
  if pick.frame then return pick.frame end
  local f = CreateFrame("Frame", "AzerothAtlasGuides", UIParent)
  f:SetSize(PICK_W, TITLE_H + PICK_ROWS * PICK_H + 124)
  f:SetFrameStrata("DIALOG")
  f:SetPoint("CENTER", UIParent, "CENTER", 0, 40)
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) self:StartMoving() end)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing() end)
  local back = f:CreateTexture(nil, "BACKGROUND")
  back:SetAllPoints(f)
  back:SetColorTexture(0.03, 0.04, 0.06, 0.94)
  local title = Label(f, "GameFontNormal")
  title:SetPoint("TOPLEFT", f, "TOPLEFT", PAD + 2, -6)
  title:SetText("Guides")
  local close = TextButton(f, "x", function() f:Hide() end)
  close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -6, -5)
  for i = 1, PICK_ROWS do
    local row = CreateFrame("Button", nil, f)
    row:SetSize(PICK_W - PAD * 2, PICK_H)
    row:SetPoint("TOPLEFT", f, "TOPLEFT", PAD, -TITLE_H - 4 - (i - 1) * PICK_H)
    local glow = row:CreateTexture(nil, "HIGHLIGHT")
    glow:SetAllPoints(row)
    glow:SetColorTexture(1, 1, 1, 0.1)
    local words = Label(row)
    words:SetPoint("LEFT", row, "LEFT", 2, 0)
    words:SetWidth(PICK_W - PAD * 2 - 4)
    if words.SetWordWrap then words:SetWordWrap(false) end
    row.text = words
    row:RegisterForClicks("LeftButtonUp")
    row:SetScript("OnClick", function(self)
      local g = self.item and self.item.guide
      if g and shared.GuideLoad(g.name) then
        say("now following " .. g.name .. ".")
        shared.GuideWindow(true)
        pcall(PickFill)
      end
    end)
    row:SetScript("OnEnter", function(self)
      local g = self.item and self.item.guide
      if not (g and g.details and GameTooltip) then return end
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      GameTooltip:AddLine(g.title or "", 1, 0.82, 0.1)
      GameTooltip:AddLine(g.details, 1, 1, 1, true)
      GameTooltip:Show()
    end)
    row:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
    pick.rows[i] = row
  end
  f:EnableMouseWheel(true)
  f:SetScript("OnMouseWheel", function(_, delta)
    pick.at = min(max(0, #pick.list - PICK_ROWS), max(0, pick.at - delta * 3))
    pcall(PickFill)
  end)
  -- how it is set (a click changes it)
  local y = -TITLE_H - 10 - PICK_ROWS * PICK_H
  local function setting(key, onClick)
    local b = TextButton(f, " ", function()
      local o = Options()
      onClick(o)
      o.seeded = true -- (set by you: Guidelime's settings are not taken over it later)
      run.rev = run.rev + 1
      pcall(PickFill)
    end)
    b:SetSize(PICK_W - PAD * 2, 14)
    b.text:SetWidth(PICK_W - PAD * 2)
    b:SetPoint("TOPLEFT", f, "TOPLEFT", PAD + 2, y)
    y = y - 16
    f[key] = b
  end
  local function nextMode(v)
    for i, mode in ipairs(MODES) do
      if mode == v then return MODES[i % #MODES + 1] end
    end
    return "Current"
  end
  setting("all", function()
    pick.all, pick.at = not pick.all, 0
    PickList()
  end)
  setting("accept", function(o) o.accept = nextMode(o.accept) end)
  setting("turnin", function(o) o.turnin = nextMode(o.turnin) end)
  setting("flight", function(o) o.flight = not o.flight end)
  setting("done", function(o) o.showDone = not o.showDone end)
  setting("side", function(o) o.buttons = not o.buttons end)
  local count = Label(f)
  count:SetPoint("TOPLEFT", f, "TOPLEFT", PAD + 2, y - 2)
  count:SetWidth(PICK_W - PAD * 2)
  count:SetTextColor(0.6, 0.6, 0.6)
  f.count = count
  if type(UISpecialFrames) == "table" then table.insert(UISpecialFrames, "AzerothAtlasGuides") end
  f:Hide()
  pick.frame = f
  return f
end

ShowPicker = function(on)
  if not on then
    if pick.frame then pick.frame:Hide() end
    return
  end
  local f = EnsurePicker()
  PickList()
  -- (open at the guide you follow)
  pick.at = 0
  for i, item in ipairs(pick.list) do
    if item.guide and item.guide == run.guide then pick.at = max(0, i - 4) break end
  end
  f:Show()
  PickFill()
end
shared.GuidePicker = ShowPicker

-- ---- kept up to date ----------------------------------------------------------------------------------------------
-- (GuideSteps.lua calls this when what the window shows has changed)
local opened = false
function shared.GuideShow()
  if not opened and run.state ~= "wait" then
    -- the first time after logging in: the window as you left it (shown, until you hide it)
    opened = true
    -- (with no guide pack installed there is nothing to show unasked)
    if run.state == "on" and Options().shown ~= false and (run.guide or book.count > 0) then
      EnsureWindow():Show()
    end
  end
  Fill()
  SideUpdate()
  if pick.frame and pick.frame:IsShown() then PickFill() end
end

local watch = CreateFrame("Frame", nil, UIParent)
pcall(watch.RegisterEvent, watch, "PLAYER_REGEN_ENABLED")
pcall(watch.RegisterEvent, watch, "GET_ITEM_INFO_RECEIVED")
pcall(watch.RegisterEvent, watch, "BAG_UPDATE_DELAYED")
watch:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_REGEN_ENABLED" then
    if side.late then pcall(SideUpdate) end
  elseif event == "BAG_UPDATE_DELAYED" then
    -- (an item a step has you use has come into your bags, or gone)
    pcall(SideUpdate)
  elseif run.guide then
    -- (an item's name has arrived: the rows that name it are written again)
    for _, row in pairs(win.rows) do row.shown = nil end
    run.rev = run.rev + 1
  end
end)

-- ---- what you can tell it --------------------------------------------------------------------------------------------
local function Foreign()
  if run.state ~= "foreign" then return false end
  say("Guidelime is switched on and runs your guides. To use the guide window built into this addon instead, switch Guidelime off in the game's addon list (or remove it), and press \"Convert guide packs\" on the 3D map's page if it is offered there. The guide Guidelime has open and what it has ticked come with you.")
  return true
end

function shared.GuideWord(word, rest)
  if word == "guides" then
    if not Foreign() then ShowPicker(not (pick.frame and pick.frame:IsShown())) end
    return true
  elseif word ~= "guide" then
    return false
  end
  if Foreign() then return true end
  if rest == "skip" then
    if not shared.GuideSkipNow() then say("there is no step to tick off.") end
  elseif rest == "reset" then
    shared.GuideReset()
    say("every tick of this guide is taken away.")
  elseif rest == "lock" then
    local o = Options()
    o.lock = not o.lock
    say(o.lock and "the guide window stays where it is." or "the guide window can be dragged and sized again.")
  elseif rest == "list" then
    ShowPicker(true)
  else
    shared.GuideWindow(not (win.frame and win.frame:IsShown()))
  end
  return true
end

-- Guidelime's own command, while Guidelime is not there to answer it.
local function LimeCommand()
  if run.state ~= "on" or SlashCmdList == nil or SlashCmdList.Guidelime ~= nil then return end
  SLASH_AZEROTHATLASGUIDE1, SLASH_AZEROTHATLASGUIDE2 = "/lime", "/guidelime"
  SlashCmdList.AZEROTHATLASGUIDE = function(msg)
    local word = type(msg) == "string" and string.lower(string.match(msg, "^%s*(%S*)") or "") or ""
    shared.Try("guide word", shared.GuideWord, "guide", word == "complete" and "skip" or word)
  end
end
-- Guide packs that could not load are said once when you log in: with none loaded there is no
-- window to say it in.
local function Hint()
  if run.state == "on" and #Waiting() > 0 then say(WaitingWords(Waiting())) end
end
local boot = CreateFrame("Frame", nil, UIParent)
boot:RegisterEvent("PLAYER_LOGIN")
boot:SetScript("OnEvent", function()
  local function late()
    pcall(LimeCommand)
    pcall(Hint)
  end
  if C_Timer and C_Timer.After then C_Timer.After(1, late) else late() end
end)

-- Keys can be set for these under Options > Keybindings > AddOns.
_G["BINDING_NAME_CLICK AzerothAtlasGuideToggle:LeftButton"] = "Show or hide the guide"
_G["BINDING_NAME_CLICK AzerothAtlasGuideTarget1:LeftButton"] = "Target who the guide's step is about"
_G["BINDING_NAME_CLICK AzerothAtlasGuideItem1:LeftButton"] = "Use the item the guide's step names"
local toggle = CreateFrame("Button", "AzerothAtlasGuideToggle", UIParent)
toggle:SetSize(1, 1)
toggle:Hide()
toggle:SetScript("OnClick", function() shared.Try("guide word", shared.GuideWord, "guide", "") end)

-- (for the tests, and for a look from the game with /dump AzerothAtlas.GuideWin())
function shared.GuideWin()
  return { win = win, pick = pick, side = side, StepText = StepText, Listed = Listed, Message = Message, Fill = Fill, SideWanted = SideWanted, PickList = PickList }
end
