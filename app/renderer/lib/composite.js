// Compositing, ported from Token Framer (Foundry module) frame-layer.js compositeImage / token-config.js
// generatePreview (they were the same code plus a preview highlight). Synchronous: callers pass loaded
// bitmaps/canvases. Offsets are authored in a 512px space and scaled by size/512 (as in the module).

export const DEFAULTS = {
  // art placement
  fitEnabled: true, fitAnchor: 'top', fitScale: 1, fitOffsetX: 0, fitOffsetY: 0,
  baseScale: 0.9, baseOffsetX: 0, baseOffsetY: 0, baseOverFrame: false,
  // mask
  maskShape: 'hole', holeDilate: 8, maskRadius: 0.95, maskOffsetX: 0, maskOffsetY: 0,
  maskImage: '', maskScale: 1,
  // frame
  frameScale: 1, frameOffsetX: 0, frameOffsetY: 0, frameOpacity: 1,
  frameTintOn: false, frameTintColor: '#ffffff',
  // background
  bgEnabled: false, bgColor: '#000000', bgImage: '', bgImageScale: 1, bgImageOffsetX: 0, bgImageOffsetY: 0,
  // overlay
  overlayImage: '', overlayScale: 1, overlayOffsetX: 0, overlayOffsetY: 0, overlayOpacity: 1,
  overlayTintOn: false, overlayTintColor: '#ffffff',
  // pop-out
  popOutEnabled: false, popOutDegrees: 180, popOutRotation: 0, popOutOffsetX: 0, popOutOffsetY: 0,
  // background color removal
  crEnabled: false, crColor: '#ffffff', crThreshold: 25, crFeather: 2, crGrow: 1, crDefringe: 15, crEdgesOnly: false,
  // the cutout (color removal + wand/brush/rectangle edits) only affects the pop-out layer unless this is off
  crPopOutOnly: true,
  // AI cutout (RMBG-2.0) post-processing; defaults follow the author's SwarmUI RMBG workflow (sensitivity 1, blur 0, offset -1)
  aiSensitivity: 1, aiBlur: 0, aiOffset: -1,
  // wand / brush tool settings (the edits themselves live in each image's override as popEdits)
  wandTolerance: 30, wandContiguous: true, brushSize: 40, brushMode: 'erase'
};

function drawHexagonPath(ctx, cx, cy, radius) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function applyMaskShape(ctx, shape, cx, cy, radius, ox = 0, oy = 0) {
  if (shape === 'none') return false;
  ctx.beginPath();
  if (shape === 'square') ctx.rect(cx - radius + ox, cy - radius + oy, radius * 2, radius * 2);
  else if (shape === 'hexagon') drawHexagonPath(ctx, cx + ox, cy + oy, radius);
  else ctx.arc(cx + ox, cy + oy, radius, 0, Math.PI * 2);
  ctx.clip();
  return true;
}

function newCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

/**
 * Where the frame hole lands in the 512px authoring space (frame is stretched to a square, like the module).
 * Returns the hole bounding box expanded by 1px per side (the Python script's "cover the hole + 1px overlap").
 */
export function holeTarget512(hole, cfg) {
  const S = 512, c = S / 2;
  const frameSize = S * cfg.frameScale;
  const x0 = c - frameSize / 2 + cfg.frameOffsetX;
  const y0 = c - frameSize / 2 + cfg.frameOffsetY;
  const sx = frameSize / hole.w;
  const sy = frameSize / hole.h;
  const b = hole.bbox;
  return { x: x0 + b.x * sx - 1, y: y0 + b.y * sy - 1, w: b.w * sx + 2, h: b.h * sy + 2 };
}

/**
 * Resolve baseScale/baseOffset. With "fit to hole" on and a valid hole, the art is cover-fitted to the hole's
 * bounding box (anchored top or centre vertically, centred horizontally) plus the user's scale/offset nudge.
 */
