// How long a fight takes: the figures the quest explorer (quests.js) reckons a kill by.
//
// There are two kinds. A round figure for someone of a level - what the reckoning began with,
// and what it falls back on. And your own: what the fights you have fought alone really came to,
// as the game's combat log has them (server/fights.js keeps the last sixty of each character of
// yours, and hands them over at /api/fights). Asked for on 21 November 2026: "each user can keep
// track of their own rolling average DPS and use that in the estimate for time to kill instead
// of some kind of idealized simulation".
//
// Why not the round figure alone. Held against 32 hours of one player's combat log (459 fights
// fought alone) it was wrong both ways: a level 37 character dealt 111 a second to a creature of
// its own level where the round figure says 74, and a level 14 one about 15 where it says 26.
// Class, gear and how one plays move it by a half either way, and no one curve has that in it.
//
// What is measured is not kept as "damage a second" but as how many times the round figure you
// deal (`times`): a fight with a creature three levels under you goes quicker than one with a
// creature at your level, and by about what `edge` allows for (measured: x1.25 at three under,
// x1.16 at two, x1.02 at one - the rule says 1.24, 1.16, 1.08). So each fight is held against
// what the round figure would have dealt to that creature at your level then, and the ratio
// carries to creatures of other levels and to the levels you have yet to reach.
//
// The same fights say how long you are from one kill to the next - looting, getting your breath,
// walking to the next one - which the reckoning had as a third of the fight and twelve seconds.

/** What someone of a level deals in a second, questing alone: the round figure. */
export const roundDps = (level) => 2 + 1.55 * level + 0.011 * level * level;

/** How much quicker a creature below you goes down, and how much slower one above (level: yours; lv: its). */
export const edge = (level, lv) => Math.max(0.5, Math.min(2.5, 1 + 0.08 * (level - lv)));

/**
 * How many times the original game's health this game gives a creature of a level. Measured, in
 * the combat logs: every creature fought whose level is one level in both has exactly 1.00 at
 * level 1, 1.05 at 10, 1.08 at 11, and 1.30 at every level from 20 to 42 (a few 1.6: creatures
 * this game has changed by hand). Between 11 and 20 none of one level has been fought: taken as
 * the straight line the three low figures lie on, which meets 1.30 at 20.
 */
export const healthHere = (lv) => Math.max(1, Math.min(1.3, 1 + 0.025 * (lv - 8)));

export const ENOUGH = 8;       // fights of your own before they are believed over the round figure
const LEAST = 0.2, MOST = 6;   // times the round figure: outside these something else was measured than a fight

/**
 * Your own pace, from the fights the server has kept.
 * @param samples  [{ at, s (seconds it lasted), d (what you dealt in it), n (creatures killed in it),
 *                   lv (their level), my (your level then), g (seconds since the fight before; null: a walk, a break) }]
 * @returns null (too few to go by), or { times (the round figure, this many times), dps (what you
 *          dealt in a second, as it was), between (seconds from a kill to your first blow at the next,
 *          a kill; null: too few of those), fights, kills, level (yours, in the last of them), at }
 */
export function paceOf(samples) {
  const ok = (Array.isArray(samples) ? samples : []).filter((f) => f && f.s > 0 && f.d > 0 && f.n >= 1 && f.my >= 1 && f.lv >= 1);
  if (ok.length < ENOUGH) return null;
  let dealt = 0, seconds = 0, round = 0, kills = 0, gaps = 0, gapKills = 0, gapFights = 0;
  for (const f of ok) {
    dealt += f.d; seconds += f.s; kills += f.n;
    round += roundDps(f.my) * edge(f.my, f.lv) * f.s;
    if (typeof f.g === 'number' && f.g >= 0) { gaps += f.g; gapKills += f.n; gapFights++; }
  }
  const last = ok.reduce((a, b) => (b.at > a.at ? b : a));
  return {
    times: Math.max(LEAST, Math.min(MOST, dealt / round)),
    dps: dealt / seconds,
    between: gapFights >= ENOUGH ? gaps / gapKills : null,
    fights: ok.length, kills, level: last.my, at: last.at,
  };
}
