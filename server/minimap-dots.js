// The dots on the game's minimap, read off its picture.
//
// What the game tracks for you - beasts, humanoids, the hidden, herbs, whatever your tracking is
// set to - it shows as dots on its minimap, and it shows your pet and your target there too. It
// tells an addon none of this: there is no asking where a dot is. But the minimap is on the
// screen, the helper that reads the strip has the game's picture (strip-reader.cs), and a dot is
// a thing with a look of its own: a small disc of one colour (red: hostile to you; yellow:
// neutral; green: friendly; blue: yours, or of your party), a ring round it (silver; gold on
// the one you have targeted), and a black edge round that. A THING your tracking finds - a
// herb, a vein of ore - is the yellow disc in the gold ring: the same dot as a neutral creature
// you have targeted (seen in the game on 24 November 2026, with Find Herbs on). The game draws every one of them from
// one sheet of icons (Interface/Minimap/ObjectIconsAtlas), which is where the measures below
// are from; how big they come out on the screen goes by the interface's scale, so the size is
// measured off the dots themselves and nothing is taken for granted about it.
//
// findDots looks at one picture and says where the dots are on it. placeDots turns that into
// places in the world: the minimap's middle is you, its edge is as many yards off as the game
// says (the addon passes that on), and it is turned as you are where it turns with you. Tracks
// follows them from picture to picture, so that a dot is one thing with a number of its own for
// as long as it is seen, and one picture's mistake comes and goes unshown.
//
// What it cannot do: say what a dot IS (its name is only in the game's tooltip); see a dot that
// lies wholly under another, or under your own arrow; tell your pet from another blue dot (that
// is worked out with what the addon says: minimap-watch.js). A dot half under another is found
// by what shows of it, to a yard or two.

// ---- what a dot is made of, in the icon sheet's own measure ------------------------------------
// (taken from the sheet: the disc's colour ends 4.3 pixels from the middle, the ring lies from
// 5 to 7.5, the black edge ends at 9.5 - of which the outer pixel is half see-through, and what is
// seen of it on the screen ends at 8.7. All of it is used as a share of the ring's outer edge.)
const DISC = 4.3 / 7.5, RING_IN = 5 / 7.5, EDGE = 8.7 / 7.5;
const SMALLEST = 3, LARGEST = 24; // pixels: the ring's outer edge is this far from the middle, at the least and at the most
const RAYS = 32;
const ALONE_LEAST = 5.5; // pixels: the least a yellow dot in a gold ring measures for it to be told with no other dot's size to go by
const WHOLE = 0.9; // the share of the ways out from a dot's middle that find its ring, for the ring to be "all round"

// what a pixel can be
const OTHER = 0, DARK = 1, GREY = 2, GOLD = 3, RED = 4, GREEN = 5, BLUE = 6, DIM = 7;
export const KINDS = { [RED]: 'red', [GREEN]: 'green', [BLUE]: 'blue', [GOLD]: 'yellow' };

// (for looking into a picture: why each blob that was looked at is no dot - findDots, opts.why)
let why = null;
const no = (b, x0, y0, text) => { if (why && b.n >= 6) why.push(`${KINDS[b.kind]} blob of ${b.n} at ${(b.mx + x0).toFixed(1)}, ${(b.my + y0).toFixed(1)}: ${text}`); return null; };

/** What a pixel is: part of a disc (by its colour), of a ring (silver or gold), of the black edge - or none of them. */
export function classOf(r, g, b) {
  const hi = r > g ? (r > b ? r : b) : (g > b ? g : b), lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
  if (hi <= 64) return DARK;
  if (b >= 140 && b - r >= 60 && b - g >= 70) return BLUE;
  if (r >= 80 && g <= 0.22 * r + 10 && b <= 0.22 * r + 10) return RED;
  if (g >= 90 && r <= 0.4 * g + 10 && b <= 0.25 * g + 10) return GREEN;
  if (r >= 140 && g >= 0.58 * r - 8 && g <= 0.95 * r + 4 && b <= 0.42 * r && r - b >= 90) return GOLD;
  if (hi - lo <= 36 && hi >= 110) return GREY;
  // (the black edge is a pixel wide, and what lies beside it shows through: seldom black, but dim)
  return hi <= 110 ? DIM : OTHER;
}

