# Fitlog 통합 개선 — 최종 완료 보고 (v12)

기존 운동 기록·가이드 보존을 최우선으로, 요청 섹션 0~22를 반영했다. 아래는 섹션 22의 14개 항목 보고.

---

## 1. 이번 작업에서 실제로 구현한 기능

- **근육 히트맵(신규 최대 기능)**: 기록 탭에 기간 연동 인체 근육 히트맵 카드 추가. 5개 시점(정면→정면 사선→측면→후면 사선→후면) 좌우 스와이프·이전/다음 버튼 전환, 시점 이름 표시, 색상 범례, `선택 기간 내 상대 운동량` 안내, 근육별 점수 접기/펼치기, 미매핑 안내.
- **컴팩트 날짜 선택 바 + 모달**: 기록·AI 공용. 한 줄 바 `📅 09.01 ~ 09.22 ▾` → 탭 시 시작/종료일·최근 7일·기간 적용 모달. draft 분리(취소 시 기존 유지), 로컬 저장, 연도 다르면 연도 표시. 요약 제목을 `기간 요약(…)` → `운동 요약`으로 변경(날짜 중복 제거).
- **유산소 종목별 입력 필드**: 카탈로그 유산소 종목 선택 시 `supportsSpeed`/`supportsIncline`에 따라 관련 입력만 표시(예: 실내자전거 = 시간만).
- **운동 카탈로그 통합 + 사용자 근육 매핑**: 새 운동 추가 모달에서 (A) 카탈로그 운동과 동일/유사 연결 또는 (B) 주요/보조 부위 직접 선택. 기존/사용자 운동에 대해 `🎯 근육 매핑 설정`으로 언제든 지정·수정·해제. 우선순위 **사용자 지정 > 카탈로그 > 미매핑(제외)**.
- **날짜별 상세 히트맵**: 기록 상세에서 `이 날짜의 근육 부위 보기`(접기/펼치기) — 메인 기간을 바꾸지 않고 그 세션만 계산(동일 계산 함수·자산 재사용).
- (v11에서 이미 반영·유지) AI 프롬프트 세트별 상세·메모·목표/실제 구분·기간 필터, AI 코치 기간 연동(`기록 탭 기간 가져오기`), 유산소 kind 템플릿, 타이머 입력값 보존.

## 2. 이미 구현되어 있어 변경하지 않은 기능

휴식 타이머(90/180초·화면 유지·AirPods 미디어 알림음)와 타이머 종료 후 입력값 보존, 세트/중량/반복 기록·판정(어시스트 역방향·워밍업 제외), 가이드 편집, 요일→템플릿 매핑, JSON 백업/복원의 기존 동작, 시드 루틴, 오늘 화면 흐름. 이들 로직 자체는 수정하지 않고 그대로 유지했다.

## 3. 수정한 기존 파일 목록

- `src/app.js` — 컴팩트 날짜 바+모달, 히트맵 마운트/스와이프, 새 운동 모달, 근육 매핑 모달, 유산소 필드 스펙, 요약 제목 변경, 상세 히트맵.
- `src/db.js` — DB_VERSION 1→2, `userMuscleMap` 스토어 및 헬퍼(`userMuscleMapAll`/`setUserMuscleMap`/`deleteUserMuscleMap`).
- `src/backup.js` — export/import/스냅샷에 `userMuscleMap` 포함, schemaVersion 2(1도 하위호환 복원).
- `src/index.html` — `catalog-data.js`·`heatmap.js` 스크립트 추가.
- `src/styles.css` — 날짜 바/모달, `.fitlog-anatomy` 히트맵 카드, 부위 칩 등 컴포넌트 스코프 스타일.
- `service-worker.js` — CACHE_VERSION `fitlog-v11`→`fitlog-v12`, 신규 JS·SVG 프리캐시.

## 4. 새로 추가한 파일 목록

