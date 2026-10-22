// Background removal. The color-removal pipeline is ported from Token Framer (Foundry module) token-config.js
// _applyColorRemoval, split into mask building and mask refinement so that the magic wand, brush and
// rectangle edits can share the same refinement (grow -> hard removal -> feather -> defringe).
// threshold/tolerance are raw RGB distance units (0-100ish), feather/grow in pixels, defringe 0-100.
// A mask is a Uint8Array(w*h) where 1 = remove.
import { matteToMask, MATTE_RES } from './matte.js';

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Pixels within `threshold` of `color`; with edgesOnly, only those connected to the image border. */
export function buildColorMask(imageData, color, threshold, edgesOnly = false) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const total = w * h;
  const tSq = threshold * threshold;

  const colorDistSq = (i) => {
    const dr = data[i] - color.r;
    const dg = data[i + 1] - color.g;
    const db = data[i + 2] - color.b;
    return dr * dr + dg * dg + db * db;
  };

  const mask = new Uint8Array(total);
  if (!edgesOnly) {
    for (let pi = 0; pi < total; pi++) {
      if (colorDistSq(pi * 4) <= tSq) mask[pi] = 1;
    }
  } else {
    const queue = [];
    const enqueue = (x, y) => {
      const pi = y * w + x;
      if (mask[pi]) return;
      if (colorDistSq(pi * 4) > tSq) return;
      mask[pi] = 1;
      queue.push(pi);
    };
    for (let x = 0; x < w; x++) { enqueue(x, 0); enqueue(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { enqueue(0, y); enqueue(w - 1, y); }
    let head = 0;
    while (head < queue.length) {
      const pi = queue[head++];
      const x = pi % w;
      const y = (pi - x) / w;
      if (x > 0) enqueue(x - 1, y);
      if (x < w - 1) enqueue(x + 1, y);
      if (y > 0) enqueue(x, y - 1);
      if (y < h - 1) enqueue(x, y + 1);
    }
  }
  return mask;
}

/**
 * Magic wand: pixels within `tolerance` of the color of the clicked pixel (compared to the clicked pixel,
 * not to neighbours, like Photoshop). Contiguous = 4-connected region from the click, else the whole image.
 * Adds into `mask` (sets 1) and returns the clicked pixel's color.
 */
export function addWandToMask(mask, imageData, x, y, tolerance, contiguous, fixed = null) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  x = Math.min(w - 1, Math.max(0, Math.round(x)));
  y = Math.min(h - 1, Math.max(0, Math.round(y)));
  const si = (y * w + x) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2];
  const tSq = tolerance * tolerance;
  const near = (pi) => {
    const i = pi * 4;
    const dr = data[i] - sr, dg = data[i + 1] - sg, db = data[i + 2] - sb;
    return dr * dr + dg * dg + db * db <= tSq;
  };
  if (!contiguous) {
    for (let pi = 0; pi < w * h; pi++) if (near(pi)) { mask[pi] = 1; if (fixed) fixed[pi] = 0; }
  } else {
    // visited is separate from mask so earlier edits (including restores) don't block the fill
    const seen = new Uint8Array(w * h);
    const queue = [y * w + x];
    seen[queue[0]] = 1;
    let head = 0;
    const push = (pi) => { if (!seen[pi] && near(pi)) { seen[pi] = 1; queue.push(pi); } };
    while (head < queue.length) {
      const pi = queue[head++];
      mask[pi] = 1;
      if (fixed) fixed[pi] = 0;
      const px = pi % w;
      if (px > 0) push(pi - 1);
      if (px < w - 1) push(pi + 1);
      if (pi >= w) push(pi - w);
      if (pi < w * (h - 1)) push(pi + w);
    }
  }
  return { r: sr, g: sg, b: sb };
}

/** Set (value 1) or clear (value 0) a filled disc. */
export function stampDisc(mask, w, h, cx, cy, r, value) {
  if (r < 1) { // a brush under 2px wide is a single-pixel pen
    const px = Math.round(cx), py = Math.round(cy);
    if (px >= 0 && px < w && py >= 0 && py < h) mask[py * w + px] = value;
    return { x0: px, y0: py, x1: px, y1: py };
  }
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  const rSq = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= rSq) mask[y * w + x] = value;
    }
  }
  return { x0, y0, x1, y1 };
}