/**
 * The dots on one picture of the minimap.
 * @param pic   { data (R G B, row by row), w, h }
 * @param geo   { cx, cy (the minimap's middle, in pixels of this picture), half (half its width), round (false: it is square) }
 * @param opts  { size (pixels from a dot's middle to the outer edge of its ring, as measured before - or null) }
 * @returns { dots: [{ x, y (pixels of this picture), kind ('red', 'yellow', 'green', 'blue', or 'hidden': its colour
 *            is under another dot), ring ('silver', 'gold'), size, fit (0 to 1), part (true: found by the part of
 *            it that shows) }], size (as measured on this picture - or null: no whole dot on it) }
 */
export function findDots(pic, geo, opts = {}) {
  why = Array.isArray(opts.why) ? opts.why : null;
  const { data, w, h } = pic;
  const half = geo.half, cx = geo.cx, cy = geo.cy, round = geo.round !== false;
  const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(w - 1, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(cy - half)), y1 = Math.min(h - 1, Math.ceil(cy + half));
  if (!(half >= 30) || x1 - x0 < 40 || y1 - y0 < 40) return { dots: [], size: null };
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  // (what each pixel of the minimap is; outside it, nothing)
  const cls = new Uint8Array(W * H), lum = new Uint8Array(W * H);
  const reach = (half - 1) * (half - 1);
  for (let y = 0; y < H; y++) {
    const dy = y + y0 - cy;
    for (let x = 0; x < W; x++) {
      const dx = x + x0 - cx;
      if (round ? dx * dx + dy * dy > reach : false) continue;
      const i = ((y + y0) * w + x + x0) * 3;
      cls[y * W + x] = classOf(data[i], data[i + 1], data[i + 2]);
      lum[y * W + x] = Math.max(data[i], data[i + 1], data[i + 2]);
    }
  }
  const at = (x, y) => { const X = Math.round(x) - x0, Y = Math.round(y) - y0; return X < 0 || Y < 0 || X >= W || Y >= H ? OTHER : cls[Y * W + X]; };
  at.lum = (x, y) => { const X = Math.round(x) - x0, Y = Math.round(y) - y0; return X < 0 || Y < 0 || X >= W || Y >= H ? 255 : lum[Y * W + X]; };
  // (the pure yellow the lit side of a gold ring is on the screen - brighter than on the icon sheet, and past what counts as gold)
  at.lit = (x, y) => { const X = Math.round(x), Y = Math.round(y); if (X < x0 || Y < y0 || X > x1 || Y > y1) return false; const i = (Y * w + X) * 3; return data[i] >= 200 && data[i + 1] >= 190 && data[i + 2] <= 130 && data[i] - data[i + 2] >= 110; };
  const taken = new Uint8Array(W * H); // (pixels a dot already found accounts for)
  const dots = [];

  // Your own arrow is in the middle, and it has a small blue eye with a silver rim. That is no
  // dot: its blue is a ring round a dark middle, where a dot's colour is a disc (wholeDot). But
  // nothing is made of a PART of a dot there, where the arrow's own silver would pass for a ring;
  // and nothing at all of what lies right under the arrow's middle.
  const ownSize = opts.size ?? null;
  const arrow = Math.max(0.085 * half, ownSize ? 2.3 * ownSize : 0.13 * half);
  const underArrow = (x, y) => Math.hypot(x - cx, y - cy) < arrow;
  const middle = Math.max(4, 0.03 * half);

  const inside = (d) => Math.hypot(d.x - cx, d.y - cy) >= middle && (round ? Math.hypot(d.x - cx, d.y - cy) < half - d.size * EDGE : Math.abs(d.x - cx) < half - d.size * EDGE && Math.abs(d.y - cy) < half - d.size * EDGE);
  const take = (d) => { dots.push(d); claim(taken, W, H, d, x0, y0); };
  // (two dots whose middles are this near are one dot seen twice: of two apart, more than half of the lower would be hidden)
  const twice = (d) => dots.some((o) => Math.hypot(o.x - d.x, o.y - d.y) < 0.9 * Math.max(o.size, d.size));

  // ---- 1. discs of one colour with a ring all round: whole dots --------------------------------
  // (a yellow disc is of the gold ring's own colour: as a disc in a ring it is only looked for with a silver one)
  const cands = components(cls, W, H, [RED, GREEN, BLUE, GOLD]).map((b) => ({ b, d: wholeDot(b, at, x0, y0, b.kind === GOLD ? GREY : null), done: false }));
  const sizes = [];
  for (const c of cands.filter((q) => q.d && q.d.fit >= WHOLE).sort((p, q) => q.d.fit - p.d.fit)) {
    c.done = true;
    if (inside(c.d) && !twice(c.d)) { take(c.d); sizes.push(c.d.size); }
  }
  let size = sizes.length ? median(sizes) : null;
  let S = size ?? ownSize;

  if (!S) {
    // ---- 1b. the yellow dot with the gold ring, with no size to go by ----------------------------
    // Who tracks herbs or ore and nothing else has no other dot on the minimap, ever: this one
    // has to be told by itself. A round of gold edged in black all round is not enough for that
    // (other things are); it has the look of a dot inside as well - a disc, a darker line round
    // it, the ring (goldAlone). What it measures is the size of a dot, for the rest.
    for (const c of cands) {
      if (c.done || c.b.kind !== GOLD || claimed(taken, W, c.b) > 0.5) continue;
      const d = goldAlone(c.b, at, x0, y0);
      if (!d) continue;
      c.done = true;
      if (inside(d) && !twice(d)) { take(d); sizes.push(d.size); }
    }
    size = sizes.length ? median(sizes) : null;
    S = size;
  }
  if (S) {
    // ---- 2. the yellow dot with the gold ring (your target, neutral to you) ---------------------
    // Disc and ring run into each other: a round of gold of the ring's size, edged in black -
    // which is only believed where the size of a dot is known.
    for (const c of cands) {
      if (c.done || c.b.kind !== GOLD || claimed(taken, W, c.b) > 0.5) continue;
      // (...or told by its own look, where it is of about that size: on the screen the lit side of its ring is past gold, and the round of gold comes out small)
      let d = goldDot(c.b, at, x0, y0, S);
      if (!d) { d = goldAlone(c.b, at, x0, y0); if (d && Math.abs(d.size - S) > Math.max(1.5, 0.25 * S)) d = null; }
      if (!d) continue;
      c.done = true;
      if (inside(d) && !twice(d)) take(d);
    }
    // ---- 3. what shows of a dot that lies half under another ------------------------------------
    const near = (b) => dots.some((d) => !d.part && Math.hypot(d.x - (b.mx + x0), d.y - (b.my + y0)) <= 2.6 * S);
    const least = Math.max(5, 0.07 * Math.PI * S * S);
    for (const c of cands.filter((q) => !q.done).sort((p, q) => q.b.n - p.b.n)) {
      const b = c.b;
      if (b.n < least || b.w > 2.6 * S || b.h > 2.6 * S || !near(b) || claimed(taken, W, b) > 0.5) continue;
      const found = partDot(b, cls, taken, W, H, x0, y0, S);
      if (!found) continue;
      c.done = true;
      if (inside(found) && !underArrow(found.x, found.y) && !twice(found)) take(found);
    }
  }
  // ---- 4. most of a ring, and not a part of a dot found: a whole dot with something over a little of it --
  for (const c of cands.filter((q) => !q.done && q.d).sort((p, q) => q.d.fit - p.d.fit)) {
    if (S && Math.abs(c.d.size - S) > Math.max(1, 0.2 * S)) continue;
    if (inside(c.d) && !twice(c.d)) take(c.d);
  }
  return { dots, size };
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Pixels of the kinds asked for that hang together (corner to corner counts): [{ kind, n, mx, my (their middle), x, y, w, h (the box round them), px: [indexes] }] */
function components(cls, W, H, kinds) {
  const want = new Uint8Array(8);
  for (const k of kinds) want[k] = 1;
  const seen = new Uint8Array(W * H), out = [], stack = [];
  for (let start = 0; start < W * H; start++) {
    const kind = cls[start];
    if (!want[kind] || seen[start]) continue;
    seen[start] = 1; stack.push(start);
    const px = [];
    let sx = 0, sy = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      px.push(i); sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (px.length > 4000) break; // (a stretch of ground of that colour: no dot)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if ((!dx && !dy) || X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X;
        if (!seen[j] && cls[j] === kind) { seen[j] = 1; stack.push(j); }
      }
    }
    if (stack.length) { for (const i of stack) seen[i] = 1; stack.length = 0; continue; }
    if (px.length >= 4) out.push({ kind, n: px.length, mx: sx / px.length, my: sy / px.length, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, px });
  }
  return out;
}

