// Runs the frame cleanup off the UI thread: decode, process (with stage caches) and PNG-encode. See cleanframe.js for the maths.
import { createCleaner } from './cleanframe.js';
import { decode, toPng } from './imgio.js';

const cleaner = createCleaner();
let loadSeq = 0; // loads overlap at the decode: only the newest one may become the image

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'load') {
      const mine = ++loadSeq;
      const d = await decode(data.bytes);
      if (mine !== loadSeq) throw new Error('stale');   // a newer image was asked for meanwhile
      cleaner.setImage(d.data, d.width, d.height);
      // keep a straight copy for the "show original" view
      const orig = new Uint8ClampedArray(d.data);
      self.postMessage({ type, id, w: d.width, h: d.height, hasAlpha: cleaner.hasAlpha, rgba: orig }, [orig.buffer]);
    } else if (type === 'setImage') { // raw RGBA from the caller (the Remove background screen hands over its cutout)
      cleaner.setImage(new Uint8ClampedArray(data.rgba), data.w, data.h);
      self.postMessage({ type, id, hasAlpha: cleaner.hasAlpha });
    } else if (type === 'preview') {
      const t = performance.now();
      const r = cleaner.preview(data.params);
      self.postMessage({ type, id, w: r.w, h: r.h, rgba: r.rgba, box: r.box, hasAlpha: r.hasAlpha, ms: Math.round(performance.now() - t) }, [r.rgba.buffer]);
    } else if (type === 'export') {
      const r = cleaner.exportImage(data.params);
      const png = await toPng(r.rgba, r.w, r.h);
      self.postMessage({ type, id, w: r.w, h: r.h, png }, [png.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
