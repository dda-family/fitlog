# DEPLOY.md — Fitlog 배포 규칙 (루트 평탄화 + git 워크플로우)

> 최종 갱신: v22 (2026-09-23) — src/ 이중구조 완전 폐지, 루트 평탄화 확정.
> 모든 작업은 맥북 로컬에서 하고, `git push` 하나로 배포한다. zip·수동 업로드 없음.

---

## 1. 단일 원칙: 모든 앱 파일은 저장소 루트(/)에 있다

과거에는 `src/`(개발본)와 루트(배포본)가 나뉘어 있어, 한쪽만 수정되면
배포가 어긋나 "고쳤는데 반영 안 됨 / 버전 불일치"가 반복됐다.
**이제 src/ 는 없다. 앱이 로드하는 파일이 곧 원본이고, 전부 루트에 있다.**

```
fitlog/                     ← 저장소 루트 = GitHub Pages 서빙 위치 = 앱이 열리는 곳
├── index.html              ← 앱 진입점 (사이트 루트 URL에서 바로 열림)
├── app.js  styles.css  db.js  evaluation.js  timer.js
├── backup.js  ai-bridge.js  catalog-data.js  heatmap.js
├── service-worker.js       ← 캐시 버전 관리 (SHELL/3D 모두 루트 경로)
├── manifest.webmanifest    ← start_url: "./index.html"
├── runtime/                ← 3D 뷰어(Three.js 포함). index.html 옆(루트)에 있어야 함
│   ├── heatmap-3d.js  muscle-bindings.js  svg-fallback.js
│   └── vendor/three/...
├── assets/                 ← icons, sounds, video, anatomy(SVG 5종 + human_3d.glb)
├── data/                   ← muscle-regions.json, anatomy-3d-map.json
├── docs/  CLAUDE.md  README.md
└── .gitignore
```

---

## 2. 왜 runtime/ 이 루트에 있어야 하는가

`app.js` 는 3D를 이렇게 동적 로드한다:
```js
mod = await import("./runtime/heatmap-3d.js");
```
이 경로는 **index.html 위치 기준**으로 해석된다. index.html이 루트에 있으므로
runtime/ 도 루트에 있어야 `/runtime/heatmap-3d.js` 로 정확히 맞는다.
GLB·JSON·SVG는 `_appRootURL()`이 오디오 경로(assets/sounds/rest-end.mp3)에서
루트를 역산하므로 위치와 무관하게 동작한다.

---

## 3. 일상 배포 흐름 (이게 전부다)

맥북에서 VSCode로 파일을 고친 뒤:
```bash
git add -A
git commit -m "수정 내용 요약"
git push
```
1~2분 뒤 GitHub Pages가 자동 반영한다. iPhone PWA는 다음 실행 시 새 버전을 받는다.

---

## 4. 코드 변경 시 반드시 함께 할 것 (★ 버전 2곳)

3D·자산은 cache-first 라, 버전을 올리지 않으면 기존 설치 PWA가 **옛 캐시를
계속 보여준다.** 코드/자산을 바꿨으면 아래 두 숫자를 **같은 값으로** 올린다:

```js
// service-worker.js
const CACHE_VERSION = "fitlog-v23";   // 숫자 +1

// app.js (최상단)
const APP_VERSION = "v23";            // 위와 같은 숫자
```

- `activate` 시 이전 캐시가 삭제되어 새 3D·자산으로 교체된다.
- **이것이 "3D/화면이 옛날 걸로 나오는" 문제의 유일한 정식 해결법이다.**
  PWA 삭제나 Safari 데이터 초기화는 필요 없다.
- 설정 화면 하단에서 **앱 버전 == 캐시 버전** 이고 최신이면 정상 배포된 것이다.

---

## 5. IndexedDB 보호 (절대 원칙)

SW는 Cache Storage(앱 파일)만 다룬다. 운동 기록(IndexedDB "fitlog")은
버전을 올려도, 캐시를 지워도 **절대 삭제되지 않는다.**
사용자에게 PWA 삭제나 Safari 데이터 초기화를 요구하지 않는다.

---

## 6. GitHub Pages 설정 (최초 1회)

저장소 → Settings → Pages → Build and deployment →
Source: **Deploy from a branch**, Branch: **main / (root)** → Save.
빌드 단계 없음(정적 파일 그대로 서빙). 앱 URL은
`https://<사용자명>.github.io/<저장소명>/` 형태.
