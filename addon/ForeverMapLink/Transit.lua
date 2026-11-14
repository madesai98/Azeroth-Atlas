-- Forever Map Link: when the boats, zeppelins and tram run.
--
-- A boat sails the same round over and over, to the second, until the server restarts. So one
-- moment at which it was seen to leave a dock fixes its whole timetable: when it is next at
-- every stop, and where it is on its track right now. This file keeps that timetable.
--
-- The game tells an addon nothing about a boat. What there is to go by:
--   your own rides      being carried along a line's recorded track (TransitData.lua) at the
--                       boat's pace says when it left, to about a second, wherever you boarded;
--   other players'      three addons pass such sightings from player to player, each in its own
--                       way, and each is read here as that addon writes it: DockWatch (the
--                       moment a boat left a dock, by where the dock is), ForeverTransport (when
--                       it arrived, by a line's number) and Nauticus (how far into its round a
--                       boat is at the moment of sending). None of them needs to be installed.
--                       This addon only ever listens: it sends nothing to anyone, so it cannot
--                       put a wrong time into anybody's timers;
--   the server's own    a restart starts every boat afresh. The warning the server gives in chat
--                       ("restart in 15:00") is read, and so is a ride of your own that no
--                       longer fits what was known.
-- Nothing is taken on one voice's word where voices differ: sightings that agree with each
-- other (give or take what a round's own uncertainty allows) make a timetable, a sighting that
-- stands alone against a fresh one waits for a second to back it, and the length of a round is
-- worked out from the sightings themselves as they spread over hours.
--
-- The 3D map is told what is known (through the strip's messages), counts boats and trams into
-- the journeys it plans, and shows them moving. The step list counts down to a departure.
--
-- /maplink boats           what is known, line by line
-- /maplink boats listen    other players' sightings: taken, or not

local shared = ForeverMapLink
if type(shared) ~= "table" or type(shared.TransitData) ~= "table" then return end

local floor, ceil, abs, sqrt, max, min = math.floor, math.ceil, math.abs, math.sqrt, math.max, math.min
local strbyte, strchar, strsub, strfind = string.byte, string.char, string.sub, string.find

local TOL = 5              -- seconds two sightings of one boat may differ by (on top of what its round's uncertainty allows)
local ROUND_UNSURE = 0.4   -- seconds a round may be off the measured one, until sightings say
local STALE = 2700         -- a timetable nobody has confirmed for this long gives way to one new sighting
local KEEP = 3 * 86400     -- sightings older than this are forgotten
local MOST = 30            -- sightings kept of one line
local DOCK = 150           -- yards: a spot this near a stop is that stop
-- how far a sighting is trusted: how exact its time is (seconds), and what it counts for when
-- timetables disagree (a timetable wins on 3: your own ride, or two other players)
local UNSURE = { own = 0.7, dw = 1.5, ft = 3, nau = 4 }
local COUNTS = { own = 3, dw = 1.5, ft = 1, nau = 0.5 }
local CHANNEL = "DockWatchData" -- where DockWatch passes its sightings on
local PREFIX_DW, PREFIX_FT, PREFIX_NAU = "DockWatch2", "FTrans2", "NauticSync"

local T = { lines = {}, rev = 0 }
shared.Transit = T

local function say(msg) print("|cff7fd4ffForever Map Link|r: " .. msg) end
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
for _, d in ipairs(shared.TransitData) do
  local L = { n = d.n, id = d.id, key = d.key, kind = d.kind, round = d.period, cars = d.cars or 1, stops = d.stops, legs = d.legs,
    rough = d.rough, lanes = d.lanes, ft = d.ft, ft2 = d.ft2, ftStops = d.ftStops, dep = { 0 }, arr = {}, stay = {} }
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

-- ---- what has been seen ----------------------------------------------------------------------------
-- Kept with the addon's settings, for every character: ForeverMapLinkDB.transit = { sight =
-- { [line] = { { t (when it left stop s, or got there), s, arr (true: got there), src, who, lane,
-- e (when that boat left stop 1 on that round) } } }, restart (the server restarted then, or
-- will), before (the restart known before that one), listen }.
local function Store()
  if type(ForeverMapLinkDB) ~= "table" then ForeverMapLinkDB = {} end
  local s = ForeverMapLinkDB.transit
  if type(s) ~= "table" then
    s = {}
    ForeverMapLinkDB.transit = s
  end
  if type(s.sight) ~= "table" then s.sight = {} end
  return s
end

-- One timetable: sightings that agree. The moment its newest boat left stop 1 (ref + a), and
-- how long from one boat to the next (b), fitted to all of them: each sighting weighed by how
-- exact it is, the gap held near the measured one for as long as the sightings span little time.
-- (va, vb, cab: how unsure the two are, and how the one's error goes with the other's.)
local function Fit(L, c)
  local q = 1 / ((ROUND_UNSURE / L.cars) ^ 2)
  local sw, sn, snn, sy, sny = 0, 0, 0, 0, 0
  for _, x in ipairs(c.members) do
    local w = 1 / (x.unsure * x.unsure)
    local y = x.e - c.ref
    sw, sn, snn, sy, sny = sw + w, sn + w * x.k, snn + w * x.k * x.k, sy + w * y, sny + w * x.k * y
  end
  local det = sw * (snn + q) - sn * sn
  c.a = (sy * (snn + q) - sn * (sny + q * L.gap)) / det
  c.b = (sw * (sny + q * L.gap) - sn * sy) / det
  c.va, c.vb, c.cab = (snn + q) / det, sw / det, -sn / det
end
local function Unsure(c, k)
  return sqrt(max(0, c.va + k * k * c.vb + 2 * k * c.cab))
end
-- Does a sighting belong to this timetable: is it a whole number of boats away from it, as near
-- as its own exactness and the timetable's allow?
local function Belongs(L, c, x)
  local k = floor((x.e - c.ref - c.a) / c.b + 0.5)
  local off = x.e - c.ref - c.a - k * c.b
  local allowed = TOL + x.unsure + 2 * Unsure(c, k)
  if allowed > L.gap / 3 then allowed = L.gap / 3 end
  if abs(off) > allowed then return false end
  x.k = k
  return true
end

local function Solve(L, now)
  local store = Store()
  local S = store.sight[L.n]
  L.fit, L.held = nil, nil
  if type(S) ~= "table" then return end
  local restart = store.restart
  -- the sightings that still count, newest first
  local live = {}
  for i = #S, 1, -1 do
    local x = S[i]
    local into = type(x) == "table" and plain(x.t) and (x.arr and L.arr[x.s] or L.dep[x.s])
    if not into or now - x.t > KEEP or (restart and restart <= now and x.t < restart) then
      table.remove(S, i)
    else
      -- (when that boat left stop 1 on that round)
      x.e, x.unsure = x.t - into, UNSURE[x.src] or 4
      live[#live + 1] = x
    end
  end
  if #live == 0 then return end
  -- gathered into timetables: each sighting joins the first it agrees with
  local found = {}
  for _, x in ipairs(live) do
    local home
    for _, c in ipairs(found) do
      if Belongs(L, c, x) then home = c break end
    end
    if home then
      home.members[#home.members + 1] = x
    else
      x.k = 0
      home = { ref = x.e, members = { x }, newest = x.t, seen = {}, counts = 0 }
      found[#found + 1] = home
    end
    Fit(L, home)
    -- (a player counts once, for the best of what they saw)
    local who = x.src == "own" and "*" or (x.who or "?")
    local worth = COUNTS[x.src] or 0.5
    if (home.seen[who] or 0) < worth then
      home.counts = home.counts + worth - (home.seen[who] or 0)
      home.seen[who] = worth
    end
    if x.src == "own" then home.own = true end
  end
  -- The newest sighting's timetable is the one that runs now, unless it stands alone against
  -- another that was confirmed not long before it: then it waits for a second voice.
  local first, second = found[1], found[2]
  local chosen = first
  if second and first.counts < 3 and first.newest - second.newest <= (first.counts >= 1.5 and STALE or 4 * STALE) then
    chosen = second
    L.held = first
  elseif second and first.own and second.counts >= 3 then
    -- your own ride no longer fits a timetable that was well founded: the server has restarted
    -- since that one was last seen to hold (and with it every other line's)
    T.Restarted(second.newest + 1, "your ride on " .. L.name)
  end
  -- (what is left of older timetables is of no more use)
  for i = #S, 1, -1 do
    local x, keep = S[i], false
    for _, m in ipairs(chosen.members) do if m == x then keep = true break end end
    if not keep and L.held then
      for _, m in ipairs(L.held.members) do if m == x then keep = now - x.t <= 2 * STALE break end end
    end
    if not keep then table.remove(S, i) end
  end
  local best
  for _, m in ipairs(chosen.members) do
    if not best or (COUNTS[m.src] or 0) > (COUNTS[best.src] or 0) then best = m end
  end
  chosen.src, chosen.size = best.src, #chosen.members
  -- which of the tram's tracks a car is on: they take turns, so one car whose track is known says it for all
  for _, m in ipairs(chosen.members) do
    if m.lane and L.cars > 1 and (not chosen.laneAt or m.t > chosen.laneT) then chosen.laneAt, chosen.lane, chosen.laneT = m.k, m.lane, m.t end
  end
  L.fit = chosen
end

local function Changed()
  T.rev = T.rev + 1
  if shared.Guide then shared.Guide.rev = (shared.Guide.rev or 0) + 1 end
end

-- The server restarted at (about) `at`, or will: what was seen before then is of an older
-- timetable. Only ever moves later.
function T.Restarted(at, why)
  local store = Store()
  if store.restart and at <= store.restart then return end
  store.before, store.restart = store.restart, at
  T.restartWhy = why
  local now = T.Now()
  if at <= now then
    for _, L in pairs(T.lines) do Solve(L, now) end
    Changed()
  end
end

-- A boat of line L was seen: it left stop `s` at server time `t` (or, with `arrived`, got there).
-- src: "own" (your ride), "dw", "ft" or "nau" (another player's, by way of that addon).
function T.Sighted(L, s, t, arrived, src, who, lane)
  local store = Store()
  local now = T.Now()
  if not (L and L.dep[s] and plain(t)) or t > now + 30 or t < now - KEEP then return false end
  if store.restart and store.restart <= now and t < store.restart then return false end
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
      return false
    end
  end
  local x = { t = t, s = s, arr = arrived and true or nil, src = src, who = who, lane = lane, e = t - (arrived and L.arr[s] or L.dep[s]) }
  local at = #S + 1
  while at > 1 and S[at - 1].t > t do at = at - 1 end
  table.insert(S, at, x)
  while #S > MOST do table.remove(S, 1) end
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

local function OnAddonMessage(prefix, msg, how, sender)
  prefix, msg, how, sender = text(prefix), text(msg), text(how), text(sender)
  if not (prefix and msg and sender) or Store().listen == false then return end
  if prefix == PREFIX_DW then
    FromDockWatch(msg, sender)
  elseif prefix == PREFIX_FT then
    if how == "PARTY" or how == "RAID" or how == "GUILD" or how == "YELL" or how == "WHISPER" then FromForeverTransport(msg, sender) end
  elseif prefix == PREFIX_NAU then
    if #msg < 254 and (how == "PARTY" or how == "RAID" or how == "GUILD" or how == "YELL") then FromNauticus(msg, sender) end
  end
end

-- The server's warning of a restart ("... restart in 15:00", "shutdown in 5 minutes"): the boats
-- start afresh then.
local function OnSystemMessage(msg)
  msg = text(msg)
  if not msg then return end
  local low = string.lower(msg)
  if not (strfind(low, "shutdown", 1, true) or strfind(low, "restart", 1, true) or strfind(low, "reboot", 1, true)) then return end
  local store = Store()
  if strfind(low, "cancel", 1, true) then
    -- called off: a restart that has not happened yet is forgotten
    if store.restart and store.restart > T.Now() then store.restart, store.before = store.before, nil end
    return
  end
  local secs
  local m, s = string.match(low, "(%d+):(%d%d)")
  if m then
    secs = tonumber(m) * 60 + tonumber(s)
  else
    local mins, more = string.match(low, "(%d+)%s*min"), string.match(low, "(%d+)%s*sec")
    if mins or more then secs = (tonumber(mins) or 0) * 60 + (tonumber(more) or 0) end
  end
  if secs and secs <= 7200 then T.Restarted(T.Now() + secs, "the server's warning") end
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
  elseif LeaveChannelByName then
    -- (DockWatch itself, where it is installed, has the channel for its own use)
    local loaded = C_AddOns and C_AddOns.IsAddOnLoaded and C_AddOns.IsAddOnLoaded("DockWatch")
    if not loaded then pcall(LeaveChannelByName, CHANNEL) end
  end
end

-- ---- what the 3D map is told (through the strip's messages, see ForeverMapLink.lua) -----------------
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
local SOURCE = { own = 1, dw = 2, ft = 3, nau = 4 }
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
    if c then
      local leaves, _, unsure = T.Next(L, 1, now)
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
local WORDS = { own = "your ride", dw = "DockWatch players", ft = "ForeverTransport players", nau = "Nauticus players" }
local function Ago(s)
  if s < 90 then return floor(s) .. " s ago" end
  if s < 5400 then return floor(s / 60 + 0.5) .. " min ago" end
  return floor(s / 3600 + 0.5) .. " h ago"
end
function shared.TransitWord(word, rest)
  if word ~= "boats" and word ~= "boat" and word ~= "transit" then return false end
  local store = Store()
  if rest == "listen" then
    store.listen = store.listen == false
    Listen(store.listen)
    say(store.listen and "other players' sightings of the boats are taken (nothing is sent)." or "other players' sightings of the boats are not taken: only your own rides time them.")
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
      say(L.name .. ": leaves " .. table.concat(parts, ", ") .. ". From " .. (WORDS[c.src] or "?") .. (c.size > 1 and (" and " .. (c.size - 1) .. " more") or "") .. ", last seen " .. Ago(now - c.newest) .. ".")
    end
  end
  if known == 0 then say("no boat, zeppelin or tram has been timed yet: ride one, or wait for another player's sighting.") end
  if known < #T.lines and known > 0 then say((#T.lines - known) .. " more lines have not been timed since the last restart.") end
  if store.restart and store.restart > now then say("the server restarts in " .. Clock(store.restart - now) .. ": every boat starts afresh then.") end
  return true
end

-- ---- starting ------------------------------------------------------------------------------------
local frame = CreateFrame("Frame", "ForeverMapLinkTransit", UIParent)
local since, applied = 0, nil
frame:SetScript("OnUpdate", function(_, dt)
  Tick()
  since = since + (dt or 0)
  if since < 0.25 then return end
  since = 0
  pcall(Sample)
  -- a restart that was announced has come: what was seen before it no longer holds
  local restart = type(ForeverMapLinkDB) == "table" and type(ForeverMapLinkDB.transit) == "table" and ForeverMapLinkDB.transit.restart
  if restart and restart ~= applied then
    local now = T.Now()
    if now >= restart then
      applied = restart
      for _, L in pairs(T.lines) do pcall(Solve, L, now) end
      Changed()
    end
  end
end)
for _, event in ipairs({ "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "CHAT_MSG_ADDON", "CHAT_MSG_SYSTEM" }) do pcall(frame.RegisterEvent, frame, event) end
local joined = false
frame:SetScript("OnEvent", function(_, event, ...)
  if event == "CHAT_MSG_ADDON" then
    pcall(OnAddonMessage, ...)
  elseif event == "CHAT_MSG_SYSTEM" then
    pcall(OnSystemMessage, ...)
  elseif event == "PLAYER_LOGIN" then
    Tick()
    local register = C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix
    if register then
      for _, prefix in ipairs({ PREFIX_DW, PREFIX_FT, PREFIX_NAU }) do pcall(register, prefix) end
    end
    local now = T.Now()
    for _, L in pairs(T.lines) do pcall(Solve, L, now) end
    Changed()
  elseif event == "PLAYER_ENTERING_WORLD" and not joined then
    joined = true
    local function join()
      if Store().listen ~= false then pcall(Listen, true) end
    end
    if C_Timer and C_Timer.After then C_Timer.After(30, join) else join() end
  end
end)

-- (for the tests, and for a look from the game with /dump ForeverMapLink.Transit.Peek())
function T.Peek()
  return { Solve = Solve, Sample = Sample, TryFix = TryFix, FromDockWatch = FromDockWatch, FromForeverTransport = FromForeverTransport,
    FromNauticus = FromNauticus, OnAddonMessage = OnAddonMessage, OnSystemMessage = OnSystemMessage, Store = Store, LegBetween = LegBetween, Tick = Tick }
end
