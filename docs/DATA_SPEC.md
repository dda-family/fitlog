# DATA_SPEC.md — Fitlog 데이터/로직 정의서

> 사전 개발 검토 결정 반영본. 변경 요약은 `docs/DECISIONS.md`.
> 아직 배포 전이므로 `schemaVersion`은 1을 유지하되, 아래 신규 모델을 v1의 기준으로 삼는다.

## 1. 데이터 저장 원칙
Fitlog는 서버 없는 개인용 앱이다.

- 실제 운동 데이터는 IndexedDB에 저장한다.
- localStorage는 작은 UI 설정/임시 상태(예: 마지막 활성 탭, 오디오 언락 여부) 외에는 주 저장소로 쓰지 않는다.
- 앱 삭제·Safari 사이트 데이터 삭제 등으로 로컬 데이터가 손실될 수 있으므로 JSON 백업을 제공한다.
- 클라우드 동기화는 MVP 범위 밖.

## 2. 데이터 버전
```text
schemaVersion = 1
```
향후 구조 변경 시 기존 데이터를 읽을 수 있도록 마이그레이션한다.

## 3. IndexedDB 이름
```text
DB_NAME = "fitlog"
DB_VERSION = 1
```

## 4. Object Store 구조 (v1)

스토어 목록: `settings`, `exercises`, `routineTemplates`(신규), `routineGuides`, `workoutSessions`, `guideHistory`.

### 4.1 settings — key: `id`
`dayTemplateMap`이 요일→템플릿 매핑을 담는다(신규).

```json
{
  "id": "app-settings",
  "setRestSeconds": 90,
  "exerciseRestSeconds": 180,
  "soundEnabled": true,
  "dayTemplateMap": {
    "mon": null,
    "tue": "tpl-back-shoulder-biceps",
    "wed": null,
    "thu": "tpl-chest-triceps",
    "fri": null,
    "sat": "tpl-legs",
    "sun": null
  },
  "schemaVersion": 1
}
```

요일 키는 소문자 3자(`mon`..`sun`)로 고정. 표시용 한글 요일은 날짜에서 파생한다.

### 4.2 exercises — 운동 마스터
```json
{
  "id": "lat-pulldown",
  "name": "랫풀다운",
  "category": "back",
  "unit": "kg",
  "sideMode": "total",
  "warmupEnabled": false,
  "active": true
}
```

`sideMode`:
- `total` 총 중량
- `per_hand` 한 손 기준
- `assist` 보조 중량 (판정 역방향, §8.4)
- `bodyweight` 체중
- `none` 중량 미사용

`warmupEnabled`(신규): 워밍업 입력 UI 노출 여부. 벤치·스쿼트만 시드에서 `true`.

### 4.3 routineTemplates — 루틴 템플릿 (신규)
요일에 종속되지 않는 독립 엔티티.
```json
{
  "id": "tpl-back-shoulder-biceps",
  "name": "등·어깨·이두",
  "order": 1,
  "active": true
}
```

### 4.4 routineGuides — 현재 가이드
`dayKey` 대신 `templateId`로 템플릿에 소속된다(변경).
```json
{
  "id": "g-lat-pulldown",
  "templateId": "tpl-back-shoulder-biceps",
  "exerciseId": "lat-pulldown",
  "order": 1,
  "targetWeight": 28,
  "targetSets": 3,
  "minReps": 8,
  "maxReps": 12,
  "optional": false,
  "warmupSuggestions": [],
  "notes": ""
}
```

- `targetWeight`: `null` 허용(미정 종목). §6.
- `warmupSuggestions`(신규, 선택): 워밍업 안내용 배열. 예 벤치:
  ```json
  [ { "weight": 20, "reps": "10-12", "note": "빈 봉" },
    { "weight": 30, "reps": "5-8" } ]
  ```
  안내 표시용이며 판정에 쓰지 않는다.

인덱스 권장: `templateId`, `[templateId+order]`, `exerciseId`.

### 4.5 workoutSessions — 하루 세션
실제 날짜·요일·수행 템플릿을 항상 저장(변경).
```json
{
  "id": "2026-08-26T21:00:00+09:00",
  "date": "2026-08-26",
  "weekday": "wed",
  "templateId": "tpl-back-shoulder-biceps",
  "status": "completed",
  "exerciseResults": [],
  "cardio": null,
  "createdAt": "2026-08-26T21:00:00+09:00",
  "updatedAt": "2026-08-26T22:30:00+09:00"
}
```