export function resolvePlacement(cfg, base, hole) {
  if (!cfg.fitEnabled || !hole?.valid) {
    return { baseScale: cfg.baseScale, baseOffsetX: cfg.baseOffsetX, baseOffsetY: cfg.baseOffsetY };
  }
  const S = 512, c = S / 2;
  const t = holeTarget512(hole, cfg);
  const aw = base.width, ah = base.height;
  const scale = Math.max(t.w / aw, t.h / ah);
  let dw = aw * scale, dh = ah * scale;
  const top = cfg.fitAnchor !== 'center';
  let dx = t.x + t.w / 2 - dw / 2;
  let dy = top ? t.y : t.y + t.h / 2 - dh / 2;

  const m = cfg.fitScale;
  const ax = dx + dw / 2;
  const ay = top ? dy : dy + dh / 2;
  dw *= m; dh *= m;
  dx = ax - dw / 2;
  dy = top ? ay : ay - dh / 2;
  dx += cfg.fitOffsetX;
  dy += cfg.fitOffsetY;

  let baseScale, offY;
  if (aw / ah >= 1) {
    baseScale = dh / S;
    offY = dy - c + dh / 2;
  } else {
    baseScale = dw / S;
    offY = dy - c + (S * baseScale) / 2;
  }
  return { baseScale, baseOffsetX: dx - c + dw / 2, baseOffsetY: offY };
}

/** Where the art is drawn (canvas px at `size`) for a resolved config: {x, y, w, h}. */
export function baseRect(cfg, base, size) {
  const { baseScale = 0.9, baseOffsetX = 0, baseOffsetY = 0 } = cfg;
  const k = size / 512;
  const aspect = base.width / base.height;
  let w, h, y;
  if (aspect >= 1) {
    h = size * baseScale;
    w = h * aspect;
    y = size / 2 - h / 2 + baseOffsetY * k;
  } else {
    w = size * baseScale;
    h = w / aspect;
    y = size / 2 - (size * baseScale) / 2 + baseOffsetY * k;
  }
  return { x: size / 2 - w / 2 + baseOffsetX * k, y, w, h };
}

/**
 * @param src {base, frame, mask?, bg?, overlay?, holeMask?}  drawables (ImageBitmap/canvas/img); holeMask is a canvas
 *            at the frame's native size (white where the hole is) drawn with the frame's transform.
 * @param cfg resolved config (baseScale/baseOffset already resolved; tint colors '' when off)
 * @returns HTMLCanvasElement of size x size
 */
