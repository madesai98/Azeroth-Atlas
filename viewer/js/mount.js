// What carries you along a flight path, as a shape: a gryphon for the Alliance, a wind rider
// (wyvern) for the Horde, wings beating, with your figure on its back. figure.js draws it in
// place of the figure standing on the ground while the game says you are on a flight path.
//
// The shapes are made here, not taken from the game: its creature models stand in one stiff
// pose without their animations, and the map draws nothing that moves by a skeleton. So these
// are simple shapes in the manner of the figure itself - a body, a head, a tail, legs tucked up,
// and two wings that are laid out again every frame as they beat.
//
// Mount space: +X is forward, +Y is left, +Z is up, in yards; the origin is under the belly,
// where the game has you (it puts you where the creature is, and sits you on its back).

const STRIDE = 7;            // floats per vertex: position, normal, part (which of the figure's colours)
export const SPAN = 9.4;     // yards from wing tip to wing tip
export const SEAT = 1.2;     // yards up: where you sit
const BEAT = 1.25;           // wing beats a second
const STATIONS = 10;         // pieces a wing is laid out in, from the shoulder to the tip
const ROOT = [0.3, 0.38, 1.12]; // the shoulder: where a wing is joined on (x, y to either side, z)
const REACH = 4.3;           // yards from there to the tip

// The parts: 0 and 1 are your own colours (figure.js: the figure's body and its trim), 2 to 7 the creature's.
const YOU = 0, HIDE = 2, PALE = 3, HORN = 4, WING = 5, SAIL = 6, DARK = 7;

function tri(out, a, b, c, part, up = false) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  // (a wing is one skin seen from both sides: lit as from above, whichever way it was wound)
  if (up && nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  for (const p of [a, b, c]) out.push(p[0], p[1], p[2], nx, ny, nz, part);
}

/**
 * A round, tapering limb along a spine that lies in an upright plane (the body from rump to
 * beak, a tail, a leg): stations of [x, z, half its width, half its height, part], the part
 * being the colour from that station to the next. `y`: how far to the left that plane is.
 */
function limb(out, stations, y = 0, segments = 14) {
  const n = stations.length, rings = [];
  for (let i = 0; i < n; i++) {
    const [x, z, ry, rz] = stations[i];
    const a = stations[Math.max(0, i - 1)], b = stations[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    // (across the spine, in its plane: up, where the spine runs forward)
    const ux = -tz, uz = tx, ring = [];
    for (let s = 0; s < segments; s++) {
      const ang = (s / segments) * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang);
      const w = Math.max(ry, 1e-3), h = Math.max(rz, 1e-3);
      let nx = (ux * sn) / h, ny = c / w, nz = (uz * sn) / h;
      const nl = Math.hypot(nx, ny, nz) || 1;
      ring.push([x + ux * rz * sn, y + ry * c, z + uz * rz * sn, nx / nl, ny / nl, nz / nl]);
    }
    rings.push(ring);
  }
  for (let i = 0; i + 1 < n; i++) {
    const part = stations[i][4];
    for (let s = 0; s < segments; s++) {
      const a = rings[i][s], b = rings[i][(s + 1) % segments], c = rings[i + 1][(s + 1) % segments], d = rings[i + 1][s];
      for (const p of [a, b, c, a, c, d]) out.push(p[0], p[1], p[2], p[3], p[4], p[5], part);
    }
  }
}
const both = (out, stations, y, segments = 10) => { limb(out, stations, y, segments); limb(out, stations, -y, segments); };

/** A value read off a row of [where (0..1), value] points. */
function along(keys, u) {
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) { const [u0, v0] = keys[i - 1], [u1, v1] = keys[i]; return v0 + ((v1 - v0) * (u - u0)) / (u1 - u0 || 1); }
  }
  return keys[keys.length - 1][1];
}

