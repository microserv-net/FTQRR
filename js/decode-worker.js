/* QR detection runs here so that a slow frame never stutters the camera
   preview or the progress readouts. */

importScripts('vendor/jsQR.js');

self.onmessage = (e) => {
  const { buf, w, h, id } = e.data;
  const data = new Uint8ClampedArray(buf);
  let bytes = null;
  try {
    // dontInvert: the sender always draws dark-on-light, and skipping the
    // inverted pass roughly halves the work per frame.
    const res = self.jsQR(data, w, h, { inversionAttempts: 'dontInvert' });
    if (res && res.binaryData && res.binaryData.length) {
      bytes = Uint8Array.from(res.binaryData);
    }
  } catch (err) {
    bytes = null;
  }
  if (bytes) self.postMessage({ id, bytes }, [bytes.buffer]);
  else self.postMessage({ id, bytes: null });
};