export function compositeImage(src, cfg, size = 1000, opts = {}) {
  const {
    baseScale = 0.9, baseOffsetX = 0, baseOffsetY = 0,
    maskRadius = 0.95, maskScale = 1, maskOffsetX = 0, maskOffsetY = 0, maskShape = 'circle',
    frameScale = 1, frameOffsetX = 0, frameOffsetY = 0, baseOverFrame = false,
    bgEnabled = false, bgColor = '#000000', bgImageScale = 1, bgImageOffsetX = 0, bgImageOffsetY = 0,
    overlayScale = 1, overlayOffsetX = 0, overlayOffsetY = 0,
    popOutEnabled = false, popOutDegrees = 180, popOutRotation = 0, popOutOffsetX = 0, popOutOffsetY = 0,
    frameOpacity = 1, overlayOpacity = 1, frameTintColor = '', overlayTintColor = ''
  } = cfg;
  const { base: baseImg, frame: frameImg, mask: maskImg, bg: bgImg, overlay: overlayImg, holeMask } = src;
  const popImg = src.popBase || baseImg; // pop-out layer may use a cut-out version of the art

  const [canvas, ctx] = newCanvas(size);
  const cx = size / 2, cy = size / 2;
  const k = size / 512;

  const { x: bx, y: by, w: bw, h: bh } = baseRect(cfg, baseImg, size);
  // opts.crisp: draw the art with nearest-neighbour sampling (preview "pixel view")
  const drawArt = (t, img) => {
    const s = t.imageSmoothingEnabled;
    if (opts.crisp) t.imageSmoothingEnabled = false;
    t.drawImage(img, bx, by, bw, bh);
    t.imageSmoothingEnabled = s;
  };

  const drawBackground = (t) => {
    if (bgEnabled && bgColor) {
      t.fillStyle = bgColor;
      t.fillRect(0, 0, size, size);
    }
    if (bgImg) {
      const s = size * bgImageScale;
      t.drawImage(bgImg, cx - s / 2 + bgImageOffsetX * k, cy - s / 2 + bgImageOffsetY * k, s, s);
    }
  };

  const drawMaskedBase = () => {
    ctx.save();
    const useHole = maskShape === 'hole' && holeMask && !maskImg;
    if (maskImg || useHole) {
      const [baseCanvas, baseCtx] = newCanvas(size);
      drawBackground(baseCtx);
      drawArt(baseCtx, baseImg);

      const [maskCanvas, maskCtx] = newCanvas(size);
      if (maskImg) {
        const s = size * maskScale;
        maskCtx.drawImage(maskImg, cx - s / 2 + maskOffsetX * k, cy - s / 2 + maskOffsetY * k, s, s);
        const md = maskCtx.getImageData(0, 0, size, size);
        const p = md.data;
        for (let i = 0; i < p.length; i += 4) {
          const lum = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
          p[i + 3] = Math.min(p[i + 3], lum);
        }
        maskCtx.putImageData(md, 0, 0);
      } else {
        const fs = size * frameScale;
        maskCtx.drawImage(holeMask, cx - fs / 2 + frameOffsetX * k, cy - fs / 2 + frameOffsetY * k, fs, fs);
      }
      baseCtx.globalCompositeOperation = 'destination-in';
      baseCtx.drawImage(maskCanvas, 0, 0);
      ctx.drawImage(baseCanvas, 0, 0);
    } else {
      // 'hole' without hole data falls back to a circle
      const shape = maskShape === 'hole' ? 'circle' : maskShape;
      applyMaskShape(ctx, shape, cx, cy, (size / 2) * maskRadius, maskOffsetX * k, maskOffsetY * k);
      drawBackground(ctx);
      drawArt(ctx, baseImg);
    }
    ctx.restore();
  };

  // Multiply tint keeps light/dark detail; destination-in restores the original alpha.
  const drawWithTint = (img, x, y, w, h, tint) => {
    if (!tint) { ctx.drawImage(img, x, y, w, h); return; }
    const [off, offCtx] = newCanvas(size);
    offCtx.drawImage(img, x, y, w, h);
    offCtx.globalCompositeOperation = 'multiply';
    offCtx.fillStyle = tint;
    offCtx.fillRect(0, 0, size, size);
    offCtx.globalCompositeOperation = 'destination-in';
    offCtx.drawImage(img, x, y, w, h);
    ctx.drawImage(off, 0, 0);
  };

  const drawFrame = () => {
    ctx.save();
    ctx.globalAlpha = frameOpacity;
    const s = size * frameScale;
    drawWithTint(frameImg, cx - s / 2 + frameOffsetX * k, cy - s / 2 + frameOffsetY * k, s, s, frameTintColor);
    ctx.restore();
  };

  const drawOverlay = () => {
    if (!overlayImg) return;
    ctx.save();
    ctx.globalAlpha = overlayOpacity;
    const s = size * overlayScale;
    drawWithTint(overlayImg, cx - s / 2 + overlayOffsetX * k, cy - s / 2 + overlayOffsetY * k, s, s, overlayTintColor);
    ctx.restore();
  };

  const wedge = () => {
    const half = (popOutDegrees / 2) * Math.PI / 180;
    const center = (popOutRotation - 90) * Math.PI / 180;
    const px = cx + popOutOffsetX * k, py = cy + popOutOffsetY * k;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, size, center - half, center + half);
    ctx.closePath();
  };

  const drawPopOut = () => {
    if (!popOutEnabled || popOutDegrees <= 0) return;
    ctx.save();
    wedge();
    ctx.clip();
    drawArt(ctx, popImg);
    ctx.restore();
  };

  if (baseOverFrame) { drawFrame(); drawMaskedBase(); } else { drawMaskedBase(); drawFrame(); }
  drawOverlay();
  drawPopOut();

  if (opts.highlightPopOut && popOutEnabled && popOutDegrees > 0) {
    ctx.save();
    wedge();
    ctx.fillStyle = 'rgba(255, 220, 50, 0.25)';
    ctx.fill();
    ctx.restore();
  }
  return canvas;
}
