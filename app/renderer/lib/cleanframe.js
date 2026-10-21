// Frame cleanup, ported from the author's ComfyUI "Token Cleaner" workflow (RefineAlphaSingle -> FastAlphaCropper -> ImageScale).
// Pure functions, no DOM, so they run in a worker and can be unit-tested from the harness. Straight (non-premultiplied) RGBA bytes in and out.
//
//   1. refineAlpha: colour guided filter (He et al. 2010) of the alpha channel, guide = the image over a flat black/white fill
//   2. shapeAlpha: alpha below `floor` -> 0, `solidify` passes of a = 1-(1-a)^2, alpha above `ceiling` -> 1 (in that order)
//   3. bleedColor: colour under transparent/soft pixels is extended outward from the opaque ones
//   4. cropBox: bounding box of alpha > threshold, plus padding (clamped to the image)
//   5. resize: fit + pad to a square (or stretch / none); the export uses a Pillow-exact Lanczos3 so results match the ComfyUI output
// Not ported on purpose: the node's "decontaminate" option (the workflow hard-codes it off).

export const DEFAULTS = { radius: 3, smoothing: 0.001, floor: 0.01, ceiling: 0.98, solidify: 2, threshold: 0.05, padding: 0, resize: 'fit', size: 1000 };

// ---------------------------------------------------------------- box filter
/** Mean over a (2r+1)^2 window, clipped (not padded) at the borders and divided by the real count; running sums in float64. r <= 0 returns `src` itself. */
export function boxMean(src, w, h, r, out = new Float32Array(w * h), tmp = new Float32Array(w * h)) {
  if (r <= 0) return src;
  for (let y = 0; y < h; y++) { // rows
    const o = y * w;
    let s = 0;
    for (let k = 0; k <= Math.min(w - 1, r); k++) s += src[o + k];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
      if (x + r + 1 < w) s += src[o + x + r + 1];
      if (x - r >= 0) s -= src[o + x - r];
    }
  }
  const col = new Float64Array(w); // columns: whole rows added and removed at a time
  for (let y = 0; y <= Math.min(h - 1, r); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    const n = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = col[x] / n;
    if (y + r + 1 < h) { const a = (y + r + 1) * w; for (let x = 0; x < w; x++) col[x] += tmp[a + x]; }
    if (y - r >= 0) { const a = (y - r) * w; for (let x = 0; x < w; x++) col[x] -= tmp[a + x]; }
  }
  return out;
}

// ---------------------------------------------------------------- guided filter
/** Guided filter of p by the 3-channel guide I (planes), window radius r, regulariser eps (used as is). Returns q clamped to 0..1. */
function guidedFilter(I0, I1, I2, p, w, h, r, eps) {
  const n = w * h;
  const tmp = new Float32Array(n), prod = new Float32Array(n);
  const box = (src) => boxMean(src, w, h, r, new Float32Array(n), tmp);
  const mul = (a, b) => { for (let i = 0; i < n; i++) prod[i] = a[i] * b[i]; return prod; };
  const m0 = box(I0), m1 = box(I1), m2 = box(I2), mp = box(p);
  const c0 = box(mul(I0, p)), c1 = box(mul(I1, p)), c2 = box(mul(I2, p));
  const v00 = box(mul(I0, I0)), v01 = box(mul(I0, I1)), v02 = box(mul(I0, I2));
  const v11 = box(mul(I1, I1)), v12 = box(mul(I1, I2)), v22 = box(mul(I2, I2));
  const a0 = new Float32Array(n), a1 = new Float32Array(n), a2 = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x0 = m0[i], x1 = m1[i], x2 = m2[i], xp = mp[i];
    const A = v00[i] - x0 * x0 + eps, B = v01[i] - x0 * x1, C = v02[i] - x0 * x2;
    const D = v11[i] - x1 * x1 + eps, E = v12[i] - x1 * x2, F = v22[i] - x2 * x2 + eps;
    const r0 = c0[i] - x0 * xp, r1 = c1[i] - x1 * xp, r2 = c2[i] - x2 * xp;
    const i00 = D * F - E * E, i01 = C * E - B * F, i02 = B * E - C * D;
    const i11 = A * F - C * C, i12 = B * C - A * E, i22 = A * D - B * B;
    const det = A * i00 + B * i01 + C * i02;
    const s0 = (i00 * r0 + i01 * r1 + i02 * r2) / det;
    const s1 = (i01 * r0 + i11 * r1 + i12 * r2) / det;
    const s2 = (i02 * r0 + i12 * r1 + i22 * r2) / det;
    a0[i] = s0; a1[i] = s1; a2[i] = s2;
    b[i] = xp - s0 * x0 - s1 * x1 - s2 * x2;
  }
  const q = new Float32Array(n);
  const ba0 = box(a0), ba1 = box(a1), ba2 = box(a2), bb = box(b);
  for (let i = 0; i < n; i++) {
    const v = ba0[i] * I0[i] + ba1[i] * I1[i] + ba2[i] * I2[i] + bb[i];
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

/** alpha0 plane (A / 255) of straight RGBA bytes. */
export function alphaPlane(rgba, w, h) {
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3] / 255;
  return a;
}

