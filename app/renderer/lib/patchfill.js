// Patch fill: content-aware fill for the border added by Extend edges. A texture-synthesis fill (PatchMatch, Barnes et al. 2009, with the
// vote-and-repeat reconstruction of Wexler et al. 2007) that copies small patches from the picture itself, so grass, stone, sky and cloth carry on
// instead of repeating a mirror image. Pure maths (no DOM), run in extendedges.worker.js.
//
// The known region is the original picture (a rectangle); everything else is filled. Source patches are only taken from a BAND next to the edge being
// filled (a face in the middle is never copied into the padding). Coarse to fine: the first guess (a mirror/smear fill) is shrunk into a pyramid, every
// level finds for each unknown pixel the best-matching source patch (random start + propagation + random search), then rebuilds the unknown pixels by
// letting every patch covering them vote; the finest level runs at full resolution. Seeded, so the same input always gives the same bytes.
// RGB only (no alpha): the caller refuses images with transparency.

/** Largest result Patch fill accepts, in pixels: the worker needs about 50 bytes per output pixel and a long time. */
export const PATCH_MAX_PIXELS = 36e6;
/** Rough time for one Patch fill (patch 7, 4 passes), in seconds per megapixel of NEW border: measured at 37 s for 3 Mpx on a 2048 px image. Scales with patch size squared and passes. */
export const PATCH_SECONDS_PER_MPX = 12;

export const PATCH_DEFAULTS = { patch: 7, iterations: 4, band: 0.12, seed: 1, knownWeight: 6 };

function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** One pyramid level down: 2x2 averages; a pixel counts as known only if all four it covers are (the known rect shrinks inward, exactly). */
function shrink(L) {
  const W = (L.W + 1) >> 1, H = (L.H + 1) >> 1, img = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x1 = Math.min(L.W - 1, 2 * x + 1), y1 = Math.min(L.H - 1, 2 * y + 1), a = (2 * y * L.W + 2 * x) * 3, b = (2 * y * L.W + x1) * 3, c = (y1 * L.W + 2 * x) * 3, d = (y1 * L.W + x1) * 3, o = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) img[o + k] = (L.img[a + k] + L.img[b + k] + L.img[c + k] + L.img[d + k]) * 0.25;
    }
  }
  const q = L.rect;
  return { W, H, img, rect: { x0: Math.ceil(q.x0 / 2), y0: Math.ceil(q.y0 / 2), x1: Math.floor(q.x1 / 2), y1: Math.floor(q.y1 / 2) } };
}

/**
 * Weighted sum of squared colour differences between the patch around (px,py) and the one around (qx,qy); stops early once it is no better than `best`.
 * `wt` weights each pixel of the target patch (known pixels count more, so the fill stays continuous with the picture).
 */
function dist(img, wt, W, H, px, py, qx, qy, r, best) {
  let d = 0;
  const edge = px < r || py < r || px >= W - r || py >= H - r; // near the canvas edge the target patch is clamped; the source patch is always inside
  for (let dy = -r; dy <= r; dy++) {
    let ay = py + dy; if (edge) ay = ay < 0 ? 0 : ay >= H ? H - 1 : ay;
    const pb = ay * W, qb = (qy + dy) * W + qx;
    for (let dx = -r; dx <= r; dx++) {
      let ax = px + dx; if (edge) ax = ax < 0 ? 0 : ax >= W ? W - 1 : ax;
      const i = pb + ax, a = i * 3, b = (qb + dx) * 3, e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2];
      d += (e0 * e0 + e1 * e1 + e2 * e2) * wt[i];
    }
    if (d >= best) return d;
  }
  return d;
}

/**
 * Fills the unknown part of `init` (straight RGBA, W x H, opaque; the unknown pixels hold a first guess such as a mirror fill).
 * `known` = { x, y, w, h }: the original picture. Returns RGBA with the known rectangle byte-identical.
 * opts: patch (odd, 3..15), iterations (per level), band (0..1, fraction of the picture's short side), seed.
 * onProgress(done, total) is called after every sweep.
 */
