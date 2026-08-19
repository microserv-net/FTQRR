import { dropletIndexes, solitonCDF, xorInto } from './oqtp.js';

/* Bounded so a huge file cannot lock the interface up. The elimination costs
   about rows × unknowns × unknowns/32 word operations. */
const ML_MAX_UNKNOWNS = 2000;
const ML_WORK_BUDGET = 3e8;
const ML_MIN_NEW_ROWS = 4; // don't re-run for every single frame

const POP = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP[i] = POP[i >> 1] + (i & 1);
function popcount32(x) {
  return POP[x & 255] + POP[(x >>> 8) & 255] + POP[(x >>> 16) & 255] + POP[(x >>> 24) & 255];
}

/**
 * Decoder for OQTP droplets, in two gears.
 *
 * Gear one is the usual peeling: a droplet whose chunks are all known except
 * one hands over that chunk, which may in turn collapse other droplets.
 * Cheap, incremental, and what runs on almost every frame.
 *
 * Gear two exists because peeling gives up early. A droplet carrying four
 * unknown chunks is not useless — it is one equation in four unknowns, and
 * once enough such equations pile up they solve as a system even though no
 * single one of them ever reaches degree one. When peeling stalls with
 * enough independent droplets in hand, the decoder eliminates over GF(2) and
 * recovers every remaining chunk at once.
 */
export class FountainDecoder {
  constructor(K, chunkSize, store, indexFn) {
    this.indexFn = indexFn || dropletIndexes;
    this.K = K;
    this.chunkSize = chunkSize;
    this.store = store;
    this.cdf = solitonCDF(K);
    this.solved = new Uint8Array(K);
    this.solvedCount = 0;
    this.pending = new Set();
    this.byIndex = new Map();
    this.seenSeeds = new Set();
    this.stats = { accepted: 0, duplicates: 0, redundant: 0, peeled: 0, solvedTogether: 0, mlRuns: 0 };
    this.lastSolveSize = 0; // how many chunks the last full solve recovered
    this.busySolving = false;
    this._triedAt = -1; // pending-set size at the last failed attempt
  }

  get complete() { return this.solvedCount === this.K; }
  get missing() { return this.K - this.solvedCount; }

  isDuplicate(seed) { return this.seenSeeds.has(seed); }

  /** @returns {Promise<number>} how many new chunks this droplet unlocked */
  async push(seed, payload) {
    if (this.seenSeeds.has(seed)) {
      this.stats.duplicates++;
      return 0;
    }
    this.seenSeeds.add(seed);
    this.stats.accepted++;

    const data = new Uint8Array(this.chunkSize);
    data.set(payload.subarray(0, this.chunkSize));

    const idxs = this.indexFn(seed, this.K, this.cdf).filter((i) => i < this.K);

    // Cancel out every part of this droplet we already know.
    const remaining = [];
    for (const i of idxs) {
      if (this.solved[i]) xorInto(data, await this.store.read(i));
      else remaining.push(i);
    }

    if (remaining.length === 0) {
      this.stats.redundant++;
      return 0;
    }

    let unlocked = 0;
    const queue = [];
    if (remaining.length === 1) {
      queue.push([remaining[0], data]);
    } else {
      const droplet = { idxs: new Set(remaining), data };
      this.pending.add(droplet);
      for (const i of remaining) {
        let set = this.byIndex.get(i);
        if (!set) this.byIndex.set(i, (set = new Set()));
        set.add(droplet);
      }
    }

    unlocked += await this._peel(queue);
    this.stats.peeled += unlocked;

    // Peeling has run dry. The droplets it could not use are still equations;
    // see whether they solve as a system.
    if (unlocked === 0 && this.missing > 0 && this._worthSolving()) {
      unlocked += await this.solveSystem();
    }
    return unlocked;
  }

  async _peel(queue) {
    let unlocked = 0;
    while (queue.length) {
      const [idx, chunkData] = queue.pop();
      if (this.solved[idx]) continue;
      this.solved[idx] = 1;
      this.solvedCount++;
      unlocked++;
      await this.store.write(idx, chunkData);

      const dependents = this.byIndex.get(idx);
      if (!dependents) continue;
      this.byIndex.delete(idx);
      for (const d of dependents) {
        if (!this.pending.has(d)) continue;
        xorInto(d.data, chunkData);
        d.idxs.delete(idx);
        if (d.idxs.size === 1) {
          const last = d.idxs.values().next().value;
          this.pending.delete(d);
          const set = this.byIndex.get(last);
          if (set) set.delete(d);
          queue.push([last, d.data]);
        }
      }
    }
    return unlocked;
  }

  _worthSolving() {
    if (this.pending.size < 2) return false;
    if (this.missing > ML_MAX_UNKNOWNS) return false;
    // Only bother once a few more equations have come in since the last
    // attempt that found nothing.
    if (this._triedAt >= 0 && this.pending.size - this._triedAt < ML_MIN_NEW_ROWS) return false;
    const words = (this.missing + 31) >> 5;
    return this.pending.size * this.missing * words <= ML_WORK_BUDGET;
  }

