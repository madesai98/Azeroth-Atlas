// The server's clock, and where a boat, zeppelin or tram line stands on it.
//
// The game's server counts real time in milliseconds in a number of 32 bits, which is full
// after 49.7 days and starts again from nought. Where a craft is on its loop is that count,
// divided by how long its loop takes, and what is left over: so every craft runs to the clock
// alone, whatever the server does in between (restarts and patches do not move it), and all of
// them jump at the moment the counter starts again. (Found by the Azeroth Tripview addon; checked
// against 205 sightings of our own, 14 to 17 November 2026: tools/clock-transit.mjs.)
//
// transit.json gives each line the two figures that takes: `period` (its loop, to a
// ten-thousandth of a second) and `left` (a moment at which a craft was measured to leave the
// line's first stop; the tram: the car on its first track), with how unsure each is. From those
// a line has a timetable from the moment the map opens, with nothing seen at all. What is seen
// (the addon: your rides, other players' sightings) makes it more exact, and takes its place
// where it plainly differs.
//
// Plain arithmetic, shared by the map, the tools and the function in the cloud.

/** Seconds from one start of the server's counter to the next: 2^32 milliseconds. */
export const WRAP = 4294967.296;
const LAG = 1; // seconds after the counter starts again from which a moment is counted to the new count

/** The moment (server time, seconds) the server's counter last started from nought before `t`. */
export const wrapBefore = (t) => Math.floor((t - LAG) / WRAP) * WRAP;

/** dep[s], arr[s]: how far into its round (seconds after leaving stop 0) a craft of the line leaves stop s, and gets there. */
export function stopTimes(d) {
  const count = d.stops.length, dep = [0], arr = new Array(count);
  let at = 0;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    at += d.legs[i].trip;
    arr[next] = at;
    if (next !== 0) { at += d.stops[next].wait; dep[next] = at; }
  }
  return { dep, arr };
}

/**
 * What the clock alone says of a line at server time `t`: { leaves (a moment a craft leaves its
 * first stop, in the count `t` is in), unsure (seconds, at that moment), perLoop (seconds more
 * with every loop away from it) } - or null for a line without the figures.
 *
 * In the count the line was measured in, that is the measured moment itself. In another (the
 * counter has started again since) the craft leaves as long after the start as it did then: as
 * unsure as the loops between the start and the measured moment make it, each by what the
 * period may be off.
 */
export function clockOf(line, t) {
  if (!(line.left > 0) || !(line.period > 0)) return null;
  const perLoop = line.periodUnsure ?? 0.4, unsure = line.leftUnsure ?? 2;
  const W0 = wrapBefore(line.left), W = wrapBefore(t);
  if (W === W0) return { leaves: line.left, unsure, perLoop };
  const into = line.left - W0, loops = Math.floor(into / line.period);
  return { leaves: W + into - loops * line.period, unsure: Math.hypot(unsure, loops * perLoop), perLoop };
}
