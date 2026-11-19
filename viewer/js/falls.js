// Falls on a route. The route search (navworker.js) lets a way go where you cannot walk back:
// off a ledge, down ground too steep to stand on. The points you come to like that are marked
// (FELL), and this says of a line of such points how far you fall and what the game takes for it.

export const FELL = 2;        // kind bit of a route's point: you come to it by a fall, not by a step
export const FALL_SPEED = 20; // yards a second, coming down (taken as steady: near enough for a route's time)
export const LIFTED = 64;     // kind bit of a route's point: you come to it standing on a lift (from the point before it, straight under or over)
const BREAK = 8;              // (route.js) kind bit: this point starts a new stretch

/**
 * The falls along a route, or along the part of it from one point to another: how far each is,
 * in yards, from where your feet leave the ground to where they are on it again (a slide down
 * steep ground and the drop at its end are one fall). One that ends in water is not counted:
 * it costs nothing.
 */
export function fallsOf(points, kinds, from = 0, to = kinds.length - 1) {
  const out = [];
  let top = null;
  for (let i = Math.max(1, from + 1); i <= to; i++) {
    if (kinds[i] & BREAK || !(kinds[i] & FELL)) { top = null; continue; }
    if (top === null) top = points[i * 3 - 1];
    const landed = i === to || !(kinds[i + 1] & FELL) || kinds[i + 1] & BREAK;
    if (!landed) continue;
    if (!(kinds[i] & 1)) out.push(top - points[i * 3 + 2]);
    top = null;
  }
  return out;
}

/** The furthest of them, in yards: 0 if there is none. */
export const furthestFall = (points, kinds, from, to) => Math.max(0, ...fallsOf(points, kinds, from, to));

/**
 * The part of your full health a fall of so many yards costs, by the game's own sum: 1.8% a
 * yard, less 24.26% - all of it at 69 yards. (The game charges nothing at all for a fall of
 * under 14.57 yards, where this comes to 2%. Here the sum is used from where it crosses
 * nought, a yard sooner: the heights these falls are measured from are good to about a yard.)
 */
export const fallCost = (yards) => Math.min(1, Math.max(0, 0.018 * yards - 0.2426));
const WORTH_SAYING = 0.02; // the least a fall costs for it to be spoken of: what the game's own least fall costs

/**
 * What to say of the lifts on a way - 'the lift down', 'the lift up', '2 lifts' - or null where
 * it takes none.
 * @param rides  [{ from, to }]: the heights each takes you from and to (navworker.js: rides)
 */
export function liftsSaid(rides) {
  if (!rides?.length) return null;
  return rides.length === 1 ? `the lift ${rides[0].to > rides[0].from ? 'up' : 'down'}` : `${rides.length} lifts`;
}

/**
 * What to say of the falls on a way that cost health - ['a fall of 31 yd', 0.32] (how to name
 * them, and the part of your full health they cost between them) - or null if none does.
 */
export function fallsSaid(falls) {
  const hurting = falls.filter((yards) => fallCost(yards) >= WORTH_SAYING);
  if (!hurting.length) return null;
  const furthest = Math.round(Math.max(...hurting)), cost = Math.min(1, hurting.reduce((sum, yards) => sum + fallCost(yards), 0));
  return [hurting.length === 1 ? `a fall of ${furthest} yd` : `${hurting.length} falls that cost health, the furthest ${furthest} yd`, cost];
}
