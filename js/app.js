import { parsePacket, formatBytes, formatDuration, unb64 } from './oqtp.js';
import { FountainDecoder } from './fountain-decoder.js';
import { createStore } from './store.js';
import { hashBlob } from './sha256.js';

const $ = (id) => document.getElementById(id);

const state = {
  stream: null,
  track: null,
  devices: [],
  deviceIdx: 0,
  scanning: false,
  paused: false,

  tid: null,
  meta: null,
  decoder: null,
  store: null,
  buffered: [], // droplets that arrived before the file details did
  framesUsed: 0,
  foreign: 0,
  startedAt: 0,
  firstHitAt: 0,

  attempts: 0,
  hits: 0,
  lastSampleAt: 0,
  rate: 0,
  hitRate: 0,
  lastSolvedCount: 0,
  solvedRate: 0,

  blob: null,
  wakeLock: null,
  busy: false,
  queue: [],
};

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function show(stage) {
  for (const s of ['stage-idle', 'stage-scan', 'stage-done']) $(s).hidden = s !== stage;
}

/* ─────────────────────────  camera  ───────────────────────── */

const video = $('video');

$('start').addEventListener('click', () => startCamera());

async function startCamera(deviceId) {
  $('cam-err').hidden = true;
  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
  };

  try {
    stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.track = state.stream.getVideoTracks()[0];
    video.srcObject = state.stream;
    await video.play();

    show('stage-scan');
    sizeRibbon();
    requestWakeLock();
    await setupCameraTools();

    state.scanning = true;
    state.paused = false;
    state.lastSampleAt = performance.now();
    requestAnimationFrame(grab);
    tickTelemetry();
  } catch (err) {
    const el = $('cam-err');
    el.hidden = false;
    el.textContent =
      err.name === 'NotAllowedError'
        ? 'The camera is blocked. Allow camera access for this page in your browser settings, then try again.'
        : err.name === 'NotFoundError'
        ? 'No camera found on this device.'
        : err.name === 'NotReadableError'
        ? 'Another app is using the camera. Close it and try again.'
        : 'The camera could not start: ' + err.message + '. This page must be served over https:// or from localhost.';
  }
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.track = null;
}

async function setupCameraTools() {
  try {
    const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};

    if (caps.torch) {
      $('torch').hidden = false;
      $('torch').onclick = async () => {
        const on = !$('torch').classList.contains('is-on');
        try {
          await state.track.applyConstraints({ advanced: [{ torch: on }] });
          $('torch').classList.toggle('is-on', on);
        } catch (e) {
          toast('This camera will not switch its light on.');
        }
      };
    }

    // Continuous focus helps a lot when the sender's screen is close.
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await state.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }

    state.devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput'
    );
    if (state.devices.length > 1) {
      $('swap').hidden = false;
      $('swap').onclick = () => {
        state.deviceIdx = (state.deviceIdx + 1) % state.devices.length;
        startCamera(state.devices[state.deviceIdx].deviceId);
      };
    }
  } catch (e) {
    /* capability probing is best-effort */
  }
}

/* ─────────────────────────  capture loop  ───────────────────────── */

const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const CAP = 720; // longest side handed to the decoder

let worker = null;
let workerBusy = false;
let fallbackDecode = null;

function initWorker() {
  try {
    worker = new Worker('js/decode-worker.js');
    worker.onmessage = (e) => {
      workerBusy = false;
      if (e.data.bytes) onBytes(e.data.bytes);
    };
    worker.onerror = () => {
      worker = null;
      loadFallback();
    };
  } catch (e) {
    loadFallback();
  }
}

// If workers are unavailable (some file:// and embedded contexts), decode on
// the main thread instead of giving up.
function loadFallback() {
  if (fallbackDecode) return;
  const s = document.createElement('script');
  s.src = 'js/vendor/jsQR.js';
  s.onload = () => {
    fallbackDecode = (data, w, h) => {
      const r = window.jsQR(data, w, h, { inversionAttempts: 'dontInvert' });
      return r && r.binaryData && r.binaryData.length ? Uint8Array.from(r.binaryData) : null;
    };
  };
  document.head.appendChild(s);
}

initWorker();

