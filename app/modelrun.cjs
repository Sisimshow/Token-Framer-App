'use strict';
// Tiled inference for image restoration / upscaling models (1x cleanup or Nx upscale), matching what ComfyUI does for "Upscale Image (using Model)":
//   - spandrel pads every call to the model's size rules (a multiple of N, a minimum size) on the right and bottom: reflect padding up to size - 1, replicate
//     beyond that; the output is cropped back to size * scale and clamped to 0..1
//   - comfy.utils.tiled_scale: 512 px tiles overlapping by 32; tile starts come from range(0, dim - 32, 480), each clamped to dim - 32, with length
//     min(512, dim - start); every output tile edge gets a linear (t + 1) / feather ramp (feather = 32 * scale); the sum is divided by the summed ramps;
//     an image that fits one tile is run directly
// No Electron or onnxruntime dependency here: `runModel(data, w, h)` is injected, so the tiling can be tested with a fake model.

const TILE = 512, OVERLAP = 32;

/** For one axis of length n padded to `total`: which source index each output index reads. Reflect for the first n - 1 pads, then replicate the last value. */
function padMap(n, total) {
  const m = new Int32Array(total);
  const reflect = Math.min(total - n, n - 1);
  for (let i = 0; i < n; i++) m[i] = i;
  for (let i = 0; i < reflect; i++) m[n + i] = n - 2 - i;
  for (let i = reflect; i < total - n; i++) m[n + i] = reflect > 0 ? m[n + reflect - 1] : n - 1;
  return m;
}

/** Pads a planar CHW float tile on the right/bottom the way spandrel does for a model that needs sizes of `multiple` and at least `minimum`. Returns {data, w, h}. */
function padTile(data, w, h, c = 3, multiple = 4, minimum = 4) {
  const ceil = (x) => (x % multiple === 0 ? x : x - (x % multiple) + multiple);
  const pw = ceil(Math.max(minimum, w)), ph = ceil(Math.max(minimum, h));
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

/**
 * Wraps a raw model call with spandrel's pad / crop / clamp: `runModel(data, w, h)` gets planar float input of a size that meets the model's rules and returns
 * planar float output of (w * scale) x (h * scale). The wrapper's result is the cropped, clamped output for the unpadded input size.
 */
function withSpandrelPadding(runModel, { c = 3, scale = 1, multiple = 4, minimum = 4 } = {}) {
  return async (data, w, h) => {
    const p = padTile(data, w, h, c, multiple, minimum);
    const out = await runModel(p.data, p.w, p.h);
    const ow = w * scale, oh = h * scale, pow = p.w * scale, poh = p.h * scale;
    if (out.length !== c * pow * poh) throw new Error(`The model returned ${out.length} values but a ${scale}x model should return ${c * pow * poh} for this tile. Its .json description file is probably missing or wrong (rerun tools/convert-model.py).`);
    const res = new Float32Array(c * ow * oh);
    for (let ch = 0; ch < c; ch++) {
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          const v = out[(ch * poh + y) * pow + x];
          res[(ch * oh + y) * ow + x] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
      }
    }
    return res;
  };
}

/** Tile origins and lengths along one axis (input pixels), as comfy.utils.tiled_scale computes them. */
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
 * Runs `callTile(data, w, h)` (planar CHW float in 0..1, output (w * scale) x (h * scale)) over the image with feathered overlapping tiles.
 * `src` is planar CHW (3 channels). Returns planar CHW of (w * scale) x (h * scale). `onProgress(done, total)` is called after each tile.
 */
async function tiledRun(src, w, h, callTile, { tile = TILE, overlap = OVERLAP, scale = 1, onProgress = () => {} } = {}) {
  const c = 3, total = countTiles(w, h, tile, overlap);
  if (w <= tile && h <= tile) {
    const out = await callTile(src, w, h);
    onProgress(1, 1);
    return out;
  }
  const ow = w * scale, oh = h * scale;
  const out = new Float32Array(c * ow * oh), div = new Float32Array(ow * oh);
  const feather = Math.round(overlap * scale);
  let done = 0;
  for (const ty of axisTiles(h, tile, overlap)) {
    for (const tx of axisTiles(w, tile, overlap)) {
      const tw = tx.len, th = ty.len;
      const piece = new Float32Array(c * tw * th);
      for (let ch = 0; ch < c; ch++) for (let y = 0; y < th; y++) {
        piece.set(src.subarray((ch * h + ty.pos + y) * w + tx.pos, (ch * h + ty.pos + y) * w + tx.pos + tw), (ch * th + y) * tw);
      }
      const ps = await callTile(piece, tw, th);
      const pw = tw * scale, ph = th * scale;
      // feather: a linear ramp over `feather` output pixels at both ends of each axis (skipped when the tile is no longer than the ramp)
      const ramp = (len) => { const m = new Float32Array(len).fill(1); if (feather < len) for (let t = 0; t < feather; t++) { const a = (t + 1) / feather; m[t] *= a; m[len - 1 - t] *= a; } return m; };
      const mx = ramp(pw), my = ramp(ph);
      const ox = tx.pos * scale, oy = ty.pos * scale;
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const m = mx[x] * my[y], o = (oy + y) * ow + ox + x;
          div[o] += m;
          for (let ch = 0; ch < c; ch++) out[ch * ow * oh + o] += ps[(ch * ph + y) * pw + x] * m;
        }
      }
      onProgress(++done, total);
    }
  }
  for (let ch = 0; ch < c; ch++) for (let i = 0; i < ow * oh; i++) out[ch * ow * oh + i] /= div[i];
  return out;
}

/** Interleaved RGBA bytes -> planar RGB float 0..1. */
function toPlanar(rgba, w, h) {
  const n = w * h, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = rgba[i * 4 + c] / 255;
  return out;
}

/**
 * Cleans (scale 1) or upscales (scale > 1) an RGBA image. `runModel` is the raw network call; `opts` carries the model's rules ({scale, multiple, minimum})
 * and optionally `tile` and `onProgress`. A 1x model passes the alpha channel through; an upscaler needs an opaque image (the model sees RGB only and the alpha
 * would have to be resized separately), so it rejects anything with transparency. Returns {rgba, w, h} (w, h already multiplied by the scale).
 */
async function processRgba(runModel, rgba, w, h, { scale = 1, multiple = 4, minimum = 4, tile = TILE, onProgress } = {}) {
  if (scale > 1) for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) throw new Error('Upscaling needs an opaque image (the model works on RGB only).');
  const res = await tiledRun(toPlanar(rgba, w, h), w, h, withSpandrelPadding(runModel, { scale, multiple, minimum }), { tile, scale, onProgress });
  const ow = w * scale, oh = h * scale, n = ow * oh, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const v = Math.round(res[c * n + i] * 255); out[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v; }
    out[i * 4 + 3] = scale === 1 ? rgba[i * 4 + 3] : 255;
  }
  return { rgba: out, w: ow, h: oh };
}

/** 1x convenience wrapper kept for callers that only want the bytes back. */
async function cleanRgba(runModel, rgba, w, h, opts = {}) {
  return (await processRgba(runModel, rgba, w, h, { scale: 1, ...opts })).rgba;
}

module.exports = { TILE, OVERLAP, padTile, withSpandrelPadding, axisTiles, countTiles, tiledRun, toPlanar, processRgba, cleanRgba };
