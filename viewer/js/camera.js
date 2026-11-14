// Camera + input. Two ways to move, both always active:
//   Map-style: drag to pan, right-drag (or Alt-drag) to orbit, wheel to zoom toward the cursor.
//   Fly-style: WASD / arrows to move, Q/E turn, R/F or Space/C up/down, Shift = fast; press G (or the
//              Fly button) to capture the mouse for free-look.
// While the camera follows your character (player.js) it is tied to them: see `lock` below.
import { basis, rayDir, clamp, DEG } from './math.js';

const TIED_MAX_PITCH = -5; // tied to your character, the view never comes down to level with the ground

export class Camera {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.pos = [0, 0, 1000];
    this.heading = 0;   // compass degrees: 0 north, 90 east
    this.pitch = -55;   // degrees, negative looks down
    this.fov = 55;
    this.near = 1;
    this.keys = new Set();
    this.scene = null;
    this.anim = null;
    this.flyLook = false;
    this.speedScale = 1;
    this.drag = null;
    this.mouse = null; // last cursor position in CSS pixels
    // Set while your character is under the terrain (a city inside a mountain, a cave): { x, y, z, r }.
    // Within r yards of that spot the level you stand on, not the mountain over it, is what the cursor
    // points at and what the camera may not go under: so you can zoom right in to yourself.
    this.under = null;
    // (x, y, z) => true where the ground is not drawn just now: the cutaway's hole through a hill
    // that was between the camera and your character. The cursor points through it.
    this.gone = null;
    // Bumped whenever the camera is moved by anything other than the mouse drag in progress
    // (keys, wheel, fly-to). A drag compares it to know its grab point has gone stale.
    this.rev = 0;
    // Set while the camera follows your character (player.js): { point: [x, y, z] }. The view is
    // then tied to that point. A right-drag swings it around the point, the wheel zooms towards
    // the point, Q and E turn about it. Whatever would take the view off the point (a left-drag,
    // the movement keys, flying, being sent to look at something else) lets go of it first:
    // onLetGo is called, and the following ends.
    this.lock = null;
    this.onLetGo = null;
    this.touched = 0;    // goes up whenever you turn or zoom the view yourself while it is tied
    this.zoomedAt = -1e9; // when you last zoomed it yourself while it was tied (performance.now())
    this.#bind();
  }

  #letGo() {
    if (!this.lock) return;
    this.lock = null;
    this.onLetGo?.();
  }

  get aspect() { return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight); }
  basis() { return basis(this.heading, this.pitch); }

  /** Ray through a canvas position (CSS pixels). */
  ray(px, py) {
    const ndcX = (px / this.canvas.clientWidth) * 2 - 1, ndcY = 1 - (py / this.canvas.clientHeight) * 2;
    return rayDir(this.basis(), this.fov, this.aspect, ndcX, ndcY);
  }

  /** The level you are on underground, if a spot (where the camera is, unless said) is in its reach, else null. */
  #level(x = this.pos[0], y = this.pos[1]) {
    const u = this.under;
    return u && Math.hypot(x - u.x, y - u.y) <= u.r * 1.5 ? u : null;
  }

  /** The lowest the camera may be over a spot (null: no ground there to mind). */
  #floor(x, y) {
    const u = this.#level(x, y);
    if (u) return u.z + 1.5; // (under the terrain with you: the floor you are on is the ground)
    const h = this.scene?.heightAt(x, y);
    return h === null || h === undefined ? null : h + 3;
  }

  pickAt(px, py) {
    if (!this.scene) return null;
    const dir = this.ray(px, py), u = this.#level();
    if (u && Math.abs(dir[2]) > 0.02) {
      // where the cursor's ray crosses the level you are on (under the terrain it would otherwise stop at)
      const t = (u.z - this.pos[2]) / dir[2];
      if (t > 0) {
        const p = [this.pos[0] + dir[0] * t, this.pos[1] + dir[1] * t, u.z];
        if (Math.hypot(p[0] - u.x, p[1] - u.y) <= u.r) return p;
      }
    }
    return this.scene.pick(this.pos, dir, undefined, this.gone);
  }

  /** Height above the terrain directly below (used to scale movement speed). */
  clearance() {
    const u = this.#level();
    if (u) return Math.max(1, this.pos[2] - u.z);
    const h = this.scene?.heightAt(this.pos[0], this.pos[1]);
    const ground = Math.max(h ?? -Infinity, this.scene?.map.ocean ? this.scene.map.seaLevel : -Infinity);
    return Number.isFinite(ground) ? this.pos[2] - ground : this.pos[2];
  }

  #keepAboveGround() {
    const floor = this.#floor(this.pos[0], this.pos[1]);
    if (floor !== null && this.pos[2] < floor) this.pos[2] = floor;
    this.pitch = clamp(this.pitch, -89.5, 60);
    this.heading = ((this.heading % 360) + 360) % 360;
  }

  /**
   * @param tied  the flight is part of following your character (it ends at them); any other
   *              flight takes the view elsewhere, and lets go of them
   */
  flyTo(target, seconds = 1.1, tied = false) {
    if (!tied) this.#letGo();
    const from = { pos: [...this.pos], heading: this.heading, pitch: this.pitch };
    let dh = ((target.heading ?? this.heading) - from.heading + 540) % 360 - 180;
    this.anim = { from, to: { pos: target.pos, heading: from.heading + dh, pitch: target.pitch ?? this.pitch }, t: 0, seconds, tied };
    this.onChange();
  }

  /** Look at a ground point from a given distance. (tied: see flyTo) */
  lookAt(point, distance, heading = this.heading, pitch = -50, animate = true, tied = false) {
    if (!tied) this.#letGo();
    const b = basis(heading, pitch);
    const pos = [point[0] - b.f[0] * distance, point[1] - b.f[1] * distance, point[2] - b.f[2] * distance];
    if (animate) this.flyTo({ pos, heading, pitch }, 1.1, tied);
    else { this.pos = pos; this.heading = heading; this.pitch = pitch; this.anim = null; this.rev++; this.onChange(); }
  }

  /**
   * Put the camera `dist` yards from a point, looking at it along a heading and pitch: the
   * following camera, every frame (player.js). Where the ground is in the way the camera rides
   * over it, still looking at the point. True if that moved anything.
   */
  place(point, heading, pitch, dist) {
    const b = basis(heading, pitch);
    const pos = [point[0] - b.f[0] * dist, point[1] - b.f[1] * dist, point[2] - b.f[2] * dist];
    const floor = this.#floor(pos[0], pos[1]);
    if (floor !== null && pos[2] < floor) {
      pos[2] = floor;
      pitch = clamp(Math.atan2(point[2] - pos[2], Math.hypot(point[0] - pos[0], point[1] - pos[1])) / DEG, -89.5, 60);
    }
    heading = ((heading % 360) + 360) % 360;
    const turn = Math.abs(((heading - this.heading + 540) % 360) - 180);
    if (turn < 1e-3 && Math.abs(pitch - this.pitch) < 1e-3 && Math.abs(pos[0] - this.pos[0]) < 1e-3 && Math.abs(pos[1] - this.pos[1]) < 1e-3 && Math.abs(pos[2] - this.pos[2]) < 1e-3) return false;
    this.pos = pos; this.heading = heading; this.pitch = pitch;
    this.rev++;
    return true;
  }

  /**
   * The same view, in coordinates moved over by (dx, dy): for when the map beside the one in
   * hand is taken in hand instead (main.js), and everything is counted from its origin.
   */
  shift(dx, dy) {
    this.pos[0] += dx; this.pos[1] += dy;
    if (this.anim) for (const p of [this.anim.from.pos, this.anim.to.pos]) { p[0] += dx; p[1] += dy; }
    if (this.drag?.pivot) { this.drag.pivot[0] += dx; this.drag.pivot[1] += dy; }
    this.under = null;
    this.lock = null; // (tied again, if you are being followed, as soon as you are found on the map now in hand)
  }

  /** Advance animation + keyboard motion. Returns true while the view is still changing. */
  update(dt) {
    let moving = false;
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.seconds);
      const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
      for (let i = 0; i < 3; i++) this.pos[i] = a.from.pos[i] + (a.to.pos[i] - a.from.pos[i]) * e;
      this.heading = a.from.heading + (a.to.heading - a.from.heading) * e;
      this.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * e;
      if (a.t >= 1) this.anim = null;
      moving = true;
    }
    const k = this.keys;
    const ax = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ay = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const az = (k.has('KeyR') || k.has('Space') ? 1 : 0) - (k.has('KeyF') || k.has('KeyC') ? 1 : 0);
    const turn = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (ax || ay || az || turn) {
      // (moving the view off your character ends the following; turning does not)
      if (ax || ay || az) this.#letGo();
      this.anim = null;
      if (this.lock) {
        // tied to your character: Q and E swing the view around them
        this.#orbit(this.lock.point, turn * 70 * dt, 0, TIED_MAX_PITCH);
        this.touched++;
      } else {
        const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
        // Speed scales with height above ground, like a map: slow near the surface, fast up high.
        const speed = clamp(this.clearance() * 0.9, 12, 12000) * fast * this.speedScale;
        const b = this.basis();
        let fwd;
        if (this.flyLook) fwd = b.f;
        else { const h = this.heading * DEG; fwd = [Math.cos(h), -Math.sin(h), 0]; }
        for (let i = 0; i < 3; i++) this.pos[i] += (fwd[i] * ay + b.r[i] * ax) * speed * dt;
        this.pos[2] += az * speed * dt;
        this.heading += turn * 70 * dt;
      }
      moving = true;
    }
    if (moving) { this.#keepAboveGround(); this.rev++; }
    return moving;
  }

  /** True while a movement key is held. */
  #steering() {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyR', 'KeyF', 'Space', 'KeyC']) if (this.keys.has(code)) return true;
    return false;
  }

  #bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (this.flyLook) return;
      c.setPointerCapture(e.pointerId);
      c.focus();
      this.anim = null;
      const orbit = e.button === 2 || e.button === 1 || e.altKey || e.ctrlKey;
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const hit = this.pickAt(px, py) ?? this.pickAt(c.clientWidth / 2, c.clientHeight / 2);
      this.drag = { orbit, x: e.clientX, y: e.clientY, pivot: hit, rev: this.rev, moved: false, travel: 0 };
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      this.mouse = [e.clientX - rect.left, e.clientY - rect.top];
      if (this.flyLook) {
        this.heading += e.movementX * 0.12;
        this.pitch -= e.movementY * 0.12;
        this.#keepAboveGround();
        this.onChange();
        return;
      }
      const d = this.drag;
      if (!d) { this.onHover?.(); return; }
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
      if (this.lock) {
        if (d.orbit) {
          // tied to your character: the view swings around them, wherever the cursor is
          this.#orbit(this.lock.point, dx * 0.25, dy * 0.25, TIED_MAX_PITCH);
          this.touched++;
          this.#keepAboveGround();
          this.onChange();
          return;
        }
        // Moving the map from under your character ends the following - once it is clearly a
        // drag and not a click that slipped.
        d.travel += Math.abs(dx) + Math.abs(dy);
        if (d.travel < 5) return;
        this.#letGo();
        d.pivot = this.pickAt(this.mouse[0], this.mouse[1]) ?? d.pivot;
        d.rev = this.rev;
      }
      // If the camera was moved by the keys / wheel since this drag grabbed its point, that point
      // is stale (rotating around it would swing the view wildly): grab what is under the cursor now.
      const stale = d.rev !== this.rev;
      if (stale) {
        d.pivot = this.pickAt(this.mouse[0], this.mouse[1]) ?? this.pickAt(c.clientWidth / 2, c.clientHeight / 2);
        d.rev = this.rev;
      }
      if (d.orbit) {
        // While flying with the movement keys, right-drag steers (turns in place) like in game;
        // otherwise it orbits around the grabbed point.
        if (this.#steering()) { this.heading += dx * 0.25; this.pitch -= dy * 0.25; }
        else this.#orbit(d.pivot, dx * 0.25, dy * 0.25);
      } else if (!stale) this.#pan(d, this.mouse[0], this.mouse[1]);
      this.#keepAboveGround();
      this.onChange();
    });
    const end = (e) => {
      if (this.drag && !this.drag.moved && e.type === 'pointerup') this.onClick?.(this.drag.pivot, e);
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.anim = null;
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const step = clamp(e.deltaY * (e.deltaMode === 1 ? 33 : 1), -400, 400);
      this.rev++;
      if (this.flyLook) { this.speedScale = clamp(this.speedScale * Math.exp(-step * 0.0015), 0.05, 20); return; }
      const k = Math.exp(step * 0.0016);
      if (this.lock) {
        // tied to your character: nearer to them or further away, the same way round
        const p = this.lock.point, dist = Math.max(1e-3, Math.hypot(this.pos[0] - p[0], this.pos[1] - p[1], this.pos[2] - p[2]));
        const f = clamp(dist * k, 6, 60000) / dist;
        for (let i = 0; i < 3; i++) this.pos[i] = p[i] + (this.pos[i] - p[i]) * f;
        this.touched++;
        this.zoomedAt = performance.now();
        this.#keepAboveGround();
        this.onChange();
        return;
      }
      const hit = this.pickAt(px, py);
      if (hit) {
        // Zoom toward the point under the cursor, never through the ground.
        const dist = Math.hypot(hit[0] - this.pos[0], hit[1] - this.pos[1], hit[2] - this.pos[2]);
        const nd = Math.max(8, dist * k);
        const f = nd / dist;
        for (let i = 0; i < 3; i++) this.pos[i] = hit[i] + (this.pos[i] - hit[i]) * f;
      } else {
        const dir = this.ray(px, py);
        const amount = (1 - k) * Math.max(200, this.clearance());
        for (let i = 0; i < 3; i++) this.pos[i] += dir[i] * amount;
      }
      this.#keepAboveGround();
      this.onChange();
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const hit = this.pickAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;
      const dist = Math.hypot(hit[0] - this.pos[0], hit[1] - this.pos[1], hit[2] - this.pos[2]);
      this.lookAt(hit, Math.max(60, dist * 0.4), this.heading, this.pitch);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'KeyG') { this.toggleFly(); return; }
      if (e.code === 'KeyN') { this.#north(); return; }
      if (e.code === 'KeyT') { this.#topDown(); return; }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.onChange();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.flyLook = document.pointerLockElement === c;
      this.onModeChange?.(this.flyLook);
      this.onChange();
    });
  }

  /** Rotate the view around a world point (used when the camera turns with the player). */
  orbit(pivot, dYaw, dPitch) {
    this.#orbit(pivot, dYaw, dPitch);
    this.#keepAboveGround();
    this.rev++;
  }

  toggleFly() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    else { this.#letGo(); this.canvas.requestPointerLock?.(); }
  }

  /** Turn to face north: in place, or around your character while tied to them. */
  #north() {
    const p = this.lock?.point;
    if (!p) { this.flyTo({ pos: [...this.pos], heading: 0, pitch: this.pitch }, 0.5); return; }
    this.lookAt(p, Math.hypot(p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]), 0, this.pitch, true, true);
    this.touched++;
  }

  #topDown() {
    const tied = !!this.lock;
    const center = tied ? this.lock.point : this.pickAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    if (!center) return;
    const dist = Math.hypot(center[0] - this.pos[0], center[1] - this.pos[1], center[2] - this.pos[2]);
    this.lookAt(center, dist, tied ? this.heading : 0, this.pitch < -80 ? -50 : -89.5, true, tied);
    if (tied) this.touched++;
  }

  /** Keep the grabbed ground point under the cursor. */
  #pan(d, px, py) {
    if (!d.pivot) return;
    const dir = this.ray(px, py);
    if (dir[2] > -0.02) return; // cursor above the horizon
    const t = (d.pivot[2] - this.pos[2]) / dir[2];
    const lim = Math.max(2000, this.clearance() * 20);
    if (t <= 0 || t > lim * 50) return;
    const qx = this.pos[0] + dir[0] * t, qy = this.pos[1] + dir[1] * t;
    this.pos[0] += d.pivot[0] - qx;
    this.pos[1] += d.pivot[1] - qy;
  }

  /** Rotate around a ground pivot: yaw about the vertical axis, pitch about the camera's right axis. */
  #orbit(pivot, dYaw, dPitch, maxPitch = 30) {
    const newPitch = clamp(this.pitch - dPitch, -89.5, Math.max(maxPitch, this.pitch));
    const applied = newPitch - this.pitch;
    if (!pivot) { this.heading += dYaw; this.pitch = newPitch; return; }
    let v = [this.pos[0] - pivot[0], this.pos[1] - pivot[1], this.pos[2] - pivot[2]];
    // pitch: rotate offset about the right axis
    const b = this.basis();
    v = rotate(v, b.r, applied * DEG);
    // yaw: compass heading increases clockwise seen from above = negative rotation about +Z
    v = rotate(v, [0, 0, 1], -dYaw * DEG);
    this.pos = [pivot[0] + v[0], pivot[1] + v[1], pivot[2] + v[2]];
    this.heading += dYaw;
    this.pitch = newPitch;
  }
}

function rotate(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const cx = axis[1] * v[2] - axis[2] * v[1], cy = axis[2] * v[0] - axis[0] * v[2], cz = axis[0] * v[1] - axis[1] * v[0];
  return [v[0] * c + cx * s + axis[0] * d * (1 - c), v[1] * c + cy * s + axis[1] * d * (1 - c), v[2] * c + cz * s + axis[2] * d * (1 - c)];
}
