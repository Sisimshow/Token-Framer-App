// Resizes an RGBA image off the UI thread (Pillow-exact Lanczos3, see cleanframe.js). Used to bring a 4x upscaler's result down to 2x or 3x.
import { resizeLanczos } from './cleanframe.js';

self.onmessage = ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'resize') {
      const out = resizeLanczos(new Uint8ClampedArray(data.rgba), data.sw, data.sh, data.dw, data.dh);
      self.postMessage({ type, id, w: data.dw, h: data.dh, rgba: out }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
