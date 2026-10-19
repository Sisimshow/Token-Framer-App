// Frame hole detection, ported from art_tokenize.py: flood fill the transparent centre of the frame,
// take its bounding box, and build a (dilated) mask of it.

/**
 * Flood fill (4-connected) over pixels with the same alpha as the seed pixel.
 * `valid` is true only when the seed pixel is fully transparent and the filled region
 * does not touch the image border (a hole connected to the outside means the frame is not closed).
 */
export function detectHole(frameBitmap, seed = null) {
  const w = frameBitmap.width;
  const h = frameBitmap.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frameBitmap, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;

  const sx = Math.min(w - 1, Math.max(0, Math.round(seed?.x ?? w / 2)));
  const sy = Math.min(h - 1, Math.max(0, Math.round(seed?.y ?? h / 2)));
  const target = px[(sy * w + sx) * 4 + 3];
  const mask = new Uint8Array(w * h);
  const matches = (x, y) => px[(y * w + x) * 4 + 3] === target && !mask[y * w + x];

  let minX = w, minY = h, maxX = -1, maxY = -1;
  let touchesBorder = false;
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x0, y] = stack.pop();
    if (!matches(x0, y)) continue;
    let xl = x0;
    while (xl > 0 && matches(xl - 1, y)) xl--;
    let xr = x0;
    while (xr < w - 1 && matches(xr + 1, y)) xr++;
    for (let x = xl; x <= xr; x++) mask[y * w + x] = 1;
    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (xl === 0 || xr === w - 1 || y === 0 || y === h - 1) touchesBorder = true;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inRun = false;
      for (let x = xl; x <= xr; x++) {
        if (matches(x, ny)) {
          if (!inRun) { stack.push([x, ny]); inRun = true; }
        } else inRun = false;
      }
    }
  }

  return {
    w, h, mask,
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    seed: { x: sx, y: sy },
    seedAlpha: target,
    touchesBorder,
    valid: target === 0 && !touchesBorder && maxX >= 0
  };
}

// Separable square dilation (same as the Python 17x17 kernel for radius 8), using running sums.
function dilate(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const run = (get, set, len, stride, outerLen, outerStride) => {
    for (let o = 0; o < outerLen; o++) {
      const base = o * outerStride;
      const pre = new Int32Array(len + 1);
      for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + get(base + i * stride);
      for (let i = 0; i < len; i++) {
        const a = Math.max(0, i - r);
        const b = Math.min(len - 1, i + r);
        set(base + i * stride, pre[b + 1] - pre[a] > 0 ? 1 : 0);
      }
    }
  };
  run((i) => src[i], (i, v) => { tmp[i] = v; }, w, 1, h, w);
  run((i) => tmp[i], (i, v) => { out[i] = v; }, h, w, w, 1);
  return out;
}

/** White-on-transparent canvas at the frame's native size; `dilatePx` is in frame-native pixels. */
export function holeMaskCanvas(hole, dilatePx = 0) {
  const m = dilate(hole.mask, hole.w, hole.h, Math.max(0, Math.round(dilatePx)));
  const c = document.createElement('canvas');
  c.width = hole.w;
  c.height = hole.h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(hole.w, hole.h);
  const d = img.data;
  for (let i = 0; i < m.length; i++) {
    if (m[i]) {
      const j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
