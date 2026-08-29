/* Fitlog Service Worker (배포용, 루트 평평 구조)
 * 앱 파일 수정/재배포 시 CACHE_VERSION을 올려 캐시 갱신.
 */
const CACHE_VERSION = "fitlog-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./timer.js",
  "./evaluation.js",
  "./backup.js",
  "./ai-bridge.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-512-maskable.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/sounds/rest-end.mp3",
  "./assets/video/keep-awake.mp4"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