const KINDS = {
  // Lion behind, eagle in front: a feathered head and chest, a hooked beak, broad feathered wings, a tufted tail.
  gryphon: {
    colors: ['#b98a45', '#efe8d8', '#f1b12c', '#7b5733', '#d8c7a0', '#3b2a1d'],
    build(v) {
      limb(v, [[-1.55, 0.78, 0.05, 0.05, HIDE], [-1.35, 0.8, 0.3, 0.3, HIDE], [-0.95, 0.82, 0.46, 0.44, HIDE], [-0.35, 0.8, 0.5, 0.46, HIDE], [0.25, 0.82, 0.54, 0.5, PALE],
        [0.75, 0.9, 0.52, 0.52, PALE], [1.15, 1.08, 0.36, 0.4, PALE], [1.45, 1.3, 0.27, 0.3, PALE], [1.72, 1.46, 0.29, 0.31, PALE], [1.95, 1.48, 0.27, 0.28, HORN],
        [2.12, 1.42, 0.17, 0.19, HORN], [2.34, 1.3, 0.07, 0.1, HORN], [2.42, 1.16, 0.01, 0.02, HORN]]);
      // the tail, and the tuft at its end
      limb(v, [[-1.4, 0.8, 0.1, 0.1, HIDE], [-2.0, 0.72, 0.07, 0.07, HIDE], [-2.6, 0.7, 0.06, 0.06, HIDE], [-2.95, 0.78, 0.06, 0.06, DARK], [-3.05, 0.8, 0.13, 0.13, DARK], [-3.28, 0.87, 0.18, 0.18, DARK], [-3.52, 0.94, 0.02, 0.02, DARK]], 0, 10);
      // legs tucked up: an eagle's in front, a lion's behind
      both(v, [[0.75, 0.62, 0.14, 0.14, PALE], [0.55, 0.32, 0.1, 0.1, HORN], [0.25, 0.16, 0.08, 0.08, HORN], [0.02, 0.1, 0.1, 0.06, HORN], [-0.14, 0.08, 0.01, 0.01, HORN]], 0.3);
      both(v, [[-0.85, 0.62, 0.17, 0.17, HIDE], [-1.15, 0.34, 0.12, 0.12, HIDE], [-1.5, 0.22, 0.09, 0.09, HIDE], [-1.8, 0.2, 0.11, 0.07, HIDE], [-1.96, 0.19, 0.01, 0.01, HIDE]], 0.32);
      // the tufts of feathers it has for ears, and its eyes
      both(v, [[1.76, 1.64, 0.07, 0.07, PALE], [1.62, 1.86, 0.05, 0.05, PALE], [1.5, 2.02, 0.01, 0.01, PALE]], 0.17, 8);
      both(v, [[1.9, 1.56, 0.01, 0.01, DARK], [1.96, 1.56, 0.06, 0.06, DARK], [2.02, 1.56, 0.01, 0.01, DARK]], 0.22, 8);
    },
    wing: {
      lead: [[0, 0.55], [0.2, 1.05], [0.4, 1.3], [0.7, 1.05], [0.9, 0.55], [1, 0.05]],
      trail: [[0, -0.75], [0.25, -1.15], [0.5, -1.2], [0.75, -0.95], [0.9, -0.6], [1, -0.15]],
      notch: 0.2,    // every other station's trailing edge is this much shorter: the ends of the feathers
      split: 0.42,   // of the way back from the leading edge: where the wing's second colour begins
      parts: [WING, SAIL],
    },
  },
  // A lion's body and mane, a bat's wings, a scorpion's tail curled up over its back.
  wyvern: {
    colors: ['#c8843f', '#e6c592', '#efe6cf', '#7d4a2a', '#d99a5b', '#4a2a1c'],
    build(v) {
      limb(v, [[-1.55, 0.78, 0.05, 0.05, HIDE], [-1.35, 0.8, 0.3, 0.3, HIDE], [-0.95, 0.82, 0.46, 0.44, HIDE], [-0.35, 0.8, 0.5, 0.46, HIDE], [0.25, 0.82, 0.54, 0.5, HIDE],
        [0.75, 0.9, 0.52, 0.52, DARK], [1.12, 1.06, 0.5, 0.52, DARK], [1.45, 1.28, 0.46, 0.46, DARK], [1.66, 1.4, 0.34, 0.34, HIDE], [1.92, 1.42, 0.3, 0.29, HIDE],
        [2.1, 1.38, 0.22, 0.2, PALE], [2.27, 1.32, 0.15, 0.13, PALE], [2.36, 1.28, 0.02, 0.02, PALE]]);
      // the tail: up and over, a swelling and a sting at its end
      limb(v, [[-1.4, 0.8, 0.15, 0.15, HIDE], [-2.05, 0.86, 0.13, 0.13, DARK], [-2.55, 1.15, 0.12, 0.12, DARK], [-2.8, 1.65, 0.11, 0.11, DARK], [-2.66, 2.15, 0.11, 0.11, DARK],
        [-2.32, 2.4, 0.16, 0.16, DARK], [-2.02, 2.34, 0.1, 0.1, HORN], [-1.72, 2.08, 0.01, 0.01, HORN]], 0, 10);
      both(v, [[0.7, 0.62, 0.16, 0.16, HIDE], [0.5, 0.33, 0.12, 0.12, HIDE], [0.2, 0.2, 0.09, 0.09, HIDE], [-0.06, 0.17, 0.11, 0.07, HIDE], [-0.22, 0.16, 0.01, 0.01, HIDE]], 0.3);
      both(v, [[-0.85, 0.62, 0.17, 0.17, HIDE], [-1.15, 0.34, 0.12, 0.12, HIDE], [-1.5, 0.22, 0.09, 0.09, HIDE], [-1.8, 0.2, 0.11, 0.07, HIDE], [-1.96, 0.19, 0.01, 0.01, HIDE]], 0.32);
      // its horns, swept back, and its eyes
      both(v, [[1.74, 1.64, 0.07, 0.07, HORN], [1.55, 1.86, 0.05, 0.05, HORN], [1.34, 1.95, 0.01, 0.01, HORN]], 0.2, 8);
      both(v, [[1.94, 1.52, 0.01, 0.01, DARK], [2.0, 1.52, 0.06, 0.06, DARK], [2.06, 1.52, 0.01, 0.01, DARK]], 0.24, 8);
    },
    wing: {
      lead: [[0, 0.5], [0.3, 1.45], [0.45, 1.6], [0.75, 1.0], [1, 0.1]],
      trail: [[0, -0.7], [0.3, -1.0], [0.6, -0.9], [0.85, -0.55], [1, -0.2]],
      notch: 0.42,   // deep scallops between the fingers of the wing
      split: 0.2,
      parts: [WING, SAIL],
    },
  },
};

