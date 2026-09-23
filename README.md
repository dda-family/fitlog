# Fitlog

오프라인 우선 개인용 운동기록 PWA. 서버·로그인 없음. 데이터는 iPhone 로컬(IndexedDB)에 저장.

## 문서 (소스 오브 트루스)
개발 전 항상 아래 순서로 확인. 충돌 시 위가 우선.
1. `docs/DECISIONS.md` — 확정 결정 로그 (가장 최근 판단)
2. `docs/PRODUCT_SPEC.md` — 제품/기능
3. `docs/UX_SPEC.md` — 화면/흐름
4. `docs/DATA_SPEC.md` — 데이터/판정 로직
5. `CLAUDE.md` — 개발 지침·원칙

문서는 계속 두텁게 갱신하며 그 기준으로 개발한다.

## 구조 (루트 평탄화 — src/ 없음)
```
fitlog/                        # 저장소 루트 = 앱이 열리는 곳 = GitHub Pages 서빙 위치
├── index.html styles.css      # app/db/timer/evaluation/backup/ai-bridge/catalog-data/heatmap.js
├── runtime/                   # 3D 뷰어(Three.js). index.html 옆(루트)에 있어야 함
├── assets/                    # icons/, sounds/rest-end.mp3, video/, anatomy/(SVG+GLB)
├── data/                      # muscle-regions.json, anatomy-3d-map.json
├── docs/                      # 스펙 4종 + 결정 로그 + DEPLOY.md
├── CLAUDE.md README.md
├── manifest.webmanifest       # start_url: "./index.html"
└── service-worker.js          # CACHE_VERSION (app.js의 APP_VERSION과 같은 숫자로 유지)
```
> 배포·버전 관리 규칙은 `docs/DEPLOY.md` 참고. 모든 작업은 맥북 로컬에서 하고 `git push` 하나로 배포한다.
`evaluation.js`는 판정 로직 완전 구현, `app.js`/`timer.js`/`styles.css`는 **Phase 1이 메모리 기반으로 동작하게 구현**되어 있다(저장은 아직 없음). `db.js`(SEED는 채워짐, IndexedDB 로직은 스텁)·`backup.js`·`ai-bridge.js`는 Phase 2~4용 스텁이며, 각 TODO에 해당 스펙 섹션을 주석으로 달아뒀다.

## 지금 되는 것 / 아직 안 되는 것
**됨 (Phase 1~2, 브라우저에서 바로):** 오늘 화면(요일 매핑 제안 + 날짜 탭 변경 + 템플릿 드롭다운) · 운동 카드 · 중량/반복 스텝퍼·직접 입력 · 세트 완료 → 90초 타이머(화면 유지 + 0초 단일 차임) · 마지막 세트 → 180초 · 큰 인라인 카운트다운 · 벤치/스쿼트 워밍업(중량·반복 입력, 자동 기록) · ＋운동 추가(즉석) · ＋세트 추가(목표 초과, 기록엔 남고 판정 제외) · 유산소 상시 카드 · 종료 요약 · **IndexedDB 저장(껐다 켜도 남음)** · **지난번 기록 자동 표시** · **미정 중량 자동 채움** · **기록 탭(날짜별 목록+상세)** · 설정(휴식 시간 저장·알림 테스트·전체 초기화) · 어시스트 역방향·워밍업 제외 판정.
**아직 (다음 단계):** 가이드/루틴 편집·JSON 백업(Phase 3) · AI 코치(Phase 4) · 기록 통계.

## 구현 순서 (CLAUDE.md §9)
- Phase 1: 운동 중 코어 UI + 타이머 + 알림 테스트
- Phase 2: IndexedDB 저장 + 판정
- Phase 3: 기록/가이드 편집/백업
- Phase 4: AI 코치

## 로컬 실행 (MacBook)
정적 파일이라 간단한 서버로 확인:
```bash
cd fitlog
python3 -m http.server 8000
# http://localhost:8000/
```
> Service Worker/설치 확인은 HTTPS가 필요하다. 로컬 http에서는 앱 동작만 확인하고, 설치·오프라인 캐시는 배포 후 iPhone에서 확인.

## 배포 (서버 아님, 정적 호스팅)
GitHub Pages 사용. 맥북에서 `git push` 하면 자동 배포된다(zip·수동 업로드 없음).
- Settings → Pages → Source: Deploy from a branch → **main / (root)** → `https://<id>.github.io/<repo>/`
- 앱 파일만 올라가고 운동 기록(IndexedDB)은 올라가지 않는다.
- 코드 변경 시 `service-worker.js`의 `CACHE_VERSION`과 `app.js`의 `APP_VERSION`을 같은 숫자로 올린다. 자세한 건 `docs/DEPLOY.md`.

## iPhone 설치 (홈 화면에 추가)
1. Safari로 배포 URL 접속
2. 공유 → **홈 화면에 추가**
3. 홈 아이콘으로 실행하면 standalone PWA로 뜬다
4. 첫 실행 시 `🎧 알림 테스트`를 눌러 소리 언락

친구에게 공유: **배포 URL만 전달**. 각자 기기에 독립 저장되며 데이터는 공유되지 않는다.

## 알림음/타이머 주의 (중요)
iOS 특성상 화면이 꺼지거나 앱이 백그라운드로 가면 알림음이 보장되지 않는다. 그래서 타이머가 도는 동안 화면을 깨워두고(무음 video), 상단에 큰 카운트다운을 표시한다. 자세한 배경은 `docs/DECISIONS.md` D1.

## 데이터 백업
기기에만 저장되므로 설정에서 주기적으로 JSON 백업 권장. 폰 교체 시에도 백업 파일로 이전.
