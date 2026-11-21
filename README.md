# Azeroth Atlas

A local 3D map of the WoW Forever world — like Google Earth for Azeroth — rendered with
WebGPU. Everything is read from **your own installed game** (read-only), so the map is the same
geometry the game uses: exact terrain heights, the real buildings and objects in their real
positions, water, zone names and in-game map coordinates.

## Get it and run it

Azeroth Atlas is an application for Windows that runs beside the game. You need:

- **WoW Forever** installed through Battle.net;
- about **4 GB** of disk space for the map data;
- a connection to the internet while the map is built. NPCs, spawn zones and quests come from
  QuestieDB, which the map fetches for itself: you do not need that addon in the game, or to
  keep it up to date, for the map's sake (see "Where QuestieDB comes from").

Then:

1. **Download it**: https://github.com/madesai98/Azeroth-Atlas/releases/latest , the file
   **Azeroth-Atlas-Setup.exe**.
2. **Run it.** (Windows may say it protected your PC, because the program is not signed:
   **More info → Run anyway**.) It installs for you alone, with no questions and no
   administrator rights, puts **Azeroth Atlas** in the Start menu and on the desktop, and opens
   the map in a window of its own. There is nothing else to install: no Node.js, no browser.
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
data unless you chose another place for it, a log of what the map's server said
(`server.log`, in place of a terminal), and its notes of what it did (`logs`: see "Reporting a
problem"). So a newer copy of the application can take the place of the old one, or be put
anywhere else, and nothing is lost.

**Rather not install anything?** The file **Azeroth-Atlas-win-x64.zip** on the same page is the
same application as a folder: unpack it somewhere of your own (your Documents or Desktop: not
Program Files, and not inside the game's folder) and double-click **Azeroth Atlas.exe**.

Installed, the application is in `%LOCALAPPDATA%\Programs\azeroth-atlas`, and is removed like
any other (Windows' list of installed apps). Removing it, or installing a newer one over it,
leaves what is yours where it is; delete `%LOCALAPPDATA%\Azeroth Atlas` yourself to be rid of
the settings and the map data too.

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

**Check for updates** (the button at the bottom of the sidebar) sees to everything in one go,
in turn, and leaves alone whatever is already up to date:

1. **Azeroth Atlas itself**: looks whether a newer version is out, and puts it in.
2. **The map's data**: builds again what has changed - a new game patch, a newer QuestieDB, a
   map tool that builds some of it differently. (The first time, this is the whole map.)
3. **The addon in the game**: installs it, or updates it to the one that came with this version.
4. **Your guide addons**: Guidelime and RestedXP are each taught to ask the addon which floor
   you are on - again, where one was updated since (see "Guides in the game").
5. **QuestieDB, Questie and Auctionator**, for each whose box is ticked under **Other addons**:
   what the map has in the game for it is brought up to date (see "What your other addons ask
   of QuestieDB, Questie and Auctionator"). With no box ticked, this step does nothing.

Each is reported in a line under the button, with what is left for you to do in the game
(`/reload`, or a restart). The page may load itself again in the middle (after an update of
itself, or a new map): it carries on from where it was. The separate buttons further up - Update
map, Update addon, Teach (a guide addon) - do the same things one at a time.

**The map tool also keeps itself up to date without being asked.** When it starts, and every six hours while it runs, it
looks whether there is a newer version where it came from, and if so puts it in by itself: the
server starts itself again and the page reloads, with nothing to restart by hand. The line under
the **Update map** button says which version you have and when it last looked; **look now**
looks at once.

| Your copy | How it is updated |
| --- | --- |
| The application (installed, or unpacked from its zip) | As the next line: the map tool's files inside it (`resources\app`) are plain files. The frame round them (the window, the built-in Node and browser) only changes with a new download from the releases page, run or unpacked over the old one, which is seldom needed |
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
`config.json` makes it only say that a newer version is out, with a button to put it in (and
**Check for updates** puts it in). `"autoUpdate": "never"` is for a working copy of your own
that is not a git checkout: nothing will ever write a published version over it.

**Publishing a new version** (for whoever keeps the repository): commit and push to the `main`
branch. Everyone's copy picks it up within six hours, or at its next start. The first time,
`node tools/publish.mjs https://github.com/<you>/<repository>` writes the address into
`package.json` (copies that are not git checkouts look there for where they came from),
commits, and pushes.

**A new download of the application** is built and published by GitHub itself when a tag is
pushed (`.github/workflows/release.yml`): `git tag v0.3.0 && git push origin v0.3.0`. That is
only needed when the frame should be newer; `npm run dist` builds the same two files here
(the installer and the zip), into `dist`.

### It keeps itself current

When the map's own code is updated, nothing has to be restarted or reloaded by hand (run from
`Start Map.bat`, leave the window it opens running):

- **The server starts itself again.** The application and `Start Map.bat` both run
  `server/watch.js`, which runs the server and watches the code it is made of (the `server` and `extractor` folders, and
  `config.json`). A change there, and the server is stopped and started anew, a second or so
  later. A map update that is running is left to finish first, and so is a report of a problem
  that is being made. Only a file that has been *written* counts: Windows keeps the time a file
  was last read as well (moved on at most once an hour) and tells whoever watches a folder when
  it does, so being told is only a reason to look at each file's size and date. (Up to version
  0.3.7 it was taken for a change. An hour after its files had last been read the server
  started itself again, four times running, each start reading a few more of them, and so
  every hour; and "Report a problem", which reads every file of the map tool, had the watcher
  take its own file for updated and start the whole application again in the middle of the
  report: "Failed to fetch", and the window gone and back.) If the new code does not start
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
- fetches QuestieDB from the Atlas database where a newer version of it is there, and re-reads
  the creature, NPC and quest data from it and the reference database. The button also turns
  orange when a newer QuestieDB has come in since the last build (the map looks for one a little
  after it starts and every six hours while it runs);
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
| Click | Drop a marker on what is under the cursor: a street, a floor, a roof, or the ground (shows distance from it). It is your waypoint. Where that spot has more than one level, you are asked which |
| Right-click your waypoint, or Esc | Take your waypoint away (also one placed in the game: see "Route to your waypoint") |
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

### The continents and Zephras Isle on one picture

The game keeps the Eastern Kingdoms and Kalimdor as two maps, each with its own coordinates.
Here they are drawn together on one sea, as far apart as the game's own world map has them:
its picture of Azeroth gives each continent a rectangle, and from those two rectangles (they
are in the game's files) Kalimdor comes out 24,000 yards to the west of the Eastern Kingdoms
and 4,800 to the south (whole terrain tiles, so all the maps on the picture lie on one grid).

Zephras Isle is a third map, and the game's world map has no place for it: it is an island in
the sky, its ground some 650 yards up, and the only ways there are the airships from Dalaran,
in the Eastern Kingdoms, and from Skywatcher Plateau, in Kalimdor. All three are open world
that the game joins together, so the island is put on the same picture, out over the sea
between the two continents its airships come from. Where exactly is the map's own choice, not
the game's, and is worked out from the game's files rather than set by hand: the island lies
about halfway between the Eastern Kingdoms' west coast and Kalimdor's east coast (each coast as
far out as that continent's zones go along the stretch of sea the island takes up), and as far
north as puts its two docks level with the middle of Dalaran's and Skywatcher Plateau's, so
that the airships fly across the sea rather than up or down it. That comes to 8,000 yards to
the west of the Eastern Kingdoms and 4,267 to the south, in whole tiles again, with at least
2,600 yards of open sea between the island's tiles and either continent's.

The island keeps its own heights, so it floats over the sea. In the game its ground goes down
in cliffs from the top almost to the height of the sea, with nothing below them but sky; over
the sea of the picture those cliffs would stand in the water and make the island a mountain
in the sea. So it is drawn down to halfway between its lowest dock and the sea (about 320
yards up) and no further: from the side you see it hang in the air. The island has no sea of
its own, and the continents' sea goes on under it at their level. Around the island the game
keeps ground under its holes (the open sky): flat at the height of the sea, and here and there
standing up in walls hundreds of yards high. Close up the holes leave it out; from further off
the terrain is drawn coarser, and a coarse level knows of holes only where a whole tile is
missing. So the island reads the holes of all its tiles once when it is opened (the tiles come
again from the browser's own store when they are drawn close up), and its distant levels leave
them out as well.

Choosing any of the three from the map list shows all three; the first view takes in the
whole picture. The tram and the dungeons are maps of their own as before.

One of them is the map *in hand*: the one the list names, whose NPCs are shown and on which
your route is worked out. It is the map your character is on while the game is running;
otherwise, or after you choose another from the list (which also ends **Follow me**), it is the
one you are looking at (zoomed in: from high up, with all of them in view, nothing changes
hands). The others are drawn in full all the same: terrain, buildings, place names, spawn
zones, your arrow if you are there. The read-out under the cursor and a marker you drop work on
any of them, in that map's own coordinates, and a marker dropped across the sea from where you
stand gets a journey there by boat, zeppelin or airship. A spot counts as the island's only up
on the island: the sea beside it and under it belongs to a continent. A page address still
holds one map and a place on it.

Boats, zeppelins and the airships cross between them (see "Boats, zeppelins and the tram,
live").

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
| `minimap` | `false` = never look at the game's minimap to find you inside a dungeon (see "Inside a dungeon: your place, read off the game's minimap") |
| `autoUpdate` | `false` = the map tool only says when a newer version of itself is out, and puts it in when you press the button (see "Updates"). `"never"` = it is never put in, whatever is pressed |
| `auctions` | Auction prices (see "Auction prices"): `{ "house": "us-110" }` = the auction house this copy shows (chosen on the page); `false` = off altogether |
| `combatLog` | `false` = the game's combat log is never read (see "What a fight shows"); the quest times then go by a round figure for your level, not your own pace |
| `atlas` | `false` = the map is built from QuestieDB and the reference database alone, without what the Atlas database adds (see "The map is built from it") |
| `database` | The Atlas database (see "The Atlas database"): `{ "share": false }` = this copy sends nothing of what it learns; `{ "apply": false }` = what a newer database adds is not put on the map by itself, only when you press **Update map**; `{ "url": "...", "apiKey": "..." }` = another database than the one this version names, and the key to sign in to it with; `{ "maintain": true }` = this copy also makes and publishes the database (the database must list it as a maintainer); `false` = off altogether |

`config.json` is each computer's own: it need not exist, it is not part of what is published,
and an update never touches it.

## How it works

```
extractor/   reads the game archives and writes map data        (node extractor/extract.js)
  casc/        local archive reader: index, encoding and root manifest, BLTE decoding
  formats/     game file parsers: DB2 tables, WDT/ADT terrain, WMO buildings, M2 objects, BLP
  jobs/        builders run on worker threads: tiles, detail pyramid, area grids, models
  questie.js   reads QuestieDB (as fetched from the Atlas database, or the addon in the game's
               folder): creatures, quests, quest objects (spawn zones, NPCs, quests)
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

### What of a building or an object is not drawn

The game never draws a building whole: it draws the parts ("groups") the camera can see from
where it is, through the building's doorways. The map draws every group at once - that is how
you see a town, and the rooms in it, from above. So what the game's files hold and never show
*where you are looking from* has to be left out by the map tool itself (`extractor/jobs/model.js`):

- **Antiportals.** A slab the game hides what is behind a wall with: flagged as one, or simply
  named "antiportal". The game never draws it and nobody can get to it. Drawn, it was a bright
  blue slab through the cathedral of Gilneas. 14 of the game's 964 buildings have one; it is left
  out whole - not drawn, and no ground to stand on.
- **Stand-ins.** The streets and squares of Stormwind are, to the game, indoor rooms lit by the
  sky. Standing in the canals the game does not draw them: it draws a copy of the cathedral made
  to be seen over the walls, larger than the one on the square and not in the same place (and a
  second copy for another direction). Drawn together with the square they were three cathedrals
  in one another. The copies are flagged "nobody can get there" - but so are Darnassus's
  treetops, the shell of Shadowfang Keep's tower and the mountain Stormwind Keep is built into,
  which are all there is of those. What tells a stand-in apart is that it is out of reach
  **and stands over a district that lies under the open sky**. Measured from straight above on
  a 2-yard grid, the two cathedral copies stand 52% and 91% over Cathedral Square; every other
  out-of-reach group of every building stands 0% over such a district. The line is drawn at a
  quarter, for groups of 100 square yards and up. (Neither half of the rule is enough alone.
  21 buildings have such districts, and 63 groups that can be reached stand a quarter or more
  over one - upper rooms over an arcade, a bell tower, the roof over a porch: those are the
  building.) An
  object that only a left-out group owns goes with it (none does today: the copies share
  their trees with groups that stay).
- **Parts of an object that are never seen.** One model holds a door whole and the same door
  broken, an invisible wall, the shape a beam of light or a column of smoke hangs on: the part
  that is not to be seen is drawn fully transparent, which the game takes as "do not draw". An
  object put down in the world plays one animation, standing; a part that is fully transparent
  at every key of that one is left out (`extractor/formats/m2.js`). 63 of the 6,283 kinds of
  object have such a part, 31 of them nothing else - the energy trails of the Caverns of Time
  (up to 520 yards long, and solid), the invisible walls of a battleground, the frames of
  dungeon portals, chimney smoke. Their collision stays as it is: an invisible wall still is one.

What is left out of a building is written into its file (`left` in its header: which group,
its name, why), and `partstest.mjs` holds the rules against the game's own files.

The cathedral of Stormwind keeps one oddity that is the game's own: it is bigger inside than
outside. The front on the square is the only outside it has; its nave, side rooms and crypts
lie behind and beside that front and are seen there from above, as rooms with no building
round them (the copies never covered them either). Stormwind Keep has no such trouble: its
rooms are inside the mountain the game shows for it, towers and all.

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

Where the data comes from: positions, levels and patrol routes are the community's
**QuestieDB** (the same database quest helpers use), fetched and read when you press **Update
map** (see "Where QuestieDB comes from": no addon is needed for it); which side a creature
attacks comes from the game's own faction table. Where QuestieDB could not be fetched and is
not an addon in the game either, the rest of the map works and this section says so.

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
the 3D world: a sign over each head - for quests, a big 3D mark (below) - faint where a roof or a
hill is in the way.

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
  ends, **among those the switches leave**, at any distance; Enter flies to the nearest. Under
  the box it says how many it found and how many more by that name are switched off, with a
  button to clear it. One letter is not searched for. (Until 0.5.0 a search set the switches
  aside: one letter that strayed into the box - a key meant for the camera - showed everybody
  and everything, and looked like the switches had stopped working. The box also lets go of
  the keyboard now when you leave the window.)

**Close up they are figures.** Within the distance set by **3D figures within** (the same one
that turns you from an arrow into a figure), everyone stands in the world as a person-sized
figure on the floor they are on, in the colour of their sign, and quest objects as small crates;
the sign, smaller, sits over the head. Elites, rares and bosses are bigger. From further off
they are the signs alone, which read better from a height. A figure can be pointed at and
clicked anywhere on its body.

**The signs of quests are big 3D marks** (from 0.6.13), so that where to go stands out at a
glance:

| Mark | Over |
| --- | --- |
| a big gold **!** | whoever gives a quest open to you |
| a big gold **?** | whoever takes a quest of yours that is finished - grey while it is not |
| crossed swords, steel with red hilts | what a quest of yours has you kill, use or collect |
| a blue gem | a quest object (when **Quest objects** is switched on) |

- Each is a solid, shaded model with a dark outline, so that it stands out of a sunlit forest or
  a snowfield as well as off grass: at least 46 pixels tall however far off, up to 86 close by,
  floating over the head of its figure (over the spot, from further off). In a picture under 900
  pixels tall they are smaller with it, down to a little over half that size: the map as a
  minimap over the game is a few hundred pixels tall.
- They face you, from above as from the side, and stand still. The map draws a picture only when
  something has changed, and a mark that turned by itself would keep it drawing all the time
  beside the game.
- Behind a wall or under a roof they show through, fainter, as the signs did.
- Someone with a finished quest of yours to take and another to give shows the **?**, as in the
  game: it is what you go to them for now. (Where your quests are not known, the **!**.)
- A mark can be pointed at and clicked anywhere on it, and the name of whoever is under it is
  written over it.
- **Big 3D quest marks**, under the switches, turns them back into the small flat signs. The
  other signs - vendors, trainers, flight masters - stay small either way.

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

A map that is one building - a dungeon, the Deeprun Tram's tunnel - has that building placed
from the middle of the world, where everything on a map with ground is placed from the map's
corner. (Until version 0.3.5 the map tool placed it from the corner too: the building stood
17,067 yards north and west of everyone in it, and from where you stood in the tram's tunnel
there was nothing to see but your arrow and the tram's cars. The page now puts right a map
built so, without its being built again.)

A dungeon has no zone map to give a spot on, so QuestieDB lists who is inside but not where. On
any map where it places nothing (dungeons, raids, the Deeprun Tram, the PvP halls), the
reference database's spawns are used outright, for the creatures and quest objects QuestieDB
knows: position and height both. The dungeon's own ground data bears them out almost
everywhere (the Deadmines 182 of 182, Scarlet Monastery 373 of 373, Naxxramas 1,208 of 1,263;
and, of the dungeons that are one building with no terrain, Blackrock Depths 1,191 of 1,193,
Dire Maul 1,123 of 1,124, the Stockade 28 of 28). A dungeon that is new to this game, or has
been rebuilt, is not in the reference: nobody can be placed there, and the NPC section says who
is known to be inside.

**Who is inside, where nobody is placed.** The game's own files list every dungeon's and raid's
bosses, in the order they are met (343 of them on 43 maps), and the Atlas database knows of many
creatures which dungeon they are in without knowing where. The NPC section says both under the
switches: the bosses by name, and how many more are known to be inside with no place yet. A
creature that is on the game's list is marked **boss** on its card, wherever it was placed from.

**They are placed as people fight them.** The game tells an addon nothing of where anything is
inside a dungeon, your own place included. Its combat log does (see "What a fight shows"): where
a creature was when a fight with it began, to the yard. So a dungeon fills in as it is run, by
anybody whose copy of the map shares what it learns: every copy gets the places the others
found. They come with no height; the map takes it from the dungeon's own ground, which every
dungeon now has (see "Data for route planning").

**Where you are, inside.** In a dungeon that is one building the map finds you on the game's
own minimap, several times a second, and holds each place against how far you can have walked
since the one before (see "Inside a dungeon: your place, read off the game's
minimap"). With every blow of yours the combat log also says where you stood: that is what
there is to go by in the dungeons the minimap cannot be read in (those that stand on open
ground: the Deadmines, Scarlet Monastery, Stratholme and the like), where the map shows you
there for a quarter of a minute after each blow - enough to see where the fight is, not a place
that follows you between fights - and it is what the minimap's reading is held against.

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

**Someone who is not where the database has them.** This game has moved some people, and built
some places anew. QuestieDB has Archmage Ansirem Runeweaver at the gate of ruined Dalaran, where
a wall of the city this game built over it stands now; he is inside. Kept as one more place, the
old one stayed on the map, and the way to him led to whichever of the two was nearer you - from
the south, the wall (reported 21 November 2026). So where the databases put someone in **one
place only**, and they are met forty yards or more from it, and nobody has met them at that
place, the place is **moved** to where they were met rather than one more being added. The map
says so: "Archmage Ansirem Runeweaver: 372 yd from the one place the database has them, so not
there in this game. Moved here, 110.8 yd up."

- Someone the databases put in several places (a guard, someone who walks a round) gets one
  more place, as before; the ones they had stay.
- Someone met at their one place as well keeps it: Archmage Tervosh is in his tower in
  Theramore and, for a quest, out in the marsh, and both stay. So does someone whose level a
  fight there settled.
- The map build does the same with every copy's sightings (below), so once one player has met
  someone, everyone's map has them there; and `quests.json`, which keeps one place for each
  person a quest involves (the way to them from another continent), has that place too.
- On the data as it was on 21 November 2026 it moved seven people, all in the Eastern Kingdoms:
  Ansirem (372 yd), Afadra Dunwall (from Dun Morogh into Ironforge, 1,311 yd), the Lost Horse,
  a Stormwind Harbor Guard, Thomas Miller and Sognar Cliffbeard (both walk a round), and Donald
  Rabonne (67 yd).
- It needs the map built again once (application 0.6.12: the page offers **Update map**, for a
  newer map tool). Until then the map has both places, as before.

The same goes for **an object you take things out of**: a chest, a herb, a vein of ore, a crate
for a quest. When its loot window opens the addon says which object it is, and the map notes it
where you stand, as it notes someone you talk to. (What you fish up comes out of your own float,
and what you take from a creature is the creature's: neither is an object anywhere.) Most of
this game's new chests and nodes are placed by nobody else.

**What an object asks, and what it is to a profession.** An object's card says what it takes to
open it - **needs Herbalism 70**, **needs Mining 155**, **needs Lockpicking 150 or a key** - and
whether a profession works at it (**counts as: Anvil**, Forge, Cooking Fire, Moonwell). Typing
"herbalism", "mining" or "anvil" in the search box finds them. Where it comes from: the game's
files hold every lock (its table `Lock`: up to eight ways in, each a key or a skill at some
level) and every kind of thing a profession works at (`SpellFocusObject`), but not which object
has which. That the server says when the object is met: the game's cache has it for every
object some copy's player has come across, and the reference database for the original game's.
Put together they name it for 316 kinds of object on 27,393 spots (118 herbs, 62 veins, 42
locked chests and doors, 93 that only a key opens), and for 2,070 cooking fires, 216 anvils and
86 forges. Of a lock's ways in only a player's own skills are told (picking locks, herbalism,
mining, fishing) and keys; the game's table also lists a key for four kinds of ore vein - an
axe, Rockslicer - which opens nothing, and is left out.

**What other players have seen** is on your map too: the Atlas database puts every copy's
sightings together, and the map build lays them over the spawn points like your own (height
source **seen in game by another player**). Yours, where you have one of the same spot, is believed
first; and someone the reference database places stays as placed, whoever saw them where -
unless they were met only far from that one place: then they are moved, as above. The
level another player fought a creature on comes the same way (**fought on this level by another
player**: see "A creature you fight" below).

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

**A creature you fight** opens no window, so until 0.5.2 a fight put nothing right: Nimsy, in
the Fargodeep Mine, stayed on the lowest of the three levels the map found at his spot (a
guess) however often he was fought on the middle one. From version 25 the addon also says who
you fought, at the moments you are surely beside them:

| When | How near |
|---|---|
| you loot it | you are standing over it |
| the fight ends with it dead and still your target | within ten yards, by the game's own measure |
| it is your target, a foe, and after you | within ten yards |

A fight says less than a talk (a creature is fought where it was chased to, and ten yards can
be the floor above), so the map lets it settle one thing only: **which level** a creature is
on, where that was the map's own guess.

- Of that creature's spawn points within 30 yards of you: if one is on your level already,
  nothing is touched (it may well be the one you fought).
- Otherwise the nearest whose height the map guessed is put on the floor **at its own spot**
  that is on your level, if there is one there and no other floor at that spot is about as
  near your height. It is then marked "seen in game: you fought them on this level", and the
  map says what it did ("Nimsy: you fought them on this level. Height corrected from 5.4 to
  28.2 yd (it was a guess).").
- Nobody is added for a fight; nobody the reference database places, or you have talked to,
  is moved; your own height is never put right by one; and nothing happens unless the map is
  sure of your own height.
- What a fight settled is kept in the same file on your disk and laid over the data each time
  the map loads.
- It goes to the shared database as a fact of its own kind - "a creature of this kind is on
  this level at this spot" - and not as a sighting, which says "this NPC stands here" from
  someone who stood beside them and talked. Where the copies that fought it at a spot agree
  on the level (what most say; two levels said by as many settle nothing), every copy's map
  build puts that spot on the floor of its own nearest that height, if it has one within
  three yards, and marks it **fought on this level by another player**. That touches only a
  height the map had guessed or taken from its one floor there: nobody is added, nobody is
  moved across the map, nobody the reference database places is touched, and on your own map
  a fight or a talk of your own still counts for more.
- In a game that will not tell an addon how near a creature is while you fight, only looting
  says it. Either way it needs version 25 of the addon (**Check for updates** installs it;
  then `/reload` in game).

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
| **QuestieDB** (this game's own data; fetched from the Atlas database: see "Where QuestieDB comes from") | Every quest: its name, level, side, words, who gives and takes it, what it has you kill, use or collect, what comes before and after it; where everyone and everything stands |
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
- **Killing**: a creature's health over what you deal in a second, and the time from one kill
  to the next. A creature below you goes down faster, one above you slower (8% a level). The
  level counted is yours when the quest is one for your level, else the quest's own.
  - **What you deal is your own**, where the game's combat log has it (asked for on 21 November
    2026: "each user can keep track of their own rolling average DPS and use that in the
    estimate for time to kill instead of some kind of idealized simulation"). The map follows
    your fights as the game writes them and keeps the last sixty you fought alone: how long
    each lasted and what you dealt in it. Sixty fights are an hour or so of questing, so the
    figure moves with you as you level and change what you wear. It is kept as how many times a
    round figure for your level you deal (about 19 a second at level 10, 58 at 30, 135 at 60),
    so that it carries to creatures above and below you and to quests of levels you have yet to
    reach. The same fights say how long you are from a kill to your first blow at the next -
    looting, getting your breath, walking over. The card says what was used: "Fights at your
    own pace: 120 damage a second over your last 60 fights alone (1.4 times the round figure
    for level 38), and 19 s from a kill to your first blow at the next."
  - Until eight such fights have been read, and for a character of yours none are kept of, it
    is the round figure, with a third of the fight and 12 s from one kill to the next - and
    the card says that instead, and how many fights there are so far. The game keeps its log
    when the addon asks it to (see "What a fight shows"); only fights fought while the live
    link is on are kept, since it is the link that says which level you are (the log's own
    "level" of a player turned out to be the level of what they wear: 28 for a character of
    level 37).
  - A fight is yours alone when nobody else dealt a tenth of it and you dealt most of the
    creature's health. Two creatures at once are one fight with two kills, its seconds counted
    once. Not kept: a fight you died in, one the creature got away from, one in a group.
  - **A creature's health** is what a fight in this game measured, where one has: yours, a
    moment after the fight, or anybody's by way of the Atlas database. Else it is the original
    game's raised by what this game adds at the creature's level: nothing up to level 8, 5% at
    level 10, 30% from level 20 on (measured in the logs: every creature of one level fought so
    far has exactly those; between 11 and 20 the straight line between them is taken). The card
    says which: "1,867 health (the original game's, and the 30% this game adds at that level)".
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

**Held against the game's own log** (21 November 2026, on the question whether the times are too
short). Thirty-two hours of one player's combat log - 937 creatures killed, 459 of them alone -
and the application's notes of one evening of a level 37 character, beside what the reckoning
said of the same creatures and quests:

- **A fight**: for the level 37 character real fights came to 1.3 times the reckoned, all
  together, by two errors that nearly cancelled. Creatures here have 1.3 times the original
  game's health, and it was the original's that was counted; and the player dealt 111 a second
  to a creature of their own level where the round figure says 74. A level 14 character dealt
  15 where it says 26: for them a fight was reckoned at half what it takes. Hence your own
  pace and this game's health, above.
- **From one kill to the next**, while at it: one every 37 s, reckoned at 33.
- **A quest that is only kills** came out right: ten Lashtail Raptors, six minutes reckoned,
  six taken.
- **An evening did not.** Ten quests were handed in, reckoned at an hour and a half in all, in
  6.3 hours in the game - of which 35 minutes were fighting, 24 were spent dead and ten on
  flight paths. Not all of those hours were questing (they were not measured as such), and the
  figure for a quest was never meant to hold what lies between quests. But what the reckoning
  leaves out is most of an evening.

What it leaves out, or has too low, and has **not** been mended by the above - plainest first:

- A thing to open or pick up is counted at 18 s each, and nothing for the creatures that stand
  around it or the way from one to the next. Eight Stolen Shipments: 2 minutes reckoned, 46
  from tracking the quest to having them (other quests were done on the way, so that is not a
  measurement of the eight either).
- The way is the straight line and a quarter until you plot the route, and the way from where
  one quest ends to where the next begins is not counted at all.
- Dying, and the walk back.
- The creatures in the way that no quest asks for, and the kills beyond the reckoned number
  when the drops are unkind (23 Lesser Water Elementals for six bracers, 16 reckoned).

So the times are best read as what a quest takes once you stand in front of what it asks for:
good for comparing quests, fair for a quest of kills, too short for one of things to be found,
and not a count of how many you will have done by midnight. The median quest comes to 5
minutes, three quarters are under a quarter of an hour.

Tried: the server's following of fights, with logs written in the game's own layout (32 checks:
a fight alone, two creatures at once, somebody else's hand in it, a pet's blows, a fight left,
dying, the time to the next, the last sixty of seventy, another character, what is on the disk)
and with the three real logs put through it as if they were being written (87 fights kept of
the level 37 character's known hours: 120 a second, 1.4 times the round figure, 19 s between -
the same as counting them by hand); the page's reckoning with the server's answer stood in for
(15 checks). That the reader keeps the same facts of creatures as before was checked on the
same logs. **Not seen yet**: the figure building up from a game being played, with the live
link saying the level.

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
| **Tracked quest** | yellow | the quest you are tracking in the game (the one its objective tracker has picked out): the nearest of what it still has you kill, use, collect or go and look at, or, once it is ready to hand in, who takes it |
| **Waypoint** | blue | the last waypoint you placed yourself: a Ctrl-click or Shift-click on the game's map, or a click on this one |
| **Corpse run** | red | your body, while you are a ghost. On foot all the way: a ghost takes no flight |
| **Party members** | purple | each member of your party who is on your map |

- **The colours are yours to change**: click the swatch beside a route. A flight is always a
  light tint of its route's colour, so you can tell whose flight it is.
- **They are all drawn at once, here and in the game**, each in its colour: placing a waypoint
  does not take your guide's route away, nor the other way about.
- **One of them leads**: your own waypoint while you have one, else your guide's step (see
  below). That is the one the Routes section describes step by step, and the one the game
  *follows* (its arrow, its list of steps, the line that goes as you walk). The others are
  drawn beside it, a little thinner. Switching the leading one off leaves the others.
- **There is one waypoint of your own**, wherever you place it: a Shift-click or a Ctrl-click
  on the game's map, a click on this one. Each new one takes the place of the one before.
- The tracked quest's route is worked out from the NPC data of the map you are on: what a quest
  asks for is looked up there, and the nearest of it is where the route goes. **Where none of
  the quest's business is on that map, it goes to another map**: a Westfall quest while you are
  on Zephras Isle (you used your hearthstone with it tracked) is a journey to Westfall, by the
  airship, the portal and a flight. QuestieDB gives one spot for every NPC and object a quest
  involves, on whichever map it is (`quests.json` keeps it), and that spot is where the journey
  goes; with several, the ones in the zone the quest is filed under come first, then the map
  most of them are on, then the one in the middle of the rest. Once you are on that map, its own
  data takes over and the route goes to the nearest. It used to stop there: on another map than
  its business, the quest had no route at all.
- **A quest that is done inside a dungeon is led to the dungeon's door.** Nothing it asks for is
  on the map you stand on outside, and in a dungeon new to this game nobody can be placed at
  all; the route used to go to who takes the quest then, with nothing of it done ("Old Ironforge
  Incursion: hand in to King Magni Bronzebeard", for a head still on its owner's shoulders in
  the Hall of Thanes). QuestieDB files a quest under its dungeon and lists where each dungeon
  is entered from (63 of them have a door in this game's world); the map's data has those doors
  (`world.json`: `dungeons`), and the route goes to the nearest: "Old Ironforge Incursion: The
  Hall of Thanes, the way in". A door is a spot on a zone's map, with no height: where there are
  several levels there, the route ends on the one the walk reaches. Inside the dungeon the game
  hides where you are, and there is no route. QuestieDB's door is a pin on a zone's map, and can
  be a good way short of the door itself: Gnomeregan's is by the top of the lift, three hundred
  yards and the lift's ride from the door, and from the door "the way in" led back up and out.
  So where the game's own tables name the spot (the one a ghost goes back in at, below), that
  spot stands in for every pin within 600 yards of it.
- **Dead in a dungeon, the run back leads to the dungeon's door.** Released, you are a ghost at
  a graveyard outside and your body is inside. For a dungeon of the original game the game says
  where a ghost goes back in (its own table of maps: 27 dungeons), and names that spot as your
  body's place. For one new to this game it says nothing: the addon was told of no body, and
  there was no corpse run at all. The page now knows which dungeon you were in when you were
  last heard from in one, alive or dead (the game says which map you are on there, though not
  where on it): a ghost outside it, your body is in it, and the run back goes to where the game
  has a ghost go back in, else to the dungeon's door as QuestieDB has it ("Your body, in The
  Hall of Thanes: the way in"). It is kept across the page loading itself again, and forgotten
  once you are alive outside. In the game, a ghost's run back is shown whether or not the game
  names a place for the body (addon version 20: it used to be taken away at once without one).
- **The tracked quest's route moves on as the quest does.** The addon reports how far the
  quest has got, as the game's own list of what it asks for has it: when one thing is done the
  route goes to the nearest of what is left, and when all of it is done, to who takes it. What
  is done is no longer led to. (Before, the route went to the nearest of everything the quest
  asks for until the whole quest was ready - so with the kills done and the collecting still
  to do, it could go on pointing at the creatures.) A quest that has you go and look at a
  place is led to that place (it used to be led to who takes the quest). Which of the things
  the game lists is which creature or item is matched up by kind, as described under "The same
  route in the game"; where that cannot be told, nothing is taken for done.
- The tick on the **Routes** heading switches all of them off and on at once.
- They need the addon as it is now: press **Check for updates** (or **Update addon**) and
  `/reload` once. With an addon from before, the page is only told the one that leads, and the
  game is only shown that one.

**Where you are heading** is read from the game by the addon. Three things can say so:

- the step your guide has you on: the guide addon you run, Guidelime or RestedXP (see "Guides
  in the game");
- a **quick waypoint**: **Shift-click** the game's world map. It is the addon's own (the game's
  map pin is left alone), it is marked on the map at once, and it stays yours through a
  `/reload`;
- a pin you put on the game's own map: **Ctrl-click** the world map.

**A waypoint of your own leads for as long as it is there**: you put it there to go to it, and
the arrow takes you there even if your guide moves on to its next step meanwhile. Your guide's
step leads when you have no waypoint. Neither does away with the other's route: both are drawn,
here and in the game.

**There is only ever one waypoint of your own.** A Shift-click takes the place of a pin (which
is taken off the game's map), a pin of a quick waypoint, and a marker dropped on the 3D map of
either - and the other way about: a waypoint placed in the game takes the marker off the 3D
map. One thing the game cannot do is hear from the 3D map of its own accord (an addon can only
read what it asks for): a marker dropped here, or taken off here, reaches the game the next
time it asks for a route - when you stray from the one you are on, when your guide moves on, or
at once with `/atlas route`. Until then the game keeps the waypoint it had. The marker counts
from when you dropped it, so a waypoint you have placed in the game since still stands.

**Taking your waypoint away from the 3D map**: right-click it on the map (the pointer says so
when it is on it), press **Esc**, or press the little **×** on the Waypoint line in the Routes
list - whichever side the waypoint was placed on. It goes here at once; in the game it goes the
next time the game asks for a route, and `/atlas route` there asks at once.

`/atlas clear` in the game (or a key you bind to *Clear the route*, or a right-click on the
route's end on the game's map) takes your waypoint away, and your guide's step, if it is on
one, leads again. With no waypoint of your own it is the guide's route that is cleared, and
stays gone until the guide moves on to another step. A pin or quick waypoint you travelled to is
taken away when you get within ten yards of it at the end of its route (standing right over or
under it, with most of the route still to go, does not count).

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
same. That is only where the NPC's floor is known (from the reference database, seen in the
game, or the only place to stand there): where it is the map data's guess, the guess is only a
hint to which level is meant, and the levels below decide - so ground buried under a street is
never where the route ends. (A waypoint in the middle of Stormwind's Trade District was put on
the earth under the city, where the data guesses a cat stands.) A **quick waypoint** is a spot
of your own and takes no one's floor: whoever happens to stand near it, it is on the level
nearest yours.

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

Two more rules hold for every walk:

- **A walk to a place at a known height ends at the foot of it** when nothing at that height can
  be walked onto. The well a quest has you use is at the height of its rim, a few yards over the
  ground around it; the search looked at two million floors for a way onto the rim and gave up,
  "too far to work out on foot", three hundred yards from the well. The floors at the spot
  itself now count as a second choice, taken when the one at the height asked for cannot be
  reached at all.
- **A walk begins on the floor you are on**, never on one more than a step above your height.
  Where nothing around you leads anywhere (you are in a room whose only way out is a portal),
  the search used to begin on whatever did, at any height: in the Wizard's Sanctum under
  Stormwind that was the earth under the streets thirty yards overhead, and the route walked
  off along it. You can drop down from where you are; you cannot rise to a floor overhead.

With **more than one level**, the choice is yours:

| Waypoint | What happens |
| --- | --- |
| A pin you put on the game's map with the mouse (Ctrl-click) | The game asks "Which level is your waypoint on?" (the levels with how high they are relative to you and how long each takes). Until you answer, the route goes to the level nearest your own height |
| A pin another addon put on the game's map (a guide's next stop, a quest helper's quest giver) | No question: the level nearest your own height. It is that addon's pin, set when that addon pleases |
| A marker clicked on the 3D map | The page asks the same, over the map. Until you answer, the route goes to the surface you clicked if you can get to it, else to the level nearest your own height |
| A quick waypoint (Shift-click, in the game or here) | No question: the level nearest your own height |
| A guide's step | No question: the level quickest to reach |

Whatever was chosen can be changed for as long as the waypoint stands: in the Routes section here
(the levels are listed under the route, the one in use marked), or in the game with
`/atlas level` or a click on the "Level:" line of the step list. The marker and the route's end
are drawn on the level chosen, not on the terrain underneath.

The question in the game is a window of its own, so it comes by itself only where the answer is
yours alone to give, and it is easy to be rid of:

- **Only for a pin of your own hand.** The game has one way of setting a pin, whoever does it,
  and the addon listens to it: a pin counts as yours when, at that moment, the world map was
  open with the cursor on the very spot (as it is for a Ctrl-click, and for a click with the
  map's own pin button down; **OpenMap**'s map counts the same). A pin set any other way - by
  a guide addon moving on to its next stop while you stand somewhere, by a quest helper, by
  `/way` or a link in chat - is not asked about. (Reported on 19 November 2026: with two guide
  addons running, the question "pops up randomly, like standing in one spot 10 minutes
  straight".) After a `/reload` no pin counts as yours until you set one again.
- **A cross in its corner** closes it, and nothing else. (Escape closes it too, with every
  other window the game closes on Escape.) Closing it keeps the level shown.
- **It can be dragged**, by anything of it that is not a button, and comes up from then on
  where you let it go. `/atlas reset` puts it back under the top of the screen.
- **"Do not ask me this again"**, a box at its foot: ticked, no pin is asked about, and each
  goes to the level nearest your own height. `/atlas ask` (`on`, `off`, or neither to change
  it) and **Ask which level a pin I set is on** in the addon's options are the same switch.
  `/atlas level`, and the "Level:" line, ask whenever you like whatever it is set to.

This needs version 27 of the addon (**Check for updates**, then `/reload` in the game).

**On foot** the route is searched over the map's navigation data, which the extractor builds from
the real geometry (`extractor/jobs/nav.js`): a grid of about one yard of every place a character
can stand. It is made by laying every solid triangle into the grid (the terrain, and the
collision meshes of the buildings and objects placed on it), so it knows slopes too steep to
walk, walls, fences, tree trunks, bridges, the floors and stairs inside buildings, and water deep
enough that you swim. A map that is one building with no terrain under it (a dungeon, a raid,
the Deeprun Tram) has the same grid, laid over that building alone: its collision as for a
building that stands on terrain, so not the objects placed inside it and not its water. Each
place records which of its neighbours it leads on to, worked out at half-yard precision, so
thin walls separate and doorways a yard wide stay open. The cost of a step is the time it takes
at **your** speeds: the addon reports your current run speed (mounted or not) and swim speed.

**How steep is too steep** is the game's own rule: ground whose face tilts more than 50 degrees
cannot be walked up, and anything up to that can. A good many of the game's hillsides are built
right at that limit, 48 to 50 degrees all the way up, and guides send you straight up them.
(Until 0.5.1 the map lost those: where such a slope climbs cornerwise across the grid, a yard
of it came out as two half-floors that led on to nothing uphill, and a hill you had just run up
in twenty seconds was shown as a mile's walk round the mountain.)

**Down is not up.** The game lets you go where you cannot walk back: off a ledge, and down
ground too steep to stand on, which you slide down. The map's data has both: what lies under
every edge you can step off, and the steep ground itself, as somewhere you only ever go
downhill. A route takes such a way where it is quicker, within what the game charges for
falling:

| The fall, from where your feet leave the ground to where they are on it again | What the game takes | What the route does |
|---|---|---|
| up to about 14.5 yd | nothing | takes it freely |
| more, up to 45 yd | about 1.8% of your full health a yard beyond that (30 yd: a third; 45 yd: a little over half) | takes it if the way round is longer by more than the health is worth (a full bar counts as a minute), and says so: "It has a fall of 31 yd: about 32% of your full health" |
| more than 45 yd | most or all of your health (69 yd kills from full health) | never |
| several on one way | each its own share, and they add up | never more between them than one fall of 45 yd costs: two you would each walk away from are not two you walk away from. Said as "It has 2 falls that cost health, the furthest 31 yd: about 47% of your full health in all" |
| into water deep enough to swim in, from any height | nothing | takes it freely |

A slide down a steep bank and the drop at its end are counted as one fall, from where you leave
your feet to where you get them back: that is the most the game can charge for it, so where
the game is kinder (you find your feet for a moment half way down) the route was only more
careful than it had to be. The map is not told how much health you have: 45 yards is a fall
you walk away from with full health and some to spare, and it is yours to decline if you are
hurt. A fall of 6 yards or more is drawn in red, here and on the game's own map (a hop down a
ledge is drawn like the walking either side of it), and one that costs health is in the
game's step too: "Walk to Grund Drokda (a fall of 31 yd on the way)". Which levels a waypoint
has is still worked out by walking alone (see "Which level"): a place you can only drop into
is not somewhere to send you.

**A lift is a way.** Up Thunder Bluff, down into the Undercity and into the halls outside
Gnomeregan there is no walking: a lift carries you, and a walk that had none to take ended at
its shaft ("no way out of where you are on foot" at the foot of Gnomeregan's; and a guide's
step in the halls under the mountain was led to on top of the mountain, the only level of that
spot anyone could walk to). The search now takes a lift like any other step: from the floor it
stops at - the nearest to its middle at that height, the rim of its shaft - to the floor at any
other of its stops, for what it costs in time: half its round of waiting, counted from any
moment you might come to it, and the ride. The game's own table of how each lift moves says
both (`world.json`: each lift's `stops`, `round`, `speed`, `still`): 20 seconds for the hundred
yards down to Gnomeregan, 27 up Thunder Bluff, 14 into the Undercity. Its ride is time and
no yards: "165 yd, about 37 s. It takes the lift down", and in the game's step "Walk to your
guide's step (the lift down on the way)". The line stops at the lift and goes on from its other
stop, a straight stretch up or down the shaft between the two; on the lift you are on the
route, whatever height you are taken to be at, and once it has carried you the way on is
worked out from where it put you down, though you have not moved a yard across the map. A
level that only a lift leads to is a level of its spot like any other (see "Which level"), and
the quickest for a guide's step if it is. A lift the reference database places where this game
has no floor for it (the Great Lift's two cars are listed in two dungeons as well) has no
landing and takes nobody anywhere.

Two things a fall never does:

- **land on ground with something built over it.** The game leaves the earth in place under a
  town (forty yards under Stormwind's streets), and the buildings nobody goes into are hollow
  shells standing over it: past any low wall of theirs the data has a clear drop to that earth,
  which is nowhere anyone gets to and has no way back up. Ground you can fall on to has the sky
  over it. (Floors of buildings, bridges and ledges are another matter, and so is walking.)
- **pass through anything**: a drop is taken only where nothing solid stands between the edge
  and the landing, at the height you come in at - checked to the half yard, and across the
  seams between the map's tiles as well (each tile records, along its edges, how much room
  there is over everything on that side).

Not known: water that belongs to a building and not to the land (Stormwind's canals) is not
in this data, so to the route a canal is a dry trench, open to the sky, down to the earth
under the town. No fall ends there either (ground sunk among a town's built floors is the
same earth, and is not somewhere to land), so a route does not have you jump into a canal -
neither to swim across it, which you could, nor to walk out under the town, which you could
not.

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
  map, and ShortestPathForever's list is used as well if you have it. **A flight can also
  begin at a flight master of your side whose flight point you have not learned yet**: you
  walk up, learn it, and fly on to one you have ("17 yd on foot to Lakeshire's flight master,
  then learn the flight point at Lakeshire and fly to Sentinel Hill"; in the game, "Learn the
  flight point, then fly to Sentinel Hill"). Into a point you have not learned there is no
  flying, nor through one. (Until 0.5.0 only points you had were looked at: standing beside
  Lakeshire's flight master, the route to Westfall was all on foot.);
- **boats and zeppelins**: every line and where it stops comes from the game's own tables
  (they sail the same kind of route a flight path flies, with the stops marked), and how long
  each leg and each stop takes from timetables measured in the game. Every line runs by the
  server's clock (see "Boats, zeppelins and the tram, live"), so it is taken at the moment its
  craft really leaves, for when you would get to its dock, with the game running or not: a boat
  you would miss by seconds is not counted on. A line whose time could be anywhere on its
  round (one measured loosely, after the server's count has started again and before it is
  seen) is counted at its measured trip plus half a round of waiting, on average. In between (a
  time too loose to name the moment: the tram's cars are 72 seconds apart, and a quarter of a
  minute is a lot of that) the wait is what it comes to on average given what is known: short
  when you would get there well before a car is due, long just after one. Lines
  that stop in the other faction's towns are left out (a place counts as theirs when the flight
  masters there serve only them), and so is one the game's tables still list but which no
  longer sails;
- **the Deeprun Tram and portals** (Darnassus, Dalaran): the tram is counted the same way, by
  when its next car leaves. The doorways between maps are not in the game's files (the server
  decides where one leads): they are listed in `extractor/doorways.json`, and read from the
  ShortestPathForever addon's own list where that addon happens to be installed. Only the ones
  between maps this game has are used: the list has Northrend's Dalaran in it (a map this game
  does not have), whose portal to Stormwind and the one back stand on the same spot there, and
  together they made a free way from the top of Stormwind's Mage Tower to the middle of the
  city ("walk to the Dalaran portal, Portal to Dalaran, Portal to Stormwind"). The portals that
  put you somewhere else on the same map are in `viewer/teleports.json`, with the floor you
  walk onto to go through each: the **Skyborne Portal** in this game's Dalaran, to the Wizard's
  Sanctum under Stormwind's Mage Tower, and the Mage Tower's own portal into the Sanctum and the
  one back out - the only way out of the Sanctum (a route from there used to be "no way out of
  where you are on foot");
- **your hearthstone**, if it is set somewhere useful: it counts the time left on its cooldown
  plus the cast, and is only suggested when it saves at least a minute and a half over the next
  best way. The game tells an addon only the name of the place it is set to ("Deepwater
  Tavern"), so the inn is found from that: the zone the place is in, then the innkeeper of that
  zone who is on your side (innkeepers come from QuestieDB). Where a zone has more than one,
  it is the one whose keeper stands in the place of that name - the game's own area under their
  feet: of Zephras Isle's two inns, the one in Valanaar - else the one beside a flight master
  or a landmark so called. Where that does not settle it, the hearthstone is left out until you
  set it again, when the addon notes the exact spot, and the page says under the routes that it
  is left out and why. **You can have it left out altogether**: the small hearthstone
  beside "Routes" in the game (a click strikes it through), `/atlas hearth`, or the addon's
  options - every route is then worked out without it, and you get the next quickest way. The
  page says so under the routes while that is on.
  **A journey that begins with the stone has a line of its own from you to the inn**: broken,
  and pink, which no route is. The stone puts you down at the inn, so the journey's own line
  begins there, and with nothing leading away from where you stand such a route looked as if
  none had come at all (reported on 19 November 2026: "wasting time tryna make the route work
  then realizing its working"). On the 3D map the line arches over the land between (straight,
  it was under the hills after a few yards); on the game's world map it runs straight from
  where you are at the moment to the inn, or to the edge of the map shown where the inn is
  off it, and is gone once you are within forty yards of the inn. It is drawn where the inn
  is on the continent you are on: to an inn across the sea there is nowhere on your map to
  draw it to, and the list's first step ("Use your hearthstone") is what says so. Not on the
  minimap. In the game it needs version 27 of the addon;

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

**Two ways onto the same boat.** A boat that leaves at its own moment makes ways of different
length come in together: what one of them saves in getting to the dock is spent standing on
it. So the simpler way would always be "as quick", however much further it has you walk or
swim. From the fields by Sentinel Hill to Darkshore the boat leaves Stormwind Harbor every 247
seconds; the flight to Stormwind and the walk to the harbor take 301 seconds, walking north and
swimming a thousand yards up the coast 353. For four boats in five both are in time for the
same one - and until version 0.4.1 the map then sent you swimming, and said fly for the fifth:
standing still, the route went from the one to the other and back as the boats came and went.
Of two ways onto one sailing the one that asks less of you stands: the seconds you are on your
own feet, with a minute for each change as before. The journey takes what it was said to
take either way; you stand on the dock the longer. (Only for a craft whose moment is known,
and only between ways onto the same sailing: nothing else is weighed differently.)

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
to another map of the picture (the other continent, or Zephras Isle) is drawn there too: its
walks and flights over there, and the way the boat, zeppelin or airship takes across, in lilac.
The game's own path for a boat stops a little way out from each dock (the craft is moved from
one map to the other while its riders look at a loading screen), so its two ends are joined by
a straight line over the open sea: the line the boats on the map are shown sailing.
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

The addon draws the routes **on the game's own world map and minimap** too: the very routes the
3D map shows, seen from above, each in the colour it has there (your guide's green, your
waypoint's blue, and so on: change one on the 3D map and it changes in the game). In a route's
own colour where you walk, turned toward light blue where you swim, a light tint of it where
you fly. The route that leads is the one the game follows: the part behind you goes as you
walk, and a diamond marks its end (on the
minimap it sits at the rim, faded, while the end is further than the minimap reaches). Hover the
diamond on the world map for the words the 3D map shows ("fly Ironforge to Menethil Harbor,
then..."); right-click it to clear the route. A waypoint whose route has not come yet is marked
with a fainter diamond, so a click on the map is seen to have taken.

The other routes are lines to look at: a little thinner, drawn from where you were when the
game last fetched them (it fetches again when you stray from the route you follow, or when what
leads changes), and with no arrow or list of their own. They come with the route that leads, so
with nothing leading - no waypoint, and the guide's route cleared - the game shows none.

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
  to use, there is no way to point: it shows the time that step takes instead. **It can be
  moved and it can be hidden**: in the options (Esc > Options > AddOns > Azeroth Atlas) untick
  "Show the arrow" and it is gone altogether; tick "Unlock it" and it can be dragged with the
  mouse to wherever you want it, at any time (`/atlas arrow unlock`, `/atlas arrow lock`).
  Locked - as it is unless you unlock it - clicks go through it to the game; unlocked, the left
  button is its own, to drag it by;
- **the list of routes**, under the header **Routes**. Every route there is has a group of its
  own, the one that leads first: its name ("Waypoint: Moonbrook", "Guide: Sentinel Hill", the
  quest's own name, "Party: Thrallina"), before it **a small arrow in the colour its line has
  on the map, pointing the way that route goes from where you stand** (it turns as you turn,
  as the big arrow does for the route you follow; where there is no way to point - a flight, a
  boat, a route that is not on your map - it is a small square in that colour instead), after
  it the time and distance left in all - and under the name the journey as things
  to do, the one you are on first and bright, each with its time ("Walk to Sentinel Hill's
  flight master 0:14", "Fly to Stormwind 2:05", "Walk to your map pin 0:40"). Steps you have
  done drop off the top. **A click on a route's name folds its steps away** (the name stays,
  marked "+"), as a click on a zone folds its quests away in Questie; **a click on "Routes"
  folds everything away**. Both are remembered. A journey that begins with your hearthstone has
  that as the step you are on until you stand where its line begins: the journey's own line
  starts at the inn, and a broken pink one on the world map goes from you to there (see "your
  hearthstone" under "Route to your waypoint"). Standing far from such a route's own line is
  not having left it: no newer one is looked for until you move. Boats say how long
  the wait is likely to be. Where the waypoint's spot has more than one level, a last line says
  which the route goes to; click it to choose another. A waypoint whose route is not there
  (yet) is listed all the same, with why: "Working out the route...", that there is no way, or
  that Azeroth Atlas is not answering;
- **your hearthstone**, beside the header: a small picture of it. **Click it and it is struck
  through in red: no route uses your hearthstone any more**, however ready it is - you get the
  next quickest way instead (for those who keep it for something else). Another click and it is
  used again wherever it is quicker. `/atlas hearth` does the same. It is kept for each
  character; the 3D map hears of it through the strip, works every route out again, and the
  game fetches those.

**Every route is in the game, not only the one that leads.** The 3D map hands the game each
route whole - its line, its steps, its name - and the game follows your place on each as you
walk. They do not hang on a waypoint: with no guide step and no waypoint in the game at all (a
quest you track and nothing else, say), the routes are still fetched, drawn and listed, and
the first of them is the one the arrow points along. (Before, the routes to the other places
only came along with the route to a waypoint - and with none, nothing reached the game, however
many routes the 3D map was showing.)

**The list is a part of Questie's quest list.** It hangs right under Questie's tracker, left
edge on left edge, and is written as Questie writes: the header in the letters, size and
outline of "Questie Tracker: 4/40", a route's name as Questie writes a zone's, the steps as it
writes what a quest asks for, each starting where Questie starts its own and spaced as it
spaces them. All of that is read from Questie's settings about once a second, so a change in
Questie's options (another font, a dark ground under the list) shows in the list too. It
follows Questie's list as that grows, shrinks, is dragged or is folded away; where there is no
room under it, it goes over it, and failing that beside it. Near the screen's right edge its
lines are wrapped rather than run off the screen. While Questie hides its list, the list of
routes stays where it hung. Nothing of the addon's is ever anchored to Questie's list (that can
break Questie's own dragging): it is only asked where it is. Without Questie the list stands
on its own, on a dark ground.

**Pinned, or free to be moved.** The list is pinned under Questie's quest list unless you say
otherwise. In the options (Esc > Options > AddOns > Azeroth Atlas) untick "Pin it under
Questie's quest list" - or type `/atlas pin` - and it is **free: it stands on its own, and you
drag it with the mouse to wherever you want it**, at any time, by any part of it (the header
and the routes' names still take a click; letting go of a drag does not count as one). Set
free for the first time it stays where it hung until you drag it; where you put it is
remembered, also while it is pinned again. Free, the left button is the list's own over all of
it, to drag it by; pinned, clicks go through its steps to the game, as before.

The arrow and the steps are click-through (the header, the routes' names, the hearthstone and
the "Level:" line take a click) - unless the arrow is unlocked or the list is free.
`/atlas arrow` and `/atlas list` switch each off or on, `/atlas pin` sets the list free or
pins it under Questie's list again, `/atlas move` lets you drag a locked arrow, and a list
that stands on its own (type it again when done), `/atlas reset` puts them back.

**Options.** All of this is also under **Esc > Options > AddOns > Azeroth Atlas** (or
`/atlas options`): the strip (shown or not, and where: see "Live player link"), your
hearthstone, the arrow (shown or not; unlocked, to be dragged, or locked), the list (shown or
not; pinned under Questie's, or free, to be dragged), whether you are asked which level a pin
you set is on, and moving the two.

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
  the waypoint was set), if it was not. After that - and when the 3D map said there was no way -
  the waypoint is asked about again by itself: after half a minute, then a minute, two, and so
  on up to five, one mailbox a look. (It used to be asked about again only once you had moved
  150 yards. A long journey the 3D map was still working out when the game asked, or a waypoint
  set while a boat was carrying you, then stayed without a route in the game until you typed
  `/atlas route`, although the 3D map had long since found it.);
- when what else you could be heading for changes - the quest you track, how far that quest
  has got (something it asks for is done, or all of it), your body, who is in your party, your
  guide's step while a waypoint of your own leads: the routes to those, a couple of seconds
  later - and, if the 3D map had not caught up by then, again up to five times, further and
  further apart (see "The quest you track, as it gets on" below);
- when you switch your hearthstone on or off: the routes worked out since;
- when you choose another level for your waypoint: the route to that level;
- when you have been more than 25 yards off the route for a few seconds (the 3D map has planned
  from where you are by then). This goes for the route you follow: the one that leads, or with
  no waypoint in the game the first of the others;
- when the addon cannot tell which of two levels you are on, or you stand at your waypoint's spot
  while the route says you have not reached it (see "One level over another" below);
- when you say so: `/atlas route`, or a key bound to *Fetch the route from the 3D map*. That is
  how a marker you dropped on the 3D map itself gets into the game, since the game cannot know
  you did that.

**The quest you track, as it gets on.** When you get something of the quest done - or all of
it, or track another quest - the way to go is another way, and the game knows that before
anyone: the 3D map hears of it through the strip a moment later, and needs another moment to
work the new way out. The game used to open one mailbox a couple of seconds after the change
and take what was in it. That was nearly always still the way from before, which it then kept:
the route stayed as it was until something else made the game ask again (tracking another
quest and then this one once more did it). Now:

- the addon says how far the tracked quest has got at the head of the strip's next round of
  messages, not when its turn comes (well under a second, where it could be two);
- every delivery says which quest its routes were worked out for and how far that quest had got
  (`tq`: its number, whether it is ready or failed, which of the things it asks for are done).
  The game compares that with what it knows itself. Older word than its own, and the quest's
  route in that delivery is the way from before: it is not shown, and the game looks again
  after 2.5 seconds, then 5, 10, 20 and 40, until the 3D map has caught up;
- the way from before goes from the map, the minimap and the arrow the moment the quest moves
  on, before anything is fetched: the list says "Working out the route..." under the quest's
  name until the new way is there. A route to where there is nothing left to do is worse than
  none;
- the 3D map does not hand over a route it knows to be the way to the last place either: while
  the way to a new place is being worked out, the game is told just that. This goes for every
  route beside the one that leads (your guide's step moving on while a waypoint of your own
  leads, for one), not only the quest's.

What the game lists for a quest says of each thing what kind it is (a creature, an item, an
object, anything else) and whether it is done - not which creature or item. The quest data
has the things kind by kind, in the game's order within a kind, which is how Questie matches
them up too. So a kind that is all done or not begun is plain; a kind partly done is matched
one for one where the game lists as many of it as the data has; and where it does not, nothing
of that kind is taken for done (better a way to something finished than none to something
that is not). A quest that asks for more than eight things is not said in this detail: for
that one the 3D map goes by the quest log alone, as before.

Walking along the route costs nothing; where you are on it is worked out in the game. A normal
hour of questing uses a few dozen. `/atlas status` says how many are left, and the map page
says so when they run low; `/reload` gives them all back.

The addon tells the server (through the strip) which mailbox it will open next and which
delivery it last read, so the page can say what the game is showing: "In the game: showing this
route". Each delivery carries the time it was written; if the game opens one that is more than
half a minute old nobody is writing them - the 3D map is not running, or cannot see the game -
and the mailboxes are then left alone for a while instead of being used up for nothing: a
quarter of a minute, then half, a minute, and so on up to five. (It used to be five minutes
straight away, doubling to forty. One look that came too early - the game's first after a
login, before the 3D map had seen it again - then cost the route for minutes. That is also why
the server keeps the first two mailboxes filled at all times, and goes on renewing the
mailboxes for a minute after it last saw the strip: a `/reload` or a loading screen no longer
leaves the game's next look with something cold.) The list of routes says "Azeroth Atlas is
not answering" meanwhile, and `/atlas status` says what it knows.

**The map works with its window out of sight.** The routes are worked out by the map's page,
and a page that is not on show - its window behind the game on the one screen there is, or
minimized - is given no frames by the browser. Everything used to hang on those frames, so
with one screen the game got a route only if it asked while you happened to be looking at the
map. Now a timekeeper beside the page (`viewer/js/tick.js`, a worker: its clock is not held
back as a hidden page's is) takes the same steps ten times a second whenever the frames stop -
where you are, the routes, what the game is sent - and draws a picture a second at most, so it
costs the graphics card next to nothing while you play. Nothing has to be in view.

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
- It knows where a boat is by the server's clock, to a second or so on a line measured well
  (to less after a ride of yours); for a few days after the server's count has started again
  (every 49.7 days) a line nobody has seen since may be a few seconds out. It does not know of mage
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
- A step of your guide that is only "go to this spot" is ticked off by the guide addon itself,
  by its own rule (how near you are on the map). Taught to, it asks the addon first, and waits
  until you are on the spot's floor; not taught, it can move on while you are a floor below
  (see "Guides in the game").

### Boats, zeppelins and the tram, live

A boat sails the same round over and over, to the second, and it does so **by the server's
clock**. So the map knows when every boat, zeppelin and tram car is at every stop, and where it
is on its way right now, from the moment it opens: with the game running or not, with nothing
seen, and with nothing to set up. What is seen in the game makes that more exact, and takes its
place where it plainly differs:

| What | How it is used |
| --- | --- |
| **The timetables** (`viewer/transit.json`; the addon's copy is written from it by `tools/make-transit-lua.mjs`) | How long each leg and each stop of a line takes, and where the craft is every couple of seconds of a leg: eleven boat and zeppelin lines and both tram cars as DockWatch's players recorded them in this game (MIT licence), and the Feathermoon ferry from the game's own path (its times are rough). The game's own path of each line is where the craft is drawn; all 695 recorded moments of the eleven lines lie on those paths. Where a line's legs and stops do not add up to its round, its stay at its first stop takes up the difference. |
| **The server's clock** (`period` and `left` of each line in `transit.json`; `viewer/js/clock.js`) | How long the line's round is, to a few ten-thousandths of a second, and a moment at which a craft was measured to leave its first stop. With those two figures the clock alone says where the craft is at any time (below). `tools/clock-transit.mjs` measures them. |
| **Your own rides** | Something is carrying you when you move without moving yourself. Carried along a line's track where the boat is under way, each spot you pass says how long ago it left; five of them over five seconds that agree to the second are when it left, wherever you boarded. |
| **Other players' sightings** | Four addons pass sightings from player to player, each in its own way, and each is read as that addon writes it, without being installed: **DockWatch** (the moment a boat left a dock, by where the dock is; over its own hidden channel, the guild and whispers), **ForeverTransport** (when it arrived, by a line's number), **Nauticus** (how far into its round a boat is as the message is sent) and **Azeroth Tripview** (when a round began, by a line's name; it speaks to guild, group and whoever stands near, so less of it is heard). The addon **only listens**: it never sends in the game, so it cannot put a wrong time into anyone's timers. `/atlas boats listen` turns the listening off. |
| **Everybody's sightings, put together** (the Atlas database) | Every copy of the map sends what its addon has seen; the database measures each line's two figures anew from all of it, and every copy fetches them. So one player's ride makes the boats right for everybody (below). |

**The server's clock.** The game's server counts real time in milliseconds, in a number of 32
bits. Where a craft is on its round is that count, divided by how long the round takes, and
what is left over: at the moment the count is at nought the craft is at the second point of
its path in the game's own tables (the first only shapes the curve), and again every round
after it. Nothing else comes into it. **A restart or a patch moves no boat.** (That every craft
runs so was found by the Azeroth Tripview addon, by Cloverdev. The figures here are not its
own: they are measured from our sightings and the game's paths, and agree with its to under
half a thousandth of a second a round on the nine lines both have measured well.)

How the two figures were measured (`node tools/clock-transit.mjs <the game's WTF folder, report
zips' folders>`): our recorded tracks say how long after leaving a stop the craft is at the
point its round starts at; a sighting says when it left that stop; the rounds since the count
started are a whole number, some eleven thousand of them, and so one sighting to the second
gives the round to a ten-thousandth of a second. From the 209 sightings the addon had saved
between 14 and 17 November 2026 (rides, and DockWatch players'):

| Line | Sightings | Round | Spread of the sightings about it |
| --- | --- | --- | --- |
| Orgrimmar - Undercity | 13 | 356.28699 s | 0.4 s |
| Grom'gol - Orgrimmar | 8 | 303.46586 s (the recording said 303.35) | 0.5 s |
| Grom'gol - Undercity | 8 | 335.29694 s | 0.4 s |
| Booty Bay - Ratchet | 31 | 350.82196 s | 0.8 s |
| Baradin Bay - Western Strand - The Long Wash | 30 | 486.20689 s | 0.5 s |
| Baradin Bay - Theramore | 30 | 329.31498 s | 0.5 s |
| Mist's Edge - Rut'theran | 12 | 316.10296 s (316.18) | 0.5 s |
| Feathermoon - The Forgotten Coast | 7 | 317.04444 s | 0.2 s |
| Deeprun Tram | 12 | 143.333 s (the game's own animation, a whole number of milliseconds) | 0.8 s |
| Stormwind - Mist's Edge | 31 | 246.63480 s | 0.5 s |
| Dalaran - Valanaar | 5 | 358.81575 s (352.49 before: see below) | 0.9 s |
| Powderfuse - Steamwheedle | 19 | 271.03490 s (270.99) | 0.4 s |
| Valanaar - Skywatcher Plateau | 2 of 3 | 346.76444 s, **or 0.032 s more or less** | 0.3 s |

The last was seen too little to tell two neighbouring rounds apart (they differ by one round
more or less since the count started; the third sighting fits neither). It is the nearest to
what the game's path makes of it, and is reckoned unsure by that much a round: a quarter of a
minute a day, until somebody rides it.

**When the server's count starts again.** A number of 32 bits is full after 49.7 days of
milliseconds, and starts again from nought: on 3 October 2026 at 04:22:42 UTC, next on **21
November 2026 at 21:25:29 UTC**, then on 10 January 2027. Every craft jumps to another place on
its round at that moment (49.7 days are no whole number of rounds), and runs on from there by
the same rule. What was seen before says nothing of what comes after: the addon and the map
forget it, and go by the clock alone, as long after the start as the craft was measured to
leave before. That is as unsure as the rounds in between make it, each by what the round may be
off: three seconds for a line measured well (eleven thousand rounds at a quarter of a
thousandth of a second), and anywhere on its round for the Skywatcher airship, which then
counts as not known until it is seen. The first ride or sighting in the new count makes a line
exact again, and with the old count's sightings ten thousand rounds away, the database then has
its round to a twenty-thousandth of a second. `/atlas boats` says so from three days before.

**What is seen, against the clock** (`addon/AzerothAtlas/Transit.lua`). Each sighting is
weighed by how exact it is: your own ride to under a second, a DockWatch sighting to a second
and a half, a ForeverTransport arrival to three, a Nauticus or Tripview one to four. The same
sighting handed on by several players counts once.

- A sighting that **agrees with the clock** (within five seconds, what the sighting itself is
  unsure by, and twice what the timetable is) joins it, and the timetable is the surer for it:
  the clock counts as one more sighting, as unsure as its figures are. The round is held as near
  its figure as that is sure, so a line measured well keeps its round and one measured loosely
  takes it from what is seen.
- Sightings that **plainly do not agree** make a timetable of their own. That one takes the
  clock's place on good grounds only: a ride of yours, or two other players who agree with each
  other. One player's word against the clock waits for a second (it is kept an hour and a half
  for it). So a ride of yours that is off the clock runs that line from then on (the clock's
  figures are out for it, or the game has changed the line), and only that line.
- Of the two, **whichever was last borne out on such grounds runs**: the clock has the line
  back once a ride of yours, or two players, agree with it again.
- A Tripview player names when a round began, which is turned into a moment at a stop by the
  clock's own figures. So it could not say that those figures were out, only that a line no
  longer runs by them, and it counts for little.

How unsure a departure is goes with it everywhere: under six seconds it is given plainly, over
that as "about", and past a sixth of a round no moment is named for it: the map neither shows
its craft as if it were somewhere nor counts on one. (The tram is the exception: its cars are
only a minute apart, so a journey still counts what a time up to 25 seconds unsure says about
the wait.) `/atlas boats` lists every line: when it leaves each of its stops, and whether that
is by the server's clock alone, by the clock borne out by sightings (whose, and how long ago),
or not as the clock has it.

**Everybody's sightings, put together** (`atlasdb/boats.js`, `functions/boats.js`). The two
figures of a line get better the more is seen, and have to be measured again when the count has
started anew or the game has changed a line. No copy sees enough by itself; together they do.

| | |
| --- | --- |
| **A copy sends** | every sighting its addon has taken: your rides, and what other players' addons passed on. The addon keeps them for this in its saved settings (the newest 40 of each line), which the game writes when you log out or `/reload`; the map reads that file and sends what it has not sent before, with the rest of what it sends to the Atlas database and under the same switch (**Share what this copy learns**). A sighting goes as one short line: the line, the stop, left or got in, the moment, and which way it came (`4,1,d,1794925600.32,own,0`). **No names**, yours or the other players'. The moment is the whole of what a sighting says, so it goes as it is: of a ride of your own, that does say that this copy's player was on that boat then. |
| **The database measures** | A function in the cloud takes in what was sent, every ten minutes, and measures each line again from everybody's sightings: the newest 400 of the count that runs, and 80 of the one before. With the figures there are, each sighting is so many whole rounds and a bit after the count started. Sightings that agree on the bit to within a few seconds, and come to a ride or two players' word, are believed; anything else leaves the figures as they are. Through the believed ones goes a straight line, the moment against the number of rounds: its slope is the round, and where it starts is where the craft stands as the count begins. The round is held near the map's own figure, as firmly as that is sure. Where rides and an addon's sightings of a line differ by a steady amount (each addon has its own idea of the moment a boat "leaves"), the rides are right and the others are shifted to them. A line of which too little was seen is left out. |
| **Every copy fetches** | the figures (`/transit` in the database) when it has sent, a little after the map starts and every six hours besides, and goes by them where they were measured later than its own. The map's page takes them at once. The addon is handed them the only way the game allows: as a small addon of its own beside it, `AzerothAtlas_Clock`, one file that the game loads before Azeroth Atlas the next time it starts or you `/reload` (the folder itself is found when the game next starts). Written only where Azeroth Atlas is installed, and nothing else is touched. |

For whoever keeps the database: the function goes into the cloud with the other two (`node
tools/cloud.mjs deploy`) and needs no key; the database's rules must let a copy add to
`/boats/seen/<its own name>` and read `/transit` (`atlasdb/rules.json` does: `node
tools/cloud.mjs rules`). Until both are done, a copy's boats are turned away (it says so in its
notes and sends them the next time), and every copy goes by the figures it came with. The
figures the map comes with can be measured again at any time from saved settings
(`tools/clock-transit.mjs --write`, then `tools/make-transit-lua.mjs`).

**What the addon took a restart for** (up to version 22). Before the clock was known, a boat
was taken to start its round afresh whenever the server restarted. The server's warning in chat
was read; a ride of yours that did not fit what was known was taken for a restart, and what had
been seen before one was thrown away (version 22: set aside until your next ride settled it).
None of it was so. On 16 November a ride on the Dalaran airship did not fit a DockWatch
sighting sixteen hours older, was taken for a restart, and every line's sightings were
forgotten; the airship's round was 6.3 seconds out in the timetables (352.49 s for 358.82 s),
which over 163 rounds is seventeen minutes. With the round as it is, that sighting, that ride
and three since lie within a second of one timetable: the clock's. Version 23 forgets what an
older version put down about restarts, once, and puts back what it had set aside.

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
  throughout. The craft you are aboard is the exception: it is drawn under your figure, and
  makes the crossing during your loading screen. (Its timetable has it where it is to the
  second, and your figure is where the game last said you were, a moment before: at an
  airship's thirty yards a second the two came apart, and you stood in the air behind the ship
  you were on.) The airships to Zephras Isle cross the same way, through the air: the island is
  on the picture too (see "The continents and Zephras Isle on one picture"), so an airship from
  Dalaran or from Skywatcher Plateau is seen flying out over the sea to it and in to its docks,
  and back. Where a recorded crossing has the craft settle a yard or two back at its dock, it
  now stays there; it used to be drawn racing once round its whole route in the last two
  seconds.

The addon tells the map what it knows through the strip (three lines a second, in turn, and
how far the server's clock is from this computer's), so the map goes on showing the boats after
the game is closed, for as long as its server runs.

### Guides in the game

The addon has no guide of its own. It follows **the guide addon you run** - Guidelime or
RestedXP - and the step that addon has you on is your waypoint: the 3D map routes to it, the
route is shown in the game, and it moves on by itself as the guide does
(`addon/AzerothAtlas/GuideSources.lua`). Other guide addons are not followed yet.

(Until version 0.4.1 the addon ran guides written for Guidelime in a window of its own, and the
page changed a line of each guide pack so that it loaded without Guidelime. That is gone: a
pack is as its maker wrote it, and needs Guidelime. A pack that was converted back then still
hands its guides to Guidelime where both Guidelime and Azeroth Atlas are switched on; with
Guidelime switched off it has nobody to hand them to, and the game reports an error for it.
Installing the pack again, or putting the line of its `.toc` back - the pack keeps it, after
"Before:" - makes it its maker's own again.)

**Where the step is read.** Each guide addon points an arrow of its own at the spot its step
sends you to, and the thing that arrow points at says where that is:

| Guide addon | Read from | |
| --- | --- | --- |
| Guidelime | `GuidelimeArrow.element` | The arrow is a frame anyone can see; Guidelime's own tables are private. With Guidelime's window shut it follows nothing, and neither does the route |
| RestedXP | `RXP.arrowFrame.element` | `RXP` is its addon table, in the open. Only an element of a step RestedXP has you on counts: it never clears what its arrow pointed at last |

It is looked at as often as your waypoint is, several times a second. Nothing of theirs is
written to.

**Which of them** is set in the addon's options ("Your guide"), or typed in the game:

| In the game | |
| --- | --- |
| `/atlas guide` | which guide addon is followed, and how that is set |
| `/atlas guide auto` | Automatic: the one that has a guide open and a step to go to; with both, the one whose step changed last |
| `/atlas guide guidelime`, `/atlas guide restedxp` | that one, whatever the other does |

It is kept for each character.

**A step is open for as long as the guide has you on it** - not for as long as its spot is
"not reached". Both guide addons count a spot as reached when you are near it on the flat map,
whatever floor you are on. A step with something to do there (a quest to take or hand in)
still waits for that, so the addon goes on leading you to the spot: standing under the quest
giver's balcony, the way up stays shown. The spot is done with when you are at the end of the
route to it, on the level it ends on (see "One level over another"), and it is your waypoint
again if you walk off without doing what the step asks. With the 3D map not running there is
nothing to tell the level by, and the guide addon's own word decides.

**A step that is only a spot** ("go here", and nothing else to do) the guide addon ticks off
by itself, on the flat map, and moves on - a floor below it, too. **The page teaches the guide
addon to ask first** (`server/guidepatch.js`): one line of its own file is changed, so that the
spot is ticked off only when the addon does not say "not yet".

| Guide addon | File | The line, and what is added to it |
| --- | --- | --- |
| Guidelime | `CurrentGuide.lua` | `element.completed = (D.wx - element.wx) * ... <= radius` **`and not (AzerothAtlas and AzerothAtlas.Arrived and AzerothAtlas.Arrived(element) == false)`** |
| RestedXP | `map.lua` | `if dist <= element.radius and objectiveCheck` **`and not (AzerothAtlas and AzerothAtlas.Arrived and AzerothAtlas.Arrived(element) == false)`** `then` |

- The line is found by its exact words. A guide addon whose line reads otherwise - its makers
  changed it - is left alone, and the page says so.
- It stays one line: every line of the file keeps its number, so an error the guide addon
  reports names the line it always did. A comment at its end says why it is as it is.
- What is added asks the addon only if it is there, and only once the guide addon itself has
  found you near the spot. `AzerothAtlas.Arrived` answers "not yet" while you are led to that
  spot and are not at the end of the route to it, on its level; in every other case it has
  nothing to say, and the guide addon decides exactly as it did - with Azeroth Atlas switched
  off or removed, with the 3D map not running, with a waypoint of your own leading.
- Guidelime looks at a spot once, as you cross into its reach. Told "not yet" then, it is asked
  to look again when you have arrived (its own two lines for "your experience changed", which
  do nothing else). RestedXP looks by itself, several times a second.
- Updating the guide addon puts its own file back. **Check for updates** teaches it again, the
  page says when there is one to teach (it looks every half minute), and a `/reload` in the
  game brings the change in.
- **It is on unless you switch it off**: the box "Guide addons ask the addon which floor you
  are on" under the addon's button on the page (`"guidePatches": false` in `config.json`).
  Switched off, every such line is put back as its makers wrote it.

Nothing relies on it: a guide addon that has not been taught ticks such a step off on the flat
map, as it always has, and the route goes on to the next step.

**Two arrows.** The guide addon's own arrow is left as you have it, so with the addon's arrow
on there are two: the guide's points straight at the spot, the addon's along the route to it.
Either can be switched off in its own settings.

## Drop rates in a creature's tooltip

With the mouse on a creature, the game's own tooltip lists the quests of yours it has something
for, and under each what is still wanted of it. Where the Atlas database knows how often that
creature drops that item, the addon puts the figure after the line:

```
Bloodscalp Hunter
Level 35
Humanoid
Bloodscalp Ears
  15/15 Bloodscalp Ear (22%)
Where's the Key?
- 0/1 Primitive Key
```

Where no figure is known the line is left as the game wrote it - as "Primitive Key" above, an
item new to this game that nobody has a rate for yet. And what a quest of yours still wants of
the creature that the game does not list at all is added under it (below). No other addon is
needed for it (asked for on 20 November 2026, by someone about to uninstall Questie).

**Where the figures come from.** The Atlas database, as this copy last fetched it: every
creature's record has `drops`, the items quests ask for that it gives, each with a rate in per
cent (see "The Atlas database": today they are the rates QuestieDB's tables have for the
original game, 16,600 of them for 4,299 creatures; a rate the database learns from anywhere
else will show the same way). The game hands an addon nothing while it runs but what the game
itself loads, so the map writes them as a small addon of their own beside Azeroth Atlas,
`AzerothAtlas_Drops` (`server/drops.js`: a quarter of a megabyte, a creature a line), as it does
the boats' times: when the map starts, each time the database has been fetched, and when the
addon is installed - and only when the figures have changed. The game takes them up when it
starts or on `/reload`; a folder it has not seen before, only when it starts.

**How a line is told.** The game's tooltip names the item and gives no number for it. So what
is left of "0/15 Bloodscalp Ear" without its count has to be, to the letter (large or small),
the name of an item this creature has a rate for: as the map's own item data has the name
(read out of the game's files, and written beside the rates), or as the game itself gives it
for the item's number. A line about anything else - a kill to make, a thing to use, an item
this creature is not known to drop - is the name of no such item, and is not touched. The
figure is added to the line the game has just written (`addon/AzerothAtlas/Drops.lua`), tick
or dash and colour as they were; whole above ten in a hundred, finer the rarer the drop
(`37%`, `5.5%`, `0.92%`).

**What the game does not list is added.** The game lists a quest under a creature only where
its own word on that creature names the item, and that word is short. The database knows of
more: of the 960 creatures it has both that list and rates for, seven in ten of the rated
drops (2,883 of 4,033) are items the list leaves out, and 810 of the 960 have at least one. A
Bloodscalp Hunter drops the pages of *The Green Hills of Stranglethorn*, about one time in a
hundred each, and the game says nothing of them under it. So once the tooltip has been
written, your quest log is gone through, and whatever a quest of yours still wants that this
creature has a rate for, and that the game did not list, is written under it as the game
would have: the quest's name, and under it the line as your log has it, with its rate.

```
Bloodscalp Hunter
Level 35
Humanoid
Bloodscalp Ears
  15/15 Bloodscalp Ear (22%)
Where's the Key?
- 0/1 Primitive Key
Chapter I
- 0/1 Green Hills of Stranglethorn - Page 1 (0.92%)
- 0/1 Green Hills of Stranglethorn - Page 4 (0.93%)
```

- **Only what is still wanted.** A thing you have all of is not added (the game shows its own
  such lines ticked; these are simply not there).
- **Nothing twice.** A thing the game has listed is not added again, and a quest the game
  lists one thing of gets the other straight under the game's lines, where those end the
  tooltip; else under the quest's name written once more, so that it is clear whose it is.
- **Your log is read when it changes** (the game says when), and every few seconds besides,
  not with every tooltip: the game writes a tooltip anew several times a second while the
  mouse stays.
- An added line cannot be told from the game's own but by this: it always has a rate. (With
  Questie still installed and adding lines of its own, the same thing may stand twice, once
  from each: this was asked for by someone uninstalling it.)

**What it does not do.**

- Nothing for a creature the database has no rate for, whatever else is known to drop from it,
  and nothing for a thing with no rate: a line is added because of a rate, not without one.
- Nothing inside a dungeon or a raid, where the game keeps what a tooltip holds to itself, and
  nothing with any value the game hands over as "secret": left alone, not worked around. A
  tooltip of which any line is kept secret gets no lines of ours either: what the game has
  listed there cannot be told.
- A copy that has never fetched the database (or has it switched off from the start) has no
  figures to write: the tooltip is as the game writes it, and `/atlas drops` says so.

`/atlas drops` says whether it is on, how many creatures there are figures for and how many
lines it has added; `/atlas drops off` (and `on`) switches both, as does **In a creature's
tooltip, show how often it drops what your quest wants** in the addon's options. The rates
after the game's own lines need version 29 of the addon, the added lines version 30 (**Check
for updates**) - and the game started again once since version 29 was put in: the addon had a
new file then, and the figures a new folder, and the game only looks for either when it
starts. From 29 to 30 a `/reload` is enough.

Tried against a mocked game that fills its tooltip the way this one does, with the figures as
the map writes them from the real database; not yet seen in the game itself when this was
written.

## Tracking all your completed quests at once

The game tracks a quest - its objectives in the list on the right of the screen - when you tick
it in the quest log, and a right-click on a zone's name in the quest log tracks or untracks all
of that zone's quests ("Track All", "Untrack All"). It has nothing for the whole log. The addon
adds two entries for that (asked for on 20 November 2026: "a button that adds all completed
quests to the tracked list would be sick, and also an untrack all button"):

| | |
|---|---|
| **Track All Completed Quests** | Every quest in your log that is ready to hand in is tracked, in every zone, as far as there is room: the game tracks 25 quests at most. What you tracked already stays tracked. |
| **Untrack All Quests** | Every quest you track is untracked. The quest the game focuses is let go of too, as the game itself does when that quest is untracked. |

They stand in three of the game's own menus, below what the game has there: the quest log's
options (the button by its search box), the right-click on a zone's name in the quest log (under
the game's own two, which are for that zone only), and the right-click on a quest in the list on
the right of the screen. Typed, they are `/atlas track` and `/atlas untrack`. What was done is
said in chat: "6 quests ready to hand in tracked, 1 was already", "no room to track 4 quests
ready to hand in: the game tracks 25 quests at most", "10 quests untracked".

- **Not in a fight.** The list on the right lays itself out again whenever a quest is tracked or
  untracked, and it holds buttons (a quest's item) that an addon may not have moved in a fight.
  Asked for in a fight, it is done the moment the fight is over, in the order asked (untrack all
  and then track the completed ones leaves just those tracked), and it says so.
- **Ready to hand in** is as the game's quest log has it: the objectives done, or none to do. A
  failed quest, one the game hides, a bonus objective and a world quest are left as they are,
  as the game's own list leaves them out.
- A new player in the game's first quests, where the game lets no quest be untracked, gets no
  "Untrack All Quests" (the game has none of its own there either).

The entries come from the game's own way of letting addons add to its menus (`Menu.ModifyMenu`),
and the tracking from the calls the game's own quest log uses (`C_QuestLog.AddQuestWatch`,
`RemoveQuestWatch`); both were read out of the installed game's interface code
(`addon/AzerothAtlas/Tracked.lua`). It needs version 32 of the addon, and the game started again
once after it is put in (a new file: the game only looks for those when it starts). Tried
against a mocked game whose quest log, tracked list and menus behave as that code has them, with
the quest log of the report that asked for it; not yet seen in the game itself when this was
written.

## Overlays: the map drawn over the game

The application can draw over the game's window, so that the map is where you are looking and
not beside it (asked for on 20 November 2026). Three overlays, each brought up and put away
with a key of its own, in the game or anywhere:

| Overlay | What it is | Key, as it comes |
| --- | --- | --- |
| **Sidebar** | the sidebar, and everything in it | Ctrl + Alt + F1 |
| **Map** | the map, full size | Ctrl + Alt + F2 |
| **Minimap** | the same map shown small, and on you | Ctrl + Alt + F3 |

**One picture of the map at a time** (asked for on 20 November 2026, a day after the overlays:
"only one viewport is ever visible at once"). The map and the minimap are the same map, shown
full size or small - never both. The full map comes first: bring it up while the minimap is
up, and the minimap is put away for that long; put the full map away, and the minimap is back
by itself, where it was. (The minimap's key, pressed meanwhile, changes only whether it is to
come back.) And while anything is over the game, nothing of the map is drawn in the
application's own window: there is one map, and it is drawn once, where you are looking.

They are set under **Overlay settings** in the sidebar, an overlay at a time (Sidebar, Map,
Minimap; a dot marks the ones that are up, a ring a minimap that waits for the full map to be
put away):

- **Shown over the game**, and its **key**: click the key, then press the one you want - with
  Ctrl, Alt or Shift held, or one of F1 to F24 (a letter or a figure by itself would be taken
  from the game and from everything you type). Esc leaves it as it is, Backspace takes the key
  away. Windows gives a key to one program at a time: one it will not give is said so under it.
  A key held for an overlay is taken from every other program, whatever it would have done
  there - which is why the keys are held only while the game is running, and why they do not
  come as Ctrl + Alt + a figure: that is how many keyboards type @, # and {.
- **Pinned**: it cannot be moved or resized. Unpinned, drag the sidebar by its head, the map
  by the grip at its top, the minimap anywhere; resize by the bottom right corner. Every panel
  has a pin and a cross of its own in its corner too (the cross puts it away).
- **Opacity** standing still, while moving, and in a fight: three figures, 5 to 100 per cent.
- **Clicks go through it** while moving, and in a fight: ticked, a click on the overlay then
  goes to the game, as if it were not there.
- **Held to the game window's** point **by its own** point, and how far **apart** the two are:
  nine points of the game's window to choose from (its corners, the middles of its edges, its
  middle) and the same nine of the overlay. An overlay held by its top right corner to the
  window's top right corner, 24 pixels in, is 24 pixels in from that corner whatever the game's
  window is resized to. Choosing another point leaves the overlay where it lies and changes
  only what it is held by; dragging it changes how far apart. It is always kept inside the
  game's window, and is never bigger than it.
- **Size**, in pixels.
- For the minimap: its **shape** (round, rounded, square), and its own **Turn with me** and
  **Auto-zoom**. The map goes by the switches under **You**, in the application's window and
  over the game alike; the minimap by these two alone - and it always follows you, whether
  the map does or not. Those switches stand as you left them meanwhile, and when the map is
  the map again it follows you or not as they say, looking where and from how far it looked
  before. How far off the minimap looks from (the wheel zooms it, the right button swings it)
  is kept as the minimap's own.

**Where the game is.** The overlays lie over the game's window as the map's server finds it
(the same reading that finds the coded strip: the window's inside, without its frame), and
follow it when it is moved or resized. That works for a game in a window and for one that
fills the screen - this game fills it as a window without a frame, which is what an overlay
of this kind can be drawn over. With the game minimized the overlays are put away until it is
back. With no game on the screen, an overlay brought up lies over the main screen instead, so
that everything can be set up without it.

**The mouse and the keyboard.** An overlay's window takes no click meant for the game: the
mouse goes through it everywhere but on a panel that can be clicked at that moment. And it
never takes the keyboard: drag the map over the game, zoom the minimap with the wheel, and
your character runs on. Only when you click into something to type in (the search box, a
number) does the overlay take the keyboard, and it gives it back when you leave that - Esc, or
a click on the game.

**One map, not two.** What is over the game is not a second copy of the map. It is the
application's own page, taken out of its window and laid over the game's in one that is
see-through, has no frame and stays on top; there the page shows its sidebar and its map as two
panels and nothing else - the map full size, or small as the minimap. Put them all away and it
is back in its window as it was, the same page: nothing is loaded again, no route worked out
twice. (A second copy would be a second map sending the game its own route - the game is
handed one, and the last to speak would win - and a second set of everything on the graphics
card the game is using. For one version, 0.6.8, the minimap was such a copy, a light one in a
window of its own, and could be up beside the full map: two pictures of one map. From 0.6.9 it
is the map itself.) While the page is over the game, the application's own window says so and
draws nothing, with a button that brings it back. "Report a problem" and anything that has
gone wrong bring it back by themselves: their windows are the page's own.

**What it costs.** One picture, of the size it is shown at: a minimap 260 pixels a side is a
ninth of the full map as it comes (960 by 640), and a smaller part still of the application's
window. Over the game the map is never taken for the window in front, so it is drawn thirty
times a second at most and only when something in it has changed, a frame is never begun before the
graphics card has handed back the last, and the resolution steps down while the card is slow
(see "Running beside the game"). With only the sidebar up there is no picture at all: nothing
is drawn until the map or the minimap is brought up.

**In a fight** is the game's own word for it, which the addon passes on in its strip (version
31 of the addon; with an older one you are never taken to be fighting). **Moving** is the
game's own speed for you, a change of place, or a flight path.

How it is made: `app/overlay.cjs` (the window over the game, the keys, the mouse; what is set is
kept in `overlays.json` beside what the window remembers), `app/main.cjs` (the page as a view
that can be lifted out of its window), `viewer/js/overlay.js` (the panels, where they lie, the
map as a minimap and as the map again, the settings). Only in the application: a page open in
a browser cannot draw over anything, and its "Overlay settings" says so.

Tried on the real page with the application stood in for (67 checks: where a panel lies for
every pair of points and three sizes of window, dragging and resizing, pinned, the three
opacities and what lets clicks through, the settings; the minimap as the map shown small - on
you while the map's own switches stand as they were, put away by the full map and back after
it from as near as it had been zoomed, the map's view as it was left, and thirty pictures a
second where sixty were asked for) and in the application
itself, run with nothing of it put on the screen (29 checks: the page lifted over and back
without starting again or losing its graphics, the window following the game's, the keys given
by Windows, the minimap with no window and no page of its own, what is set kept across a
restart). The minimap was looked at as the page draws it, in a browser nobody sees. That a
page lifted into a see-through window really is see-through was looked at once on this screen
with a small window, and that the map goes on drawing there once with the overlays put on the
screen for a few seconds - both with 0.6.8, not again since. **Not tried in the game itself**:
the overlays over the running game, the keys while the game has the keyboard, the mouse going
through to it, the keyboard taken for typing and given back. If any of that is not as it
should be, "Report a problem" has what is set and how the windows stand.

## Live player link

The map can show where you are in real time, along with your party members.

Addons cannot talk to other programs, so this works in two halves:

1. The **AzerothAtlas** addon (`addon/AzerothAtlas`, installed into the game's AddOns folder
   with the **Install addon** button) draws a thin strip of coloured squares in a corner of
   the game window: the top-left one, unless you move it (6 px tall; 392 px wide when you are
   alone with no waypoint - 516 px for the three seconds after your height was measured - and
   844 px at most).
   `/atlas` in game turns it on or off. After the map updates the addon (the button turns
   orange), type `/reload` in game; until then the older addon keeps working.

   **The strip is drawn over everything in the game's own interface**: in the topmost layer
   there is, at the top of it, and put back there every couple of seconds should another addon
   have had a say. What it cannot be drawn over is what another *program* draws over the game:
   a frame-rate counter, a voice chat's overlay, a recording tool's - those are painted onto
   the game's picture after the game is done with it, and the top-left corner is where most of
   them sit. So **the strip can be moved**: in the game, **Esc > Options > AddOns > Azeroth
   Atlas** - one of the four corners, and how many pixels in from it - or
   `/atlas strip topright 0 40` (a corner: `topleft`, `topright`, `bottomleft`, `bottomright`;
   then the pixels across, and down or up; `/atlas strip reset` puts it back). Nothing has to be
   told to the map: where the strip is not in the top-left corner, the helper looks through
   the whole picture of the game window for its first seven squares, reads it where they are
   from then on, and looks again when it is no longer there (a look takes a few hundredths of a
   second, and is only taken while the strip is lost). The page says so when something is in
   the strip's way: "Cannot read the strip: something is drawn over it in the game".

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
which needs the strip's corner of the game uncovered.

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
  are a ghost, and the quest you are tracking are each reported, for the routes - the quest
  with how far it has got: whether it is ready to hand in, and which of the things it asks for
  are done.

### Inside a dungeon: your place, read off the game's minimap

Inside a dungeon or a raid the game tells an addon which one you are in and nothing of where:
the strip can say "the Stockade", and no more. But the game's own minimap is on the screen, and
the picture on it is centred on you. So, while you are in a dungeon, the map reads that picture
too and finds where it fits on the dungeon's plan. That is where you are: the figure stands
there, glides as you walk, faces the way you face, and the camera, the routes and "Follow me"
go by it as they do outdoors. The line under **You** says "by the minimap".

**What it reads, and what it does not.** It reads the picture of the game window - the same
picture the strip is read off, by the same helper, the same way - and of that picture one
small square: the minimap with its rim (about 240 pixels each way on a screen 1240 high), about
four times a second, and only while you are in a dungeon the map has a plan of. It does not read the game's memory,
sends nothing into the game, presses nothing, and changes nothing about the minimap. The square
is looked at and dropped: nothing of it is written to the disk and nothing leaves this computer
(the last one is held in memory, so that a report of a problem you make yourself can show what
was looked at). `"minimap": false` in `config.json` switches all of it off.

**How it works.**

- *The plan.* The game has a picture of the floor of every room of a dungeon (they are what
  its minimap is drawn from). The map build puts them together for every map that is one
  building (`extractor/jobs/minimap.js`): for each room where its floor is, two pixels a yard,
  north up - `maps/<id>/minimap.bin`, between 4 and 43 KB a dungeon. An update of the map tool
  that brings this offers **Update map** once; the plans take seconds to make.
- *Where the minimap is on the screen.* Its middle has to be known to a pixel - a pixel off is
  a yard and a half off, at the widest view - and its size to a hundredth. The addon says where
  the game has it (the minimap frame's middle and size in pixels, its zoom, how many yards it
  shows from its middle to its edge, whether it turns with you, whether it is round; read
  outside fights, and kept through them). The gold rim the game draws round its minimap is
  looked for on the picture as well. Where north stays up, the rim stands still and is measured
  to half a pixel: there the picture has the last word. Where the minimap turns with you, the
  rim turns with it, and what is read off it wanders - on an evening in Gnomeregan by six pixels
  and three hundredths of its size, and the place found with it by as many yards, swinging round
  you as you turned - while the addon's word stood still and put you on the game's own spot for
  the door to within a yard. So there the addon's word is gone by, as long as the rim is
  anywhere near it (a twentieth of the minimap's width). With an older addon
  that says nothing, the rim is looked for in the top right corner of the game's picture,
  where the game puts its minimap, and the six steps of the minimap's zoom (300, 240, 180, 120,
  80 and 50 yards across, indoors) are tried in turn until one fits.
- *Finding you.* Both pictures are boiled down to "is this floor": lit, or black. The plan is
  brought to the screen's scale and the minimap's disc is looked for on it, at every place and -
  where the minimap turns with you - every turn (`server/minimap-match.js`, in a thread of its
  own, so the map goes on answering). A place is believed only where it fits well **and** no
  other place fits nearly as well; otherwise nothing is said. Once found you are followed from
  one picture to the next, which takes a hundredth or two of a second; a fresh look takes a
  few tenths of a second in a small dungeon (the Stockade, Ragefire Chasm) and several seconds
  in the biggest with many floors (Dire Maul, Blackrock Spire: four with north up, up to ten
  where every turn has to be tried).
- *Held against how you can have moved.* A picture can be read wrong: two corridors that look
  alike, something over half the minimap, a hall so wide that all of it is floor. But you get
  from one place to the next on your feet, and the game says how fast you are going (the
  strip). The map server sums that up to the yards you have gone, and the map has every
  dungeon's floors, the same ones a route is found over. So a picture is not asked "where on
  the plan is this", but "where, of the places you can have got to" (`server/minimap-find.js`:
  the trail; `server/minimap-ground.js`: the floors):
  - **no further than you have gone** since the place before - and that near, every turn is
    tried each time it is needed, which a look through a whole plan cannot afford. Losing you
    used to mean such a look: one to ten seconds of a figure standing still, then a jump. Now it
    is a look round a few yards, in a few hundredths of a second;
  - **never further from the last place the picture told for sure** than the game says you
    have gone since. The trail's own place can become unsure - a corridor that looks the same
    all along, something over the minimap - and you are looked for the wider for it; but how
    far you can be is not a matter of how unsure the trail is;
  - **on a floor, and one you can have walked to** from the floor you were on: not through a
    wall into the next corridor, and not up to the storey above with no stair between. Which
    floor you are on is followed the same way, a step at a time - the page is told the height
    of that floor (to a yard or two) instead of every height the rooms in sight span (forty
    yards and more, in Gnomeregan), down a drop and up a lift included;
  - **on a storey you can have got to.** Which rooms the game draws depends on the storey you
    are on, so a place is tried once for every set of rooms near it - and of those, only the
    ones with a room at a height you can have reached: by the floors (a drop and a lift take
    you far in no yards at all), or because nobody climbs further than they have walked. The
    Sunken Temple has six floors one over the other in its middle, and eighteen sets of rooms;
    before this, a picture that fitted nowhere well had every set near tried, and took one to
    three seconds there;
  - **standing, you are where you stood.** While the game says you are not moving, every
    picture is one more reading of the same place: the place given is their middle, and does
    not stir. With something over the minimap you are still there - shown as found, not as
    lost;
  - **where the picture does not say where you are** - down a long straight corridor, in a hall
    wider than the minimap shows - you are where you would have got to going on as you were,
    instead of wherever the best fit happens to be; and with something over part of the minimap
    while you run, the same, for a few seconds: drawn greyed, as a place not seen, until the
    picture bears it out again;
  - **a place that fits well where you cannot have walked to** is not thrown away - the floors
    may have a gap the map does not know of, a spell may have moved you - but it has to hold
    for three pictures running, moving as you move, before you are taken to be there. One
    picture that looks like somewhere else moves nothing;
  - **a way the floors do not have, gone twice before** - by you, or by any other copy of the
    map (see "What following you teaches the map" below) - is looked at before that: where the
    trail's own place does not fit, or is on no floor you can have walked to, and you were
    near the one end of such a way, a place at its other end that fits as well as one of the
    trail's own is believed at once, with no three pictures to wait for;
  - **the whole plan is looked through a little with each picture**, when the trail's place
    has not fitted for some seconds (you were moved far all at once, or the trail has gone
    wrong). All of it takes seconds; done in one go, the trail saw nothing for as long, and a
    few seconds of something over the minimap while you ran cost eight more. What such a look
    finds is where you were when it began: you are then looked for as far from there as you
    have gone since.
- *The door.* Coming in from outside you are at the door. The map build takes the spot each
  door puts you at from the reference database (`world.json`: `entrances`, 47 doors into 30
  dungeons of the original game), and that is where you are looked for first: found with the
  first picture, where a look through all of Gnomeregan at every turn took ten seconds. A door
  the database does not have is noted the first time you are found standing just inside it
  (`<dataDir>/user/dungeon-doors.json`), known from then on, and counted each time you come in
  by it again. The doors other copies of the map have found come with the Atlas database: one
  that anybody else has come in by is where you are looked for the first time you use it
  (see "What following you teaches the map" below).
- *Which way you face.* Where the minimap turns with you, its turn is the way you face; where
  it keeps north up, your arrow in its middle says.
- *Which floor.* The game leaves off its minimap every room that lies wholly above the ceiling
  of the room you are in. So the plan is put together once for every set of rooms that can be
  showing, and which set fits says which rooms you can be in - and between which heights. The
  page takes your height from the dungeon's own walkable ground, as it does everywhere
  (following the floor you walk on), and where the rooms on the minimap rule that floor out, you
  are put on the one they allow. With the trail in hand the heights handed over are those of
  the floors you can be standing on (see above), and the rooms' only where the map has no
  floors to go by.

**Checked against the game's own figures.** Where the game keeps its combat log (`/combatlog`
in the game, or the addon's own switch for it), that log says exactly where you stood at each
blow, and the map reads it. While the minimap has you, the log's place - which is always a
moment old - is not shown; it is what the minimap's place is held against. Where you stood
still round a blow, the two should be the same spot, and what lies between them says how far
off the minimap's middle is taken to be: after a few such blows that agree with each other, the
middle is moved by that much (never more than two and a half pixels). When the minimap has
nothing to say, the log's place is shown as before.

**What following you teaches the map of the dungeon - and every other copy's map.** Three
things come of following you that no file has. Each is kept, sent to the Atlas database with
the rest of what a copy learns, put together there with what every other copy found, and
fetched back by all of them (`server/minimap-places.js`, `atlasdb/places.js`):

| What | How it is learned | What it is good for | Gone by once |
|---|---|---|---|
| **A door** the map's data has no spot for (a dungeon new to this game, a back way in) | you are found standing just inside, having come in from outside | the trail begins there with the first picture, with no look through the plan | any copy has found it: once is enough |
| **A way** the map's floors do not have: a lift the reference database lacks, a doorway the floors are shut at, a portal | a place you cannot have walked to holds for three pictures, no more than a dozen yards on from the last place the picture told for sure, and is then borne out by a dozen pictures more | where you are not found where you can have walked to, the far end of a known way is looked at first: you are found with the next picture, where a portal across the dungeon cost a look through the whole plan (eight or nine seconds) | it has been gone twice: by one copy, or by two once each. So it is the third time anybody goes it that it saves anything |
| **A check**: how far the minimap's place was from the combat log's while you stood, summed by the 32-yard square of the dungeon | every blow while you stand still, where the game keeps its combat log (above) | the measure of how well all this works in the game itself, dungeon by dungeon (`npm run db -- places` lists it). And where a copy's checks say that a part of a plan sits off one way, every copy's place there is put right by that much, fading out towards the squares nothing is known of | one copy has ten checks in the square that point one way (taken together they are off by seven tenths of what each is off by: checks that point every way are the place wandering, not a plan sitting off), on something between one yard and six. Where several copies have as many, they must say the same to within a yard |

One copy's word is enough for all of these: the copies are few, and each has been where the
others have not. What a way waits for is not a second copy but a second finding, whoever's.
One finding proves little: the map having lost you and found you again looks the same, and
the copy that found it does not go by it either until it has seen it again. (Each time, the
place it took you to must have held.) A copy that takes a way other copies found, and is borne out the same,
adds its own word to theirs. A way leads one way: up a lift is not down it (down is a drop, which the
floors have anyway). A step of a yard on one storey is a hole in the floors and no way.

The three files (`<dataDir>/user/dungeon-doors.json`, `dungeon-ways.json`,
`dungeon-checks.json`) hold places inside dungeons and counts, and nothing of when you were
there or how the run went (a door has the day it was first found, which stays on your disk).
What is sent of them is a fact a line: "this door puts you here", "from here one gets to
there", "in this square the minimap's place is this far off, over so many checks". **Share
what this copy learns** is the switch for it, as for the rest.

Measured on the walks below, with a way the first walk found handed to a second: put across
the dungeon by a portal you are found with the next picture, standing there or running on,
where finding you took nine seconds; walking on from the top of a lift the map does not know,
your height is right with the first picture the floors do not account for, where two pictures
gave no place and a third was waited for. Fifty ways that lead nowhere you are, laid along
four minutes of a walk with things over the minimap now and then, changed what no picture
gave. None of this has been tried in the game: it needs somebody to go such a way twice.

**Measured.** On seven screenshots taken in the Stockade, three of them with the minimap turned,
every one was found, fitting 0.96 of a possible 1 with the next best place 0.3 behind; the one
taken within five seconds of a blow in the combat log was 0.2 yards from where the game said
you stood. The same seven with a tenth, a quarter, four tenths and six tenths of the minimap
covered (black, floor-coloured or bright, from eight sides: 672 tries) were found in the right
place or refused, never placed in a wrong one: with a tenth covered all were found, with four
tenths covered in black six in ten. A place far from where you were a moment ago is only
believed of a fit as good as an uncovered minimap gives, and a minimap with next to nothing lit
on it only of a good one.

**Measured again, moving.** One evening in Gnomeregan (19 November 2026: 21,365 pictures) said
what was wrong with taking each picture on its own: the place was found for 96 in 100 of them,
but 523 times it was lost and had to be looked for afresh - a figure that stood still for
seconds and then jumped -, and the minimap's place on the screen, read off its turning rim,
wandered so that the figure swung round you by yards. There is no screenshot of that evening
to hold anything against, so walks were made: a figure taken through all of Gnomeregan over
the map's own floors (2,557 yards in eight minutes, standing and turning at fourteen places, a
scuffle here and there, down the lift), the minimap drawn for every fifth of a second as the
game draws it - the rooms above yours left out, turned with you, the rim wandering as it did
that evening - and handed to the finder as the game's picture is, with where the figure really
was known. Five such walks, each through the finder as it was and as it is:

| The walk | The finder | Pictures that gave a place | That place off by, mean / worst | Leaps of more than four yards | Shown off by, mean / worst | No place, or one over a second and a half old | Lost and looked for afresh |
|---|---|---|---|---|---|---|---|
| the rim wandering | as it was | 2,447 of 2,495 | 3.8 / 7.8 yd | 10 | 4.0 / 36 yd | 7.1 s | 9 times |
| | as it is | 2,493 of 2,495 | 0.1 / 1.6 yd | none | 0.8 / 3.9 yd | 0.3 s | never |
| the same, other stops | as it was | 2,420 of 2,458 | 3.9 / 7.5 yd | 15 | 4.0 / 36 yd | 7.0 s | 4 times |
| | as it is | 2,457 of 2,458 | 0.1 / 1.6 yd | none | 0.9 / 3.6 yd | 0.3 s | never |
| the rim steady | as it was | 2,502 of 2,540 | 0.1 / 0.4 yd | none | 0.8 / 31 yd | 6.7 s | 6 times |
| | as it is | 2,533 of 2,540 | 0.1 / 1.6 yd | none | 0.8 / 3.8 yd | 0.5 s | never (at a gap in the floors, four pictures gave no place) |
| the rim wandering, and a quarter to a half of the minimap covered for a few seconds every half minute | as it was | 2,025 of 2,495 | 4.1 / 8.3 yd | 10 | 7.0 / 60 yd | 79 s | 50 times |
| | as it is | 2,375 of 2,495 | 0.2 / 23.6 yd | 3 | 1.4 / 27 yd | 5.5 s | never |
| the same, other stops | as it was | 2,045 of 2,458 | 3.9 / 7.7 yd | 17 | 6.8 / 52 yd | 67 s | 56 times |
| | as it is | 2,304 of 2,458 | 0.1 / 1.7 yd | none | 1.3 / 22 yd | 5.2 s | never |

While the figure stood, the place given moved 0.6 yards from one picture to the next on average
with the rim wandering (up to 5.7): now 0.01 or less. The heights handed to the page spanned 43
yards and held yours; now they span 3 and hold yours, down the lift's shaft as well (in the
first covered walk 21 of 2,375 places were at the height of the storey beside yours, carried on
there under a cover). A picture takes under 40 thousandths of a second on average, as before;
the longest look, six to eight seconds before, is under one. The 23.6 yards are three pictures
running at the end of a cover of the floor's own colour over half the minimap: a place a
dozen yards off fitted those better than the right one, by more than going on as you were
counts for. (Which pictures are looked at depends on how long each look takes, so that figure
differs from run to run. With every picture looked at, the same walk's worst is 14 yards, and
four such walks' worst 14, 9, 4 and 3.)

("Shown" is what the page has to go by: at every tenth of a second, the newest place that had
come by then against where the figure was at that moment - a look that takes seconds counts
there, a wrong place counts there, and so does no place at all.) A walk drawn from the plan is
kinder than the game: the game's own pictures fitted 0.93 to 0.98 that evening, these fit 0.99.
What it shows is what the trail does with the same pictures, not how good the pictures are.

**The other dungeons.** What was tuned on Gnomeregan was then walked through every dungeon
that has a plan: in by its door (the reference database's spot), five minutes round seven
stops far apart on floors you can walk to from it, on other storeys where there are any, the
rim wandering:

| Dungeon | Walked | Pictures that gave a place | Off by, mean / worst | No place, or a stale one | The longest look |
|---|---|---|---|---|---|
| The Stockade | 925 yd | 1,019 of 1,019 | 0.1 / 1.2 yd | 0.2 s | 0.5 s |
| Ragefire Chasm | 1,631 yd | 1,472 of 1,472 | 0.1 / 1.6 yd | 0.3 s | 0.3 s |
| Wailing Caverns | 1,776 yd | 1,499 of 1,499 | 0.1 / 0.5 yd | 0.3 s | 0.4 s |
| Blackfathom Deeps | 1,702 yd | 1,499 of 1,499 | 0.1 / 2.3 yd | 0.3 s | 0.4 s |
| Gnomeregan | 1,808 yd | 1,500 of 1,500 | 0.1 / 3.6 yd | 0.3 s | 0.4 s |
| Uldaman | 1,637 yd | 1,500 of 1,500 | 0.1 / 1.5 yd | 0.4 s | 0.3 s |
| Maraudon | 1,780 yd | 1,499 of 1,499 | 0.1 / 0.9 yd | 0.3 s | 0.3 s |
| The Sunken Temple | 1,743 yd | 1,475 of 1,475 | 0.1 / 1.0 yd | 0.7 s | 1.3 s |
| Blackrock Depths | 1,749 yd | 1,500 of 1,500 | 0.1 / 1.5 yd | 0.4 s | 0.4 s |
| Blackrock Spire | 1,775 yd | 1,490 of 1,490 | 0.1 / 1.8 yd | 1.1 s | 1.0 s |
| Dire Maul | 1,758 yd | 1,498 of 1,498 | 0.1 / 1.3 yd | 0.6 s | 0.5 s |
| Molten Core | 1,753 yd | 1,498 of 1,500 | 0.2 / 1.9 yd | 0.3 s | 0.2 s |
| Onyxia's Lair | 1,160 yd | 1,210 of 1,210 | 0.2 / 2.9 yd | 0.2 s | 0.2 s |

No leap in any of them, and your height right throughout but for nine pictures in three of
them. It was this that found the Sunken Temple's seconds (see "on a storey you can have got
to" above: the worst place there was 9.2 yards off before, and ten seconds had no place or a
stale one). These are walks drawn from each dungeon's own plan, like Gnomeregan's.

Cases a walk does not have, tried in Gnomeregan:

| What | What came of it |
|---|---|
| Up the lift, the map knowing it | your place and your height right all the way (141 of 141 pictures) |
| Up the lift, the map not knowing it | your place right all the way; your height the storey you came from until you walked on from the top, right a second after that |
| The same, the way known from having been gone before | as above, and your height right with the first picture after you walk on from the top: no picture without a place, none waited for |
| Twelve seconds on the run with seven tenths of the minimap covered by something dark | no look over a second; nothing said for most of it (the picture fits nowhere), a place carried on to up to 13 yards off; right again within a second of its showing |
| The same, six tenths covered by something of the floor's colour | carried on throughout, greyed, never more than 5 yards off; right again within a second |
| Moved across the dungeon all at once (670 yards), and standing there | found after 9 seconds, the old place shown until then |
| The same, running on | found after 8 seconds, and followed from there |
| Moved across the dungeon, that way known from having been gone before | found with the next picture, standing there or running on, with no look through the plan |

**What it cannot do.**

- A dungeon that stands on ground of its own - the Deadmines, Shadowfang Keep, Scarlet
  Monastery, Zul'Farrak, Stratholme, Scholomance, the raids outside Molten Core and Onyxia's
  Lair - has no plan: the game has pictures of that ground on its minimap as well, lit from
  edge to edge, and there is no dark to tell the floor from, which is all the matcher goes by.
  There the combat log's place is what there is. The dungeons that are one building have one:
  the Stockade, Ragefire Chasm, Wailing Caverns, Blackfathom Deeps, Gnomeregan, Uldaman,
  Maraudon, the Sunken Temple, Blackrock Depths and Spire, Dire Maul, Molten Core, Onyxia's
  Lair, and the Deeprun Tram.
- In the open air inside a dungeon (the arena of Dire Maul, the way in to Onyxia) the game's
  minimap shows nothing, and so nothing is said.
- A minimap that is hidden, covered by another program's overlay, or reskinned by an addon so
  that it has no gold rim and the addon's word is all there is: it works by that word alone
  where it can, and says so on the page ("looking for you on its minimap") where it cannot.
- Only the Stockade could be tried against pictures of the real game, and Gnomeregan against an
  evening's notes of it. For every other dungeon the plan is made the same way and a minimap
  drawn from it is found on it, but no screenshot was there to hold it against. The trail was
  measured on walks drawn from the plans, every dungeon's (see above), not in the game.
- With something over the minimap while you run, the place shown is where you would have got
  to going on as you were - round a corner it is wrong, by as far as you have gone since - and
  it is drawn greyed for that reason: for eight seconds, or forty yards. After that nothing
  more is said until the picture shows again, and then you are found within a second. What
  "fits worse than usual" means is learned from the pictures themselves. A fit a little under
  the usual that stays (up to a quarter under) is how the pictures now fit, within three or
  four seconds: a part of a dungeon whose pictures fit the plan less well must not leave you
  greyed all the way through it. A fit far under it is something over the minimap, for as long
  as it lasts (after half a minute of it, that is the usual). Under something of the floor's
  own colour over half the minimap, a place a dozen or two yards off can still fit better than
  the right one for a moment, and is then shown as found: once in five covered walks, for
  under a second.
- A lift the map does not know, or a way between two storeys that its floors lack. The map
  has the one lift in Gnomeregan, from the reference database, which lists none in any other
  dungeon that has a plan; a lift this game has added is not in it. Your place stays right;
  your height is the storey you came from until you walk on to where that storey has no floor
  under you, and is put right a second or two after (a place you cannot have walked to, borne
  out by three pictures). That is then noted as a way, and once it has been gone twice - by
  you, or by anybody - it is put right with one picture (see "What following you teaches the
  map"); your height on the lift itself stays the storey you came from all the same.
- Moved all at once by a spell (a mage's Blink, a warlock's summons) you are shown where you
  were for a second or two more: the new place has to hold for three pictures. Summoned
  across the whole dungeon, finding it takes a look through the whole plan: eight or nine
  seconds, standing there or running on, with the figure waiting where it was. A portal that
  always leads from the same place to the same place becomes a known way like the lift; a
  summons, which leads from anywhere, does not.
- An addon older than version 6 of the strip does not say how fast you move: then every picture
  is taken on its own, as before.

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
does report and from what the map data knows - and, every few seconds, checked against a
measurement that the game can be made to give (next paragraph). What the game reports, besides
your position: whether you are on a flight path, swimming, under water, falling or indoors; how
fast it has you moving; and what it calls the place you are in (the words over its minimap).
The addon adds what only it sees: whether a time in the air began with a jump, and whether you
are holding the key that takes you up, or the one that takes you down, in water.

**Measured, every few seconds.** The game has a marker of its own that it points at where you
are heading, and it says how far off that is. To a pin on its map that distance is the way
across the map and no more: a pin given a height of 500 yards, one given -500 and one given
none all read the same, and jumping beside a pin changes nothing. But pointed at a **flight
master** or a **landmark** of its map - places the game's data has in three dimensions - the
distance counts height. Tried in the game on 17 November 2026, at Sentinel Hill: on top of the
tower three places 136, 712 and 752 yards off all gave 95.60 to 95.62 yards for a floor the
map has at 95.6; on open ground Anvilmar, 4,352 yards away and 360 yards up, gave 38.50 where
the map's ground is at 38.49; and running up the tower's stairs, the two places of each
measurement agreed with each other to a twenty-fifth of a yard.

So the addon (`addon/AzerothAtlas/Height.lua`) points the game's marker at three such places,
one frame each, and puts it straight back on what you were tracking (a quest, a pin: nothing
is seen of it, and it works with the marker switched off, as most have it). For each place,
what is left of the distance once the way across the map is taken off is how far above or
below it you are. Which of the two the addon cannot say, nor what there is to stand on: it
sends the two places that say most through the strip, and the map, which knows the floors,
takes the floor at that height - whatever it had worked out before. Where the map has nothing
at that height you are on something it does not have (a lift on its way, a ship's deck), at
the height measured. Under water it says how deep you are. That is what makes the rest of this
section the way your height is followed *between* two measurements, not the last word on it.

Two things had to be found out for it to be that good, both in the game:

- **Where you are, finely.** What is left of a distance once the way across the map is taken
  off is only as good as that way across, and the game rounds where you are to a tenth of a
  yard (`UnitPosition`). Where its own *map* of the place has you is not rounded: laid over
  the world by that map's corners it gives the same spot some twenty times as finely, and the
  addon goes by that (and says with the measurement which of the two it had).
- **A frame late.** The distance the game gives in a frame is the one it worked out the frame
  before: it belongs with where you were then. Taken with where you are now, two places would
  disagree by a yard or two as soon as you ran; standing still they agreed to an inch.

How much a place says depends on how steeply it is above or below you: a place far off and at
about your own height says least (a town a thousand yards off at exactly your height: three
or four yards), one far over or under you most. The addon chooses the places for that, from
the 473 flight masters and landmarks of the game's data (`HeightRefs.lua`, written by
`tools/make-height-refs.mjs` from the map data; any of them can be pointed at, not only the
few the game lists for the map you are on) - and both continents have places high up that can
be had from anywhere on them: Ironforge at 495 yards and Anvilmar at 399 in the east, Mount
Hyjal at 1,659 and Darnassus at 1,335 in the west. Reckoned for a spot beside every flight
master and landmark of the two continents, at its height and thirty yards over and under it,
the best place there gives the height to within a twentieth of a yard at nine spots in ten and
a tenth of a yard at ninety-nine in a hundred. (With only the rounded spot - a map the game
gives no place on - that would be half a yard and a yard.) What goes through the strip is
good to a sixteenth of a yard.

When: on arriving somewhere (a login, a portal, a hearthstone), on landing from a fall or a
flight, on coming out of water, on going indoors or out or into a place of another name, a
moment after you stop, and every four seconds while you move (every second and a half under
water). `/atlas measure off` turns it off (and `on`, on); `/atlas measure` says what was last
found. Without it - an older addon, a map with none of those places, an instance - everything
below works as it did.

**Not while you are dead.** Dead, the game keeps its marker on your body, whatever an addon
points it at, and the distance it gives is the way to that. Taken for the distance to a
landmark, that made a ghost - who runs back along the ground - as many hundreds of yards high
as the body was far off, a little less with every step towards it; the map had nothing to stand
on up there, took it for "something the map does not have", and the camera that follows you
went up into the sky after it and came down again every four seconds. (Reported on 20 November
2026, from Stranglethorn: "my map keeps zooming in and out and losing position". The report's
own notes had the ghost at 660 yards up at the graveyard and at 236 a minute on; reckoned
from the way to the body, at the two moments the report has a spot for, it comes to 330 and
236 yards where the map had noted 332 and 236.) So:

- **The addon measures nothing from dying until you live again** (`UnitIsDeadOrGhost`, and the
  game's own word that its marker is on your body: `C_SuperTrack.IsSuperTrackingCorpse`), and
  does not point the marker anywhere in that time. A fix it was in the middle of when you died
  is given up, the marker put back in that frame. Alive again, it measures at once.
- **A distance has to go with the marker.** The marker is pointed at three places, one frame
  each, and the distance to each is another: they differ, as a rule by hundreds of yards. Three
  that are the same, but for what you moved in between, are the distance to one thing, which
  is none of the three - whatever holds the marker, said by the game or not. Nothing is made of
  such a fix, the addon notes it once (with what the game says it is tracking), and tries less
  and less often while it lasts.
- **A place is not struck off on such a distance.** A place the game gives a shorter distance
  to than the way across the map is "not where the list has it", and is left alone until the
  next `/reload`. As a ghost every place further off than the body was that - Ironforge and
  Anvilmar first, the two that say most from anywhere in the east. That is now decided when the
  fix is finished, and only for one whose distances went with the marker.
- **The map passes over a measurement that comes while you are dead**, so a copy of the addon
  from before this (version 27 and older) does no harm either: nothing to do in the game for
  the map to be right again.

The addon's part needs its version 28 (**Check for updates**, then `/reload` in the game).

**On a flight path** (the game says so) your height is the flight route's own: every route is
in the game data as 3D points, and the map follows the same curve through them. Where it sets
you down you are on the ground at the flight master's height, which is also in the data, so you
arrive on the platform and not under the city.

**On a zeppelin or a boat** there is no such flag, but the game counts how fast you move from
the deck you stand on: it says you are standing (or strolling) while the map sees you cross
the sea. Where the game owns up to less than a third of the speed the map sees, for most of a
second, along one of their routes, something is carrying you, and your height is that route's.
That holds at any speed, from the first second. (A copy of the addon from before it sent the
speed is served as before: they are recognised by moving along one of their routes faster than
you can travel yourself, which takes longer and misses a ship that is crawling.) A zeppelin
slows to a crawl long before its tower: once it has been carrying you, you are on its deck, at
its route's height, for as long as you are on its line - until you step onto something the map
has within reach of that height (the tower's platform), and not, as it was, onto the ground far
under the ship after twenty yards of crawling.

**Through a portal to another floor** of the same building (the one at the top of Stormwind's
Mage Tower, into the Wizard's Sanctum under it, and the one back out) you move a few yards
across the map and a long way up or down, in no time. Nothing the game reports says so, and
retraced as a walk it would leave you on the floor you came from. The map knows those portals
and where they put you down (`viewer/teleports.json`: where each takes hold is in the game's
files, where it leads is not): at one's doorstep on its level, then all at once where it puts
you down, faster than anything carries you on the ground, you have gone through.

**Through a portal from far away** - the Skyborne Portal in Dalaran puts you in the Wizard's
Sanctum, under the Mage Tower and under the streets - there is no doorstep to have been seen at,
only a jump with nothing in between. Wherever you arrive like that within ten yards of where a
portal puts you down (one in `viewer/teleports.json`, or a doorway between maps), you are on the
floor it puts you down on. Before, the map took the lowest floor not buried under the terrain,
and had you on the street over the Sanctum.

**Walking**, the map retraces the way from your previous position in quarter-yard steps over
the surfaces you could be standing on and stays on the ground as it rises and falls. Those
surfaces are the terrain, the floors, stairs and bridges in the buildings' collision data, the
surface of deep water - and what the game places as *objects*: the decks of docks, the planks
of rope bridges, scaffolds, ramps. The page's own floor lookup has only buildings; the
walkable-ground data made for the route planner (`maps/<id>/nav`) has the collision of objects
too, so it is asked as well (`viewer/js/navgrid.js`).

- Only surfaces with room for a character above them count, so the floor underneath the first
  treads of a staircase, or under a counter, is not somewhere you can be.
- If the ground carries on at about the same height (a tread up or down), you are still on it.
  That is what takes you up a staircase even though the floor carries on underneath it.
- If something stands between your feet and your head, you have stepped up onto it.
- If neither the terrain nor a building has anything at your height any more (for longer than
  a hairline gap), but the walkable-ground data has something to stand on there, you have
  walked on onto that: the first plank of a dock where the quay ends, a bridge that is an
  object.
- The ground can also carry on *under* such a thing: a beach slopes away under the planks of
  its dock. Where the walkable-ground data has nowhere to stand at the ground's height in its
  cell (a character needs 1.7 yards of room, and the planks are in it) and has the top of an
  object just over it, you are on the object, not under it. And on water too deep to stand
  in, not swimming, with an object's top a little over the water, you are on that: so a dock
  left by mistake is found again at the latest over deep water.
- That data is a yard coarse - a cell of it holds whatever reaches into the cell anywhere -
  so a floor of it only counts as *a thing of its own* (somewhere a fall can end, a second
  place you might be) where no floor of a building and no ground comes within 1.2 yards of
  its height anywhere in its cell. Else it is the edge of a roof over the street beside it,
  or the porch a step further on: taken for objects, those made every street beside a house a
  place with "two floors".
- If the ground ends and the game does not say you are in the air, you are taken to be on
  something the map does not have at all (a ship's deck) and your height is kept, for up to
  20 yd of travel.
- The storey above is never any of these, so it stays over your head.

**In the air.** The game says when you are in the air and when that ends, and the addon whether
it began with a jump. Nothing is decided while you are up there. Where you come down, how long
you were in the air says how far you fell - the game's gravity is 19.3 yd/s², a jump leaves the
ground at 7.96 yd/s, and nothing falls faster than 60 yd/s - and of the surfaces at that spot
the one at that height is where you landed. So a jump across a gap lands on the far side and
not at the bottom of the gap; a hop on a staircase stays on the staircase; and a drop down a
stairwell ends on the storey the time fits, not on the first thing under the edge. (Before, a
fall was "believed" once it had lasted long enough to cover the drop to the next surface
below, whatever lay beyond it.) While you fall, the figure is drawn falling.

**In water** too deep to stand in you are at the surface for as long as the game says your
head is above it. Under it there is no measurement, but there is something to reckon by: the
speed the game has for you counts the way down as well, and the map sees how fast you cross
it. What is left over is how fast you sink or rise. Which of the two the game does not say; so
it is rising while you hold the key that takes you up (Space), and sinking otherwise - you
went under to get down there. You are never put above the surface or under the bottom the map
has at that spot. While nothing changes the game says nothing new, so this goes on by the
clock between its readings. It is dead reckoning: it tells the bottom of a lake from its
surface, which is what a route or a quest marker needs; it is not right to the yard, and after
a long dive with many turns you may be shown deeper than you are until your head comes out.
On deep water without swimming, something is carrying you (a boat), and the first pier within
reach above the water is where you step off.

**On a lift** you go a long way up or down with no step across the map, and nothing the game
reports says so. But the map now knows where the lifts are and how far each goes
(`world.json`: `lifts` - 24 of them: the Undercity's three, the lifts of Thunder Bluff and of
Thousand Needles, the one down to Gnomeregan, the scaffold cars of the Searing Gorge; from the
reference database's list of what moves, and the game's own table of how far). Having stood
still on one for two and a half seconds, where you
step off decides which end you are at: the end that has a floor there (or, of a lift that
calls at more heights than two - the scaffold cars - the stop that has). If the level you got on
at carries on there as well, that one is followed alongside (next paragraph). A route takes
the same lifts (see "A lift is a way").

**More than one answer.** Sometimes the height is a guess: arriving somewhere with several
floors, stepping off a lift, a fall that fits two surfaces, ground that was not there for
twenty yards. From such a moment the other floors at that spot are followed alongside, each as
if it were the one you are on, and what the game goes on to say is held against every one of
them:

- a floor that ends under you where another carries on;
- a wall between two spots you were at one after the other: the walkable-ground data knows,
  for every yard of every floor, which of its four sides lead on;
- a room the game counts as indoors, while it says you are outdoors;
- a room with another name than the game shows over its minimap, where a room of that name is
  at that spot. The game's files name the rooms of its buildings (`rooms.json`: 1,533 names
  for the rooms of 864 buildings - "The Park", "Cathedral of Light", "Stormwind Keep"); the
  addon sends the name the game shows as a number, and the map makes the same number of each
  room's name.

The floor that fits best is where you are, and when another comes to fit clearly better you
are moved to it. This is only done from a real guess and for forty yards of walking after it:
if nothing has told the floors apart by then, the guess stands. A floor you walked to step by
step is never put in doubt by any of it. (That was tried: the walls in the ground data are a
yard coarse, and the map's idea of which rooms the game counts as indoors is right on
Stormwind's streets and wrong in some of its shops, whose floor is a piece of the street's. So
the game's word on indoors is only ever taken the one way round that holds - it says outdoors,
so you are not on the floor of an indoor room.)

**Arriving with no way in between** (hearthstone, teleport, login, a new map), in this order:
the height saved for your last position if you are still there; the height you had when you
walked through that place before (floors of buildings you have been in are remembered in the
browser, so hearthing back to an inn you have walked around in puts you on the right floor); a
flight master's if you are beside one; otherwise the topmost surface outdoors and the lowest
sensible floor indoors - with the other floors there followed alongside, as above.

What the tracker decides is written in the page's notes (`page.log`, lines beginning
`height`; see "The notes it keeps"): something carrying you, a fall and where it was settled,
a lift, a dive, a guess and the floors followed with it, a move to a floor that fits better,
and every time a measurement put you somewhere other than where you were taken to be. A report
sent in has them. The addon notes the first measurements of each login in full (what the game
gave, and the way across the map by the fine spot and the rounded one), and when the game gives
it nothing.

Limits that come from the game, not from this tool:

- The game only tells addons the position of you and your group, never of creatures or other
  players, so live enemy positions cannot be shown (spawn zones show where they are stationed).
- Inside dungeons and raids the game may hide your position; the map then only switches to
  the right map. There is nothing to measure by there either.
- Your height is measured every few seconds, not all the time, only on maps the game's
  data has flight masters or landmarks for (the two continents; not instances), and not while
  you are dead (the game's marker is on your body then). Between two measurements, and where
  there are none:
  - a lift is only known where the game's data has it as one, and only taken where you stood
    still on it;
  - a first arrival indoors somewhere you have never walked is a guess, with the other floors
    followed alongside;
  - under water the depth is reckoned from your speed.
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
| `maps/<id>/nav/<col>_<row>.bin` (`WFN1`) | Where a character can stand, and what can only be slid or fallen down, per tile, on a 512 x 512 grid (1.04 yd). Sections (each deflated): 2 number of surfaces per cell (at most 14, lowest first), 3 their heights (uint16, 1/8 yd, +2048, stored as differences), 4 flags per surface (1 swim, 2 lava, 4 terrain, 8 steep ground: nowhere to stand, only a way down; 16 / 32 / 64 / 128 = a floor you walk on from to the cell east / west / south / north), 5 links per surface (uint16: four bits each for east, west, south, north, lowest first: 0 leads nowhere that way, 1 to 14 the surface of the next cell it leads on to, counted from 1, by a step where the flag for that side is set and by a fall where it is not, 15 open on that side at the edge of the tile), 6 the room over each surface along the tile's four edges (uint16, 1/8 yd, 65535 open sky, 0 not open on that side: for the east, west, south and north edge in turn, each cell along it, each surface of that cell - what a fall across the seam of two tiles is checked against). Steep ground is kept only where it is part of a way from a floor down to a floor. Tiles built before 0.5.1 have sections 2 to 4 only and are still read. A map that is one building has no tiles: it has one such file for each square of the same grid that its building reaches into, and `maps/<id>/map.json` lists them (`nav.at`: `[col, row]` each) |
| `maps/<id>/creatures.bin` (`WFC1`) | Stationed creatures: section 1 JSON (`creatures`: name, `min`/`max` level, `rank`, reaction to Alliance `a` and Horde `h` (0 friendly, 1 neutral, 2 hostile), `est` level estimated, `u` = no side recorded (new to this game: shown only when asked for), `t` = these spawn points are inside a town or city of the Alliance (1) or the Horde (2) and make no zone for that side), 2 spawn points (float32 world x, y), 3 creature index per spawn point, 4 patrol route points, 5 routes (`creature, firstPoint, count`) |
| `models/wmo/<id>.bin` (`WFM1`) | Section 1 header (JSON: its groups with the game's flags, box and run of vertices; `left`: the groups left out and why - see "What of a building or an object is not drawn"), 2 vertices (36-byte stride, position first), 5 collision triangle indices, 6 the game's per-triangle flags (`0x08` collision, `0x20` render, `0x04` detail, `0x02` no-camera-collide), 7 interior object placements, 8/9 interior liquid surfaces |
| `models/m2/<id>.bin` (`WFM1`) | Section 4 collision vertices, 5 collision triangles |
| `maps/<id>/npcs.bin` (`WFP1`) | Every creature and quest object with somewhere to be: section 1 JSON (`entries`: `id`, name `n`, title `s`, levels `l`, rank `r`, reaction to Alliance `a` and Horde `h`, `u` = side not recorded, job flags `f`, `ct` what kind of thing a creature is (the reference database's number: 1 beast to 9 mechanical), quests started `qs` and ended `qe`; `k: 1` = an object), 2 spawn points (float32 x, y, z; z is NaN where not known), 3 entry index per spawn point, 4 how each height is known (0 not known, 1 likeliest of several, 2 only place to stand, 3 reference database, 4 reference and ground agree, 7 as another player saw them, 8 on the level another player fought them on; 5 and 6 are the page's own, for your sightings and fights). `unplaced` in the JSON names who QuestieDB lists on the map that neither source could place |
| `quests.json` | Every quest: name `n`, level `l`, from level `m`, side (1 Alliance, 2 Horde, 3 either), who starts (`s` NPCs, `so` objects, `si` items) and ends it (`e`, `eo`), its text `t`, what it asks for (`oc` creatures, `ok` kill credit, `oo` objects, `oi` items), what comes before and after; from the reference database, where it has the quest: `nd` how many of each (`[kind n / o / i, id, count]`), `ty` its type (elite, dungeon, raid...), `tl` its time limit. Plus `items`: those quests ask for, with what drops them (`d` creatures, `o` objects, `v` vendors) and how often (`dc`, `oc`: per source `[per cent, how many at a time]`); `mobs`: every creature a quest has you kill or that drops something wanted (`sp` spawn points, `lv` levels, `rk` rank, `hp` health, `ct` kind, `rs` seconds to come back); and the name and first position of every NPC and object mentioned. `source` and `reference` name the two databases |
| `user/npcs-seen.json` | Where you have seen NPCs stand for yourself (see "Seen in game"). Never touched by a map update |
| `user/dungeon-doors.json` | Where you were found standing just inside a dungeon's door that the map's data has no spot for (see "Inside a dungeon: your place, read off the game's minimap"): map, place, height where it is known, the way you faced, how often you have come in by it, and the day it was first found. Never touched by a map update |
| `user/dungeon-ways.json` | The ways you went inside a dungeon that the map's floors do not have (a lift it does not know, a portal): map, the place you left from, the place you came to, how often. Gone by from the second time. Never touched by a map update |
| `user/dungeon-checks.json` | How far the minimap's place was from the combat log's while you stood, summed by the 32-yard square of each dungeon: how many checks, the sums north, west and in all, and the same as last sent. Never touched by a map update || `sources/classic-db/` | The reference database as downloaded, with a note of where it came from |
| `sources/questiedb/` | QuestieDB as fetched from the Atlas database (see "Where QuestieDB comes from"): `source.json` says which version is in use, and the files are in a folder of that version's own, laid out as in the addon, with QuestieDB's licence. The version before it is kept until the next one comes |
| `rooms.json` | What the game calls the rooms of its buildings: `names`, and per building (`wmo`: by the building's number in the game's files) runs of three numbers - which set of names the placed building uses, the room's number in it (-1: the whole building), and the name's place in `names`. For telling floors apart by the name the game shows (see "How your height is known") |
| `world.json` | Area names/hierarchy, zones with world rectangles, points of interest, liquid types (water / ocean / magma / slime), `lifts` (each lift: map, where it stands, the heights of its two ends `lo` and `hi`, how far from its middle its platform reaches `r`; and, read off the game's table of how it moves, the heights it stands at `stops`, the seconds its round takes `round`, the yards a second it goes between stops `speed` and the seconds it stands at one `still`), **flight masters and flight paths with their full 3D route points** (boat and zeppelin routes too; `pointMaps` says which map each point is on when a route crosses continents), `transports` (each boat / zeppelin line: its stops with map and position, seconds to the next stop, seconds for a full round), `portals` (doorways between maps, from `extractor/doorways.json`, or ShortestPathForever's `Data/Portals.lua` where that addon is installed), `inns` (every innkeeper: map, zone, position, reaction to each side; from QuestieDB), area triggers (dungeon entrances and other transitions), `entrances` (where each door into a dungeon puts you: map, position with height, the way you face; from the reference database) |

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
- draws at most 30 times a second while it is not the window in front - and always while it is
  drawn over the game (see "Overlays"), where the game is what is in front whatever Windows
  tells the page;
- drops to 75 %, then 50 % resolution while the card is still slow to hand frames back (the
  line under the layer switches says so), and returns to full resolution when the card has time
  again, or at once when you click on the map;
- asks Windows for a picture of the game window only as often as it reads one (about 20 a
  second), instead of a copy of every frame the game draws.

With that, frames come back in about 20 to 30 ms and the long freezes are gone. What is left is
the card itself: if the game is drawing as fast as it possibly can, anything else on that card
waits its turn. Capping the game's frame rate (its own "Max Foreground FPS" setting, or vertical
sync) leaves room for the map and usually costs nothing you can see.

## The Atlas database

Who and what is in the world - every creature, object and quest - is also kept in one database
of Azeroth Atlas's own, which every copy of the map adds to and takes from. Much of this game
is nowhere in its files: the game's server tells your game about a creature or a quest only
when you meet it. So no single player, and no single source, has all of it; put together, the
copies of the map do.

**What is in it.** One record per creature, object and quest, made from every source there is,
each fact with a note of where it came from (and one per dungeon, of its insides: below):

| Source | What it gives | Believed |
| --- | --- | --- |
| **The game's own cache** (`Cache/WDB` in the game folder: what the server told your game about what you have met) | A creature's name, kind, family and rank; a quest's level, what it asks for and how many, what it gives; an object's kind | first: it is the server's own answer. Every copy's cache is believed; where several have sent the same thing, a vote settles it (below) |
| **Seen in game** | where an NPC really stands, noted when you talk to it; where an object is, noted when you take something out of it | next |
| **What a fight shows, whom the addon met, and what the game's windows show** (the game's combat log, as each copy's map read it; what the game shows of a creature you target, have the mouse on or see a name plate of; a vendor's and a trainer's window, and the game's own quest pins) | where a creature was when a fight with it began (inside dungeons too, where nothing else says); its health at each level it has; how it stands towards each side; what a vendor sells and a trainer teaches; where the game's map puts a quest | next. Its health is believed before every other source's, being the game's own figure (this game's creatures have more health than the original's: a Defias Captive 2,538 at level 24, where the reference database has 1,815). Its levels only add to what is known, never narrow it: a fight shows the levels met, not all there are. Where copies differ on a figure, what most say |
| **Which level a creature is on** (a fight of yours beside it that put it on your level, where the map had only guessed: see "Seen in game") | the height of the floor it was fought on, at a spot of the map's own for it | for that spot's height only, and only over the map's own guess. What most copies say; where two levels are said by as many, nothing |
| **Wowhead** (its database for this game, which its own users' games feed; read by the database's maintainer and handed in as a file) | a creature's name, level, kind, rank and how it stands towards each side; a quest's level, experience, money and rewards; and, where its page was read, where a thing stands and what a quest asks for | next for what a thing is; after QuestieDB for where things stand and who gives which quest, so it fills in what QuestieDB lacks |
| **QuestieDB** | everything it has for this game: names, levels, sides, where things stand, who gives and takes each quest, what comes before and after it; quest experience measured from players' sessions | next |
| **cmangos classic-db** | the original game: heights, a creature's kind and health, how soon it is back, drop tables, how many of each thing a quest asks for | last: right for most of the old world, silent about everything new |

Where two sources say different things the record keeps both: the one believed, and what the
other said (the server calls a creature "Searing Lava Spider" where QuestieDB has "Greater Lava
Spider"). Nothing is lost by merging, and a disagreement can be looked into.

**Where copies disagree about the game's cache**, a vote settles it, fact by fact (a name, a
level, what a quest gives). Each copy has one voice about a thing: the last it sent.

| Copies that have sent the thing | Believed |
| --- | --- |
| one | what it says |
| two | what the later one says |
| three or more | what most say; where that is a tie, the side whose latest voice is the later |

A copy that has the thing but not a fact the others give (no money for the quest, say) counts
as saying "there is none", so one copy cannot add a fact of its own to what several agree on.
"Later" is when the database took the delivery, which a copy cannot set ahead. A delivery is
believed only for what a game cache holds (the facts in the table above, each in its own
shape): anything else sent with it, such as where a creature stands, is left out. What the vote
does not do: a thing only one copy has ever sent is believed as it stands, and a voice is an
anonymous account, of which one person can make several. `votes` (below) lists every fact the
copies disagree about, who said what, and what was believed.

**The map is built from it.** QuestieDB and the reference database are what the map is built
from; the Atlas database is laid over them when the map is built (`extractor/atlas.js`), so what
any copy has learned is on every copy's map. What it adds, and what it leaves alone:

- **Whom QuestieDB does not list at all**: creatures, objects and quests known only from the
  game's cache, a fight or Wowhead (as the database stood on 18 November 2026: 171 creatures,
  3,403 objects, 111 quests).
- **A place** for a creature or object QuestieDB lists and does not place (428 and 210): from a
  sighting, from where a fight with it began, from Wowhead's page. Wowhead has some creatures on
  no zone's map, only on a continent's own, where a pin is some 35 yards coarse: those are used
  only where nothing else says where the creature is.
- **A level, a side, a giver** where QuestieDB has none (a level for 70 creatures; a side for
  2,513 that have no faction recorded, from how Wowhead and players' own fights say they stand
  towards the Alliance and the Horde; who gives or takes 88 quests).
- **The game's own word** where it differs: a name as the server gives it, a rank from the
  game's cache, health as fights showed it.
- **Left alone**: what QuestieDB has. Its levels, sides and places are what the spawn zones and
  the danger zones are worked out from, and another source's different opinion does not move them.

A newer database changes the map only where it says something new: each map's NPC layer is
built again only if its own contents changed (5 to 26 seconds, the larger figure where a whole
continent's layer is redone). So the map does it by itself, a little after it starts and
whenever a newer database has been fetched, and the page loads the result
(`"database": { "apply": false }` in `config.json` leaves it to the **Update map** button, which
then reads "new in the Atlas database"; `"atlas": false` builds the map without the database).

**What a fight shows.** The game can write every blow of a fight to a file (`Logs\WoWCombatLog...txt`
in its folder: the same log raiders hand to log sites; `/combatlog` is the game's own switch for
it, off at every login). Each line names who struck whom and carries figures of one of them:
where it stood, its level, its health. The map reads the file while the game runs
(`server/combatlog.js`; only ever reads it) and keeps, of each creature: where it was when it
first came into a fight, its health at that level, and whether it was hostile to your side. Not
kept: anything of other players, pets and guardians, or when a fight was. Your own place in
those lines is used for one thing, on your own computer: showing you on the map inside a
dungeon (see "Dungeons"). And of how your own fights went one thing is made, which stays on
your computer too (`server/fights.js`, `user/fights.json` in the map's data folder): of the
last sixty you fought alone, how long each lasted, what you dealt in it, how many creatures
died and of which level, which level you were, and how long after the fight before it began -
for the quest explorer to reckon a kill by your own pace (see "Quests": how the time is worked
out). No name is in it, nothing of anybody else, and it is no part of what goes to the Atlas
database. The addon asks the game to keep the log each time you enter the
world, and never switches off a log it did not switch on itself; `/atlas fights` (or the
addon's options) stops it asking, and `"combatLog": false` in `config.json` stops the map
reading. The file grows by a few megabytes an evening and the game never clears it: delete old
ones in the game's `Logs` folder whenever you like.

**Whom the addon met.** Of a creature you have targeted, have the mouse on or see a name plate
of, the game shows an addon its level, its health and how it stands towards you. The addon
notes those (`addon/AzerothAtlas/Met.lua`; `/atlas met` says how many) in its saved settings,
which the game writes when you log out or `/reload`, and the map reads them there. So a creature
nobody ever fights gets its level and side as well. Left out: players, their pets, a creature
whose level the game shows as a skull, and whatever the game withholds in a fight or inside a
dungeon.

**What the game's own windows show.** Three more things the game says to an addon and keeps in
no file, noted the same way (`addon/AzerothAtlas/Learned.lua`; `/atlas learned` says how many;
read by `atlasdb/learned.js`):

| What | When | What the map does with it |
| --- | --- | --- |
| **What a vendor sells**: each thing, what one purchase costs, how many it gives, whether its stock runs out | when you open its window | The vendor's card lists it ("Sells 23 things: Coarse Thread, Gray Dye…"; hover for the prices). A recipe's reagent that some vendor was seen to sell counts as sold by a vendor, as QuestieDB's do. A price falls with your standing with the vendor's people, so the database keeps the highest anybody was shown. Things sold for tokens or marks are left out |
| **What a trainer teaches**: each spell, what it costs, the profession and skill it asks for, the level it asks for | half a second after you open its window (the game fills the list late) | The trainer's card says how many things it teaches. A recipe is **learnt at** the skill a trainer asks: the game's files have 1 there for most of what trainers teach, the trainer's own window has the real figure. Left out: what you know already (the game no longer says its level), and a hunter's pet trainers |
| **Where the game's own map puts a quest**: the pin of what is still to do, of where it is handed in, and - where this game's server says so - of where a quest on offer starts | as your quest log and the game's map change; a pin counts once it was seen twice | A quest nothing else places has that to go by: the route to it leads to the game's own pin ("where the game's map puts it"), and the quest explorer plots it there |

To read a trainer's whole list the addon needs "available" and "unavailable" both shown; one of
the two that you have switched off is switched on for the read and off again in the same
moment. None of the three has been tried in the game by the map's maker: they go by the game's
own window code, read out of the installed game, and by what other addons do in this client.

**The insides of the dungeons.** Besides the three kinds of thing there is one record per
dungeon (`/truth/place`, made by `atlasdb/places.js`): the doors copies were found at having
come in that the map's own data has no spot for, the ways they went that its floors do not
have (a lift, a portal), and how far the minimap's place was from the combat log's, by the
32-yard square. Each with how many copies say so and how often. One copy's word is enough to
go by: a door any copy found, a way gone twice (by one copy, or by two once each), a square
one copy has ten checks in that point one way - and on which the copies that have as many say
the same to a yard. Where several copies say where a thing is, a copy's word weighs by how
often it found it, and never for more than five findings: one copy does not carry the rest. Nothing else says anything of this, so there is no source to
believe first; the record is what the copies sent, put together. What it is for is under
"Inside a dungeon: your place, read off the game's minimap".

**What a copy sends.** While the map runs it reads the game's cache, its own sightings, what a
fight showed and whom the addon met (above: "a creature of this kind was here", "at this level
it has this much health", "it is hostile to this side"), which level a creature is on where a
fight of yours settled it ("a creature of this kind is on this level here"), what the game's
windows showed ("this vendor sells this for so much", "this trainer teaches this spell at this
skill", "the game's map puts this quest here"), what following you through a dungeon taught
the map of the dungeon ("this door puts you here", "from here one gets to there", "in this
part of it the minimap's place is this far off": not when you were in it, how the run went, or
which way you took through it), and what
the addon has seen of the boats (see "Boats, zeppelins and the tram, live": a boat sighting
is a line, a stop and a moment, with no names; of a ride of your own, that does say this copy's
player was aboard then), and
sends what it has not sent before: a little after it starts, whenever the game has written its
cache or the addon's saved settings again (it does when you log out, leave the game or
`/reload`), after you have met an NPC or the map has learned something of a dungeon, and every
six hours besides. **Facts about the game
world and nothing else**: not your account, your characters, your realm or your computer's
name. Of what you have seen of the world, not where you were or when: a sighting of an NPC goes
as "this NPC stands here". A boat's moment is the one thing sent that has a time in it. The
game's files are only ever read.

**Who a copy is to the database.** Nobody in particular. The first time it runs, a copy asks the
database for an anonymous account: a made-up name and a key to come back as the same one, kept in
`<dataDir>/atlasdb/install.json`. No e-mail, no password, nothing about you; delete the file and
the copy is a new nobody the next time. What a copy sends is filed under that name.

**What a copy may do there** is settled by the database's own rules (`atlasdb/rules.json`), not
by the copy: any copy that has signed in may read what is published (the records, the auction
prices, QuestieDB); each may add to its own
corner of what was sent, and may neither change nor take back what it has sent, nor see anybody
else's; and only the copies the database lists as maintainers may publish (the records, and the
auction prices: see "Auction prices"). The address and the
key in `atlasdb/database.json` are no secrets: the key only says which database is meant.

**The switch.** At the bottom of the sidebar: **Share what this copy learns**. Unticked, the
copy sends nothing and still gets what the others have found. (`"database": { "share": false }`
in `config.json` is the same switch; `"database": false` switches the whole thing off.) The
line is only there in a version that names a database.

**By hand** (`npm run db -- <command>`, or `node atlasdb/cli.js <command>`):

| Command | What it does |
| --- | --- |
| `status` | what is published, how many copies have sent something, what this copy has |
| `collect` | send what this copy has learned, now (`--dry`: only say what would be sent) |
| `pull` | fetch the database as published (only the parts that changed) into `<dataDir>/atlasdb` |
| `questie` | fetch QuestieDB as the database has it, if this disk has another version (below) |
| `show npc 263380` | one record (`quest`, `object` likewise, and `show place 90` for a dungeon by its map's number; `--local`: as last fetched) |
| `places` | the dungeons: the doors and ways the copies found in each, how many copies and how often, which of them are gone by, and how far off the minimap's place is there by the copies' checks (`--local`: as last fetched; `--sent`, for a maintainer: as what was sent comes to now, published or not) |
| `publish` | make the database again from the sources on this disk and everything every copy has sent, and write what changed. For the copy that keeps the database: `"database": { "maintain": true }` has the map do this by itself. The database lets only a maintainer do it |
| `whoami` | the made-up name this copy is signed in under |
| `votes` | every fact on which the copies' game caches disagree, and how the vote went (`votes quest 95534`: one thing). For a maintainer: it reads what was sent |

The pieces: `atlasdb/records.js` (a record, and how sources are merged into one), `collect.js`
(what a copy gathers and sends), `boats.js` (the boats: a sighting as it is sent, and how a
line is measured from everybody's), `places.js` (the insides of the dungeons: a door, a way and
a check as they are sent, everybody's put together, and what of that is gone by),
`server/minimap-places.js` (what the map's server keeps of them and goes by),
`publish.js` (making, publishing and fetching the database),
`extractor/atlas.js` (laying the database over QuestieDB when the map is built), `server/combatlog.js`
(reading the game's combat log), `rtdb.js` (talking to the database: plain web requests, nothing to install), `signin.js` (the
anonymous account), `rules.json` (the database's rules, as pasted into the Firebase console),
`extractor/wdb.js` (reading the game's cache), `server/atlasdb.js` (the map doing it by itself).

### Where QuestieDB comes from

The map's creatures, NPCs, spawn zones and quests are built from **QuestieDB**, the community's
database of this game (github.com/Questie/QuestieDB), which is published as an addon. The map
used to read it from the addon in your own game folder, so everybody had to install it and keep
it up to date for the map's sake. Now it is fetched for you:

1. **A scheduled function in the cloud** (`functions/questie.js`, part of the Atlas database's
   own Firebase project, beside the one that reads the auction houses) asks once an hour where
   QuestieDB is published which version is the latest. That is one small question. Only when
   the answer is another version than the database holds does it fetch that release (16 MB) and
   write the files the map reads into the database, under `/questie`, **as QuestieDB publishes
   them**: the data file for this game, what the addon keeps beside it (quest experience, drop
   rates, the dungeons and their doors), and QuestieDB's licence. Nothing is changed in them.
2. **Every copy of the map fetches them from the database** into
   `<dataDir>/sources/questiedb`: when **Update map** runs, a little after the map starts, and
   every six hours while it runs. A look that finds nothing newer is one small request. A
   newer version is about 10 MB to fetch, less where only some of the files changed; it is
   checked file by file against the fingerprints the database gives, read once to see that it
   can be read, and only then put to use. **Update map** then turns orange.

So the map needs no QuestieDB addon, and a newer QuestieDB reaches every copy within hours of
its release, whoever has what installed.

**The addon in your game folder still counts** where it is there: of the fetched copy and the
addon, the map is built from the newer version (the fetched one where they are the same). So
somebody who keeps the addon up to date is not held back should the database ever fall behind,
and without a connection, or with `"database": false`, the addon is what is read, as before.
The same data in either place is the same data: a map built from the addon is not asked to be
built again the day the fetched copy of that version arrives.

**In the game**, addons that use QuestieDB - Questie, guide packs - need the addon itself in the
game's AddOns folder: the game loads nothing from anywhere else. The box **QuestieDB** under
**Other addons** puts it there where you have none, straight from where QuestieDB is published
(the database holds the files the map reads, not the whole addon), and lays the Atlas database
over it: see "What your other addons ask of QuestieDB, Questie and Auctionator".

**What is refused.** A release whose data file is laid out in a way this version of the map
cannot read stays in the database and is not fetched (the copy in use goes on being used, and
`status` says so); a release with less than half the creatures, objects or quests of the last
is taken for broken by the function and not put in at all. `/questie/check` in the database
says when the function last looked, and what went wrong if something did.

| In the database | |
| --- | --- |
| `/questie/meta` | which version is there: its tag and version, the layout of its data file, where it came from, how many creatures, objects, quests and items it holds, and the list of its files with the fingerprint of each |
| `/questie/data/<fingerprint>` | one file, gzipped and written as text in pieces of 4 MB (the database takes no larger, and compresses nothing itself) |
| `/questie/check` | the function's last look: when, and whether it found the same version, took a new one in, or failed |

For whoever keeps the database: the function goes into the cloud with the others
(`node tools/cloud.mjs deploy`), needs no key (QuestieDB's releases are public), and the
database's rules must let copies read `/questie` (`atlasdb/rules.json` does:
`node tools/cloud.mjs rules`). `node tools/cloud.mjs logs` shows what the functions' last runs
said. The copy that makes the database (`publish`) reads QuestieDB the same way as any other,
so the records are made from the newest version there is.

QuestieDB is the work of the Questie team and its many contributors, who let it be copied under
the GNU General Public License, version 3 (their `LICENSE.md` and the licence itself travel
with the files, and lie beside them on your disk). Azeroth Atlas is not affiliated with or
endorsed by the Questie team.

## Auction prices

What every item costs at your auction house, and how that has moved: the **Auction prices**
section of the sidebar. Choose your house there (your ruleset and your side), then **Open the
price list**: every item for sale, to search, filter by kind and quality, and sort by any
column. Click an item for its own page: what it gives (its armor, damage and stats), what it
costs now, how much of it is for sale, which recipe makes it and what that costs, and two
charts, its price and the pieces for sale, day by day or look by look. **Crafting**, beside
**Items** at the top of the list, is every recipe of every profession, costed at today's prices.

Two prices are told apart everywhere:

| | |
| --- | --- |
| **Lowest** | the cheapest anybody asks for one piece right now |
| **Going price** | what the cheap end of the market asks, with the oddities left out. Of all the pieces for sale, cheapest first: the cheapest 15% are taken, then more, up to 30%, for as long as each costs no more than 1.2 times the one before; their average is taken, anything further from it than one and a half times their spread is dropped, and the average is taken again. One seller dumping a single piece moves the lowest, not this |

**Where it comes from.**

| Source | What it gives | How fresh |
| --- | --- | --- |
| **Blizzard's own game data** (its API for developers) | every auction in every house: the item, how many, the price | Blizzard makes each house's list anew once an hour |
| **The game's own tables**, read from your installed game | each item's name, quality, kind, levels, what a vendor pays for it; its armor, damage and stats; every recipe and what it uses | whenever the game has been sent new records |
| **TradeSkillMaster's public price files** | what no list of auctions can say: how often an item sells of the times it is put up, how many sell in a day and for how much (for the whole region); and TSM's own market value for your house, to hold ours against | the house every few hours, the region daily |

Blizzard gives its lists only to someone with an "API client" of their own, and a client may
not be handed on. So the lists are read in one place: a scheduled function in the cloud, part
of the Atlas database's own Firebase project (`functions/`). Once an hour, with nobody's
computer switched on, it asks Blizzard for every house whose list is newer than the one in the
database, boils it down (one line per item, not the auctions themselves) and writes it there.
Every copy of the map reads the prices from the database: nobody else needs a client or an
account. A copy fetches only the one house it is set to, and only while somebody is looking at
prices - or while the game runs with the box **Auctionator** ticked, where other addons are
answered with these prices.
TradeSkillMaster's files are different: each copy fetches them for itself, straight from
TradeSkillMaster, and nothing of them goes into the Atlas database.

**What an item gives.** This game keeps no stats on an item (the original game did). An item
only says what share of a budget each of its stats takes, and the budget comes from the item's
level, its quality and where it is worn. So an item's armor, a weapon's damage and every stat
are worked out the way the game works them out, from the tables of your own installed game
(`extractor/jobs/items.js` has the sums, and says where each comes from). The words for the
stats are the game's own, the ones only this game has among them ("Fire Damage", "Axes Skill",
"Attack Power Vs Undead"). Held against the forever-ref project's results, which were checked
against Wowhead's tooltips, for every item both know: the same armor for all 4,706, the same
damage range and speed for 1,785 of 1,786 weapons, and the same stats for 4,639 of 4,676 (their
copy of the game is three weeks older, and the game has changed some items since). Not shown yet: what an item does when used or
equipped (its spells), sets, and what a random ending ("of the Monkey") adds.

**Crafting.** Every recipe of every profession is in the game's files whether or not you know
it: 2,521 of them. Each is costed at your house's prices now: what its reagents cost, what the
thing it makes goes for, and the difference. A reagent costs the going price at the auction
house, or a vendor's price where a vendor sells it for no more (which reagents a vendor sells is
taken from QuestieDB: thread, vials, flux and the like). A recipe with a reagent that has no
price, because none is for sale and no vendor is known to sell it, is shown with the rest costed
and the gap said, and no difference is worked out. An item's page shows the recipe that makes
it, reagent by reagent, and the recipes it goes into. What the sums leave out: the auction
house's cut and deposit (how much this game takes is not in its files), what the recipe itself
costs to learn, and whether the thing sells at all, which is what the Sells column
(TradeSkillMaster's) is beside it for. A difference is between two prices asked, not a promise.
The skill at which a recipe turns yellow and grey is in the files; the skill at which a trainer
teaches it is the trainer's to say, and is not.

**Thirty days, and no longer.** Blizzard's terms for its API say that what is read from it may
be kept "for no longer than 30 days". So that is as far back as any chart reaches: on every
run, days older than that are deleted, on each computer and in the Atlas database. An hour in
which a house could not be read (Blizzard's API not answering, say) has no look, and a day
without any has no line.

**Which house is which.** Blizzard lists fifteen houses for a region (five each called
"Alliance", "Horde" and "Blackwater", the neutral one) and does not say which ruleset each
serves. `auctions/houses.js` says it, and how it was found: each house was held against
TradeSkillMaster's file for a ruleset and side, and one house fits each file far better than
any other (for PvP Alliance in the Americas: all 6,505 items with the same lowest price and
the same number of auctions as TSM's data of the same hour). Checked that way for the Americas
and Europe on 16 November 2026, and for two of Korea's houses; the rest of Korea and Taiwan
are taken to be numbered alike. The neutral houses have nothing to be held against: theirs is
taken from their place in the list, and the page says so. `houses --check` does it again.

**What is kept where.** In `<dataDir>/auctions`: each house as last listed, one line a day per
item (the lowest, highest and last going price of the day, the lowest anybody asked, the
pieces for sale), every look of the last 7 days, and TradeSkillMaster's files as last fetched.
Beside it, `items.json` and `recipes.json`: every item and every recipe, made from the game's
files when the map is built and again whenever the game has been sent new records.
In the Atlas database, under `/market`: each house as last listed, its days, and every single
look of today and yesterday (so a copy that is opened seldom still has the last two days look
by look, and one that is opened often gathers seven).

**In `config.json`:** `"auctions": { "house": "us-110" }` is the house this copy shows (the
page writes it); `"auctions": false` switches the whole thing off.

**By hand** (`node auctions/cli.js <command>`):

| Command | What it does |
| --- | --- |
| `status` | what this computer has of each house |
| `house us-110` | choose the house this copy shows (`houses` lists them) |
| `show linen cloth` | an item's price now, day by day, and what TradeSkillMaster says of it (a name, part of one, or the item's number) |
| `pull` | fetch this copy's house from the Atlas database |
| `tsm` | fetch TradeSkillMaster's files for this copy's house |
| `houses --check` | hold each house's prices in the Atlas database against TradeSkillMaster's file for it, to see that `houses.js` still says which house is which |
| `auto` | what the map does by itself, once |

**No copy of the map reads the auction houses.** A copy only fetches prices from the Atlas
database: it holds no API client, asks Blizzard nothing, and has no code to. The reading is in
one place, the function below, and belongs to whoever keeps the database.

**The function in the cloud** (for whoever keeps the Atlas database). `functions/` is all of
it: `index.js` runs at 20 and at 45 minutes past every hour (Blizzard's new list is out at about
18 past; the second run is for a list that came late); `blizzard.js` asks Blizzard, `summary.js`
boils a house's auctions down to a line per item, and `cloud.js` writes the database. It keeps
nothing of its own: what it must know from one hour to the next (when each house was last
listed, the day's line so far) it reads from the database it writes to, and it asks Blizzard
for a house only if its list is newer than the one there. It needs the database's Firebase
project to be on the pay-as-you-go plan (Firebase runs no functions without it) and a Blizzard
API client, made for free at https://develop.battle.net:

| Command | What it does |
| --- | --- |
| `node tools/cloud.mjs login` | sign in to Firebase, once |
| `node tools/cloud.mjs key --id-file=<file> --secret-file=<file>` | hand the client to the function: its two values, each from a file holding nothing else, go into the project's Secret Manager. Never into the repository or the database, and nothing of it is kept on the computer |
| `node tools/cloud.mjs deploy` | put the function in the cloud, and the one that takes in QuestieDB with it (and again whenever anything in `functions/`, or `houses.js`, `days.js` or `pack.js` in `auctions/`, has changed) |
| `node tools/cloud.mjs logs` | what the last runs said (`--only=auctions`: of this function alone) |
| `node tools/cloud.mjs rules` | publish `atlasdb/rules.json` as the database's rules (the same as pasting it into the console) |

Which regions it reads is `AUCTION_REGIONS` in `functions/.env` (`us`; `us,eu,kr,tw` for all
four). For the Americas it reads about 77 MB of lists an hour and writes under 2 MB; a run takes
about 20 seconds.

If the publishing is ever given up, `/market` should be deleted from the database with it:
nothing else takes away what is there, and it may not be kept past 30 days.

The addresses these lists are read from are not in Blizzard's documentation yet (November
2026): they were found by people trying them, and may change. A house that cannot be read is
said so in the function's log (`logs`), and the others go on; the page then shows the last
list it has, and when that was.

**Blizzard's and TradeSkillMaster's data, and you.** The auction lists are Blizzard
Entertainment's data, handed on here as its terms for developers allow: to the people using
this application, for their own use, for free, kept no longer than 30 days, and as they
are, with no promise from Blizzard or from this project that they are complete or right.
Azeroth Atlas is not affiliated with or endorsed by Blizzard Entertainment or by
TradeSkillMaster. Nothing about you is involved in any of it: the lists hold no seller's
name, and reading prices sends nothing but the request for a house.

The pieces. In a copy of the map: `auctions/share.js` (fetching a house from the database),
`store.js` (what a computer keeps), `days.js` (days, and the 30 of them), `pack.js` (how prices
are written in the database), `houses.js` (which house is which), `tsm.js` (TradeSkillMaster's
files), `craft.js` (what a recipe costs), `view.js` (the list, an item's history and the recipes
as the page takes them), `server/auctions.js` (the map fetching by itself),
`viewer/js/prices.js` (the page), `extractor/jobs/items.js` (every item's name, kind, armor,
damage and stats), `extractor/jobs/recipes.js` (every recipe) and `extractor/hotfix.js` (what
the game was sent after its files were made, laid over its tables: four items in ten are known
to it from there alone). In the cloud: `functions/` (the scheduled function; `prepare.mjs`
copies in the three files it shares with the map), put there with `tools/cloud.mjs`.

## What your other addons ask of QuestieDB, Questie and Auctionator

Plenty of addons lean on those three. A map addon asks Questie where the vendors and trainers
stand; a profession planner asks Auctionator what an herb costs; a guide pack will not load
without QuestieDB. The map has all of that itself: QuestieDB as published, the Atlas database
laid over it, and your auction house's prices hour by hour. So it can answer for each of the
three in the game, and whether it does is yours to say: the sidebar's **Other addons** section
has a box for each, and none is ticked until you tick it.

Nothing is put in the game for a box that is not ticked, and nothing is worked out from the
addons you happen to have. (A box's tooltip names the addons of yours that mention it in their
`.toc`. That is told, and decides nothing.)

A box acts as it is ticked or unticked, and says what was done in a line under the boxes.
**Check for updates** sees to the ticked ones again and says how each stands.

| Ticked | You have none | You have your own |
| --- | --- | --- |
| **QuestieDB** | Put in the folder `QuestieDB`, as its makers publish it: fetched from where they publish it, checked against the fingerprint they give, nothing in it changed. Kept current from then on | Left exactly as it is, whatever its version |
| **Questie** | A stand-in in the folder `Questie` answers what other addons ask of Questie, out of QuestieDB (which is seen to as if its own box were ticked) | Not touched. It reads QuestieDB, so the Atlas database laid over that is what reaches it |
| **Auctionator** | A stand-in in the folder `Auctionator` answers with the map's prices | Not touched. The map's price is given through Auctionator's own price questions, wherever Auctionator has none or an older one |

**An addon of yours is never written over, moved or changed.** The least that routes the map's
data into it turned out to be nothing of its own at all: QuestieDB has a way in for
corrections, and Auctionator's price questions can be answered through from outside. What does
the routing is in folders of the map's own beside yours (`AzerothAtlas_Facts`,
`AzerothAtlas_Prices`). So an addon manager updating your addon undoes nothing, and with those
two switched off your addon is as its makers published it.

**A stand-in is in the folder the addon itself would be in**, under its name, so that every
addon that names it finds it: one that will not load without Questie loads, and one that loads
after Auctionator where it is there does so. Its title in the game's list of addons says what
it is ("Azeroth Atlas stand-in").

**Unticked again**, the stand-in is taken out, and whatever was laid beside your own addon. A
QuestieDB the map put in is taken out too, unless a Questie of yours is there or an addon that
will not load without QuestieDB (its `.toc` says so): then it stays, and the line says for
whom.

What is the map's own is known by a mark: a stand-in's `.toc` says
`## X-AzerothAtlas-StandIn`, and a QuestieDB the map put in has a note beside it
(`AzerothAtlas-installed.json`) with the fingerprint of its data file. A folder without the
mark, or whose data file is another by now (an addon manager updated it), is yours and is
treated as yours. So is the addon itself unpacked over a stand-in (you installed the real one
later): what is left of the stand-in is cleared out of the folder, and the map's data is routed
into yours from then on. Which boxes are ticked is kept with what is yours
(`<dataDir>/user/standins.json`). A folder the game has open is not replaced or removed under
it: bringing QuestieDB up to date, or taking it out, waits until the game is closed, and the
line says so. A new folder goes in at any time, and the game finds it when it next starts.

**Switched off in the game.** The game keeps, for each character, which addons are switched
off, and goes on keeping it for an addon whose folder is gone: one you once switched off and
removed is still switched off the day a folder of its name is back - a stand-in's too, since it
has the addon's own name. A QuestieDB that is switched off answers nobody, and nothing that
needs it loads. So a line says which of your characters the addon is switched off for, with a
button, **Switch it on**, which changes that one line of each of those characters' lists
(`WTF/Account/.../AddOns.txt`) and nothing else, while the game is closed. It is asked and not
done by itself, because it is your setting.

### The Atlas database, laid over QuestieDB in the game

The 3D map is built from QuestieDB with the Atlas database laid over it ("The Atlas database"
says what is believed over what). Where the box **QuestieDB** or **Questie** is ticked, the
same is worked out for the QuestieDB that is in the game, yours or one the map put in: it is
read as the map reads it, the database is laid over it by the same code, and whatever reads
otherwise afterwards, in a field QuestieDB itself has, is a row for the game:

| | |
| --- | --- |
| A creature, object or quest QuestieDB does not have | its whole row (an object only if it stands somewhere or a quest has to do with it) |
| A field QuestieDB says nothing of: a level it has as 0, somebody it does not place, a quest with no giver | that field |
| A name the game's own server gives otherwise | that name, laid over only where the game is in English, so a translated name is never undone |
| Somebody the databases put in one place, whom players have only ever met elsewhere | where they were met, as on the map |

Against QuestieDB 1.1.4 and database 14 that is 1,115 creatures, 193 objects and 203 quests,
65 names, 6 people moved to where they were met, and the 126 mailboxes named for whoever asks
where they are. Heights, health and what a vendor sells have no field in QuestieDB, and stay
the map's.

QuestieDB has a way in for exactly this: an addon registers a "correction", rows of
`{ [id] = { field = value } }`, under its own name, and QuestieDB lays them over what it reads.
The rows are written as a small addon of the map's own, `AzerothAtlas_Facts`, which hands them
to QuestieDB under the name `AzerothAtlas`. **QuestieDB's own files are not touched**: with
that addon switched off, QuestieDB is as its makers published it. QuestieDB's own layer is
under ours, and Questie's (which it adds when it starts, from what your character is and has
done) is over it. The rows hold for the one QuestieDB they were worked out against, so the file
names it, and nothing is laid over another one until the map has run and written them anew.
`/dump AzerothAtlasFactsState` in the game says what was laid over, or why nothing was. With
both boxes unticked, `AzerothAtlas_Facts` is taken out of the game again.

### The stand-in for Questie

It hands QuestieDB on under the names addons ask Questie by. It is not Questie: it draws no
icons, tracks nothing and has no settings, and none of Questie's code is in it.

| Asked for | Answered |
| --- | --- |
| `QuestieLoader:ImportModule(name)` | a module by name; one nobody has made is an empty one, as with Questie |
| `"QuestieDB"` | `QueryNPCSingle`, `QueryQuestSingle`, `QueryObjectSingle`, `QueryItemSingle` and the same for whole rows; `NPCPointers`, `QuestPointers`, `ObjectPointers`, `ItemPointers`; `npcFlags`, `classKeys`, `factionIDs`, `factionTemplate`; `GetQuest`, `GetNPC`, `GetObject`, `GetItem`, `IsDoable` |
| `"ZoneDB"` | which area is which map and back, an area by its name, the dungeons and where their doors are |
| `"Townsfolk"` | the mailboxes, and whose side each is for |

**It is in the folder `Questie`, and that has a price.** There is no `Questie` in the game
with it (no global of that name, no frame of Questie's), so an addon that looks for those to
leave something to Questie goes on doing its own work: RestedXP goes on telling your party what
you have done. But an addon that asks the game whether an addon *named* Questie is loaded is
told yes, and may leave its work to a Questie that does none: OneForAll switches its own quest
icons and the quest lines in its tooltips off. Where you want those, leave the box unticked.

`IsDoable` goes by what QuestieDB says of the quest and the game says of your character: not
done yet, old enough, of a race and class it is for, the quests before it done, none taken that
rules it out. Standing with a faction, a profession's skill and what is on at the moment are
not looked at.

### Auctionator: the stand-in, and the map's prices through your own

The prices are the ones the map keeps for the auction house you chose under **Auction
prices**, so nobody has to scan the auction house for other addons to have prices. One file
(`addon/standins/Auctionator.lua`) hands them on in both cases, and finds out which it is by
whether an Auctionator is there when it runs. None of Auctionator's code is in it: both ways
go by the names other addons call.

**The stand-in** (you have no Auctionator) has no auction window of its own, sells nothing and
scans nothing. It answers by the names the installed addons were seen to ask under:

| Asked for | Answered |
| --- | --- |
| `GetAuctionPriceByItemID`, `GetAuctionPriceByItemLink` | the lowest anybody asked for one piece when the list was read (what Auctionator's own would be straight after a scan), or nothing for an item nobody was selling |
| `GetAuctionAgeByItemID`, `GetAuctionAgeByItemLink` | days since the list was read |
| `RegisterForDBUpdate` | taken; called only for whoever asked before the game knew your character's side |
| `ConvertToSearchString`, `CreateShoppingList` | the list is kept while the game runs and said in the chat, with what each thing costs and what the lot comes to: there is no shopping window to put it in |
| `Auctionator.SavedState.TimeOfLastBrowseScan` | when the prices were read, so an addon that says "last scan: 40 min ago" says what is so |

**Through your own Auctionator**, the four price questions above
(`GetAuctionPriceByItemID`, `...ByItemLink`, `GetAuctionAgeByItemID`, `...ByItemLink`) are
answered through, and nothing else is touched. The map's price is told where Auctionator has
none, or where the map's list was read no longer ago than Auctionator last saw the item (in
days, as Auctionator counts); otherwise Auctionator's own is. The age told is that of the price
told. A complaint Auctionator makes about a question is handed on as it is. Its window, its
scans, its shopping lists and who it tells of new prices are its own as before, and so are the
prices in its own tooltips and its own selling window: only what other addons ask of it goes
through. `/dump AzerothAtlasPricesState()` in the game says which of the two ways is at work.

An auction house belongs to one side of one kind of realm. The map's prices are told to a
character of that side on that kind of realm; a character of another is told nothing by the
stand-in, and Auctionator's own prices alone through yours.

The game can be handed nothing while it runs but what it loads itself. So the prices are
written as a file the game loads - `prices.lua` in the stand-in's folder, or in
`AzerothAtlas_Prices` beside your own Auctionator - and are as fresh as the last time the game
loaded its addons: when it started, or `/reload`. With the box ticked the map fetches them
once as it starts and every hour while the game runs, not only while the Prices page is open.
A list older than thirty days is not handed on, and one that was is taken out of the game's
folder again (see "Thirty days, and no longer").

The pieces: `server/standins.js` (the boxes, what is put in and taken out),
`server/facts.js` and `facts-worker.js` (the rows for QuestieDB), `server/prices.js` (the
prices for the game), `addon/standins/Questie.lua`, `Auctionator.lua` and `Layer.lua` (what
runs in the game).

## Credits

The map is built from your own installed game. What else it draws on, and where each comes from:

| What | From | How it gets here |
| --- | --- | --- |
| Creatures, NPCs, quests, where they stand | **QuestieDB** by the Questie team and its contributors (github.com/Questie/QuestieDB; GPL-3.0) | Each release is fetched by a scheduled function of the database's own and kept in the database as published, with its licence; every copy fetches it from there when the map is built (or reads the addon in your game's folder, where that is the newer). Where you tick the box for it and have none in the game, the whole addon is fetched from where it is published and put in the game's AddOns folder as it is. Not in the download |
| NPC heights, what quests ask for, drop rates, creature health and respawn times | **cmangos classic-db** | Downloaded when the map is built, kept in the map data. Not included |
| The layout of the game's data tables | **WoWDBDefs** (wowdev) | Each definition is fetched the first time it is needed, kept in `extractor/dbd/`. Not included |
| The doorways between maps (`extractor/doorways.json`) | **ShortestPathForever** by cjber, `Data/Portals.lua` (GPL-3.0-or-later) | Included; the addon's own, newer list is read instead where it is installed |
| The timetables of boats, zeppelins and the tram (`viewer/transit.json`, `addon/AzerothAtlas/TransitData.lua`) | **DockWatch** by Wyveryx (MIT), recorded in the game; **NauticusClassicResurrected** (MIT) by way of **ForeverTransport** by Stilo | Included |
| Guides in the game | **Guidelime** and **RestedXP**, whichever you run, with the guides you have for them | Followed as they run in your game. Not included. One line of each is changed in your own copy, unless you switch that off (see "Guides in the game") |
| How an item's stats, armor and damage are worked out, and where the game keeps its recipes | **forever-ref** by alcaras (github.com/alcaras/forever-ref), which found that this game uses the formulas TrinityCore worked out for the client, and checked its results against Wowhead | The method only. The code is this project's own; its results were held against forever-ref's |
| Auction prices | **Blizzard Entertainment**'s game data (its API for developers) | Read hourly by a scheduled function of the database's own; in the database for 30 days, not in the download. Handed on to the game where the box Auctionator is ticked |
| How often and how fast an item sells; a second opinion on its price | **TradeSkillMaster**'s public price files (tradeskillmaster.com) | Fetched by each copy for itself. Not included |
| Facts in the Atlas database marked `w`: what a creature or quest is, and where QuestieDB is silent | **Wowhead** (wowhead.com/forever) | Read by the database's maintainer; in the database, not in the download |

## Reporting a problem

When something does not work as it should, **Report a problem** (bottom left of the map, under
"Check for updates"; also on the page that says the map has stopped) opens a window to say what
went wrong in. Your words go into **one zip file**, together with everything that may help
whoever looks into it, and you are asked where to save it. **Nothing is sent anywhere**: the
file is yours to pass on. Making it takes a few seconds; it is a few hundred kilobytes.

**Is it about the game?** Type `/reload` in the game before you save the report. The addon
keeps notes of what it did, and the game writes what an addon has saved to the disk only on a
/reload or when you log out. The window says how long ago that last was.

What goes in (`report.txt`, the first file in the zip, lists every file and whatever was left
out, and why):

| In the zip | What it is |
| --- | --- |
| `report.txt` | what you wrote, and a summary of all the rest |
| `timeline.txt` | every note below as one list, in the order things happened: the server's, the page's and the addon's own, side by side |
| `computer/` | the version of Windows, processor, memory, graphics card and its driver, drives and how full they are, the antivirus program, and the names of the programs running (an overlay or a capture program can be in the strip's way) |
| `atlas/` | this copy of Azeroth Atlas: its version, a digest of each of its own files (a file gone wrong in an update shows), `config.json`, what the server knew at that moment (the game, the addon, your character as the game reported it, your quest log), its notes, what the page was showing (where you were, each route and how it was taken to go, what the game had been handed) with a picture of the map, the route mailboxes as they stood, and - where you were looked for on the game's minimap inside a dungeon - `atlas/minimap/`: the last small square of the game's picture that was looked at (`last.png`), where the minimap was taken to be in it (by its rim, and by the addon's word), the figures of the last look, and how it has agreed with the combat log (`state.json`), and what each of the last 1,500 pictures gave (`trail.json`: five minutes of them, a line of figures apiece - when, whether a place was found and how, where, how well it fitted, how far you had gone - and nothing of the pictures themselves); and what following you has taught the map of the dungeons (`atlas/data/dungeon-doors.json`, `dungeon-ways.json`, `dungeon-checks.json`: places and counts) |
| `game/` | the game's build and its settings, the addons installed and which are switched on, what the Azeroth Atlas addon has saved (its own notes among it), what the addons it works with have saved (Questie, Guidelime and guide packs, TomTom, ShortestPathForever, DockWatch and the like), the game's own logs about itself and its addons, the beginning of its last three crash reports, and its cache of what the server told it about creatures, objects and quests |

**What never goes in:** account names (an account's folder is called `account-1` in the zip,
and the name is struck from every text), passwords and anything like one, e-mail addresses, your
Windows user name and the computer's name (struck from paths and texts: a path begins at
`%USERPROFILE%`), the game's chat and combat logs and its logs about your account, your
macros, crash dumps, anything of the game itself. Character and realm names do go in: the game
keeps what addons save under them. What every *other* addon has saved goes in only if you tick
it (it may hold whatever those addons keep, chat included), and so does the game's cache of
hotfixes (several megabytes).

**Where it is saved.** In the application, its own "Save as" window; in a browser, the
browser's (or, where it has none, your downloads). With the map's server not up at all, the
application's starting page offers the same report once it has waited a while, made by the
application itself; and from a terminal it is `npm run report` (`node server/report.js
--out=report.zip --text="what went wrong"`).

### The notes it keeps

So that there is something to go by when a thing went wrong and nobody was looking, each part
notes what it does - a line for every *change*, not for every yard walked:

- **the server** (`events.log`): the game found or lost and how its strip is read, where the
  game says you are (twice a minute) and what you are heading for, your quest log and the quest
  you track as they change, how you can travel (your hearthstone as the game names it, your
  flight points), each route the page hands over and each delivery put in the mailboxes, what
  the game says of its mailboxes (which it opened, which delivery it read), updates, map
  builds, errors. The application adds what only it knows: a page or a helper of its own that
  crashed, and (`app.json`) the graphics card and the screens;
- **the page** (`page.log`, sent on to the server as it goes, so that it outlasts the page
  loading itself again; a batch at a time of a size any browser sends - one batch of four
  hundred lines once came to more than the 64 KB a browser allows a request that is to outlive
  its page, and nothing more of the page's was written down until it loaded again, two hours
  later): where each route is heading and which way it is taken to go ("lead:
  hearth, then walk"), with what was looked for and how long it took; what the game is handed;
  what the height tracker decided (lines beginning "height": see "How your height is known");
  the graphics card; every warning and error;
- **the addon** (with what it saves for the character; `/atlas log` shows the last of it):
  each mailbox opened, which delivery was in it and what was made of it, the waypoint and what
  else you could head for as they change, the quest you track moving on - and every mistake
  caught in its own code. The addon does much of what it does so that a mistake cannot stop
  the rest; such a mistake used to be seen by nobody, the route simply staying as it was. Of
  the boats (lines beginning "boats:"): what each line goes by when you log in (the server's
  clock alone, the clock borne out by sightings, or not as the clock has it), each ride of
  yours and how far it was off what was known, a line that stops running by the clock or runs
  by it again, whether DockWatch's channel could be joined, what other players passed on in
  every ten minutes in which there was any (by which way it came, and whether it was taken,
  known already, or from before the server's count started again), and the count starting
  again. (A report
  reads these notes out of what the game saved; up to version 0.3.7 it looked for them written
  one way only, and this game writes them another: a report had none of them.)

They are kept beside `config.json`, in `logs` (the installed application's:
`%LOCALAPPDATA%\Azeroth Atlas\logs`; run from the source, `server/.build/logs`), each file
to two megabytes with the one before it kept beside it - some days of playing. Nothing in them
leaves the computer unless you make a report and pass it on.

## If the map does not come up

**"The graphics card would not start"** (or, in older versions, "WebGPU is required ... D3D12
create command queue failed with E_OUTOFMEMORY"). The map draws with the graphics card, and
Windows can refuse it one for a moment: just after the map has been built (the page that was
there is still letting go of the card), or while the game has the card busy. The map asks
again several times over about ten seconds, and of the other card too on a computer with two (a
laptop's own, when the one the game runs on will not). If it is still refused it says so, with a
**Try again** button, and tries again by itself after 15, 30 and 60 seconds. If it keeps
happening: close what else is using the card, lower the game's graphics settings a notch, or
update the graphics driver.

## If the routes do not show in the game

The 3D map shows them, the game does not. In the order worth looking:

1. **Is the addon the current one?** Press **Check for updates** (bottom left of the map), then
   type `/reload` in the game. (Version 15 and later lists the routes under "Routes".)
2. **Does the map show where you are?** Top of its sidebar: "You: Elwynn Forest 42.1, 65.3"
   and a green dot. If it says the strip cannot be read, something is drawn over the strip in
   the game - an overlay of another program, most often in the top-left corner. Move the strip
   to a free corner: **Esc > Options > AddOns > Azeroth Atlas** in the game.
3. **Type `/atlas status`** in the game. It says how many deliveries are left (when they are
   used up: `/reload`), whether a route is showing, and whether Azeroth Atlas is answering at
   all. The list of routes says the same in a line where a waypoint has no route.
4. **Azeroth Atlas has to be running**, but its window need not be in view: behind the game or
   minimized is fine (before version 0.3.0 it was not: with one screen, routes then reached the
   game only now and then).
5. `/atlas route` asks the map for its routes there and then.

## Known limits

- Ground texture is the game's baked per-tile colour map (≈1 texel per yard), so it is softer
  than in game when the camera is right at ground level.
- Objects are drawn in their rest pose (no animation, particles or lights); skin-swapped
  textures on a few props fall back to a neutral colour.
- Content the game ships encrypted (unreleased areas) is skipped automatically.
- With the continents and Zephras Isle on one picture, NPC markers are those of the map in
  hand; each of the others shows them once it is taken in hand (look at it closely, or choose
  it from the list). The route is drawn on all of them.
- The stand-ins for Questie and Auctionator answer what the addons installed here were seen to
  ask (OpenMap, RestedXP, WhatsItFor, OneForAll, TradeSkillMaster, EllesmereUI, Forever Leveling
  Guide). An addon that asks them something else gets no answer. They, the Atlas layer over
  QuestieDB and the map's prices through a real Auctionator were run in a made-up game - the
  first two against the real QuestieDB addon, the last against an Auctionator made up from the
  names other addons call it by - and not in the game itself.
