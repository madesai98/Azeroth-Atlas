# Azeroth Atlas

A local 3D map of the WoW Forever world — like Google Earth for Azeroth — rendered with
WebGPU. Everything is read from **your own installed game** (read-only), so the map is the same
geometry the game uses: exact terrain heights, the real buildings and objects in their real
positions, water, zone names and in-game map coordinates.

## Get it and run it

Azeroth Atlas is an application for Windows that runs beside the game. You need:

- **WoW Forever** installed through Battle.net;
- about **4 GB** of disk space for the map data;
- for NPCs, spawn zones and quests: the **QuestieDB** addon in the game (the map works without).

Then:

1. **Download it**: https://github.com/madesai98/Azeroth-Atlas/releases/latest , the file
   **Azeroth-Atlas-win-x64.zip**. Unpack it somewhere of your own (your Documents or Desktop:
   not Program Files, and not inside the game's folder).
2. Open the folder and double-click **Azeroth Atlas.exe**. (Windows may say it protected your
   PC, because the program is not signed: **More info → Run anyway**.) The map opens in a window
   of its own. There is nothing else to install: no Node.js, no browser.
3. **The game is found by itself** where it is usually installed. If it cannot be found, the
   window asks for its folder (the one with `.build.info` in it, usually called "World of
   Warcraft") and for where to keep the map data.
4. Press **Build map**. The first build reads the whole world out of your own installed game
   and takes a good while; after that, updates only rebuild what has changed.
5. Under **You**, press **Install addon** and restart the game: the addon tells the map where
   you are and draws the map's routes in the game.

Nothing of the game is in what you download: the map is built on your computer, from your own
installation, read-only. Closing the window closes everything. What is yours is kept apart from
the application, in `%LOCALAPPDATA%\Azeroth Atlas`: your settings (`config.json`), the map
data unless you chose another place for it, and a log of what the map's server said
(`server.log`, in place of a terminal). So a newer copy of the application can be unpacked
over the old one, or anywhere else, and nothing is lost.

In the window: **F11** fills the screen, **F5** loads the page again, **F12** opens the
browser's own tools. A link that leads elsewhere (Wowhead) opens in your browser.

**From the source instead** (for working on it): `git clone` the repository (or download its
ZIP), and either

- `npm install` once, then `npm run app`: the same window, run straight from the folder; or
- double-click **`Start Map.bat`** (needs [Node.js](https://nodejs.org) 20 or newer and Chrome
  or Edge): the server in a terminal window, the map in a browser tab at
  `http://localhost:5173/`.

Run this way, `config.json` and the map data are in the folder itself. The server only listens
on this computer (`127.0.0.1`) either way, and the map can be opened in a browser at that
address while the application is running, too.

### Updates

**The map tool keeps itself up to date.** When it starts, and every six hours while it runs, it
looks whether there is a newer version where it came from, and if so puts it in by itself: the
server starts itself again and the page reloads, with nothing to restart by hand. The line under
the **Update map** button says which version you have and when it last looked; **look now**
looks at once.

| Your copy | How it is updated |
| --- | --- |
| The application | As the next line: the map tool's files inside it (`resources\app`) are plain files. The frame round them (the window, the built-in Node and browser) only changes with a new download from the releases page, which is seldom needed |
| The source, unpacked from the ZIP | The newest version's files are downloaded from GitHub and the ones that differ are written; files that are no longer part of the map tool are removed. Needs the repository to be public |
| A git checkout | `git fetch`, then a fast-forward. A checkout with changes or commits of its own is never touched: the line says a newer version is out, and `git pull` is yours to run. Works with a private repository too (with the access your git already has) |

What is yours is never touched by an update: `config.json`, the map data, your notes of where
NPCs stand, the addon inside the game. After an update there may be two things left to press,
and the page says so when there are:

- **Update map** turns orange ("the map tool is newer") when the new version builds part of
  the map data differently. The map goes on working as it is until you press it.
- **Update addon** appears (under **You**) when the addon that came with the new version is
  newer than the one in the game. Press it, then type `/reload` in the game.

An update is not put in while a map build is running (it waits), and `"autoUpdate": false` in
`config.json` makes it only say that a newer version is out, with a button to put it in.

**Publishing a new version** (for whoever keeps the repository): commit and push to the `main`
branch. Everyone's copy picks it up within six hours, or at its next start. The first time,
`node tools/publish.mjs https://github.com/<you>/<repository>` writes the address into
`package.json` (copies that are not git checkouts look there for where they came from),
commits, and pushes.

**A new download of the application** is built and published by GitHub itself when a tag is
pushed (`.github/workflows/release.yml`): `git tag v0.3.0 && git push origin v0.3.0`. That is
only needed when the frame should be newer; `npm run dist` builds the same zip here, into
`dist`.

### It keeps itself current

When the map's own code is updated, nothing has to be restarted or reloaded by hand (run from
`Start Map.bat`, leave the window it opens running):

- **The server starts itself again.** The application and `Start Map.bat` both run
  `server/watch.js`, which runs the server and watches the code it is made of (the `server` and `extractor` folders, and
  `config.json`). A change there, and the server is stopped and started anew, a second or so
  later. A map update that is running is left to finish first. If the new code does not start
  (a mistake in it), the error stays on show in the window and the server is started again as
  soon as the files change once more. (`npm run serve` runs the server alone, without the
  watching.)
- **The page loads itself again.** The server watches the page's files too (the `viewer`
  folder) and tells every open page when they change; the page reloads on the spot. A restart
  of the server alone does not reload it: the page waits the second it takes, your character
  staying where it was last seen, and carries on.

### What the page remembers

Everything you set on the page is kept in the browser, and comes back however the page is
opened again: after a restart of the server or the browser, after the page has reloaded itself,
or opened afresh. That is every switch and number in the sidebar (Follow me,
Turn with me, Auto-zoom and its three distances, the NPC filters, the spawn zones, each route's
switch and colour, the figures, buildings, trees, cutaway, place names, flight masters, boats,
slopes, contour lines), the sidebar itself (folded away or not, and which of its sections are
open), and where you were looking: the map, the spot, the direction and tilt. It is
kept per browser (in its storage for `localhost:5173`); another browser, or a private window,
starts from the defaults. The application counts as a browser of its own: it keeps these with
the rest of what is yours, and remembers where its window was besides.

## Updating after a game patch

Press **Update map** (in the sidebar, under **Map & search**). The button turns orange when the installed game
build is newer than the map. An update:

- re-reads the game's file manifest and compares content hashes with what each map file was
  built from, so only things that actually changed are rebuilt (an unchanged game takes ~2 s);
- removes map files whose source no longer exists in the game;
- fetches updated public table-column definitions (WoWDBDefs) automatically if a patch changed a
  table layout;
- re-reads the creature, NPC and quest data from the QuestieDB addon and the reference database. The button also
  turns orange ("new creature data") when that addon has been updated since the last build;
- reloads the page when finished, keeping your current view.

You can also run it from a terminal: `npm run extract` (add `--force` to rebuild everything,
`--maps=0,1` to limit to certain map ids).

## Controls

| Input | Action |
| --- | --- |
| Drag | Move the map (and stop following your character) |
| Right-drag / middle-drag / Alt-drag | Rotate and tilt around the point under the cursor; around your character while following. While a movement key is held it steers (turns in place), as in game |
| Wheel | Zoom toward the cursor; toward your character while following |
| Double-click | Zoom in on a point |
| Click | Drop a marker on what is under the cursor: a street, a floor, a roof, or the ground (shows distance from it; Esc clears). Where that spot has more than one level, you are asked which |
| Shift-click | Drop a quick marker: no question, the level nearest your own height |
| W A S D / arrows | Move (Shift = faster); stops following your character |
| Q / E, R / F | Turn (around your character while following), up / down |
| G | Free-look flying (mouse look; wheel changes speed; Esc to stop) |
| N / T | Face north / top-down view |
| X | Cutaway: open up whatever hides your character (a building in the way, the ceiling of the room they are in, the ground over a city under it, the tree tops around them) |
| / | Search places, or type map coordinates such as `42.5 63` for the zone in view |
| B | Fold the sidebar away, and bring it back |

The view is stored in the page address, so a bookmark returns to the same spot (and it is
remembered besides: see "What the page remembers").

### The page

Everything you can set is in **one sidebar** down the left, in sections that open and shut at a
click on their heading; the map has the rest of the page. The ☰ button at its top (or the **B**
key) folds the whole sidebar away, so the map has all of it, and brings it back. Anything that
needs you to see it (a question about which level a waypoint is on, the card of an NPC you
clicked) opens the sidebar at the right place by itself.

| Section | What is in it |
| --- | --- |
| **Map & search** | Which map; search for a place or coordinates; **Update map** |
| **You** | The live link to the game: where you are, **Follow me** and what goes with it, the 3D figures, the addon and the guides |
| **Routes** | A route to each place you could be heading for, each with its switch and its colour (see "Route to your waypoint") |
| **NPCs** | Everyone and everything standing in the world, and the filters for them (see "NPCs") |
| **Spawn zones** | Where creatures are stationed (see "Spawn zones") |
| **Quests** | Every quest there is, to search and look into, with about how long each takes (see "Quests") |
| **Layers & view** | Buildings, objects, trees, cutaway, place names, flight masters, boats, slopes, contour lines; north, top-down, flying, help |

Two things are on the map itself:

- **The read-out** at the bottom left: the sub-zone and zone under the pointer, its **in-game
  map coordinates**, world coordinates and elevation, who you are pointing at, and, while spawn
  zones are on, what spawns there. It is there only while the pointer is on the map and on
  something in the world. With the pointer off the page, over the sidebar, or on the open sky,
  there is nothing to say and it is gone.
- **Find me**, the round button at the bottom right: flies to your character and follows them.

### The two continents on one picture

The game keeps the Eastern Kingdoms and Kalimdor as two maps, each with its own coordinates.
Here they are drawn together on one sea, as far apart as the game's own world map has them:
its picture of Azeroth gives each continent a rectangle, and from those two rectangles (they
are in the game's files) Kalimdor comes out 24,000 yards to the west of the Eastern Kingdoms
and 4,800 to the south (whole terrain tiles, so both lie on one grid). Choosing either from the
map list shows both; the first view takes in the two of them. Zephras Isle, the tram and the
dungeons are maps of their own as before.

One of the two is the map *in hand*: the one the list names, whose NPCs are shown and on which
your route is worked out. It is the continent your character is on while the game is running;
otherwise, or after you choose the other from the list (which also ends **Follow me**), it is
the one you are looking at (zoomed in: from high up, with both in view, nothing changes hands). The other continent is
drawn in full all the same: terrain, buildings, place names, spawn zones, your arrow if you
are there. The read-out under the cursor and a marker you drop work on either, in that
continent's own coordinates, and a marker dropped across the sea from where you stand gets a
journey there by boat or zeppelin. A page address still holds one map and a place on it.

Boats and zeppelins cross between them (see "Boats, zeppelins and the tram, live").

**Steep slopes** tints ground steeper than the chosen angle (default 50°, the classic walkable
limit) using the true surface geometry; **Contour lines** adds elevation contours.

The map only redraws when the view changes, so it uses no GPU while you are just looking at it.

## Configuration (`config.json`)

| Key | Meaning |
| --- | --- |
| (where it is) | The application: `%LOCALAPPDATA%\Azeroth Atlas\config.json`. Run from the source: `config.json` in the folder itself |
| `installRoot` | Game folder that contains `.build.info`. Not set, or no longer there: the game is looked for where it is usually installed (the registry, Battle.net's own list, a "World of Warcraft" folder on any drive), and asked for on the page if it cannot be found |
| `product` | Battle.net product code (`wowf`) |
| `dataDir` | Where extracted map data is written (about 4 GB). Never inside the game folder. Not set: a `data` folder beside `config.json` |
| `port` | Local web server port |
| `reference` | `false` = never download the reference database used for NPC heights (see "NPCs") |
| `referenceFile` | A copy of that database of your own to use instead of downloading one |
| `ingame` | `false` = never write the route into the game's route mailboxes (see "The same route in the game") |
| `autoUpdate` | `false` = the map tool only says when a newer version of itself is out, and puts it in when you press the button (see "Updates") |

`config.json` is each computer's own: it need not exist, it is not part of what is published,
and an update never touches it.

## How it works

```
extractor/   reads the game archives and writes map data        (node extractor/extract.js)
  casc/        local archive reader: index, encoding and root manifest, BLTE decoding
  formats/     game file parsers: DB2 tables, WDT/ADT terrain, WMO buildings, M2 objects, BLP
  jobs/        builders run on worker threads: tiles, detail pyramid, area grids, models
  questie.js   reads the QuestieDB addon: creatures, quests, quest objects (spawn zones, NPCs, quests)
  reference.js fetches and reads the public cmangos classic-db, a second source: NPC heights, what
               kind of thing a creature is, and for the quest explorer how many of each thing a
               quest asks for, drop rates, creature health and respawn times
  navread.js   reads the walkable-ground data back in (what is there to stand on at a spot)
server/      local web server + update endpoint
viewer/      WebGPU renderer (no build step, plain ES modules)
app/         the application's frame (Electron): one window with the map in it, the server run
             behind it with the Node that is built in
addon/       the addon that tells the map where you are and draws its routes in the game
```

Accuracy checks built into the pipeline:

- every archive read is verified against the MD5 the game itself keys the data by;
- terrain uses the game's exact vertices (corner + centre vertex per quad, drawn as the same four
  triangles), heights stored as lossless 32-bit floats; neighbouring tile edges match exactly;
- object placement math was validated against the world bounding boxes the game stores for all
  building placements (mean error 0.008 yd);
- colours are the game's own baked ground textures, copied block-for-block (no re-compression).

Distant terrain uses a quadtree (1, 2×2, 4×4 and 8×8 tile pages) built by exact subsampling, so
it stays sharp at any altitude while only nearby tiles are loaded at full detail.

## Spawn zones

**Spawn zones** (in the sidebar) paints the ground where creatures are stationed, so you can
find what you are looking for: where the wolves are, where a quest's creatures stand, which
part of a zone is which level.

- Each stationed creature gets a circle the size of the distance it would notice you from **at
  your level**: 20 yd for a creature of your level, one yard more per level it is above you and
  one less per level below, never under 5 or over 45 yd, plus the **extra margin** you choose
  (5 yd by default). Patrol routes are covered along their whole length.
- **Which creatures** is yours to say, with three switches:

  | Switch | Creatures |
  | --- | --- |
  | **Hostile** (on by default) | attack your side on sight: Stormwind guards make zones for Horde and none for Alliance |
  | **Neutral** | leave you alone unless you attack them |
  | **Side not recorded** | new to this game: QuestieDB does not yet say whose side they are on, so whether they attack you is not known. About 1,700 creatures at 80,000 spawn points with QuestieDB 1.1.1 |

- Zones are **grouped by how the creature's level compares with yours**, and each group has its
  own switch:

  | Group | Creature level | Colour |
  | --- | --- | --- |
  | Trivial (off by default) | so far below you it gives no experience | grey |
  | Easy | 3 or more levels below you | green |
  | Even | within 2 levels of you | yellow |
  | Hard | 3 to 4 levels above you | orange |
  | Deadly | 5 or more levels above you | red |

  Elites, rare elites and bosses count one group higher (unless they are trivial). Where groups
  overlap, the strongest one is shown.
- **My level** and faction are typed in by hand, or taken from the game automatically while the
  live player link is connected.
- Point at a zone to see what spawns there (the read-out at the bottom left). `~` after a
  level means the level was estimated.

Where the data comes from: positions, levels and patrol routes are read from the community
**QuestieDB** addon in your game's AddOns folder (the same database quest helpers use) when you
press **Update map**; which side a creature attacks comes from the game's own faction table.
Without QuestieDB installed the rest of the map works and this section says so.

**Routes pay the zones no heed.** They used to be "danger zones", which a route could be told
to go round. That is gone: a zone says where something is stationed, not where it is at this
moment, and going round every one made for long ways round things that were often not there.
With routes out of it, the creatures with no side recorded could come back as a switch of their
own: painting one that turns out to be a quest NPC costs nothing now.

What the zones are not:

- They show where creatures are **stationed**, not where they are at this moment. The game does
  not tell addons the position of anything but you and your group, so a creature that has
  wandered, been pulled or been killed looks the same on the map.
- Nothing hostile makes a zone **inside your own side's towns and cities**. The database records
  things as hostile there that you will never fight: the weather and event helpers the game
  keeps in towns ("Pat's Snowcloud Guy", level 60, in the middle of Menethil), practice targets,
  the other side's flight master in a neutral port, the beast in Stormwind's canals, rioters at
  the Stockade. A city is one the game's own area table marks as a capital of your side, and a
  creature the database files mostly under cities counts as in it. A town is the named place
  where an innkeeper who is not hostile to you, or one of your flight masters, stands; because
  such a place takes in the fields around it, a spot only counts as in the town when at least
  three of its people (anyone friendly to you, or neutral and offering a service) are within
  40 yards. So the wolves at the edge of Goldshire keep their zone, and so does everything in
  the **other** side's towns, where the guards are real.
- A creature with **no side recorded** that has a job or a quest (a vendor, a quest giver) is
  left out even with that switch on: those are people, and they are in the NPC section. What is
  left is mostly this game's new creatures, with some props and event visitors among them.
- A map built before this (the note under the switches says so) has no creatures without a side
  in it: press **Update map** once.

## NPCs

Tick **NPCs** (in the sidebar) and everyone and everything QuestieDB knows on the map is standing in
the 3D world: a small sign over each head, faint where a roof or a hill is in the way.

| Sign | Who |
| --- | --- |
| yellow **!** / **?** | starts a quest that is open to you / takes one in (grey **?**: a quest in your log that is not finished yet) |
| red crossed swords | what the unfinished quests in your log have you kill, use or collect |
| blue plane, tan house | flight master, innkeeper |
| green **$**, grey hammers | vendor, repairs |
| purple **T**, gold **B** | trainer; banker, auctioneer or stable master |
| small green / yellow / red / grey dot | other friendly, neutral, hostile, side not recorded |
| blue diamond | a quest object (a wanted poster, a crate to open) |

**Choosing who is shown.** Each kind has its own switch, about fifty of them, in groups that can
be switched on or off whole (**all** / **none**). Someone who is several things shows as the
first that is switched on.

| Group | Kinds |
| --- | --- |
| Quests | quest givers, quest turn-ins, my quest targets |
| Services | flight masters, innkeepers, repairs, bankers, auctioneers, stable masters, spirit healers, battlemasters, guild masters and tabard designers |
| Vendors | general goods, food and drink, trade supplies, reagents and poisons, weapons, armour and clothes, mounts and pets, other |
| Class trainers | one for each class, and the hunters' pet and warlocks' demon trainers |
| Profession and other trainers | one for each profession (alchemy to fishing), riding, weapon masters, other |
| Creatures | friendly, neutral, hostile, side not recorded |
| Objects | quest objects |

How far that can be trusted: what someone **does** (vendor, trainer, flight master, banker and
so on) is the game's own flags for them, as QuestieDB records them. **Which** vendor or trainer
is read from the title under their name ("Hunter Trainer", "Trade Supplies", "Bowyer"), which is
all the data has; the few whose title does not say are under **Other vendors** and **Other
trainers** rather than guessed at. On top of the kinds:

- **Only quests open to me now** leaves out quests you are not yet high enough for, ones that
  need another quest first, and ones you have outgrown. (Quests of the other side are always
  left out, and so, once the game has said, are the ones you have done or already have.) Your
  side and level are the ones in the Spawn zones section, which come from the game while the
  live link is connected.
- **Creature levels**, their **rank** (ordinary, elite, rare, rare elite, boss) and their **kind**
  (beast, humanoid, undead, demon, elemental, dragonkin, giant, mechanical, critter) narrow the
  four creature kinds, so "hostile rare beasts of level 30 to 35" is a filter. Rank and level
  are QuestieDB's. The kind of thing a creature is comes from the reference database, which has
  the original game's creatures; one new to this game is under **Not recorded**. (A map built
  before this has no kinds, and that row is not offered until **Update map** has been pressed.)
- **Only heights that are a guess** shows just the ones worth walking up to (see below).
- **Show within** is how far from the camera markers are drawn.
- The **search box** finds by name, title ("trainer") or the name of a quest someone starts or
  ends, whatever the switches say and at any distance; Enter flies to the nearest.

**Close up they are figures.** Within the distance set by **3D figures within** (the same one
that turns you from an arrow into a figure), everyone stands in the world as a person-sized
figure on the floor they are on, in the colour of their sign, and quest objects as small crates;
the sign, smaller, sits over the head. Elites, rares and bosses are bigger. From further off
they are the signs alone, which read better from a height. A figure can be pointed at and
clicked anywhere on its body.

**Point** at a sign for a line about it; **click** it for a card: level, what they do, every
quest they start and end (dimmed when not for you, with why), where they stand and how that
height is known. **Route here** drops the marker there, so the route planner takes you to them.
Click a quest in the card for what it asks: who gives and takes it, what to kill, use or
collect and what drops it. **Show these on the map** then shows only that quest's cast (red
crossed swords for what it has you kill or collect) until you ask for everything again.

