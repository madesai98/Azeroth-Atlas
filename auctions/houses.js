// Which of Blizzard's auction houses is which.
//
// Blizzard's API lists fifteen houses for every region and gives each a number and one of three
// names ("Alliance Auction House", "Horde Auction House", "Blackwater Auction House": Blackwater
// is the neutral one, in the goblin towns). It lists the same fifteen under every ruleset, and
// does not say which ruleset a house serves. This table says it.
//
// How it was found (16 November 2026, and `node auctions/cli.js houses --check` does it again):
// TradeSkillMaster publishes, for each ruleset and side, the lowest price of every item; each of
// those files was held against every house's list from Blizzard. One house fits each file far
// better than any other (for PvP Alliance against house 110: all 6,505 items, the same lowest
// price and the same number of auctions for every one of them, against the TSM desktop app's data
// of the same hour). The neutral houses have no file to be held against: theirs is taken from
// their place in the list (the houses come in threes: Alliance, Horde, Blackwater), and is marked.
// Houses 112, 115 and 118 are listed and empty.
//
// Checked that day: the Americas and Europe (all eight houses of the two sides, each), and Korea's
// two Alliance houses. Korea's Horde houses and Taiwan's were not (TradeSkillMaster stops handing
// out files to whoever asks for many in a row, and had by then): they are taken to be numbered
// like the rest.

export const RULESETS = {
  pvp: { id: 1, name: 'PvP', tsm: 'pvp' },
  normal: { id: 2, name: 'Normal', tsm: 'normal' },
  rp: { id: 3, name: 'Roleplay', tsm: 'roleplay' },
  rppvp: { id: 15, name: 'Roleplay PvP', tsm: 'roleplay-pvp' },
};
export const SIDES = { alliance: 'Alliance', horde: 'Horde', neutral: 'Blackwater (neutral)' };

/** house number → which ruleset and side it serves (`taken`: by its place in the list, not by its prices) */
export const HOUSES = {
  110: { ruleset: 'pvp', side: 'alliance' }, 113: { ruleset: 'pvp', side: 'horde' }, 116: { ruleset: 'pvp', side: 'neutral', taken: true },
  111: { ruleset: 'normal', side: 'alliance' }, 114: { ruleset: 'normal', side: 'horde' }, 117: { ruleset: 'normal', side: 'neutral', taken: true },
  119: { ruleset: 'rp', side: 'alliance' }, 120: { ruleset: 'rp', side: 'horde' }, 121: { ruleset: 'rp', side: 'neutral', taken: true },
  123: { ruleset: 'rppvp', side: 'alliance' }, 124: { ruleset: 'rppvp', side: 'horde' }, 125: { ruleset: 'rppvp', side: 'neutral', taken: true },
};
/** Which rulesets a region has (Korea and Taiwan have two). */
export const REGION_RULESETS = { us: ['pvp', 'normal', 'rp', 'rppvp'], eu: ['pvp', 'normal', 'rp', 'rppvp'], kr: ['pvp', 'normal'], tw: ['pvp', 'normal'] };
export const REGION_NAMES = { us: 'Americas', eu: 'Europe', kr: 'Korea', tw: 'Taiwan' };

/**
 * Which ruleset a realm is of, by the game's own number for the realm - the folder its
 * characters' settings are kept under (WTF/Account/<account>/<realm>). Only the realms this
 * is known of: the game's files do not say, and Blizzard's lists name no realms. (91, the
 * Americas: the realm of the copy whose house, 110, was held against TradeSkillMaster's PvP
 * Alliance file.) A realm not listed here is one the map asks about, on its Prices page.
 */
export const REALM_RULESETS = { us: { 91: 'pvp' } };

/** The house of a side on a realm ('us', 91, 'alliance' → 'us-110') - or null where the realm's ruleset is not known, or there is no such side. */
export function houseOf(region, realm, side) {
  const ruleset = REALM_RULESETS[region]?.[realm];
  if (!ruleset || !REGION_RULESETS[region]?.includes(ruleset) || (side !== 'alliance' && side !== 'horde')) return null;
  const id = Object.keys(HOUSES).find((n) => HOUSES[n].ruleset === ruleset && HOUSES[n].side === side);
  return id ? `${region}-${id}` : null;
}

/** 'us-110' → { region, id, ruleset, side } or null when there is no such house. */
export function parseHouse(key) {
  const m = /^(us|eu|kr|tw)-(\d{1,4})$/.exec(String(key ?? ''));
  if (!m) return null;
  const h = HOUSES[m[2]];
  if (!h || !REGION_RULESETS[m[1]].includes(h.ruleset)) return null;
  return { key: `${m[1]}-${m[2]}`, region: m[1], id: Number(m[2]), ...h };
}

/** The neutral house that goes with a house: the same region and ruleset ('us-110' → 'us-116'); a neutral house's is itself. Null: no such house. */
export function neutralOf(key) {
  const h = parseHouse(key);
  if (!h) return null;
  const id = Object.keys(HOUSES).find((n) => HOUSES[n].ruleset === h.ruleset && HOUSES[n].side === 'neutral');
  return id ? `${h.region}-${id}` : null;
}

/**
 * What an auction costs its seller, by the kind of house.
 *   cut      per cent of the price the house keeps when the auction sells
 *   deposit  per cent of what a vendor pays for the thing, paid when it is put up for 2, 8 or 24
 *            hours - never less than one copper. Handed back when it sells; kept by the house
 *            when it does not (its time runs out, or it is taken down).
 * The faction houses' are as published for this game (Wowhead, November 2026: 5%, 20%, 60%)
 * and as the game's own table of auction houses has them (AuctionHouse: a deposit rate of 5 for
 * two hours, a cut of 5). The neutral houses' are that table's alone - a deposit rate of 25, a
 * cut of 15 - reckoned the same way: nobody of ours has put a thing up there and looked.
 */
export const HOUSE_COSTS = {
  faction: { cut: 5, deposit: { 2: 5, 8: 20, 24: 60 } },
  neutral: { cut: 15, deposit: { 2: 25, 8: 100, 24: 300 } },
};
/** What an auction costs at this house: { cut, deposit: { 2, 8, 24 } } - or null: no such house. */
export const costsOf = (key) => { const h = parseHouse(key); return h ? HOUSE_COSTS[h.side === 'neutral' ? 'neutral' : 'faction'] : null; };

/** Every house of a region, as keys ('us-110', …). */
export function housesOf(region) {
  return Object.entries(HOUSES).filter(([, h]) => (REGION_RULESETS[region] ?? []).includes(h.ruleset)).map(([id]) => `${region}-${id}`);
}

/** "PvP · Alliance (Americas)" */
export function houseName(key) {
  const h = parseHouse(key);
  return h ? `${RULESETS[h.ruleset].name} · ${SIDES[h.side]} (${REGION_NAMES[h.region]})` : String(key);
}

/** The name TradeSkillMaster files a house under ('pvp-alliance'), or null (it has none for the neutral houses). */
export function tsmSlug(key) {
  const h = parseHouse(key);
  return h && h.side !== 'neutral' ? `${RULESETS[h.ruleset].tsm}-${h.side}` : null;
}