- `src/catalog-data.js` — 패키지 JSON 3종 + 링크표 임베드(`window.FitlogCatalog`).
- `src/heatmap.js` — 참조 계산 이식 + Fitlog 어댑터 + SVG 로딩/색칠(`window.FitlogHeatmap`).
- `assets/anatomy/human_{front,front_oblique,side,back_oblique,back}.svg` — 인체 5종.
- `docs/EXERCISE_MAPPING_MAINTENANCE.md` — 운동/매핑 추가 유지보수 가이드.
- `docs/INTEGRATION_REPORT_v12.md` — 본 보고서.
- `build-deploy.sh` — 개발본→배포(평면) 빌드 스크립트.

## 5. 첨부 ZIP에서 실제 앱에 반영한 자산 목록

- SVG 5종(`human_*.svg`) → `assets/anatomy/`에 그대로 복사.
- `data/muscle-regions.json`(20부위+5시점), `data/exercise-catalog.json`(79종), `data/exercise-muscle-map.json`(72종 매핑) → `catalog-data.js`에 임베드.
- `validation/reference-heatmap.mjs`의 계산부(palette/dayNumber/scoreColors/calculate) → `heatmap.js`에 **동작 동일**하게 이식(패키지 12 시나리오 검증 통과).
- 신규 자산 제작 없음. 패키지 제공물만 사용.

## 6. 기존 운동 ID와 새 카탈로그 ID의 연결 방식

- **기존 운동ID는 절대 치환하지 않는다.** 별도 링크 계층 `EXISTING_LINK`(기존ID→카탈로그ID)로 연결만 한다. 이름 유사가 아닌 동작·장비 기준으로 큐레이션.
- 새로 만드는 운동에만 `catalogId`를 부여(선택 시). 사용자 지정 매핑은 `userMuscleMap` 스토어에 별도 저장. 계산 시 `사용자 지정 > catalogId/EXISTING_LINK > 미매핑`.
- 데드리프트 계열이 카탈로그에 있어도 사용자 가이드에 자동 추가하지 않음(카탈로그=선택 목록, 가이드=실제 루틴).

## 7. 기존 IndexedDB 구조 변경 여부

- **가산적 마이그레이션**만 수행: DB_VERSION 1→2, `userMuscleMap` 스토어 1개 추가. `onupgradeneeded`는 없는 스토어만 생성하므로 기존 6개 스토어·데이터는 그대로 유지된다.
- 기존 데이터 삭제·재시드·초기화 없음. 신규 사용자와 기존 사용자 구분: `seedIfEmpty`가 데이터가 있으면 no-op(기존 사용자 루틴 보존), 없을 때만 시드.
- 검증: v1 DB에 데이터를 넣고 v2로 열어 세션/운동/설정 보존 + 신규 스토어 생성 확인(통과).

## 8. 기존 운동 기록 및 사용자 가이드에 미치는 영향

- **없음(보존).** 히트맵은 기록을 읽어 메모리상 계약 객체로만 변환하며 원본 세션/세트를 수정하지 않는다. 근육 매핑 변경도 기록 자체를 바꾸지 않고 색상 계산에만 반영된다.
- 기존 가이드의 목표 중량·세트·반복은 카탈로그 기본값으로 덮어쓰지 않는다(검증: `g-bench-press` 유지 확인).

## 9. 운동 카탈로그와 사용자 지정 근육 매핑의 저장 및 백업 방식

- 카탈로그·기본 매핑: 정적 파일 `catalog-data.js`(코드 배포에 포함, 사용자 데이터 아님).
- 사용자 지정 매핑: IndexedDB `userMuscleMap` 스토어(운동ID별 `{mapping, source, catalogRef, version, updatedAt}`).
- 백업: JSON export/import에 `userMuscleMap` 포함(schemaVersion 2). v1 백업(해당 필드 없음)도 정상 복원(빈 값 처리) — 하위호환.

## 10. Service Worker 및 PWA 캐시 변경사항

- `CACHE_VERSION` `fitlog-v11`→`fitlog-v12`. 핵심 셸에 `catalog-data.js`·`heatmap.js` 추가(원자적), SVG 5종은 best-effort 프리캐시(일부 실패해도 설치·앱 정상). SVG는 cache-first + 미스 시 네트워크 수신 후 캐시 → 최초 온라인 후 오프라인 동작.
- **정적 자산 캐시(Cache Storage)와 사용자 데이터(IndexedDB)는 분리.** SW는 IndexedDB를 건드리지 않으며, 버전 교체 시 옛 캐시만 삭제하고 사용자 기록은 유지된다. 시점 전환 시 재fetch/재조회/재계산 없음(계산은 데이터·기간 변경 시에만).