### Your quests

While the live link is connected the addon tells the map which quests are in your log, whether
each is ready to hand in, and every quest you have ever done. From then on:

- a **quest giver** is someone with a quest you can actually take: not one you have done or
  have, not one that needs another first (the card says which: "after The Fargodeep Mine");
- a **turn-in** is where one of the quests in YOUR log goes, bright when it is ready and grey
  until then;
- **My quest targets** marks what your unfinished quests have you kill, use or collect, and what
  drops the things they ask for;
- the card says of every quest what it is to you: in your log, ready to hand in, done, from
  level 12, after another quest, outgrown.

That is a lot to send through a strip a few pixels high (hundreds of quest numbers), so it goes
a little at a time: the log within a second or two, the list of quests done over the next
several (packed as the steps between their numbers), and again after you hand one in. The map
only believes a list once every piece of one edition of it has arrived. The line under the
switches says what it knows ("Your quests, from the game: 14 in your log, 312 done"). Until it
knows, quests go by side and level as before.

### Dungeons

A dungeon has no zone map to give a spot on, so QuestieDB lists who is inside but not where. On
any map where it places nothing (dungeons, raids, the Deeprun Tram, the PvP halls), the
reference database's spawns are used outright, for the creatures and quest objects QuestieDB
knows: position and height both. Where the dungeon has ground data to check against, it bears
them out almost everywhere (the Deadmines 182 of 182, Scarlet Monastery 373 of 373, Naxxramas
1,208 of 1,263). A dungeon that is new to this game, or has been rebuilt, is not in the
reference: nobody can be placed there, and the NPC section says who is known to be inside.

