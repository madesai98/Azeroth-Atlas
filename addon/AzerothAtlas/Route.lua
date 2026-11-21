-- Azeroth Atlas: the route, shown in the game.
--
-- The 3D map works out the way to your waypoint over the real ground - stairs, bridges, caves,
-- flight paths, boats. This file draws that same route, seen from above, on the game's world
-- map and on the minimap, so both show one and the same way.
--
-- An addon cannot be sent anything while the game runs. What it can do is load another addon
-- on demand, and the game reads that addon's file from the disk at that moment. So the route
-- comes in through "mailboxes": a row of tiny load-on-demand addons (AzerothAtlas_Mail001,
-- 002, ...) whose one file the map's local server keeps rewriting with the route as it is now.
-- A mailbox can be opened once per login or /reload, so they are opened sparingly: when your
-- waypoint changes, when you have left the route, or when you ask (/atlas route).
--
-- The game tells an addon where you are on the map but not how high. Seen from above, the floor
-- under a waypoint and the gallery the waypoint is on are one spot, and a road is on the bridge
-- that crosses it. So your place on the route is followed step by step from where you were on it
-- (you cannot be further along than you have walked), each delivery says how high the route runs
-- and where another level lies over or under it, and where that leaves a doubt the 3D map - which
-- does follow your height - is asked. A waypoint is reached at the end of its route, on its own
-- level: not when you stand under it.
--
-- The same delivery says what the journey consists of (walk to the flight master, fly, walk on)
-- and, where the spot you are heading for has more than one level, which levels there are:
-- Guide.lua shows those as the arrow, the step list and the question about the level.
--
-- /atlas clear    stop heading for the waypoint you have now (also: right-click the route's end on the map)
-- /atlas route    fetch the route the 3D map shows now (for a marker you dropped on the 3D map)
-- /atlas status   how the route's way into the game is doing
-- /atlas level    choose again which level your waypoint is on

local shared = AzerothAtlas
if type(shared) ~= "table" then return end

local floor, sqrt, huge = math.floor, math.sqrt, math.huge
local strchar, strbyte, format = string.char, string.byte, string.format

local MAIL_NAME, MAIL_MAX = "AzerothAtlas_Mail%03d", 999
local FIRST_WAIT = 1.8        -- seconds from a new waypoint to opening the first mailbox for it
local RETRY = { 2.5, 5, 10, 20, 40 } -- then these, while the 3D map is still working the route out
local LATE = 30               -- seconds: a delivery older than this means nobody is writing them
-- Seconds to leave the mailboxes alone when nobody seems to be writing them (doubling). Short
-- to begin with: the first look after a login can simply have come before the 3D map had seen
-- the game again, and a route that stays away for minutes over that is a route that "sometimes
-- does not show". With the 3D map really not running, this costs a dozen mailboxes an hour.
local QUIET, QUIET_MAX = 15, 300
local STRAY, STRAY_FOR = 25, 3     -- yards off the route, for this many seconds, before a newer one is fetched
local STRAY_GAP, STRAY_HOLD = 8, 20 -- seconds between such fetches; and after one that brought nothing new
local MOVED = 150             -- yards you must move before a waypoint with no route is asked about again
local ARRIVE, DEPART = 10, 15 -- yards: a pin or quick waypoint you reach (having been this far from it) is taken off the map
local LEVEL = 2.5             -- yards of height within which two places are on one level
local ON = 12                 -- yards from where you were on the route within which you are still on it
local REJOIN = 8              -- yards from another part of the route within which you may have joined it there
local AHEAD, BACK, PACE = 3, 6, 1.6 -- how far along the route you can have got since the last look: these yards on or back, and this many more for each yard you moved
local LEAP = 30               -- yards between two looks that no walking explains (a teleport, a loading screen)
local TRAIL = 300             -- of your steps are remembered: a minute's worth
local APART = 30              -- yards of route between two parts of it that count as two
local NEAR_FOR = 3            -- seconds at a waypoint's spot with the route saying you are not at it, before the 3D map is asked
local NEAR_HOLD, NEAR_HOLD_MAX = 30, 600 -- seconds from the last word on that waypoint to asking (doubling each time)
local W_GUIDE, W_PIN, W_QUICK = 1, 3, 4 -- the waypoint is your guide's step, a pin on the game's map, or a quick one of ours (as in AzerothAtlas.lua)
local LEVEL_WAIT = 2          -- seconds from choosing another level to opening a mailbox for the route to it
local BARE_MOVED = 60         -- yards you move before a journey with nothing to draw here is asked about again
local NEXT_AT = 8             -- yards from the end of what can be walked here: the boat, the portal is the step you are on
local F_TAXI = 16             -- (as in AzerothAtlas.lua) player flag: on a flight path
local BREAK = 8               -- kind flag: this point starts a new stretch
-- kinds of stretch: on foot, swimming, one no longer sent (it was "through a danger zone"), in the air, carried by a boat or zeppelin
-- (and a sixth that no delivery has: the line from you to your inn, where a journey begins with your hearthstone - see Hearth)
local COLOUR = { [0] = { 1, 0.82, 0.1 }, { 0.35, 0.75, 1 }, { 1, 0.4, 0.25 }, { 0.8, 0.92, 1 }, { 0.76, 0.61, 1 }, { 1, 0.42, 0.84 } }
local HEARTH = 5              -- that sixth kind
local HEARTH_NEAR = 40        -- yards from the inn within which the stone has been used (or is not worth a line)
local HEARTH_STEP = 4         -- yards you move before that line is drawn again from where you are
local ALSO_MAX = 60           -- lines of a journey that are only shown (on other continents, across the sea), at most
local MORE_MAX = 80           -- lines of the other routes (shown beside the one that is followed), at most
local OTHERS_MAX = 8          -- other routes of a delivery (each with its steps), at most
local HEADS_WAIT = 2.5        -- seconds from a change in what else you could be heading for (the quest you track, your body, your party) to asking for the routes there
local WANDER_HOLD, WANDER_HOLD_MAX = 20, 300 -- with no route that leads: seconds from one look for a newer route (you have left the one you follow) to the next, doubling while you stay off it...
local WANDER_BACK = 15        -- ...and back to the first of those once you have been on the route for this long
local ALLY_NEAR = 80          -- yards from the end of the route to someone in your party within which they still are where it leads
local HEARTH_FOR = 60         -- seconds from switching your hearthstone on or off in which only a route worked out since will do
local AGAIN, AGAIN_MAX = 30, 300 -- seconds from giving a waypoint's route up to asking for it once more (doubling)
-- A route has a colour of its own on the 3D map (your guide's green, your waypoint's blue...),
-- and is drawn in it here: as it is where you walk, turned toward light blue where you swim,
-- a light tint of it where you fly, toward violet where a boat carries you. (As RouteRenderer
-- does on the 3D map: viewer/js/route.js.) And a pink of its own, hardly tinted (no route is pink), for the
-- line your hearthstone takes you along: nobody is to take that one for a way to walk.
local function Shades(colour)
  local r, g, b = floor(colour / 65536) % 256 / 255, floor(colour / 256) % 256 / 255, colour % 256 / 255
  local function mix(tr, tg, tb, t) return { r + (tr - r) * t, g + (tg - g) * t, b + (tb - b) * t } end
  local walk = { r, g, b }
  return { [0] = walk, mix(0.36, 0.78, 1, 0.55), walk, mix(1, 1, 1, 0.62), mix(0.76, 0.61, 1, 0.5), mix(1, 0.42, 0.84, 0.85) }
end
local shadesOf = {} -- (worked out once for each colour)
local function Shade(colour, kind)
  if not colour then return nil end
  local s = shadesOf[colour]
  if not s then
    s = Shades(colour)
    shadesOf[colour] = s
  end
  return s[kind] or s[0]
end
-- The other routes of a delivery: { map, kind, colour, X, Y, n } each.
local function More(m)
  local out = {}
  if type(m.more) ~= "table" then return out end
  for _, a in ipairs(m.more) do
    if type(a) == "table" and #out < MORE_MAX then
      local map, kind, colour = tonumber(a[1]), tonumber(a[2]) or 0, tonumber(a[3])
      if kind < 0 or kind > 4 then kind = 0 end
      local X, Y, c = {}, {}, 0
      for i = 4, #a - 1, 2 do
        local x, y = tonumber(a[i]), tonumber(a[i + 1])
        if x and y then
          c = c + 1
          X[c], Y[c] = x, y
        end
      end
      if map and colour and c >= 2 then out[#out + 1] = { map = map, kind = kind, colour = colour, X = X, Y = Y, n = c } end
    end
  end
  return out
end

local function say(msg) print("|cff7fd4ffAzeroth Atlas|r: " .. msg) end

-- ---- the mailboxes --------------------------------------------------------------------------
local Addons = C_AddOns or {}
local function Exists(name)
  if Addons.DoesAddOnExist then return Addons.DoesAddOnExist(name) and true or false end
  local info = Addons.GetAddOnInfo or GetAddOnInfo
  if not info then return false end
  local found, _, _, _, reason = info(name)
  return found ~= nil and reason ~= "MISSING"
end
local function IsLoaded(name)
  local f = Addons.IsAddOnLoaded or IsAddOnLoaded
  if not f then return false end
  local a, b = f(name)
  return (a and true) or (b and true) or false
end
local function LoadMail(name)
  local load = Addons.LoadAddOn or LoadAddOn
  if not load then return false, "NO_LOADER" end
  local ok, loaded, reason = pcall(load, name)
  if ok and not loaded and reason == "DISABLED" then
    -- (switched off in the addon list: a mailbox is of no use that way)
    local enable = Addons.EnableAddOn or EnableAddOn
    if enable then
      pcall(enable, name)
      ok, loaded, reason = pcall(load, name)
    end
  end
  if not ok then return false, "ERROR" end
  return loaded and true or false, reason
end

-- size: how many mailboxes are installed; next: the one to open next; have: the number of the
-- last delivery read (told to the server, so it knows what arrived); at: when one was last opened
local mail = { counted = false, size = 0, next = 1, session = 0, have = 0, at = -100, opened = 0 }
local function Count()
  mail.counted = true
  mail.session = math.random(1, 255) -- a new number after every /reload: the mailboxes can be opened again
  local size = 0
  for i = 1, MAIL_MAX do
    if not Exists(format(MAIL_NAME, i)) then break end
    size = i
  end
  local next = size + 1
  for i = 1, size do
    if not IsLoaded(format(MAIL_NAME, i)) then next = i break end
  end
  mail.size, mail.next = size, next
  shared.Log("mailboxes: " .. size .. " found, the next to open is " .. next .. " (this login or reload is number " .. mail.session .. ")")
end

-- Open the next mailbox: the delivery in it (a table), or nil and why not.
local function Open(now)
  if mail.next > mail.size then return nil, "used" end
  local name = format(MAIL_NAME, mail.next)
  mail.next = mail.next + 1
  mail.opened, mail.at = mail.opened + 1, now
  AzerothAtlasMail = nil
  local loaded, reason = LoadMail(name)
  local m = AzerothAtlasMail
  AzerothAtlasMail = nil
  if shared.Tell then shared.Tell() end
  if type(m) ~= "table" then return nil, loaded and "empty" or tostring(reason or "unreadable") end
  mail.have = type(m.written) == "number" and m.written % 65536 or 0
  return m
end

-- ---- the route ------------------------------------------------------------------------------
-- route: { plan, tk tm tx ty (the waypoint it leads to, as the strip names it), map, n,
--          X[i] north, Y[i] west, K[i] kind of the piece ending at point i (+BREAK: no piece),
--          C[i] yards along, at (the piece you are on), sn sw (your spot on it) }
local route, rev = nil, 0
local want = nil      -- a delivery is wanted: { why, tm, tx, ty, tries, at (when to open the next mailbox) }
local gave = nil      -- the waypoint the 3D map had no route for: { tm, tx, ty, north, west }
local note = nil      -- why there is no route, for /atlas status
local quietUntil, quietFor = -1, QUIET
local offSince, strayHold = nil, -1
-- the pin or quick waypoint you have now: far (you have been away from it since it was set), near
-- (since when you stand at its spot unreached), asked (when the 3D map last said anything of it)
local pin = { x = -1, y = -1, far = false, near = nil, asked = nil, hold = NEAR_HOLD }

local function Drop()
  if route then
    route = nil
    rev = rev + 1
  end
end

-- For the addon's notes (shared.Log): a delivery in a few words - its number and what it says,
-- the waypoint it is about, the quest its routes were worked out for, the other routes it brings.
local function Told(m)
  local out = "delivery " .. tostring(m.written) .. " " .. tostring(m.state) .. " to " .. tostring(m.tk) .. ":" .. tostring(m.tm) .. ":" .. tostring(m.tx) .. ":" .. tostring(m.ty)
  if m.plan then out = out .. " plan " .. tostring(m.plan) end
  if type(m.tq) == "table" then out = out .. " quest " .. tostring(m.tq[1]) .. "." .. tostring(m.tq[2]) .. "." .. tostring(m.tq[3]) end
  if m.hs ~= nil then out = out .. " hearth" .. tostring(m.hs) end
  if type(m.rs) == "table" then
    out = out .. " others"
    for _, o in ipairs(m.rs) do
      if type(o) == "table" then out = out .. " " .. tostring(o.k) .. "=" .. tostring(o.st) end
    end
  end
  return out
end

-- A route, made of what a delivery says of it: the delivery itself for the one that leads, one
-- of its `rs` for another (`other`). nil: there is nothing to it.
local function Build(m, other)
  local r = {
    plan = tonumber(m.plan) or 0, tk = tonumber(m.tk) or 0, tm = tonumber(m.tm) or 0, tx = tonumber(m.tx) or 0, ty = tonumber(m.ty) or 0,
    map = tonumber(m.map) or 0, text = type(m.text) == "string" and m.text or nil, name = type(m.name) == "string" and m.name or nil,
    title = type(m.title) == "string" and m.title or nil, secs = tonumber(m.secs) or 0,
    detached = m.detached and true or false, X = {}, Y = {}, K = {}, C = {}, n = 0, at = 1, sn = nil, sw = nil,
    -- S[i]: the last point of the track's i-th stretch; steps: { text, secs, to (the point its line ends at, nil if
    -- none of it is drawn here), fly (its line is a flight), note }; cur: the step you are on; along, off: yards
    -- along the line, and off it
    S = {}, steps = {}, cur = 0, along = 0, off = 0, lv = nil,
    -- Z[i]: how high point i is; A[i]: another level lies over or under it; tall: every point has both.
    -- fixed: your place on it has been found; doubt: you may be on another part of it than it is followed on
    Z = {}, A = {}, tall = false, fixed = false, doubt = false,
    -- from the 3D map, which follows how high you are: you are at the waypoint (nil: it does not say); where the route ends, and on which map
    there = nil, ex = tonumber(m.ex), ey = tonumber(m.ey), em = tonumber(m.em),
    -- also: the rest of the journey, shown on the world map and not followed - its lines on other
    -- continents, and its crossings by boat and zeppelin: { map, kind, X, Y, n, joins (it goes on
    -- from the line before it, over the sea between two continents) }
    also = {},
    -- rc: the colour this route has on the 3D map (nil from a map that does not say: the colours of old);
    -- more: the other routes there are, shown beside it and not followed
    -- (the others' lines alone - More - are what an older 3D map sends; a newer one sends them whole as well: rs)
    rc = tonumber(m.rc) or tonumber(m.c), more = (other or type(m.rs) == "table") and {} or More(m),
    -- key: which route it is ("guide", "waypoint", "quest", "death", "ally1"...); head: what the
    -- list of routes calls it ("Waypoint: Sentinel Hill"); state: "route" (the others can also
    -- be "pending" or "none": see TakeOthers)
    key = (type(m.sk) == "string" and m.sk) or (type(m.k) == "string" and m.k) or nil, head = type(m.hd) == "string" and m.hd or nil, state = "route",
  }
  if type(m.also) == "table" then
    for _, a in ipairs(m.also) do
      if type(a) == "table" and #r.also < ALSO_MAX then
        local map, kind = tonumber(a[1]), tonumber(a[2]) or 0
        local joins = kind >= 16
        if joins then kind = kind - 16 end
        if kind < 0 or kind > 4 then kind = 0 end
        local X, Y, c = {}, {}, 0
        for i = 3, #a - 1, 2 do
          local x, y = tonumber(a[i]), tonumber(a[i + 1])
          if x and y then
            c = c + 1
            X[c], Y[c] = x, y
          end
        end
        if map and c >= 2 then r.also[#r.also + 1] = { map = map, kind = kind, X = X, Y = Y, n = c, joins = joins } end
      end
    end
  end
  if m.there == true then r.there = true elseif m.there == false then r.there = false end
  -- inn: the journey begins with your hearthstone, which takes you here ({ map, north, west }).
  -- It has no line on the map from where you stand - the line begins at the inn - so one is drawn (DrawMap: Hearth).
  if type(m.inn) == "table" then
    local im, ix, iy = tonumber(m.inn[1]), tonumber(m.inn[2]), tonumber(m.inn[3])
    if im and ix and iy then r.inn = { map = im, north = ix, west = iy } end
  end
  local tall = type(m.zs) == "table" and type(m.am) == "table"
  local n = 0
  if type(m.track) == "table" then
    for si, s in ipairs(m.track) do
      if type(s) == "table" then
        local kind = tonumber(s[1]) or 0
        if kind < 0 or kind > 3 then kind = 0 end
        local first = true
        local zs, am = tall and m.zs[si], tall and m.am[si]
        if type(zs) ~= "table" or type(am) ~= "string" then zs, am, tall = nil, nil, false end
        for i = 2, #s - 1, 2 do
          local x, y = tonumber(s[i]), tonumber(s[i + 1])
          if x and y then
            n = n + 1
            r.X[n], r.Y[n], r.K[n] = x, y, kind + (first and BREAK or 0)
            first = false
            local z = zs and tonumber(zs[i / 2])
            if z then r.Z[n], r.A[n] = z, strbyte(am, i / 2) == 49 else tall = false end
          end
        end
      end
      r.S[si] = n
    end
  end
  if type(m.steps) == "table" then
    for _, st in ipairs(m.steps) do
      if type(st) == "table" and type(st[1]) == "string" then
        local last = tonumber(st[3]) or 0
        local to = last > 0 and r.S[last] or nil
        if to and to < 2 then to = nil end
        -- (line, stop, ride: a step that waits for a boat, zeppelin or tram - which, where you board, seconds the crossing takes; see Transit.lua)
        r.steps[#r.steps + 1] = { text = st[1], secs = tonumber(st[2]) or 0, to = to, fly = to ~= nil and r.K[to] % BREAK == 3,
          note = type(st[4]) == "string" and st[4] ~= "" and st[4] or nil, line = tonumber(st[5]), stop = tonumber(st[6]), ride = tonumber(st[7]) }
      end
    end
  end
  -- the levels there are at the waypoint's spot (more than one: there is a choice)
  if type(m.lv) == "table" then
    local list = {}
    for _, label in ipairs(m.lv) do
      if type(label) == "string" then list[#list + 1] = label end
    end
    if #list > 1 then
      r.lv = { id = tonumber(m.lv.id) or 0, at = tonumber(m.lv.at) or 1, ask = m.lv.ask and true or false, list = list }
    end
  end
  if n < 2 and #r.steps == 0 and #r.more == 0 then return nil end
  -- (bare: a journey with nothing to draw on this map - it begins with a hearthstone, or a boat you stand by)
  r.n, r.bare = n, n < 2
  r.tall = tall and n >= 2
  if n >= 1 then r.C[1] = 0 end
  for i = 2, n do
    r.C[i] = r.C[i - 1] + (r.K[i] >= BREAK and 0 or sqrt((r.X[i] - r.X[i - 1]) ^ 2 + (r.Y[i] - r.Y[i - 1]) ^ 2))
  end
  local p = shared.player
  r.bornMap, r.bornN, r.bornW = p.map, p.world and p.north or nil, p.world and p.west or nil
  return r
end

local function Adopt(m)
  local r = Build(m)
  if not r then return false end
  route = r
  rev = rev + 1
  return true
end

-- ---- the other routes --------------------------------------------------------------------------
-- The 3D map plans a route to every place you could be heading for - your guide's step, the
-- quest you track, your body, your party - and one of them leads. A delivery brings the others
-- as well (rs), each as the leading one comes: its line, its steps, what it is called. They are
-- drawn beside it and listed under it, and your place on each is followed as you walk. They do
-- not hang on the one that leads: with no waypoint in the game at all they are still there, and
-- the first of them is then the one you follow.
local others = {}       -- { key, state ("route", "pending": still being worked out, "none": no way), head, rc, text, and for a route all that Build gives }
local othersSaid = nil  -- true: the 3D map says them route by route; false: an older one, that sends their lines alone (More); nil: not heard yet
local othersDue, othersTries = nil, 0 -- when to ask for them (again), and how often that has been done since they last changed
local headsSig = nil    -- what else you could be heading for, as it last was (see HeadsSig)
local wanderHold, loneOn = WANDER_HOLD, nil -- how long the next look after leaving the route you follow is put off; since when you have been on it
local hearthAt, hearthDue = -1000, nil -- when you last switched your hearthstone on or off, and when to ask for the routes without (or with) it

local function OtherOf(key)
  for _, o in ipairs(others) do
    if o.key == key then return o end
  end
  return nil
end

-- With no route that leads (no waypoint in the game at all), the one you follow - the arrow
-- points along it, and leaving it is what a newer one is fetched for: the first of the others.
-- Not the way to someone in your party, though: those are shown, and nobody is led along them.
local function Lone()
  if route or shared.target.kind ~= 0 then return nil end
  for _, o in ipairs(others) do
    if o.state == "route" and not string.find(o.key, "^ally") then return o end
  end
  return nil
end

-- A route that is not there to be shown (yet): still being worked out ("pending"), or none.
local function NoRoute(key, state, head, colour, words)
  return { key = key, state = state, head = head, rc = colour, text = words, steps = {}, also = {}, more = {}, n = 0, bare = true, cur = 0, secs = 0, off = 0, along = 0 }
end

-- The quest you track changes under the 3D map's feet: you track another, or get something of
-- it done, and the way to it is then another way - to the next thing it asks for, or to who
-- takes it. The game knows at once; the 3D map hears of it through the strip, a moment later,
-- and needs another moment to work the new way out. So every delivery says which quest its
-- routes were worked out for and how far that had got (tq: its number, how it stands, which of
-- what it asks for is done). true: that is older word than the game's own.
-- (and whether it is at least the same quest: then what the delivery calls it is its name)
local function Behind(m)
  if type(m.tq) ~= "table" or not shared.Heads then return false, true end
  local h = shared.Heads()
  if not (h.quest and h.quest > 0) then return false, true end
  if tonumber(m.tq[1]) ~= h.quest then return true, false end
  return h.qsaid == true and (tonumber(m.tq[2]) ~= h.qstate or tonumber(m.tq[3]) ~= h.qdone), true
end

-- Take the other routes from a delivery. true if any of them is still being worked out.
local function TakeOthers(m, now)
  if type(m.rs) ~= "table" then
    -- (an older 3D map: there is nothing of this kind to ask it for)
    othersSaid, othersDue = false, nil
    if others[1] then
      others = {}
      rev = rev + 1
    end
    return false
  end
  othersSaid = true
  -- (the 3D map has not heard yet how the quest you track stands now: its route here is the one
  -- from before - not shown, and looked for again a little later, like one still being worked out)
  local behind, known = Behind(m)
  local list, pending = {}, behind
  if behind then
    local h = shared.Heads()
    shared.Log("that delivery is behind on the quest you track: the game has " .. tostring(h.quest) .. "." .. tostring(h.qstate) .. "." .. tostring(h.qdone) .. ", its quest route is not taken")
    local was = OtherOf("quest")
    list[1] = NoRoute("quest", "pending", known and was and was.head or nil, was and was.rc or nil, nil)
  end
  for _, o in ipairs(m.rs) do
    if type(o) == "table" and o.k == "quest" and behind then
      -- (said above; what it is called and its colour are as the delivery has them, where it is this quest)
      if known and type(o.hd) == "string" then list[1].head = o.hd end
      list[1].rc = tonumber(o.c) or list[1].rc
    elseif type(o) == "table" and type(o.k) == "string" and #list < OTHERS_MAX then
      local made = nil
      if o.st == "route" then
        made = Build(o, true)
        -- (the same route as before: your place on it stands)
        local was = made and OtherOf(o.k)
        if was and was.state == "route" and was.plan == made.plan and was.n == made.n then
          was.head, was.rc = made.head, made.rc
          made = was
        end
      end
      if not made then
        made = NoRoute(o.k, o.st == "pending" and "pending" or "none", type(o.hd) == "string" and o.hd or nil, tonumber(o.c), type(o.text) == "string" and o.text or nil)
      end
      if made.state == "pending" then pending = true end
      list[#list + 1] = made
    end
  end
  others = list
  rev = rev + 1
  if pending and othersTries < #RETRY then
    othersTries = othersTries + 1
    othersDue = now + RETRY[othersTries]
  else
    othersDue = nil
    if not pending then othersTries = 0 end
  end
  return pending
end

-- What else you could be heading for, as the game itself knows it: a few words that change when
-- it does. (The quest you track, and how far it has got - once something it asks for is done,
-- or all of it, there is another place to go to; your body; your guide's step; who is in your
-- party.) And the words about the quest on their own.
local function HeadsSig()
  if not shared.Heads then return "", "" end
  local h, party, log = shared.Heads()
  local out, quest = {}, ""
  if h.quest and h.quest > 0 then
    -- (a game that does not say how far a quest has got: your quest log as a whole, as it was before)
    quest = "q" .. h.quest .. "." .. (h.qsaid and (h.qstate .. "." .. h.qdone) or ("log" .. tostring(log or 0)))
    out[1] = quest
  end
  -- (a ghost: with your body's place as the game gives it - or without, where it gives none)
  if h.corpse.on then out[#out + 1] = "c" elseif h.ghost then out[#out + 1] = "ghost" end
  if h.guide.on then out[#out + 1] = "g" .. h.guide.map .. "," .. floor(h.guide.north + 0.5) .. "," .. floor(h.guide.west + 0.5) end
  for i = 1, #party do
    if party[i].flags ~= 0 then out[#out + 1] = "p" .. i end
  end
  return table.concat(out, " "), quest
end

-- What the game knows to be over is taken off at once: the route to a quest you no longer
-- track, to your body once you live, to someone who has left your party. And the route to the
-- quest you track, once you track another or have got further with it: that way may lead to
-- where there is nothing left for you to do. It is not shown again until the 3D map has said
-- which way it is now (asked for in a moment: see Scan).
-- @param quest  the words about the quest you track, as they are now (see HeadsSig)
local questWas = nil
local function Prune(quest)
  local stale = questWas ~= nil and quest ~= questWas
  local same = stale and string.match(quest, "^q%d+") == string.match(questWas, "^q%d+")
  questWas = quest
  if not shared.Heads or not others[1] then return end
  local h, party = shared.Heads()
  local kept, changed = {}, false
  for _, o in ipairs(others) do
    local gone = (o.key == "quest" and not (h.quest and h.quest > 0)) or (o.key == "death" and not h.corpse.on and not h.ghost) or (o.key == "guide" and not h.guide.on)
    local slot = tonumber(string.match(o.key, "^ally(%d)$") or "")
    if slot and party[slot] and party[slot].flags == 0 then gone = true end
    if gone then
      changed = true
    elseif o.key == "quest" and stale and o.state == "route" then
      kept[#kept + 1] = NoRoute("quest", "pending", same and o.head or nil, o.rc, nil)
      changed = true
      shared.Log("the quest you track has moved on: its route is put aside until the 3D map says the way now")
    else
      kept[#kept + 1] = o
    end
  end
  if changed then
    others = kept
    rev = rev + 1
  end
end

-- ---- where you have been ----------------------------------------------------------------------
-- The last minute of your steps. How far you have gone since you stood at a spot says how far
-- along a route that begins there you can be.
local trail = { n = 0, at = 0, total = 0, map = nil, N = {}, W = {}, D = {} }
-- Note where you are now; the yards moved since the last look.
local function Trail(p)
  if trail.map ~= p.map then trail.map, trail.n = p.map, 0 end
  local moved = 0
  if trail.n > 0 then
    moved = sqrt((p.north - trail.N[trail.at]) ^ 2 + (p.west - trail.W[trail.at]) ^ 2)
    if moved < 0.05 then return 0 end -- (standing still: nothing new to remember)
    if moved > LEAP then trail.n = 0 end -- (not walked: what came before says nothing of now)
  end
  trail.total = trail.total + moved
  local i = trail.at % TRAIL + 1
  trail.N[i], trail.W[i], trail.D[i], trail.at = p.north, p.west, trail.total, i
  if trail.n < TRAIL then trail.n = trail.n + 1 end
  return moved
end
-- How far you have gone since you last stood at a spot (nil: you have not, in what is remembered).
local function Since(north, west)
  for j = 0, trail.n - 1 do
    local k = (trail.at - 1 - j) % TRAIL + 1
    if (trail.N[k] - north) ^ 2 + (trail.W[k] - west) ^ 2 <= 16 then return trail.total - trail.D[k] end
  end
  return nil
end

-- ---- your place on the route ------------------------------------------------------------------
-- The spot of the route nearest to you among its pieces from..to, and of those only what lies
-- between lo and hi yards along it (all of it when lo is nil): the piece, its distance squared,
-- the spot, and how far along the route that is. On a flight path only the flights of the route
-- count, and off one only the rest: which of the two you are on, the game does say.
local function Seek(r, north, west, taxi, lo, hi, from, to)
  local X, Y, K, C = r.X, r.Y, r.K, r.C
  local best, bestD, bn, bw, ba = nil, huge, nil, nil, nil
  for i = from, to do
    local k = K[i + 1]
    if k < BREAK and (k == 3) == taxi and (not lo or (C[i + 1] >= lo and C[i] <= hi)) then
      local ax, ay = X[i], Y[i]
      local dx, dy = X[i + 1] - ax, Y[i + 1] - ay
      local len2, len = dx * dx + dy * dy, C[i + 1] - C[i]
      local t = len2 > 0 and ((north - ax) * dx + (west - ay) * dy) / len2 or 0
      local t0, t1 = 0, 1
      if lo and len > 0 then
        t0, t1 = (lo - C[i]) / len, (hi - C[i]) / len
        if t0 < 0 then t0 = 0 end
        if t1 > 1 then t1 = 1 end
      end
      if t < t0 then t = t0 elseif t > t1 then t = t1 end
      local qx, qy = ax + dx * t, ay + dy * t
      local d = (north - qx) ^ 2 + (west - qy) ^ 2
      if d < bestD then best, bestD, bn, bw, ba = i, d, qx, qy, C[i] + len * t end
    end
  end
  return best, bestD, bn, bw, ba
end

-- With nothing to say where you were on it: of the spots of the route about as near to you as
-- the nearest, the earliest. (Under the end of a route that begins beside you, you are at its
-- beginning.)
local function First(r, north, west, taxi)
  local g, gD = Seek(r, north, west, taxi, nil, nil, 1, r.n - 1)
  if not g then return nil, huge end
  local limit = (sqrt(gD) + 5) ^ 2
  for i = 1, g do
    local b, d, bn, bw, ba = Seek(r, north, west, taxi, nil, nil, i, i)
    if b and d <= limit then return b, d, bn, bw, ba end
  end
  return Seek(r, north, west, taxi, nil, nil, g, g)
end

-- How high the route runs at a spot on one of its pieces.
local function HeightAt(r, i, along)
  local a, b = r.C[i], r.C[i + 1]
  local t = b > a and (along - a) / (b - a) or 0
  if t < 0 then t = 0 elseif t > 1 then t = 1 end
  return r.Z[i] + (r.Z[i + 1] - r.Z[i]) * t
end

-- You are no longer where the route was being followed, and near another part of it (piece g).
-- Are you on that part? From above there is no telling a floor from the one over it: yes where
-- the 3D map found no other level over or under that part, or where it runs on the level you were
-- last known to be on; anywhere else it is not for the addon to say.
local function Plausible(r, at, along, g, ga)
  if not r.tall then return false end
  if not (r.A[g] or r.A[g + 1]) then return true end
  if not at then return false end
  return math.abs(HeightAt(r, at, along) - HeightAt(r, g, ga)) <= LEVEL
end

-- How many parts of the route pass within reach of you (one above the other counts as two).
local function Parts(r, north, west, taxi, reach)
  local count, last = 0, nil
  for i = 1, r.n - 1 do
    local b, d = Seek(r, north, west, taxi, nil, nil, i, i)
    if b and d < reach * reach then
      if not last or r.C[i] - last > APART then count = count + 1 end
      last = r.C[i + 1]
    end
  end
  return count
end

-- Where you are on the route: r.at (the piece), r.sn r.sw (the spot on it), r.along (yards from
-- its start), r.off (yards you are from that spot), r.doubt (see above). Followed from where you
-- were on it, no further on or back than you have moved since.
local function Progress(r, p, moved)
  local north, west = p.north, p.west
  local taxi = floor((p.flags or 0) / F_TAXI) % 2 == 1
  local last = r.n - 1
  local best, bestD, bn, bw, ba
  if not r.fixed then
    -- the first look. A route begins where you stood when it was worked out, a few seconds ago:
    -- you are no further along it than you have gone since.
    r.fixed = true
    local gone = Since(r.X[1], r.Y[1])
    if gone then best, bestD, bn, bw, ba = Seek(r, north, west, taxi, 0, gone * PACE + AHEAD + BACK, 1, last) end
    if not best then best, bestD, bn, bw, ba = First(r, north, west, taxi) end
  else
    local step = moved <= LEAP and moved or 0
    best, bestD, bn, bw, ba = Seek(r, north, west, taxi, r.along - BACK - step * PACE, r.along + AHEAD + step * PACE, 1, last)
  end
  local off = best and sqrt(bestD) or huge
  local doubt = false
  if off > ON then
    -- not there any more. Somewhere else on the route (a corner cut, a part of it skipped)?
    local g, gD, gn, gw, ga = Seek(r, north, west, taxi, nil, nil, 1, last)
    if g and gD < REJOIN * REJOIN and sqrt(gD) + 4 < off then
      -- (trust: the 3D map has just said that you are on this route, and only one part of it is near)
      if Plausible(r, best or (r.sn and r.at), ba or r.along, g, ga) or (r.trust and Parts(r, north, west, taxi, ON) == 1) then
        best, bestD, bn, bw, ba, off = g, gD, gn, gw, ga, sqrt(gD)
      else
        doubt = true
      end
    end
  end
  r.trust, r.doubt = nil, doubt
  if best then
    if best ~= r.at or bn ~= r.sn or bw ~= r.sw then
      r.at, r.sn, r.sw, r.along = best, bn, bw, ba
      r.moved = (r.moved or 0) + 1
    end
    r.off = off
  else
    r.off = r.sn and sqrt((north - r.sn) ^ 2 + (west - r.sw) ^ 2) or 9999
  end
  return r.off
end

-- At the end of the route: on its last few yards, where it runs on the level it ends on.
local function AtEnd(r)
  if not r.fixed or r.doubt or r.off > ON then return false end
  if r.C[r.n] - r.along > ARRIVE then return false end
  return not r.tall or math.abs(HeightAt(r, r.at, r.along) - r.Z[r.n]) <= LEVEL
end

-- Which step of the journey you are on: the first whose line still lies ahead of you. At the end
-- of a walk the next thing is what you are on if it is not a walk: a flight (you are at the
-- flight master), or something with nothing drawn here (a boat, a portal). Off a flight, the
-- walk that follows. And a step with nothing drawn that begins the journey (a hearthstone) is
-- the one you are on while you are nowhere near the line.
local function StepNow(r)
  local steps = r.steps
  local count = #steps
  if count == 0 then r.cur = 0 return end
  local on = nil
  if not r.bare then
    for i = 1, count do
      local to = steps[i].to
      if to and r.at < to then on = i break end
    end
    if not on then
      for i = count, 1, -1 do
        if steps[i].to then on = i break end
      end
    end
  end
  local cur = on or 1
  if on then
    -- (nowhere near the line, and something with nothing drawn - a hearthstone - comes before
    -- this part of it: that is still to do, however near the end of a walk the nearest spot of
    -- the line happens to be. From Dun Morogh, the walk to Stormwind's flight master ends at
    -- its end of the line nearest to you: that is not standing at the flight master.)
    local before = nil
    if r.off > STRAY * 2 then
      for i = 1, on - 1 do
        if not steps[i].to then before = i break end
      end
    end
    local following = steps[on + 1]
    local taxi = floor((shared.player.flags or 0) / F_TAXI) % 2 == 1
    if before then
      cur = before
    elseif following and r.C[steps[on].to] - r.along < NEXT_AT and (not following.to or following.fly or (steps[on].fly and not taxi)) then
      cur = on + 1
    end
  end
  r.cur = cur
end

local function Matches(m, t)
  return m.tm == t.map and m.tx == t.x and m.ty == t.y
end

-- This waypoint has no route to draw just now (said once). It is asked about again when you
-- have moved a good way - and by itself after a while, a little later each time: the 3D map may
-- only have needed longer (a long journey takes it a while to work out; from a boat it plans
-- nothing until you land), and it cannot say so unasked. One mailbox a look.
local again = { tm = nil, tx = nil, ty = nil, hold = AGAIN }
local function GiveUp(t, why)
  local p = shared.player
  if again.tm == t.map and again.tx == t.x and again.ty == t.y then
    again.hold = math.min(again.hold * 2, AGAIN_MAX)
  else
    again.tm, again.tx, again.ty, again.hold = t.map, t.x, t.y, AGAIN
  end
  want, gave = nil, { tm = t.map, tx = t.x, ty = t.y, north = p.world and p.north or nil, west = p.world and p.west or nil, again = GetTime() + again.hold }
  note = why
  shared.Log("gave up on this waypoint for " .. again.hold .. " s: " .. tostring(why))
end
local saidAt = -1000
local function Remind(now, msg, every)
  if now - saidAt < every then return end
  saidAt = now
  say(msg)
end

-- ---- being there ------------------------------------------------------------------------------
-- How far you are (yards, squared) from where a waypoint is reached: the end of its route when
-- that is known (a pin on a roof is walked to at the nearest place you can stand), else its own spot.
local function Away(t, ex, ey)
  local p, r = shared.player, route
  if not ex and r and Matches(r, t) then
    if not r.bare then ex, ey = r.X[r.n], r.Y[r.n] else ex, ey = r.ex, r.ey end
  end
  if not (ex and ey) then ex, ey = t.x / 128 - 32768, t.y / 128 - 32768 end
  return (p.north - ex) ^ 2 + (p.west - ey) ^ 2
end

-- Standing at a waypoint's spot on the map is not being at it: it may be on the floor above, or
-- on the bridge overhead. With its route drawn you are there at the end of that route, on the
-- level it ends on. With nothing drawn to go by, when the 3D map has not said otherwise.
local function Reached(t)
  local r = route
  if r and Matches(r, t) then
    if not r.bare then return AtEnd(r) end
    return r.there ~= false
  end
  -- (its route is still on the way: that will tell - unless nobody is writing routes at all)
  if want and want.why == "target" and GetTime() >= quietUntil then return false end
  return true
end

-- For the guide (GuideSources.lua): are you at the spot its step names - a place `reach` yards
-- wide at map, north, west? true or false when the route in the game can tell: you are there on
-- the last yards of the route to it, on the level it ends on. nil when there is nothing to tell
-- by (another waypoint leads, or the 3D map is not sending routes): the map alone decides then.
function shared.There(reach, map, north, west)
  local t, r = shared.target, route
  if t.kind ~= W_GUIDE or t.map ~= map then return nil end
  if math.abs(t.x / 128 - 32768 - north) > 0.02 or math.abs(t.y / 128 - 32768 - west) > 0.02 then return nil end
  if r and Matches(r, t) then
    if r.bare then return r.there end
    if not r.fixed or r.doubt or r.off > ON then return false end
    local left = r.C[r.n] - r.along
    if left > math.max(ARRIVE, reach or 0) then return false end
    if not r.tall or math.abs(HeightAt(r, r.at, r.along) - r.Z[r.n]) <= LEVEL then return true end
    -- A wide spot, and you are within it but further off than a few yards: the ground may simply
    -- slope. You are there unless another level lies over or under what is left of the way.
    if left <= ARRIVE then return false end
    for i = r.at, r.n do
      if r.A[i] then return false end
    end
    return true
  end
  if gave and Matches(gave, t) then return nil end
  -- (no delivery can come: the mailboxes are not installed, or are all used until the next /reload)
  if mail.counted and mail.next > mail.size then return nil end
  if want and want.why == "target" and GetTime() >= quietUntil then return false end
  return nil
end

-- A waypoint you have reached is taken off the map.
local function Arrive(t)
  pin.far = false
  shared.Log("arrived: the waypoint (kind " .. tostring(t.kind) .. ") is taken off")
  if t.kind == W_QUICK then
    if shared.QuickOff then shared.QuickOff() end
  elseif t.kind == W_PIN then
    if C_Map and C_Map.ClearUserWaypoint then pcall(C_Map.ClearUserWaypoint) end
    if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, false) end
  end
end

-- The marker dropped on the 3D map is your waypoint here too: there is one waypoint of your own,
-- wherever it was placed. A delivery names the marker (a number that is new with each one,
-- where it is, when it was dropped), and one not seen before is taken up as a quick waypoint -
-- unless the waypoint you have here was placed after it. Word that it has been taken off the
-- 3D map lets go of the waypoint here, unless that was placed since.
local mark = { stamp = nil }
local function Marker(m)
  local k = m.mk
  if type(k) ~= "table" then return end
  local stamp = tonumber(k[1])
  if not stamp then return end
  local db = type(AzerothAtlasCharDB) == "table" and AzerothAtlasCharDB or nil
  if mark.stamp == nil and db then mark.stamp = tonumber(db.mark) end
  if stamp == mark.stamp then return end
  mark.stamp = stamp
  if db then db.mark = stamp end
  -- (when it happened, by this game's clock: the delivery says how long before it was written)
  local at = GetTime() - math.max(0, (tonumber(m.at) or 0) - (tonumber(k[5]) or 0))
  local own = shared.OwnAt and shared.OwnAt()
  if own and own >= at then return end
  local map, north, west = tonumber(k[2]), tonumber(k[3]), tonumber(k[4])
  if map and north and west then
    shared.Log("the marker dropped on the 3D map is taken up as the waypoint: map " .. map .. " " .. floor(north) .. " " .. floor(west))
    if shared.Quick then shared.Quick(map, north, west, at) end
  elseif own and shared.OwnOff then
    shared.Log("the marker was taken off the 3D map: the waypoint here is let go of")
    shared.OwnOff()
  end
end

-- A mailbox is due: open it and see what the 3D map says.
local function Fetch(now)
  local t, w = shared.target, want
  local m, why = Open(now)
  -- (side: asked for the sake of the other routes, not of the waypoint you have)
  local side = w.why == "heads" or w.why == "wander" or w.why == "hearth"
  shared.Log("opened mailbox " .. (mail.next - 1) .. " for " .. tostring(w.why) .. " (try " .. tostring(w.tries) .. "): " .. (m and Told(m) .. ", written " .. (time() - (tonumber(m.at) or 0)) .. " s ago" or "nothing (" .. tostring(why) .. ")"))
  if not m then
    if side then
      want, othersDue = nil, nil
      if why == "used" and mail.size > 0 then
        note = "every route delivery of this login has been used: type /reload to have them all again"
        Remind(now, note, 120)
      end
    elseif why == "used" and mail.size > 0 then
      GiveUp(t, "every route delivery of this login has been used: type /reload to have them all again")
      Remind(now, note, 120)
    elseif why == "used" then
      GiveUp(t, "the route mailboxes are not installed: press Update addon on the 3D map's page, then restart the game")
      if w.why == "asked" then say(note) end
    else
      GiveUp(t, "a route delivery could not be read (" .. why .. ")")
      if w.why == "asked" then say(note) end
    end
    return
  end
  local age = time() - (tonumber(m.at) or 0)
  if age > LATE or age < -LATE then
    -- nobody is writing them: the 3D map is not running, or its page is not open
    quietUntil, quietFor = now + quietFor, math.min(quietFor * 2, QUIET_MAX)
    note = "the 3D map is not sending routes: is Azeroth Atlas running, and does it show where you are? (Its window need not be in view.)"
    if w.why == "asked" then say(note) end
    want = nil
    return
  end
  quietUntil, quietFor = -1, QUIET
  shared.Try("marker", Marker, m)
  -- the other routes there are, whatever else this delivery is about
  TakeOthers(m, now)
  -- (your hearthstone was switched on or off a moment ago: a route worked out before that will not do)
  local old = m.hs ~= nil and now - hearthAt < HEARTH_FOR and ((tonumber(m.hs) or 0) == 1) ~= (shared.HearthOff ~= nil and shared.HearthOff() == true)
  if Matches(m, t) then pin.asked = now end
  -- (the 3D map follows how high you are: when it says you are at the waypoint, on its level, you are)
  if (t.kind == W_PIN or t.kind == W_QUICK) and Matches(m, t) and m.there == true and pin.far
    and shared.player.world and shared.player.map == t.map and Away(t, tonumber(m.ex), tonumber(m.ey)) < ARRIVE * ARRIVE then
    Arrive(t)
    want = nil
    return
  end
  if side then
    if old then
      w.tries = w.tries + 1
      local wait = RETRY[w.tries]
      if wait then w.at = now + wait else want = nil end
      return
    end
    -- (the waypoint you have: its route as it is now, if this is it)
    if t.kind ~= 0 and Matches(m, t) and m.state == "route" and not (route and route.plan == tonumber(m.plan)) then
      if Adopt(m) then
        gave, note = nil, nil
        again.tm = nil
      end
    end
    if w.why == "wander" then
      -- Off the route you follow. The next such look is not for a while, and for longer each
      -- time while you stay off it: someone roaming about - after a quest's creatures, say,
      -- whose route moves with every one of them - would otherwise be through a login's
      -- mailboxes within the hour. Back on a route for a little, and it is prompt again (Scan).
      strayHold, wanderHold = now + wanderHold, math.min(wanderHold * 2, WANDER_HOLD_MAX)
    end
    want = nil
    return
  end
  if w.why == "asked" and t.kind == 0 then
    -- no waypoint in the game: whatever the 3D map is showing (a marker dropped on it)
    if m.state == "route" and Adopt(m) then
      note = nil
    else
      Drop()
      -- (nothing of its own to show, but routes to the other places there are: nothing to be said)
      note = type(m.text) == "string" and m.text or "the 3D map has no route to show"
      if not others[1] then say(note) end
    end
    want = nil
    return
  end
  local ready = Matches(m, t) and m.state == "route" and not old
  if w.why == "level" then
    -- (you chose another level: only the route to that one will do; a marker on the 3D map has no waypoint in the game to match)
    if t.kind == 0 then ready = m.state == "route" and (tonumber(m.tk) or 0) == 0 end
    ready = ready and type(m.lv) == "table" and tonumber(m.lv.at) == w.index
  end
  if ready then
    -- (off the route, and the 3D map has nothing newer: no point in looking again for a while)
    local kept = (w.why == "stray" or w.why == "near") and route and route.plan == tonumber(m.plan)
    if kept then
      if w.why == "stray" then strayHold = now + STRAY_HOLD end
      local p = shared.player
      if route.bare and p.world then route.bornMap, route.bornN, route.bornW = p.map, p.north, p.west end
      -- (what the 3D map knows meanwhile: you are on this route - then a doubt about which part is settled if only one is near - and at its end or not)
      route.trust = m.sure == true or nil
      if m.there == true then route.there = true elseif m.there == false then route.there = false end
      -- (the other routes are as the 3D map has them now)
      route.more, route.rc = type(m.rs) == "table" and {} or More(m), tonumber(m.rc)
      if type(m.hd) == "string" then route.head = m.hd end
      rev = rev + 1
    end
    if kept or Adopt(m) then
      want, gave, note = nil, nil, nil
      again.tm = nil
    else
      -- a way there with nothing to draw on this map (a hearthstone, a flight from where you stand)
      Drop()
      GiveUp(t, type(m.text) == "string" and m.text or "the route has nothing to draw here")
      if type(m.text) == "string" then say(m.text) end
    end
  elseif Matches(m, t) and m.state == "none" and not old then
    Drop()
    GiveUp(t, type(m.text) == "string" and m.text or "the 3D map found no way there")
  elseif w.why == "near" then
    want = nil -- (only a question: no looking again)
  else
    -- not worked out yet, or still about your last waypoint: look again a little later
    -- (once: this was the one more look after giving up - the next comes after a longer while)
    w.tries = w.tries + 1
    local wait = not w.once and RETRY[w.tries] or nil
    if wait then
      w.at = now + wait
    elseif w.why == "stray" or w.why == "level" then
      want = nil
    else
      GiveUp(t, "the 3D map has not worked a route out yet: it is asked again in a while (/atlas route asks now)")
      if w.why == "asked" then say(note) end
    end
  end
end

-- For the addon's notes: how things stand - the route that leads, what is still wanted, the
-- other routes - in a few words. Noted after each mailbox, so that what was made of it shows.
local function Stands(now)
  local out = route and ("route plan " .. tostring(route.plan) .. (route.bare and " (nothing to draw here)" or (" of " .. tostring(route.n) .. " points"))) or "no route"
  if want then out = out .. "; wanted for " .. tostring(want.why) .. " in " .. format("%.1f", math.max(0, want.at - now)) .. " s" end
  if gave then out = out .. "; given up (" .. tostring(note) .. ")" end
  if now < quietUntil then out = out .. "; the 3D map is not heard from, left alone for " .. floor(quietUntil - now) .. " s" end
  for _, o in ipairs(others) do out = out .. "; " .. tostring(o.key) .. " " .. tostring(o.state) .. (o.state == "route" and (" plan " .. tostring(o.plan)) or "") end
  if othersDue then out = out .. "; the others asked for again in " .. format("%.1f", math.max(0, othersDue - now)) .. " s" end
  return out
end

local EnsureMap, EnsureMini -- (below)

-- Five times a second, after the waypoint has been read (called by AzerothAtlas.lua).
function shared.Scan(now)
  if not mail.counted then Count() end
  local t, p = shared.target, shared.player
  local moved = p.world and Trail(p) or 0
  -- (noted when it is another waypoint: what the game heads for - kind 1 your guide's step, 3 a pin, 4 a quick one, 0 nothing)
  local heading = t.kind .. ":" .. t.map .. ":" .. t.x .. ":" .. t.y
  if heading ~= shared.headingSaid then
    shared.headingSaid = heading
    shared.Log(t.kind == 0 and "waypoint: none" or ("waypoint: kind " .. t.kind .. " map " .. t.map .. " at " .. floor(t.x / 128 - 32768) .. " " .. floor(t.y / 128 - 32768)))
  end

  if t.kind == 0 then
    -- nothing to head for in the game: only a route you asked for by hand stays
    if route and route.tk ~= 0 then Drop() end
    if want and (want.why == "target" or want.why == "stray" or want.why == "near" or want.why == "level") then want = nil end
    gave = nil
  else
    local same = route and Matches(route, t)
    if not same then
      Drop() -- a route to somewhere else is worse than none
      if gave and not Matches(gave, t) then gave = nil end
      if gave and gave.north and p.world and (p.north - gave.north) ^ 2 + (p.west - gave.west) ^ 2 > MOVED * MOVED then gave = nil end
      -- (given up a while ago: one more look - the 3D map may have the route by now)
      local once = false
      if gave and gave.again and now >= gave.again and now >= quietUntil then gave, once = nil, true end
      if not gave and not (want and Matches(want, t)) then
        want = { why = "target", tm = t.map, tx = t.x, ty = t.y, tries = 0, at = once and now or now + FIRST_WAIT, once = once }
      end
    elseif want and want.why == "target" then
      want = nil
    end
  end

  -- What else you could be heading for has changed: the routes there are asked for, once the 3D
  -- map has had a moment to work them out. (Not from an older 3D map, which sends no such routes.)
  local sig, quest = HeadsSig()
  if sig ~= headsSig then
    local first = headsSig == nil
    shared.Log("what you could head for: " .. (sig == "" and "nothing" or sig) .. (first and "" or (" (it was: " .. (headsSig == "" and "nothing" or headsSig) .. ")")))
    headsSig = sig
    Prune(quest)
    if othersSaid ~= false and (sig ~= "" or others[1]) and not (first and sig == "") then
      othersDue, othersTries = now + HEADS_WAIT, 0
    end
  end
  if hearthDue and now >= hearthDue and not want then
    hearthDue = nil
    want = { why = "hearth", tm = 0, tx = 0, ty = 0, tries = 0, at = now }
  end
  if othersDue and now >= othersDue and not want and now >= quietUntil then
    othersDue = nil
    want = { why = "heads", tm = 0, tx = 0, ty = 0, tries = 0, at = now }
  end

  -- on the route? (also finds how far along it you are, for the drawing)
  local astray = false
  if route and p.world then
    if route.bare then
      -- nothing drawn to be on or off: a newer plan once you have moved on (the hearthstone used, the boat landed)
      astray = t.kind ~= 0 and (p.map ~= route.bornMap or not route.bornN or (p.north - route.bornN) ^ 2 + (p.west - route.bornW) ^ 2 > BARE_MOVED * BARE_MOVED)
    elseif p.map == route.map then
      -- (in doubt which part of it you are on - one lies over another here - is a question for the 3D map as well)
      astray = (Progress(route, p, moved) > STRAY or route.doubt) and t.kind ~= 0 and not route.detached
    else
      -- on another map than the route (off a boat, through a portal): the 3D map plans from where you are now
      astray = t.kind ~= 0
    end
  end
  -- The other routes: your place on each. With no route that leads, the first of them is the
  -- one you follow (lone), and leaving that one is what a newer delivery is fetched for.
  local lone = Lone()
  local _, party = nil, nil
  if shared.Heads then _, party = shared.Heads() end
  for _, o in ipairs(others) do
    if o.state == "route" then
      if p.world and not o.bare and p.map == o.map then Progress(o, p, moved) end
      StepNow(o)
      -- The way to someone in your party is only as good as where they were when it was worked
      -- out, and nothing is fetched for their sake. The game does know where they are now: once
      -- they have gone from where the route ends (or cannot be seen), it is no longer shown.
      local slot = tonumber(string.match(o.key, "^ally(%d)$") or "")
      if slot then
        local m = party and party[slot]
        local gone = not (m and m.flags % 4 >= 2 and o.n >= 2
          and (o.X[o.n] - (m.x / 16 - 32768)) ^ 2 + (o.Y[o.n] - (m.y / 16 - 32768)) ^ 2 <= ALLY_NEAR * ALLY_NEAR)
        if gone ~= (o.gone == true) then
          o.gone = gone
          rev = rev + 1
        end
      end
    end
  end
  if lone and p.world then
    -- (a journey that begins with your hearthstone has its line at the inn, far from where you
    -- stand: like one with nothing to draw here, it is left when you have gone from where you
    -- stood when it came - by the stone, or on foot - and not for being far from its line)
    if lone.bare or lone.inn then
      astray = p.map ~= lone.bornMap or not lone.bornN or (p.north - lone.bornN) ^ 2 + (p.west - lone.bornW) ^ 2 > BARE_MOVED * BARE_MOVED
    elseif p.map == lone.map then
      astray = lone.off > STRAY
    else
      astray = true
    end
    -- (on it for a while: you are following it, and a newer one is fetched as promptly as ever
    -- when you leave it. Roaming about with no mind to it - see Fetch - the looks thin out.)
    if astray then
      loneOn = nil
    else
      loneOn = loneOn or now
      if now - loneOn >= WANDER_BACK then wanderHold = WANDER_HOLD end
    end
  end
  if astray then
    offSince = offSince or now
    if not want and now - offSince >= STRAY_FOR and now - mail.at >= STRAY_GAP and now >= strayHold then
      want = { why = lone and "wander" or "stray", tm = t.map, tx = t.x, ty = t.y, tries = 0, at = now, key = lone and lone.key or nil }
    end
  else
    offSince = nil
  end
  if route then StepNow(route) end

  if want and now >= want.at and (want.why == "asked" or now >= quietUntil) then
    Fetch(now)
    shared.Log("  so: " .. Stands(now))
  end

  -- a pin on the game's map, or a quick waypoint, that you have reached has done its work
  if (t.kind == W_PIN or t.kind == W_QUICK) and p.world and p.map == t.map then
    if pin.x ~= t.x or pin.y ~= t.y then pin.x, pin.y, pin.far, pin.near, pin.asked, pin.hold = t.x, t.y, false, nil, nil, NEAR_HOLD end
    local d = Away(t)
    if d > DEPART * DEPART then
      pin.far, pin.near = true, nil
    elseif d < ARRIVE * ARRIVE and pin.far then
      if Reached(t) then
        Arrive(t)
      elseif route and Matches(route, t) then
        -- At its spot on the map, and the route says not at it: as it should be under the waypoint,
        -- or over it. But the addon follows only your steps and the 3D map your height as well, so
        -- once in a while it is asked whether you are there after all.
        pin.near = pin.near or now
        if not want and now >= quietUntil and now - pin.near >= NEAR_FOR and now - (pin.asked or -1000) >= pin.hold then
          pin.hold = math.min(pin.hold * 2, NEAR_HOLD_MAX)
          want = { why = "near", tm = t.map, tx = t.x, ty = t.y, tries = 0, at = now }
        end
      end
    else
      pin.near = nil
    end
  end

  -- (the map and the minimap also mark a waypoint whose route is still on its way)
  if route or t.kind ~= 0 or others[1] then
    EnsureMap()
    EnsureMini()
  end
  -- the arrow, the step list and the question about the level (Guide.lua)
  if shared.GuideScan then shared.Try("guide", shared.GuideScan, now) end
end

-- ---- the level you chose --------------------------------------------------------------------
-- Told to the 3D map through the strip (which list of levels, which of them, and a number that
-- goes up with every choice), for a minute so that it is sure to arrive; the route to that level
-- then comes in as any other does.
local choice = { id = 0, index = 0, seq = 0, at = -1000 }
function shared.Choose(i)
  local lv = route and route.lv
  if not lv or not lv.list[i] then return false end
  local now = GetTime()
  choice.id, choice.index, choice.seq, choice.at = lv.id, i, choice.seq % 250 + 1, now
  if shared.Tell then shared.Tell() end
  if i ~= lv.at then
    lv.at = i
    local t = shared.target
    want = { why = "level", tm = t.map, tx = t.x, ty = t.y, tries = 0, at = now + LEVEL_WAIT, index = i }
    rev = rev + 1
  end
  return true
end
function shared.ChoiceReport()
  if choice.index == 0 or GetTime() - choice.at > 60 then return nil end
  -- (with which /reload this is: the choices are numbered from one again after each)
  return strchar(floor(choice.id / 256) % 256, choice.id % 256, choice.index, choice.seq, 1, mail.session % 256)
end

-- The route as it is now, and a number that changes whenever it does (for Guide.lua).
function shared.Route() return route, rev end
-- All of them: the one that leads (nil when none does), the others, and that number.
function shared.Routes() return route, others, rev end
-- The one you follow - the arrow points along it: the one that leads, or where the game has no
-- waypoint at all, the first of the others.
function shared.Follow()
  return route or Lone()
end

-- For the list of routes: why the waypoint you have has no route yet, in a few words (nil: it
-- has one, or you have no waypoint).
function shared.Waiting()
  local t = shared.target
  if t.kind == 0 or (route and Matches(route, t)) then return nil end
  if mail.counted and mail.size == 0 then return "The route mailboxes are not installed: press Check for updates in Azeroth Atlas, then restart the game." end
  if mail.counted and mail.next > mail.size then return "Type /reload to go on seeing routes (this login's deliveries are used up)." end
  if GetTime() < quietUntil then return "Azeroth Atlas is not answering: is it running, and does it show where you are?" end
  if gave and Matches(gave, t) then
    if not note then return "No route." end
    return string.upper(string.sub(note, 1, 1)) .. string.sub(note, 2)
  end
  return "Working out the route..."
end

-- Your hearthstone has been switched on or off (the button by "Routes": Guide.lua). The 3D map
-- hears of it through the strip and works every route out again; those are then fetched.
function shared.HearthChanged()
  local now = GetTime()
  hearthAt = now
  if route or others[1] or shared.target.kind ~= 0 then hearthDue = now + HEADS_WAIT end
  shared.Log("hearthstone switched: the routes are asked for anew" .. (hearthDue and "" or " (there are none just now)"))
end

-- For the server (9 bytes, on the text channel): which /reload this is, the mailbox that will
-- be opened next, how many there are, the delivery last read, and what is going on.
function shared.MailReport()
  if not mail.counted then return nil end
  local flags = ((route or others[1]) and 1 or 0) + (want and 2 or 0) + (gave and 4 or 0) + (GetTime() < quietUntil and 8 or 0)
  local function two(v) return strchar(floor(v / 256) % 256, v % 256) end
  return strchar(mail.session) .. two(mail.next) .. two(mail.size) .. two(mail.have) .. strchar(flags) .. strchar(1)
end

-- ---- what you can tell it -------------------------------------------------------------------
-- Clearing: a waypoint of your own is taken away, and nothing else - your guide's step, if it
-- is on one, leads again. With no waypoint of your own it is the guide's route that is cleared,
-- until the guide moves on.
function shared.Clear()
  local t = shared.target
  local own = t.kind == W_PIN or t.kind == W_QUICK
  if t.kind == W_PIN then
    if C_Map and C_Map.ClearUserWaypoint then pcall(C_Map.ClearUserWaypoint) end
    if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then pcall(C_SuperTrack.SetSuperTrackedUserWaypoint, false) end
  end
  if shared.QuickOff then shared.QuickOff() end
  if not own and shared.ClearHeading then shared.ClearHeading() end
  Drop()
  want, gave, note = nil, nil, nil
  shared.Log(own and "cleared: your own waypoint" or "cleared: the route")
  if own then say("waypoint cleared.")
  else say("route cleared. A new guide step, or a Shift-click or Ctrl-click on the map, starts another.") end
end

function shared.Ask()
  if not mail.counted then Count() end
  local t = shared.target
  gave = nil
  want = { why = "asked", tm = t.map, tx = t.x, ty = t.y, tries = 0, at = GetTime() }
end

local function Status()
  if not mail.counted then Count() end
  if mail.size == 0 then
    say("the route mailboxes are not installed. Press Update addon on the 3D map's page, then restart the game.")
    return
  end
  say(format("route deliveries: %d of %d left until the next /reload (%d opened).", math.max(0, mail.size - mail.next + 1), mail.size, mail.opened))
  if route and route.bare then
    say("the journey has nothing to draw on this map" .. (route.steps[route.cur] and (": " .. route.steps[route.cur].text) or "") .. ".")
  elseif route then
    say(format("showing a route of %d points, %d yd%s.", route.n, floor(route.C[route.n] - (route.C[route.at] or 0) + 0.5), route.name and (" to " .. route.name) or ""))
  elseif want then
    say("waiting for the 3D map's route.")
  else
    say(note or (shared.target.kind == 0 and "no waypoint: a guide step, or a Shift-click or Ctrl-click on the map, sets one." or "no route."))
  end
  if route and route.lv then
    say(format("your waypoint is on level %d of %d there (/atlas level to choose another).", route.lv.at, #route.lv.list))
  end
  if route and route.doubt then
    say("one level lies over another where you are, and the game does not say which you are on: the 3D map is asked.")
  end
  -- the other routes there are
  local shown, working = 0, 0
  for _, o in ipairs(others) do
    if o.state == "route" then shown = shown + 1 elseif o.state == "pending" then working = working + 1 end
  end
  if shown > 0 or working > 0 then
    say(format("%d other route%s shown%s.", shown, shown == 1 and "" or "s", working > 0 and format(", %d still being worked out", working) or ""))
  elseif othersSaid == false then
    say("the 3D map is an older one: update it (Check for updates on its page) to see every route here with its steps.")
  end
  if GetTime() < quietUntil then
    say("Azeroth Atlas is not answering. It has to be running for routes to come in (its window can be behind the game, or minimized).")
  end
  if shared.HearthOff and shared.HearthOff() then say("your hearthstone is left out of routes (/atlas hearth, or the button by \"Routes\", brings it back).") end
end

function shared.Command(word, rest)
  if word == "clear" then shared.Clear()
  elseif word == "route" then shared.Ask()
  elseif word == "status" then Status()
  elseif shared.GuideCommand and shared.GuideCommand(word, rest) then return
  elseif shared.GuideWord and shared.GuideWord(word, rest or "") then return
  elseif shared.TransitWord and shared.TransitWord(word, rest or "") then return
  else
    say("/atlas (strip on or off)   /atlas clear   /atlas route   /atlas status   /atlas level   /atlas options   /atlas log (its notes of what it did)")
    say("/atlas arrow, /atlas list (each on or off)   /atlas arrow unlock (drag the arrow with the mouse; /atlas arrow lock when it is there)   /atlas move (drag both where you want them)   /atlas reset")
    say("/atlas pin (the list of routes pinned under Questie's quest list, or free: drag it with the mouse where you want it)   A click on \"Routes\", or on a route's name, folds its steps away.")
    say("/atlas hearth (your hearthstone: used in routes, or left out)   /atlas strip (where the coded strip is: /atlas strip topright 0 40)")
    say("/atlas boats (when the boats, zeppelins and tram leave, as far as known)   /atlas boats listen (other players' sightings: taken or not)")
    say("/atlas guide (which guide addon the route follows: Guidelime or RestedXP)   /atlas guide auto, /atlas guide guidelime, /atlas guide restedxp (set it)")
    say("Shift-click the world map: a quick waypoint.   Ctrl-click: a pin, and you are asked which level where there are several (/atlas ask: asked, or not; /atlas level asks whenever you like).")
    say("/atlas drops (how often a creature drops what your quest wants, after that line of its tooltip: /atlas drops off, /atlas drops on)")
  end
end

-- Keys can be set for these under Options > Keybindings > AddOns (Bindings.xml names the buttons).
BINDING_HEADER_AZEROTHATLAS = "Azeroth Atlas"
_G["BINDING_NAME_CLICK AzerothAtlasClearButton:LeftButton"] = "Clear the route"
_G["BINDING_NAME_CLICK AzerothAtlasFetchButton:LeftButton"] = "Fetch the route from the 3D map"
local function KeyButton(name, run)
  local b = CreateFrame("Button", name, UIParent)
  b:SetSize(1, 1)
  b:Hide()
  b:SetScript("OnClick", function() pcall(run) end)
end
KeyButton("AzerothAtlasClearButton", function() shared.Clear() end)
KeyButton("AzerothAtlasFetchButton", function() shared.Ask() end)

-- ---- drawing --------------------------------------------------------------------------------
-- A stroke is two lines: a dark one underneath so that the coloured one reads on any ground.
local function Strokes(frame)
  return { frame = frame, under = {}, over = {}, used = 0 }
end
local function Stroke(s, anchor, x1, y1, x2, y2, kind, thick, colour)
  local i = s.used + 1
  s.used = i
  local under, over = s.under[i], s.over[i]
  if not under then
    under = s.frame:CreateLine(nil, "BACKGROUND")
    under:SetColorTexture(0, 0, 0, 0.6)
    over = s.frame:CreateLine(nil, "ARTWORK")
    s.under[i], s.over[i] = under, over
  end
  local c = Shade(colour, kind) or COLOUR[kind] or COLOUR[0]
  over:SetColorTexture(c[1], c[2], c[3], 1)
  under:SetThickness(thick * 1.9)
  over:SetThickness(thick)
  under:SetStartPoint(anchor, s.frame, x1, y1)
  under:SetEndPoint(anchor, s.frame, x2, y2)
  over:SetStartPoint(anchor, s.frame, x1, y1)
  over:SetEndPoint(anchor, s.frame, x2, y2)
  under:Show()
  over:Show()
end
local function Finish(s)
  for i = s.used + 1, #s.under do
    s.under[i]:Hide()
    s.over[i]:Hide()
  end
end
-- A broken line from one spot of the canvas to another, in the colour of the hearthstone's
-- line: as much of it as lies on the canvas (W wide, H high, its top left corner the origin and
-- y going down as minus; beyond: the canvas is a stitched map's, which has no edge to cut at).
-- Of a line right across a great map the dashes get longer, not more.
local function Hearth(s, x1, y1, x2, y2, W, H, beyond, unit, thick, colour)
  local dx, dy = x2 - x1, y2 - y1
  local lo, hi = 0, 1
  if not beyond then
    -- (cut at the canvas's four sides: where along the line it comes on, and where it goes off)
    local function side(p, q)
      if p == 0 then return q >= 0 end
      local at = q / p
      if p < 0 then
        if at > hi then return false elseif at > lo then lo = at end
      else
        if at < lo then return false elseif at < hi then hi = at end
      end
      return true
    end
    if not (side(-dx, x1) and side(dx, W - x1) and side(dy, -y1) and side(-dy, H + y1)) then return end
  end
  local len = sqrt(dx * dx + dy * dy) * (hi - lo)
  if len < 2 * unit then return end
  local ax, ay = x1 + dx * lo, y1 + dy * lo
  local ux, uy = dx * (hi - lo) / len, dy * (hi - lo) / len
  local dash, gap = 7 * unit, 5 * unit
  local count = len / (dash + gap)
  if count > 120 then dash, gap = dash * count / 120, gap * count / 120 end
  local at = 0
  while at < len do
    local to = at + dash
    if to > len then to = len end
    Stroke(s, "TOPLEFT", ax + ux * at, ay + uy * at, ax + ux * to, ay + uy * to, HEARTH, thick, colour)
    at = to + gap
  end
end

-- The end of the route: a small diamond.
local function Diamond(parent, button)
  local f = CreateFrame(button and "Button" or "Frame", nil, parent)
  f:SetSize(12, 12)
  local edge = f:CreateTexture(nil, "BACKGROUND")
  edge:SetColorTexture(0, 0, 0, 0.85)
  edge:SetAllPoints(f)
  local fill = f:CreateTexture(nil, "ARTWORK")
  fill:SetColorTexture(1, 0.82, 0.1, 1)
  fill:SetPoint("TOPLEFT", f, "TOPLEFT", 2, -2)
  fill:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -2, 2)
  if edge.SetRotation then
    edge:SetRotation(math.pi / 4)
    fill:SetRotation(math.pi / 4)
  end
  f:Hide()
  return f
end

-- ---- on the world map -----------------------------------------------------------------------
-- A frame over the map's canvas (it scrolls and zooms with the map), redrawn when the map
-- shown, its zoom, the route or your place on it changes.
local onMap = { frame = nil, strokes = nil, goal = nil, sig = "", elapsed = 0, level = 1 }

-- OpenMap (the addon that stitches every zone into one seamless world map) lays the world out on
-- the canvas its own way, and says where a spot of the world is on it through its public API
-- (OpenMapAPI, version 2 and up): nil when it is not installed, or not stitching just now.
local function Stitched()
  local api = OpenMapAPI
  if type(api) ~= "table" or api.major ~= 1 or (tonumber(api.version) or 0) < 2 then return nil end
  if type(api.IsStitched) ~= "function" or type(api.CanvasFromWorldPos) ~= "function" then return nil end
  local ok, on = pcall(api.IsStitched)
  return ok and on == true and api or nil
end

-- Where the world is on the canvas now: six numbers that turn a spot (north, west) into canvas
-- fractions, x = ax * north + bx * west + cx (across) and y likewise (down); and whether the
-- canvas shows the world beyond the 0..1 of its own map. nil when this route is not on the map shown.
local function Projection(uiMap, continent, n, w)
  local api = Stitched()
  if api then
    -- (three spots a thousand yards apart say all there is to know about a flat map)
    local ok0, x0, y0 = pcall(api.CanvasFromWorldPos, continent, n, w)
    local ok1, x1, y1 = pcall(api.CanvasFromWorldPos, continent, n + 1000, w)
    local ok2, x2, y2 = pcall(api.CanvasFromWorldPos, continent, n, w + 1000)
    if ok0 and ok1 and ok2 and type(x0) == "number" and type(y0) == "number" and type(x1) == "number" and type(y1) == "number" and type(x2) == "number" and type(y2) == "number" then
      local ax, bx, ay, by = (x1 - x0) / 1000, (x2 - x0) / 1000, (y1 - y0) / 1000, (y2 - y0) / 1000
      local top = type(api.ArtTopLevel) == "function" and api.ArtTopLevel() or nil
      return ax, bx, x0 - ax * n - bx * w, ay, by, y0 - ay * n - by * w, true, type(top) == "number" and top or nil
    end
    return nil
  end
  -- the game's own map: its corners in the world (north, west), and which continent they are on
  local map, a = C_Map.GetWorldPosFromMapPos(uiMap, CreateVector2D(0, 0))
  local other, b = C_Map.GetWorldPosFromMapPos(uiMap, CreateVector2D(1, 1))
  if not (map and a and b) or map ~= other or map ~= continent then return nil end
  local n0, w0 = a:GetXY()
  local n1, w1 = b:GetXY()
  if n0 == n1 or w0 == w1 then return nil end
  return 0, -1 / (w0 - w1), w0 / (w0 - w1), -1 / (n0 - n1), 0, n0 / (n0 - n1), false, nil
end

local function DrawMap()
  local f, s = onMap.frame, onMap.strokes
  -- (whole: the route with all that came with it; r: its line on your own map, where it has one)
  local whole = route
  local r = whole
  if r and r.n < 2 then r = nil end
  -- (no route yet, or none to draw here: the waypoint itself is marked, so a click on the map is seen to have taken)
  local t = shared.target
  local continent, gn, gw = nil, nil, nil
  if r then continent, gn, gw = r.map, r.X[r.n], r.Y[r.n]
  elseif t.kind ~= 0 then continent, gn, gw = t.map, t.x / 128 - 32768, t.y / 128 - 32768 end
  -- (a journey that goes on elsewhere ends where the waypoint is, not where its line on this map does)
  local gm, mn, mw = continent, gn, gw
  local also = whole and whole.also[1] and whole.also or nil
  if also and whole.em and whole.ex and whole.ey then gm, gn, gw = whole.em, whole.ex, whole.ey end
  local more = whole and whole.more[1] and whole.more or nil
  local rc = whole and whole.rc or nil
  -- (rest: the other routes, where they came whole - TakeOthers; walked: how far you have got on them)
  local rest, walked = others[1] and others or nil, 0
  if rest then
    for _, o in ipairs(rest) do walked = walked + (o.moved or 0) end
  end
  local uiMap = WorldMapFrame:GetMapID()
  local W, H = f:GetWidth(), f:GetHeight()
  -- one screen unit, in the canvas's own units (the canvas is scaled as the map is zoomed)
  local unit = UIParent:GetEffectiveScale() / f:GetEffectiveScale()
  local open = uiMap and W > 0 and H > 0
  local ax, bx, cx, ay, by, cy, beyond, top
  if continent and open then ax, bx, cx, ay, by, cy, beyond, top = Projection(uiMap, continent, mn, mw) end
  -- (where the end is on the canvas: on another continent than your own line, by that continent's place on it)
  local gax, gbx, gcx, gay, gby, gcy, gbeyond, gtop = ax, bx, cx, ay, by, cy, beyond, top
  if gm ~= continent then
    gax = nil
    if gm and open then gax, gbx, gcx, gay, gby, gcy, gbeyond, gtop = Projection(uiMap, gm, gn, gw) end
  end
  top = top or gtop
  -- (with no route that leads: how high a stitched map's art is drawn, asked for the first of the others)
  if not top and not continent and rest and open then
    for _, o in ipairs(rest) do
      if o.state == "route" and o.n >= 2 then
        local _, _, _, _, _, _, _, high = Projection(uiMap, o.map, o.X[1], o.Y[1])
        top = high
        break
      end
    end
  end
  local function six(a, b, c, d, e, g)
    return a and (floor(a * 1e9) .. "," .. floor(b * 1e9) .. "," .. floor(c * 1e5) .. "," .. floor(d * 1e9) .. "," .. floor(e * 1e9) .. "," .. floor(g * 1e5)) or "-"
  end
  -- The journeys that begin with your hearthstone (inns: of the one that leads, and of the
  -- others): each has a line from where you stand to its inn, which is drawn again as you move.
  local me = shared.player
  local inns, stood = nil, ""
  if open and me.world then
    local function inn(o, colour, lead)
      local at = o and o.inn
      if not at or at.map ~= me.map or (me.north - at.north) ^ 2 + (me.west - at.west) ^ 2 < HEARTH_NEAR * HEARTH_NEAR then return end
      inns = inns or {}
      inns[#inns + 1] = { north = at.north, west = at.west, colour = colour, lead = lead }
    end
    inn(whole, rc, true)
    if rest then
      for _, o in ipairs(rest) do
        if o.state == "route" and not o.gone then inn(o, o.rc, false) end
      end
    end
    if inns then stood = #inns .. "," .. floor(me.north / HEARTH_STEP) .. "," .. floor(me.west / HEARTH_STEP) end
  end
  local sig = rev .. ":" .. tostring(uiMap) .. ":" .. floor(W) .. ":" .. floor(H) .. ":" .. floor(unit * 1000) .. ":" .. (r and (r.moved or 0) or ("-" .. t.kind .. "," .. t.x .. "," .. t.y))
    .. ":" .. six(ax, bx, cx, ay, by, cy) .. ":" .. tostring(top) .. ":" .. (gm ~= continent and six(gax, gbx, gcx, gay, gby, gcy) or "=") .. ":" .. walked .. ":" .. stood
  if sig == onMap.sig then return end
  onMap.sig = sig
  s.used = 0
  onMap.goal:Hide()
  if not ax and not gax and not ((also or more or rest or inns) and open) then Finish(s) return end
  -- (over a stitched map's art, which is drawn higher up than the game's own map)
  local level = top and top >= onMap.level and top + 1 or onMap.level
  if f:GetFrameLevel() ~= level then
    f:SetFrameLevel(level)
    onMap.goal:SetFrameLevel(level + 1)
  end
  local thick, step = 2.4 * unit, 2.5 * unit
  -- The other routes there are, each in its own colour and a little thinner: drawn first, so
  -- that the one you follow lies over them where they run together.
  local where = {}
  if more and open then
    for _, a in ipairs(more) do
      local p = where[a.map]
      if p == nil then
        local pa, pb, pc, pd, pe, pf, pg = Projection(uiMap, a.map, a.X[1], a.Y[1])
        p = pa and { pa, pb, pc, pd, pe, pf, pg } or false
        where[a.map] = p
      end
      if p then
        local AX, AY = a.X, a.Y
        local ux, uy = (p[1] * AX[1] + p[2] * AY[1] + p[3]) * W, -(p[4] * AX[1] + p[5] * AY[1] + p[6]) * H
        for i = 2, a.n do
          local vx, vy = (p[1] * AX[i] + p[2] * AY[i] + p[3]) * W, -(p[4] * AX[i] + p[5] * AY[i] + p[6]) * H
          if i == a.n or (vx - ux) ^ 2 + (vy - uy) ^ 2 >= step * step then
            if p[7] or not ((ux < 0 and vx < 0) or (ux > W and vx > W) or (uy > 0 and vy > 0) or (uy < -H and vy < -H)) then
              Stroke(s, "TOPLEFT", ux, uy, vx, vy, a.kind, thick * 0.75, a.colour)
            end
            ux, uy = vx, vy
          end
        end
      end
    end
  end
  -- ...and the other routes that came whole (from a newer 3D map): each from where you are on
  -- it - its line on this continent, and what of its journey lies beyond.
  if rest and open then
    local function place(map, north, west)
      local p = where[map]
      if p == nil then
        local pa, pb, pc, pd, pe, pf, pg = Projection(uiMap, map, north, west)
        p = pa and { pa, pb, pc, pd, pe, pf, pg } or false
        where[map] = p
      end
      return p
    end
    local thin = thick * 0.75
    for _, o in ipairs(rest) do
      local p = o.state == "route" and not o.gone and o.n >= 2 and place(o.map, o.X[1], o.Y[1]) or nil
      if p then
        local OX, OY, OK, on = o.X, o.Y, o.K, o.n
        local have, ux, uy = false, 0, 0
        for i = o.at or 1, on - 1 do
          local k = OK[i + 1]
          if k >= BREAK then
            have = false
          else
            if not have then
              local north, west = OX[i], OY[i]
              if i == o.at and o.sn then north, west = o.sn, o.sw end
              ux, uy, have = (p[1] * north + p[2] * west + p[3]) * W, -(p[4] * north + p[5] * west + p[6]) * H, true
            end
            local vx, vy = (p[1] * OX[i + 1] + p[2] * OY[i + 1] + p[3]) * W, -(p[4] * OX[i + 1] + p[5] * OY[i + 1] + p[6]) * H
            local nextK = OK[i + 2]
            local ends = i + 1 >= on or nextK >= BREAK or nextK ~= k
            if ends or (vx - ux) ^ 2 + (vy - uy) ^ 2 >= step * step then
              if p[7] or not ((ux < 0 and vx < 0) or (ux > W and vx > W) or (uy > 0 and vy > 0) or (uy < -H and vy < -H)) then
                Stroke(s, "TOPLEFT", ux, uy, vx, vy, k, thin, o.rc)
              end
              ux, uy = vx, vy
              if ends then have = false end
            end
          end
        end
      end
      if o.state == "route" and not o.gone then
        for _, a in ipairs(o.also) do
          local q = place(a.map, a.X[1], a.Y[1])
          if q then
            local AX, AY = a.X, a.Y
            local ux, uy = (q[1] * AX[1] + q[2] * AY[1] + q[3]) * W, -(q[4] * AX[1] + q[5] * AY[1] + q[6]) * H
            for i = 2, a.n do
              local vx, vy = (q[1] * AX[i] + q[2] * AY[i] + q[3]) * W, -(q[4] * AX[i] + q[5] * AY[i] + q[6]) * H
              if i == a.n or (vx - ux) ^ 2 + (vy - uy) ^ 2 >= step * step then
                if q[7] or not ((ux < 0 and vx < 0) or (ux > W and vx > W) or (uy > 0 and vy > 0) or (uy < -H and vy < -H)) then
                  Stroke(s, "TOPLEFT", ux, uy, vx, vy, a.kind, thin, o.rc)
                end
                ux, uy = vx, vy
              end
            end
          end
        end
      end
    end
  end
  -- Your hearthstone's line: straight from where you stand to the inn, broken, in a colour of
  -- its own. A journey that begins with the stone has nothing else to show where you are - its
  -- line begins at the inn - and looked as if no route had come at all. (Reported on 19
  -- November 2026: "wasting time tryna make the route work then realizing its working".)
  if inns then
    for _, at in ipairs(inns) do
      local p = where[me.map]
      if p == nil then
        local pa, pb, pc, pd, pe, pf, pg = Projection(uiMap, me.map, at.north, at.west)
        p = pa and { pa, pb, pc, pd, pe, pf, pg } or false
        where[me.map] = p
      end
      if p then
        Hearth(s, (p[1] * me.north + p[2] * me.west + p[3]) * W, -(p[4] * me.north + p[5] * me.west + p[6]) * H,
          (p[1] * at.north + p[2] * at.west + p[3]) * W, -(p[4] * at.north + p[5] * at.west + p[6]) * H,
          W, H, p[7], unit, thick * (at.lead and 0.9 or 0.7), at.colour)
      end
    end
  end
  local X, Y, K, n = r and r.X, r and r.Y, r and r.K, ax and r and r.n or 0
  local have, px, py = false, 0, 0
  for i = r and r.at or 1, n - 1 do
    local k = K[i + 1]
    if k >= BREAK then
      have = false
    else
      if not have then
        -- (the first piece starts where you are on it, not at its far end behind you)
        local north, west = X[i], Y[i]
        if i == r.at and r.sn then north, west = r.sn, r.sw end
        px, py, have = (ax * north + bx * west + cx) * W, -(ay * north + by * west + cy) * H, true
      end
      local north, west = X[i + 1], Y[i + 1]
      local qx, qy = (ax * north + bx * west + cx) * W, -(ay * north + by * west + cy) * H
      local nextK = K[i + 2]
      local ends = i + 1 >= n or nextK >= BREAK or nextK ~= k
      if ends or (qx - px) ^ 2 + (qy - py) ^ 2 >= step * step then
        -- (skip pieces wholly off one side of the map)
        if beyond or not ((px < 0 and qx < 0) or (px > W and qx > W) or (py > 0 and qy > 0) or (py < -H and qy < -H)) then
          Stroke(s, "TOPLEFT", px, py, qx, qy, k, thick, rc)
        end
        px, py = qx, qy
        if ends then have = false end
      end
    end
  end
  -- The rest of the journey: its lines on the other continents, and across the sea by boat or
  -- zeppelin. Each is drawn where the map shown has the continent it is on (the game's own map
  -- shows one continent; a stitched one, all of them).
  if also and open then
    local lx, ly = nil, nil -- where the line before ended on the canvas (nil: it is not on the map shown)
    for _, a in ipairs(also) do
      local p = where[a.map]
      if p == nil then
        local pa, pb, pc, pd, pe, pf, pg = Projection(uiMap, a.map, a.X[1], a.Y[1])
        p = pa and { pa, pb, pc, pd, pe, pf, pg } or false
        where[a.map] = p
      end
      if not p then
        lx = nil
      else
        local AX, AY = a.X, a.Y
        local ux, uy = (p[1] * AX[1] + p[2] * AY[1] + p[3]) * W, -(p[4] * AX[1] + p[5] * AY[1] + p[6]) * H
        -- (a crossing goes on over the open sea from where its line off the other coast ended:
        -- on a map that shows both continents, the two are joined)
        if a.joins and lx then Stroke(s, "TOPLEFT", lx, ly, ux, uy, a.kind, thick, rc) end
        for i = 2, a.n do
          local vx, vy = (p[1] * AX[i] + p[2] * AY[i] + p[3]) * W, -(p[4] * AX[i] + p[5] * AY[i] + p[6]) * H
          if i == a.n or (vx - ux) ^ 2 + (vy - uy) ^ 2 >= step * step then
            if p[7] or not ((ux < 0 and vx < 0) or (ux > W and vx > W) or (uy > 0 and vy > 0) or (uy < -H and vy < -H)) then
              Stroke(s, "TOPLEFT", ux, uy, vx, vy, a.kind, thick, rc)
            end
            ux, uy = vx, vy
          end
        end
        lx, ly = ux, uy
      end
    end
  end
  Finish(s)
  if not gax then return end
  local gx, gy = (gax * gn + gbx * gw + gcx) * W, -(gay * gn + gby * gw + gcy) * H
  if gbeyond or (gx >= 0 and gx <= W and gy <= 0 and gy >= -H) then
    local goal = onMap.goal
    goal:SetAlpha(whole and 1 or 0.6)
    goal:SetScale(unit)
    goal:ClearAllPoints()
    goal:SetPoint("CENTER", f, "TOPLEFT", gx / unit, gy / unit)
    goal:Show()
  end
end

EnsureMap = function()
  if onMap.frame then return onMap.frame end
  if not (WorldMapFrame and WorldMapFrame.GetCanvas and WorldMapFrame.GetMapID and C_Map and C_Map.GetWorldPosFromMapPos and CreateVector2D) then return nil end
  local canvas = WorldMapFrame:GetCanvas()
  if not canvas then return nil end
  local f = CreateFrame("Frame", "AzerothAtlasOnMap", canvas)
  f:SetAllPoints(canvas)
  -- under the map's own icons, over its ground
  local level
  local levels = WorldMapFrame.GetPinFrameLevelsManager and WorldMapFrame:GetPinFrameLevelsManager()
  if levels and levels.GetValidFrameLevel then
    local ok, value = pcall(levels.GetValidFrameLevel, levels, "PIN_FRAME_LEVEL_QUEST_BLOB")
    if ok and type(value) == "number" then level = value end
  end
  onMap.level = level or canvas:GetFrameLevel() + 100
  f:SetFrameLevel(onMap.level)
  onMap.frame, onMap.strokes = f, Strokes(f)
  local goal = Diamond(f, true)
  goal:SetFrameLevel(f:GetFrameLevel() + 1)
  goal:RegisterForClicks("RightButtonUp")
  goal:SetScript("OnClick", function() shared.Try("clear", shared.Clear) end)
  goal:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:AddLine(route and route.name or "Your waypoint")
    if route and route.text then GameTooltip:AddLine(route.text, 1, 1, 1, true)
    elseif not route then GameTooltip:AddLine(note or "The route is on its way from the 3D map.", 1, 1, 1, true) end
    GameTooltip:AddLine("Right-click to clear the route", 0.6, 0.6, 0.6)
    GameTooltip:Show()
  end)
  goal:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  onMap.goal = goal
  -- (runs only while the map is open: a hidden map's children get no updates)
  f:SetScript("OnUpdate", function(_, dt)
    onMap.elapsed = onMap.elapsed + dt
    if onMap.elapsed < 0.1 then return end
    onMap.elapsed = 0
    if not pcall(DrawMap) then onMap.sig = "" end
  end)
  return f
end

-- ---- on the minimap -------------------------------------------------------------------------
-- The minimap shows the ground within a radius of you (and turns with you if you have set it
-- to), so the route there is redrawn as you move: the part of it within reach, cut at the edge.
local onMini = { frame = nil, strokes = nil, goal = nil, elapsed = 0, sig = "" }
-- (yards from the middle to the edge at each zoom, for a game without the function that says)
local REACH = { [true] = { [0] = 150, 120, 90, 60, 40, 25 }, [false] = { [0] = 233.33, 200, 166.67, 133.33, 100, 66.67 } }
local RIM = 0.93 -- how far out the route is drawn (1 = the minimap's very edge)

local function Reach()
  if C_Minimap and C_Minimap.GetViewRadius then
    local v = C_Minimap.GetViewRadius()
    if type(v) == "number" and not (issecretvalue and issecretvalue(v)) and v > 0 then return v end
  end
  local zoom = Minimap.GetZoom and Minimap:GetZoom() or 0
  local indoors = IsIndoors and IsIndoors() and true or false
  return REACH[indoors][zoom] or REACH[indoors][0]
end

-- The part of a line inside the minimap (a circle, or a square for those who have made it one).
local function Inside(x1, y1, x2, y2, square)
  local dx, dy = x2 - x1, y2 - y1
  local lo, hi = 0, 1
  if square then
    -- each side in turn
    local function side(p, q)
      if p == 0 then return q >= 0 end
      local t = q / p
      if p < 0 then if t > hi then return false elseif t > lo then lo = t end
      else if t < lo then return false elseif t < hi then hi = t end end
      return true
    end
    if not (side(-dx, x1 + RIM) and side(dx, RIM - x1) and side(-dy, y1 + RIM) and side(dy, RIM - y1)) then return nil end
  else
    local a = dx * dx + dy * dy
    if a == 0 then return nil end
    local b, c = 2 * (x1 * dx + y1 * dy), x1 * x1 + y1 * y1 - RIM * RIM
    local disc = b * b - 4 * a * c
    if disc <= 0 then return nil end
    local root = sqrt(disc)
    lo, hi = math.max(0, (-b - root) / (2 * a)), math.min(1, (-b + root) / (2 * a))
  end
  if lo >= hi then return nil end
  return x1 + dx * lo, y1 + dy * lo, x1 + dx * hi, y1 + dy * hi
end

local function DrawMini()
  local f, s = onMini.frame, onMini.strokes
  local r, p = route, shared.player
  local goal = onMini.goal
  -- (lead: the route you follow has a line on the map you are on; more: so has one of the others)
  local lead = r and r.n >= 2 and p.world and p.map == r.map
  local more = false
  if r and p.world then
    for _, a in ipairs(r.more) do
      if a.map == p.map then more = true break end
    end
  end
  -- (rest: so has one of the others that came whole; walked: how far you have got on them;
  -- main: the route whose end is marked - the one that leads, or with none the one you follow)
  local rest, walked, main = false, 0, lead and r or nil
  if p.world then
    local lone = Lone()
    for _, o in ipairs(others) do
      if o.state == "route" and not o.gone and o.n >= 2 and o.map == p.map then
        rest = true
        walked = walked + (o.moved or 0)
        if o == lone then main = o end
      end
    end
  end
  if not (lead or more or rest) then
    if onMini.sig ~= "" then
      onMini.sig = ""
      s.used = 0
      Finish(s)
      goal:Hide()
    end
    return
  end
  local reach = Reach()
  local facing = 0
  if GetCVar and GetCVar("rotateMinimap") == "1" then
    local v = GetPlayerFacing and GetPlayerFacing()
    if type(v) == "number" and not (issecretvalue and issecretvalue(v)) then facing = v end
  end
  local W, H = f:GetWidth(), f:GetHeight()
  local square = GetMinimapShape and GetMinimapShape() == "SQUARE"
  local sig = rev .. ":" .. p.north .. ":" .. p.west .. ":" .. reach .. ":" .. facing .. ":" .. W .. ":" .. H .. ":" .. (r and r.moved or 0) .. ":" .. p.map .. ":" .. walked
  if sig == onMini.sig then return end
  onMini.sig = sig
  s.used = 0
  local cosine, sine = math.cos(facing), math.sin(facing)
  local hw, hh = W / 2, H / 2
  local pn, pw = p.north, p.west
  -- a spot in the world as a place on the minimap: -1..1 across and up (east is to the right)
  local function place(north, west)
    local e, nn = (pw - west) / reach, (north - pn) / reach
    return e * cosine + nn * sine, nn * cosine - e * sine
  end
  -- the other routes there are, a little thinner (drawn first: the one you follow lies over them)
  if more then
    local out = (1.5 * reach) ^ 2 -- (a piece with both ends this far off cannot cross the minimap: a quick look before the sums)
    for _, a in ipairs(r.more) do
      if a.map == p.map then
        local AX, AY = a.X, a.Y
        for i = 1, a.n - 1 do
          local d1, d2 = (AX[i] - pn) ^ 2 + (AY[i] - pw) ^ 2, (AX[i + 1] - pn) ^ 2 + (AY[i + 1] - pw) ^ 2
          if d1 < out or d2 < out or (AX[i] - AX[i + 1]) ^ 2 + (AY[i] - AY[i + 1]) ^ 2 > out then
            local u1, v1 = place(AX[i], AY[i])
            local u2, v2 = place(AX[i + 1], AY[i + 1])
            local a1, b1, a2, b2 = Inside(u1, v1, u2, v2, square)
            if a1 then Stroke(s, "CENTER", a1 * hw, b1 * hh, a2 * hw, b2 * hh, a.kind, 1.6, a.colour) end
          end
        end
      end
    end
  end
  -- a route's line from where you are on it, as far as the minimap reaches
  local function trace(o, thick)
    local X, Y, K, C, n = o.X, o.Y, o.K, o.C, o.n
    local far = (C[o.at] or 0) + reach * 2.5 + 100 -- (no need to look further along the route than this)
    for i = o.at, n - 1 do
      if C[i] > far then break end
      local k = K[i + 1]
      if k < BREAK then
        local north, west = X[i], Y[i]
        if i == o.at and o.sn then north, west = o.sn, o.sw end
        local u1, v1 = place(north, west)
        local u2, v2 = place(X[i + 1], Y[i + 1])
        local a1, b1, a2, b2 = Inside(u1, v1, u2, v2, square)
        if a1 then Stroke(s, "CENTER", a1 * hw, b1 * hh, a2 * hw, b2 * hh, k, thick, o.rc) end
      end
    end
  end
  -- (the others that came whole, a little thinner; then the one that leads, over them)
  if rest then
    for _, o in ipairs(others) do
      if o.state == "route" and not o.gone and o.n >= 2 and o.map == p.map then trace(o, o == main and 2.2 or 1.6) end
    end
  end
  if lead then trace(r, 2.2) end
  Finish(s)
  if not main then
    goal:Hide()
    return
  end
  -- the end of the route, or the way to it at the edge
  local X, Y, n = main.X, main.Y, main.n
  local u, v = place(X[n], Y[n])
  local d = square and math.max(math.abs(u), math.abs(v)) or sqrt(u * u + v * v)
  local alpha = 1
  if d > RIM then
    u, v, alpha = u / d * RIM, v / d * RIM, 0.7
  end
  goal:ClearAllPoints()
  goal:SetPoint("CENTER", f, "CENTER", u * hw, v * hh)
  goal:SetAlpha(alpha)
  goal:Show()
end

EnsureMini = function()
  if onMini.frame then return onMini.frame end
  if not Minimap then return nil end
  local f = CreateFrame("Frame", "AzerothAtlasOnMinimap", Minimap)
  f:SetAllPoints(Minimap)
  f:SetFrameLevel(Minimap:GetFrameLevel() + 2)
  onMini.frame, onMini.strokes = f, Strokes(f)
  onMini.goal = Diamond(f, false)
  onMini.goal:SetSize(9, 9)
  f:SetScript("OnUpdate", function(_, dt)
    onMini.elapsed = onMini.elapsed + dt
    if onMini.elapsed < 0.033 then return end
    onMini.elapsed = 0
    if not pcall(DrawMini) then onMini.sig = "" end
  end)
  return f
end

-- (for the tests, and for a look from the game with /dump AzerothAtlas.Peek())
function shared.Peek()
  return { route = route, others = others, want = want, gave = gave, note = note, mail = mail, quietUntil = quietUntil, onMap = onMap, onMini = onMini, othersDue = othersDue, hearthDue = hearthDue }
end