/**
 * Refined alpha (before floor / solidify / ceiling). The guide is the colour image over a flat fill: white behind a dark subject, black behind
 * a light one (decided once from the alpha-weighted mean brightness). Processed in horizontal bands with a 2r halo so memory stays small on big
 * images; the result is identical to filtering the whole image at once.
 */
export function refineAlpha(rgba, w, h, { radius = DEFAULTS.radius, smoothing = DEFAULTS.smoothing, band = 192 } = {}) {
  const alpha0 = alphaPlane(rgba, w, h);
  if (radius <= 0) return alpha0;
  let num = 0, den = 0;
  for (let i = 0; i < alpha0.length; i++) {
    const a = alpha0[i];
    num += a * ((rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 765);
    den += a;
  }
  const fill = num / Math.max(den, 1e-5) < 0.5 ? 1 : 0;
  const out = new Float32Array(w * h);
  const halo = 2 * radius;
  for (let y0 = 0; y0 < h; y0 += band) {
    const y1 = Math.min(h, y0 + band);
    const ys = Math.max(0, y0 - halo), ye = Math.min(h, y1 + halo), bh = ye - ys, n = w * bh;
    const I0 = new Float32Array(n), I1 = new Float32Array(n), I2 = new Float32Array(n), p = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = ys * w + i, a = alpha0[g], f = (1 - a) * fill;
      I0[i] = a * (rgba[g * 4] / 255) + f;
      I1[i] = a * (rgba[g * 4 + 1] / 255) + f;
      I2[i] = a * (rgba[g * 4 + 2] / 255) + f;
      p[i] = a;
    }
    const q = guidedFilter(I0, I1, I2, p, w, bh, radius, smoothing);
    out.set(q.subarray((y0 - ys) * w, (y1 - ys) * w), y0 * w);
  }
  return out;
}

/** floor -> solidify -> ceiling, all strict comparisons, as in the node. */
export function shapeAlpha(q, { floor = DEFAULTS.floor, solidify = DEFAULTS.solidify, ceiling = DEFAULTS.ceiling } = {}) {
  const out = new Float32Array(q.length);
  const lo = Math.fround(floor), hi = Math.fround(ceiling); // torch compares a float32 tensor with the threshold in float32
  for (let i = 0; i < q.length; i++) {
    let a = q[i];
    if (a < lo) a = 0;
    for (let s = 0; s < solidify; s++) a = Math.fround(1 - (1 - a) * (1 - a));
    if (a > hi) a = 1;
    out[i] = a;
  }
  return out;
}

// ---------------------------------------------------------------- colour
/**
 * Straight colour for the output: pixels with alpha >= 0.1 keep their own colour; below that the colour is blended toward an estimate that is
 * grown outward from the opaque pixels in three box-filter passes (radii R, 3R, 9R with R = 2 * max(radius, 1)). Returns three Float32 planes.
 */
