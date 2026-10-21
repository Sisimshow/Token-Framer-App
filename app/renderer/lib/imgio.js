// Image decode / PNG encode for the tool workers (OffscreenCanvas, so worker-only).

/** Decodes image bytes to straight RGBA ImageData; no colour conversion and no premultiplication, so the file's own values are used. */
export async function decode(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return d;
}

export async function toPng(rgba, w, h) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
