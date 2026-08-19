/* ------------------------------------------------------------------
   Where solved chunks live while a transfer is in flight.

   Small file  -> plain memory.
   Large file  -> the browser's private file system, written at the right
                  offset the moment each chunk is solved, so a 200 MB
                  transfer never needs 200 MB of RAM.

   Both backends expose the same four calls, so the decoder does not know
   or care which one it got. If anything about the disk path fails, the
   store falls back to memory rather than failing the transfer.
   ------------------------------------------------------------------ */

const DISK_THRESHOLD = 8 * 1024 * 1024;

class MemoryStore {
  constructor(size, chunkSize, K) {
    this.kind = 'memory';
    this.size = size;
    this.chunkSize = chunkSize;
    this.chunks = new Array(K);
    this.zero = new Uint8Array(chunkSize);
  }
  async write(idx, data) {
    this.chunks[idx] = data.slice(0, this.chunkSize);
  }
  async read(idx) {
    return this.chunks[idx] || this.zero;
  }
  async blob(type) {
    const parts = [];
    let left = this.size;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] || this.zero;
      parts.push(c.subarray(0, Math.min(this.chunkSize, left)));
      left -= this.chunkSize;
      if (left <= 0) break;
    }
    return new Blob(parts, { type: type || 'application/octet-stream' });
  }
  async dispose() {
    this.chunks = [];
  }
}

class DiskStore {
  constructor(size, chunkSize, worker, fileName) {
    this.kind = 'disk';
    this.size = size;
    this.chunkSize = chunkSize;
    this.worker = worker;
    this.fileName = fileName;
    this.seq = 0;
    this.waiting = new Map();
    worker.onmessage = (e) => {
      const { id } = e.data;
      const slot = this.waiting.get(id);
      if (!slot) return;
      this.waiting.delete(id);
      e.data.ok ? slot.resolve(e.data) : slot.reject(new Error(e.data.error));
    };
  }
  _call(op, args, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...args }, transfer || []);
    });
  }
  async write(idx, data) {
    const pos = idx * this.chunkSize;
    const len = Math.max(0, Math.min(this.chunkSize, this.size - pos));
    if (!len) return;
    const slice = data.slice(0, len);
    await this._call('write', { pos, data: slice }, [slice.buffer]);
  }
  async read(idx) {
    const pos = idx * this.chunkSize;
    const res = await this._call('read', { pos, len: this.chunkSize });
    return res.data;
  }
  async blob(type) {
    await this._call('flush', {});
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('oqtp', { create: true });
    const fh = await dir.getFileHandle(this.fileName, { create: false });
    const file = await fh.getFile();
    return file.slice(0, this.size, type || 'application/octet-stream');
  }
  async dispose() {
    try {
      await this._call('close', {});
    } catch (e) {
      /* already gone */
    }
    this.worker.terminate();
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('oqtp', { create: true });
      await dir.removeEntry(this.fileName);
    } catch (e) {
      /* nothing to clean up */
    }
  }
}

export async function createStore(size, chunkSize, K) {
  if (size >= DISK_THRESHOLD && 'storage' in navigator && navigator.storage.getDirectory) {
    try {
      const worker = new Worker('js/store-worker.js');
      const fileName = 'recv-' + Date.now() + '.part';
      const store = new DiskStore(size, chunkSize, worker, fileName);
      await store._call('open', { name: fileName, size });
      return store;
    } catch (e) {
      console.warn('Falling back to memory store:', e);
    }
  }
  return new MemoryStore(size, chunkSize, K);
}
