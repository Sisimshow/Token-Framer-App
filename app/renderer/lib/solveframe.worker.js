// Runs the white/black frame solver off the UI thread. See solveframe.js for the maths.
import { createSolver } from './solveframe.js';
import { decode, toPng } from './imgio.js';

const solver = createSolver();

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'mask') { // the "clear the middle" mask: only its red channel matters
      const d = await decode(data.bytes);
      const red = new Uint8Array(d.width * d.height);
      for (let i = 0; i < red.length; i++) red[i] = d.data[i * 4];
      solver.setMask(red, d.width, d.height);
      self.postMessage({ type, id });
    } else if (type === 'load') {
      const d = await decode(data.bytes);
      solver.setImage(data.slot, d.data, d.width, d.height);
      const copy = new Uint8ClampedArray(d.data); // straight copy for the White / Black views
      self.postMessage({ type, id, w: d.width, h: d.height, rgba: copy }, [copy.buffer]);
    } else if (type === 'preview') {
      const t = performance.now();
      const r = solver.preview(data.params);
      self.postMessage({ type, id, w: r.w, h: r.h, rgba: r.rgba, box: r.box, report: r.report, ms: Math.round(performance.now() - t) }, [r.rgba.buffer]);
    } else if (type === 'export') {
      const r = solver.exportImage(data.params);
      const png = await toPng(r.rgba, r.w, r.h);
      self.postMessage({ type, id, w: r.w, h: r.h, png }, [png.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
