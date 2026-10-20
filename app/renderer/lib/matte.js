// Post-processing for the RMBG-2.0 matte, same maths as the ComfyUI RMBG node (AILab_RMBG.py), at source-image size:
//   m = clamp(m * (1 + (1 - sensitivity)), 0, 1)  ->  bilinear resize  ->  gaussian blur (mask_blur)
//   ->  mask_offset times a 3x3 max (grow) or min (shrink) filter on the 8-bit mask.
// Pure functions, no DOM, so they can be unit-tested from the harness.

export const MATTE_RES = 1024; // the ONNX model takes a fixed 1024x1024 input

/** Bilinear resize of a Uint8 plane to w x h (align_corners=false, like torch's default), returned as Float32 in 0..255. */
function resizeBilinear(src, sw, sh, w, h) {
  const out = new Float32Array(w * h);
  const xs = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const f = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / w - 0.5));
    xs[x] = Math.min(Math.max(sw - 2, 0), Math.floor(f));
    xf[x] = f - xs[x];
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / h - 0.5));
    const y0 = Math.min(Math.max(sh - 2, 0), Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const x0 = xs[x], x1 = Math.min(sw - 1, x0 + 1), wx = xf[x];
      const a = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx;
      const b = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx;
      out[y * w + x] = a * (1 - wy) + b * wy;
    }
  }
  return out;
}

/** Separable gaussian blur on a Uint8 plane, sigma = radius (PIL's GaussianBlur(radius) convention), edges clamped. */
function gaussianBlur(a, w, h, radius) {
  const r = Math.max(1, Math.ceil(radius * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * radius * radius)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += a[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
      tmp[y * w + x] = s;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
      out[y * w + x] = Math.round(s);
    }
  }
  return out;
}

/** One pass of a 3x3 max (grow = true) or min filter, done as two 1-D passes. Border pixels see only in-image neighbours. */
function rank3(a, w, h, grow) {
  const pick = grow ? Math.max : Math.min;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = a[y * w + x];
      if (x > 0) v = pick(v, a[y * w + x - 1]);
      if (x < w - 1) v = pick(v, a[y * w + x + 1]);
      tmp[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      if (y > 0) v = pick(v, tmp[(y - 1) * w + x]);
      if (y < h - 1) v = pick(v, tmp[(y + 1) * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * matte: Uint8Array(mw*mh) model output (255 = subject). Returns the 8-bit alpha at w x h after sensitivity, blur and offset.
 * opts: {sensitivity (0..1, 1 = untouched), blur (px radius), offset (px, + grows the subject, - shrinks it)}
 */
export function matteToAlpha(matte, mw, mh, w, h, { sensitivity = 1, blur = 0, offset = 0 } = {}) {
  const gain = 1 + (1 - sensitivity);
  const f = resizeBilinear(matte, mw, mh, w, h);
  let a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = Math.round(Math.min(255, Math.max(0, f[i] * gain)));
  if (blur > 0) a = gaussianBlur(a, w, h, blur);
  for (let n = Math.abs(Math.round(offset)); n > 0; n--) a = rank3(a, w, h, offset > 0);
  return a;
}

/** Removal mask in the form buildEditedMask uses (1 = removed): everything the matte calls less than half subject. */
export function matteToMask(matte, mw, mh, w, h, opts) {
  const a = matteToAlpha(matte, mw, mh, w, h, opts);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = a[i] < 128 ? 1 : 0;
  return mask;
}
