// Frame from a white and a black render, ported from the author's ComfyUI "Token Background Solver V2" workflow:
//   TriangulationMatte (alpha measured from the two renders, not guessed) -> two "image over itself" composites (solidify)
//   -> FastAlphaCropper -> ImageScale (Lanczos) -> a fixed circular mask subtracted from the alpha ("clear the middle").
// Pure functions, no DOM. Inputs are straight RGBA bytes (alpha ignored: the renders are opaque pictures).
// The workflow first runs both renders through a 1x ESRGAN-style model (1x_PureVision) to clean up compression noise: here that is the optional `preClean`, which uses
// cleaned copies of the renders supplied by the app (the model itself runs in the main process, see modelrun.cjs).
import { cropBox, assemble, resizeLanczos, resizeOutput, DEFAULTS as CLEAN } from './cleanframe.js';

export const SOLVE_DEFAULTS = {
  channelMode: 'min', floor: 0.02, ceiling: 0.98, whiteLevel: 1, blackLevel: 0, colorSource: 'white',
  solidify: 2, threshold: CLEAN.threshold, padding: CLEAN.padding, resize: CLEAN.resize, size: CLEAN.size, clearMiddle: true,
  crop: true,                 // false: keep the full image (the Image Background Solver V2 has no trim, resize or cut-out middle)
  preClean: true, preCleanModel: '' // app-level options: which model, if any, was used to prepare the cleaned copies
};
const EPS = 1e-6;

/** Mean of the one-pixel border ring over all channels: what the background actually measures. */
function borderMean(rgba, w, h) {
  let s = 0, n = 0;
  const add = (x, y) => { const i = (y * w + x) * 4; s += rgba[i] + rgba[i + 1] + rgba[i + 2]; n += 3; };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  return s / n / 255;
}

/**
 * Triangulation matting. With white (level Lw) and black (level Lb) renders:  alpha = 1 - (W - B) / (Lw - Lb)  per channel, reduced with `channelMode`,
 * clamped to 0..1, then floor and ceiling (strict, in float32 like torch). Straight colour = (source - (1 - alpha) * level) / alpha from the shaped alpha.
 * Returns {alpha: Float32Array, color: [r, g, b] Float32Arrays, report}.
 */
