/* Fitlog Service Worker
 * 역할: 앱 셸 + 알림음 오프라인 캐시 (DATA_SPEC §19)
 * 주의: 운동 데이터는 여기 캐시하지 않는다. 데이터는 IndexedDB(db.js).
 * 앱 파일을 수정/배포할 때마다 CACHE_VERSION을 올려 캐시를 갱신한다.
 */

const CACHE_VERSION = "fitlog-v3";
const APP_SHELL = [
  "./src/index.html",
  "./src/styles.css",
  "./src/app.js",
  "./src/db.js",
  "./src/timer.js",
  "./src/evaluation.js",
  "./src/backup.js",
  "./src/ai-bridge.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-512-maskable.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/sounds/rest-end.mp3",
  "./assets/video/keep-awake.mp4"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// cache-first (오프라인 우선). 네트워크 실패 시 캐시로 폴백.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
