-- Azeroth Atlas: your height, measured.
--
-- The game tells an addon where you are on the map and not how high. But it has a marker of
-- its own that it points at where you are heading, and it says how far off that is: and when
-- the marker is pointed at a flight master or a landmark of its map - places it knows in all
-- three dimensions - that distance counts height. (To a pin of your own it does not: tried in
-- the game, November 2026. Standing on the hill at Sentinel Hill the distance to the flight
-- master at its foot gave 51.8 yards for a height the map's ground has at 51.6, and followed
-- the climb up the tower yard by yard.)
--
-- So now and then the marker is pointed at two or three such places, one frame each, and at once
-- put back on what you were tracking. For each, what is left of the distance once the way
-- across the map is taken off is how far above or below that place you are. The addon cannot
-- say which of the two, nor what there is to stand on: it sends the two best of them to the 3D
-- map through the strip (the fix: AzerothAtlas.lua), and the map, which knows the floors, takes
-- the one at that height.
--
-- How much such a distance is worth depends on how steeply the place is above or below you: the
-- game's distance is good to about a twentieth of a yard, so a flight master a hundred yards
-- off and twenty below gives your height to a foot, and a town a thousand yards off at about
-- your own height gives it to ten yards - which still tells a cellar from a tower. The places
-- are chosen for that.
--
-- When: on arriving somewhere (a login, a portal, a hearthstone), on landing from a fall or a
-- flight, on coming out of water, on going indoors or out or into a place of another name, a
-- moment after you stop, and every few seconds while you move (more often under water).
-- /atlas measure turns it off and on, and says what it last found.
--
-- Not while you are dead. The game then keeps its marker on your body, whatever an addon points
-- it at, and the distance it gives is the way to that: taken for the distance to a flight master
-- it made a ghost, running back along the ground, hundreds of yards high - by as much as the
-- body was far off, less with every step towards it (a report of 20 November 2026: the 3D map
-- went up into the sky and came down again every few seconds). So nothing is measured from
-- dying until you live again, and a fix is taken as soon as you do. And whatever else may one
-- day hold the marker: a distance that is to the place the marker was pointed at changes when
-- the marker goes on to the next place. One that stays as it was is to something else, and
-- nothing is made of that fix (Finish).
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local sqrt, abs, huge = math.sqrt, math.abs, math.huge
local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function plain(v)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end
local function yes(v)
  if v == nil or secret(v) then return false end
  return v == true
end
local function call(fn, ...)
  if type(fn) ~= "function" then return nil end
  local ok, a, b = pcall(fn, ...)
  if ok then return a, b end
  return nil
end

local EVERY, EVERY_UNDER = 4, 1.5  -- seconds between two fixes while you move; under water
local GAP = 0.5                    -- ...and never sooner after the last than this
local MOVED = 3                    -- yards you must have moved since the last for another
local NEAR, FAR = 25, 9000         -- a place nearer than this is left alone (the game says "you have arrived"); further than this, not looked at
local SHOWN = 3                    -- seconds a fix is drawn in the strip
local EPS, EPS_FINE = 0.14, 0.012  -- twice what the way across the map may be out by, in yards, by the rounded spot and by the fine one (for weighing a place)
local PLACES = 3                   -- the marker is pointed at up to this many places for a fix

