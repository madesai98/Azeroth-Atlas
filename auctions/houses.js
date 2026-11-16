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

/** 'us-110' → { region, id, ruleset, side } or null when there is no such house. */
export function parseHouse(key) {
  const m = /^(us|eu|kr|tw)-(\d{1,4})$/.exec(String(key ?? ''));
  if (!m) return null;
  const h = HOUSES[m[2]];
  if (!h || !REGION_RULESETS[m[1]].includes(h.ruleset)) return null;
  return { key: `${m[1]}-${m[2]}`, region: m[1], id: Number(m[2]), ...h };
}

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