- `date`: 로컬(KST) 캘린더 날짜.
- `weekday`(신규): `date`에서 파생한 요일 키. 화 템플릿을 수요일에 해도 `"wed"`.
- `templateId`(신규): 실제 수행한 템플릿. 요일 매핑과 달라도 됨.
- 인덱스 권장: `date`, `templateId`, `[templateId+date]`(지난번 기록 조회용).

### 4.6 guideHistory — 가이드 변경 이력
```json
{
  "id": "guide-change-uuid",
  "changedAt": "2026-09-15T12:00:00+09:00",
  "source": "manual",
  "before": {},
  "after": {},
  "notes": "이두 컬 첫 사용값 가이드 승격"
}
```
`source`: `manual` | `ai-import`.

## 5. workoutSessions 상세

### 5.1 exerciseResults[]
```json
{
  "exerciseId": "bench-press",
  "sideMode": "total",
  "guideSnapshot": {
    "targetWeight": 40,
    "targetSets": 3,
    "minReps": 8,
    "maxReps": 10
  },
  "sets": [
    { "setNumber": 0, "setType": "warmup", "weight": 20, "reps": 10, "completed": true },
    { "setNumber": 1, "setType": "work",   "weight": 40, "reps": 9,  "completed": true },
    { "setNumber": 2, "setType": "work",   "weight": 40, "reps": 8,  "completed": true },
    { "setNumber": 3, "setType": "work",   "weight": 40, "reps": 8,  "completed": true }
  ],
  "status": "completed",
  "skipReason": null,
  "notes": ""
}
```

- `sideMode`를 결과에도 스냅샷해 과거 기록의 판정 방향(어시스트 여부)을 보존한다.
- `setType`: `warmup` | `work`. 판정은 `work`만 사용.

### 5.2 왜 guideSnapshot이 필요한가
과거 기록은 당시 가이드 기준으로 평가해야 한다. 현재 가이드가 32kg로 바뀌어도 과거 28kg 기록이 재평가되면 안 된다. 세션 저장 시 당시 가이드를 스냅샷으로 함께 저장한다.

## 6. 미정 중량 로직 (신규 확정)
- 시드 가이드의 `targetWeight`가 `null`이면 "미정" 종목.
- **지난 사용값**은 별도 필드 없이 해당 `exerciseId`의 가장 최근 세션 `work` 세트 무게에서 파생한다(원하면 성능상 캐시 가능).
- 입력칸 자동 채움 우선순위: `가이드 targetWeight` → (null이면) `지난 사용값` → (없으면) 빈칸.
- 사용자가 `가이드 기본값으로 저장`을 누르면 그 값을 `routineGuides.targetWeight`에 기록하고 `guideHistory`에 `manual` 이력 추가. **자동 승격 금지.**

## 7. 워밍업 (신규 확정)
- 종목 단위 `exercises.warmupEnabled`로 표시 여부 결정.
- 안내 문구는 `routineGuides.warmupSuggestions`.
- 실제 워밍업 수행은 `sets[]`에 `setType: "warmup"`로 저장.
- 판정·완료율·증량후보는 `setType === "work"`만 사용.
- 첫 버전에서 UI가 복잡하면 워밍업 기록 입력은 접힘 기본, 안내만 노출해도 된다.

## 8. 판정 함수

### 8.1 세트 판정
입력 `reps, minReps, maxReps` → `under` | `in_range` | `over`
```text
if reps < minReps: under
elif reps <= maxReps: in_range
else: over
```

### 8.2 운동 판정
입력: `targetSets, workSets(=setType 'work' 완료 세트), minReps, maxReps, skipped, optional, sideMode, targetWeight`
출력: `not_started` | `skipped` | `volume_under` | `completed` | `progression_candidate`
```text
if skipped: skipped
if workSets.length == 0: not_started
completed_count = workSets.filter(completed).length
if completed_count < targetSets: volume_under
if targetWeight == null:
    # 미정 종목: 반복수만 기준
    if every work set reps >= maxReps: progression_candidate
    elif every work set reps >= minReps: completed
    else: volume_under
else:
    if every work set reps >= maxReps: progression_candidate
    elif every work set reps >= minReps: completed
    else: volume_under
```
자동 증량 금지.

