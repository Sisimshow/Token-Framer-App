// Runs the Extend edges maths off the UI thread. `load` keeps the picture, `extend` pads it with the given settings (see extendedges.js).
import { extendEdges } from './extendedges.js';

let src = null; // { rgba, w, h }

self.onmessage = ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'load') {
      src = { rgba: new Uint8ClampedArray(data.rgba), w: data.w, h: data.h };
      self.postMessage({ type, id });
    } else if (type === 'extend') {
      if (!src) throw new Error('No image loaded');
      const out = extendEdges(src.rgba, src.w, src.h, data.params);
      self.postMessage({ type, id, w: out.w, h: out.h, rgba: out.rgba }, [out.rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