/** The share of a blob's pixels that a dot already found accounts for. */
function claimed(taken, W, b) { let n = 0; for (const i of b.px) if (taken[i]) n++; return n / b.n; }

/** A dot found accounts for every pixel out to its black edge. */
function claim(taken, W, H, d, x0, y0) {
  const r = d.size * EDGE + 0.3, X = d.x - x0, Y = d.y - y0;
  for (let y = Math.max(0, Math.floor(Y - r)); y <= Math.min(H - 1, Math.ceil(Y + r)); y++) for (let x = Math.max(0, Math.floor(X - r)); x <= Math.min(W - 1, Math.ceil(X + r)); x++) {
    if ((x - X) ** 2 + (y - Y) ** 2 <= r * r) taken[y * W + x] = 1;
  }
}

/**
 * Is this blob the disc of a dot with its ring round it? Out from its middle, every way: the
 * disc's colour, then the ring's (silver or gold) for a pixel or more, then something darker -
 * the black edge. The ring's outer edge, on the ways that have one, is a circle: its middle is
 * the dot's, its radius the dot's size. (Where the ring runs straight on into more of its
 * colour - a neighbour's ring: drawn small, the black between the two is too thin to show -
 * it is ended where a ring that began there would end, and counted, as long as that is so on
 * few of the ways.)
 * @param only  the one colour of ring looked for (or any)
 * @returns { x, y, kind, ring, size, fit (the share of the ways that found the ring: 0.72 and more) } - or null
 */
