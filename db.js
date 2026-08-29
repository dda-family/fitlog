/* db.js — IndexedDB 래퍼 + 시드 (DATA_SPEC §3~§7, §20)
 * 스토어: settings, exercises, routineTemplates, routineGuides, workoutSessions, guideHistory
 * Phase 2: 세션 저장/조회, 지난번 기록, 미정 중량 자동채움까지 사용.
 */
const DB_NAME = "fitlog";
const DB_VERSION = 1;
const STORES = {
  settings:         { keyPath: "id" },
  exercises:        { keyPath: "id" },
  routineTemplates: { keyPath: "id", indexes: [["order", "order"]] },
  routineGuides:    { keyPath: "id", indexes: [["templateId", "templateId"], ["exerciseId", "exerciseId"]] },
  workoutSessions:  { keyPath: "id", indexes: [["date", "date"], ["templateId", "templateId"]] },
  guideHistory:     { keyPath: "id" },
};

const DB = {
  _db: null,

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB 미지원"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const [name, cfg] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            const os = db.createObjectStore(name, { keyPath: cfg.keyPath });
            (cfg.indexes || []).forEach(([iname, kp]) => os.createIndex(iname, kp));
          }
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  _store(name, mode) { return this._db.transaction(name, mode).objectStore(name); },
  _p(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); },

  get(store, key) { return this._p(this._store(store, "readonly").get(key)); },
  getAll(store) { return this._p(this._store(store, "readonly").getAll()); },
  put(store, value) { return this._p(this._store(store, "readwrite").put(value)); },
  delete(store, key) { return this._p(this._store(store, "readwrite").delete(key)); },
  getByIndex(store, index, value) { return this._p(this._store(store, "readonly").index(index).getAll(value)); },

  async clearAll() {
    await this.open();
    for (const name of Object.keys(STORES)) await this._p(this._store(name, "readwrite").clear());
  },

  // 세션을 최신순(date desc, 같은 날은 createdAt desc)으로
  async recentSessions(limit) {
    await this.open();
    const all = await this.getAll("workoutSessions");
    all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
    return limit ? all.slice(0, limit) : all;
  },

  // 특정 운동의 가장 최근 실제 결과(work 세트 존재하는)
  async lastResultFor(exerciseId) {
    const sessions = await this.recentSessions();
    for (const s of sessions) {
      const r = (s.exerciseResults || []).find((x) => x.exerciseId === exerciseId);
      if (r) {
        const work = (r.sets || []).filter((x) => x.setType === "work");
        if (work.length) return { session: s, result: r, workSets: work };
      }
    }
    return null;
  },

  async lastUsedWeight(exerciseId) {
    const last = await this.lastResultFor(exerciseId);
    return last ? last.workSets[0].weight : null;
  },

  // 최초 실행 시 시드 (이미 데이터 있으면 no-op) — DATA_SPEC §20
  async seedIfEmpty() {
    await this.open();
    const existing = await this.getAll("routineTemplates");
    if (existing && existing.length) return false;
    for (const tpl of SEED.templates) await this.put("routineTemplates", tpl);
    for (const ex of SEED.exercises) await this.put("exercises", ex);
    for (const g of SEED.guides) await this.put("routineGuides", g);
    await this.put("settings", {
      id: "app-settings", setRestSeconds: 90, exerciseRestSeconds: 180, soundEnabled: true,
      dayTemplateMap: SEED.dayTemplateMap, schemaVersion: 1,
    });
    return true;
  },
};