### 8.3 증량 방향
판정과 함께 `progressionDirection`을 반환한다.
```text
if status != progression_candidate: direction = null
elif sideMode == "assist":       direction = "decrease_assist"   # 보조중량 ↓ = 난이도 ↑
else:                            direction = "increase"          # 중량 ↑
```
UI는 이 값으로 문구를 노출한다. (어시스트 딥스/풀업은 "보조중량 ↓ 고려")

### 8.4 어시스트 종목 주의
`sideMode: assist`는 판정 임계값 자체는 동일하다(반복수 비교). 다른 것은 §8.3의 권장 방향뿐이다. 어시스트 풀업은 `optional`이며 목표 볼륨(완료율)에서 제외.

## 9. 전체 루틴 완료율
필수 운동만 기본 분모.
```text
완료율 = 완료한 필수 운동 수 / 전체 필수 운동 수
```
`completed`·`progression_candidate`는 완료로 계산. `volume_under`는 부분 완료로 별도 표시. 선택 운동은 완료율을 깎지 않는다.

## 10. 타이머 상태 (사전 검토 반영)
타이머는 영구 기록 데이터가 아니다. 메모리 상태 예:
```json
{ "type": "set_rest", "durationSeconds": 90, "startedAt": 0, "endsAt": 0, "running": true, "wakeActive": true }
```
- `endsAt = startedAt + durationSeconds*1000` 기준으로 남은 시간 계산. `setInterval`은 표시 갱신용일 뿐 신뢰하지 않는다.
- `visibilitychange`로 앱 복귀 시 `endsAt - Date.now()`로 재계산.
- `running` 동안 화면 유지(무음 video)를 켜고, 종료/취소 시 끈다(`wakeActive`).
- `type`: `set_rest`(90s) | `exercise_rest`(180s).

## 11. 알림 사운드 (사전 검토 반영)
- 소스: 자체 제작 `assets/sounds/rest-end.mp3` (짧고 부드러운 차임). iPhone 시스템 사운드는 접근 불가.
- 진동 없음. 앱 시작 후 `🎧 알림 사운드 테스트`로 재생 가능(오디오 언락 겸용).
- iOS 현재 미디어 출력 경로 사용. AirPods 전용 강제는 가정하지 않는다.
- 재생 신뢰 조건: 앱이 화면 켜진 포그라운드(§CLAUDE §5). 오디오 요소는 최초 사용자 제스처에서 프라임해 언락.

## 12. 백업 JSON 포맷
```json
{
  "app": "fitlog",
  "schemaVersion": 1,
  "exportedAt": "2026-09-01T10:00:00+09:00",
  "settings": {},
  "exercises": [],
  "routineTemplates": [],
  "routineGuides": [],
  "workoutSessions": [],
  "guideHistory": []
}
```
`routineTemplates`가 백업에 포함된다(신규).

## 13. 백업 Export
1. IndexedDB 전체(위 스토어) 읽기 → 2. 백업 객체 생성 → 3. JSON 직렬화 → 4. 다운로드/공유 형태 생성.
파일명: `fitlog-backup-YYYY-MM-DD.json`.

## 14. 백업 Import
1. JSON 파싱 → 2. `app === "fitlog"` 확인 → 3. `schemaVersion` 확인 → 4. 필수 필드 검사 → 5. 복원 확인 → 6. 기존 DB 보존 → 7. Import → 8. 성공/실패 처리(실패 시 기존 유지). MVP 기본: 전체 덮어쓰기. Merge는 이후.

## 15. AI Export 데이터
개인정보/기기정보 제외. 포함: 템플릿 + 요일 매핑 / 현재 가이드 / 최근 4주 세션 / 운동별 최근 3~5회 기록 / 반복적 생략 사유 / 증량 후보(+방향) / 사용자 제약.

