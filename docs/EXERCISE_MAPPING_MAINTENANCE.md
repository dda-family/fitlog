# 운동 카탈로그 · 근육 매핑 유지보수 가이드

> 목적: 앞으로 새 운동 종목을 추가할 때 **어떤 파일을 어떻게 고치는지**를 명확히 남긴다.
> 핵심 원칙: 카탈로그·매핑은 **데이터**이고, 앱 로직에 조건문으로 하드코딩하지 않는다.
> 새 운동을 추가해도 **SVG를 다시 만들 필요가 없고**, 히트맵 계산 로직(`src/heatmap.js`)을 고칠 필요가 없다.

---

## 1. 데이터가 사는 곳 (단일 파일)

모든 정적 데이터는 `src/catalog-data.js` 안 `window.FitlogCatalog`에 임베드되어 있다.
(오프라인·PWA에서 fetch 경합 없이 즉시 로드하려고 JSON을 이 파일에 넣는다. SVG만 파일로 둔다.)

| 키 | 원본 패키지 파일 | 내용 |
|---|---|---|
| `REGIONS_META` | `data/muscle-regions.json` | 20개 근육 부위 정의 + 5개 시점(view) 정의 |
| `CATALOG` | `data/exercise-catalog.json` | 79개 운동 종목(영문 ID + 한글명 `label_ko`) |
| `MUSCLE_MAP` | `data/exercise-muscle-map.json` | 운동ID → 근육 가중치(primary/secondary/minor) |
| `EXISTING_LINK` | (앱 고유) | 기존 앱 운동ID → 카탈로그ID 연결 표 |
| `REGION_IDS` | 파생 | 20개 부위 ID 배열(계산 시 점수 초기화용) |
| `packageVersion` | `1.0.0` | 자산 버전. SVG·JSON ID 불일치 방지용 |

- SVG 5종: `assets/anatomy/human_{front,front_oblique,side,back_oblique,back}.svg`
- 각 SVG에는 `[data-muscle="<부위ID>"]` path가 들어 있고, 앱은 그 fill만 바꿔 색칠한다.

---

## 2. 근육 부위 ID (20종, 절대 임의 변경 금지)

```
upper_chest, chest, front_delts, side_delts, rear_delts,
traps, upper_back, mid_back, lats, biceps, triceps, forearms,
abs, obliques, glutes, quads, hamstrings, calves, adductors, hip_flexors
```

- 이 ID는 **SVG의 data-muscle**, **매핑의 근육 키**, **REGION_IDS**가 모두 공유한다.
- 부위 ID를 바꾸면 세 곳(SVG/매핑/REGIONS_META)을 동시에 고쳐야 하고, 기존 사용자 매핑과의 호환성 검토가 필요하다. → **가급적 바꾸지 않는다.**

---

## 3. 시나리오별 "무엇을 고치나"

### A. 카탈로그에 이미 있는 운동을 사용자가 앱에서 쓰기 시작
> 파일 수정 **불필요**. 앱 UI에서 처리된다.

- 가이드 편집 → `＋근력 종목` → "카탈로그 운동과 동일/유사"에서 선택하면
  새 운동에 `catalogId`가 붙고 카탈로그 기본 매핑이 자동 적용된다.
- 기존 운동ID는 절대 바뀌지 않는다(새로 만드는 운동에만 `catalogId` 부여).

### B. 카탈로그에 없는 운동을 사용자가 추가
> 파일 수정 **불필요**. 앱 UI에서 처리된다.

- `＋근력 종목` → "부위 직접 선택"으로 주요/보조 부위를 지정하면
  `userMuscleMap` 스토어(IndexedDB)에 별도 저장된다(운동 기록은 변경하지 않음).
- 나중에 가이드 편집의 `🎯 근육 매핑 설정`으로 언제든 수정/해제 가능하다.
- 우선순위: **사용자 지정 매핑 > 카탈로그(`catalogId`/`EXISTING_LINK`) > 미매핑(계산 제외)**.

### C. 카탈로그 자체에 새 운동 종목을 "기본 제공"으로 추가 (개발자 작업)
> `src/catalog-data.js`만 수정한다. **앱 로직·SVG는 손대지 않는다.**

1. `CATALOG.exercises` 배열에 항목 추가:
   ```js
   { id: "cable_crunch", label_ko: "케이블 크런치", exerciseType: "strength",
     supportsReps: true /* 유지: 시간형이면 false */, /* 기타 메타 자유 */ }
   ```
   - `id`는 영문 소문자+언더스코어, **한 번 정하면 안정적으로 유지**(§13-2).
   - 한글 표시명은 `label_ko`에서 자유롭게 바꿔도 된다(§13-3).
2. `MUSCLE_MAP.mappings` 배열에 같은 `id`로 매핑 추가:
   ```js
   { exerciseId: "cable_crunch", policy: "weighted_completed_sets",
     primary: { abs: 1 }, secondary: { obliques: 0.5 }, minor: {} }
   ```
   - 가중치는 **primary=1, secondary=0.5, minor=0.25**만 허용.
   - 근육 키는 §2의 20개 ID 중에서만 사용(그 외는 계산 시 무시·경고).
3. 끝. 유산소면 `exerciseType:"cardio"`로 넣고 `supportsSpeed`/`supportsIncline` 플래그로
   입력 필드를 결정한다(매핑은 없어도 됨 — 유산소는 근육 점수에 기여하지 않음).

### D. 기존 앱 운동을 새 카탈로그 항목과 연결 (개발자 작업, 드묾)
> `EXISTING_LINK`에 한 줄 추가. 기존 운동ID·기록·가이드는 그대로.

```js
EXISTING_LINK["my-app-exercise-id"] = "catalog_exercise_id"
```
- **이름이 비슷하다는 이유만으로 연결하지 않는다.** 동작·장비(바벨/덤벨/머신)가
  실제로 같은 운동일 때만 연결한다(§11-3~5).

---

## 4. 하지 말아야 할 것 (데이터 보존)

- 카탈로그에 데드리프트 계열이 있어도 **사용자 기본 가이드에 자동 추가하지 않는다.**
  (카탈로그 = 선택 가능한 목록 / 가이드 = 실제 수행 루틴. 둘은 분리.)
- 기본 카탈로그를 업데이트해도 `userMuscleMap`(사용자 지정)을 덮어쓰지 않는다(§13-7).
- 기존 운동ID를 카탈로그ID로 치환하지 않는다(§11-6, §17-2).
- 새 기능 추가를 이유로 시드를 다시 깔거나 사용자 루틴을 덮어쓰지 않는다(§17-13).

---

## 5. 버전 관리

- 자산 버전은 `packageVersion`(현재 `1.0.0`). SVG 요청 시 `?v=<packageVersion>`을 붙여
  캐시된 옛 SVG와 새 매핑의 근육 ID 불일치를 방지한다(§16-11).
- 자산(SVG/JSON)을 교체하면 `packageVersion`을 올리고 Service Worker의
  `CACHE_VERSION`(`service-worker.js`)도 함께 올린다(현재 `fitlog-v12`).
- `userMuscleMap` 엔트리에는 `version` 필드가 있어 향후 스키마 변경에 대비한다.

---

## 6. 검증

새 운동/매핑을 추가한 뒤:
- `node --check src/catalog-data.js` (구문)
- 패키지 참조 계산과의 일치: `validation/reference-heatmap.mjs` 기준 12 시나리오
- 새 매핑 근육 키가 §2의 20개 안에 있는지, 가중치가 {1, 0.5, 0.25}인지 확인