### Where everyone stands, and how high

QuestieDB gives each spawn point as a spot on a zone map: no height. Each one gets a height, and
a note of how it is known, when the map is built (`extractor/jobs/npcs.js`):

| How the height is known | Share of spawn points |
| --- | --- |
| **The reference database, and the ground agrees.** The public cmangos *classic-db* (a full world database for the original game) lists the same creature within 5 yards, with its real height, and this game's own map data has something to stand on there. The more exact position is taken too. | 43% |
| **The reference database alone**: nothing to stand on there, so something that flies, swims or perches. | 3% |
| **The only place to stand**: no reference (a creature new to this game), one level in the map data. | 44% |
| **The likeliest of several levels**: no reference, and a building with storeys, a bridge, or a cave under a hill. | 10% |
| Not known (nothing to stand on at all). | under 0.1% |

Where the two sources overlap they agree closely: the reference spawn is within 2 yards of
QuestieDB's in 91% of cases, and its height within inches of a floor in this game's map data in
95%. That agreement is also what the guessing rule was tuned on. Counting only ground you can walk
onto (not a roof, a ledge, or the earth shut in under a floor), people are put on the lowest
built floor and creatures on the lowest ground. Where the reference database has someone
standing on one of the stretches of ground at a spot, that stretch is preferred to one nobody
is known to stand on; failing that, whatever is at the height of the people it has within 60
yards. (A city inside a mountain has a shell under its streets and a mountain over them: the
streets are where everyone is. In Ironforge this took the guesses from 483 of 572 on a city
floor to 540.) Scored against the reference heights the rule is right for about 91% of people
and 97% of creatures overall; where there are several levels to choose from, for about 83% and
81%.

The reference database is downloaded once (13 MB, from the cmangos project on GitHub) into
`<dataDir>/sources` and looked for again only when you press **Update map**. With no connection
the copy fetched earlier is used, and with none at all every height comes from the map data.
Nothing about you or your game is sent.

### Seen in game

A guess is only a guess, so the map corrects itself as you play. When you open an NPC's window
in the game (a quest, gossip, a shop, a trainer, a flight map, the bank), the addon tells the
map which NPC it is. You are standing next to them, so their height is yours: the map takes the
floor at their spot nearest the height it has followed you to, notes it on that spawn point as
**seen in game**, and says what it learned under the switches ("height corrected from 6.0 to
12.0 yd"). An NPC the database has nowhere near is added where you met them.

- Who is surer decides. Someone the reference database places is surer of where they stand than
  the map is of where you do, so if the two disagree by more than four yards it is your height
  that is put right ("King Magni Bronzebeard stands at 505.8 yd, so that is where you are"),
  and theirs is left alone. Someone whose height was a guess takes yours, unless the map itself
  cannot trust it: the game says you are indoors and your height is the open top of everything
  at that spot. A sighting read back from the file is left out if it contradicts a reference
  height by more than a storey or two, or lifts anyone sixty yards.
- Sightings are kept by the server in `<dataDir>/user/npcs-seen.json`, apart from everything
  **Update map** writes, so they survive every rebuild, and are laid over the data each time
  the map loads.
- It waits until your own height is certain (a few seconds at most), and drops the meeting if
  you walk off first. The map must be showing the map you are on (it follows you across maps
  when **Follow me** is on).
- The addon reads only the id of a creature or object: never a player or a pet, and nothing the
  game marks as restricted.
- This, and your quests, need version 5 of the addon: press **Update addon** on the page, then
  `/reload` in game.

## Quests

The **Quests** section of the sidebar is the whole quest database, to search and to look into:
5,910 quests with QuestieDB 1.1.1.

**Finding them.** Type part of a name (or a quest's number). Narrow by side (yours, or both), by
the zone a quest belongs to, by level. **Open to me now** leaves only the quests you could take
this minute: your side, your level, and, while the live link is connected, not the ones you
have or have done, nor those that need another done first. Order them by level, by name, or by
time: quickest first, longest first. Each line has the quest's level, its name and about how
long it takes. **Chains** lists whole chains instead (three quests or more that follow one from
another), each with how many quests it is and how long the lot takes.

**A quest's card** (click a line) has what it asks in its own words, who gives it and who takes
it and what it sends you to (click any of them to look at the place), the chain it is part of
with the time of each quest and of the whole, what else it opens, and:

- **Plot the route** works out the way a quest takes you - from who gives it, by what it asks
  for, to who takes it - with the same planner your own routes use, over the ground and the
  flight paths you know, and draws it in orange. Its time then takes the place of the
  straight-line figure in the estimate.
- **Show on the map** shows only that quest's cast among the NPCs.
- **Route me to the start** drops your marker on who gives it, so your waypoint route goes there.

**Where it comes from.** Two sources, each used for what it is good at, and the card names both:

| Source | What it gives |
| --- | --- |
| **QuestieDB** (the addon in your game's folder: this game's own data) | Every quest: its name, level, side, words, who gives and takes it, what it has you kill, use or collect, what comes before and after it; where everyone and everything stands |
| **cmangos classic-db** (the public database of the original game, downloaded once by Update map) | How many of each thing a quest asks for; how often each creature or chest gives an item (drop rates gathered from players of the original game over years, where QuestieDB only says who can drop it); each creature's health; how soon it is back once killed |

A quest or creature that is new to this game is in the first and not the second. Of the 5,910
quests, 3,168 have their counts from the reference database; for the rest the count is read out
of the quest's own words ("Kill 10 Kobold Vermin") where they say it. Of the 2,202 items that
quests ask for and something drops, 1,562 have a recorded drop rate; of the 4,269 creatures quests
have you kill, 3,583 have their health recorded (the rest: a usual figure for their level and rank).

**How the time is worked out.** It is an estimate for one player, and the card shows what it is
made of, line by line, with the numbers behind each line:

- **Getting about**: from who gives it, to each thing it asks for (the nearest next), to who
  takes it. Until you plot the route this is the straight line, a quarter added for the way
  round things, at your running speed; a part on another map is counted at five minutes.
  Plotted, it is the real way, flights and boats included.
- **Killing**: a creature's health over what a player of the level deals in a second, and the
  time between one fight and the next (recovering: a third of the fight; getting to the next
  and looting: 12 s). What a player deals is a round figure for questing alone (about 19 a
  second at level 10, 58 at 30, 135 at 60): your class, gear and talents move it. A creature
  below you goes down faster, one above you slower. The level counted is yours when the quest
  is one for your level, else the quest's own.
- **Collecting**: the kills it takes at the recorded drop rate ("drops 66% of the time, so about
  10 kills"), from whichever source is quickest; a chest or a plant at 18 s each. A drop rate
  nobody recorded is counted at 35%, and the card says so.
- **Waiting**: where a quest asks for more of something than there are, the wait for them to
  come back, by the recorded respawn time (five minutes where it is not recorded).
- **Taking it and handing it in**: 10 s each.

What makes a figure rougher than usual is said on the card under it. In particular:

- An **elite** is counted as fought alone. A **boss**, or anything with eight times the health
  of an ordinary creature of its level, is a fight for a group: counted at four minutes for a
  boss and 45 s for the rest, and finding the group is not counted. Dungeon and raid quests are
  marked as such.
- Nothing a quest asks for is counted at more than **two hours**. Where the arithmetic comes to
  more (a one-in-ten-thousand drop, a raid boss that is back in a week), the thing is in truth
  bought, made, or won over several visits; no figure would be honest, so it is two hours and
  the card says so.
- A dungeon's creatures are placed at its door by the database, and are hours in coming back:
  they are counted as if there were enough of them.
- Escort quests, timed events and anything a quest only says in words ("speak with", "find")
  are counted as the travel and the talking alone.

So the figures are good for comparing quests and for adding up a chain or an evening, and less
good to the minute: the median quest comes to 5 minutes, three quarters are under a quarter of
an hour.

## Route to your waypoint

With **Routes** ticked, the map works out the fastest way to where you are heading and draws it
in the world, in the route's own colour: the colour itself where you walk, turned toward light
blue where you swim, a light tint of it where you fly. The Routes section says how far it is and
how long it should take, and the diamond on the target shows what is left.

### A route to each place you could be heading for

There can be several at once, each in its own colour, each with its own switch in the Routes
section, where each also says how long it is:

| Route | Colour | Where it goes |
| --- | --- | --- |
| **Guide objective** | green | your guide's current step |
| **Tracked quest** | yellow | the quest you are tracking in the game (the one its objective tracker has picked out): the nearest of what it has you kill, use or collect, or, once it is ready to hand in, who takes it |
| **Waypoint** | blue | the last waypoint you placed yourself: a Ctrl-click or Shift-click on the game's map, or a click on this one |
| **Corpse run** | red | your body, while you are a ghost. On foot all the way: a ghost takes no flight |
| **Party members** | purple | each member of your party who is on your map |

- **The colours are yours to change**: click the swatch beside a route. A flight is always a
  light tint of its route's colour, so you can tell whose flight it is.
- **One of them leads**: the guide's step or your own waypoint, whichever the game itself is
  heading for (see below for which wins). That is the one the Routes section describes step by
  step, and the one handed to the game for its own map and minimap. The others are drawn on the
  3D map only. Switching the leading one off leaves the others.
- The tracked quest's route needs the NPC data of the map you are on (what a quest asks for is
  looked up there), so it reaches what is on your continent.
- The tick on the **Routes** heading switches all of them off and on at once.
- They need the addon as it is now: press **Update addon** and `/reload` once. With the addon
  from before, the page is only told the one that leads, and draws that one and your party's.

**Where you are heading** is read from the game by the addon. Three things can say so:

- the step your guide has you on: the addon's own guide window (see "Guides in the game"), or,
  while the Guidelime addon is switched on, the step Guidelime's arrow points at;
- a **quick waypoint**: **Shift-click** the game's world map. It is the addon's own (the game's
  map pin is left alone), it is marked on the map at once, and it stays yours through a
  `/reload`;
- a pin you put on the game's own map: **Ctrl-click** the world map.

**Whichever changed last leads**: Shift-click or place a pin and the route goes there; when the
guide moves on to its next step the route follows the guide again; take a pin off and the guide's
step is back. A quick waypoint that something newer has taken the place of is gone for good.
With none of them, click the 3D map to drop a marker and the route goes there instead.

`/atlas clear` in the game (or a key you bind to *Clear the route*, or a right-click on the
route's end on the game's map) drops the waypoint you have now: the route goes, here and in the
game, and stays gone until the guide moves on to another step or you set a new waypoint. A pin or
quick waypoint you travelled to is taken away when you get within ten yards of it at the end of
its route (standing right over or under it, with most of the route still to go, does not count).

While **Shortest Path Forever** is still installed the addon allows for it, because it uses the
game's map pin for itself: while it leads you it moves that pin from bend to bend of its own
path, so that pin is not taken for yours; a journey of your own in it (Shift-click) counts as
your waypoint; and clearing its path clears the route here too. None of that is needed once it
is removed.

**Which level.** A waypoint from the game is a spot on a flat map, and under one spot there can
be a street and the floor above it, a bridge and the road beneath, a hall and its cellar - and,
in a town, the ground the game leaves buried under the streets.

When the waypoint is on someone the map knows (within six yards of an NPC or quest object,
preferring whoever your quests send you to), it is them you are heading for, on the floor they
are on: the route climbs the stairs to Captain Stoutfist rather than stopping in the hall below
him, and the Routes section says "To Captain Stoutfist". **Route here** on an NPC's card does the
same. Where the NPC's own height is only a guess, it says that which floor is a guess.

For any other waypoint the route worker is asked **which levels there are at that spot that you
can walk to** (`viewer/js/navworker.js`, `viewer/js/levels.js`): every floor within a couple of
yards of the spot, sorted into levels, and a search from where you are (or, for a journey, from
where its last walk begins) that goes on until it has reached each of them or has looked far
enough to say the rest cannot be reached. Two rules keep out what is not a real place:

- a level counts only if it can be walked to **without a one-way drop**. The ground buried
  under Stormwind can be reached in the game's data, by climbing down a cliff at the city's
  western edge and dropping the last three yards; nothing leads back up. A place you could only
  fall into is not somewhere to be sent, and this rule removes it without knowing anything
  about Stormwind. (Standing on a ledge you can only leave by dropping, the search is done
  again with drops allowed.)
- ground with a floor built wide over it, or lying in a pit of built floors, is only taken
  where there is nothing else.

If **no level at the spot can be reached** (the waypoint is on a roof, or inside a wall) the
route goes to the nearest place within 45 yards that can be, and the end of the route is marked
there.

With **more than one level**, the choice is yours:

| Waypoint | What happens |
| --- | --- |
| A pin on the game's map (Ctrl-click) | The game asks "Which level is your waypoint on?" (the levels with how high they are relative to you and how long each takes). Until you answer, the route goes to the level nearest your own height |
| A marker clicked on the 3D map | The page asks the same, over the map. Until you answer, the route goes to the surface you clicked if you can get to it, else to the level nearest your own height |
| A quick waypoint (Shift-click, in the game or here) | No question: the level nearest your own height |
| A guide's step | No question: the level quickest to reach |

Whatever was chosen can be changed for as long as the waypoint stands: in the Routes section here
(the levels are listed under the route, the one in use marked), or in the game with
`/atlas level` or a click on the "Level:" line of the step list. The marker and the route's end
are drawn on the level chosen, not on the terrain underneath.

**On foot** the route is searched over the map's navigation data, which the extractor builds from
the real geometry (`extractor/jobs/nav.js`): a grid of about one yard of every place a character
can stand. It is made by laying every solid triangle into the grid (the terrain, and the
collision meshes of the buildings and objects placed on it), so it knows slopes too steep to
walk, walls, fences, tree trunks, bridges, the floors and stairs inside buildings, and water deep
enough that you swim. Each place records which of its neighbours it leads on to, worked out at
half-yard precision, so thin walls separate and doorways a yard wide stay open. The cost of a
step is the time it takes at **your** speeds: the addon reports your current run speed (mounted
or not) and swim speed.

Routes take the quickest way and pay no heed to where creatures are stationed (see "Spawn
zones" for why going round them was taken out).

**Faster than walking**, when it is: the map also considers

- **flying** between two flight points you know: walk to one, fly along the game's own flight
  routes, walk on. A flight takes the length of its route (as the game flies it, height
  counted) over the speed flights go at: 30.4 yards a second, which gives the measured times
  of 266 of the game's flight paths to within a second on average. Yours may be faster (the
  Frequent Flier talent adds a fifth), so the map times the flights you take: how far along the
  route you have come over twenty seconds or more of it, not how fast you cross the map at one
  moment (coming down to land, that is well under the speed you fly at). From then on flights
  are counted at your speed. Flight points are learned whenever you open a flight master's
  map, and ShortestPathForever's list is used as well if you have it;
- **boats and zeppelins**: every line and where it stops comes from the game's own tables
  (they sail the same kind of route a flight path flies, with the stops marked), and how long
  each leg and each stop takes from timetables measured in the game. A line that has been timed
  (see "Boats, zeppelins and the tram, live") is taken at the moment its craft really leaves,
  for when you would get to its dock: a boat you would miss by seconds is not counted on. One
  that has not is counted at its measured trip plus half a round of waiting, on average. In
  between (a time too loose to name the moment, as the tram's usually is from other players'
  sightings: its cars are 72 seconds apart, and a quarter of a minute is a lot of that) the
  wait is what it comes to on average given what is known: short when you would get there
  well before a car is due, long just after one. Lines
  that stop in the other faction's towns are left out (a place counts as theirs when the flight
  masters there serve only them), and so is one the game's tables still list but which no
  longer sails;
- **the Deeprun Tram and portals** (Darnassus): the tram is counted the same way, by when its
  next car leaves. The doorways between maps are not in the game's files (the server decides
  where one leads): they are listed in `extractor/doorways.json`, and read from the
  ShortestPathForever addon's own list where that addon happens to be installed;
