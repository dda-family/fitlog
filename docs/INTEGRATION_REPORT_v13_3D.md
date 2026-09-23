# Fitlog 3D 근육 히트맵 통합 — 완료 보고 (v13, SW fitlog-v15)

SVG 5시점 히트맵을 **실제 GLB 기반 3D 히트맵**으로 발전시켰다. 3D 실패 시 기존 SVG로 자동 대체하며,
기존 운동 기록·가이드·설정·DB 스키마·백업 포맷은 일절 변경하지 않았다.

---

## 1. 새로 추가한 파일

- `src/runtime/heatmap-3d.js` — 3D 뷰어(create→ready→setColors/setVisible→destroy). DB·집계·계산 없음, 색상만 받음.
- `src/runtime/muscle-bindings.js` — glTF 노드↔muscleId 바인딩·색상 적용(순수 검증 로직).
- `src/runtime/svg-fallback.js` — 3D 실패 시 뷰어 내부 SVG 5시점 대체.
- `src/runtime/vendor/three/` — 로컬 Three.js 0.180.0(three.module/core.min, GLTFLoader, BufferGeometryUtils) + `LICENSE`(MIT).
- `data/muscle-regions.json` — 20개 근육 지역 + 5시점 정의(뷰어가 muscleId 목록 확보용).
- `data/anatomy-3d-map.json` — muscleId → glTF node/material/분할영역 매핑(packageVersion 2.0.0).
- `assets/anatomy/human_3d.glb` — 입체 인체 모델(920KB, 21 메시/재질, 텍스처 0, 정점 25,635/삼각형 48,966).
- `docs/INTEGRATION_REPORT_v13_3D.md` — 본 보고서.

## 2. 수정한 기존 파일

- `src/app.js`
  - `mountHeatmap()`을 **3D 우선 + SVG 대체**로 개편. 기록 탭 진입 시 `import('./runtime/heatmap-3d.js')` 동적 로드 → `createHeatmap3D(host, { baseURL, colors })`. 계산은 기존 `FitlogHeatmap.compute()` 그대로 사용하고 결과 `colors`만 뷰어에 전달.
  - `_destroyHeatmaps()`/`_heatCtrls`(Set) 추가 — 기록↔상세 재렌더·탭 전환 시 활성 뷰어를 명시적 `destroy`(WebGL 컨텍스트·리스너 누수 방지). `show()`, `renderHistory()`, `renderHistoryDetail()` 진입 시 호출.
  - `_appRootURL()` 추가 — 오디오 요소 src에서 앱 루트 절대 URL 역산(dev `src/`·배포 평면·**GitHub Pages 서브패스** 모두 정확). `/assets` 같은 루트 절대경로 하드코딩 없음.
  - `_renderSVGModel()` 추가 — 3D 모듈 자체를 못 읽을 때 기존 5시점 SVG UI 유지(색상 재사용, 재계산 없음). 기존 스와이프/버튼/시점 로직 그대로.
  - 정면/후면 버튼(`showFront`/`showBack`) + 좌우 드래그·화살표 360° 회전(뷰어 내부). 45° 프레임 전환·자동회전·핀치줌 없음. 세로 스크롤·두 손가락·pointercancel 처리.
  - 비동기 세대(`_heatSeq`) + `ready` 이후 화면 변경 시 즉시 destroy — 늦은 응답이 최신 화면을 되살리지 않음.
- `src/styles.css` — `.anat-svg.is-3d`(3D 캔버스 확정 높이 330px) 추가. preview/styles.css를 전역에 덮어쓰지 않음(컴포넌트 스코프 유지).
- `service-worker.js` — `CACHE_VERSION` `fitlog-v14`→`fitlog-v15`. 3D 자산(GLB·Three·runtime·3D map·muscle-regions)을 **best-effort 그룹(THREE3D)**으로 분리. 핵심 SHELL(원자적)에는 넣지 않음 → GLB 하나 실패해도 앱 설치·기록·SVG 대체는 정상. fetch 시 `/runtime/`·`/data/`·GLB는 cache-first + 미스 시 캐시(최초 온라인 후 오프라인 3D 동작).
- `build-deploy.sh` — 배포에 `src/runtime/`→`runtime/`, `data/`→`data/` 복사 추가(하위 모듈·상대 import 구조 보존). SW의 `./src/`→`./` 평탄화가 runtime 경로에도 적용됨.

## 3. DB·사용자 기록 영향 — 없음(보존)

- IndexedDB 스키마·스토어·시드·백업 포맷 **변경 없음**. 3D는 신규 스토어를 만들지 않는다.
- 3D 뷰어는 IndexedDB를 열지 않는다(정적·브라우저 검증 확인). 계산은 host(heatmap.js)가, 뷰어는 색상만 담당.
- 기존 운동 ID·가이드·목표값·설정 불변. 근육 색상은 기존 계산 결과를 그대로 표시(재분류·자동매핑 없음).
- 20개 근육 ID·79개 운동·가중치·완료세트 집계·상대 색상 정규화·유산소 별도 집계 그대로.

