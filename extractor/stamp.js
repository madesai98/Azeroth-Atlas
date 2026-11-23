// Which build of the map data this map tool makes: the version of every part of it, as one stamp.
// It is written into the map data (manifest.json: "tool"). When the map tool has been updated and
// builds some part differently, the stamps differ, and the page offers "Update map". (The page
// goes on working with data from before: every such change is one it can do without.)
import { TILE_VERSION } from './jobs/tile.js';
import { PAGE_VERSION } from './jobs/page.js';
import { AREAS_VERSION } from './jobs/areas.js';
import { PLACEMENTS_VERSION } from './jobs/placements.js';
import { MODEL_VERSION } from './jobs/model.js';
import { NAV_VERSION, BUILDING_NAV_VERSION } from './jobs/nav.js';
import { NAVCOARSE_VERSION } from './jobs/navcoarse.js';
import { CREATURES_VERSION, PLACES_VERSION } from './jobs/creatures.js';
import { NPCS_VERSION, QUESTS_VERSION } from './jobs/npcs.js';
import { TREES_VERSION } from './trees.js';
import { WORLD_VERSION } from './world.js';
import { MINIMAP_VERSION } from './jobs/minimap.js';

export const DATA_STAMP = [TILE_VERSION, PAGE_VERSION, AREAS_VERSION, PLACEMENTS_VERSION, MODEL_VERSION, NAV_VERSION, CREATURES_VERSION, NPCS_VERSION, TREES_VERSION, WORLD_VERSION, PLACES_VERSION, BUILDING_NAV_VERSION, MINIMAP_VERSION, QUESTS_VERSION, NAVCOARSE_VERSION].join('.');
