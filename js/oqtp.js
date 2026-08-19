/* ------------------------------------------------------------------
   OQTP/2 — Optical QR Transport Protocol
   Shared core: packet framing, integrity, and the rateless fountain
   code that lets a receiver rebuild a file from ANY sufficient set of
   frames instead of one specific set.

   This file is byte-identical in /sender and /receiver. Both sides
   must agree on every constant here.
   ------------------------------------------------------------------ */

export const MAGIC = 0x51; // 'Q'
export const VERSION = 2;
export const T_DROPLET = 1;
export const T_META = 2;

export const DROPLET_HEADER = 8; // magic, verType, tid(2), seed(4)
export const META_HEADER = 4; // magic, verType, tid(2)
export const CRC_LEN = 2;
export const DROPLET_OVERHEAD = DROPLET_HEADER + CRC_LEN; // 10 bytes per frame

/* ---------------------------- integrity ---------------------------- */

// CRC-16/CCITT-FALSE. QR has its own Reed-Solomon ECC, but this catches
// the rare case where a mis-decoded frame produces structurally valid
// bytes, and it is cheap enough to run on every frame.
export function crc16(bytes, from = 0, to = bytes.length) {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/* ------------------------- binary <-> string ------------------------ */

// QR byte mode carries raw octets. qrcode-generator's default
// stringToBytes is latin-1 (charCodeAt & 0xff), so a latin-1 string is a
// lossless carrier for arbitrary bytes.
export function bytesToLatin1(bytes) {
  let out = '';
  const STEP = 4096;
  for (let i = 0; i < bytes.length; i += STEP) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return out;
}

export function latin1ToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* ---------------------------- framing ------------------------------ */

export function buildDroplet(tid, seed, payload) {
  const p = new Uint8Array(DROPLET_OVERHEAD + payload.length);
  const dv = new DataView(p.buffer);
  p[0] = MAGIC;
  p[1] = (VERSION << 4) | T_DROPLET;
  dv.setUint16(2, tid, true);
  dv.setUint32(4, seed >>> 0, true);
  p.set(payload, DROPLET_HEADER);
  dv.setUint16(p.length - 2, crc16(p, 0, p.length - 2), true);
  return p;
}

export function buildMeta(tid, metaObj) {
  const json = new TextEncoder().encode(JSON.stringify(metaObj));
  const p = new Uint8Array(META_HEADER + json.length + CRC_LEN);
  const dv = new DataView(p.buffer);
  p[0] = MAGIC;
  p[1] = (VERSION << 4) | T_META;
  dv.setUint16(2, tid, true);
  p.set(json, META_HEADER);
  dv.setUint16(p.length - 2, crc16(p, 0, p.length - 2), true);
  return p;
}

/** Returns {type, tid, seed, payload} | {type:'meta', tid, meta} | null */
export function parsePacket(bytes) {
  if (!bytes || bytes.length < META_HEADER + CRC_LEN) return null;
  if (bytes[0] !== MAGIC) return null;
  if (bytes[1] >> 4 !== VERSION) return null;
  const type = bytes[1] & 0x0f;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const want = dv.getUint16(bytes.length - 2, true);
  if (crc16(bytes, 0, bytes.length - 2) !== want) return null;
  const tid = dv.getUint16(2, true);
  if (type === T_DROPLET) {
    if (bytes.length <= DROPLET_OVERHEAD) return null;
    return {
      type: 'droplet',
      tid,
      seed: dv.getUint32(4, true) >>> 0,
      payload: bytes.slice(DROPLET_HEADER, bytes.length - 2),
    };
  }
  if (type === T_META) {
    try {
      const json = new TextDecoder().decode(bytes.subarray(META_HEADER, bytes.length - 2));
      return { type: 'meta', tid, meta: JSON.parse(json) };
    } catch (e) {
      return null;
    }
  }
  return null;
}

/* --------------------------- fountain code -------------------------- */

/*  Every frame is a "droplet": the XOR of a pseudo-random subset of the
    file's chunks, identified only by a 32-bit seed. Both sides derive the
    same subset from the same seed, so no frame is special and no frame
    needs to be re-requested — the receiver simply collects droplets until
    the system of equations solves.

    Seeds 0..K-1 are reserved and mean "chunk N, plain". The sender emits
    those first, so a clean, well-lit transfer finishes in exactly K frames
    with zero coding overhead; only the frames that were actually missed
    get paid for, in the random phase that follows.                       */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Robust soliton distribution, as a cumulative table indexed by degree-1. */
export function solitonCDF(K, c = 0.03, delta = 0.05) {
  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let i = 2; i <= K; i++) rho[i] = 1 / (i * (i - 1));

  const R = Math.max(1, c * Math.log(K / delta) * Math.sqrt(K));
  const pivot = Math.floor(K / R);
  const tau = new Float64Array(K + 1);
  for (let i = 1; i < pivot; i++) tau[i] = R / (i * K);
  if (pivot >= 1 && pivot <= K) tau[pivot] = (R * Math.log(R / delta)) / K;

  let total = 0;
  for (let i = 1; i <= K; i++) total += rho[i] + tau[i];

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let i = 1; i <= K; i++) {
    acc += (rho[i] + tau[i]) / total;
    cdf[i] = acc;
  }
  cdf[K] = 1;
  return cdf;
}

