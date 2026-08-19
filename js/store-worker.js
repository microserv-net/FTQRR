/* Random-access file handle for the chunk store. Synchronous access
   handles only exist inside a worker, which is the whole reason this
   file exists. */

let handle = null;

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    if (op === 'open') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('oqtp', { create: true });
      const fh = await dir.getFileHandle(e.data.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      handle.truncate(e.data.size);
      handle.flush();
      self.postMessage({ id, ok: true });
    } else if (op === 'write') {
      handle.write(e.data.data, { at: e.data.pos });
      self.postMessage({ id, ok: true });
    } else if (op === 'read') {
      const buf = new Uint8Array(e.data.len);
      handle.read(buf, { at: e.data.pos });
      self.postMessage({ id, ok: true, data: buf }, [buf.buffer]);
    } else if (op === 'flush') {
      handle.flush();
      self.postMessage({ id, ok: true });
    } else if (op === 'close') {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      self.postMessage({ id, ok: true });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