function wholeDot(b, at, x0, y0, only = null) {
  const rd = Math.sqrt(b.n / Math.PI);
  if (rd < SMALLEST * DISC * 0.7 || rd > LARGEST * DISC * 1.2 || b.w > 2.6 * rd + 2 || b.h > 2.6 * rd + 2 || Math.abs(b.w - b.h) > Math.max(2, 0.45 * Math.max(b.w, b.h))) return no(b, x0, y0, `its shape (${b.w} by ${b.h})`);
  let mx = b.mx + x0, my = b.my + y0;
  // (a disc: its middle is of its colour - not a ring of the colour round something else, as the eye of your own arrow is)
  if (at(mx, my) !== b.kind) return no(b, x0, y0, 'no disc: its middle is not of its colour');
  let best = null;
  // (twice: the second time from the middle the ring gave, which is truer than the blob's - a disc is shaded, and darker below)
  for (let pass = 0; pass < 2; pass++) {
    const ends = [];
    let grey = 0, gold = 0, ranOn = 0;
    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a);
      const most = rd * 1.9 + 2;
      // out past the disc, and the thin shade between disc and ring
      let r = 0.5, c = at(mx + ux * r, my + uy * r);
      if (b.kind === GOLD) { // (a yellow disc is of the gold ring's own colour: its ring is the silver past it)
        while (r <= most && c !== GREY) { r += 0.5; c = at(mx + ux * r, my + uy * r); }
      } else {
        while (r <= most && c !== GREY && c !== GOLD) { r += 0.5; c = at(mx + ux * r, my + uy * r); }
      }
      if ((c !== GREY && c !== GOLD) || r < rd * 0.6 || r > most) continue;
      const ring = c, from = r, wide = Math.max(1.5, from * (1 / RING_IN - 1) + 1); // (how wide a ring that begins here is, at the most)
      let gap = 0, end = r, bright = at.lum(mx + ux * r, my + uy * r), ended = false;
      while (r <= from + wide + 1.5) {
        r += 0.5; c = at(mx + ux * r, my + uy * r);
        const l = at.lum(mx + ux * r, my + uy * r);
        if (c === DARK || c === DIM || l <= 0.7 * bright) { ended = true; break; }
        if (c === ring || (ring === GOLD && c === GREY) || (ring === GREY && c === GOLD)) { end = r; gap = 0; if (l > bright) bright = l; continue; }
        if (++gap > 2) break;
      }
      if (end - from < 0.5) continue;
      if (!ended || end - from > wide) { if (end - from >= wide) ranOn++; continue; }
      if (ring === GREY) grey++; else gold++;
      ends.push([mx + ux * (end + 0.25), my + uy * (end + 0.25)]);
    }
    const ring = grey >= gold ? GREY : GOLD;
    if (only !== null && ring !== only) return no(b, x0, y0, 'the ring is of the other colour');
    if (ends.length < RAYS * 0.6) return best ?? no(b, x0, y0, `a ring on ${ends.length} of ${RAYS} ways out (${ranOn} more ran on)`);
    let circle = fitCircle(ends);
    if (!circle || circle.r < SMALLEST || circle.r > LARGEST || circle.spread > Math.max(0.9, circle.r * 0.14)) return best ?? no(b, x0, y0, circle ? `the ring's edge is no circle (radius ${circle.r.toFixed(1)}, off by ${circle.spread.toFixed(2)})` : 'the ring\'s edge is no circle');
    // (only the ways whose ring lies on that circle count: one that found a neighbour's ring instead does not)
    const on = ends.filter((p) => Math.abs(Math.hypot(p[0] - circle.x, p[1] - circle.y) - circle.r) <= Math.max(1.1, circle.r * 0.15));
    if (on.length < RAYS * 0.6) return best ?? no(b, x0, y0, `${on.length} of ${ends.length} ring ends on one circle of ${circle.r.toFixed(1)}`);
    if (on.length < ends.length) { const again = fitCircle(on); if (again) circle = again; }
    // (the disc is as big as a dot's is for a ring of that size - not a speck in a wide ring, nor a ring hugging a big blob)
    if (rd < circle.r * DISC * 0.55 || rd > circle.r * DISC * 1.5) return best ?? no(b, x0, y0, `a disc of ${rd.toFixed(1)} in a ring of ${circle.r.toFixed(1)}`);
    const fit = (on.length + Math.min(ranOn, RAYS * 0.3)) / RAYS;
    if (fit < 0.72) return best ?? no(b, x0, y0, `the ring is there on ${on.length} ways of ${RAYS}, and ran on along ${ranOn}`);
    best = { x: circle.x, y: circle.y, kind: KINDS[b.kind], ring: ring === GREY ? 'silver' : 'gold', size: circle.r, fit };
    mx = circle.x; my = circle.y;
  }
  return best;
}

