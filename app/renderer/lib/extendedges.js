// "Extend edges": grows an image's canvas and fills the new border from the picture itself instead of a flat colour.
// Pure maths (no DOM), run in extendedges.worker.js. Modes: 'mirror' (reflect the picture outward), 'smear' (repeat the edge pixels) and 'transparent' (just more canvas).
// Mirror and smear are softened by a blur that grows with the distance from the picture, so the far edge is a calm wash instead of a hard echo.
// RGBA is straight (not premultiplied) in and out; every blur runs on premultiplied values so transparent pixels never leave dark or coloured fringes.

export const EXTEND_DEFAULTS = { top: 0, right: 0, bottom: 0, left: 0, link: false, mode: 'mirror', blur: 0.25, showBounds: true };

/** Largest output, in pixels (the same cap the model tools use). */
export const MAX_EXTEND_PIXELS = 100e6;

/**
 * Index of the pixel a position `i` outside 0..n-1 reads when the picture is reflected (period 2(n-1), the edge pixel itself is NOT repeated,
 * so there is no doubled line along the seam). Bounces, so a border wider than the picture still works.
 */
export function reflectIndex(i, n) {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  const m = ((i % period) + period) % period;
  return m < n ? m : period - m;
}

/** The padding (top/right/bottom/left) that makes `w` x `h` square by growing the short side, centred (an odd extra pixel goes to the end). */
export function squarePadding(w, h) {
  const d = Math.abs(w - h);
  const a = Math.floor(d / 2), b = d - a;
  return w < h ? { left: a, right: b, top: 0, bottom: 0 } : h < w ? { top: a, bottom: b, left: 0, right: 0 } : { top: 0, right: 0, bottom: 0, left: 0 };
}

/** The sizes of three successive box blurs that together approximate a Gaussian of `sigma`. */
function boxSizes(sigma, n = 3) {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lo = Math.floor(ideal);
  if (lo % 2 === 0) lo--;
  const hi = lo + 2;
  const m = Math.round((12 * sigma * sigma - n * lo * lo - 4 * n * lo - 3 * n) / (-4 * lo - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? lo : hi));
}

/** One channel of one line, box blurred with radius `r`; the ends repeat their edge value. */
function boxLine(src, dst, base, step, len, r, inv) {
  const last = base + (len - 1) * step;
  let acc = src[base] * r;
  for (let i = 0; i <= r; i++) acc += src[Math.min(base + i * step, last)];
  const first = src[base], end = src[last], mid = Math.min(len, Math.max(0, len - r - 1));
  let i = 0;
  for (; i < Math.min(r, mid); i++) { dst[base + i * step] = acc * inv; acc += src[base + (i + r + 1) * step] - first; }   // left end: the window still sticks out on the left
  for (; i < mid; i++) { const p = base + i * step; dst[p] = acc * inv; acc += src[p + (r + 1) * step] - src[p - r * step]; }   // middle: no clamping
  for (; i < len; i++) { const p = base + i * step; dst[p] = acc * inv; acc += end - src[Math.max(p - r * step, base)]; }   // right end: the window sticks out on the right
}

/** Gaussian blur of an interleaved 4-channel Float32 image, in place (`tmp` is scratch of the same size). */
function gaussBlur(a, tmp, w, h, sigma) {
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) / 2, inv = 1 / size;
    for (let y = 0; y < h; y++) for (let c = 0; c < 4; c++) boxLine(a, tmp, y * w * 4 + c, 4, w, r, inv);
    for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) boxLine(tmp, a, x * 4 + c, w * 4, h, r, inv);
  }
}

const clampInt = (v) => Math.max(0, Math.round(+v || 0));

/**
 * Pads `rgba` (w x h, straight RGBA) by params.top/right/bottom/left and fills the border.
 * Returns { rgba, w, h }; the original pixels are copied into the middle byte for byte.
 * params.blur: pixels of blur sigma per pixel of distance from the picture (0 = no softening).
 */
