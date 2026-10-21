'use strict';
// Tiled inference for same-size (1x) image restoration models, matching what ComfyUI does for "Upscale Image (using Model)" with an ESRGAN-type model:
//   - spandrel pads every call to a multiple of 4 (minimum 4) on the right and bottom: reflect padding up to size - 1, replicate beyond that; the result is
//     cropped back and clamped to 0..1
//   - comfy.utils.tiled_scale: 512 px tiles overlapping by 32; tile starts come from range(0, dim - 32, 480), each clamped to dim - 32, with length
//     min(512, dim - start); every tile edge gets a linear (t + 1) / 32 ramp; the sum is divided by the summed ramps; an image that fits one tile is run directly
// No Electron or onnxruntime dependency here: `runModel(data, w, h)` is injected, so the tiling can be tested with a fake model.

const TILE = 512, OVERLAP = 32, MULTIPLE = 4, MINIMUM = 4;

/** For one axis of length n padded to `total`: which source index each output index reads. Reflect for the first n - 1 pads, then replicate the last value. */
function padMap(n, total) {
  const m = new Int32Array(total);
  const reflect = Math.min(total - n, n - 1);
  for (let i = 0; i < n; i++) m[i] = i;
  for (let i = 0; i < reflect; i++) m[n + i] = n - 2 - i;
  for (let i = reflect; i < total - n; i++) m[n + i] = reflect > 0 ? m[n + reflect - 1] : n - 1;
  return m;
}

/** Pads a planar CHW float tile on the right/bottom the way spandrel does. Returns {data, w, h}. */
function padTile(data, w, h, c = 3) {
  const ceil = (x) => (x % MULTIPLE === 0 ? x : x - (x % MULTIPLE) + MULTIPLE);
  const pw = ceil(Math.max(MINIMUM, w)), ph = ceil(Math.max(MINIMUM, h));
  if (pw === w && ph === h) return { data, w, h };
  const mx = padMap(w, pw), my = padMap(h, ph);
  const out = new Float32Array(c * pw * ph);
  for (let ch = 0; ch < c; ch++) {
    for (let y = 0; y < ph; y++) {
      const row = (ch * h + my[y]) * w;
      for (let x = 0; x < pw; x++) out[(ch * ph + y) * pw + x] = data[row + mx[x]];
    }
  }
  return { data: out, w: pw, h: ph };
}

/** Wraps a raw model call with spandrel's pad / crop / clamp: `runModel(data, w, h)` gets multiple-of-4 planar float input and returns planar float output of the same size. */
function withSpandrelPadding(runModel, c = 3) {
  return async (data, w, h) => {
    const p = padTile(data, w, h, c);
    const out = await runModel(p.data, p.w, p.h);
    const res = new Float32Array(c * w * h);
    for (let ch = 0; ch < c; ch++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = out[(ch * p.h + y) * p.w + x];
          res[(ch * h + y) * w + x] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
      }
    }
    return res;
  };
}

/** Tile origins and lengths along one axis, as comfy.utils.tiled_scale computes them. */
function axisTiles(dim, tile = TILE, overlap = OVERLAP) {
  const starts = dim > tile ? Array.from({ length: Math.ceil((dim - overlap) / (tile - overlap)) }, (_, i) => i * (tile - overlap)) : [0];
  return starts.map((s) => { const pos = Math.max(0, Math.min(dim - overlap, s)); return { pos, len: Math.min(tile, dim - pos) }; });
}

/** Number of model calls for a w x h image (for progress). */
function countTiles(w, h, tile = TILE, overlap = OVERLAP) {
  if (w <= tile && h <= tile) return 1;
  return axisTiles(w, tile, overlap).length * axisTiles(h, tile, overlap).length;
}

/**
 * Runs `callTile(data, w, h)` (planar CHW float in 0..1, same-size output) over the image with feathered overlapping tiles.
 * `src` is planar CHW (3 channels). Returns planar CHW. `onProgress(done, total)` is called after each tile.
 */
async function tiledRun(src, w, h, callTile, { tile = TILE, overlap = OVERLAP, onProgress = () => {} } = {}) {
  const c = 3, total = countTiles(w, h, tile, overlap);
  if (w <= tile && h <= tile) {
    const out = await callTile(src, w, h);
    onProgress(1, 1);
    return out;
  }
  const out = new Float32Array(c * w * h), div = new Float32Array(w * h);
  let done = 0;
  for (const ty of axisTiles(h, tile, overlap)) {
    for (const tx of axisTiles(w, tile, overlap)) {
      const tw = tx.len, th = ty.len;
      const piece = new Float32Array(c * tw * th);
      for (let ch = 0; ch < c; ch++) for (let y = 0; y < th; y++) {
        piece.set(src.subarray((ch * h + ty.pos + y) * w + tx.pos, (ch * h + ty.pos + y) * w + tx.pos + tw), (ch * th + y) * tw);
      }
      const ps = await callTile(piece, tw, th);
      // feather: a linear ramp over `overlap` pixels at both ends of each axis (skipped when the tile is no longer than the ramp)
      const ramp = (len) => { const m = new Float32Array(len).fill(1); if (overlap < len) for (let t = 0; t < overlap; t++) { const a = (t + 1) / overlap; m[t] *= a; m[len - 1 - t] *= a; } return m; };
      const mx = ramp(tw), my = ramp(th);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const m = mx[x] * my[y], o = (ty.pos + y) * w + tx.pos + x;
          div[o] += m;
          for (let ch = 0; ch < c; ch++) out[ch * w * h + o] += ps[(ch * th + y) * tw + x] * m;
        }
      }
      onProgress(++done, total);
    }
  }
  for (let ch = 0; ch < c; ch++) for (let i = 0; i < w * h; i++) out[ch * w * h + i] /= div[i];
  return out;
}

/** Interleaved RGBA bytes -> planar RGB float 0..1. */
function toPlanar(rgba, w, h) {
  const n = w * h, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = rgba[i * 4 + c] / 255;
  return out;
}

/** Cleans an RGBA image (alpha is passed through untouched). `runModel` is the raw network call (multiple-of-4 sizes). Returns new RGBA bytes. */
async function cleanRgba(runModel, rgba, w, h, { onProgress } = {}) {
  const res = await tiledRun(toPlanar(rgba, w, h), w, h, withSpandrelPadding(runModel), { onProgress });
  const n = w * h, out = new Uint8Array(rgba.length);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const v = Math.round(res[c * n + i] * 255); out[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v; }
    out[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return out;
}

module.exports = { TILE, OVERLAP, padTile, withSpandrelPadding, axisTiles, countTiles, tiledRun, toPlanar, cleanRgba };