- **your hearthstone**, if it is set somewhere useful: it counts the time left on its cooldown
  plus the cast, and is only suggested when it saves at least a minute and a half over the next
  best way. The game tells an addon only the name of the place it is set to ("Deepwater
  Tavern"), so the inn is found from that: the zone the place is in, then the innkeeper of that
  zone who is on your side (innkeepers come from QuestieDB). Where a zone has more than one and
  the name does not settle it, the hearthstone is left out until you set it again, when the
  addon notes the exact spot.

All of these are stops in one network, on whichever map they are: the quickest chain from you
to the waypoint is found by estimate, the walks in it are then worked out for real over the
ground of the map they are on, and the chain is looked for again until it holds. So a waypoint
**on another continent** gets a journey ("684 yd on foot to the Deeprun Tram entrance, then the
tram, then fly Ironforge to Menethil Harbor, then the boat from Menethil Harbor to Theramore,
then 553 yd on foot"). The quickest is drawn (the parts on the map you are looking at), with
each part spelled out in the Routes section next to what walking the whole way would take.

**A change has to be worth making.** The first thing a journey takes (a flight, a boat, the
tram) counts for the time it takes. Each one after it has to save a minute on top, or the
simpler journey stands: from Stormwind's inn the tram to Ironforge's flight master comes out
nine seconds ahead of flying from the flight master round the corner, which is less than what
one missed car costs, and seven steps for it. From nearer the tram's entrance, where it saves
a minute and a half, the tram it is. (A flight is one thing to take however many flight
points it passes.)

Walks that were worked out are remembered, and a long search that found no way is not repeated
from the same spot for a minute, so keeping the route current costs very little while you move.

**A journey being worked out is left to finish.** It takes a few seconds (the walks to the
flight masters, a search or two that finds no way), and you may be running meanwhile. Every
few yards used to be a new question that threw the last one away: out of Dun Morogh on a fast
mount, a waypoint in the Wetlands had no route for twenty seconds, which is longer than the
game waited for one. Now a question is given up to twenty seconds before the next takes its
place; the route then begins where you stood when it was asked, and the addon knows how far
you have gone since.

**On a flight path the route is the rest of the flight.** While the game says you are on a
flight path, the route is the flight path from where you are to where the flight comes down,
then the way on from there (a walk, another flight, a boat), and the time left counts what is
left of the flight at the speed your flights go. It is worked out once, not as you move: the
way on from where a flight lands does not change in the air. The game does not say where a
flight is going. If the route in hand had you take this flight, it goes where that says, over
however many flight paths ("Fly to Thelsamar" from Darkshire is three). Any other flight is
taken to come down at the end of the flight path you are on, and the journey goes on from
there by whatever is quickest: on a flight to Stormwind with a waypoint in Westfall, "Fly to
Stormwind, Fly to Sentinel Hill, Walk". Should such a flight fly on past that flight point,
the route is worked out again from the end of the next path. (Before, no journey was looked
for while anything carried you, and every twenty seconds the route became the walk from the
ground under you.) Where several flight paths run together (out of a flight point they all
do, for a while), the ones the journey in hand flies along are taken first, and where the
flight goes is kept for as long as you are in the air. On a boat, a zeppelin or the tram the
way on is still worked out when it has put you down; until then the journey in hand stays as
it is (it used to be taken away for the crossing).

**The whole journey is drawn, on every continent and across the sea.** A journey that goes on
to the other continent is drawn there too, on the picture that shows the two side by side: its
walks and flights over there, and the way the boat or zeppelin takes across, in lilac. The
game's own path for a boat stops a little way out from each dock (the craft is moved from one
continent's map to the other's while its riders look at a loading screen), so its two ends are
joined by a straight line over the open sea: the line the boats on the map are shown sailing.
These lines are shown, not followed. Your place on the route is kept on the line of the map
you are on, exactly as before; the rest is worked out afresh when you get there.

**Walks alone are not a journey, and a guess does not beat a way that was found.** A walk too
long to work out step by step is still allowed as one leg of a journey, as an estimate, but at
three times the straight line: the search gave up with the place not reached, so the way is a
long way round. At 1.3 times, as it was, a "walk" from Dun Morogh to Menethil Harbor (in truth
by way of Loch Modan) came out quicker than the flight from Ironforge; the route was that
guess plus the real walk on from Menethil, drawn from Menethil only, and to Southshore you
were sent "walking" to Menethil's flight master. And a chain of walks from stop to stop, with
nothing to ride in it, is never taken: the walk straight there is the quickest of those.

### The same route in the game

The addon draws the route **on the game's own world map and minimap** too: the very route the
3D map shows, seen from above (the one that leads: the game follows one route at a time, and
the 3D map's other routes are its own). Gold where you walk, blue where you swim, pale where you
fly; the part behind you goes as you walk; a diamond marks the end (on the
minimap it sits at the rim, faded, while the end is further than the minimap reaches). Hover the
diamond on the world map for the words the 3D map shows ("fly Ironforge to Menethil Harbor,
then..."); right-click it to clear the route. A waypoint whose route has not come yet is marked
with a fainter diamond, so a click on the map is seen to have taken.

**The rest of a journey is on the game's world map too.** Open the other continent's map (or
one of its zones) and the journey's lines there are drawn: what is walked and flown, and the
boat coming in. The diamond is at the waypoint itself, where a journey that ends on another
continent used to end, on the map, at the pier. On the map of where you are, the boat's way
out to sea from its pier is drawn in lilac. On OpenMap's stitched map, which shows both
continents at once, the crossing is joined over the sea as it is on the 3D map. Nothing of
this is on the minimap (none of it is near you), and none of it is followed: the arrow, the
step list and your place on the route go by the line of your own continent, as they did.

The game is handed a route only once it stands. The 3D map shows the walk all the way as soon
as it has found it, and goes on looking for a quicker way (a flight, a boat, the tram); the
addon fetches a route once per waypoint and keeps it, so if it were handed that first answer it
would have you walk and swim from Stormwind to Southshore with both flight points known. Until
the looking is done the game is told the route is still being worked out, and asks again a
moment later.

To follow it without the map open (`addon/AzerothAtlas/Guide.lua`):

- **the arrow**, top middle of the screen: which way the route goes from where you stand (it
  aims a dozen yards further along the line, so it leads you round corners and back onto the
  route when you are off it), how far it is to the end of the step you are on, and what that
  step is. It dims when the route is behind you. On a flight, on a boat, or with the hearthstone
  to use, there is no way to point: it shows the time that step takes instead;
- **the step list**, under a header that counts the steps (**Current Route: 2/5**: you are on
  the second of five): the journey's name with the time and distance left in all, then the
  journey as things to do, the one you are on first and bright, each with its time ("Walk to
  Sentinel Hill's flight master 0:14", "Fly to Stormwind 2:05", "Walk to your map pin 0:40").
  Steps you have done drop off the top. A journey that begins with your hearthstone has that as
  the step you are on until you stand where its line begins: nothing is drawn from you to an
  inn on the far side of the continent, and the line starts there. (Being nearest to the end of
  the walk from the inn to a flight master used to count as standing at the flight master: from
  Dun Morogh, with the hearthstone set to Stormwind, the list began at "3/4, Fly to Darkshire".)
  Boats say how long the wait is likely to be. Where the waypoint's spot has more than one
  level, a last line says which the route goes to; click it to choose another. **A click on the
  header folds the steps away**, and another brings them back (folded, it reads "Current Route:
  2/5 +").

**The step list is a part of Questie's quest list.** It hangs right under Questie's tracker,
left edge on left edge, and is written as Questie writes: the header in the letters, size and
outline of "Questie Tracker: 4/40", the journey as Questie writes a quest's name, the steps as
it writes what a quest asks for, each starting where Questie starts its own and spaced as it
spaces them. All of that is read from Questie's settings about once a second, so a change in
Questie's options (another font, a dark ground under the list) shows in the step list too. It
follows Questie's list as that grows, shrinks, is dragged or is folded away; where there is no
room under it, it goes over it, and failing that beside it. Near the screen's right edge its
lines are wrapped rather than run off the screen. While Questie hides its list, the step list
stays where it hung. Nothing of the addon's is ever anchored to Questie's list (that can break
Questie's own dragging): it is only asked where it is. Without Questie, or after
`/atlas pin`, the step list stands on its own, on a dark ground.

The arrow and the steps are click-through (the header and the "Level:" line take a click).
`/atlas arrow` and `/atlas list` switch each off or on, `/atlas pin` takes the step list
out from under Questie's list or puts it back, `/atlas move` lets you drag the arrow, and the
step list where it stands on its own (type it again when done), `/atlas reset` puts them
back.

There is one router, the 3D map's, so the two cannot disagree. The route is not worked out
again inside the game. With the **OpenMap** addon showing its stitched world map, the route is
placed through OpenMap's own interface for other addons, so it sits right there too.

**How it gets there.** Nothing can be sent to an addon while the game runs. What an addon can do
is load another addon on demand, and the game reads that addon's file from the disk at that
moment. So beside the addon sit 300 tiny load-on-demand addons, the **route mailboxes**
(`AzerothAtlas_Mail001` ... `300`, grouped under Azeroth Atlas in the game's addon list;
there is nothing to switch on or off in them). The map page hands each new route to the local
server as a track (`viewer/js/ingame.js`: stretches of x, y points with the height of each,
thinned to within about half a yard of the real line and a yard of its height, so 600 yd of
level road is some 25 points), the server keeps the next
six mailboxes filled with it (`server/mail.js`), and the addon opens one when it wants the
route (`addon/AzerothAtlas/Route.lua`).

A mailbox can be opened once per login or `/reload`, so they are opened sparingly:

- when your waypoint changes: a couple of seconds later (the route is usually worked out by
  then), and again up to five times, further and further apart (the last some 80 seconds after
  the waypoint was set), if it was not;
- when you choose another level for your waypoint: the route to that level;
- when you have been more than 25 yards off the route for a few seconds (the 3D map has planned
  from where you are by then);
- when the addon cannot tell which of two levels you are on, or you stand at your waypoint's spot
  while the route says you have not reached it (see "One level over another" below);
- when you say so: `/atlas route`, or a key bound to *Fetch the route from the 3D map*. That is
  how a marker you dropped on the 3D map itself gets into the game, since the game cannot know
  you did that.

Walking along the route costs nothing; where you are on it is worked out in the game. A normal
hour of questing uses a few dozen. `/atlas status` says how many are left, and the map page
says so when they run low; `/reload` gives them all back.

The addon tells the server (through the strip) which mailbox it will open next and which
delivery it last read, so the page can say what the game is showing: "In the game: showing this
route". Each delivery carries the time it was written; if the game opens one that is more than
half a minute old the 3D map is evidently not running, and the mailboxes are then left alone
(one look every five minutes, then ten, and so on) instead of being used up for nothing.

Installing the mailboxes is part of **Update addon**. The game only notices new addons when it
starts, so restart it once after that update. The server writes only into folders named
`AzerothAtlas_Mail###`, and only while it is reading the strip of a running game.

What the addon says back goes through the strip: which mailbox it opens next, and the level you
chose in the game's question (repeated for a minute so that it is sure to arrive).

**One level over another.** The game tells an addon where you are on the map but not how high.
Seen from above, the hall under a waypoint and the gallery the waypoint is on are one spot, and
a road is on the bridge that crosses it. An addon that took "the nearest part of the route on
the map" for where you are would, under the end of your route, think you had arrived: the path
would vanish and the pin be taken off. So:

- **Your place on the route is followed, not looked up.** From where you were on it, you can be
  no further on (or back) than you have moved since: a few yards each look. A part of the route
  that lies overhead is yards of walking away along the route, so it is never mistaken for where
  you are. A new route begins where you stood when it was worked out, and the addon keeps the last
  minute of your steps to know how far you have gone since then.
- **Each delivery says how high the route runs** (`zs`), and marks the points where another
  level lies over or under the way (`am`). The route worker works that out from the walking
  data: a place to stand within 7 yards that is more than 2.5 yards higher or lower, is not the
  same ground a few steps on (a slope is not two levels), and is somewhere to walk about - not a
  roof, an awning, a tree top, the face of a steep bank, or the ground the game leaves buried
  under a town. Where the route passes over or under itself, both parts are marked.
- **When you have left the part you were on** (a corner cut, a jump down) and are beside another
  part of the route, the addon takes you to be there at once if nothing lies over or under that
  part, or if it runs on the level you were last on. Otherwise it does not guess: it asks the 3D
  map, which follows your height (one delivery; a newer route from where you really are, or the
  word that you are on this one).
- **A waypoint is reached at the end of its route, on the level it ends on**: within 10 yards of
  the end along the route, and within 2.5 yards of its height by the route's own heights. Not
  when you stand under it or over it. A pin where nobody can stand is reached at the end of its
  route, the nearest place you can.
- **The 3D map has the last word.** Each delivery says whether you are at the waypoint (at its
  spot and within 2.5 yards of its height) and on the route. If you stand at the waypoint's
  spot for three seconds and the route says you are not there, the addon asks (no sooner than
  half a minute after it last heard about that waypoint; then a minute later, two, four...):
  should the 3D map say you are there after all - you took a lift, or a stair the route does not
  know - the waypoint is taken off.

The game itself does not take a map pin away when you reach it (its own tracker only stops
tracking, with "destination reached"), so whether a pin stays is the addon's doing alone.

The 3D map follows your place on its own route by height as well (a yard above or below counts
as four beside it), so it does not hide the way up either, and works out a new route when you
are a floor off the one shown.

Not there: a marker dropped on the 3D map needs `/atlas route` to reach the game; nothing is
drawn on the minimap inside dungeons, where the game does not tell addons where you are; and
the arrow is a compass on the screen, not a marker standing in the world.

What it does not do:

- A walk that cannot be worked out step by step (a way that does not exist takes the longest to
  rule out) is given as "roughly N yd" when it is one leg of a longer journey: three times the
  straight line, and nothing is drawn for it.
- It knows where a boat is only once the line has been timed since the server last restarted
  (by a ride of yours, or by another player's sighting reaching you). It does not know of mage
  portals, summons, or the fatigue water far
  out at sea (it will not send you swimming between continents, which are separate maps, but it
  does not know about fatigue between an island and the coast of the same map).
- Doors and gates the game opens and closes, and anything else that is not part of the static
  world, are not known.
- The earth under a city's streets is real ground in the game's data. A waypoint is never sent
  there while there is a real place to go (see "Which level"); a route you are already on can
  still use a drop off a ledge as a short cut, as you would.
- The levels of a waypoint are worked out once, when it is set. They are described relative to
  where you stood then, and a waypoint keeps the level it was given until you change it.
- Whether you are on the waypoint's level rests on the route in the game and, behind it, on the
  3D map's reckoning of your height. With the 3D map not running there is no route and no
  height: a pin is then taken off when you reach its spot on the map, whatever floor you are on.
- While the Guidelime addon itself is switched on, a step of its guide is ticked off by
  Guidelime, by its own rule (how near you are on the map): it can move on while you are a floor
  below the step. The addon's own guide window does not (see "Guides in the game").

### Boats, zeppelins and the tram, live

A boat sails the same round over and over, to the second, until the server restarts. So one
moment at which it was seen to leave a dock fixes its whole timetable: when it is next at every
stop, and where it is on its way right now. The game tells an addon nothing about a boat, so
that moment has to be seen. Everything there is to see it by is used, cross-checked, and made
into one answer, with nothing to set up:

| What | How it is used |
| --- | --- |
| **The timetables** (`viewer/transit.json`; the addon's copy is written from it by `tools/make-transit-lua.mjs`) | How long each line's round takes, each leg, each stop, and where the craft is every couple of seconds of a leg: eleven boat and zeppelin lines and both tram cars as DockWatch's players recorded them in this game (MIT licence), and the Feathermoon ferry from the game's own path and the round Nauticus measured for it (its times are rough). The game's own path of each line is where the craft is drawn; all 695 recorded moments of the eleven lines lie on those paths. |
| **Your own rides** | Something is carrying you when you move without moving yourself. Carried along a line's track where the boat is under way, each spot you pass says how long ago it left; five of them over five seconds that agree to the second are when it left, wherever you boarded. |
| **Other players' sightings** | Three addons pass sightings from player to player, each in its own way, and each is read as that addon writes it, without being installed: **DockWatch** (the moment a boat left a dock, by where the dock is; over its own hidden channel, the guild and whispers), **ForeverTransport** (when it arrived, by a line's number) and **Nauticus** (how far into its round a boat is as the message is sent). The addon **only listens**: it never sends, so it cannot put a wrong time into anyone's timers. `/atlas boats listen` turns the listening off. |
| **The server's restarts** | A restart starts every boat afresh. The warning the server gives in chat ("restart in 15:00") is read, and a ride of your own that no longer fits a well-founded timetable says one has happened. |

**Voices that differ** (`addon/AzerothAtlas/Transit.lua`). Sightings that agree (give or
take what a round's own uncertainty allows) make a timetable. Each is weighed by how exact it
is: your own ride to under a second, a DockWatch sighting to a second and a half, a
ForeverTransport arrival to three, a Nauticus one to four (it is counted on from the moment of
sending, so a slow message shifts it). The same sighting handed on by several players counts
once. A sighting that stands alone against a timetable confirmed in the last three quarters of
an hour waits until a second player backs it; your own ride always counts. **The length of a
round is worked out from the sightings** as they spread over hours (the sources give it a few
tenths of a second apart, which is a minute's drift over a day): two sightings three hours
apart give it to a few hundredths. How unsure a departure is goes with it everywhere: under six
seconds it is given plainly, over that as "about", and past a sixth of a round the line counts
as not timed: no moment is named for it (a journey still counts what such a time says about
the wait, up to half a round unsure, where it says nothing).

**What it is used for:**

- **Journeys** take a timed boat or tram at the moment it really leaves (see above), and the
  page says so ("the boat from Booty Bay to Ratchet, it leaves in 2 min 30 s").
- **In the game**, the step that waits for a boat counts down to it second by second
  ("Boat to Ratchet 6:10 · leaves in 4:07"), in the step list and under the arrow, and once
  you are aboard to when you get there ("arrives in 1:32"). `/atlas boats` lists every line
  that is timed: when it leaves each of its stops, what that rests on, and when it was last
  seen.
- **On the 3D map**, every timed craft is shown where it is this moment, moving along its line,
  with what it is doing over it ("1:49 to Ratchet", "leaves Booty Bay in 0:39"), and each dock
  says when its next one comes. Close up it is the game's own model of the craft (the ship,
  the zeppelin, the tram car, placed like any building); from further off, where that would be
  a speck, a plain shape in the colour of the side whose line it is. **Boats & trams** in the
  options switches them off. The two airships of Zephras Isle are always the plain shape (the
  game's model for them is not known), and the tram car's model needs one press of **Update
  map** to be made ready.
- **Across the sea.** In the game a boat never sails from one continent to the other: about
  fifty seconds out of port it is moved to the other map, some 20,000 yards away on the
  picture, while its riders see a loading screen, and sails in from there. On the map it is
  shown making that crossing: for its first and last twenty seconds, in sight of the docks, it
  is exactly where the game has it, and in between it sails evenly over the sea from the one
  stretch to the other, so the time over it ("0:48 to Ratchet") and its arrival are right
  throughout. The craft you are aboard is the exception: it stays under you, exactly where the
  game has it, and makes the crossing during your loading screen. (A boat to Zephras Isle,
  which is on no common picture, simply leaves one map and turns up on the other.)

The addon tells the map what it knows through the strip (three lines a second, in turn, and
how far the server's clock is from this computer's), so the map goes on showing the boats after
the game is closed, for as long as its server runs.

### Guides in the game

The addon follows **leveling guides written for Guidelime** in a window of its own, so that
Guidelime is not needed: the same guide packs, installed and updated as ever. The reason to have
it here is the step that sends you to a spot. Guidelime counts such a step as reached when you
are near the spot on the map, whatever floor you are on. Here the step is your waypoint, the 3D
map routes to it, and it is reached **where that route ends, on the level it ends on** (see "One
level over another"): standing under the quest giver's balcony does not tick the step off, and
the way up stays shown.

**Convert guide packs.** A guide pack names Guidelime in its `.toc` file as the addon it needs,
and the game loads no addon whose needed addon is missing or switched off. So with Guidelime
switched off or removed, a pack as its maker wrote it does not load at all. The 3D map's page
sees such packs in the game's AddOns folder and offers **Convert guide packs**. That changes
the one line (`server/addon.js`):

```
## RequiredDeps: Guidelime, QuestieDB        becomes        ## RequiredDeps: AzerothAtlas, QuestieDB
                                                             ## OptionalDeps: Guidelime
                                                             ## X-AzerothAtlas-Converted: by the 3D map. Before: RequiredDeps: Guidelime, QuestieDB
```

The pack then needs Azeroth Atlas, and names Guidelime only as an addon to load after if it
is there. Nothing else of a pack is touched: its guides are the files its maker wrote. Restart
the game afterwards (leave it altogether: which addon needs which is read when it starts). A
pack you install or update later is as its maker wrote it again; the page offers it again
(it looks every half minute), and in the game the addon says when you log in that a pack did
not load.

**Who runs the guides** is then set in the game's addon list, per character:

- Guidelime **switched off, or removed**: the addon's own guide window.
- Guidelime **switched on**: Guidelime, as before (a converted pack hands its guides to it), and
  the route goes to the step its arrow points at. The guide Guidelime has open, what it has
  ticked and how it is set are copied to the addon's own settings as you play, so the addon's
  window goes on from there on the day you switch Guidelime off. The other way round nothing is
  copied (Guidelime's saved file is its own): back in Guidelime, the steps the game itself can
  tell are done are done, and a step you ticked by hand in the addon's window is not.

A converted pack needs Azeroth Atlas switched on, also for Guidelime to get its guides.

**The window** (`addon/AzerothAtlas/GuideWindow.lua`): the steps of the guide, the ones you are
on bright and scrolled into view, with what a quest still asks for listed under its step. Each
step has a box: tick a step off yourself, or take a tick away. Drag the window by its title and
size it by its corner. **Guides** in its title opens the list of every guide the installed packs
bring (the ones for your character; click one to follow it), and at the end of a guide the one
that comes next is offered. Beside the window are buttons to target who the step is about and to
use the item it names; keys can be bound to the first of each, and to showing the window
(Options > Keybindings > AddOns). The game allows such buttons to change only outside a fight.

| In the game | |
| --- | --- |
| `/atlas guide` | the window, shown or hidden (`/lime` does the same while Guidelime is not switched on) |
| `/atlas guides` | the list of guides, and the settings |
| `/atlas guide skip` | tick off the steps you are on |
| `/atlas guide reset` | take every tick of this guide away |
| `/atlas guide lock` | the window stays where it is (again: it can be moved) |

**What a step is, and when it is done** (`GuideBook.lua` reads the guides, `GuideSteps.lua`
follows them). Every code Guidelime knows is read the way Guidelime reads it, and the rules are
Guidelime's, so a guide behaves as its writer saw it behave:

| A step with | is done when |
| --- | --- |
| `[QA]` accept, `[QC]` do (also one goal of a quest: `[QC123,2]`), `[QT]` hand in | the game says so: the quest is in your log, its goals are met, it is handed in |
| `[XP]` a level (or so much of one), `[SK]` a skill worked up, `[LE]` a skill or spell learned, `[REP]` a standing, `[CI]` items to have | you have it |
| `[G]` a spot, and nothing else to do | you are there: at the end of the route to it, on its level |
| `[V]` vendor, `[R]` repair, `[T]` trainer, `[S]` set your hearthstone, `[P]` a new flight point | that window opens, the hearthstone is set, the flight point is yours - or you tick it |
| `[F]` fly, `[H]` hearthstone, `[SP]` a spell to cast | you take off, the hearthstone is used, the spell is cast (with a spot named as well: also on getting there) |
| plain words | you tick it |

You are on the first step that is not done, and on every optional one (`[O]`, `[OC]`) before
it. A step for another class, race or faction (`[A ...]`, or a quest only they can have) is left
out. A quest whose earlier quests you have not done, or which you do not have and no step has
you take, is out of reach: its steps are shown greyed with what they wait for, and passed over.
A step that names no spot sends you where it is done: the quest's giver or taker, the thick of
what the quest asks for, the NPC it names. Those places, quest names, and which quest needs
which come from the **QuestieDB** addon, the same data the 3D map is built from.

**Done for you**, as set in the list of guides (taken over from Guidelime's settings the first
time the addon sees Guidelime switched on): quests accepted and handed in at the NPC - none,
those of the step you are on, any the guide speaks of, or every quest - and, if you set it so,
the flight a step names taken. A reward to choose is always yours to choose, and holding Shift
at an NPC does nothing for you.

Not there: Guidelime's guide editor, its import of other guide formats, its recording of steps
as you play, notes on steps, markers on the map for every place a quest can be done (the route
goes to one), training skills for you, and custom code in guides (none of the installed packs
uses any). A guide whose text was changed after you ticked steps in it keeps the ticks of the
lines that still read the same.

## Live player link

The map can show where you are in real time, along with your party members.

Addons cannot talk to other programs, so this works in two halves:

1. The **AzerothAtlas** addon (`addon/AzerothAtlas`, installed into the game's AddOns folder
   with the **Install addon** button) draws a thin strip of coloured squares along the top-left
   edge of the game window (6 px tall; 348 px wide when you are alone with no waypoint, 676 px at
   most).
   `/atlas` in game turns it on or off. After the map updates the addon (the button turns
   orange), type `/reload` in game; until then the older addon keeps working.

   The addon's commands all begin with `/atlas`. If another addon has that word already (there
   is an old and well-known one called Atlas), it is left to it, the addon says so once when you
   log in, and `/azatlas` does the same everywhere this page says `/atlas`. (`/azatlas` and
   `/azerothatlas` always work.)

   Before 14 November 2026 the addon was called Forever Map Link. A copy under that name goes
   on working with the map until it is replaced: close the game, press **Update addon**, start
   the game. What it had saved (your settings, your place in your guides) and the guide packs
   converted for it are carried over to the new name, and the old copy is removed
   (`server/legacy.js`).
2. While a map page is open, the server runs a small helper (`server/strip-reader.cs`, compiled
   on first use with the C# compiler that ships with Windows) that reads that row of pixels
   about 18 times a second and decodes it.

The helper reads the **game window's own picture**, through the Windows capture API that
streaming and screen-sharing programs use. So it does not matter what is in front of the game
or where its window is: you can alt-tab, cover it with other windows or move it between
monitors. It only stops while the game is minimized (the game draws nothing then) or on a
loading screen. On a Windows without that API it falls back to reading that spot of the screen,
which needs the game's top-left corner uncovered.

Either way it is only picture capture. It does not read the game's memory, does not modify the
game, and sends it no input; nothing leaves this computer. The only thing it writes on the
game's side is its own addon: the AzerothAtlas folder, and the route mailboxes beside it (see
"The same route in the game"). It is still a third-party tool outside what the game officially
supports, so use it at your own discretion.

What you get:

- **You**: an arrow at your position, pointing the way you face, and a camera that follows
  you (next section).
- **3D figure**: once the camera is closer to you than the distance next to **3D figure
  within** (150 yd by default), the arrow is replaced by a person-sized figure standing in the
  world exactly where you are, with a ring at its feet and an arrow on the ground for the way
  you face. Behind a wall or under a floor it shows through as a silhouette. Untick it to keep
  the arrow at every distance.
- **On a flight path** the figure rides what is flying it: a gryphon for the Alliance, a wind
  rider for the Horde, your figure on its back and its wings beating. It heads the way the
  flight path goes (by the path itself, not by the way the game says you face), noses up and
  down with it and leans into its turns. It is drawn from five times as far as the figure on
  the ground (750 yd by default: it is that much bigger, and the camera sits further off on a
  flight), never narrower than 76 pixels from wing tip to wing tip; further off you are the
  arrow, as on the ground. With the signal lost it hangs where it was last seen, greyed, wings
  still. Which creature it is goes by your side, not by the flight master: a flight on a
  hippogryph or a bat is shown as a gryphon's or a wind rider's. The shapes are the map's own
  (`viewer/js/mount.js`): the game's creature models stand in one stiff pose without their
  animations.
- **Party members**: green dots with names (grey when dead), while they are on your map.
- **Spawn zones**, the NPC filters and the quest explorer use your real level and faction.
- **Where you could be heading**: your guide's step, your own waypoint, your body while you
  are a ghost, and the quest you are tracking are each reported, for the routes.

### The camera that follows you

**Follow me** ties the camera to your character: they stay in the middle of the view, and the
camera goes where they go, switching map when they do. How far off it sits, how steeply it
looks down and from which side are yours to choose, and are kept as you walk:

- **Right-drag or middle-drag** (or Q / E) swings the view around your character; the **wheel**
  zooms on them, wherever the cursor is.
- **Moving the map from under them ends the following**: a left-drag, the movement keys
  (W A S D, arrows, up / down), a double-click on a spot, free-look flying, choosing another
  map from the list, going to a place from the search. A plain click (a marker) does not.
  The **Follow me** box unticks itself.
- **Find me** (the round button at the bottom right of the map) flies the camera to your
  character and ticks **Follow me** again.

Two more switches belong to it, and can only be set while **Follow me** is on (they keep what
they were set to while it is off, and take effect again with it):

- **Turn with me** keeps the way you face at the top of the view. You can still swing the view
  aside with a right-drag; let go and it comes back round to the way you face. Only the
  direction comes back: the tilt and the distance stay as you left them.
- **Auto-zoom** sets the camera's distance by the kind of place you are in, from three
  distances of your choosing: **Indoors, caves** / **Towns, quest areas** / **Everywhere
  else**. The one in force is highlighted, and the number beside the switch is how far the
  camera is from you at this moment (handy for choosing the three). You can still zoom by
  hand: it is left as you put it for about five seconds, then eased back. A new kind of place
  has to last a second or so before the zoom follows it, so a doorway or the edge of a town
  does not make it flicker.

What counts as what is worked out from the game's own data, not from a list of places:

- **Indoors** is the game's own word for it (inside a building or a cave: the same thing that
  decides whether you can mount). Ironforge and the Undercity are the exception: each is one
  enormous building, and in the game's data every room of it is an indoor room, the great halls
  included. There the map goes by the room you are standing in, as the game itself divides the
  city into rooms: a shop, the inn, the bank or the auction house is a small room (270 to 2,200
  square yards in those two cities) and gets the indoor zoom; the halls, rings and quarters are
  rooms of 4,000 square yards and more, and get the town zoom.
- **A town** is any of the capitals; any named part of a zone that has an innkeeper, or four or
  more people with a job (vendors, trainers, a flight master, a banker...), or that the game's
  own world map marks as a settlement; and anywhere an innkeeper, or three such people, are
  within some 70 yards. Goldshire, Darkshire, the Crossroads and Booty Bay are towns by this;
  a lone vendor by the road is not.
- **A quest area** is within 60 yards of someone who gives a quest open to you, of what a
  quest in your log has you kill, use or collect, of where one is handed in (all from your
  quest log, as for the NPC markers), or of the waypoint you are heading for.
- On a flight path it is always **Everywhere else**.

### Cutaway around you

**Cutaway around me** (or `X`) keeps your character in view by taking off the picture what
hides them, and nothing that does not. What it takes, and when (`viewer/js/cutaway.js`):

- **Something stands between the camera and you.** Walking the streets of Stormwind, nothing is
  cut; step behind a house and a hole opens through it along the line from the camera to you,
  and closes again half a second after you come out. The hole is as wide as what is in the way
  is far from you: the edge of a roof you stand under loses a bite, a house you have walked
  behind gets a window you can see the street through (reaching up to a fifth of the distance
  from the camera to you on every side of that line). Whatever the camera itself has backed
  into goes altogether. Nothing at or below your feet is cut. Whether something is in the way
  is found by casting that line through the triangles each building is drawn with (the
  see-through ones, glass and beams of light, left out) and through the collision shapes of the
  objects (`viewer/js/sight.js`). Not through the buildings' collision triangles: three
  quarters of what Stormwind is drawn with has none (most of its roofs, for one: nobody can get
  up there to walk through them), and a roof hides you whether you could walk through it or
  not.
- **A hill stands between the camera and you.** The same hole, through the ground: a hill, a
  bank, the side of a valley. Whether the ground is in the way is found by following the line
  from you to the camera over the terrain's heights, every two yards (grazing it by less than a
  foot does not count). As with a building, nothing at or below your feet goes, so the ground
  you stand on stays; what stands on the part of the hill that goes (a house, a boulder) goes
  with it, rather than hang in the air; and the cursor points through the hole, so a click
  lands on what you see through it. The ground is only cut where the ground itself is in the
  way: a house that hides you gets its window, the slope beside it stays. Through the hole the
  hill is hollow: what shows is the sky's colour, and the far side of the hill from within.
- **You are indoors.** The ceiling and everything over it are taken off, 3 yards over your
  feet, so you look into the room from above; what is at or below that height stays (the floor
  you are on, the walls, the furniture). A house, an inn or a tower is opened as a whole: its
  roof comes off, not a square of it. In a city that is one enormous building (Stormwind), it
  is the room you are in, by the outline the game gives that room. A hall (a room of 3,000
  square yards and more: a cathedral's nave, a throne room) is opened under its ceiling, at
  most 18 yards up, so that its walls stay. The game has to say you are indoors as well: it
  knows where you really are, the map only how high you seem to be.
- **You are in a city or a cave system under the ground** (Ironforge, the Undercity; in a
  dungeon, which has no ground at all, any building with a big room): the ground over all of it
  is taken off, and everything of it higher than 18 yards over your feet, which is over the
  roofs of its shops. The whole city lies open, as a city above ground does. Step into one of
  its shops and that room is opened over your head as well. A building counts as such a city
  when most of its big indoor rooms lie under the terrain; in a mine or a cellar, it is the
  room you are in that is opened, and the hill over it.
- **Tree tops** go inside a circle around you (30 yards by default: the number beside the
  switch), as before, and along the line from the camera to you. A forest's canopy is in the
  way more often than not, and it has no collision in the game's data, so there is nothing to
  find it by.
- Where the game says you are indoors and the map cannot make out a room (a tent, the hold of
  a boat), and under the ground outside any building, it is as it used to be: everything over
  your head inside the circle.

Which rooms are indoor rooms is the game's own flag on each room, with one catch: to the
game's data the streets and squares of Stormwind are "indoor" rooms as well (it is how the city
is put together). They are lit as the outdoors is, and that second flag is what tells a street
from a shop.

A click goes through what has been taken off: with the roof gone, the marker lands on the
floor of the room.

### Trees

**Trees** (under **Layers & view**) shows and hides the trees, apart from everything else that stands
in the world (**Objects**: rocks, fences, tents, lamp posts, furniture). Switch them off to see
the ground under a forest.

The game does not say which objects are trees. The map works it out when it is built
(`extractor/trees.js`): from the name a model carries inside itself ("AshenvaleTree03",
"DurotarPalm02"), where it has one, and for the tenth that have none (the big canopy trees of
Elwynn, Duskwood and Stranglethorn among them) from the shape: tall, about as wide as tall,
and a good part of it foliage. Stumps, logs, saplings and bushes are not counted: they hide
nothing. Checked against the file paths the community has collected for the game's files, of
some 350 standing trees it misses 5 and takes 6 things that are not trees (two fountains, two
giant flowers, a bat roost, a hanging brazier).

A map built before this was added does not have the list: press **Update map** once (it reads
each object once more for it; nothing is converted again). Until then the **Trees** switch is
greyed out, the trees are shown and hidden with the other objects, and the cutaway's circle
takes the tops of all objects, as it did.

### How your height is known

The game tells addons where you are on the map but not how high: in this client `UnitPosition`
gives no usable height. (If a future version does report it, the addon already sends it and the
map uses it directly.) So the height is worked out (`viewer/js/height.js`) from what the game
does report, which besides your position is whether you are on a flight path, swimming, falling
or indoors, and from what the map data knows.

**On a flight path** (the game says so) your height is the flight route's own: every route is
in the game data as 3D points, and the map follows the same curve through them. Where it sets
you down you are on the ground at the flight master's height, which is also in the data, so you
arrive on the platform and not under the city. Zeppelins and boats have no such flag, so they
are recognised by moving along one of their routes faster than you can travel yourself.

**Walking**, the map retraces the way from your previous position in quarter-yard steps over
the surfaces you could be standing on (the terrain, the floors, stairs and bridges in the
buildings' collision data, and the surface of deep water) and stays on the ground as it rises
and falls:

- only surfaces with room for a character above them count, so the floor underneath the first
  treads of a staircase, or under a counter, is not somewhere you can be;
- if the ground carries on at about the same height (a tread up or down), you are still on it.
  That is what takes you up a staircase even though the floor carries on underneath it;
- if something stands between your feet and your head, you have stepped up onto it;
- if the ground ends, you have dropped to the next surface below, but only once the game has
  reported you **falling** for long enough to cover the drop. Without that you are taken to be
  on something the map does not have (a bridge or platform that is a prop, a ship's deck) and
  your height is kept, for up to 20 yd of travel;
- the storey above is never any of these, so it stays over your head.

**In water** too deep to stand in you are at the surface: the game says when you are swimming.
On deep water without swimming, something is carrying you (a boat), and the first pier within
reach above the water is where you step off.

**Arriving with no way in between** (hearthstone, teleport, login, a new map), in this order:
the height saved for your last position if you are still there; the height you had when you
walked through that place before (floors of buildings you have been in are remembered in the
browser, so hearthing back to an inn you have walked around in puts you on the right floor); a
flight master's if
you are beside one; otherwise the topmost surface outdoors and the lowest sensible floor
indoors.

Limits that come from the game, not from this tool:

- The game only tells addons the position of you and your group, never of creatures or other
  players, so live enemy positions cannot be shown (spawn zones show where they are stationed).
- Inside dungeons and raids the game may hide your position; the map then only switches to
  the right map.
- Lifts move you up or down without walking, falling or a route to go by, so after one the
  height can be a storey out until you have walked about 20 yd, gone outside or used stairs.
  The same goes for a first arrival indoors somewhere you have never walked, when the guess
  picks the wrong storey.
- Under water the depth is not known; you are shown at the surface.
- The game must not be minimized (and the strip not hidden by a loading screen).

### Under a mountain

Ironforge's streets are 330 yards under the terrain, and its floor has gaps in the map's data
where nothing is walkable: the foot of every pillar, the sides of the king's dais, the walls.
The tracker's last resort, when there is no ground at your height or below, was to take the
lowest surface above, which there is the mountain top. Crossing one such gap after the tracker
had already lost the floor for a moment (stepping off the dais) put you on the mountain, and
every NPC you then talked to was "corrected" up there with you. Now a rise of more than four
yards is never taken while the game says you are indoors and it would put you under the open
sky; and inside the bounds of a building it is only taken after twenty yards of travel with
nothing at your height or below (which is what a lift leaves you with), not at the first gap.
In the open, with nothing over you but sky, a lift still carries you up after a step or two.

The camera follows you in. While you are under the terrain, the level you stand on (not the
mountain over it) is what the cursor points at and what the camera may not go under, within 300
yards of you: so the wheel zooms right in to you inside the mountain instead of stopping at its
surface.

### Cellars, caves and mines

Where you go down below the ground (the cellar of a keep, the mouth of a cave or a mine, the way
into the Undercity) the game cuts a hole in the terrain, and there are 480 such places on the
two continents with a floor more than three yards under where the ground would have been. The
map draws those holes, and the walkable-ground data leaves them out, but the height tracker used
to ask only how high the terrain was, which has an answer inside a hole too. So on the way down
the stairs it found "ground" a yard under the hall floor and stayed on it: the map showed you
on the ground floor while you walked about the cellar, and climbing back out looked like going
up a storey. The terrain inside a hole is no longer something to stand on. A test walks down
and back up at a spread of these places (cellars, cave mouths, mines, tunnels; 20 of them) and
the height follows at every reading.

## Data for route planning

The extractor keeps what a pathfinder needs, in `dataDir`:

| File | Contents |
| --- | --- |
| `maps/<id>/t/<col>_<row>.bin` (`WFT1`) | Per tile: section 1 heights (129×129 corner + 128×128 centre, float32), 2 normals, 4 holes (per chunk, 8 rows × 8 bits), 5 chunk flags + area id (flag `0x2` = impassable), 6 liquid layers (type, level, per-quad existence, per-vertex heights), 7 object placements |
| `maps/<id>/areas.bin` | Area id per terrain chunk for the whole map |
| `maps/<id>/wmos.bin` | Every building placement (position, rotation, scale, world bounds) |
| `maps/<id>/nav/<col>_<row>.bin` (`WFN1`) | Where a character can stand, per tile, on a 512 x 512 grid (1.04 yd). Sections (each deflated): 2 number of floors per cell, 3 floor heights (uint16, 1/8 yd, +2048, stored as differences), 4 flags per floor (1 swim, 2 lava, 4 terrain, 16 / 32 / 64 / 128 = leads on to the cell east / west / south / north) |
| `maps/<id>/creatures.bin` (`WFC1`) | Stationed creatures: section 1 JSON (`creatures`: name, `min`/`max` level, `rank`, reaction to Alliance `a` and Horde `h` (0 friendly, 1 neutral, 2 hostile), `est` level estimated, `u` = no side recorded (new to this game: shown only when asked for), `t` = these spawn points are inside a town or city of the Alliance (1) or the Horde (2) and make no zone for that side), 2 spawn points (float32 world x, y), 3 creature index per spawn point, 4 patrol route points, 5 routes (`creature, firstPoint, count`) |
| `models/wmo/<id>.bin` (`WFM1`) | Section 2 vertices (36-byte stride, position first), 5 collision triangle indices, 6 the game's per-triangle flags (`0x08` collision, `0x20` render, `0x04` detail, `0x02` no-camera-collide), 7 interior object placements, 8/9 interior liquid surfaces |
| `models/m2/<id>.bin` (`WFM1`) | Section 4 collision vertices, 5 collision triangles |
| `maps/<id>/npcs.bin` (`WFP1`) | Every creature and quest object with somewhere to be: section 1 JSON (`entries`: `id`, name `n`, title `s`, levels `l`, rank `r`, reaction to Alliance `a` and Horde `h`, `u` = side not recorded, job flags `f`, `ct` what kind of thing a creature is (the reference database's number: 1 beast to 9 mechanical), quests started `qs` and ended `qe`; `k: 1` = an object), 2 spawn points (float32 x, y, z; z is NaN where not known), 3 entry index per spawn point, 4 how each height is known (0 not known, 1 likeliest of several, 2 only place to stand, 3 reference database, 4 reference and ground agree). `unplaced` in the JSON names who QuestieDB lists on the map that neither source could place |
| `quests.json` | Every quest: name `n`, level `l`, from level `m`, side (1 Alliance, 2 Horde, 3 either), who starts (`s` NPCs, `so` objects, `si` items) and ends it (`e`, `eo`), its text `t`, what it asks for (`oc` creatures, `ok` kill credit, `oo` objects, `oi` items), what comes before and after; from the reference database, where it has the quest: `nd` how many of each (`[kind n / o / i, id, count]`), `ty` its type (elite, dungeon, raid...), `tl` its time limit. Plus `items`: those quests ask for, with what drops them (`d` creatures, `o` objects, `v` vendors) and how often (`dc`, `oc`: per source `[per cent, how many at a time]`); `mobs`: every creature a quest has you kill or that drops something wanted (`sp` spawn points, `lv` levels, `rk` rank, `hp` health, `ct` kind, `rs` seconds to come back); and the name and first position of every NPC and object mentioned. `source` and `reference` name the two databases |
| `user/npcs-seen.json` | Where you have seen NPCs stand for yourself (see "Seen in game"). Never touched by a map update |
| `sources/classic-db/` | The reference database as downloaded, with a note of where it came from |
| `world.json` | Area names/hierarchy, zones with world rectangles, points of interest, liquid types (water / ocean / magma / slime), **flight masters and flight paths with their full 3D route points** (boat and zeppelin routes too; `pointMaps` says which map each point is on when a route crosses continents), `transports` (each boat / zeppelin line: its stops with map and position, seconds to the next stop, seconds for a full round), `portals` (doorways between maps, from `extractor/doorways.json`, or ShortestPathForever's `Data/Portals.lua` where that addon is installed), `inns` (every innkeeper: map, zone, position, reaction to each side; from QuestieDB), area triggers (dungeon entrances and other transitions) |

World coordinates are the game's: +X north, +Y west, +Z up, in yards. A tile is 533.33 yd and
`col`/`row` map to world space as `X = (32 − row) × 533.33`, `Y = (32 − col) × 533.33` at the
tile's north-west corner. Container layout is described in `extractor/container.js`.

The route planner (see "Route to your waypoint") runs in `viewer/js/navworker.js` (the search,
on any map), `viewer/js/route.js` (the journey: flights, boats, zeppelins, tram, portals,
hearthstone; drawing) and `viewer/js/trips.js` (a route to each place you could be heading for).
The quest explorer and its estimates are `viewer/js/quests.js`.
`extractor/transit.js` reads the boat and zeppelin lines and the doorway list.

## Running beside the game

The map is meant to sit on another monitor while you play, which means sharing the graphics card
with the game, and Windows serves the window in front first. Measured with the game in front
and using over 90 % of the card: the page's own code takes about 2.5 ms a frame and is idle
nine tenths of the time, but each frame took 140 ms on average (up to a second) to come back
from the card, while the page went on sending sixty a second. Frames queued up, so the picture
fell behind and then froze while the queue drained. The map therefore:

- does not begin a frame until the card has finished the last one;
- draws at most 30 times a second while it is not the window in front;
- drops to 75 %, then 50 % resolution while the card is still slow to hand frames back (the
  line under the layer switches says so), and returns to full resolution when the card has time
  again, or at once when you click on the map;
- asks Windows for a picture of the game window only as often as it reads one (about 20 a
  second), instead of a copy of every frame the game draws.

With that, frames come back in about 20 to 30 ms and the long freezes are gone. What is left is
the card itself: if the game is drawing as fast as it possibly can, anything else on that card
waits its turn. Capping the game's frame rate (its own "Max Foreground FPS" setting, or vertical
sync) leaves room for the map and usually costs nothing you can see.

## Credits

The map is built from your own installed game. What else it draws on, and where each comes from:

| What | From | How it gets here |
| --- | --- | --- |
| Creatures, NPCs, quests, where they stand | **QuestieDB** (the addon) | Read from your game's AddOns folder when the map is built. Not included |
| NPC heights, what quests ask for, drop rates, creature health and respawn times | **cmangos classic-db** | Downloaded when the map is built, kept in the map data. Not included |
| The layout of the game's data tables | **WoWDBDefs** (wowdev) | Each definition is fetched the first time it is needed, kept in `extractor/dbd/`. Not included |
| The doorways between maps (`extractor/doorways.json`) | **ShortestPathForever** by cjber, `Data/Portals.lua` (GPL-3.0-or-later) | Included; the addon's own, newer list is read instead where it is installed |
| The timetables of boats, zeppelins and the tram (`viewer/transit.json`, `addon/AzerothAtlas/TransitData.lua`) | **DockWatch** by Wyveryx (MIT), recorded in the game; **NauticusClassicResurrected** (MIT) by way of **ForeverTransport** by Stilo | Included |
| Guides in the game | Guide packs written for **Guidelime** | Read from your game's AddOns folder. Not included |

## Known limits

- Ground texture is the game's baked per-tile colour map (≈1 texel per yard), so it is softer
  than in game when the camera is right at ground level.
- Objects are drawn in their rest pose (no animation, particles or lights); skin-swapped
  textures on a few props fall back to a neutral colour.
- Content the game ships encrypted (unreleased areas) is skipped automatically.
- With both continents on the picture, NPC markers are those of the map in hand; the other
  continent shows them once it is taken in hand (look at it closely, or choose it from the
  list). The route is drawn on both.
