/* Fitlog Service Worker (배포용)
 * JS/HTML/manifest/icons: cache-first (오프라인 우선)
 * assets/sounds, assets/video: network-first (사운드 교체 즉시 반영)
 * 앱 파일 수정 시 CACHE_VERSION을 올린다.
 */
const CACHE_VERSION = "fitlog-v9";
const SHELL = [
  "./", "./index.html", "./styles.css",
  "./app.js", "./db.js", "./timer.js", "./evaluation.js", "./backup.js", "./ai-bridge.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png", "./assets/icons/icon-512.png",
  "./assets/icons/icon-512-maskable.png", "./assets/icons/apple-touch-icon.png",
];
// assets(사운드·비디오)는 캐시 목록에 넣지 않고 network-first로 별도 처리
const ASSETS = ["./assets/sounds/rest-end.mp3", "./assets/video/keep-awake.mp4"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("message", (e) => { if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isAsset = url.pathname.includes("/assets/sounds/") || url.pathname.includes("/assets/video/");
  if (isAsset) {
    // network-first: 서버에서 받아오고, 실패 시 캐시 폴백
    event.respondWith(
      fetch(event.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
        return res;
      }).catch(() => caches.match(event.request))
    );
  } else {
    // cache-first: 오프라인 동작 보장
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