/** A circle through points, by least squares: { x, y, r, spread (how far the points are off it, at the middle) } */
function fitCircle(pts) {
  const n = pts.length;
  if (n < 5) return null;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p[0]; sy += p[1]; }
  const ox = sx / n, oy = sy / n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p[0] - ox, v = p[1] - oy;
    suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const a = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (a * svv - b2 * suv) / det, vc = (b2 * suu - a * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const off = pts.map((p) => Math.abs(Math.hypot(p[0] - ox - uc, p[1] - oy - vc) - r)).sort((p, q) => p - q);
  return { x: ox + uc, y: oy + vc, r, spread: off[off.length >> 1] };
}

/**
 * A round of gold the size of a dot's ring, edged in black all round: the yellow dot with the
 * gold ring. (Told from other gold things of that size - the diamond the game pins to the rim
 * for what lies off the minimap - by being round: its edge is the same distance out every way.)
 */
function goldDot(b, at, x0, y0, S) {
  const rb = Math.sqrt(b.n / Math.PI);
  if (rb < S * 0.78 || rb > S * 1.15 || Math.abs(b.w - b.h) > Math.max(2, 0.2 * S) || b.w > 2.5 * S) return no(b, x0, y0, `no round of gold the size of a ring of ${S.toFixed(1)} (${b.w} by ${b.h}, as much as a round of ${rb.toFixed(1)})`);
  const mx = b.mx + x0, my = b.my + y0, ends = [];
  for (let k = 0; k < RAYS; k++) {
    const a = (k / RAYS) * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a);
    let r = 0, end = 0, gap = 0, c = OTHER;
    while (r <= S * 1.5 + 2) {
      r += 0.5; c = at(mx + ux * r, my + uy * r);
      if (c === GOLD) { end = r; gap = 0; continue; }
      if (r < S * 0.8) continue; // (inside, between disc and ring, it is shaded: anything goes)
      if (c === DARK || c === DIM) { c = DARK; break; }
      if (++gap > 2) break;
    }
    if (c === DARK && end > S * 0.6) ends.push([mx + ux * (end + 0.25), my + uy * (end + 0.25)]);
  }
  if (ends.length < RAYS * 0.85) return no(b, x0, y0, `gold, with black round it on ${ends.length} of ${RAYS} ways out`);
  const circle = fitCircle(ends);
  if (!circle || Math.abs(circle.r - S) > Math.max(0.8, 0.14 * S) || circle.spread > Math.max(0.5, S * 0.07)) return no(b, x0, y0, circle ? `gold, its edge a circle of ${circle.r.toFixed(1)} (off by ${circle.spread.toFixed(2)}) where a ring is ${S.toFixed(1)}` : 'gold, its edge no circle');
  // (round: no way out to the edge is much longer or shorter than the others - a diamond's are)
  const far = ends.map((p) => Math.hypot(p[0] - circle.x, p[1] - circle.y));
  if (Math.max(...far) - Math.min(...far) > Math.max(1.6, 0.3 * S)) return no(b, x0, y0, `gold, and not round: its edge is from ${Math.min(...far).toFixed(1)} to ${Math.max(...far).toFixed(1)} out`);
  return { x: circle.x, y: circle.y, kind: 'yellow', ring: 'gold', size: S, fit: ends.length / RAYS };
}

