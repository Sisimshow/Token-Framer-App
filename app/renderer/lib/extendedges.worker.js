// Runs the Extend edges maths off the UI thread. `load` keeps the picture, `extend` pads it with the given settings (see extendedges.js).
// `scale` < 1 builds a reduced-size PREVIEW: the picture is shrunk (Lanczos) and the padding scaled with it, so a big image follows the controls quickly.
import { resizeLanczos } from './cleanframe.js';
import { extendEdges } from './extendedges.js';

let src = null;      // { rgba, w, h }
let small = null;    // the last shrunk copy: { w, h, rgba }

self.onmessage = ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'load') {
      src = { rgba: new Uint8ClampedArray(data.rgba), w: data.w, h: data.h };
      small = null;
      self.postMessage({ type, id });
    } else if (type === 'extend') {
      if (!src) throw new Error('No image loaded');
      const scale = data.scale > 0 && data.scale < 1 ? data.scale : 1;
      let pic = src, params = data.params;
      if (scale < 1) {
        const w = Math.max(1, Math.round(src.w * scale)), h = Math.max(1, Math.round(src.h * scale));
        if (!small || small.w !== w || small.h !== h) small = { w, h, rgba: resizeLanczos(src.rgba, src.w, src.h, w, h) };
        pic = small;
        params = { ...params };
        for (const k of ['top', 'right', 'bottom', 'left']) params[k] = Math.round((params[k] || 0) * scale);
      }
      const out = extendEdges(pic.rgba, pic.w, pic.h, params);
      self.postMessage({ type, id, w: out.w, h: out.h, rgba: out.rgba, inner: { x: params.left | 0, y: params.top | 0, w: pic.w, h: pic.h }, scale }, [out.rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