/** Stamp discs along a polyline so fast strokes stay continuous. */
export function stampStroke(mask, w, h, pts, r, value) {
  if (!pts.length) return;
  const step = Math.max(1, r / 2);
  let [px, py] = pts[0];
  stampDisc(mask, w, h, px, py, r, value);
  for (let i = 1; i < pts.length; i++) {
    const [qx, qy] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) / step));
    for (let s = 1; s <= n; s++) stampDisc(mask, w, h, px + ((qx - px) * s) / n, py + ((qy - py) * s) / n, r, value);
    px = qx; py = qy;
  }
}

// Pixel pen. A brush of 1 to 3 px is no longer a disc: it paints whole pixels, exactly the ones under the pointer. Points are image coordinates where pixel i spans
// [i, i + 1), so the pixel under the pointer is floor(x). Size 1 is that pixel, size 3 is the 3x3 block centred on it, size 2 is the 2x2 block around the nearest pixel
// corner. Strokes are joined with a Bresenham line, so they are gapless and never fatter than the pen. (The old disc code rounded the pointer to the nearest pixel
// centre, half a pixel off, and a size 3 disc is a rounded plus, not a 3x3 block.)
export const penSize = (brushSize) => (brushSize < 3.5 ? Math.min(3, Math.max(1, Math.round(brushSize))) : 0); // 0 = the normal round brush
/** Top-left pixel of the pen block for a pointer at (x, y): what is stored in a pen edit's `pts`. */
export const penAnchor = (x, y, n) => (n % 2 ? [Math.floor(x) - (n - 1) / 2, Math.floor(y) - (n - 1) / 2] : [Math.round(x) - n / 2, Math.round(y) - n / 2]);
/** Every pixel a pen of `n` x `n` covers when its anchor moves along the integer `pts`. */
export function penPixels(pts, n, w, h, put) {
  const block = (ax, ay) => { for (let y = ay; y < ay + n; y++) for (let x = ax; x < ax + n; x++) if (x >= 0 && x < w && y >= 0 && y < h) put(y * w + x); };
  if (!pts.length) return;
  let [x, y] = pts[0];
  block(x, y);
  for (let i = 1; i < pts.length; i++) {
    const [qx, qy] = pts[i], dx = Math.abs(qx - x), dy = -Math.abs(qy - y), sx = x < qx ? 1 : -1, sy = y < qy ? 1 : -1;
    let err = dx + dy;
    while (x !== qx || y !== qy) {
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
      block(x, y);
    }
  }
}
export function stampPixelStroke(mask, w, h, pts, n, value) { penPixels(pts, n, w, h, (i) => { mask[i] = value; }); }

/**
 * Pixel-perfect pencil (as in Aseprite), for the 1 px pen. A hand-drawn diagonal crosses pixel corners, so the pointer passes through the side neighbour first
 * and the line gets an L-shaped extra pixel at every step: it looks 2 px thick. This extends `path` (whole pixels, each next to the last) to `to` along a Bresenham
 * line and drops every such corner pixel (b, when a-b-c turns a corner and a and c touch diagonally). Returns what changed, so a live view can paint and un-paint.
 * The finished path is stored as the edit's `pts`: consecutive pixels, so replaying it through penPixels draws exactly those pixels.
 */
export function penPathAdd(path, to) {
  const added = [], removed = [];
  if (!path.length) { path.push([to[0], to[1]]); added.push(path[0]); return { added, removed }; }
  let [x, y] = path[path.length - 1];
  const [qx, qy] = to, dx = Math.abs(qx - x), dy = -Math.abs(qy - y), sx = x < qx ? 1 : -1, sy = y < qy ? 1 : -1;
  let err = dx + dy;
  while (x !== qx || y !== qy) {
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
    const p = [x, y];
    path.push(p); added.push(p);
    const n = path.length;
    if (n >= 3) {
      const a = path[n - 3], b = path[n - 2], c = path[n - 1];
      const corner = Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1 && ((b[0] === a[0] && b[1] === c[1]) || (b[1] === a[1] && b[0] === c[0]));
      if (corner) { path.splice(n - 2, 1); removed.push(b); }
    }
  }
  return { added, removed };
}

/**
 * Build the final removal mask: automatic color mask (when cfg.crEnabled) followed by the manual edits in order.
 * edits: {type:'wand',x,y,tol,contiguous} | {type:'rect',x0,y0,x1,y1} | {type:'brush',mode,r,pts}
 * Returns {mask, color}; `color` is the reference color for defringe.
 */