## 16. AI Import 포맷
```json
{
  "format": "fitlog-guide-update",
  "version": 1,
  "summary": "변경 제안 요약",
  "changes": [
    {
      "guideId": "g-lat-pulldown",
      "action": "update",
      "before": { "targetWeight": 28, "targetSets": 3, "minReps": 8, "maxReps": 12 },
      "after":  { "targetWeight": 32, "targetSets": 3, "minReps": 8, "maxReps": 12 },
      "reason": "최근 목표 반복수 달성"
    }
  ]
}
```
허용 action: `update` | `add` | `remove` | `reorder`. 앱은 즉시 적용하지 않는다.

## 17. AI Import 검증
format 일치 / version 지원 / guideId 존재 / 숫자 필드 타입 / 세트 수 ≥ 1 / `minReps <= maxReps` / 중량 음수 금지 / 예상 못한 필드 무시 또는 경고. 적용 전 diff 표시.

## 18. 데이터 삭제
설정 → 전체 초기화 → 1차 확인 → 강한 2차 확인.
```text
모든 운동기록과 가이드가 삭제됩니다.
이 작업은 되돌릴 수 없습니다.
[취소] [전체 삭제]
```

## 19. 오프라인/PWA
Service Worker가 앱 셸과 사운드를 캐시. 최소 캐시: `index.html`, `styles.css`, JS 파일들, `manifest.webmanifest`, 아이콘, `assets/sounds/rest-end.mp3`. 운동 데이터는 Cache Storage가 아니라 IndexedDB에 저장.

### 19.1 진행 중 세션 임시 저장 (v38)
저장(오늘 운동 저장) 전의 오늘 세션은 `localStorage["fitlog-active-session"]`에 임시로 둔다. IndexedDB 스토어·스키마 버전·백업 파일과 무관하다(백업에 포함되지 않음).
```text
{ v: 1, savedAt, date: "YYYY-MM-DD", session: { templateId, results, extras, cardio, groupProgress, order, removed },
  ended, hist: { undo: [...], redo: [...] }, cmdSeq, extraSeq, rest: { type, startedAt, endsAt, key } | null,
  summary: { name, total, started } }
```
- `session.order`: 오늘 순서(블록 키 `s:<guideId>` · `g:<groupId>` · `e:<extraId>`), `session.removed`: 오늘에서 삭제한 블록 키. 저장된 루틴은 바뀌지 않는다.
- 쓰기: 입력/동작마다, 앱을 숨기거나 떠날 때. 시간형 수행 엔진이 도는 동안은 쓰지 않는다(직전 상태 유지).
- 삭제: 오늘 운동 저장 성공 · 복구 화면의 [새로 시작] · 전체 초기화 · 백업 복원. 정식 기록(`workoutSessions`)에는 섞지 않는다.
- 읽을 때 형식이 맞지 않거나 루틴이 없어졌으면 조용히 버린다.

### 19.2 오늘 추가한 운동 · 최근 실제 기록 (v42)
- **오늘 추가한 운동**(`adhoc: true`)도 정식 기록의 한 운동이다. 저장 직전 이름으로 안정적인 운동 ID를 정한다:
  내 운동(`exercises`) 이름 → 카탈로그 이름·별칭(앱 운동으로 확보) → 둘 다 없으면 `exercises`에 새 운동 등록
  (`{ id: "ex-…", name, category: "custom", sideMode: "total", createdFrom: "today" }`). 루틴(가이드)에는 추가하지 않는다.
  v41 이전 기록의 `exerciseId: "extra-N"`은 그대로 두며(마이그레이션 없음), 최근 기록 조회 때만 `exerciseName`으로 이어 본다.
  이름 없이 저장한 추가 운동은 예전처럼 `extra-N`으로 남는다.
- **최근 실제 기록**은 `workoutSessions`에서 그때그때 파생한다(별도 스토어·캐시 저장 없음 → 백업 복원 후 자동 재계산).
  운동 ID 기준 가장 최근 기록(루틴 무관). `status: "skipped"`·본세트 없는 기록은 건너뛰고, 워밍업 세트는 쓰지 않는다.
- 요약·기록 카드·근육 집계는 저장된 `exerciseResults`만 읽는다(루틴을 다시 읽지 않음). 오늘 추가한 운동도 같은 기준으로 센다.