## 4. 실행 테스트 결과 (이 환경에서 실제 실행)

- 패키지 구조 검증 `validate-3d.mjs`: **PASS**(GLB 유효, 20 muscleId, 21 메시/재질, 텍스처 0, 원본 21파일 SHA 동일, 로컬 모듈 7).
- 매핑 검증 `test-muscle-mapping.mjs`: **PASS**.
- 기존 계산 이식 파리티 `legacy-2d/.../test-calculation.mjs`: **PASS**(12 시나리오).
- 뷰어 브라우저 검증 `test-heatmap-3d.mjs`(Chromium+SwiftShader WebGL2): **21/21 PASS**(3D 렌더·20색 독립·360°·드래그·유휴 정지·빈 기간 중립·반복 생성/파괴·컨텍스트 소실→SVG·로딩 중 파괴·5종 실패→SVG·모바일 390×844·세로 스크롤·두 손가락·오프라인·DB 미접근).
- **통합본 브라우저 검증(신규 작성, 실제 index.html + 주입 세션, 서브패스 `/repo/`): 9/9 PASS**
  - 기록 탭 진입 → 3D 뷰어 마운트(21 메시), GLB가 서브패스 origin에서 로드(절대경로 하드코딩 없음), 기존 계산 색상 바인딩(가슴 비중립 `#dc865d`), 정면/후면·범례·근육별 상세 유지, 탭 전환 시 destroy(캔버스 해제), 반복 열기/닫기 누수 없음(컨트롤러 1개 유지), 3D 모듈 로드 실패→SVG 5시점 유지, GLB 404→뷰어 내부 SVG(state=svg), 뷰어 파일 DB 접근 흔적 없음.
- 기존 회귀 스위트(Mac 자동): heatmap-adapter+SVG, DB v2/userMuscleMap/백업 v1·v2, catalog-link, **Section 18(29체크)**, delete-session — **모두 PASS**.
- 앱 스모크(jsdom): **PASS** — 3D 모듈 미해결(ERR_MODULE_NOT_FOUND) 시 앱이 잡아 기존 SVG 히트맵 유지(가슴 `#dc865d`) 확인.

## 5. 미검증(NOT_TESTED)

- iPhone 15 실기기 Safari·홈 화면 설치형 PWA에서의 3D 렌더·터치·발열·배터리·GPU 성능. (데스크톱 헤드리스 SwiftShader 소프트웨어 WebGL2 결과를 실기 성능으로 해석하지 않음.)
- 실제 GitHub Pages 정적 URL에서의 MIME(특히 `.glb` `model/gltf-binary`, ESM `.js` `text/javascript`)·SW 업데이트 흐름. 로컬 서버에서는 정확한 MIME로 통과.
- iOS 캐시 퇴거 후 오프라인 3D 지속(영구 오프라인은 보장하지 않음).

## 6. 알려진 사항

- 헤드리스 SwiftShader에서 한 브라우저에 WebGL 컨텍스트를 다수 생성·파괴하면 후속 컨텍스트가 느려질 수 있음(테스트 격리로 회피). 실제 앱은 뷰어를 항상 destroy하므로 동시 1~2개만 유지.
- 3D는 WebGL2 필요. iOS 15.4+ Safari는 지원하나, 불가 환경에서는 자동으로 SVG 5시점(기존 화면)으로 전환.

## 7. 배포 절차

1. `fitlog-deploy.zip`을 GitHub Pages 저장소 루트에 그대로 반영(평면 구조, `.nojekyll` 포함). 또는 개발본에서 `bash build-deploy.sh` 재생성.
2. 최초 1회는 온라인에서 열어 3D 자산(GLB·Three·runtime·3D map)을 캐시 → 이후 오프라인에서도 3D/SVG 동작.
3. SW `CACHE_VERSION`이 v15로 올랐으므로 설치된 PWA는 다음 접속 시 새 셸로 갱신(IndexedDB·기록은 그대로 유지).

## 8. 롤백

- 3D를 끄려면 `src/runtime/`·`data/`·`human_3d.glb`를 제외하고 배포(또는 `mountHeatmap`의 3D 분기 제거) → 앱은 즉시 기존 SVG 5시점으로 동작. `_renderSVGModel`이 그대로 남아 있어 코드 변경 최소.
- 이전 배포본으로 되돌려도 **사용자 운동 기록(IndexedDB)은 과거 상태로 덮어쓰지 않는다**. SW는 캐시만 교체하며 IndexedDB를 건드리지 않음.

## 9. 최종 산출물

- `fitlog-deploy.zip` — GitHub Pages 평면 배포본(3D 자산·Three LICENSE 포함, 개발 전용 preview/validation/model-source/legacy-2d/docs 제외).
- `fitlog-3d-source.zip` — 수동 반영용 변경/추가 소스(app.js, styles.css, runtime/, data/, human_3d.glb, service-worker.js, build-deploy.sh).