export function buildEditedMask(imageData, cfg, edits = [], matte = null) {
  const w = imageData.width;
  const h = imageData.height;
  let color = hexToRgb(cfg.crColor);
  const mask = cfg.crEnabled ? buildColorMask(imageData, color, cfg.crThreshold, cfg.crEdgesOnly) : new Uint8Array(w * h);
  // `fixed` marks pixels last set by hand (1 = erased, 2 = restored): they stay exact, i.e. skip grow/feather/defringe
  const fixed = edits.some((e) => e.type !== 'wand' && e.type !== 'ai') ? new Uint8Array(w * h) : null;
  let firstWand = !cfg.crEnabled;
  for (const e of edits) {
    if (e.type === 'ai') {
      // RMBG-2.0 matte (1024x1024, see matte.js); parameters come from cfg so they can be tweaked without re-running the model
      if (!matte) continue;
      const m = matteToMask(matte, MATTE_RES, MATTE_RES, w, h, { sensitivity: cfg.aiSensitivity ?? 1, blur: cfg.aiBlur ?? 0, offset: cfg.aiOffset ?? -1 });
      const d = imageData.data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        mask[i] = 1;
        if (fixed) fixed[i] = 0;
        if (i % 7 === 0) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; } // sampled mean colour for defringe
      }
      if (firstWand && n) { color = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }; firstWand = false; }
    } else if (e.type === 'wand') {
      const c = addWandToMask(mask, imageData, e.x, e.y, e.tol, e.contiguous, fixed);
      if (firstWand) { color = c; firstWand = false; }
    } else if (e.type === 'rect') {
      const x0 = Math.max(0, Math.floor(Math.min(e.x0, e.x1))), x1 = Math.min(w - 1, Math.ceil(Math.max(e.x0, e.x1)));
      const y0 = Math.max(0, Math.floor(Math.min(e.y0, e.y1))), y1 = Math.min(h - 1, Math.ceil(Math.max(e.y0, e.y1)));
      for (let y = y0; y <= y1; y++) { mask.fill(1, y * w + x0, y * w + x1 + 1); fixed.fill(1, y * w + x0, y * w + x1 + 1); }
    } else if (e.type === 'brush') {
      const restore = e.mode === 'restore';
      if (e.px) { // pixel pen (see penSize): `pts` are anchor pixels
        stampPixelStroke(mask, w, h, e.pts, e.px, restore ? 0 : 1);
        stampPixelStroke(fixed, w, h, e.pts, e.px, restore ? 2 : 1);
      } else {
        stampStroke(mask, w, h, e.pts, e.r, restore ? 0 : 1);
        stampStroke(fixed, w, h, e.pts, e.r, restore ? 2 : 1);
      }
    }
  }
  return { mask, color, fixed };
}

/**
 * Refine a removal mask and apply it to the image's alpha: grow -> hard removal -> feather -> defringe.
 * `fixed` (from buildEditedMask) keeps hand edits exact. Mutates both `mask` (grow) and `imageData`; returns the ImageData.
 */
