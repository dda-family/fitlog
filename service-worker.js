/* Fitlog Service Worker — 루트 평탄화 배포본 (모든 앱 파일이 저장소 루트에서 서빙됨)
 * JS/HTML·3D: cache-first / assets(sounds·video): network-first
 * ★ 이 SW는 Cache Storage(앱 셸·자산)만 관리한다. 사용자 운동 데이터(IndexedDB "fitlog")는
 *   절대 건드리지 않는다. 캐시 버전이 바뀌어도 IndexedDB는 그대로 유지된다.
 * ★ 버전을 올리면(activate) 이전 캐시가 삭제되어 옛 3D/자산이 강제로 교체된다.
 *   → 코드 수정 시 반드시 CACHE_VERSION 과 app.js 의 APP_VERSION 을 같은 숫자로 올린다.
 */
const CACHE_VERSION = "fitlog-v24";
// 핵심 셸: 하나라도 실패하면 설치 실패(원자적). 기존 앱 동작에 필수인 파일만.
// ★ 3D(GLB·Three·runtime)는 절대 여기 넣지 않는다 — 3D 자산 실패가 앱 설치/기록 사용을 막지 않도록 분리.
const SHELL = [
  "./index.html", "./styles.css",
  "./app.js", "./db.js", "./timer.js", "./evaluation.js", "./backup.js", "./ai-bridge.js",
  "./catalog-data.js", "./heatmap.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png", "./assets/icons/icon-512.png",
  "./assets/icons/icon-512-maskable.png", "./assets/icons/apple-touch-icon.png",
];
// 근육 히트맵 SVG 5종: 최초 온라인 로드 시 프리캐시 → 이후 오프라인 동작(3D 실패 시 대체 화면).
// 실패해도 설치를 막지 않는다(하나가 없어도 기록 탭·기존 기능은 정상). fetch 시 다시 캐시 시도.
const ANATOMY = [
  "./assets/anatomy/human_front.svg", "./assets/anatomy/human_front_oblique.svg",
  "./assets/anatomy/human_side.svg", "./assets/anatomy/human_back_oblique.svg", "./assets/anatomy/human_back.svg",
];
// 3D 자산(선택적·best-effort): GLB·로컬 Three.js·뷰어 런타임·3D 매핑·근육 지역 정의.
// 하나라도 실패해도 설치·기존 기능·SVG 대체 화면은 정상. 최초 온라인 후 오프라인 3D 동작을 위해 프리캐시.
// 같은 표시 버전(CACHE_VERSION)으로 함께 관리 → 버전 전환 시 3D 자산 집합이 원자적으로 교체.
const THREE3D = [
  "./runtime/heatmap-3d.js", "./runtime/muscle-bindings.js", "./runtime/svg-fallback.js",
  "./runtime/vendor/three/three.module.min.js", "./runtime/vendor/three/three.core.min.js",
  "./runtime/vendor/three/addons/loaders/GLTFLoader.js",
  "./runtime/vendor/three/addons/utils/BufferGeometryUtils.js",
  "./data/muscle-regions.json", "./data/anatomy-3d-map.json",
  "./assets/anatomy/human_3d.glb",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then(async (c) => {
    await c.addAll(SHELL);                                  // 필수 셸(원자적)
    await Promise.all(ANATOMY.map((u) => c.add(u).catch(() => {})));   // SVG는 best-effort
    await Promise.all(THREE3D.map((u) => c.add(u).catch(() => {})));   // 3D 자산은 best-effort(실패 무시)
  }));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("message", (e) => { if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const isAsset = url.pathname.includes("/assets/sounds/") || url.pathname.includes("/assets/video/");
  const isAnatomy = url.pathname.includes("/assets/anatomy/");   // SVG 5종 + human_3d.glb
  const is3D = url.pathname.includes("/runtime/") || url.pathname.includes("/data/");   // Three·뷰어·3D 매핑
  if (isAsset) {
    // 사운드·영상: network-first (교체 즉시 반영), 오프라인 시 캐시 폴백
    event.respondWith(fetch(event.request).then((res) => { const clone = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone)); return res; }).catch(() => caches.match(event.request)));
  } else if (isAnatomy || is3D) {
    // 히트맵 자산(SVG·GLB)·3D 런타임: cache-first + 미스 시 네트워크에서 받아 캐시.
    // 프리캐시 실패(예: GLB 미수신)해도 최초 온라인 후 캐시되어 이후 오프라인 3D/SVG 동작. 실패해도 앱은 정상.
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => { const clone = res.clone(); if (res.ok) caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone)); return res; })));
  } else {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