local fix = { seq = 0, at = -100, tried = -100, x = nil, y = nil, refs = {} } -- the last fix, as the strip draws it
local job = nil      -- a fix being taken: the places, which is being measured, what the marker was on
local bad = {}       -- places the game would not point its marker at, or that are not where the list has them: [kind * 100000 + id] = true
local was = {}       -- what the game said of you the last time it was looked at
local due = nil      -- when a fix is wanted whatever else (the game's clock)
local est = nil      -- your height as the last fix has it, to choose the places by
local count = { taken = 0, empty = 0, row = 0, odd = 0, offUntil = -100 }
local said = {}

-- Where you are, as finely as the game will say: north, west, and whether that is the fine way.
-- What the game gives outright (UnitPosition) is rounded to a tenth of a yard, and a twentieth
-- of a yard in the way across the map is what limits how well a height can be told from a
-- distance. Where you are on the game's own map of the place is not rounded: laid over the
-- world by that map's corners it gives the same spot some twenty times as finely. (Taken only
-- where it agrees with the rounded one: a map that does not lie over the world as taken here
-- must not make a height wrong.)
local corners = {}
local function Here()
  local x, y = UnitPosition("player")
  x, y = plain(x), plain(y)
  if not (x and y) then return nil end
  local uiMap = C_Map and C_Map.GetBestMapForUnit and plain(call(C_Map.GetBestMapForUnit, "player"))
  if uiMap and C_Map.GetPlayerMapPosition and C_Map.GetWorldPosFromMapPos and CreateVector2D then
    local c = corners[uiMap]
    if c == nil then
      c = false
      local _, a = call(C_Map.GetWorldPosFromMapPos, uiMap, CreateVector2D(0, 0))
      local _, b = call(C_Map.GetWorldPosFromMapPos, uiMap, CreateVector2D(1, 1))
      if a and b then
        local n0, w0 = a:GetXY()
        local n1, w1 = b:GetXY()
        n0, w0, n1, w1 = plain(n0), plain(w0), plain(n1), plain(w1)
        if n0 and w0 and n1 and w1 and n0 ~= n1 and w0 ~= w1 then c = { n0, w0, n1, w1 } end
      end
      corners[uiMap] = c
    end
    local at = c and call(C_Map.GetPlayerMapPosition, uiMap, "player")
    if at then
      local mx, my = at:GetXY()
      mx, my = plain(mx), plain(my)
      if mx and my then
        local fx, fy = c[1] + (c[3] - c[1]) * my, c[2] + (c[4] - c[2]) * mx
        if abs(fx - x) <= 0.08 and abs(fy - y) <= 0.08 then return fx, fy, true end
      end
    end
  end
  return x, y, false
end

local function PinType(kind)
  local T = Enum and Enum.SuperTrackingMapPinType
  if not T then return nil end
  if kind == 1 then return T.TaxiNode end
  return T.AreaPOI
end

-- Dead, or a ghost - or the game says its marker is on your body: the distance it gives is to
-- that, whatever the marker is pointed at (see the top of this file).
local function Dead()
  if UnitIsDeadOrGhost and yes(UnitIsDeadOrGhost("player")) then return true end
  if not C_SuperTrack then return false end
  if C_SuperTrack.IsSuperTrackingCorpse and yes(call(C_SuperTrack.IsSuperTrackingCorpse)) then return true end
  local T = Enum and Enum.SuperTrackingType
  if T and T.Corpse ~= nil and C_SuperTrack.GetHighestPrioritySuperTrackingType then
    return plain(call(C_SuperTrack.GetHighestPrioritySuperTrackingType)) == T.Corpse
  end
  return false
end

-- Whether the distances the game gave for the places of one fix went with its marker. Each is
-- to another place: they differ, as a rule by hundreds of yards. Two that are the same - but
-- for what you moved between the two frames - are the distance to one thing, which is neither
-- place. (Two places that happen to be as far off as each other, to a foot: that fix is lost,
-- and the next is four seconds away.)
local function Stuck(seen)
  for i = 1, #seen - 1 do
    for k = i + 1, #seen do
      local a, b = seen[i], seen[k]
      if abs(a.d - b.d) <= 0.05 + sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) then return true end
    end
  end
  return false
end

function shared.MeasureOn() return type(AzerothAtlasDB) ~= "table" or AzerothAtlasDB.measure ~= false end
function shared.SetMeasure(on)
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  AzerothAtlasDB.measure = on and true or false
end

-- The fix to draw in the strip, while it is fresh: seq, and for each of two places kind, id,
-- h (16ths of a yard) and d (8 yards) - or nil.
function shared.FixNow(now)
  if fix.seq == 0 or now - fix.at > SHOWN or #fix.refs == 0 then return nil end
  return fix
end