/**
 * The yellow dot with the gold ring where the size of a dot is not known: a round of gold edged
 * in black all round, as goldDot looks for - and, since nothing else vouches for it, with a
 * dot's own look inside: out from the middle the bright disc, a darker line, the bright ring.
 * (A coin, a nugget, the glow of a quest's mark are gold and round and have no such line; drawn
 * very small the line does not show either, and the dot is then found only once another has
 * given the size.)
 * @returns { x, y, kind: 'yellow', ring: 'gold', size (as measured: the ring's outer edge), fit } - or null
 */
function goldAlone(b, at, x0, y0) {
  // (how big it is, to begin with: half the box round it - the line between disc and ring is not gold, so its pixels are fewer than a round that size has)
  let R = Math.max(b.w, b.h) / 2;
  if (R < SMALLEST || R > LARGEST * 1.1 || Math.abs(b.w - b.h) > Math.max(2, 0.25 * Math.max(b.w, b.h)) || b.n < 0.5 * Math.PI * R * R) return no(b, x0, y0, `no round of gold (${b.w} by ${b.h}, ${b.n} of it)`);
  let mx = b.x + x0 + (b.w - 1) / 2, my = b.y + y0 + (b.h - 1) / 2, circle = null, count = 0;
  // (twice: the second time from the middle its edge gave, which is truer than the blob's)
  for (let pass = 0; pass < 2; pass++) {
    const ends = [];
    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a);
      let r = 0, end = 0, gap = 0, c = OTHER;
      while (r <= R * 1.5 + 2) {
        r += 0.5; c = at(mx + ux * r, my + uy * r);
        if (c === GOLD || at.lit(mx + ux * r, my + uy * r)) { end = r; gap = 0; continue; }
        if (r < R * 0.8) continue; // (inside, between disc and ring, it is shaded: anything goes)
        if (c === DARK || c === DIM) { c = DARK; break; }
        if (++gap > 3) break; // (the ring's own rim, where it is dim: a pixel or two that are neither gold nor black yet)
      }
      if (c === DARK && end > R * 0.6) ends.push([mx + ux * (end + 0.25), my + uy * (end + 0.25)]);
    }
    if (ends.length < RAYS * 0.9) return no(b, x0, y0, `gold, with black round it on ${ends.length} of ${RAYS} ways out (no size of a dot known)`);
    circle = fitCircle(ends);
    if (!circle || circle.r < SMALLEST || circle.r > LARGEST || circle.spread > Math.max(0.5, circle.r * 0.07)) return no(b, x0, y0, circle ? `gold, its edge no circle (radius ${circle.r.toFixed(1)}, off by ${circle.spread.toFixed(2)})` : 'gold, its edge no circle');
    const far = ends.map((p) => Math.hypot(p[0] - circle.x, p[1] - circle.y));
    if (Math.max(...far) - Math.min(...far) > Math.max(1.6, 0.3 * circle.r)) return no(b, x0, y0, `gold, and not round: its edge is from ${Math.min(...far).toFixed(1)} to ${Math.max(...far).toFixed(1)} out`);
    mx = circle.x; my = circle.y; R = circle.r; count = ends.length;
  }
  // (drawn smaller than this the line inside does not show, and a diamond or a coin would pass)
  if (R < ALONE_LEAST) return no(b, x0, y0, `gold, round, edged in black, and too small to be told by itself (${R.toFixed(1)}; no size of a dot known)`);
  if (at(mx, my) !== GOLD) return no(b, x0, y0, 'gold, round, and its middle is not');
  // The look inside: bright in the disc, a darker line where disc and ring meet, bright again in
  // the ring. The line is drawn shaded - dark on the side away from the light, on the other
  // only a little duller than what it parts: so it has to be there, however faint, on half of
  // the ways out, and plainly on a quarter.
  let lined = 0, plain = 0;
  for (let k = 0; k < RAYS; k++) {
    const a = (k / RAYS) * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a);
    let disc = 0, line = 255, ring = 0;
    for (let r = 0.5; r <= R; r += 0.5) {
      const l = at.lum(mx + ux * r, my + uy * r), f = r / R;
      if (f <= DISC - 0.1) { if (l > disc) disc = l; }
      else if (f >= DISC - 0.06 && f <= RING_IN + 0.08) { if (l < line) line = l; }
      else if (f >= RING_IN + 0.1 && f <= 0.95) { if (l > ring) ring = l; }
    }
    if (line <= 0.9 * Math.min(disc, ring)) lined++;
    if (line <= 0.7 * Math.min(disc, ring)) plain++;
  }
  if (lined < RAYS * 0.5 || plain < RAYS * 0.25) return no(b, x0, y0, `gold, round, edged in black - and a line between a disc and a ring on ${lined} of ${RAYS} ways out, plainly on ${plain} (no size of a dot known)`);
  return { x: mx, y: my, kind: 'yellow', ring: 'gold', size: R, fit: count / RAYS };
}