function grab() {
  if (!state.scanning) return;
  requestAnimationFrame(grab);
  if (state.paused || video.readyState < 2) return;
  if (workerBusy) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // Only the square inside the reticle is examined: less pixels per attempt
  // means more attempts per second, which matters more than field of view.
  const side = Math.min(vw, vh) * 0.82;
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;
  const out = Math.min(CAP, Math.round(side));
  if (work.width !== out) {
    work.width = out;
    work.height = out;
  }
  wctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
  const img = wctx.getImageData(0, 0, out, out);
  state.attempts++;

  if (worker) {
    workerBusy = true;
    worker.postMessage({ buf: img.data.buffer, w: out, h: out }, [img.data.buffer]);
  } else if (fallbackDecode) {
    const bytes = fallbackDecode(img.data, out, out);
    if (bytes) onBytes(bytes);
  }
}

/* ─────────────────────────  packets  ───────────────────────── */

function flashLock() {
  const r = $('reticle');
  r.classList.add('is-lock');
  clearTimeout(flashLock.t);
  flashLock.t = setTimeout(() => r.classList.remove('is-lock'), 130);
}

function onBytes(bytes) {
  const pkt = parsePacket(bytes);
  if (!pkt) return; // not ours, or the frame was misread — CRC caught it
  state.hits++;
  flashLock();

  if (pkt.type === 'meta') {
    if (state.tid === null) initTransfer(pkt);
    else if (pkt.tid !== state.tid) state.foreign++;
    return;
  }

  if (state.tid === null) {
    // Details have not arrived yet. Hold on to the droplet rather than
    // wasting a frame that took real effort to catch.
    if (state.buffered.length < 400) state.buffered.push(pkt);
    return;
  }
  if (pkt.tid !== state.tid) {
    state.foreign++;
    return;
  }
  enqueue(pkt);
}

function enqueue(pkt) {
  if (!state.decoder || state.decoder.complete) return;
  if (state.decoder.isDuplicate(pkt.seed)) {
    state.decoder.stats.duplicates++;
    return;
  }
  state.queue.push(pkt);
  drain();
}

async function drain() {
  if (state.busy) return;
  state.busy = true;
  try {
    while (state.queue.length) {
      const pkt = state.queue.shift();
      if (!state.decoder || state.decoder.complete) break;
      await state.decoder.push(pkt.seed, pkt.payload);
      state.framesUsed++;
      if (state.decoder.complete) {
        finish();
        break;
      }
    }
  } catch (err) {
    console.error(err);
    toast('Something went wrong while rebuilding: ' + err.message, 5000);
  } finally {
    state.busy = false;
  }
}

async function initTransfer(pkt) {
  const m = pkt.meta;
  if (!m || !m.k || !m.c || !m.s) return;

  state.tid = pkt.tid;
  state.meta = m;
  state.startedAt = performance.now();
  state.framesUsed = 0;

  state.store = await createStore(m.s, m.c, m.k);
  state.decoder = new FountainDecoder(m.k, m.c, state.store);

  $('s-name').textContent = m.n || 'Unnamed file';
  $('s-eyebrow').textContent = m.e ? 'Incoming · encrypted' : 'Incoming';
  $('t-store').textContent = state.store.kind === 'disk' ? 'browser storage' : 'memory';
  $('v-status').textContent = `Reading ${m.n || 'file'} — ${formatBytes(m.s)}`;
  sizeRibbon();

  const held = state.buffered;
  state.buffered = [];
  for (const d of held) if (d.tid === state.tid) enqueue(d);
}

/* ─────────────────────────  telemetry  ───────────────────────── */