export function solveMatte(white, black, w, h, p = {}) {
  p = { ...SOLVE_DEFAULTS, ...p };
  const n = w * h;
  const alpha = new Float32Array(n), color = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const denom = Math.max(p.whiteLevel - p.blackLevel, EPS);
  const lo = Math.fround(p.floor), hi = Math.fround(p.ceiling);
  const src = p.colorSource === 'black' ? black : white, level = p.colorSource === 'black' ? p.blackLevel : p.whiteLevel;
  let spread = 0, blown = 0, transparent = 0, opaque = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a0 = 1 - (white[o] - black[o]) / 255 / denom, a1 = 1 - (white[o + 1] - black[o + 1]) / 255 / denom, a2 = 1 - (white[o + 2] - black[o + 2]) / 255 / denom;
    let a = p.channelMode === 'max' ? Math.max(a0, a1, a2) : p.channelMode === 'mean' ? (a0 + a1 + a2) / 3 : Math.min(a0, a1, a2);
    a = Math.fround(a < 0 ? 0 : a > 1 ? 1 : a);
    const m = (a0 + a1 + a2) / 3;
    spread += Math.sqrt(((a0 - m) ** 2 + (a1 - m) ** 2 + (a2 - m) ** 2) / 3);
    if (white[o] >= 252.45 && white[o + 1] >= 252.45 && white[o + 2] >= 252.45 && black[o] >= 252.45 && black[o + 1] >= 252.45 && black[o + 2] >= 252.45) blown++;
    if (a <= 0.001) transparent++;
    if (a >= 0.999) opaque++;
    if (a < lo) a = 0;
    if (a > hi) a = 1;
    alpha[i] = a;
    for (let c = 0; c < 3; c++) {
      const prem = src[o + c] / 255 - (1 - a) * level;
      const v = a > EPS ? prem / Math.max(a, EPS) : 0;
      color[c][i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return {
    alpha, color,
    report: { whiteBg: borderMean(white, w, h), blackBg: borderMean(black, w, h), disagreement: spread / n, blown: blown / n, transparent: transparent / n, opaque: opaque / n }
  };
}

/** `passes` times: alpha = 1 - (1 - alpha)^2. This is what compositing the image over itself (Porter-Duff SRC_OVER) does to alpha; colour is unchanged. */
export function solidifyAlpha(alpha, passes) {
  if (passes <= 0) return alpha;
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    let a = alpha[i];
    for (let s = 0; s < passes; s++) a = Math.fround(1 - (1 - a) * (1 - a));
    out[i] = a;
  }
  return out;
}

/**
 * "Clear the middle": the alpha is reduced by a fixed mask (MaskComposite add on the inverted alpha), computed in float32 and floored to 8 bits like the
 * ComfyUI save step. `maskRed` is the mask's red channel at mw x mh; it is Lanczos-scaled to w x h when the sizes differ (the original only works at 1000 x 1000).
 */
export function clearMiddle(rgba, w, h, maskRed, mw, mh) {
  let m = maskRed;
  if (mw !== w || mh !== h) {
    const g = new Uint8ClampedArray(mw * mh * 4);
    for (let i = 0; i < mw * mh; i++) { g[i * 4] = g[i * 4 + 1] = g[i * 4 + 2] = maskRed[i]; g[i * 4 + 3] = 255; }
    const r = resizeLanczos(g, mw, mh, w, h);
    m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = r[i * 4];
  }
  const out = Uint8ClampedArray.from(rgba);
  for (let i = 0; i < w * h; i++) {
    const t = Math.fround(1 - Math.fround(out[i * 4 + 3] / 255));
    let s = Math.fround(t + Math.fround(m[i] / 255));
    if (s > 1) s = 1;
    const v = Math.floor(Math.fround(255 * Math.fround(1 - s)));
    out[i * 4 + 3] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/** Two renders being solved. Everything is per pixel, so there are no stage caches: each call recomputes from the two inputs. */
export function createSolver() {
  let white = null, black = null, mask = null, cleanWhite = null, cleanBlack = null;
  const check = () => {
    if (!white || !black) throw new Error('Open both the white and the black render first');
    if (white.w !== black.w || white.h !== black.h) throw new Error(`The two renders must be the same size (white is ${white.w}×${white.h}, black is ${black.w}×${black.h})`);
  };
  const solve = (p) => {
    p = { ...SOLVE_DEFAULTS, ...p };
    const useClean = !!(p.preClean && cleanWhite && cleanBlack); // both cleaned copies, or neither (the alpha needs the pair to be treated alike)
    const { alpha: a0, color, report } = solveMatte(useClean ? cleanWhite : white.rgba, useClean ? cleanBlack : black.rgba, white.w, white.h, p);
    const alpha = solidifyAlpha(a0, p.solidify);
    const box = p.crop === false ? { x0: 0, y0: 0, x1: white.w, y1: white.h, found: true } : cropBox(alpha, white.w, white.h, p.threshold, p.padding);
    return { p, report, box, usedClean: useClean, rgba: assemble(color, alpha, white.w, box), w: box.x1 - box.x0, h: box.y1 - box.y0 };
  };
  return {
    setImage(slot, rgba, w, h) { if (slot === 'white') { white = { rgba, w, h }; cleanWhite = null; } else { black = { rgba, w, h }; cleanBlack = null; } }, // a new render drops its cleaned copy
    /** The pre-cleaned copy of a render (same size as the raw one, straight RGBA); null to forget it. */
    setCleaned(slot, rgba) { if (slot === 'white') cleanWhite = rgba; else cleanBlack = rgba; },
    get cleanedReady() { return { white: !!cleanWhite, black: !!cleanBlack }; },
    setMask(redPlane, w, h) { mask = { red: redPlane, w, h }; },
    get ready() { return !!white && !!black; },
    /** Solved and trimmed, not resized, middle not cleared: {rgba, w, h, box, report}. */
    preview(p) { check(); const r = solve(p); return { rgba: r.rgba, w: r.w, h: r.h, box: r.box, report: r.report, usedClean: r.usedClean }; },
    /** The final image: {rgba, w, h}. */
    exportImage(p) {
      check();
      const r = solve(p);
      const out = resizeOutput(r.rgba, r.w, r.h, r.p);
      if (r.p.clearMiddle && mask) out.rgba = clearMiddle(out.rgba, out.w, out.h, mask.red, mask.w, mask.h);
      return out;
    }
  };
}