/**
 * A dot of which only a part shows, the rest lying under a dot already found. Its size is
 * known (every dot is the same size), so each place its middle could be is tried: what shows
 * of the picture there - whatever no dot found accounts for - is held against what a dot there
 * would look like, ring by ring: the disc's colour, the ring's, the black edge. The place
 * where most of it agrees is where the dot is; too little showing, or too little agreeing, and
 * there is none.
 */
function partDot(b, cls, taken, W, H, x0, y0, S) {
  const rDisc = S * DISC, rIn = S * RING_IN, rEdge = S * EDGE;
  const span = Math.ceil(rEdge + 1);
  let best = null;
  for (let cy = b.my - S; cy <= b.my + S; cy += 0.5) for (let cx = b.mx - S; cx <= b.mx + S; cx += 0.5) {
    let fits = 0, not = 0, grey = 0, gold = 0, disc = 0, red = 0, green = 0, blue = 0;
    for (let y = Math.max(0, Math.floor(cy - span)); y <= Math.min(H - 1, Math.ceil(cy + span)); y++) for (let x = Math.max(0, Math.floor(cx - span)); x <= Math.min(W - 1, Math.ceil(cx + span)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > rEdge) continue;
      const i = y * W + x;
      if (taken[i]) continue;
      const c = cls[i];
      if (d <= rDisc - 0.5) { if (c === b.kind || (b.kind === GOLD && (c === RED || c === GREEN || c === BLUE))) { fits++; disc++; if (c === RED) red++; else if (c === GREEN) green++; else if (c === BLUE) blue++; } else if (c !== DARK && c !== DIM) not++; } // (a disc is darker toward its lower edge)
      else if (d <= rIn + 0.4) { /* between disc and ring: shaded, anything goes */ }
      else if (d <= S - 0.4) { if (c === GREY) { fits++; grey++; } else if (c === GOLD) { fits++; gold++; } else not++; }
      else if (d <= S + 0.5) { /* the ring's outer edge: half one, half the other */ }
      else if (c === DARK || c === DIM) fits++; else not++;
    }
    const shows = fits + not;
    if (shows < 8) continue;
    const score = fits - 1.5 * not;
    if (!best || score > best.score) best = { score, fits, not, grey, gold, disc, red, green, blue, cx, cy };
  }
  if (!best) return null;
  const whole = Math.PI * rEdge * rEdge, shows = best.fits + best.not;
  if (shows < 0.12 * whole || best.fits < 0.74 * shows || best.grey + best.gold < 3) return null;
  // (nothing but a stretch of ring to go by: then nearly all of it has to agree, and there has to be a fair stretch)
  if (b.kind === GOLD && Math.max(best.red, best.green, best.blue) < 3 && (best.fits < 0.86 * shows || best.gold < 0.2 * Math.PI * (S * S - rIn * rIn))) return null;
  // (of a gold blob with no disc showing, only the ring is seen: what colour the dot is, is under the other one)
  // (and where a little of its disc does show beside the gold, that is its colour)
  const most = Math.max(best.red, best.green, best.blue);
  const kind = b.kind !== GOLD ? KINDS[b.kind] : most < 3 ? 'hidden' : most === best.red ? 'red' : most === best.green ? 'green' : 'blue';
  return { x: best.cx + x0, y: best.cy + y0, kind, ring: best.gold > best.grey ? 'gold' : 'silver', size: S, fit: best.fits / shows, part: true };
}