-- The places to measure by, from where you are: the few that should say most. A place says
-- most when it is steeply above or below you; with no idea yet of how high you are, the nearest.
local picked = {}
local function Pick(map, x, y)
  local list = shared.HeightRefs and shared.HeightRefs[map]
  for i = #picked, 1, -1 do picked[i] = nil end
  if not list then return picked end
  for i = 1, #list, 5 do
    local kind, id, rx, ry, rz = list[i], list[i + 1], list[i + 2], list[i + 3], list[i + 4]
    if not bad[kind * 100000 + id] then
      local across = sqrt((x - rx) ^ 2 + (y - ry) ^ 2)
      if across >= NEAR and across <= FAR then
        -- (how many yards of height a yard of the distance's error makes: the less the better)
        local worth = est and across / math.max(abs(rz - est), sqrt((count.fine and EPS_FINE or EPS) * across)) or across
        local at = #picked + 1
        while at > 1 and picked[at - 1].worth > worth do at = at - 1 end
        if at <= PLACES then
          table.insert(picked, at, { kind = kind, id = id, x = rx, y = ry, z = rz, worth = worth })
          picked[PLACES + 1] = nil
        end
      end
    end
  end
  return picked
end

-- What the game's marker was on is put back.
local function Back()
  local j = job
  if not j then return end
  if j.quest and j.quest > 0 then call(C_SuperTrack.SetSuperTrackedQuestID, j.quest)
  elseif j.pin then call(C_SuperTrack.SetSuperTrackedUserWaypoint, true)
  elseif j.kind ~= nil and j.id then call(C_SuperTrack.SetSuperTrackedMapPin, j.kind, j.id)
  elseif j.content ~= nil and j.contentId then call(C_SuperTrack.SetSuperTrackedContent, j.content, j.contentId)
  elseif j.vignette then call(C_SuperTrack.SetSuperTrackedVignette, j.vignette)
  else call(C_SuperTrack.ClearSuperTrackedMapPin) end
end

-- A fix that is being taken is given up: the marker goes back, and nothing is made of what was read.
local function Drop(now)
  Back()
  job = nil
  shared.measuring = nil
  fix.tried = now
end

local function Finish(now)
  local j = job
  Back()
  job = nil
  shared.measuring = nil
  fix.tried = now
  -- The game's distance did not go with its marker: it is to something else, and says nothing
  -- of these places - not how high you are by them, and not that they are somewhere else.
  if Stuck(j.seen) then
    count.empty, count.row = count.empty + 1, count.row + 1
    if count.row >= 3 then count.offUntil = now + math.min(300, 10 * count.row) end
    if not said.stuck then
      said.stuck = true
      local T = Enum and Enum.SuperTrackingType
      local top = C_SuperTrack.GetHighestPrioritySuperTrackingType and plain(call(C_SuperTrack.GetHighestPrioritySuperTrackingType))
      shared.Log("height: the game's distance stayed at " .. string.format("%.1f", j.seen[1].d) .. " yd whichever of " .. #j.seen .. " places its marker was pointed at: it is to something else, and no height is had from it"
        .. " (what the game says it is tracking first: " .. tostring(top) .. (T and T.MapPin ~= nil and (", a place of the map being " .. tostring(T.MapPin)) or "") .. ")")
    end
    return
  end
  -- (a distance shorter than the way across the map: the place is not where the list has it)
  for _, key in ipairs(j.short) do bad[key] = true end
  -- the two that say most
  local a, b = nil, nil
  for _, g in ipairs(j.got) do
    g.worth = g.d / math.max(g.h, sqrt((g.fine and EPS_FINE or EPS) * g.d))
    if not a or g.worth < a.worth then a, b = g, a elseif not b or g.worth < b.worth then b = g end
  end
  if not a then
    count.empty, count.row = count.empty + 1, count.row + 1
    -- (nothing to be had here: tried less and less often, so that it costs nothing where it cannot work)
    if count.row >= 3 then count.offUntil = now + math.min(300, 10 * count.row) end
    if count.row == 3 and not said.empty then said.empty = true; shared.Log("height: the game gave no distance to any of the places tried here (" .. #j.list .. " of them): tried less often") end
    return
  end
  count.taken, count.row, count.fine = count.taken + 1, 0, a.fine
  fix.seq = fix.seq % 7 + 1
  fix.at, fix.x, fix.y = now, j.x, j.y
  fix.refs[1], fix.refs[2] = a, b
  -- your height by it, for choosing the places next time: where the two agree; with one, the answer nearer the last
  local best = nil
  if b then
    for _, za in ipairs({ a.z - a.h, a.z + a.h }) do
      for _, zb in ipairs({ b.z - b.h, b.z + b.h }) do
        if not best or abs(za - zb) < best.off then best = { off = abs(za - zb), z = a.worth <= b.worth and za or zb } end
      end
    end
    if best.off > 8 then best = nil end
  elseif est then
    best = { z = abs(a.z - a.h - est) < abs(a.z + a.h - est) and a.z - a.h or a.z + a.h }
  end
  if best then est = best.z end
  if not said.first then
    said.first = true
    shared.Log("height: measured by the game's distance to " .. (a.kind == 1 and "flight master " or "landmark ") .. a.id .. " (" .. string.format("%.1f", a.h) .. " yd above or below it, " .. string.format("%.0f", a.d) .. " yd off)"
      .. (b and (" and " .. (b.kind == 1 and "flight master " or "landmark ") .. b.id .. " (" .. string.format("%.1f", b.h) .. ", " .. string.format("%.0f", b.d) .. ")") or "") .. (est and ("; so about " .. string.format("%.1f", est) .. " yd up") or ""))
  end
end

-- A frame of a fix being taken: what the game says of the place its marker was pointed at in the
-- frame before is read, and the marker goes on to the next (or back).
local function Step(now)
  local j = job
  local ref = j.list[j.i]
  local d = plain(call(C_Navigation.GetDistance))
  local kind, id = call(C_SuperTrack.GetSuperTrackedMapPin)
  -- The distance the game gives in a frame is the one it worked out in the frame before: it is
  -- for where you were then. (Found in the game, running: taken with where you are now, two
  -- places would disagree by a yard or two; standing still they agreed to an inch.)
  local x, y, fine = j.px, j.py, j.pfine
  local nx, ny, nfine = Here()
  j.px, j.py, j.pfine = nx or x, ny or y, nfine or false
  if kind == PinType(ref.kind) and id == ref.id and x and y then
    if d and d > 0 then
      local across2 = (x - ref.x) ^ 2 + (y - ref.y) ^ 2
      j.seen[#j.seen + 1] = { d = d, x = x, y = y }
      -- (a distance shorter than the way across the map: the place is not where the list has it -
      -- if the distance is to that place at all, which is known when the fix is finished)
      if d * d < across2 - 2 * d then j.short[#j.short + 1] = ref.kind * 100000 + ref.id
      else
        j.got[#j.got + 1] = { kind = ref.kind, id = ref.id, z = ref.z, d = d, h = sqrt(math.max(0, d * d - across2)), fine = fine }
        if #j.got == 1 then j.x, j.y = x, y end
        -- (the first few of a login are noted in full: what the game gave, and the way across by the fine and the rounded spot)
        if count.taken < 6 then
          shared.Log("height: " .. (ref.kind == 1 and "flight master " or "landmark ") .. ref.id .. " at " .. string.format("%.3f", ref.z) .. ": the game " .. string.format("%.4f", d) .. ", across " .. string.format("%.4f", sqrt(across2))
            .. " from where you were the frame before" .. (fine and "" or " (the rounded spot)") .. ", " .. string.format("%.4f", sqrt(((nx or x) - ref.x) ^ 2 + ((ny or y) - ref.y) ^ 2)) .. " from where you are")
        end
      end
    elseif count.odd < 12 then
      count.odd = count.odd + 1
      shared.Log("height: the game gave no distance to " .. (ref.kind == 1 and "flight master " or "landmark ") .. ref.id .. " (" .. tostring(d) .. ")")
    end
  else
    -- the game would not point its marker at it
    bad[ref.kind * 100000 + ref.id] = true
    if count.odd < 12 then
      count.odd = count.odd + 1
      shared.Log("height: the game's marker would not go to " .. (ref.kind == 1 and "flight master " or "landmark ") .. ref.id .. " (it is on " .. tostring(kind) .. " / " .. tostring(id) .. "; you at " .. tostring(x) .. ", " .. tostring(y) .. ")")
    end
  end
  -- (three frames, however long they take - within reason: just after a loading screen a frame can be half a second)
  if j.i < #j.list and now - j.at < 5 then
    j.i = j.i + 1
    ref = j.list[j.i]
    call(C_SuperTrack.SetSuperTrackedMapPin, PinType(ref.kind), ref.id)
  else
    Finish(now)
  end
end

local function Begin(now, map, x, y)
  local list = Pick(map, x, y)
  fix.tried = now
  if #list == 0 then return end
  job = { list = {}, i = 1, got = {}, seen = {}, short = {}, at = now, x = x, y = y }
  for i, r in ipairs(list) do job.list[i] = r end
  -- (where you are in this frame: what the game says of the first place in the next frame is for here)
  local fx, fy, ffine = Here()
  job.px, job.py, job.pfine = fx or x, fy or y, ffine or false
  -- what the game's marker is on now, to put back
  job.quest = plain(call(C_SuperTrack.GetSuperTrackedQuestID)) or 0
  job.pin = yes(call(C_SuperTrack.IsSuperTrackingUserWaypoint))
  job.kind, job.id = call(C_SuperTrack.GetSuperTrackedMapPin)
  job.content, job.contentId = call(C_SuperTrack.GetSuperTrackedContent)
  job.vignette = call(C_SuperTrack.GetSuperTrackedVignette)
  shared.measuring = true
  call(C_SuperTrack.SetSuperTrackedMapPin, PinType(list[1].kind), list[1].id)
end

local function Want(now, after)
  if not due or now + after < due then due = now + after end
end

local function Run()
  local now = GetTime()
  local dead = Dead()
  if job then
    -- (you died while a fix was being taken: what the game gave in this frame may be the way to your body already)
    if dead then Drop(now) else Step(now) end
    return
  end
  if not shared.MeasureOn() or shared.probing or (shared.StripOn and not shared.StripOn()) then return end
  if not (C_SuperTrack and C_SuperTrack.SetSuperTrackedMapPin and C_Navigation and C_Navigation.GetDistance and shared.HeightRefs and PinType(1) ~= nil) then return end
  local x, y, _, map = UnitPosition("player")
  x, y, map = plain(x), plain(y), plain(map)
  if not (x and y and map) or not shared.HeightRefs[map] then was.x = nil return end
  local taxi = yes(UnitOnTaxi("player"))
  local falling = IsFalling and yes(IsFalling()) or false
  local swimming = IsSwimming and yes(IsSwimming()) or false
  local under = IsSubmerged and yes(IsSubmerged()) or false
  local indoors = IsIndoors and yes(IsIndoors()) or false
  local place = GetMinimapZoneText and GetMinimapZoneText() or nil
  if secret(place) then place = nil end
  -- what has changed since the last look, that makes a fix worth having
  if was.x == nil or map ~= was.map or abs(x - was.x) + abs(y - was.y) > 60 then Want(now, 0.8)
  else
    if abs(x - was.x) + abs(y - was.y) > 0.01 then was.movedAt = now end
    if was.taxi and not taxi then Want(now, 0.3) end
    if falling and not was.falling then was.fellAt = now end
    if was.falling and not falling and now - (was.fellAt or now) >= 0.6 then Want(now, 0.15) end
    if swimming ~= was.swimming or indoors ~= was.indoors or place ~= was.place then Want(now, 0.3) end
    -- (alive again: at your body, or wherever a spirit healer or a friend brought you back)
    if was.dead and not dead then Want(now, 0.3) end
  end
  was.x, was.y, was.map, was.taxi, was.falling, was.swimming, was.indoors, was.place, was.dead = x, y, map, taxi, falling, swimming, indoors, place, dead
  if taxi then due = nil return end
  -- (dead, the game's distance is the way to your body: nothing to measure by)
  if dead then
    due = nil
    if not said.dead then said.dead = true; shared.Log("height: not measured while you are dead - the game's marker stays on your body, and its distance is the way to that") end
    return
  end
  -- as you go: every few seconds while you move, and once a moment after you stop
  local since = now - fix.tried
  local gone = fix.x and (abs(x - fix.x) + abs(y - fix.y)) or huge
  local moving = now - (was.movedAt or -100) < 0.3
  if moving then
    if since >= (under and EVERY_UNDER or EVERY) and gone >= (under and 1 or MOVED) then Want(now, 0) end
  elseif gone >= 2 and now - (was.movedAt or -100) >= 0.6 then Want(now, 0) end
  if due and now >= due and since >= GAP and now >= count.offUntil and not falling then
    due = nil
    Begin(now, map, x, y)
  end
end

local frame = CreateFrame("Frame", "AzerothAtlasHeight")
frame:SetScript("OnUpdate", function()
  local ok = shared.Try("height", Run)
  if not ok and job then
    -- (whatever went wrong, the marker goes back on what it was on)
    pcall(Back)
    job = nil
    shared.measuring = nil
    count.offUntil = GetTime() + 60
  end
end)

-- /atlas measure: off and on, and what it last found
function shared.MeasureSay(word)
  local function say(text) print("|cff7fd4ffAzeroth Atlas|r: " .. text) end
  if word == "off" or word == "on" then shared.SetMeasure(word == "on") end
  if not shared.MeasureOn() then say("your height is not measured (/atlas measure on turns it on): the 3D map works it out from the ground and the floors alone.") return end
  local a, b = fix.refs[1], fix.refs[2]
  if fix.seq == 0 or not a then
    say("your height is measured by the game's distance to flight masters and landmarks - none has been had yet" .. (count.empty > 0 and (" (" .. count.empty .. " tries came to nothing)") or "") .. ". /atlas measure off turns it off.")
    return
  end
  local function one(g) return (g.kind == 1 and "flight master " or "landmark ") .. g.id .. ": " .. string.format("%.1f", g.h) .. " yd above or below it, " .. string.format("%.0f", g.d) .. " yd off" end
  say("your height is measured by the game's distance to flight masters and landmarks. Last, " .. string.format("%.0f", GetTime() - fix.at) .. " s ago: " .. one(a) .. (b and ("; " .. one(b)) or "")
    .. (est and (". That makes about " .. string.format("%.1f", est) .. " yd up") or "") .. ". " .. count.taken .. " taken since you logged in. /atlas measure off turns it off.")
end