export function applyRemovalMask(imageData, mask, color, feather = 0, grow = 0, defringe = 0, fixed = null) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const total = w * h;
  // hand-erased pixels must not seed grow/feather/defringe: refine without them, then force them exact at the end
  const orig = fixed ? data.slice() : null;
  if (fixed) for (let pi = 0; pi < total; pi++) if (fixed[pi] === 1) mask[pi] = 0;

  // Grow the mask by N pixels
  if (grow > 0) {
    const growQueue = [];
    const growDist = new Int16Array(total).fill(-1);
    for (let pi = 0; pi < total; pi++) {
      if (mask[pi]) { growDist[pi] = 0; growQueue.push(pi); }
    }
    let gHead = 0;
    while (gHead < growQueue.length) {
      const pi = growQueue[gHead++];
      const d = growDist[pi];
      if (d >= grow) continue;
      const x = pi % w;
      const y = (pi - x) / w;
      const nb = [];
      if (x > 0) nb.push(pi - 1);
      if (x < w - 1) nb.push(pi + 1);
      if (y > 0) nb.push(pi - w);
      if (y < h - 1) nb.push(pi + w);
      for (const npi of nb) {
        if (growDist[npi] >= 0) continue;
        growDist[npi] = d + 1;
        mask[npi] = 1;
        growQueue.push(npi);
      }
    }
  }

  // Hard removal
  for (let pi = 0; pi < total; pi++) {
    if (mask[pi]) data[pi * 4 + 3] = 0;
  }

  // Feather - graded alpha by spatial distance from the mask boundary
  if (feather > 0) {
    const fQueue = [];
    const fDist = new Float32Array(total).fill(-1);
    for (let pi = 0; pi < total; pi++) {
      if (mask[pi]) continue;
      const x = pi % w;
      const y = (pi - x) / w;
      let borderNeighbor = false;
      if (x > 0 && mask[pi - 1]) borderNeighbor = true;
      else if (x < w - 1 && mask[pi + 1]) borderNeighbor = true;
      else if (y > 0 && mask[pi - w]) borderNeighbor = true;
      else if (y < h - 1 && mask[pi + w]) borderNeighbor = true;
      if (borderNeighbor) { fDist[pi] = 1; fQueue.push(pi); }
    }
    let fHead = 0;
    while (fHead < fQueue.length) {
      const pi = fQueue[fHead++];
      const d = fDist[pi];
      if (d >= feather) continue;
      const x = pi % w;
      const y = (pi - x) / w;
      const nb = [];
      if (x > 0) nb.push(pi - 1);
      if (x < w - 1) nb.push(pi + 1);
      if (y > 0) nb.push(pi - w);
      if (y < h - 1) nb.push(pi + w);
      for (const npi of nb) {
        if (mask[npi] || fDist[npi] >= 0) continue;
        fDist[npi] = d + 1;
        fQueue.push(npi);
      }
    }
    for (let pi = 0; pi < total; pi++) {
      if (fDist[pi] > 0) {
        const t = fDist[pi] / feather;
        data[pi * 4 + 3] = Math.round(data[pi * 4 + 3] * t);
      }
    }
  }

  // Defringe - shift border pixel colors away from the removed color
  if (defringe > 0) {
    const strength = defringe / 100;
    const dfQueue = [];
    const dfDist = new Int16Array(total).fill(-1);
    const DEFRINGE_RADIUS = Math.max(1, Math.round(defringe / 10));

    for (let pi = 0; pi < total; pi++) {
      if (data[pi * 4 + 3] === 0) continue;
      const x = pi % w;
      const y = (pi - x) / w;
      let nearMask = false;
      if (x > 0 && data[(pi - 1) * 4 + 3] === 0) nearMask = true;
      else if (x < w - 1 && data[(pi + 1) * 4 + 3] === 0) nearMask = true;
      else if (y > 0 && data[(pi - w) * 4 + 3] === 0) nearMask = true;
      else if (y < h - 1 && data[(pi + w) * 4 + 3] === 0) nearMask = true;
      if (nearMask) { dfDist[pi] = 0; dfQueue.push(pi); }
    }

    let dfHead = 0;
    while (dfHead < dfQueue.length) {
      const pi = dfQueue[dfHead++];
      const d = dfDist[pi];
      if (d >= DEFRINGE_RADIUS) continue;
      const x = pi % w;
      const y = (pi - x) / w;
      const nb = [];
      if (x > 0) nb.push(pi - 1);
      if (x < w - 1) nb.push(pi + 1);
      if (y > 0) nb.push(pi - w);
      if (y < h - 1) nb.push(pi + w);
      for (const npi of nb) {
        if (dfDist[npi] >= 0 || data[npi * 4 + 3] === 0) continue;
        dfDist[npi] = d + 1;
        dfQueue.push(npi);
      }
    }

    const bgLum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
    for (let qi = 0; qi < dfQueue.length; qi++) {
      const pi = dfQueue[qi];
      const d = dfDist[pi];
      const falloff = strength * (1 - d / (DEFRINGE_RADIUS + 1));
      const i = pi * 4;
      data[i]     = Math.max(0, Math.min(255, Math.round(data[i]     - (color.r - bgLum) * falloff)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(data[i + 1] - (color.g - bgLum) * falloff)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(data[i + 2] - (color.b - bgLum) * falloff)));
    }
  }

  if (fixed) {
    for (let pi = 0; pi < total; pi++) {
      const f = fixed[pi];
      if (f === 1) data[pi * 4 + 3] = 0;
      else if (f === 2) { const i = pi * 4; data[i] = orig[i]; data[i + 1] = orig[i + 1]; data[i + 2] = orig[i + 2]; data[i + 3] = orig[i + 3]; }
    }
  }
  return imageData;
}

/** Original single-call API (color removal only); kept for parity with the module. */
export function applyColorRemoval(imageData, color, threshold, edgesOnly = false, feather = 0, grow = 0, defringe = 0) {
  return applyRemovalMask(imageData, buildColorMask(imageData, color, threshold, edgesOnly), color, feather, grow, defringe);
}
