-- Azeroth Atlas: when the boats, zeppelins and tram run.
--
-- A boat sails the same round over and over, to the second, and it does so by the server's
-- clock. The server counts real time in milliseconds in a number of 32 bits; where a craft is
-- on its round is that count, divided by how long the round takes, and what is left over. So
-- the clock alone says when every craft is at every stop, from the moment you log in and with
-- nothing seen at all: a restart or a patch moves no boat. (The count is full after 49.7 days
-- and starts again from nought. Every craft jumps to another place on its round then, and what
-- was seen before says nothing of what comes after.) TransitData.lua has the two figures that
-- takes for each line: how long its round is, and a moment at which a craft was measured to
-- leave its first stop.
--
-- Those figures are only as good as they were measured, and the game may change a line. So what
-- is seen counts as well. The game tells an addon nothing about a boat; what there is to go by:
--   your own rides      being carried along a line's recorded track (TransitData.lua) at the
--                       boat's pace says when it left, to about a second, wherever you boarded;
--   other players'      four addons pass such sightings from player to player, each in its own
--                       way, and each is read here as that addon writes it: DockWatch (the
--                       moment a boat left a dock, by where the dock is), ForeverTransport (when
--                       it arrived, by a line's number), Nauticus (how far into its round a
--                       boat is at the moment of sending) and Azeroth Tripview (when a round
--                       began, by a line's name). None of them needs to be installed. This addon
--                       only ever listens: it sends nothing to anyone in the game, so it cannot
--                       put a wrong time into anybody's timers.
-- A sighting that agrees with the clock (give or take what both are unsure by) makes the
-- timetable more exact. Sightings that plainly do not agree make a timetable of their own, and
-- that one takes the clock's place on good grounds only: a ride of yours, or two other players
-- who agree with each other. One player's word against the clock waits for a second. Whichever
-- was last borne out on such grounds is the one that runs.
--
-- Every sighting is also kept for the 3D map to hand on (AzerothAtlasDB.transit.out: the line,
-- the stop, the moment and which way it came, and no names). The map sends them to the Atlas
-- database, where everybody's are put together and each line's two figures are measured anew
-- for all (the README, "Boats, zeppelins and the tram, live").
--
-- The 3D map is told what is known (through the strip's messages), counts boats and trams into
-- the journeys it plans, and shows them moving. The step list counts down to a departure.
--
-- /atlas boats           what is known, line by line
-- /atlas boats listen    other players' sightings: taken, or not

local shared = AzerothAtlas
if type(shared) ~= "table" or type(shared.TransitData) ~= "table" then return end

local floor, ceil, abs, sqrt, max, min = math.floor, math.ceil, math.abs, math.sqrt, math.max, math.min
local strbyte, strchar, strsub, strfind = string.byte, string.char, string.sub, string.find

local WRAP = 4294967.296   -- seconds from one start of the server's count to the next: 2^32 milliseconds
local WRAP_LAG = 1         -- seconds after the count starts again from which a moment belongs to the new count
local TOL = 5              -- seconds two sightings of one boat may differ by (on top of what its round's uncertainty allows)
local ROUND_UNSURE = 0.4   -- seconds a round may be off the measured one (a line without a figure of its own)
local PLACE = 1 / 4        -- a sighting is put down to one of a timetable's boats only while its window is at most this much of a gap
local SOUND = 3            -- what a timetable must have been seen by to stand against another: your own ride, or two other players
local STALE = 2700         -- a voice against the timetable that runs is kept twice this long, waiting for a second
local KEEP = 3 * 86400     -- sightings older than this are forgotten
local MOST = 30            -- sightings kept of one line
local OUT = 40             -- sightings of one line kept for the 3D map to hand on
local DOCK = 150           -- yards: a spot this near a stop is that stop
-- how far a sighting is trusted: how exact its time is (seconds), and what it counts for when
-- timetables disagree (a timetable stands on 3: your own ride, or two other players). Tripview
-- names when a round began, which is turned into a moment at a stop by the clock's own figures:
-- so it counts for little, as it could not say that those were wrong.
local UNSURE = { own = 0.7, dw = 1.5, ft = 3, nau = 4, tv = 4 }
local COUNTS = { own = 3, dw = 1.5, ft = 1, nau = 0.5, tv = 0.5 }
local CHANNEL = "DockWatchData" -- where DockWatch passes its sightings on
local PREFIX_DW, PREFIX_FT, PREFIX_NAU, PREFIX_TV = "DockWatch2", "FTrans2", "NauticSync", "AzTripview"
local MADE = 23            -- what is kept is as this version of the addon keeps it (see Mend)

local T = { lines = {}, rev = 0 }
shared.Transit = T

local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end
-- (the addon's own notes of what it did, which "Report a problem" on the 3D map packs: AzerothAtlas.lua)
local function Note(what)
  if shared.Log then pcall(shared.Log, "boats: " .. what) end
end
-- a moment, as this computer's clock would show it
local function Hour(t)
  if date then
    local ok, s = pcall(date, "%d %b %H:%M:%S", t)
    if ok and type(s) == "string" then return s end
  end
  return tostring(math.floor(t))
end
local function secret(v) return issecretvalue ~= nil and issecretvalue(v) end
local function plain(v)
  if v == nil or secret(v) or type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then return nil end
  return v
end
local function text(v)
  if v == nil or secret(v) or type(v) ~= "string" then return nil end
  return v
end
local function yes(v) return v ~= nil and not secret(v) and v == true end
local function Split(s, sep)
  local out, at = {}, 1
  while true do
    local a, b = strfind(s, sep, at, true)
    if not a then out[#out + 1] = strsub(s, at) break end
    out[#out + 1] = strsub(s, at, a - 1)
    at = b + 1
  end
  return out
end
local function Clock(s)
  s = floor(max(0, s) + 0.5)
  return string.format("%d:%02d", floor(s / 60), s % 60)
end

-- ---- the clocks ----------------------------------------------------------------------------------
-- The server's time to a fraction of a second. The game gives it in whole seconds, rounded
-- down: so the most it is ever ahead of the game's own stopwatch is how far the two are apart.
-- The same for this computer's clock, so that the 3D map (which has only that one) can be told
-- how far the server's is from it.
local serverLead, localLead
local function Tick()
  local g = GetTime()
  local s = GetServerTime and plain(GetServerTime())
  if s then
    local lead = s - g
    if not serverLead or lead > serverLead or serverLead - lead > 2 then serverLead = lead end
  end
  local l = time and plain(time())
  if l then
    local lead = l - g
    if not localLead or lead > localLead or localLead - lead > 2 then localLead = lead end
  end
end
function T.Now()
  if serverLead then return GetTime() + serverLead end
  return (GetServerTime and plain(GetServerTime())) or time()
end

-- ---- the lines -----------------------------------------------------------------------------------
-- dep[s], arr[s]: how far into its round (seconds after leaving stop 1) a boat leaves stop s, and
-- gets there. gap: how often one leaves each stop (a round; half of one for the tram's two cars).
-- roundUnsure: how far its round may be off. left, leftUnsure: a moment (server time) at which
-- a craft was measured to leave stop 1 (the tram: the car on its first track), and how far that
-- may be off: with the round, where the line stands on the server's clock (ClockOf). Where the
-- legs and stops do not add up to the round, the stay at the first stop takes up the difference:
-- a boat leaves there a round after it last did, and gets there when its last leg says.
--
-- AzerothAtlasClock (set by a small addon of its own, AzerothAtlas_Clock, which the 3D map
-- writes beside this one where it has fetched them): the same figures as the Atlas database has
-- measured them from everybody's sightings, newer than the ones this addon came with. Taken
-- where they are of a line as it is here, and measured later than what the addon has.
local published = type(AzerothAtlasClock) == "table" and type(AzerothAtlasClock.lines) == "table" and AzerothAtlasClock.lines or nil
for _, d in ipairs(shared.TransitData) do
  local L = { n = d.n, id = d.id, key = d.key, kind = d.kind, round = d.period, roundUnsure = d.periodUnsure or ROUND_UNSURE, cars = d.cars or 1, stops = d.stops, legs = d.legs,
    left = d.left, leftUnsure = d.leftUnsure or 2,
    rough = d.rough, lanes = d.lanes, ft = d.ft, ft2 = d.ft2, ftStops = d.ftStops, dep = { 0 }, arr = {}, stay = {} }
  local p = published and published[d.key]
  if type(p) == "table" and plain(p.period) and plain(p.left) and plain(p.periodUnsure) and plain(p.leftUnsure)
    and abs(p.period - d.period) < 30 and p.periodUnsure > 0 and p.leftUnsure > 0 and (not d.left or p.left >= d.left) then
    L.round, L.roundUnsure, L.left, L.leftUnsure, L.published = p.period, p.periodUnsure, p.left, p.leftUnsure, true
  end
  local count, at = #d.stops, 0
  for i = 1, count do
    local nxt = i % count + 1
    at = at + d.legs[i].trip
    L.arr[nxt] = at
    if nxt ~= 1 then
      at = at + d.stops[nxt].wait
      L.dep[nxt] = at
    end
  end
  L.gap = L.round / L.cars
  for s = 1, count do L.stay[s] = (L.dep[s] - L.arr[s]) % L.round end
  local names = {}
  for s = 1, count do names[s] = d.stops[s].name end
  L.name = table.concat(names, " - ")
  T.lines[L.n] = L
end
local function ByFt(id)
  for _, L in pairs(T.lines) do
    if L.ft == id then return L, L.cars > 1 and 1 or nil end
    if L.ft2 == id then return L, 2 end
  end
end

-- ---- the server's clock ----------------------------------------------------------------------------
-- The moment (server time) the server's count last started from nought before `t`.
local function WrapBefore(t)
  return floor((t - WRAP_LAG) / WRAP) * WRAP
end
-- What the clock alone says of a line at server time `t`: a moment a craft leaves stop 1 (the
-- tram: the car on its first track) in the count `t` is in, and how unsure that moment is. In
-- the count the line was measured in, that is the measured moment. In another (the count has
-- started again since) the craft leaves as long after the start as it did then: as unsure as
-- the rounds between that start and the measured moment make it, each by what the round may be
-- off. nil for a line without the figures.
local function ClockOf(L, t)
  if not (L.left and L.round) then return nil end
  local w0, w = WrapBefore(L.left), WrapBefore(t)
  if w == w0 then return L.left, L.leftUnsure end
  local into = L.left - w0
  local rounds = floor(into / L.round)
  return w + into - rounds * L.round, sqrt(L.leftUnsure * L.leftUnsure + (rounds * L.roundUnsure) ^ 2)
end
T.WrapBefore, T.ClockOf = WrapBefore, ClockOf

-- ---- what has been seen ----------------------------------------------------------------------------
-- Kept with the addon's settings, for every character: AzerothAtlasDB.transit = { sight =
-- { [line] = { { t (when it left stop s, or got there), s, arr (true: got there), src, who, lane,
-- e (when that boat left stop 1 on that round) } } }, out (every sighting taken, line by line,
-- for the 3D map to hand on: t, s, arr, src, lane, and no names), made (the addon's version that
-- keeps it), listen }.
local function Store()
  if type(AzerothAtlasDB) ~= "table" then AzerothAtlasDB = {} end
  local s = AzerothAtlasDB.transit
  if type(s) ~= "table" then
    s = {}
    AzerothAtlasDB.transit = s
  end
  if type(s.sight) ~= "table" then s.sight = {} end
  return s
end
-- A sighting into a list of them: kept in the order they were seen, the oldest dropped past MOST.
local function Put(S, x)
  local at = #S + 1
  while at > 1 and S[at - 1].t > x.t do at = at - 1 end
  table.insert(S, at, x)
  while #S > MOST do table.remove(S, 1) end
end
-- A sighting kept for the 3D map to hand on: what was seen, and no names.
local function Out(store, n, x)
  if type(store.out) ~= "table" then store.out = {} end
  if type(store.out[n]) ~= "table" then store.out[n] = {} end
  local O = store.out[n]
  O[#O + 1] = { t = x.t, s = x.s, arr = x.arr, src = x.src, lane = x.lane }
  while #O > OUT do table.remove(O, 1) end
end

-- One timetable: sightings that agree, and the clock's own say where they agree with that. The
-- moment its newest boat left stop 1 (ref + a), and how long from one boat to the next (b),
-- fitted to all of them: each weighed by how exact it is, the gap held as near the measured one
-- as that is sure. (va, vb, cab: how unsure the two are, and how the one's error goes with the
-- other's.)
local function Fit(L, c)
  local q = 1 / ((L.roundUnsure / L.cars) ^ 2)
  local sw, sn, snn, sy, sny = 0, 0, 0, 0, 0
  for _, x in ipairs(c.members) do
    local w = 1 / (x.unsure * x.unsure)
    local y = x.e - c.ref
    sw, sn, snn, sy, sny = sw + w, sn + w * x.k, snn + w * x.k * x.k, sy + w * y, sny + w * x.k * y
  end
  -- (the clock counts as a sighting does: the moment it names, as unsure as that is)
  local clock = c.clock
  if clock then
    local w = 1 / (clock.unsure * clock.unsure)
    local y = clock.e - c.ref
    sw, sn, snn, sy, sny = sw + w, sn + w * clock.k, snn + w * clock.k * clock.k, sy + w * y, sny + w * clock.k * y
  end
  local det = sw * (snn + q) - sn * sn
  c.a = (sy * (snn + q) - sn * (sny + q * L.gap)) / det
  c.b = (sw * (sny + q * L.gap) - sn * sy) / det
  c.va, c.vb, c.cab = (snn + q) / det, sw / det, -sn / det
end
local function Unsure(c, k)
  return sqrt(max(0, c.va + k * k * c.vb + 2 * k * c.cab))
end
-- Where a sighting stands against a timetable: which of its boats it would be (k: so many boats
-- on from the one the timetable counts from), how far it is off that boat, and its window: how far
-- off it may be and still be that boat (TOL, its own exactness, and twice the timetable's
-- uncertainty at that boat).
local function Against(c, x)
  local k = floor((x.e - c.ref - c.a) / c.b + 0.5)
  return k, x.e - c.ref - c.a - k * c.b, TOL + x.unsure + 2 * Unsure(c, k)
end
-- Does a sighting belong to this timetable: is it a whole number of boats away from it, as near
-- as its own exactness and the timetable's allow? true or false, or nil where that cannot be told.
-- A round is known only so well, so a timetable is less sure of where its boat was with every
-- round away from what it rests on, and the window grows with it. Past a quarter of a gap there
-- is no telling: the boat the sighting would be put down to might as well be the one before or
-- after it, and a sighting of anything at all would land in the window as often as not. Within a
-- quarter, the windows of the boats on either side are at least half a gap away, so the boat is
-- the right one even if the timetable were twice as unsure as it reckons.
local function Belongs(L, c, x)
  local k, off, window = Against(c, x)
  if window > PLACE * L.gap then return nil end
  if abs(off) > window then return false end
  x.k = k
  return true
end

-- A sighting joins a timetable: fitted again, and counted (a player counts once, for the best of
-- what they saw).
local function Join(L, c, x)
  c.members[#c.members + 1] = x
  Fit(L, c)
  if x.t > c.newest then c.newest = x.t end
  if x.t < c.oldest then c.oldest = x.t end
  local who = x.src == "own" and "*" or (x.who or "?")
  local worth = COUNTS[x.src] or 0.5
  if (c.seen[who] or 0) < worth then
    c.counts = c.counts + worth - (c.seen[who] or 0)
    c.seen[who] = worth
  end
  if x.src == "own" then c.own = true end
end

-- Sightings (newest first, each with when its boat left stop 1 and how exact it is) gathered into
-- timetables: the clock's first (where the line has one: clockE, the moment the clock names, and
-- how unsure that is), then newest first. Each sighting joins the first it belongs to. One that
-- plainly belongs to none starts a timetable of its own (another voice: the clock's figures are
-- out for this line, or the game has changed it, or the sighting is wrong). One that cannot be
-- told is set aside: it starts nothing, and is tried again once the others are in (they may have
-- pinned the round down enough to place it). Returns the timetables, and what could not be placed.
local function Gather(L, live, clockE, clockUnsure)
  local found, waiting = {}, live
  if clockE then
    local c = { ref = clockE, clock = { e = clockE, k = 0, unsure = clockUnsure }, members = {}, newest = -math.huge, oldest = math.huge, seen = {}, counts = 0 }
    Fit(L, c)
    found[1] = c
  end
  repeat
    local aside = {}
    for _, x in ipairs(waiting) do
      local home, unsure = nil, false
      for _, c in ipairs(found) do
        local fits = Belongs(L, c, x)
        if fits then home = c break end
        if fits == nil then unsure = true end
      end
      if not home and not unsure then
        x.k = 0
        home = { ref = x.e, members = {}, newest = x.t, oldest = x.t, seen = {}, counts = 0 }
        found[#found + 1] = home
      end
      if home then Join(L, home, x) else aside[#aside + 1] = x end
    end
    local placed = #aside < #waiting
    waiting = aside
  until not placed or #waiting == 0
  return found, waiting
end

-- Since when a timetable stands on good grounds: counting back from its newest sighting, the
-- moment of the one with which those who saw it come to a ride of yours or two other players
-- (a player counts once, for the best of what they saw). nil where they never do.
local function Sound(c)
  local list = {}
  for i, m in ipairs(c.members) do list[i] = m end
  table.sort(list, function(a, b) return a.t > b.t end)
  local seen, counts = {}, 0
  for _, m in ipairs(list) do
    local who = m.src == "own" and "*" or (m.who or "?")
    local worth = COUNTS[m.src] or 0.5
    if (seen[who] or 0) < worth then
      counts = counts + worth - (seen[who] or 0)
      seen[who] = worth
    end
    if counts >= SOUND then return m.t end
  end
  return nil
end

local function Solve(L, now)
  local store = Store()
  local S = store.sight[L.n]
  L.fit, L.held = nil, nil
  local clockE, clockUnsure = ClockOf(L, now)
  -- the sightings that still count, newest first
  local began = WrapBefore(now) + WRAP_LAG
  local live = {}
  if type(S) == "table" then
    for i = #S, 1, -1 do
      local x = S[i]
      local into = type(x) == "table" and plain(x.t) and (x.arr and L.arr[x.s] or L.dep[x.s])
      -- (what was seen before the server's count last started again says nothing of now)
      if not into or now - x.t > KEEP or x.t <= began then
        table.remove(S, i)
      else
        -- (when that boat left stop 1 on that round)
        x.e, x.unsure = x.t - into, UNSURE[x.src] or 4
        live[#live + 1] = x
      end
    end
  end
  if #live == 0 and not clockE then return end
  local found, waiting = Gather(L, live, clockE, clockUnsure)
  -- Which timetable runs. The clock's, made more exact by whatever agrees with it, unless
  -- sightings that plainly do not agree with it stand on good grounds (your own ride, or two
  -- other players): then whichever of the two was last borne out on such grounds. So a ride of
  -- yours that is off the clock runs the line from then on (the clock's figures are out for it,
  -- or the game has changed the line), and the clock has it back once a ride of yours, or two
  -- players, agree with it again. One player's word against the clock waits for a second.
  -- (A line without the clock's figures: the newest that stands on good grounds, or the newest.)
  local chosen, since = nil, nil
  for _, c in ipairs(found) do
    c.sound = Sound(c)
    if c.clock then
      if not chosen then chosen, since = c, c.sound end
    elseif c.sound and (not chosen or not since or c.sound > since) then
      chosen, since = c, c.sound
    end
  end
  chosen = chosen or found[1]
  if not chosen then return end
  -- (what is left of other timetables is of no more use, but for a voice against this one that
  -- still waits for a second: kept for as long as it may yet get one. What could not be placed
  -- is kept for next time.)
  local keep = {}
  for _, x in ipairs(waiting) do keep[x] = true end
  for _, m in ipairs(chosen.members) do keep[m] = true end
  for _, c in ipairs(found) do
    if c ~= chosen and not c.sound then
      local any = false
      for _, m in ipairs(c.members) do
        if now - m.t <= 2 * STALE then keep[m] = true any = true end
      end
      if any and not L.held then L.held = c end
    end
  end
  if type(S) == "table" then
    for i = #S, 1, -1 do
      if not keep[S[i]] then table.remove(S, i) end
    end
  end
  local best
  for _, m in ipairs(chosen.members) do
    if not best or (COUNTS[m.src] or 0) > (COUNTS[best.src] or 0) then best = m end
  end
  chosen.src, chosen.size = best and best.src or "clock", #chosen.members
  -- Which of the tram's tracks a car is on: they take turns. The clock says it (the moment it
  -- names is the car on the first track); without the clock, one car whose track is known says
  -- it for all.
  -- (A ride of yours on a track is surer than either: the newest such has the last word.)
  if L.cars > 1 then
    if chosen.clock then chosen.laneAt, chosen.lane = chosen.clock.k, 1 end
    for _, m in ipairs(chosen.members) do
      if m.lane and (m.src == "own" or not chosen.clock) and (not chosen.laneT or m.t > chosen.laneT) then chosen.laneAt, chosen.lane, chosen.laneT = m.k, m.lane, m.t end
    end
  end
  -- (for the addon's notes: a line that stops running by the clock, or runs by it again)
  local byClock = chosen.clock ~= nil
  if L.byClock ~= nil and L.byClock ~= byClock then
    Note(L.name .. (byClock and ": runs by the server's clock again" or (": no longer as the server's clock has it, by " .. tostring(chosen.src) .. " x" .. chosen.size)))
  end
  L.byClock = byClock
  L.fit = chosen
end

local function Changed()
  T.rev = T.rev + 1
end

-- What came in from other players since it was last noted, and what became of it (for the
-- addon's notes: a report then shows whether anything was heard at all, and why it was not used).
local heard, heardAt = {}, 0
local function Heard(src, what)
  local key = tostring(src) .. " " .. what
  heard[key] = (heard[key] or 0) + 1
end
local function TellHeard()
  local parts = {}
  for key, count in pairs(heard) do parts[#parts + 1] = key .. " x" .. count end
  heard = {}
  if #parts == 0 then return end
  table.sort(parts)
  Note("heard from other players: " .. table.concat(parts, ", "))
end

-- A boat of line L was seen: it left stop `s` at server time `t` (or, with `arrived`, got there).
-- src: "own" (your ride), "dw", "ft", "nau" or "tv" (another player's, by way of that addon).
function T.Sighted(L, s, t, arrived, src, who, lane)
  local store = Store()
  local now = T.Now()
  if not (L and L.dep[s] and plain(t)) or t > now + 30 or t < now - KEEP then
    Heard(src, "not of a time or place that can be used")
    return false
  end
  if t <= WrapBefore(now) + WRAP_LAG then
    Heard(src, "from before the server's count started again")
    return false
  end
  local S = store.sight[L.n]
  if type(S) ~= "table" then
    S = {}
    store.sight[L.n] = S
  end
  -- (the same sighting again, passed on by somebody else: once is enough)
  for _, x in ipairs(S) do
    if x.s == s and (x.arr == true) == (arrived == true) and abs(x.t - t) < 0.15 then
      if (COUNTS[src] or 0) > (COUNTS[x.src] or 0) then x.src, x.who = src, who end
      if lane and not x.lane then x.lane = lane end
      Heard(src, "known already")
      return false
    end
  end
  local x = { t = t, s = s, arr = arrived and true or nil, src = src, who = who, lane = lane, e = t - (arrived and L.arr[s] or L.dep[s]), unsure = UNSURE[src] or 4 }
  if src == "own" then
    -- (how far off the timetable that ran: for the addon's notes, and for whoever reads a report)
    local c, off = L.fit, nil
    if c then
      local _, o = Against(c, x)
      off = o
    end
    Note("your ride on " .. L.name .. ": it left stop " .. s .. " at " .. Hour(t) .. (off and string.format(", %+.1f s off what was known", off) or ""))
  else
    Heard(src, "taken")
  end
  Put(S, x)
  Out(store, L.n, x)
  Solve(L, now)
  Changed()
  return true
end

-- ---- what the timetable says ---------------------------------------------------------------------
-- When a boat next leaves stop `s` of line L after server time `t` (now, if not given):
-- when it leaves, when it gets in before that, how unsure that is (seconds), and for the tram
-- which track it is on (if known). nil while nothing is known of the line.
function T.Next(L, s, t)
  local c = L and L.fit
  if not (c and L.dep[s]) then return nil end
  t = t or T.Now()
  local base = c.ref + c.a + L.dep[s]
  local k = ceil((t - base) / c.b)
  local leaves = base + k * c.b
  local lane
  if c.laneAt then lane = (c.lane - 1 + (k - c.laneAt)) % L.cars + 1 end
  return leaves, leaves - L.stay[s], Unsure(c, k), lane
end

-- What a journey's step says of the boat it waits for ("leaves in 2:28"), or nil while nothing
-- is known (the step then keeps what the 3D map wrote: half a round, on average).
function T.Note(n, s)
  local L = T.lines[n]
  local now = T.Now()
  local leaves, gets, unsure = T.Next(L, s, now)
  if not leaves then return nil end
  if unsure > L.gap / 6 then return nil end
  local about = unsure > 6 and "about " or ""
  if gets <= now then return "boarding, leaves in " .. about .. Clock(leaves - now) end
  return "leaves in " .. about .. Clock(leaves - now)
end

-- ---- your own rides ------------------------------------------------------------------------------
-- Something is carrying you when you move without moving yourself. Carried along a line's track,
-- where the boat is well under way, each spot you pass says how long ago it left; when a handful
-- of them over a few seconds say the same, to the second, that is when it left.
local FIX = { near = 25, count = 5, span = 5, agree = 1, pace = 10, keep = 12 }
local ride = { buffer = {}, last = 0, tried = 0, done = false, prev = nil, on = nil }
T.ride = ride

-- every moment of a leg (seconds after leaving) at which its boat is where `p` is
local function Moments(track, p, out)
  local count, slow = 0, false
  for i = 2, #track do
    local a, b = track[i - 1], track[i]
    local dt = b[1] - a[1]
    if dt > 0 and a[2] == p.map and b[2] == p.map then
      local dx, dy = b[3] - a[3], b[4] - a[4]
      local len2 = dx * dx + dy * dy
      local len = sqrt(len2)
      -- (not across the leap from one continent to the other)
      if not (len > 1000 and len / dt > 100) then
        local f = len2 > 0 and ((p.x - a[3]) * dx + (p.y - a[4]) * dy) / len2 or 0
        if f >= -0.05 and f <= 1.05 then
          if f < 0 then f = 0 elseif f > 1 then f = 1 end
          local ox, oy = a[3] + f * dx - p.x, a[4] + f * dy - p.y
          if ox * ox + oy * oy <= FIX.near * FIX.near then
            if len / dt >= FIX.pace then
              count = count + 1
              out[count] = a[1] + f * dt
            else
              slow = true -- (on the track, but where the boat is slow: of no use for timing)
            end
          end
        end
      end
    end
  end
  for i = count + 1, #out do out[i] = nil end
  return count, slow
end

-- When the boat of this leg left, if every spot in the buffer lies on its track and they agree.
local function LegFix(track)
  local buffer = ride.buffer
  local use, times = {}, {}
  for _, p in ipairs(buffer) do
    local list = {}
    local count, slow = Moments(track, p, list)
    if count > 0 then
      use[#use + 1], times[#times + 1] = p, list
    elseif not slow then
      return nil
    end
  end
  if #use < FIX.count or use[#use].t - use[1].t < FIX.span then return nil end
  for _, first in ipairs(times[1]) do
    local left = use[1].t - first
    local all, good = { left }, true
    for i = 2, #use do
      local best
      for _, m in ipairs(times[i]) do
        local d = use[i].t - m
        if abs(d - left) <= FIX.agree and (not best or abs(d - left) < abs(best - left)) then best = d end
      end
      if not best then good = false break end
      all[#all + 1] = best
    end
    if good then
      table.sort(all)
      return all[ceil(#all / 2)]
    end
  end
  return nil
end

local function TryFix()
  local found
  for _, L in pairs(T.lines) do
    for s, leg in ipairs(L.legs) do
      for lane = 1, leg.track2 and 2 or 1 do
        local left = LegFix(lane == 2 and leg.track2 or leg.track)
        if left then
          if found then return end -- (more than one line passes here: not known which)
          found = { L = L, s = s, left = left, lane = L.cars > 1 and lane or nil }
        end
      end
    end
  end
  if not found then return end
  ride.done = true
  local on = ride.on
  -- (the same crossing picked up again after the loading screen between continents: once is enough)
  if on and on.L == found.L and on.s == found.s and abs(on.left - found.left) < 5 then return end
  ride.on = found
  local known = found.L.fit ~= nil
  if T.Sighted(found.L, found.s, found.left, false, "own", nil, found.lane) and not known then
    say("timed the " .. found.L.name .. " " .. found.L.kind .. " from your ride.")
  end
end

local function Sample()
  local x, y, _, map = UnitPosition("player")
  local pace = GetUnitSpeed and GetUnitSpeed("player")
  local now = GetTime()
  if secret(x) or secret(y) or secret(map) or secret(pace) or type(x) ~= "number" or type(y) ~= "number" or type(pace) ~= "number" then
    -- (a loading screen, or a fight: nothing to go by for now; the crossing is still the same one after it)
    ride.prev = nil
    if #ride.buffer > 0 or ride.done then ride.last = now end
    return
  end
  local blocked = yes(UnitOnTaxi("player")) or (UnitInVehicle ~= nil and yes(UnitInVehicle("player")))
    or (IsFalling ~= nil and yes(IsFalling())) or (IsFlying ~= nil and yes(IsFlying()))
  local prev = ride.prev
  local carried = false
  if prev and not blocked and pace == 0 and prev.map == map and now - prev.t <= 3 then
    local d = sqrt((x - prev.x) ^ 2 + (y - prev.y) ^ 2)
    carried = d > 0.25 and d < 60
  end
  if carried then
    ride.last = now
    if not ride.done then
      local buffer = ride.buffer
      local at = T.Now()
      buffer[#buffer + 1] = { t = at, map = map, x = x, y = y }
      while #buffer > 0 and at - buffer[1].t > FIX.keep do table.remove(buffer, 1) end
      if now - ride.tried >= 1 then
        ride.tried = now
        TryFix()
      end
    end
  elseif now - ride.last > 3 then
    -- off the boat, or it has stopped: the next leg is a departure of its own
    if #ride.buffer > 0 then ride.buffer = {} end
    ride.done = false
    if ride.on and now - ride.last > 30 then ride.on = nil end
  end
  ride.prev = ride.prev or {}
  ride.prev.t, ride.prev.map, ride.prev.x, ride.prev.y = now, map, x, y
end

-- The crossing you are on, if it has been timed: the line, the stop it is heading for, and when
-- it gets there (server time).
function T.Riding()
  local on = ride.on
  if not on or GetTime() - ride.last > 30 then return nil end
  local L = on.L
  return L, on.s % #L.stops + 1, on.left + L.legs[on.s].trip
end

-- ---- other players' sightings --------------------------------------------------------------------
local function Short(name)
  name = text(name)
  if not name then return nil end
  return (string.gsub(name, "%-.*$", ""))
end

-- The leg from a dock at (map, x, y) to one at (map2, x2, y2): the line and the stop it leaves.
local function LegBetween(map, x, y, map2, x2, y2)
  local found, from
  for _, L in pairs(T.lines) do
    for s, a in ipairs(L.stops) do
      local b = L.stops[s % #L.stops + 1]
      local reach = L.cars > 1 and 300 or DOCK
      -- (the tram's two ends are told apart along the tunnel only: its tracks lie side by side)
      local da = L.cars > 1 and abs(a.y - y) or sqrt((a.x - x) ^ 2 + (a.y - y) ^ 2)
      local db = L.cars > 1 and abs(b.y - y2) or sqrt((b.x - x2) ^ 2 + (b.y - y2) ^ 2)
      if a.map == map and b.map == map2 and da <= reach and db <= reach then
        if found then return nil end
        found, from = L, s
      end
    end
  end
  return found, from
end

-- DockWatch: "D;map;x;y;map;x;y;when it left;trip;round;name;name;track;faction;version;next stop;
-- language" and, passed on from player to player, ";G1;who saw it;how many hands".
local function FromDockWatch(msg, sender)
  local f = Split(msg, ";")
  if f[1] ~= "D" or #f < 9 then return end
  local map, x, y = tonumber(f[2]), tonumber(f[3]), tonumber(f[4])
  local map2, x2, y2 = tonumber(f[5]), tonumber(f[6]), tonumber(f[7])
  local t, trip = tonumber(f[8]), tonumber(f[9])
  if not (plain(map) and plain(x) and plain(y) and plain(map2) and plain(x2) and plain(y2) and plain(t) and plain(trip)) then return end
  if abs(x) > 20000 or abs(y) > 20000 or abs(x2) > 20000 or abs(y2) > 20000 or trip < 30 or trip > 1200 then return end
  local L, s = LegBetween(map, x, y, map2, x2, y2)
  if not L then return end
  -- (a trip far off the real one was not timed the way the others are: its time is not to be trusted either)
  if abs(trip - L.legs[s].trip) > 20 then return end
  local lane = L.cars > 1 and tonumber(f[13]) or nil
  if lane and not (lane == 1 or lane == 2) then lane = nil end
  local who = sender
  if f[18] == "G1" and type(f[19]) == "string" and f[19] ~= "" and #f[19] <= 100 then who = f[19] end
  return T.Sighted(L, s, t, false, "dw", Short(who), lane)
end

-- ForeverTransport: "A|line|dock|when it arrived|when that was seen|how sure".
local function FromForeverTransport(msg, sender)
  if #msg > 253 then return end
  local p = {}
  for token in string.gmatch(msg, "([^|]+)") do
    if #p >= 8 then return end
    p[#p + 1] = token
  end
  if p[1] ~= "A" or #p < 6 then return end
  local line, dock, arrived, seen = tonumber(p[2]), tonumber(p[3]), tonumber(p[4]), tonumber(p[5])
  if not (plain(line) and plain(dock) and plain(arrived) and plain(seen)) then return end
  local L, lane = ByFt(line)
  local s = L and L.ftStops[dock]
  local now = T.Now()
  if not s or seen > now + 30 or seen < now - KEEP or arrived > now + L.round then return end
  return T.Sighted(L, s, arrived, true, "ft", Short(sender), lane)
end

-- Nauticus: "KWN4 4 line:time:hands:restarts,... check", numbers written in an alphabet of its
-- own, lowest digit first. The time is how far into its round the boat is as the message is
-- sent, counted on from the moment it got to its first dock. (A line with nothing after its
-- number is a question, not an answer. Lines 5 and 11 are left out: their rounds do not begin
-- where the others' do.)
local NAU_ROUND = { 356.28836360078276, 303.4671353784595, 335.2982692023634, 350.8233330757341, nil, 329.3162968069666, 316.254198816156,
  317.0452004189944, 143.3335603979157, 143.3335603979157, nil, 347, 353, 271.4125 }
local nauDigit = {}
do
  local letters = "0123456789ABCDEFGHIJKLMNOPQRTUVWXYZabcdefghijklmnopqrtuvwxyz!\"#$&'()*+-./;<=>?@[\\]^_`{}~"
    .. "\001\002\003\004\005\006\007\008\011\012\014\015\016\017\018\019\020\021\022\023\024\025\026\027\028\029\030\031\127"
  for i = 1, #letters do nauDigit[strbyte(letters, i)] = i - 1 end
  T.nauBase = #letters
end
local function NauNumber(s)
  if type(s) ~= "string" or s == "" or #s > 8 then return nil end
  local value, place = 0, 1
  for i = 1, #s do
    local d = nauDigit[strbyte(s, i)]
    if not d then return nil end
    value = value + d * place
    place = place * T.nauBase
    if value > 1e12 then return nil end
  end
  return value
end
local nauParts = {}
local function FromNauticus(msg, sender)
  -- (a long message comes in pieces, each marked by its first letter: 1 the first, 2 more, 3 the last; 4 a plain one)
  local mark = strbyte(msg, 1)
  if mark == 4 then
    msg = strsub(msg, 2)
  elseif mark == 1 then
    nauParts[sender or "?"] = { strsub(msg, 2), GetTime() }
    return
  elseif mark == 2 or mark == 3 then
    local part = nauParts[sender or "?"]
    if not part or GetTime() - part[2] > 10 or #part[1] + #msg > 600 then nauParts[sender or "?"] = nil return end
    part[1] = part[1] .. strsub(msg, 2)
    if mark == 2 then return end
    msg, nauParts[sender or "?"] = part[1], nil
  end
  local a = strfind(msg, " ", 1, true)
  local b = a and strfind(msg, " ", a + 1, true)
  local c = b and strfind(msg, " ", b + 1, true)
  if not c or strsub(msg, 1, a - 1) ~= "KWN4" or strsub(msg, a + 1, b - 1) ~= "4" then return end
  local lag = 0
  if GetNetStats then
    local ok, _, _, home, world = pcall(GetNetStats)
    if ok then lag = (plain(home) or plain(world) or 0) / 1000 end
  end
  local now = T.Now()
  local any = false
  for entry in string.gmatch(strsub(msg, b + 1, c - 1), "([^,]+)") do
    local f = Split(entry, ":")
    local line, since = NauNumber(f[1]), NauNumber(f[2])
    local round = line and NAU_ROUND[line]
    if round and since and since <= 3.2e10 and #f <= 4 then
      local L, lane = ByFt(line)
      if L then
        local into = (since / 1000 + lag) % round
        if T.Sighted(L, L.ftStops[1], now - into, true, "nau", Short(sender), lane) then any = true end
      end
    end
  end
  return any
end

-- Azeroth Tripview: "S|line|when a round began|how exact|when that was seen|how" (how: r a ride,
-- d seen from a dock, s passed on by somebody else). A round of theirs begins where the clock's
-- does: with the craft at the second point of the game's path, as the server's count starts. So
-- the round they name began as long before a craft leaves our first stop as the clock's own
-- does, and that is how it is turned into a sighting here. (It cannot say that the clock's
-- figures for a line are out, only that the line no longer runs by them: see COUNTS.) Their two
-- tram lines are our two tracks: the north one begins as its car leaves Ironforge, the south one
-- as its car leaves Stormwind.
local TV_LINE = { OG_UC = 1, OG_GG = 2, UC_GG = 3, RA_BB = 4, MH_AU = 5, MH_TH = 6, RT_AU = 7, FM_FC = 8, TRAM_N = 9, TRAM_S = 9, SW_AU = 10, ZI_MU = 11, ZI_DA = 12, RG_TA = 13 }
local function FromTripview(msg, sender)
  if #msg > 120 then return end
  local key, e, q, at = string.match(msg, "^S|([%w_]+)|([%d%.]+)|([%d%.]+)|(%d+)|%a$")
  local L = key and T.lines[TV_LINE[key] or 0]
  e, q, at = tonumber(e), tonumber(q), tonumber(at)
  if not (L and L.left and plain(e) and plain(q) and plain(at)) or q > 5 then return end
  local now = T.Now()
  if at > now + 120 or at < now - KEEP or e > at + 1 or e < at - 2 * L.round then return end
  -- (how long after a round begins a craft leaves stop 1: as the clock has it, whichever count it is)
  local after = (L.left - WrapBefore(L.left)) % L.round
  local s, lane = 1, L.cars > 1 and 1 or nil
  if key == "TRAM_S" then s, lane = 2, 2 end
  local t = e + after
  while t > now do t = t - L.round end
  return T.Sighted(L, s, t, false, "tv", Short(sender), lane)
end

local function OnAddonMessage(prefix, msg, how, sender)
  prefix, msg, how, sender = text(prefix), text(msg), text(how), text(sender)
  if not (prefix and msg and sender) or Store().listen == false then return end
  if prefix == PREFIX_DW then
    -- (for the addon's notes: that its players are heard at all, and by which way)
    Heard("dw", "messages by " .. string.lower(how or "?"))
    FromDockWatch(msg, sender)
  elseif prefix == PREFIX_FT then
    if how == "PARTY" or how == "RAID" or how == "GUILD" or how == "YELL" or how == "WHISPER" then FromForeverTransport(msg, sender) end
  elseif prefix == PREFIX_NAU then
    if #msg < 254 and (how == "PARTY" or how == "RAID" or how == "GUILD" or how == "YELL") then FromNauticus(msg, sender) end
  elseif prefix == PREFIX_TV then
    if how == "PARTY" or how == "RAID" or how == "GUILD" or how == "YELL" then FromTripview(msg, sender) end
  end
end

-- Listening where DockWatch passes its sightings on: a chat channel of its own, kept out of the
-- chat windows. Joined a while after you log in, so that it takes a number after the game's own
-- channels. Nothing is ever said in it.
local function Listen(on)
  if on then
    if JoinTemporaryChannel then pcall(JoinTemporaryChannel, CHANNEL) end
    local hide = ChatFrame_RemoveChannel or (ChatFrameUtil and ChatFrameUtil.RemoveChannel)
    if hide then
      for i = 1, NUM_CHAT_WINDOWS or 10 do
        local window = _G["ChatFrame" .. i]
        if window then pcall(hide, window, CHANNEL) end
      end
    end
    -- (noted a little later: whether the game let it in)
    local function check()
      local ok, id = pcall(function() return GetChannelName and GetChannelName(CHANNEL) end)
      id = ok and plain(id) or nil
      Note(id and id > 0 and ("listening to DockWatch's players (channel " .. id .. ")") or "DockWatch's channel could not be joined: its players are heard by guild and whisper only")
    end
    if C_Timer and C_Timer.After then C_Timer.After(8, check) end
  elseif LeaveChannelByName then
    -- (DockWatch itself, where it is installed, has the channel for its own use)
    local loaded = C_AddOns and C_AddOns.IsAddOnLoaded and C_AddOns.IsAddOnLoaded("DockWatch")
    if not loaded then pcall(LeaveChannelByName, CHANNEL) end
  end
end

-- ---- what the 3D map is told (through the strip's messages, see AzerothAtlas.lua) -----------------
-- { key, 9 bytes } each: how far the server's clock is from this computer's (key 8), and, three
-- lines a round in turn, each line's timetable (key 15 + its number): what it rests on, the
-- moment its newest boat left stop 1 (hundredths of a second), how far its gap is off the
-- measured one (thousandths), and how unsure the next departure is (tenths).
local function Bytes(value, count)
  local out = {}
  value = floor(value + 0.5)
  for i = count, 1, -1 do
    out[i] = strchar(value % 256)
    value = floor(value / 256)
  end
  return table.concat(out)
end
local SOURCE = { own = 1, dw = 2, ft = 3, nau = 4, clock = 5, tv = 6 }
local turn = 0
function shared.TransitReport()
  local out = {}
  if serverLead and localLead then
    local known = 0
    for _, L in pairs(T.lines) do if L.fit then known = known + 1 end end
    out[1] = { 8, strchar(128) .. Bytes((serverLead - localLead) * 1000 + 549755813888, 5) .. strchar(known) .. strchar(0) .. strchar(1) }
  end
  local now = T.Now()
  local count = #T.lines
  for _ = 1, min(3, count) do
    turn = turn % count + 1
    local L = T.lines[turn]
    local c = L.fit
    local leaves, unsure, _
    if c then leaves, _, unsure = T.Next(L, 1, now) end
    -- (a timetable too unsure to name a moment by is told as none, as a step in the game names
    -- none past a sixth of a gap: a byte carries no more than 25.5 s of how unsure it is, and the
    -- map would take it for surer than it is. The tram's cars, a minute apart, are told up to that.)
    if c and unsure <= max(L.gap / 6, 25.5) then
      local k = floor((leaves - L.dep[1] - c.ref - c.a) / c.b + 0.5)
      local flags = 128 + (SOURCE[c.src] or 4)
      if c.laneAt then
        flags = flags + 8
        if (c.lane - 1 + (k - c.laneAt)) % L.cars == 1 then flags = flags + 16 end
      end
      local age = now - c.newest
      flags = flags + 32 * (age < 600 and 0 or age < 3600 and 1 or age < 21600 and 2 or 3)
      out[#out + 1] = { 15 + L.n, strchar(flags) .. Bytes(leaves * 100, 5) .. Bytes(max(0, min(65535, (c.b - L.gap) * 1000 + 32768)), 2) .. strchar(min(255, floor(unsure * 10 + 0.5))) }
    else
      out[#out + 1] = { 15 + L.n, strchar(64) .. string.rep(strchar(0), 8) }
    end
  end
  return out
end

-- ---- what you can tell it ------------------------------------------------------------------------
local WORDS = { own = "your ride", dw = "DockWatch players", ft = "ForeverTransport players", nau = "Nauticus players", tv = "Tripview players" }
local function Ago(s)
  if s < 90 then return floor(s) .. " s ago" end
  if s < 5400 then return floor(s / 60 + 0.5) .. " min ago" end
  return floor(s / 3600 + 0.5) .. " h ago"
end
-- What a line's timetable rests on, in words.
local function Rests(c, now)
  local seen = c.size > 0 and ((WORDS[c.src] or "?") .. (c.size > 1 and (" and " .. (c.size - 1) .. " more") or "") .. ", last seen " .. Ago(now - c.newest)) or nil
  if c.clock then return "By the server's clock" .. (seen and (", borne out by " .. seen) or "") end
  return "Not as the server's clock has it: from " .. (seen or "?")
end
function shared.TransitWord(word, rest)
  if word ~= "boats" and word ~= "boat" and word ~= "transit" then return false end
  local store = Store()
  if rest == "listen" then
    store.listen = store.listen == false
    Listen(store.listen)
    say(store.listen and "other players' sightings of the boats are taken (nothing is sent in the game)." or "other players' sightings of the boats are not taken: the server's clock and your own rides time them.")
    return true
  end
  if rest == "restore" then
    say("there is nothing to put back any more: the boats run by the server's clock, which a restart does not move.")
    return true
  end
  local now = T.Now()
  local known = 0
  for n = 1, #T.lines do
    local L = T.lines[n]
    local c = L.fit
    if c then
      known = known + 1
      local parts = {}
      for s = 1, #L.stops do
        local leaves, gets, unsure = T.Next(L, s, now)
        parts[#parts + 1] = L.stops[s].name .. (gets <= now and " boarding, leaves in " or " in ") .. Clock(leaves - now) .. (unsure > 6 and " (about)" or "")
      end
      say(L.name .. ": leaves " .. table.concat(parts, ", ") .. ". " .. Rests(c, now) .. ".")
    end
  end
  if known == 0 then say("nothing is known of any boat, zeppelin or tram: ride one, or wait for another player's sighting.") end
  local again = WrapBefore(now) + WRAP - now
  if again < 3 * 86400 then
    say("the server's count starts again in " .. (again < 7200 and Clock(again) or (floor(again / 3600 + 0.5) .. " h")) .. ": every boat jumps to another place on its round then, and runs by the clock alone until it is seen again.")
  end
  return true
end

-- ---- what an older version left behind --------------------------------------------------------------
-- Up to version 22 a boat was taken to start its round afresh when the server restarted: the
-- server's warning was read, a ride that did not fit what was known was taken for a restart, and
-- what had been seen before one was thrown away or set aside. The boats run by the server's
-- clock, which no restart moves (the ride of 16 November 2026 that "said" one was off because
-- the airship's round was out by six seconds). What such a version put down about restarts is
-- forgotten, once, and what it had set aside is in use again.
local function Mend(now)
  local store = Store()
  if (tonumber(store.made) or 0) >= MADE then return end
  store.made = MADE
  local back = 0
  if type(store.aside) == "table" then
    for n, A in pairs(store.aside) do
      if T.lines[n] and type(A) == "table" then
        if type(store.sight[n]) ~= "table" then store.sight[n] = {} end
        for _, y in ipairs(A) do
          if type(y) == "table" and plain(y.t) and now - y.t <= KEEP then
            Put(store.sight[n], y)
            back = back + 1
          end
        end
      end
    end
  end
  if store.restart or back > 0 then
    Note("what an older version of the addon put down about a restart" .. (store.restart and (" (" .. Hour(store.restart) .. ")") or "") .. " is forgotten: the boats run by the server's clock; " .. back .. " sightings set aside for it are in use again")
  end
  store.restart, store.before, store.soft, store.why, store.aside = nil, nil, nil, nil, nil
end
-- What is known as the game starts, in a line, for the addon's notes.
local function Summary(now)
  local store = Store()
  local seen, apart, bare = {}, {}, 0
  for n = 1, #T.lines do
    local L = T.lines[n]
    local c = L.fit
    if c then
      local _, _, unsure = T.Next(L, 1, now)
      local word = n .. " " .. tostring(c.src) .. "x" .. tostring(c.size) .. " +-" .. string.format("%.1f", unsure or 0)
      if not c.clock then apart[#apart + 1] = word elseif c.size > 0 then seen[#seen + 1] = word else bare = bare + 1 end
    end
  end
  local began = WrapBefore(now)
  Note(#T.lines .. " lines: " .. bare .. " by the server's clock alone, " .. #seen .. " borne out by sightings" .. (#seen > 0 and (" (" .. table.concat(seen, ", ") .. ")") or "")
    .. ", " .. #apart .. " not as the clock has them" .. (#apart > 0 and (" (" .. table.concat(apart, ", ") .. ")") or "")
    .. "; the server's count started " .. Hour(began) .. " and starts again " .. Hour(began + WRAP)
    .. "; figures " .. (published and "as the Atlas database has measured them" or "as the addon came with them")
    .. "; other players' sightings " .. (store.listen == false and "not taken" or "taken"))
end

-- ---- starting ------------------------------------------------------------------------------------
local frame = CreateFrame("Frame", "AzerothAtlasTransit", UIParent)
local since, applied = 0, nil
frame:SetScript("OnUpdate", function(_, dt)
  Tick()
  since = since + (dt or 0)
  if since < 0.25 then return end
  since = 0
  pcall(Sample)
  -- the server's count has started again: every craft has jumped to another place on its round,
  -- and what was seen before says nothing of now
  local now = T.Now()
  local began = WrapBefore(now)
  if applied and began ~= applied then
    Note("the server's count has started again: every line runs by the clock alone until it is seen again")
    for _, L in pairs(T.lines) do pcall(Solve, L, now) end
    Changed()
  end
  applied = began
  -- (what other players passed on, noted every ten minutes in which there was any)
  local g = GetTime()
  if g - heardAt >= 600 then
    heardAt = g
    pcall(TellHeard)
  end
end)
for _, event in ipairs({ "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "PLAYER_LOGOUT", "CHAT_MSG_ADDON" }) do pcall(frame.RegisterEvent, frame, event) end
local joined = false
frame:SetScript("OnEvent", function(_, event, ...)
  if event == "CHAT_MSG_ADDON" then
    pcall(OnAddonMessage, ...)
  elseif event == "PLAYER_LOGOUT" then
    -- (the game writes the addon's notes down now: with what was heard up to this moment)
    pcall(TellHeard)
  elseif event == "PLAYER_LOGIN" then
    Tick()
    local register = C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix
    if register then
      for _, prefix in ipairs({ PREFIX_DW, PREFIX_FT, PREFIX_NAU, PREFIX_TV }) do pcall(register, prefix) end
    end
    local now = T.Now()
    pcall(Mend, now)
    for _, L in pairs(T.lines) do pcall(Solve, L, now) end
    Changed()
    pcall(Summary, now)
  elseif event == "PLAYER_ENTERING_WORLD" and not joined then
    joined = true
    local function join()
      if Store().listen ~= false then pcall(Listen, true) end
    end
    if C_Timer and C_Timer.After then C_Timer.After(30, join) else join() end
  end
end)

-- (for the tests, and for a look from the game with /dump AzerothAtlas.Transit.Peek())
function T.Peek()
  return { Solve = Solve, Sample = Sample, TryFix = TryFix, FromDockWatch = FromDockWatch, FromForeverTransport = FromForeverTransport,
    FromNauticus = FromNauticus, FromTripview = FromTripview, OnAddonMessage = OnAddonMessage, Store = Store, LegBetween = LegBetween, Tick = Tick,
    Mend = Mend, TellHeard = TellHeard, Summary = Summary }
end
