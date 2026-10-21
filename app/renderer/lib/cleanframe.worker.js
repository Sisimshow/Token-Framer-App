// Runs the frame cleanup off the UI thread: decode, process (with stage caches) and PNG-encode. See cleanframe.js for the maths.
import { createCleaner } from './cleanframe.js';

const cleaner = createCleaner();

async function decode(bytes) {
  // no colour conversion and no premultiplication: the maths wants the file's straight RGBA values
  const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return d;
}

async function toPng(rgba, w, h) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'load') {
      const d = await decode(data.bytes);
      cleaner.setImage(d.data, d.width, d.height);
      // keep a straight copy for the "show original" view
      const orig = new Uint8ClampedArray(d.data);
      self.postMessage({ type, id, w: d.width, h: d.height, hasAlpha: cleaner.hasAlpha, rgba: orig }, [orig.buffer]);
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
