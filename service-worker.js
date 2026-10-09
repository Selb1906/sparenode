// SpareNode 서비스 워커 - 앱 파일을 저장해 두고 인터넷 없이도 열리게 한다.
// 파일을 고친 뒤에는 CACHE 버전을 올려야 설치된 앱이 새 파일로 바뀐다.
const CACHE = 'sparenode-v3';

const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'bench-worker.js',
  'task-worker.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 저장해 둔 앱 파일은 저장본을 먼저 쓰고, 그 밖의 요청(코디네이터 API 등)은 그대로 네트워크로
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});