## 11. 각 기능별 테스트 결과 (Mac에서 자동 검증)

Node + jsdom + fake-indexeddb로 6개 스위트 전부 통과:

- 참조 계산 이식 파리티: **12/12** (패키지 `reference-heatmap` 시나리오와 동일 결과).
- DB v2 마이그레이션·`userMuscleMap` CRUD·백업 v1/v2 왕복: **통과**.
- 어댑터+SVG 파이프라인(가슴/등/하체 점수, 어시스트 무관, 유산소 분리, 미매핑 제외, 빈 기간 중립, 사용자 오버라이드, 세션 필터): **통과**.
- 카탈로그 연결 커스텀 운동 채점: **통과**.
- 앱 부팅 스모크(기록 렌더·히트맵 SVG 색칠·모달·필드 스펙): **통과**.
- 섹션 18 A/C/D/F/G/H 시나리오: **29개 체크 통과**(세트별 원본 4세트·메모·기간필터·어시스트 라벨, 한 줄 라벨·연도 표시·최근7일·저장, AI 기간 상속·독립, 가슴/등/하체 색상·유산소 중립·시점 간 동일 색·시작·종료 포함, ID 불변·가이드 미덮어씀·사용자 매핑 소급, 백업 포함).

## 12. 실제 iPhone에서 직접 확인해야 할 사항 (사용자 확인 필요)

Mac 자동 테스트로 대체 불가한 실기기 항목:

- 세로 화면에서 날짜 바가 한 줄, 날짜 선택창이 화면 밖으로 잘리지 않는지.
- 히트맵이 가로 스크롤 없이 표시되고, 5개 시점 전환이 부드러운지.
- 세로 스크롤 중 인체가 잘못 회전하지 않고, 가로 스와이프만 시점 변경되는지(터치 실측).
- 기록 목록이 히트맵 때문에 과도하게 밀리지 않는지.
- 휴식 타이머 종료 후 입력값 유지 + AirPods 미디어 알림음 정상.
- 홈 화면 PWA에서 신규 자산 로드 후, 네트워크 없이도 히트맵/5시점 표시.
- 앱 업데이트(v12) 후 기존 운동 기록 보존.

## 13. 앞으로 운동 종목을 추가할 때의 유지보수 방법

`docs/EXERCISE_MAPPING_MAINTENANCE.md` 참조. 요지:
- 데이터-주도: 앱 로직·SVG 수정 없이 `catalog-data.js`의 `CATALOG.exercises`·`MUSCLE_MAP.mappings`만 추가.
- 근육 키는 20개 부위 ID 내에서만, 가중치는 primary=1/secondary=0.5/minor=0.25.
- 카탈로그에 없는 운동은 앱 UI(부위 직접 선택)로 사용자 매핑 저장. 기존ID·사용자 매핑은 기본 데이터 업데이트로 덮어쓰지 않음.

## 14. 배포 시 주의사항

- 배포는 평면 구조(`fitlog-deploy.zip`): `src/` 없이 루트에 파일, `index.html`이 `./service-worker.js`·`assets/...` 참조. `build-deploy.sh`로 재생성.
- `.nojekyll` 포함(정적 자산 그대로 서빙).
- SW 캐시 버전을 반드시 올렸으므로(v12), 설치된 PWA는 다음 접속 시 새 셸로 갱신된다. 단 **강제 새로고침이나 IndexedDB 초기화는 하지 않는다** — 사용자 기록은 그대로 유지.
- 자산(SVG/JSON) 교체 시 `catalog-data.js`의 `packageVersion`과 SW `CACHE_VERSION`을 함께 올려 근육 ID 불일치를 방지.
- 최초 1회는 온라인 상태에서 열어 신규 자산을 캐시한 뒤 오프라인 사용을 권장.