function tickTelemetry() {
  if (!state.scanning) return;
  const now = performance.now();
  const dt = (now - state.lastSampleAt) / 1000;

  if (dt >= 0.5) {
    state.rate = state.attempts / dt;
    state.hitRate = state.hits / dt;
    const solved = state.decoder ? state.decoder.solvedCount : 0;
    state.solvedRate = state.solvedRate * 0.6 + ((solved - state.lastSolvedCount) / dt) * 0.4;
    state.lastSolvedCount = solved;
    state.attempts = 0;
    state.hits = 0;
    state.lastSampleAt = now;
  }

  $('t-rate').textContent = `${state.hitRate.toFixed(0)} of ${state.rate.toFixed(0)} /s`;

  if (state.decoder) {
    const d = state.decoder;
    const pct = (d.solvedCount / d.K) * 100;
    $('s-bar').style.width = pct.toFixed(2) + '%';
    $('s-pct').textContent = pct.toFixed(1) + '%';
    $('s-chunks').textContent = `${d.solvedCount.toLocaleString()} of ${d.K.toLocaleString()} chunks`;
    $('t-missing').textContent = d.missing.toLocaleString();
    $('t-useful').textContent = `${d.stats.accepted.toLocaleString()} of ${(
      d.stats.accepted + d.stats.duplicates
    ).toLocaleString()}`;
    $('t-dup').textContent = d.stats.duplicates.toLocaleString();
    $('t-eta').textContent =
      state.solvedRate > 0.05 ? formatDuration(d.missing / state.solvedRate) : 'hold steady…';

    // One honest sentence about what is going wrong, when something is.
    let q = '';
    if (state.hitRate < 0.4 && state.rate > 2) q = 'Nothing is decoding. Move closer, or steady the camera.';
    else if (d.stats.duplicates > 40 && state.solvedRate < 0.5)
      q = 'Reading the same frame over and over — ask the sender to speed up.';
    else if (state.hitRate > 3 && state.solvedRate < 0.2 && d.missing > 0)
      q = 'Frames are landing but few are new. Keep going; the repair stream will fill the gaps.';
    $('quality').textContent = q;
  }

  drawRibbon();
  setTimeout(tickTelemetry, 300);
}

/* ── the ribbon, mirrored from the transmitter ── */

const ribbon = $('ribbon');
const rctx = ribbon.getContext('2d');

function sizeRibbon() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ribbon.width = Math.max(1, Math.floor(ribbon.clientWidth * dpr));
  ribbon.height = Math.floor(30 * dpr);
  drawRibbon();
}
window.addEventListener('resize', sizeRibbon);

function drawRibbon() {
  if (!state.decoder) return;
  const K = state.decoder.K;
  const solved = state.decoder.solved;
  const W = ribbon.width;
  const H = ribbon.height;
  rctx.clearRect(0, 0, W, H);
  rctx.fillStyle = '#25e0b0';

  if (K <= W) {
    const w = W / K;
    for (let i = 0; i < K; i++) {
      if (solved[i]) rctx.fillRect(i * w, 0, Math.max(1, w - (w > 3 ? 1 : 0)), H);
    }
  } else {
    const per = K / W;
    for (let x = 0; x < W; x++) {
      const from = Math.floor(x * per);
      const to = Math.min(K, Math.floor((x + 1) * per));
      let hit = 0;
      for (let i = from; i < to; i++) if (solved[i]) hit++;
      if (!hit) continue;
      rctx.fillStyle = `rgba(37,224,176,${0.3 + 0.7 * (hit / Math.max(1, to - from))})`;
      rctx.fillRect(x, 0, 1, H);
    }
  }
}

/* ─────────────────────────  completion  ───────────────────────── */

async function finish() {
  state.scanning = false;
  state.paused = true;
  stopCamera();
  releaseWakeLock();

  const m = state.meta;
  $('d-name').textContent = m.n || 'Unnamed file';
  $('d-size').textContent = formatBytes(m.s);
  $('d-type').textContent = m.m || 'unknown';
  $('d-chunks').textContent = m.k.toLocaleString();
  $('d-frames').textContent = `${state.framesUsed.toLocaleString()} of ${(
    state.framesUsed + state.decoder.stats.duplicates
  ).toLocaleString()} seen`;
  show('stage-done');
  beep();

  $('d-verdict').textContent = 'Checking the file…';
  const raw = await state.store.blob(m.e ? 'application/octet-stream' : m.m);
  const digest = await hashBlob(raw);
  $('d-hash').textContent = digest.slice(0, 16) + '…';
  $('d-hash').title = digest;

  if (digest !== m.h) {
    $('d-verdict').textContent = 'Rebuilt, but the fingerprint does not match';
    document.querySelector('.panel--done').classList.add('is-bad');
    toast('The file did not verify. Ask the sender to run it again.', 6000);
    state.blob = raw;
    return;
  }

  if (m.e) {
    $('d-verdict').textContent = 'Verified · locked';
    $('pw-wrap').hidden = false;
    state.blob = raw;
    $('d-password').focus();
    return;
  }

  $('d-verdict').textContent = 'Verified · byte for byte identical';
  state.blob = raw;
  preview(raw, m);
}