export function patchFill(init, W, H, known, opts = {}, onProgress = () => {}) {
  const o = { ...PATCH_DEFAULTS, ...opts };
  const patch = Math.max(3, Math.min(15, Math.round(o.patch) | 1)), r = (patch - 1) >> 1, iters = Math.max(1, Math.round(o.iterations));
  const rand = rng(o.seed);
  const img0 = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { img0[i * 3] = init[i * 4]; img0[i * 3 + 1] = init[i * 4 + 1]; img0[i * 3 + 2] = init[i * 4 + 2]; }
  const levels = [{ W, H, img: img0, rect: { x0: known.x, y0: known.y, x1: known.x + known.w, y1: known.y + known.h } }];
  for (;;) {
    const c = levels[levels.length - 1], q = c.rect;
    const thick = Math.max(q.x0, c.W - q.x1, q.y0, c.H - q.y1), ext = Math.min(q.x1 - q.x0, q.y1 - q.y0);
    if (levels.length >= 8 || thick <= 2 * patch || ext / 2 < 2 * patch + 4) break;
    levels.push(shrink(c));
  }
  const bandPx = Math.max(patch, Math.round(o.band * Math.min(known.w, known.h)));
  // progress is weighted by the work: a sweep costs about 8 votes, and the work at a level is proportional to its unknown pixels (the finest level is most of it)
  const unknownAt = levels.map((L) => L.W * L.H - Math.max(0, L.rect.x1 - L.rect.x0) * Math.max(0, L.rect.y1 - L.rect.y0));
  const SWEEP = 8, VOTE = 1;
  const total = unknownAt.reduce((t, u) => t + u * (iters * (SWEEP + VOTE) + VOTE), 0) + unknownAt[levels.length - 1] * 2 * SWEEP;
  let done = 0, prev = null;

  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li], { W: lw, H: lh, img } = L, q = L.rect;
    const Sx0 = q.x0 + r, Sx1 = q.x1 - 1 - r, Sy0 = q.y0 + r, Sy1 = q.y1 - 1 - r;   // where a source patch may be centred (it must lie wholly inside the known rect)
    if (Sx1 < Sx0 || Sy1 < Sy0) throw new Error('The image is too small for that patch size');
    const band = Math.max(1, Math.round(bandPx / (1 << li)));
    const isKnown = (x, y) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1;
    const maskOf = (x, y) => (y < q.y0 ? 1 : 0) | (y >= q.y1 ? 2 : 0) | (x < q.x0 ? 4 : 0) | (x >= q.x1 ? 8 : 0);
    // the source strips each side may copy from, as [x0, y0, x1, y1] (inclusive), per combination of sides
    const strip = [[Sx0, Sy0, Sx1, Math.min(Sy1, Sy0 + band)], [Sx0, Math.max(Sy0, Sy1 - band), Sx1, Sy1], [Sx0, Sy0, Math.min(Sx1, Sx0 + band), Sy1], [Math.max(Sx0, Sx1 - band), Sy0, Sx1, Sy1]];
    const strips = Array.from({ length: 16 }, (_, m) => strip.filter((_, i) => m & (1 << i)));
    const valid = (qx, qy, m) => qx >= Sx0 && qx <= Sx1 && qy >= Sy0 && qy <= Sy1 &&
      (((m & 1) && qy <= Sy0 + band) || ((m & 2) && qy >= Sy1 - band) || ((m & 4) && qx <= Sx0 + band) || ((m & 8) && qx >= Sx1 - band));
    const pick = (m, out) => { const s = strips[m], t = s[Math.floor(rand() * s.length)]; out[0] = t[0] + Math.floor(rand() * (t[2] - t[0] + 1)); out[1] = t[1] + Math.floor(rand() * (t[3] - t[1] + 1)); };

    // unknown pixels in scan order
    let count = 0;
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) if (!isKnown(x, y)) count++;
    const order = new Int32Array(count);
    for (let y = 0, n = 0; y < lh; y++) for (let x = 0; x < lw; x++) if (!isKnown(x, y)) order[n++] = y * lw + x;

    const wt = new Float32Array(lw * lh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) wt[y * lw + x] = isKnown(x, y) ? o.knownWeight : 1;
    const nx = new Int32Array(lw * lh), ny = new Int32Array(lw * lh), nd = new Float32Array(lw * lh), tmp = [0, 0];
    for (let k = 0; k < count; k++) {
      const i = order[k], x = i % lw, y = (i / lw) | 0, m = maskOf(x, y);
      let qx = -1, qy = -1;
      if (prev) { // start from the coarser level's answer, scaled up
        const cx = Math.min(x >> 1, prev.W - 1), cy = Math.min(y >> 1, prev.H - 1), ci = cy * prev.W + cx;
        qx = prev.nx[ci] * 2 + (x & 1); qy = prev.ny[ci] * 2 + (y & 1);
      }
      if (!valid(qx, qy, m)) { pick(m, tmp); qx = tmp[0]; qy = tmp[1]; }
      nx[i] = qx; ny[i] = qy; nd[i] = dist(img, wt, lw, lh, x, y, qx, qy, r, Infinity);
    }

    const acc = new Float32Array(lw * lh * 3), wsum = new Float32Array(lw * lh);
    /** Every patch centred on an unknown pixel votes, with the matching source patch's colours, for each unknown pixel it covers. */
    const vote = () => {
      for (let k = 0; k < count; k++) { const i = order[k]; wsum[i] = 0; acc[i * 3] = acc[i * 3 + 1] = acc[i * 3 + 2] = 0; }
      for (let k = 0; k < count; k++) {
        const i = order[k], px = i % lw, py = (i / lw) | 0, qx = nx[i], qy = ny[i];
        for (let dy = -r; dy <= r; dy++) {
          const uy = py + dy; if (uy < 0 || uy >= lh) continue;
          for (let dx = -r; dx <= r; dx++) {
            const ux = px + dx; if (ux < 0 || ux >= lw || isKnown(ux, uy)) continue;
            const u = uy * lw + ux, s = ((qy + dy) * lw + qx + dx) * 3;
            acc[u * 3] += img[s]; acc[u * 3 + 1] += img[s + 1]; acc[u * 3 + 2] += img[s + 2]; wsum[u]++;
          }
        }
      }
      for (let k = 0; k < count; k++) { const u = order[k]; if (wsum[u] > 0) { img[u * 3] = acc[u * 3] / wsum[u]; img[u * 3 + 1] = acc[u * 3 + 1] / wsum[u]; img[u * 3 + 2] = acc[u * 3 + 2] / wsum[u]; } }
    };
    /** One PatchMatch pass: each pixel tries its already-visited neighbours' answers (shifted), then random guesses at shrinking distances around its best. */
    const sweep = (forward) => {
      const step = forward ? 1 : -1;
      for (let k = forward ? 0 : count - 1, n = 0; forward ? k < count : k >= 0; k += step, n++) {
        if ((n & 0x7fff) === 0) onProgress(done + n * SWEEP, total);
        const i = order[k], x = i % lw, y = (i / lw) | 0, m = maskOf(x, y);
        let bx = nx[i], by = ny[i], bd = nd[i];
        const xn = x - step;
        if (xn >= 0 && xn < lw && !isKnown(xn, y)) { const j = i - step, cx = nx[j] + step, cy = ny[j]; if (valid(cx, cy, m)) { const d = dist(img, wt, lw, lh, x, y, cx, cy, r, bd); if (d < bd) { bd = d; bx = cx; by = cy; } } }
        const yn = y - step;
        if (yn >= 0 && yn < lh && !isKnown(x, yn)) { const j = i - step * lw, cx = nx[j], cy = ny[j] + step; if (valid(cx, cy, m)) { const d = dist(img, wt, lw, lh, x, y, cx, cy, r, bd); if (d < bd) { bd = d; bx = cx; by = cy; } } }
        for (let R = Math.max(Sx1 - Sx0, Sy1 - Sy0); R >= 1; R >>= 1) {
          const cx = bx + Math.round((rand() * 2 - 1) * R), cy = by + Math.round((rand() * 2 - 1) * R);
          if (!valid(cx, cy, m)) continue;
          const d = dist(img, wt, lw, lh, x, y, cx, cy, r, bd);
          if (d < bd) { bd = d; bx = cx; by = cy; }
        }
        nx[i] = bx; ny[i] = by; nd[i] = bd;
      }
    };

    if (!prev) { // coarsest level: smooth the first guess (a plain edge smear) by diffusion, then find matches against that before the first vote
      for (let pass = 0; pass < 80; pass++) {
        for (let k = pass % 2 ? count - 1 : 0; pass % 2 ? k >= 0 : k < count; k += pass % 2 ? -1 : 1) {
          const i = order[k], x = i % lw, y = (i / lw) | 0, a = (y * lw + Math.max(0, x - 1)) * 3, b = (y * lw + Math.min(lw - 1, x + 1)) * 3, c = (Math.max(0, y - 1) * lw + x) * 3, d = (Math.min(lh - 1, y + 1) * lw + x) * 3;
          for (let ch = 0; ch < 3; ch++) img[i * 3 + ch] = (img[a + ch] + img[b + ch] + img[c + ch] + img[d + ch]) * 0.25;
        }
      }
      for (let k = 0; k < count; k++) { const i = order[k]; nd[i] = dist(img, wt, lw, lh, i % lw, (i / lw) | 0, nx[i], ny[i], r, Infinity); }
      sweep(true); done += count * SWEEP; sweep(false); done += count * SWEEP;
    }
    vote(); done += count * VOTE; onProgress(done, total);
    for (let it = 0; it < iters; it++) { sweep(it % 2 === 0); done += count * SWEEP; vote(); done += count * VOTE; onProgress(done, total); }
    prev = { W: lw, H: lh, nx, ny };
  }

  const L0 = levels[0], out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = L0.img[i * 3]; out[i * 4 + 1] = L0.img[i * 3 + 1]; out[i * 4 + 2] = L0.img[i * 3 + 2]; out[i * 4 + 3] = 255; }
  for (let y = 0; y < known.h; y++) { const s = ((known.y + y) * W + known.x) * 4; out.set(init.subarray(s, s + known.w * 4), s); }
  return out;
}
