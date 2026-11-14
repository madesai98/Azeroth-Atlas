// Minimal vector / matrix helpers. World space follows the game: +X north, +Y west, +Z up.

export const TILE = 1600 / 3;       // yards per map tile
export const CHUNK = TILE / 16;     // yards per terrain chunk
export const UNIT = CHUNK / 8;      // yards per terrain quad
export const MAP_HALF = 32 * TILE;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Camera basis from compass heading (0 = north, 90 = east) and pitch (positive = up), degrees. */
export function basis(headingDeg, pitchDeg) {
  const h = headingDeg * DEG, p = pitchDeg * DEG;
  const cp = Math.cos(p), sp = Math.sin(p), ch = Math.cos(h), sh = Math.sin(h);
  const f = [cp * ch, -cp * sh, sp];
  const r = [-sh, -ch, 0];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

/**
 * Camera-relative view-projection (rotation only; translation is applied on the CPU in doubles).
 * Reversed-Z with an infinite far plane: depth = near / distance.
 */
export function viewProj(out, b, fovYDeg, aspect, near) {
  const t = 1 / Math.tan((fovYDeg * DEG) / 2);
  const sx = t / aspect, sy = t;
  const { f, r, u } = b;
  // P * V, with V rows = [r; u; -f] and P = diag(sx, sy) plus clip.z = near, clip.w = -z_view
  out[0] = sx * r[0]; out[4] = sx * r[1]; out[8] = sx * r[2]; out[12] = 0;
  out[1] = sy * u[0]; out[5] = sy * u[1]; out[9] = sy * u[2]; out[13] = 0;
  out[2] = 0; out[6] = 0; out[10] = 0; out[14] = near;
  out[3] = f[0]; out[7] = f[1]; out[11] = f[2]; out[15] = 0;
  return out;
}

/** Frustum planes (left, right, bottom, top, near) for camera-relative points. */
export function frustumPlanes(m, near) {
  const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r3 = row(3);
  const add = (a, b, s) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
  return [add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), [r3[0], r3[1], r3[2], -near]];
}

/** Axis-aligned box (camera-relative min/max) vs frustum. */
export function boxVisible(planes, x0, y0, z0, x1, y1, z1) {
  for (const p of planes) {
    const x = p[0] > 0 ? x1 : x0, y = p[1] > 0 ? y1 : y0, z = p[2] > 0 ? z1 : z0;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}

/** Project a camera-relative point. Returns [ndcX, ndcY, distanceAlongView] or null if behind. */
export function project(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z;
  if (w <= 0.01) return null;
  return [(m[0] * x + m[4] * y + m[8] * z) / w, (m[1] * x + m[5] * y + m[9] * z) / w, w];
}

/** World-space ray direction through a normalized device coordinate. */
export function rayDir(b, fovYDeg, aspect, ndcX, ndcY) {
  const t = Math.tan((fovYDeg * DEG) / 2);
  const vx = ndcX * t * aspect, vy = ndcY * t;
  const d = [b.f[0] + b.r[0] * vx + b.u[0] * vy, b.f[1] + b.r[1] * vx + b.u[1] * vy, b.f[2] + b.r[2] * vx + b.u[2] * vy];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

// ---- object placement --------------------------------------------------------------------
// Affine transforms are 3x4, row-major, in doubles: [r00 r01 r02 tx | r10 r11 r12 ty | r20 r21 r22 tz].

/**
 * World transform of a placed building/object. `rot` is the game's (x, y, z) rotation in degrees.
 * Convention verified against the bounds the game stores for every building placement.
 */
export function placementMatrix(pos, rot, scale) {
  const a = (rot[1] + 180) * DEG, b = rot[0] * DEG, g = rot[2] * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  const m = new Float64Array(12);
  m[0] = ca * cb * scale; m[1] = (-sa * cg + ca * sb * sg) * scale; m[2] = (sa * sg + ca * sb * cg) * scale; m[3] = pos[0];
  m[4] = sa * cb * scale; m[5] = (ca * cg + sa * sb * sg) * scale; m[6] = (-ca * sg + sa * sb * cg) * scale; m[7] = pos[1];
  m[8] = -sb * scale; m[9] = cb * sg * scale; m[10] = cb * cg * scale; m[11] = pos[2];
  return m;
}

/** Transform from position + quaternion (x, y, z, w) + uniform scale. */
export function quatMatrix(pos, q, scale) {
  const [x, y, z, w] = q;
  const m = new Float64Array(12);
  m[0] = (1 - 2 * (y * y + z * z)) * scale; m[1] = 2 * (x * y - z * w) * scale; m[2] = 2 * (x * z + y * w) * scale; m[3] = pos[0];
  m[4] = 2 * (x * y + z * w) * scale; m[5] = (1 - 2 * (x * x + z * z)) * scale; m[6] = 2 * (y * z - x * w) * scale; m[7] = pos[1];
  m[8] = 2 * (x * z - y * w) * scale; m[9] = 2 * (y * z + x * w) * scale; m[10] = (1 - 2 * (x * x + y * y)) * scale; m[11] = pos[2];
  return m;
}

/** out = a * b for 3x4 affine transforms. */
export function affineMul(a, b) {
  const m = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2];
    m[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    m[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    m[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    m[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a[r * 4 + 3];
  }
  return m;
}

/** Sphere (camera-relative centre) vs frustum planes. */
export function sphereVisible(planes, x, y, z, r) {
  for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r * Math.hypot(p[0], p[1], p[2])) return false;
  return true;
}
