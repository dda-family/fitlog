# 인수인계 — 운동 상세 화면 3D 미리보기 연결 (2차 개발)

이번 1차 개발에서 운동 찾아보기 상세 화면에 **향후 3D 운동 동작 미리보기**를 연결할 지점을 마련했다.
2차 개발에서 운동 추가 UX를 다시 만들 필요 없이, 운동 ID 기준으로 자산만 연결하면 된다.

## 1. 상세 화면 구조 (현재)

- 파일: `src/app.js`
- 진입: 운동 추가 → 운동 찾아보기(`_addSearch`) → 결과 항목 탭 → `_addDetail(ctx, catId)`
- `_addDetail`이 그리는 것: (미리보기 슬롯) → 이름 → 유형·부위·기구 → 주요 부위 → 설명(notes) → `이 운동 추가` 버튼.

## 2. 운동 ID ↔ 상세 화면 연결 방식

- 상세 화면은 **카탈로그 운동 ID**(예: `barbell_curl`, `lat_pulldown`)를 인자로 받는다.
- 카탈로그 정의: `catalog-data.js`의 `window.FitlogCatalog.CATALOG.exercises[]` (필드: `id`, `label_ko`, `category`, `equipment`, `notes` 등).
- 검색은 `App.catalogSearch(query, type, region)` → 카탈로그 운동 배열 반환.

## 3. 향후 미리보기 자산 연결 위치 (핵심)

미리보기 렌더는 이미 자산 조회 지점을 통해 분기하도록 되어 있다.

- `App._exercisePreviewAsset(catId)` — 운동 ID로 미리보기 자산 경로를 반환. **현재는 항상 `null`(자산 없음).**
  - 조회 소스: `window.FitlogCatalog.EXERCISE_PREVIEWS`(현재 미정의). 아래처럼 `catalog-data.js`에 가산적으로 추가하면 된다.
    ```js
    EXERCISE_PREVIEWS: {
      "barbell_curl": { type: "model", src: "assets/exercise-3d/barbell_curl.glb" },
      "lat_pulldown": { type: "video", src: "assets/exercise-3d/lat_pulldown.mp4" }
    }
    ```
- `App._addDetail` 안:
  ```js
  const asset = this._exercisePreviewAsset(c.id);
  if (asset) body.appendChild(el("div", { class: "addex-preview", "data-preview-exercise": c.id }));
  ```
  - **자산이 없으면 미리보기 영역을 아예 그리지 않는다**(빈 3D 영역·작동 안 하는 버튼 미표시 — 스펙 §6 준수).
  - 2차 개발에서는 이 `if (asset)` 블록 안에서 `asset.type`에 따라 `<model-viewer>`/`<video>`/이미지 등으로 실제 렌더를 채우면 된다. `.addex-preview` 스타일(높이 200px 영역)은 이미 `styles.css`에 있다.

## 4. 운동 카탈로그 ↔ 3D 자산 연결 규약(권장)

- 자산 키는 **카탈로그 운동 ID**로 통일(검색·상세·추가가 모두 이 ID를 사용).
- 자산 파일은 `assets/exercise-3d/<catalogId>.<ext>` 권장. Service Worker `THREE3D`/신규 그룹에 best-effort 프리캐시로 추가 가능(GLB 실패가 앱을 막지 않도록 분리 유지).

## 5. 현재 구현 / 미구현

| 항목 | 상태 |
|---|---|
| 운동 ID 기준 상세 화면 진입 | 구현 |
| 미리보기 자산 조회 분기(`_exercisePreviewAsset`) | 구현(자산 없으면 null) |
| 자산 없을 때 빈 영역 미표시 | 구현 |
| 실제 3D/영상 미리보기 렌더 | 미구현(2차) |
| `EXERCISE_PREVIEWS` 자산 매핑 | 미정의(2차에서 가산 추가) |

## 6. 2차 연결 시 기존 앱에서 수정할 부분

- `catalog-data.js`: `EXERCISE_PREVIEWS` 추가(가산).
- `src/app.js` `_addDetail`: `if (asset)` 블록 내부에 실제 렌더 코드 채우기(그 외 흐름 수정 불필요).
- `service-worker.js`: 자산 프리캐시 목록에 추가(선택, best-effort).
- 운동 추가 UX 자체는 재작성 불필요.

## 7. AI 근육 매핑(별개 트랙, 참고)

- 직접 만든 운동은 `description`(동작 설명)을 저장한다(`exercises` 스토어). 향후 AI 프롬프트 생성 입력으로 사용.
- 매핑 적용부 `App.openMuscleMapModal` / `DB.setUserMuscleMap` / `userMuscleMap` 스토어는 보존되어 있어, AI JSON 검증·적용에 재사용 가능.
</content>