export function bleedColor(rgba, w, h, radius = DEFAULTS.radius) {
  const n = w * h, R = Math.max(radius, 1) * 2;
  const alpha0 = alphaPlane(rgba, w, h);
  const rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) rgb[c][i] = rgba[i * 4 + c] / 255;
  const fg = rgb.map((p) => Float32Array.from(p));
  const known = Float32Array.from(alpha0);
  const tmp = new Float32Array(n), wgt = new Float32Array(n), prod = new Float32Array(n), est = new Float32Array(n);
  for (const rad of [R, 3 * R, 9 * R]) {
    boxMean(known, w, h, rad, wgt, tmp);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) prod[i] = fg[c][i] * known[i];
      boxMean(prod, w, h, rad, est, tmp);
      for (let i = 0; i < n; i++) fg[c][i] = known[i] * fg[c][i] + (1 - known[i]) * (est[i] / Math.max(wgt[i], 1e-5));
    }
    for (let i = 0; i < n; i++) known[i] = Math.max(known[i], wgt[i] > 1e-3 ? 1 : 0);
  }
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, 10 * alpha0[i]));
    for (let c = 0; c < 3; c++) fg[c][i] = t * rgb[c][i] + (1 - t) * fg[c][i];
  }
  return fg;
}

// ---------------------------------------------------------------- crop + assemble
/** Bounding box [x0, x1) x [y0, y1) of alpha > threshold, grown by padding and clamped to the image; the whole image if nothing passes. */
export function cropBox(alpha, w, h, threshold = DEFAULTS.threshold, padding = DEFAULTS.padding) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: w, y1: h, found: false };
  return { x0: Math.max(0, x0 - padding), y0: Math.max(0, y0 - padding), x1: Math.min(w, x1 + 1 + padding), y1: Math.min(h, y1 + 1 + padding), found: true };
}

/** Straight RGBA bytes of the cropped region. Floats are truncated with floor(255 * v), like the ComfyUI save path. */
export function assemble(color, alpha, w, box) {
  const cw = box.x1 - box.x0, ch = box.y1 - box.y0;
  const out = new Uint8ClampedArray(cw * ch * 4);
  const q = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.floor(255 * v));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y + box.y0) * w + x + box.x0, d = (y * cw + x) * 4;
      out[d] = q(color[0][s]); out[d + 1] = q(color[1][s]); out[d + 2] = q(color[2][s]); out[d + 3] = q(alpha[s]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- resize
/** Where a cw x ch image goes when fitted (longest side = size, aspect kept) and centred in a size x size square: {w, h, x, y}. */
export function fitRect(cw, ch, size) {
  const s = size / Math.max(cw, ch);
  const w = Math.max(1, Math.round(cw * s)), h = Math.max(1, Math.round(ch * s));
  return { w, h, x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2) };
}

const PRECISION = 22;
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos3 = (x) => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0);

function coefficients(inN, outN) { // Pillow's precompute_coeffs with its 22-bit fixed-point weights
  const scale = inN / outN, fscale = Math.max(scale, 1), support = 3 * fscale, out = new Array(outN);
  for (let xx = 0; xx < outN; xx++) {
    const center = (xx + 0.5) * scale;
    const x0 = Math.max(0, Math.trunc(center - support + 0.5));
    const n = Math.min(inN, Math.trunc(center + support + 0.5)) - x0;
    const k = new Float64Array(n);
    let sum = 0;
    for (let x = 0; x < n; x++) { k[x] = lanczos3((x + x0 - center + 0.5) / fscale); sum += k[x]; }
    const kk = new Int32Array(n);
    for (let x = 0; x < n; x++) {
      const v = (sum !== 0 ? k[x] / sum : k[x]) * (1 << PRECISION);
      kk[x] = v < 0 ? Math.trunc(v - 0.5) : Math.trunc(v + 0.5);
    }
    out[xx] = { x0, kk };
  }
  return out;
}

const clip8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Lanczos3 resize of straight RGBA bytes, bit-exact with Pillow 11 `Image.resize(LANCZOS)` on an RGBA image: premultiply in 8-bit, horizontal
 * pass to an 8-bit intermediate, vertical pass, un-premultiply. A dimension that does not change skips its pass.
 */