/** The creature that flies your side's flight paths. */
export const mountOf = (faction) => (faction === 'horde' ? 'wyvern' : 'gryphon');

/** A creature's own colours: six of them, as '#rrggbb' (the parts 2 to 7). */
export const mountColors = (kind) => KINDS[kind].colors;

/**
 * Everything of a creature that does not move: its body, with a cloth in your colour over its
 * back and your figure sitting on it.
 * @param rider  (vertices, lift) => adds your figure, standing `lift` yards up
 */
export function mountBody(kind, rider) {
  const v = [];
  KINDS[kind].build(v);
  // the saddle cloth: a band round the body where you sit
  limb(v, [[-0.42, 0.81, 0.53, 0.495, YOU], [0, 0.81, 0.555, 0.51, YOU], [0.42, 0.83, 0.575, 0.53, YOU], [0.44, 0.83, 0.5, 0.48, YOU]], 0, 16);
  rider(v, SEAT);
  return new Float32Array(v);
}

/** How many vertices the two wings take (they are laid out anew for every frame: see mountWings). */
export const WING_VERTICES = 2 * STATIONS * 2 * 6;

/**
 * The two wings as they are `seconds` into their beating, written into `out` (WING_VERTICES of
 * them). A wing is a row of pieces from the shoulder to the tip, each tilted a little more than
 * the one before and a little later: so the beat runs out along it, and the tips trail behind.
 */
export function mountWings(kind, seconds, out) {
  const w = KINDS[kind].wing, phase = seconds * BEAT * Math.PI * 2, v = [];
  const step = REACH / STATIONS;
  for (const side of [1, -1]) {
    let y = ROOT[1], z = ROOT[2];
    const rows = [];
    for (let j = 0; j <= STATIONS; j++) {
      const u = j / STATIONS;
      if (j > 0) {
        const m = (j - 0.5) / STATIONS;
        const tilt = 0.14 + 0.52 * Math.sin(phase - 1.1 * m) * (0.55 + 0.75 * m);
        y += step * Math.cos(tilt); z += step * Math.sin(tilt);
      }
      const lead = ROOT[0] + along(w.lead, u), end = ROOT[0] + along(w.trail, u) + (j % 2 === 1 && j < STATIONS ? w.notch : 0);
      const mid = lead + (end - lead) * w.split;
      // (the skin hangs a little toward its trailing edge)
      rows.push([[lead, side * y, z], [mid, side * y, z - 0.04], [end, side * y, z - 0.16]]);
    }
    for (let j = 0; j < STATIONS; j++) for (let b = 0; b < 2; b++) {
      const p = rows[j][b], q = rows[j + 1][b], r = rows[j + 1][b + 1], s = rows[j][b + 1];
      tri(v, p, q, r, w.parts[b], true); tri(v, p, r, s, w.parts[b], true);
    }
  }
  out.set(v);
  return v.length / STRIDE;
}

/** How far the body rides up and down with the beat (yards), at the same moment. */
export const mountBob = (seconds) => -0.07 * Math.sin(seconds * BEAT * Math.PI * 2 - 0.4);
