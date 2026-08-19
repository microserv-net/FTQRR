/* Caches the whole application on first visit so that later transfers need
   no network at all — which is the point of the project. */
const CACHE = 'oqtp-rx-v3';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/oqtp.js',
  'js/sha256.js',
  'js/fountain-decoder.js',
  'js/bench-frame.js',
  'js/store.js',
  'js/store-worker.js',
  'js/decode-worker.js',
  'js/vendor/jsQR.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('index.html')))
  );
});
