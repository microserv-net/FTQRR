import { dropletIndexes, solitonCDF, xorInto } from './oqtp.js';

/**
 * Belief-propagation ("peeling") decoder for OQTP droplets.
 *
 * Chunks are handed to a store as soon as they are solved, so the decoder
 * itself holds only the droplets it has not been able to reduce yet. When a
 * later droplet references a chunk the store has already written out, the
 * decoder reads it back — which is why push() is async.
 */
export class FountainDecoder {
  constructor(K, chunkSize, store, indexFn) {
    this.indexFn = indexFn || dropletIndexes;
    this.K = K;
    this.chunkSize = chunkSize;
    this.store = store;
    this.cdf = solitonCDF(K);
    this.solved = new Uint8Array(K); // 1 = chunk is written to the store
    this.solvedCount = 0;
    this.pending = new Set(); // droplets waiting for more information
    this.byIndex = new Map(); // chunk index -> Set of pending droplets
    this.seenSeeds = new Set(); // duplicate frames are free to reject
    this.stats = { accepted: 0, duplicates: 0, redundant: 0 };
  }

  get complete() {
    return this.solvedCount === this.K;
  }

  get missing() {
    return this.K - this.solvedCount;
  }

  isDuplicate(seed) {
    return this.seenSeeds.has(seed);
  }

  /** @returns {Promise<number>} how many new chunks this droplet unlocked */
  async push(seed, payload) {
    if (this.seenSeeds.has(seed)) {
      this.stats.duplicates++;
      return 0;
    }
    this.seenSeeds.add(seed);
    this.stats.accepted++;

    let data = new Uint8Array(this.chunkSize);
    data.set(payload.subarray(0, this.chunkSize));

    let idxs = this.indexFn(seed, this.K, this.cdf).filter((i) => i < this.K);

    // Cancel out every part of this droplet we already know.
    const remaining = [];
    for (const i of idxs) {
      if (this.solved[i]) {
        xorInto(data, await this.store.read(i));
      } else {
        remaining.push(i);
      }
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

    // Peel: every solved chunk may collapse other droplets down to degree 1.
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

  reset() {
    this.solved.fill(0);
    this.solvedCount = 0;
    this.pending.clear();
    this.byIndex.clear();
    this.seenSeeds.clear();
    this.stats = { accepted: 0, duplicates: 0, redundant: 0 };
  }
}
