/* ------------------------------------------------------------------
   Incremental SHA-256.

   WebCrypto's digest() needs the whole message in one buffer, which
   defeats the point of streaming a large file through the transfer. This
   is a plain incremental implementation: feed it slices, ask for the
   digest at the end.
   ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class SHA256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ]);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.length = 0; // bytes consumed
  }

  _block(bytes, offset) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const H = this.h;
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }

  update(bytes) {
    this.length += bytes.length;
    let i = 0;
    if (this.bufLen) {
      const need = 64 - this.bufLen;
      if (bytes.length < need) {
        this.buf.set(bytes, this.bufLen);
        this.bufLen += bytes.length;
        return this;
      }
      this.buf.set(bytes.subarray(0, need), this.bufLen);
      this._block(this.buf, 0);
      this.bufLen = 0;
      i = need;
    }
    for (; i + 64 <= bytes.length; i += 64) this._block(bytes, i);
    if (i < bytes.length) {
      this.buf.set(bytes.subarray(i), 0);
      this.bufLen = bytes.length - i;
    }
    return this;
  }

  digest() {
    const bitLen = this.length * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const dv = new DataView(tail.buffer);
    dv.setUint32(padLen, Math.floor(bitLen / 4294967296));
    dv.setUint32(padLen + 4, bitLen >>> 0);
    this.length -= tail.length; // padding is not message length
    this.update(tail);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.h[i] >>> 0);
    return out;
  }

  hex() {
    const d = this.digest();
    let s = '';
    for (let i = 0; i < 32; i++) s += d[i].toString(16).padStart(2, '0');
    return s;
  }
}

/** Hash a Blob/File in slices, reporting progress. Never holds it all in RAM. */
export async function hashBlob(blob, onProgress, sliceSize = 4 * 1024 * 1024) {
  const h = new SHA256();
  let done = 0;
  for (let off = 0; off < blob.size; off += sliceSize) {
    const part = blob.slice(off, Math.min(off + sliceSize, blob.size));
    h.update(new Uint8Array(await part.arrayBuffer()));
    done += part.size;
    if (onProgress) onProgress(done / (blob.size || 1));
    await Promise.resolve();
  }
  return h.hex();
}