function sampleDegree(cdf, r) {
  let lo = 1;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/*  Degree schedule for the random phase.

    Textbook LT uses the soliton distribution alone, which assumes the
    receiver starts from nothing. Here it starts from the systematic pass
    with most of the file already in hand, and in that regime soliton
    wastes frames: half its droplets are degree 2, and a degree-2 droplet
    usually touches two chunks the receiver already has.

    Which schedule is best depends on something both sides can work out for
    themselves — how big the file is:

      Small enough to solve (K <= ML_SAFE_K)
        The receiver can run Gaussian elimination over everything it holds,
        so a droplet that peeling cannot use is still a usable equation.
        That makes heavy droplets worth sending: they are far more likely to
        touch a missing chunk, and nothing is lost when they cannot be
        peeled. Measured 1.12x of ideal at 5% loss, 1.87x at 45%.

      Larger (K > ML_SAFE_K)
        Early on there are more unknowns than the solver's work budget
        allows, so peeling has to carry the transfer alone — and heavy
        droplets peel badly (3.2x at 45% loss, worse than doing nothing
        clever). So the mixed schedule is used, which peels well on its own.
        The solver still takes over for the endgame, once the number of
        missing chunks falls below its limit, which is exactly where peeling
        is weakest.

    K travels in the metadata frame, so both sides pick the same schedule
    without a single extra byte on the wire.                               */
const ML_SAFE_K = 1500;
/*  Below this, heavy droplets stop being distinguishable: every degree in the
    ladder caps to K, so each droplet is the XOR of nearly all the chunks —
    the same equation over and over, carrying no new information. A handful of
    chunks is better served by the mixed schedule, which still produces low
    degrees.  */
const SMALL_K = 32;
const DEGREE_LADDER = [1, 2, 2, 3, 4, 6, 9, 14, 21, 32, 48, 72];
const HEAVY_LADDER = [2, 3, 4, 6, 9, 14, 21, 32, 48, 72, 108, 162];

/**
 * The chunk indexes a droplet is built from. Deterministic on both sides.
 * @returns {number[]}
 */
export function dropletIndexes(seed, K, cdf) {
  if (seed < K) return [seed]; // systematic pass
  const step = seed - K;
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  let d;
  if (K > SMALL_K && K <= ML_SAFE_K) {
    d = HEAVY_LADDER[step % HEAVY_LADDER.length];
  } else {
    d = step % 2 === 0 ? sampleDegree(cdf, rnd()) : DEGREE_LADDER[step % DEGREE_LADDER.length];
  }
  if (d > K) d = K;
  if (d === 1) return [Math.floor(rnd() * K) % K];
  const picked = new Set();
  let guard = 0;
  while (picked.size < d && guard++ < d * 12) picked.add(Math.floor(rnd() * K) % K);
  // Deterministic completion if rejection sampling stalls on a small K.
  for (let i = 0; picked.size < d; i++) picked.add(i);
  return Array.from(picked);
}

export function xorInto(target, source) {
  const n = Math.min(target.length, source.length);
  for (let i = 0; i < n; i++) target[i] ^= source[i];
}

/* ------------------------------ helpers ----------------------------- */

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '<1s';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function b64(bytes) {
  return btoa(bytesToLatin1(bytes));
}

export function unb64(str) {
  return latin1ToBytes(atob(str));
}