  /**
   * Gaussian elimination over GF(2) across every droplet peeling could not use.
   *
   * This is where one QR code can hand over several missing chunks at once.
   * A single droplet blending four unknowns is one equation in four unknowns
   * and peeling discards it; but four such droplets, overlapping the right
   * way, determine all four chunks together. Elimination extracts exactly the
   * chunks the accumulated set determines — not only when the whole system
   * solves, but any partial solution hiding inside it.
   *
   * The pass over the index bitsets runs first and alone. If it turns out
   * nothing new is determined, the attempt is abandoned there, before a
   * single payload byte has been touched. That is what makes it safe to try
   * speculatively as droplets arrive.
   *
   * @returns {Promise<number>} chunks recovered
   */
  async solveSystem() {
    const rows = [...this.pending];
    const col = new Map();
    const unknown = [];
    for (let i = 0; i < this.K; i++) {
      if (!this.solved[i]) {
        col.set(i, unknown.length);
        unknown.push(i);
      }
    }
    const m = unknown.length;
    if (!m || rows.length < 2) return 0;

    this.busySolving = true;
    this.stats.mlRuns++;
    const words = (m + 31) >> 5;

    const bits = rows.map((r) => {
      const b = new Uint32Array(words);
      for (const i of r.idxs) {
        const c = col.get(i);
        if (c !== undefined) b[c >> 5] |= 1 << (c & 31);
      }
      return b;
    });

    // ── pass one: bitsets only, recording what would happen to the payloads
    const ops = [];
    const used = new Uint8Array(rows.length);

    for (let c = 0; c < m; c++) {
      const w = c >> 5;
      const bit = 1 << (c & 31);
      let p = -1;
      for (let r = 0; r < rows.length; r++) {
        if (!used[r] && bits[r][w] & bit) { p = r; break; }
      }
      if (p < 0) continue; // free column: nothing determines it yet
      used[p] = 1;
      const pb = bits[p];
      for (let r = 0; r < rows.length; r++) {
        if (r === p || !(bits[r][w] & bit)) continue;
        const rb = bits[r];
        for (let k = 0; k < words; k++) rb[k] ^= pb[k];
        ops.push(r, p);
      }
    }

    // Which rows came out carrying exactly one unknown? Those are chunks.
    const found = [];
    const claimed = new Set();
    for (let r = 0; r < rows.length; r++) {
      let n = 0;
      let only = -1;
      for (let k = 0; k < words && n < 2; k++) {
        const v = bits[r][k];
        if (!v) continue;
        n += popcount32(v);
        if (only < 0) only = (k << 5) + (31 - Math.clz32(v & -v));
      }
      if (n === 1 && !claimed.has(only)) {
        claimed.add(only);
        found.push([only, r]);
      }
    }

    if (!found.length) {
      // Nothing new is determined. No payload work was done.
      this.busySolving = false;
      this._triedAt = this.pending.size;
      return 0;
    }

    // ── pass two: the same operations, now on the bytes
    for (let k = 0; k < ops.length; k += 2) xorInto(rows[ops[k]].data, rows[ops[k + 1]].data);

    let recovered = 0;
    for (const [c, r] of found) {
      const idx = unknown[c];
      if (this.solved[idx]) continue;
      this.solved[idx] = 1;
      this.solvedCount++;
      recovered++;
      await this.store.write(idx, rows[r].data);
    }

    // Keep the reduced equations: they are simpler than what went in, so the
    // next attempt starts from better ground.
    const keep = [];
    for (let r = 0; r < rows.length; r++) {
      let n = 0;
      for (let k = 0; k < words; k++) n += popcount32(bits[r][k]);
      if (n < 2) continue;
      const idxs = new Set();
      for (let c = 0; c < m; c++) {
        if (bits[r][c >> 5] & (1 << (c & 31))) idxs.add(unknown[c]);
      }
      keep.push({ idxs, data: rows[r].data });
    }

    this.pending.clear();
    this.byIndex.clear();
    const queue = [];
    for (const d of keep) {
      // fold in anything solved during this pass
      for (const i of [...d.idxs]) {
        if (this.solved[i]) {
          xorInto(d.data, await this.store.read(i));
          d.idxs.delete(i);
        }
      }
      if (d.idxs.size === 0) continue;
      if (d.idxs.size === 1) {
        queue.push([d.idxs.values().next().value, d.data]);
        continue;
      }
      this.pending.add(d);
      for (const i of d.idxs) {
        let set = this.byIndex.get(i);
        if (!set) this.byIndex.set(i, (set = new Set()));
        set.add(d);
      }
    }
    recovered += await this._peel(queue);

    this.stats.solvedTogether += recovered;
    this.lastSolveSize = recovered;
    this.busySolving = false;
    this._triedAt = -1;
    return recovered;
  }

  reset() {
    this.solved.fill(0);
    this.solvedCount = 0;
    this.pending.clear();
    this.byIndex.clear();
    this.seenSeeds.clear();
    this.stats = { accepted: 0, duplicates: 0, redundant: 0, peeled: 0, solvedTogether: 0, mlRuns: 0 };
    this.lastSolveSize = 0;
    this._triedAt = -1;
  }
}