export function resizeLanczos(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Uint8ClampedArray.from(src);
  let cur = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    for (let c = 0; c < 3; c++) { const t = src[i + c] * a + 128; cur[i + c] = ((t >> 8) + t) >> 8; }
    cur[i + 3] = a;
  }
  let cw = sw, ch = sh;
  const half = 1 << (PRECISION - 1);
  if (dw !== sw) {
    const co = coefficients(sw, dw), out = new Uint8ClampedArray(dw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < dw; x++) {
        const { x0, kk } = co[x];
        let s0 = half, s1 = half, s2 = half, s3 = half;
        for (let i = 0; i < kk.length; i++) { const p = (y * cw + x0 + i) * 4, k = kk[i]; s0 += cur[p] * k; s1 += cur[p + 1] * k; s2 += cur[p + 2] * k; s3 += cur[p + 3] * k; }
        const d = (y * dw + x) * 4;
        out[d] = clip8(s0 >> PRECISION); out[d + 1] = clip8(s1 >> PRECISION); out[d + 2] = clip8(s2 >> PRECISION); out[d + 3] = clip8(s3 >> PRECISION);
      }
    }
    cur = out; cw = dw;
  }
  if (dh !== sh) {
    const co = coefficients(sh, dh), out = new Uint8ClampedArray(cw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const { x0: y0, kk } = co[y];
      for (let x = 0; x < cw; x++) {
        let s0 = half, s1 = half, s2 = half, s3 = half;
        for (let i = 0; i < kk.length; i++) { const p = ((y0 + i) * cw + x) * 4, k = kk[i]; s0 += cur[p] * k; s1 += cur[p + 1] * k; s2 += cur[p + 2] * k; s3 += cur[p + 3] * k; }
        const d = (y * cw + x) * 4;
        out[d] = clip8(s0 >> PRECISION); out[d + 1] = clip8(s1 >> PRECISION); out[d + 2] = clip8(s2 >> PRECISION); out[d + 3] = clip8(s3 >> PRECISION);
      }
    }
    cur = out; ch = dh;
  }
  for (let i = 0; i < cur.length; i += 4) { // un-premultiply (alpha 0 and 255 are left as they are)
    const a = cur[i + 3];
    if (a !== 0 && a !== 255) for (let c = 0; c < 3; c++) cur[i + c] = Math.min(255, Math.floor((255 * cur[i + c]) / a));
  }
  return cur;
}

// ---------------------------------------------------------------- the whole pipeline, with per-stage caches
/**
 * One image being cleaned. The expensive stages are cached: the guided filter by (radius, smoothing), the colour bleed by radius; floor, solidify,
 * ceiling, threshold, padding and the resize are cheap and rerun on every call, so most sliders respond immediately.
 */
export function createCleaner() {
  let img = null, alphaKey = '', alphaQ = null, colorKey = '', color = null;
  const params = (p) => ({ ...DEFAULTS, ...p });
  return {
    setImage(rgba, w, h) {
      let hasAlpha = false;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
      img = { rgba, w, h, hasAlpha };
      alphaKey = colorKey = ''; alphaQ = color = null;
    },
    get hasAlpha() { return !!img?.hasAlpha; },
    /** Cleaned and cropped, not resized: {rgba, w, h, box, hasAlpha}. An image with no transparency is returned uncropped. */
    preview(p) {
      p = params(p);
      const { rgba, w, h, hasAlpha } = img;
      if (!hasAlpha) return { rgba: Uint8ClampedArray.from(rgba), w, h, box: { x0: 0, y0: 0, x1: w, y1: h, found: false }, hasAlpha };
      const ak = `${p.radius}|${p.smoothing}`;
      if (ak !== alphaKey) { alphaQ = refineAlpha(rgba, w, h, p); alphaKey = ak; }
      if (colorKey !== String(p.radius)) { color = bleedColor(rgba, w, h, p.radius); colorKey = String(p.radius); }
      const alpha = shapeAlpha(alphaQ, p);
      const box = cropBox(alpha, w, h, p.threshold, p.padding);
      return { rgba: assemble(color, alpha, w, box), w: box.x1 - box.x0, h: box.y1 - box.y0, box, hasAlpha };
    },
    /** The final image: {rgba, w, h}. resize 'fit' = fit + pad to size x size, 'stretch' = size x size ignoring aspect (what ComfyUI does), 'none' = as cropped. */
    exportImage(p) {
      p = params(p);
      const c = this.preview(p);
      if (p.resize === 'none') return { rgba: c.rgba, w: c.w, h: c.h };
      const size = p.size;
      if (p.resize === 'stretch') return { rgba: resizeLanczos(c.rgba, c.w, c.h, size, size), w: size, h: size };
      const f = fitRect(c.w, c.h, size);
      const small = resizeLanczos(c.rgba, c.w, c.h, f.w, f.h);
      const out = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < f.h; y++) out.set(small.subarray(y * f.w * 4, (y + 1) * f.w * 4), ((y + f.y) * size + f.x) * 4);
      return { rgba: out, w: size, h: size };
    }
  };
}
