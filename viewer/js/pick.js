// What is under the cursor: the first thing a ray from the camera meets that you could stand on
// - a street, a floor, a roof, a bridge (the game's own collision triangles, see floors.js) - or
// else the ground. The camera's own picking only knows the ground, which is right for moving the
// view about but wrong for pointing at a place in a city: there the ground is buried under the
// streets, some way off from where the cursor seems to be.

const NEAR_STEP = 0.4;   // yards between samples close to the camera...
const GROW = 0.004;      // ...growing with distance (a pixel covers more ground far away)
const MAX_STEP = 2.5;

/** Where a ray enters and leaves a box [x0, y0, z0, x1, y1, z1] (padded): [t0, t1] or null. */
function through(o, d, b, pad) {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const lo = b[i] - pad, hi = b[i + 3] + pad;
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return null; continue; }
    let a = (lo - o[i]) / d[i], c = (hi - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/**
 * @param app  the page (camera, floors, objects, player)
 * @param px, py  where on the canvas (CSS pixels)
 * @returns [x, y, z] of the surface there, or the ground, or null
 */
export function pickSurface(app, px, py) {
  const cam = app.camera;
  const ground = cam.pickAt(px, py);
  const wmos = app.objects?.wmos;
  if (!wmos?.length || !app.floors || app.objects.enabled?.buildings === false) return ground;
  const o = cam.pos, d = cam.ray(px, py);
  if (d[2] > -0.02) return ground; // (looking level or up: a floor is not seen from above)
  const far = ground ? Math.hypot(ground[0] - o[0], ground[1] - o[1], ground[2] - o[2]) : 4000;
  // the buildings the ray passes through, and the stretch of it that is inside any of them
  const hit = [];
  let from = Infinity, to = 0;
  for (const w of wmos) {
    const span = through(o, d, w.bounds, 1);
    if (!span || span[0] > far) continue;
    hit.push(w);
    if (span[0] < from) from = span[0];
    if (span[1] > to) to = span[1];
  }
  if (!hit.length) return ground;
  to = Math.min(to, far);
  // what the cutaway has taken off the picture (a ceiling, the floors over you) is not there to be clicked
  const hidden = (x, y, z) => !!app.cutaway?.hides(x, y, z);
  const floorAt = (x, y, below, above) => {
    // the highest floor on this spot between two heights of the ray
    let best = null;
    for (const z of app.floors.at(hit, x, y).zs) if (z >= below && z < above && !hidden(x, y, z) && (best === null || z > best)) best = z;
    return best;
  };
  const flat = Math.hypot(d[0], d[1]);
  let t = Math.max(0, from), prevT = t, prevZ = o[2] + d[2] * t + 0.01;
  for (let n = 0; n < 6000 && t <= to; n++) {
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    // A floor here whose height the ray has come down through since the last sample (with some
    // room for a floor that slopes up toward the camera: a roof, a ramp).
    const top = prevZ + (t - prevT) * flat * 1.5;
    const f = floorAt(x, y, z, top);
    if (f !== null) {
      // close in on where between the two samples
      let a = prevT, b = t;
      for (let k = 0; k < 8 && b - a > 0.02; k++) {
        const m = (a + b) / 2;
        if (floorAt(o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m, top) !== null) b = m; else a = m;
      }
      const hx = o[0] + d[0] * b, hy = o[1] + d[1] * b;
      return [hx, hy, floorAt(hx, hy, o[2] + d[2] * b, top) ?? f];
    }
    prevT = t;
    prevZ = z;
    t += Math.min(MAX_STEP, Math.max(NEAR_STEP, t * GROW));
  }
  return ground;
}