// 시드 = 사용자가 기획한 현재 컨디션 기준 기본 루틴 (PRODUCT_SPEC §5).
// 최초 실행 시 1회만 깔리고(seedIfEmpty), 이후엔 일반 데이터라 가이드 화면에서 자유 편집 가능.
const SEED = {
  templates: [
    { id: "tpl-back-shoulder-biceps", name: "등·어깨·이두", order: 1, active: true },
    { id: "tpl-chest-triceps",        name: "가슴·삼두",    order: 2, active: true },
    { id: "tpl-legs",                 name: "하체",         order: 3, active: true },
  ],
  exercises: [
    { id: "lat-pulldown",            name: "랫풀다운",           category: "back",     unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "seated-cable-row",        name: "시티드 케이블 로우", category: "back",     unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "dumbbell-shoulder-press", name: "덤벨 숄더프레스",    category: "shoulder", unit: "kg", sideMode: "per_hand", warmupEnabled: false, active: true },
    { id: "lateral-raise",           name: "레터럴 레이즈",      category: "shoulder", unit: "kg", sideMode: "per_hand", warmupEnabled: false, active: true },
    { id: "reverse-pec-deck",        name: "리버스 펙덱",        category: "shoulder", unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "front-raise",             name: "프론트 레이즈",      category: "shoulder", unit: "kg", sideMode: "per_hand", warmupEnabled: false, active: true },
    { id: "biceps-curl",             name: "이두 컬",            category: "arm",      unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "assisted-pullup",         name: "어시스트 풀업",      category: "back",     unit: "kg", sideMode: "assist",   warmupEnabled: false, active: true },
    { id: "bench-press",             name: "벤치프레스",         category: "chest",    unit: "kg", sideMode: "total",    warmupEnabled: true,  active: true },
    { id: "incline-bench-press",     name: "인클라인 벤치프레스", category: "chest",    unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "assisted-dips",           name: "어시스트 딥스",      category: "chest",    unit: "kg", sideMode: "assist",   warmupEnabled: false, active: true },
    { id: "pec-deck-fly",            name: "펙덱 플라이",        category: "chest",    unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "triceps-pushdown",        name: "삼두 푸시다운",      category: "arm",      unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "squat",                   name: "스쿼트",             category: "leg",      unit: "kg", sideMode: "total",    warmupEnabled: true,  active: true },
    { id: "leg-extension",           name: "레그 익스텐션",      category: "leg",      unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "leg-curl",                name: "레그 컬",            category: "leg",      unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
    { id: "hip-abduction",           name: "힙 어브덕션",        category: "leg",      unit: "kg", sideMode: "total",    warmupEnabled: false, active: true },
  ],
  guides: [
    { id: "g-lat-pulldown",            templateId: "tpl-back-shoulder-biceps", exerciseId: "lat-pulldown",            order: 1, targetWeight: 28,   targetSets: 3, minReps: 8,  maxReps: 12, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-seated-cable-row",        templateId: "tpl-back-shoulder-biceps", exerciseId: "seated-cable-row",        order: 2, targetWeight: 28,   targetSets: 3, minReps: 8,  maxReps: 12, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-dumbbell-shoulder-press", templateId: "tpl-back-shoulder-biceps", exerciseId: "dumbbell-shoulder-press", order: 3, targetWeight: 6,    targetSets: 3, minReps: 8,  maxReps: 12, optional: false, warmupSuggestions: [], notes: "한 손 6kg" },
    { id: "g-lateral-raise",           templateId: "tpl-back-shoulder-biceps", exerciseId: "lateral-raise",           order: 4, targetWeight: 3,    targetSets: 3, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "한 손 3kg" },
    { id: "g-reverse-pec-deck",        templateId: "tpl-back-shoulder-biceps", exerciseId: "reverse-pec-deck",        order: 5, targetWeight: 25,   targetSets: 3, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-front-raise",             templateId: "tpl-back-shoulder-biceps", exerciseId: "front-raise",             order: 6, targetWeight: 3,    targetSets: 2, minReps: 10, maxReps: 15, optional: true,  warmupSuggestions: [], notes: "시간 부족 시 우선 생략" },
    { id: "g-biceps-curl",             templateId: "tpl-back-shoulder-biceps", exerciseId: "biceps-curl",             order: 7, targetWeight: null, targetSets: 2, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "첫 사용 후 중량 확정" },
    { id: "g-assisted-pullup",         templateId: "tpl-back-shoulder-biceps", exerciseId: "assisted-pullup",         order: 8, targetWeight: null, targetSets: 2, minReps: 5,  maxReps: 12, optional: true,  warmupSuggestions: [], notes: "가끔 수행. 정규 목표 볼륨 미포함" },
    { id: "g-bench-press",             templateId: "tpl-chest-triceps", exerciseId: "bench-press",         order: 1, targetWeight: 40,   targetSets: 3, minReps: 8,  maxReps: 10, optional: false, warmupSuggestions: [ { weight: 20, reps: "10-12", note: "빈 봉" }, { weight: 30, reps: "5-8" } ], notes: "" },
    { id: "g-incline-bench-press",     templateId: "tpl-chest-triceps", exerciseId: "incline-bench-press", order: 2, targetWeight: 40,   targetSets: 3, minReps: 8,  maxReps: 10, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-assisted-dips",           templateId: "tpl-chest-triceps", exerciseId: "assisted-dips",       order: 3, targetWeight: 75,   targetSets: 2, minReps: 6,  maxReps: 12, optional: false, warmupSuggestions: [], notes: "보조중량 75kg 기준. 체중≈98kg. 보조↑=부담↓" },
    { id: "g-pec-deck-fly",            templateId: "tpl-chest-triceps", exerciseId: "pec-deck-fly",        order: 4, targetWeight: 25,   targetSets: 3, minReps: 10, maxReps: 12, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-triceps-pushdown",        templateId: "tpl-chest-triceps", exerciseId: "triceps-pushdown",    order: 5, targetWeight: null, targetSets: 2, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "첫 사용 후 중량 확정" },
    { id: "g-squat",                   templateId: "tpl-legs", exerciseId: "squat",         order: 1, targetWeight: 40, targetSets: 3, minReps: 8,  maxReps: 10, optional: false, warmupSuggestions: [ { weight: 20, reps: "10", note: "빈 봉" }, { weight: 30, reps: "5" } ], notes: "시작값 40kg. 첫 기록 후 실제값으로 수정" },
    { id: "g-leg-extension",           templateId: "tpl-legs", exerciseId: "leg-extension", order: 2, targetWeight: 28, targetSets: 3, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-leg-curl",                templateId: "tpl-legs", exerciseId: "leg-curl",      order: 3, targetWeight: 35, targetSets: 3, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "" },
    { id: "g-hip-abduction",           templateId: "tpl-legs", exerciseId: "hip-abduction", order: 4, targetWeight: 28, targetSets: 3, minReps: 10, maxReps: 15, optional: false, warmupSuggestions: [], notes: "" },
  ],
  cardioDefault: { type: "incline_walk", incline: 12, speedKmh: 4.8, durationMinutes: 30 },
  dayTemplateMap: { mon: null, tue: "tpl-back-shoulder-biceps", wed: null, thu: "tpl-chest-triceps", fri: null, sat: "tpl-legs", sun: null },
};

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function weekdayKeyOf(dateStr) { return WEEKDAY_KEYS[new Date(dateStr + "T00:00:00+09:00").getDay()]; }

window.FitlogDB = { DB, SEED, weekdayKeyOf, DB_NAME, DB_VERSION };