export function extendEdges(rgba, w, h, params = {}) {
  const p = { ...EXTEND_DEFAULTS, ...params };
  const t = clampInt(p.top), r = clampInt(p.right), b = clampInt(p.bottom), l = clampInt(p.left);
  const W = w + l + r, H = h + t + b;
  if (W * H > MAX_EXTEND_PIXELS) throw new Error(`The result would be ${W}×${H} (${(W * H / 1e6).toFixed(0)} megapixels), more than the ${MAX_EXTEND_PIXELS / 1e6} megapixel limit`);
  const out = new Uint8ClampedArray(W * H * 4);
  const copyOriginal = () => { for (let y = 0; y < h; y++) out.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), ((y + t) * W + l) * 4); };
  if (p.mode === 'transparent' || (!t && !r && !b && !l)) { copyOriginal(); return { rgba: out, w: W, h: H }; }

  const mirror = p.mode !== 'smear';
  const map = mirror ? reflectIndex : (i, n) => Math.min(n - 1, Math.max(0, i));
  const xs = new Int32Array(W), ys = new Int32Array(H);
  for (let x = 0; x < W; x++) xs[x] = map(x - l, w);
  for (let y = 0; y < H; y++) ys[y] = map(y - t, h);

  // the reflected / repeated picture, premultiplied (alpha kept on a 0..255 scale)
  let cur = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const row = ys[y] * w;
    for (let x = 0; x < W; x++) {
      const s = (row + xs[x]) * 4, d = (y * W + x) * 4, a = rgba[s + 3];
      cur[d] = (rgba[s] * a) / 255; cur[d + 1] = (rgba[s + 1] * a) / 255; cur[d + 2] = (rgba[s + 2] * a) / 255; cur[d + 3] = a;
    }
  }

  // blur sigma wanted at a pixel: grows with the distance from the picture
  const k = Math.max(0, +p.blur || 0);
  const distAt = (x, y) => Math.hypot(Math.max(l - x, 0, x - (l + w - 1)), Math.max(t - y, 0, y - (t + h - 1)));
  const finish = (x, y, v) => { // un-premultiply into out
    const d = (y * W + x) * 4, a = v[3];
    if (a <= 0) return;
    const f = 255 / a;
    out[d] = v[0] * f; out[d + 1] = v[1] * f; out[d + 2] = v[2] * f; out[d + 3] = a;
  };
  const px = new Float32Array(4), px2 = new Float32Array(4);
  const load = (buf, x, y, v) => { const s = (y * W + x) * 4; v[0] = buf[s]; v[1] = buf[s + 1]; v[2] = buf[s + 2]; v[3] = buf[s + 3]; };

  const maxSigma = k * Math.hypot(Math.max(l, r), Math.max(t, b));
  if (k === 0 || maxSigma < 0.5) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { load(cur, x, y, px); finish(x, y, px); }
  } else {
    // blur levels (sigma 0, 1, 2, 4, 8 ... up to what the farthest corner needs); each pixel takes the two levels around its own sigma
    const levels = [0];
    for (let s = 1; levels[levels.length - 1] < maxSigma; s *= 2) levels.push(s);
    const sig = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sig[y * W + x] = k * distAt(x, y);
    let prev = new Float32Array(cur), tmp = new Float32Array(cur.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (sig[y * W + x] <= 0) { load(cur, x, y, px); finish(x, y, px); }
    for (let i = 1; i < levels.length; i++) {
      const delta = Math.sqrt(levels[i] * levels[i] - levels[i - 1] * levels[i - 1]);
      gaussBlur(cur, tmp, W, H, delta); // blurring the previous level further: variances add
      const lo = levels[i - 1], hi = levels[i], last = i === levels.length - 1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const s = sig[y * W + x];
          if (s <= lo || (s > hi && !last)) continue;
          const f = Math.min(1, (s - lo) / (hi - lo));
          load(prev, x, y, px); load(cur, x, y, px2);
          for (let c = 0; c < 4; c++) px[c] += (px2[c] - px[c]) * f;
          finish(x, y, px);
        }
      }
      prev.set(cur);
    }
  }
  copyOriginal();
  return { rgba: out, w: W, h: H };
}