/**
 * Where the dots of a picture are in the world.
 * @param dots  what findDots gave
 * @param view  { cx, cy, half (the minimap on the picture), radius (yards from its middle to its edge),
 *                rotation (radians the map is turned clockwise by: the way you face where it turns with you, else 0),
 *                x, y (where you are: yards north and west) }
 * @returns the same dots with x, y in the world (yards north and west), and px, py: where they were on the picture
 */
export function placeDots(dots, view) {
  const k = view.radius / view.half, c = Math.cos(view.rotation), s = Math.sin(view.rotation);
  return dots.map((d) => {
    const dx = d.x - view.cx, dy = d.y - view.cy;
    return { ...d, px: d.x, py: d.y, x: view.x + (dx * s - dy * c) * k, y: view.y - (dx * c + dy * s) * k, far: Math.hypot(dx, dy) * k };
  });
}

/**
 * The dots, followed from picture to picture. Each picture's dots are held against the ones
 * known: the nearest of its kind within reach is the same dot, moved; one with no such
 * neighbour is new. A dot is shown once it has been seen in two pictures (one picture's
 * mistake is never shown), and gone once it has not been seen for a while: sooner where it
 * should be in view and is not, later where it has left the minimap's edge or lies under your
 * arrow, where the picture could not show it anyway.
 */
export class Tracks {
  constructor() { this.list = []; this.next = 1; this.map = null; }

  /**
   * @param placed  the dots of one picture, in the world (placeDots)
   * @param view    { map, x, y, radius (yards the minimap shows from you), at (ms) }
   * @returns what is to be shown: [{ id, kind, ring, x, y, since (ms), seen (ms), part }]
   */
  add(placed, view) {
    if (view.map !== this.map) { this.list = []; this.map = view.map; }
    const now = view.at;
    const free = new Set(placed.map((_, i) => i));
    // (a dot moves as fast as a creature runs, and the place read off the picture is a yard or two out either way)
    const pairs = [];
    for (const t of this.list) {
      const reach = 6 + 14 * Math.min(3, (now - t.seen) / 1000);
      placed.forEach((d, i) => {
        const far = Math.hypot(d.x - t.x, d.y - t.y);
        // (a dot that was half hidden may show whole the next moment, and its colour with it)
        const same = d.kind === t.kind || d.kind === 'hidden' || t.kind === 'hidden';
        if (same && far <= reach) pairs.push([far + (d.kind === t.kind ? 0 : 3) + (d.ring === t.ring ? 0 : 2), t, i]);
      });
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const matched = new Set();
    for (const [, t, i] of pairs) {
      if (matched.has(t) || !free.has(i)) continue;
      matched.add(t); free.delete(i);
      const d = placed[i];
      // (standing still it is the middle of where the pictures put it; moving, where the newest does)
      const far = Math.hypot(d.x - t.x, d.y - t.y), k = far > 2.5 ? 1 : 0.5;
      t.x += (d.x - t.x) * k; t.y += (d.y - t.y) * k;
      if (d.kind !== 'hidden') t.kind = d.kind;
      t.ring = d.ring; t.part = !!d.part; t.seen = now; t.count++;
    }
    for (const i of free) {
      const d = placed[i];
      this.list.push({ id: this.next++, kind: d.kind, ring: d.ring, x: d.x, y: d.y, since: now, seen: now, count: 1, part: !!d.part });
    }
    this.list = this.list.filter((t) => {
      const age = now - t.seen;
      if (age <= 0) return true;
      const far = Math.hypot(t.x - view.x, t.y - view.y);
      // in plain view and not seen: gone (under another dot it may only be hidden: a little longer). Past the edge or under your arrow: kept a while.
      const inView = far < view.radius * 0.92 && far > view.radius * 0.1;
      return age <= (t.count < 2 ? 450 : inView ? 1600 : 6000);
    });
    return this.shown(now);
  }

  shown(now) {
    return this.list.filter((t) => t.count >= 2 && now - t.seen <= 6000).map((t) => ({ id: t.id, kind: t.kind, ring: t.ring, x: t.x, y: t.y, since: t.since, seen: t.seen, part: t.part }));
  }

  clear() { this.list = []; }
}