async function unlock() {
  const pw = $('d-password').value;
  if (!pw) return;
  const m = state.meta;
  $('pw-err').hidden = true;
  try {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, [
      'deriveKey',
    ]);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(m.e.s), iterations: m.e.it || 250000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(m.e.i) },
      key,
      await state.blob.arrayBuffer()
    );
    const out = new Blob([plain], { type: m.m || 'application/octet-stream' });
    if (m.ph) {
      const h = await hashBlob(out);
      if (h !== m.ph) throw new Error('decrypted file does not match its fingerprint');
    }
    state.blob = out;
    $('pw-wrap').hidden = true;
    $('d-verdict').textContent = 'Verified · unlocked';
    $('d-size').textContent = formatBytes(out.size);
    preview(out, m);
  } catch (e) {
    $('pw-err').hidden = false;
    $('pw-err').textContent = 'That password did not open the file.';
  }
}

$('unlock').addEventListener('click', unlock);
$('d-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlock();
});

async function preview(blob, m) {
  const box = $('preview');
  const type = m.m || '';
  if (type.startsWith('image/') && blob.size < 20 * 1024 * 1024) {
    box.hidden = false;
    box.innerHTML = '';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = m.n || 'received image';
    box.appendChild(img);
  } else if ((type.startsWith('text/') || type.includes('json')) && blob.size < 200 * 1024) {
    box.hidden = false;
    box.innerHTML = '';
    const pre = document.createElement('pre');
    pre.textContent = (await blob.text()).slice(0, 4000);
    box.appendChild(pre);
  }
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], m.n || 'file')] })) {
    $('share').hidden = false;
  }
}

$('save').addEventListener('click', async () => {
  if (!state.blob) return;
  const name = (state.meta && state.meta.n) || 'received.bin';
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      await state.blob.stream().pipeTo(w);
      toast('Saved.');
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(state.blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
});

$('share').addEventListener('click', async () => {
  try {
    const file = new File([state.blob], state.meta.n || 'file', {
      type: state.meta.m || 'application/octet-stream',
    });
    await navigator.share({ files: [file], title: state.meta.n });
  } catch (e) {
    /* the person dismissed the sheet */
  }
});

$('again').addEventListener('click', () => resetAll(true));

/* ─────────────────────────  controls  ───────────────────────── */

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? 'Resume scanning' : 'Pause scanning';
  $('v-status').textContent = state.paused ? 'Paused — nothing is being read.' : 'Reading…';
});

$('discard').addEventListener('click', () => {
  if (state.decoder && state.decoder.solvedCount > 0) {
    if (!confirm('Throw away the chunks received so far?')) return;
  }
  resetAll(true);
});

async function resetAll(backToIdle) {
  state.scanning = false;
  state.paused = false;
  stopCamera();
  releaseWakeLock();
  if (state.store) await state.store.dispose().catch(() => {});
  Object.assign(state, {
    tid: null,
    meta: null,
    decoder: null,
    store: null,
    buffered: [],
    queue: [],
    framesUsed: 0,
    foreign: 0,
    blob: null,
    solvedRate: 0,
    lastSolvedCount: 0,
  });
  $('s-name').textContent = 'Waiting for the sender…';
  $('s-bar').style.width = '0%';
  $('s-pct').textContent = '0%';
  $('s-chunks').textContent = '— of — chunks';
  $('quality').textContent = '';
  $('preview').hidden = true;
  $('preview').innerHTML = '';
  $('pw-wrap').hidden = true;
  $('share').hidden = true;
  document.querySelector('.panel--done').classList.remove('is-bad');
  $('pause').textContent = 'Pause scanning';
  if (backToIdle) show('stage-idle');
}

window.addEventListener('beforeunload', (e) => {
  if (state.decoder && !state.decoder.complete && state.decoder.solvedCount > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* A short tone on completion: the person is usually looking at the sender,
   not at this screen. */
function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g);
    g.connect(ac.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
    o.start();
    o.stop(ac.currentTime + 0.36);
  } catch (e) {
    /* audio is a nicety */
  }
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    /* not fatal */
  }
}
function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.scanning) requestWakeLock();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
