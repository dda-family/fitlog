# Fitlog — 새 Claude Code 세션 인수인계 문서

> 작성: 2026-09-23
> 목적: 맥북 VSCode + Claude Code 환경에서 다음 세션이 컨텍스트 없이도 바로 작업할 수 있도록.

---

## 1. 이 앱이 뭔지

iPhone 홈 화면에 추가한 **오프라인 우선 운동기록 PWA**. 서버·로그인 없음. 데이터는 기기 로컬 IndexedDB에만 저장. GitHub Pages 정적 배포.

GitHub: https://github.com/dda-family/fitlog
배포 URL: https://dda-family.github.io/fitlog/

---

## 2. ★ 절대 원칙 (어기면 안 됨)

1. **IndexedDB 절대 건드리지 않음**: 운동 기록은 IndexedDB "fitlog" DB에 있음. "PWA 삭제하세요" / "Safari 데이터 초기화하세요" 절대 말하지 말 것.
2. **SW는 Cache Storage만 관리**: service-worker.js는 앱 파일만 다룸. IndexedDB 손대지 않음.
3. **버전 번호 2곳 동시 올리기**: 코드 수정 시 service-worker.js의 CACHE_VERSION과 app.js의 APP_VERSION을 같은 숫자로 +1.
4. **safe-area env() 직접 사용**: CSS 변수로 감싸면 iOS PWA 첫 렌더 시 0으로 평가됨. env(safe-area-inset-bottom, 0px) 직접 쓸 것.
5. **src/ 폴더 없음**: v22에서 완전 폐지. 앱 파일 전부 루트에 있음.

---

## 3. 현재 버전

- APP_VERSION (app.js): v25
- CACHE_VERSION (service-worker.js): fitlog-v25
- 다음 수정 시 둘 다 v26으로 올릴 것

---

## 4. 배포 워크플로우

```bash
git add -A
git commit -m "수정 내용"
git push
# → 1~2분 뒤 GitHub Pages 자동 반영
```

---

## 5. 완료된 기능 (Phase 1~4)

- Phase 1: 오늘화면·운동카드·세트완료·타이머(90s/180s)·워밍업·유산소·즉석운동추가
- Phase 2: IndexedDB 저장·지난번 기록·미정 중량 자동채움·기록 탭
- Phase 3: 가이드 편집·템플릿 CRUD·요일 매핑·JSON 백업/복원
- Phase 4: AI 코치(프롬프트 생성 + 제안 JSON 적용)
- 추가: 드래그 다이얼·기록 통계·분석기간·화면 유지 강화(WakeLock)
- v25: 운동 추가 → 상세 화면 3D 운동 애니메이션(바벨 컬·덤벨 이두 컬·케이블 컬, Astra 제작). 히트맵용 `assets/anatomy/human_3d.glb`와 애니메이션용 `assets/exercises/*.glb`는 별개 파일이며 서로 교체 금지
- `_astra_review/`는 외부 제작 패키지 검토용(읽기 전용, `.gitignore` 대상). 자산 수정·커밋 금지

---

## 6. 미확인 버그 (iPhone에서 확인 필요)

1. 탭바 하단 위치 — 첫 실행 때 앱 화면 자체가 상태바 높이만큼 짧게 잡힘(아래는 그릴 수 없는 영역). CSS나 탭바 내리기(v23)로는 해결 불가. v24에서 짧게 잡힌 걸 감지하면 1px 스크롤을 유도하는 방식으로 재수정, 기기 확인 필요. 설정 → 앱 버전 옆 `화면 첫값→현재값/화면높이 · 보정 N` 진단값으로 확인
2. 운동 추가 검색창 — v23에서 해결 확인. v24에서 키보드가 열렸을 때 시트 상단이 상태바에 가리지 않게 safe-area만큼 내림

---

## 7. 문서 우선순위

1. 최근 사용자 요구사항
2. docs/DECISIONS.md
3. docs/PRODUCT_SPEC.md → UX_SPEC.md → DATA_SPEC.md
4. CLAUDE.md

새 작업 전 항상 CLAUDE.md → docs/DECISIONS.md 먼저 읽을 것.