### 19.3 운동 종료 시 루틴 반영 (v44)
- 오늘 세션(`session.order`·`session.extras`·`session.removed`)은 운동 중 루틴(`routineGuides`)을 바꾸지 않는다. 오늘 운동 저장 때만, 사용자가 고른 것만 반영한다.
- 반영 후보는 두 가지: **새로 추가한 운동**(오늘에서 삭제하지 않았고, 이름이 있고, 본세트를 1개 이상 기록했으며, 루틴에 아직 없는 운동) · **운동 순서**(오늘에서 삭제한 블록을 뺀 원본 블록끼리의 상대 순서가 다를 때). 생략·미실시·오늘에서 삭제·중량/횟수/세트·메모·수행 결과는 후보가 아니다.
- 저장 순서: ① 정식 기록(`workoutSessions`) 저장 ② 그 뒤 루틴 반영. 반영이 실패해도 기록은 남는다.
- 반영 방식(블록 단위 — 연속 세트는 한 덩어리, 그룹 구성은 바꾸지 않음):
  - 순서: 원본 루틴에서 "오늘 살아 있던" 블록 자리들에 오늘 순서대로 채운다. 오늘에서 삭제한 블록은 원래 자리 그대로 남는다. `routineGuides.order`만 다시 매김.
  - 추가: 오늘 순서에서 바로 앞에 있던 원본 블록(오늘에서 삭제한 것 포함) 또는 먼저 넣은 추가 운동 바로 뒤에 넣는다. 앞에 아무것도 없으면 맨 앞. 순서를 반영하지 않아도 기존 운동끼리의 상대 순서는 바뀌지 않는다.
  - 새 `routineGuides` 항목: 다른 루틴에 같은 운동 가이드가 있으면 그 목표값을 복사(`groupId` 제외), 없으면 앱 기본(3세트·8~12회·`targetWeight: null`, 시간형 가능 운동은 `targetDurationSeconds: 30`). 오늘 실제 수행값은 가이드로 옮기지 않는다. 운동 ID는 §19.2와 같은 저장용 ID.
- 새 스토어·필드·DB 버전 변경 없음. `settings.soundEnabled`(기존 필드)는 오늘 화면 토글로도 바뀐다.

## 20. 초기 시드 데이터
최초 실행 시 PRODUCT_SPEC §5의 기본값을 생성한다.
- `routineTemplates`: 3개(등·어깨·이두 / 가슴·삼두 / 하체).
- `exercises`: 각 종목 마스터(벤치·스쿼트는 `warmupEnabled: true`, 어시스트 딥스·풀업은 `sideMode: assist`, 덤벨류는 `per_hand`).
- `routineGuides`: 각 템플릿에 소속. 미정 중량(이두 컬·삼두 푸시다운)은 `targetWeight: null`. 벤치는 `warmupSuggestions` 포함.
- `settings.dayTemplateMap`: 화·목·토 기본 매핑.
- 이미 데이터가 있으면 시드가 덮어쓰지 않는다.

## 21. 테스트 시나리오
1. 첫 실행 → 템플릿 3개 + 요일 매핑 + 가이드 시드 생성
2. 28kg / 12,11,9 → `completed`
3. 28kg / 12,12,12 → `progression_candidate`, direction `increase`
4. 어시스트 딥스 목표 반복 초과 → `progression_candidate`, direction `decrease_assist`
5. 28kg / 12,7 후 종료 → `volume_under`
6. 선택 운동 생략 → 완료율 영향 없음
7. 미정 종목 첫 기록 → 다음 사용 시 자동 채움 → 승격 버튼으로 가이드 확정
8. 벤치 워밍업 20kg 기록 → 판정에서 제외, 본세트만 평가
9. 화 템플릿을 수요일에 수행 → 세션 `weekday: "wed"`, `templateId` 화 템플릿
10. 요일 매핑 화목토 → 월수금 변경 → 과거 세션 불변
11. 가이드 변경 후 과거 기록 평가 유지(guideSnapshot)
12. 브라우저/PWA 종료 후 기록 유지
13. JSON 백업 후 DB 초기화 → 복원 성공(템플릿 포함)
14. 잘못된 JSON Import → 기존 데이터 유지
15. AI 변경안 검증 → 사용자 승인 전 가이드 불변
