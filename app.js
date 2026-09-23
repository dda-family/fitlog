/* app.js — Phase 2 (IndexedDB 저장 연결)
 * 오늘 화면 + 운동 카드 + 세트 입력 + 타이머 + 워밍업 + 유산소 + 즉석 운동 + 기록 조회 + 설정.
 * 정의(템플릿/운동/가이드)와 설정은 DB에서 로드(최초 실행 시 SEED로 시드). 세션은 DB에 저장.
 * 의존: FitlogDB, FitlogEval, FitlogTimer
 */
const APP_VERSION = "v26";

const WEEKDAY_KO = { sun: "일", mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토" };
const WD_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "hidden") { if (v) n.hidden = true; }
    else if (v != null) n.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return n;
}
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

const App = {
  view: "today",
  sessionDate: new Date(),
  session: null,
  lastMap: {},
  activeTimerExerciseId: null,
  ended: false,
  dbReady: false,
  _extraSeq: 0,

  async init() {
    this.wireTabs(); this.wireAudioUnlock(); this.wireTimerHooks();
    const FDB = window.FitlogDB;
    try {
      await FDB.DB.open(); await FDB.DB.seedIfEmpty();
      this.templates = (await FDB.DB.getAll("routineTemplates")).sort((a, b) => a.order - b.order);
      this.exercises = await FDB.DB.getAll("exercises");
      this.guides = await FDB.DB.getAll("routineGuides");
      try { this.userMap = await FDB.DB.userMuscleMapAll(); } catch (_) { this.userMap = {}; }
      this.settings = (await FDB.DB.get("settings", "app-settings")) || this.defaultSettings();
      this.dbReady = true;
    } catch (e) {
      console.warn("[Fitlog] IndexedDB 사용 불가 → SEED 폴백", e);
      this.templates = [...FDB.SEED.templates].sort((a, b) => a.order - b.order);
      this.exercises = FDB.SEED.exercises; this.guides = FDB.SEED.guides;
      this.settings = this.defaultSettings(); this.dbReady = false;
    }
    this.historyRange = this.loadHistoryRange();   // 기록 탭 분석 기간 (localStorage 유지)
    const todayKey = WD_KEYS[new Date().getDay()];
    const suggested = this.settings.dayTemplateMap[todayKey] || this.templates[0].id;
    this.startSession(suggested);
    await this.loadLastResults(suggested);
    this.show("today");
  },
  defaultSettings() {
    return { id: "app-settings", setRestSeconds: 90, exerciseRestSeconds: 180, soundEnabled: true, dayTemplateMap: window.FitlogDB.SEED.dayTemplateMap, schemaVersion: 1 };
  },

  // ---------------- 분석 기간(기록/AI 공용) ----------------
  defaultRange() {
    const end = new Date();
    const start = new Date(Date.now() - 6 * 86400000);   // 오늘 포함 최근 7일
    return { start: isoDate(start), end: isoDate(end) };
  },
  loadHistoryRange() {
    try {
      const raw = localStorage.getItem("fitlog-history-range");
      if (raw) {
        const r = JSON.parse(raw);
        if (r && r.start && r.end && r.start <= r.end) return { start: r.start, end: r.end };
      }
    } catch (_) {}
    return this.defaultRange();
  },
  saveHistoryRange() {
    try { localStorage.setItem("fitlog-history-range", JSON.stringify(this.historyRange)); } catch (_) {}
  },
  inRange(dateStr, range) { return dateStr >= range.start && dateStr <= range.end; },
  isCardio(ex, guide, res) {
    return (ex && ex.kind === "cardio") || (guide && guide.kind === "cardio") || (res && res.kind === "cardio");
  },

  wireTabs() {
    document.getElementById("tabbar").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab"); if (!btn) return; this.show(btn.dataset.view);
    });
  },
  wireAudioUnlock() {
    const once = () => { window.FitlogTimer.unlock(); document.removeEventListener("pointerdown", once); };
    document.addEventListener("pointerdown", once, { once: true });
  },
  wireTimerHooks() {
    const T = window.FitlogTimer;
    T.onTick = (ms) => { const cd = document.getElementById("inline-cd-num"); if (cd) cd.textContent = T._mmss(ms); };
    T.onEnd = () => {
      const wrap = document.getElementById("inline-cd"), num = document.getElementById("inline-cd-num"), label = document.getElementById("inline-cd-label");
      if (wrap) wrap.classList.add("ended"); if (num) num.textContent = "00:00"; if (label) label.textContent = "휴식 종료 · 다음 세트 준비";
      setTimeout(() => { this.activeTimerExerciseId = null; const bar = document.getElementById("timer-bar"); if (bar) bar.hidden = true; if (this.view === "today") this.renderToday(); }, 2000);
    };
  },

  startSession(templateId) {
    const results = {};
    this.guidesOf(templateId).forEach((g) => {
      const ex = this.exercise(g.exerciseId);
      results[g.exerciseId] = this.isCardio(ex, g) ? this.newCardioRes(g) : this.newRes();
    });
    // 템플릿에 유산소 종목이 이미 있으면 세션 유산소(경사 걷기 기본값) 불필요 — 중복 방지
    const hasCardioGuide = this.guidesOf(templateId).some((g) => {
      const ex = this.exercise(g.exerciseId);
      return this.isCardio(ex, g);
    });
    const c = window.FitlogDB.SEED.cardioDefault;
    const sessionCardio = hasCardioGuide ? null : { type: c.type, incline: c.incline, speedKmh: c.speedKmh, durationMinutes: c.durationMinutes, done: false };
    this.session = { templateId, results, extras: [], cardio: sessionCardio };
    this.ended = false;
  },
  newRes() { return { workSets: [], warmupSets: [], skipped: false, showExtra: false, notes: "" }; },
  newCardioRes(g) {
    return { kind: "cardio", done: false, notes: "",
      cardio: { durationMinutes: g.targetDurationMinutes != null ? g.targetDurationMinutes : 30, speedKmh: g.targetSpeedKmh != null ? g.targetSpeedKmh : 4.8, incline: g.targetIncline != null ? g.targetIncline : 12 } };
  },

  async loadLastResults(templateId) {
    this.lastMap = {};
    if (!this.dbReady) return;
    try {
      const sessions = await window.FitlogDB.DB.recentSessions();
      for (const g of this.guidesOf(templateId)) {
        for (const s of sessions) {
          const r = (s.exerciseResults || []).find((x) => x.exerciseId === g.exerciseId);
          if (!r) continue;
          if (r.kind === "cardio") { if (r.cardioActual) { this.lastMap[g.exerciseId] = { cardio: r.cardioActual, date: s.date }; break; } continue; }
          const work = (r.sets || []).filter((x) => x.setType === "work");
          if (work.length) { this.lastMap[g.exerciseId] = { weight: work[0].weight, reps: work.map((w) => w.reps), date: s.date }; break; }
        }
      }
    } catch (e) { console.warn(e); }
  },

  template(id) { return (this.templates || []).find((t) => t.id === id); },
  exercise(id) { return (this.exercises || []).find((e) => e.id === id); },
  guidesOf(templateId) { return (this.guides || []).filter((g) => g.templateId === templateId).sort((a, b) => a.order - b.order); },

  // ───────── 카탈로그 조회·재사용·검색·매핑 (운동 추가 UX 개편) ─────────
  _catExercises() { return (window.FitlogCatalog && window.FitlogCatalog.CATALOG.exercises) || []; },
  catalogById(catId) { return this._catExercises().find((e) => e.id === catId) || null; },
  catalogMappingById(catId) { return ((window.FitlogCatalog && window.FitlogCatalog.MUSCLE_MAP.mappings) || []).find((m) => m.exerciseId === catId) || null; },
  regionLabel(regionId) {
    const r = ((window.FitlogCatalog && window.FitlogCatalog.REGIONS_META.regions) || []).find((x) => x.id === regionId);
    return (r && (r.label_ko || r.label_en)) || regionId;
  },
  categoryLabel(cat) {
    return ({ chest: "가슴", back: "등", shoulders: "어깨", biceps: "이두", triceps: "삼두", legs: "하체", core: "코어", cardio: "유산소" })[cat] || cat || "";
  },
  // 앱 운동 → 카탈로그ID (사용자 매핑 제외한 정적 규칙; heatmap.effectiveCatalogId와 동일 방향)
  appExerciseCatalogId(ex) {
    if (!ex) return null;
    if (ex.catalogId) return ex.catalogId;
    const link = (window.FitlogCatalog && window.FitlogCatalog.EXISTING_LINK) || {};
    return link[ex.id] || null;
  },
  // 카탈로그ID로 이미 존재하는 앱 운동 찾기(재사용/중복 방지). 시드 17종은 EXISTING_LINK 역방향으로 인식.
  findAppExerciseByCatalogId(catId) {
    let found = (this.exercises || []).find((e) => e.catalogId === catId);
    if (found) return found;
    const link = (window.FitlogCatalog && window.FitlogCatalog.EXISTING_LINK) || {};
    const appId = Object.keys(link).find((k) => link[k] === catId);
    if (appId) { found = (this.exercises || []).find((e) => e.id === appId); if (found) return found; }
    return null;
  },
  guideHasExercise(tid, exId) { return this.guidesOf(tid).some((g) => g.exerciseId === exId); },
  // 카탈로그 운동이 현재 템플릿 가이드에 이미 있는지
  catalogInGuide(tid, catId) { const ex = this.findAppExerciseByCatalogId(catId); return ex ? this.guideHasExercise(tid, ex.id) : false; },
  _sideModeFromCatalog(c) {
    if (!c) return "total";
    if (c.weightMode === "assist") return "assist";
    if (c.weightMode === "per_hand") return "per_hand";
    return "total";
  },
  // 카탈로그 운동을 앱 운동으로 확보(없으면 생성, 있으면 재사용). 반환: 앱 운동 객체
  async ensureAppExerciseForCatalog(catId) {
    const existing = this.findAppExerciseByCatalogId(catId);
    if (existing) return existing;
    const c = this.catalogById(catId); if (!c) return null;
    const isCardio = c.exerciseType === "cardio";
    const ex = isCardio
      ? { id: catId, name: c.label_ko || catId, category: "cardio", unit: "", sideMode: "none", kind: "cardio",
          warmupEnabled: false, active: true, catalogId: catId, supportsSpeed: !!c.supportsSpeed, supportsIncline: !!c.supportsIncline, cardioCatalogId: catId }
      : { id: catId, name: c.label_ko || catId, category: c.category || "custom", unit: "kg",
          sideMode: this._sideModeFromCatalog(c), warmupEnabled: false, active: true, catalogId: catId };
    await window.FitlogDB.DB.put("exercises", ex);
    return ex;
  },
  // 카탈로그 운동을 현재 편집 템플릿 가이드에 추가. 반환 {ok, dup, ex}
  async addCatalogExerciseToGuide(tid, catId) {
    const ex = await this.ensureAppExerciseForCatalog(catId);
    if (!ex) return { ok: false };
    if (this.guideHasExercise(tid, ex.id)) { await this.reloadDefs(); return { ok: false, dup: true, ex }; }
    const c = this.catalogById(catId);
    const isCardio = c && c.exerciseType === "cardio";
    const order = Math.max(0, ...this.guidesOf(tid).map((g) => g.order)) + 1;
    const cd = window.FitlogDB.SEED.cardioDefault;
    const g = isCardio
      ? { id: "g-" + ex.id + "-" + Date.now(), templateId: tid, exerciseId: ex.id, order, kind: "cardio",
          targetDurationMinutes: cd.durationMinutes, targetSpeedKmh: c.supportsSpeed ? cd.speedKmh : null, targetIncline: c.supportsIncline ? cd.incline : null, optional: false, notes: "" }
      : { id: "g-" + ex.id + "-" + Date.now(), templateId: tid, exerciseId: ex.id, order,
          targetWeight: null, targetSets: 3, minReps: 8, maxReps: 12, optional: false, warmupSuggestions: [], notes: "" };
    await window.FitlogDB.DB.put("routineGuides", g);
    await this.reloadDefs();
    return { ok: true, ex, g };
  },
  // 로컬 검색: 이름/영문/별칭/부위/기구 + SEARCH_KEYWORDS. 점수순 정렬(모호하면 후보 다수).
  catalogSearch(query, typeFilter, regionFilter) {
    const KW = (window.FitlogCatalog && window.FitlogCatalog.SEARCH_KEYWORDS) || {};
    const q = (query || "").trim().toLowerCase();
    const stop = new Set(["운동", "동작", "하는", "하기", "그리고"]);
    const tokens = q.split(/\s+/)
      .map((t) => t.replace(/(을|를|이|가|은|는|의|로|으로|에서|에|와|과|도|들)$/g, ""))
      .filter((t) => t && t.length >= 1 && !stop.has(t));
    let list = this._catExercises().filter((e) => {
      if (typeFilter && typeFilter !== "all" && e.exerciseType !== typeFilter) return false;
      if (regionFilter && regionFilter !== "all" && e.category !== regionFilter) return false;
      return true;
    });
    if (!tokens.length) return list;
    const scored = list.map((e) => {
      const name = (e.label_ko || "").toLowerCase();
      const hay = [e.label_ko, e.label_en, ...(e.aliases || []), this.categoryLabel(e.category), e.equipment, KW[e.id] || ""].join(" ").toLowerCase();
      let score = 0;
      tokens.forEach((t) => { if (name.includes(t)) score += 3; else if (hay.includes(t)) score += 1; });
      if (q.length >= 2 && (name.includes(q) || (e.aliases || []).some((a) => a.toLowerCase().includes(q)))) score += 5;
      return { e, score };
    }).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.e);
  },
  // 운동의 해석된 근육 매핑(사용자매핑 > 카탈로그). 없으면 null.
  resolvedMapping(ex) {
    const um = (this.userMap || {})[ex && ex.id];
    if (um && um.mapping && um.mapping.primary) return um.mapping;
    const cid = this.appExerciseCatalogId(ex);
    if (!cid) return null;
    const m = this.catalogMappingById(cid);
    return m ? { primary: m.primary, secondary: m.secondary, minor: m.minor } : null;
  },
  // 주요 운동 부위 표시용 텍스트(읽기 전용). 없으면 null.
  primaryPartsText(ex) {
    const c = this.catalogById(this.appExerciseCatalogId(ex));
    if (c && c.exerciseType === "cardio") {
      const m = this.catalogMappingById(c.id);
      const dm = m && m.descriptiveMuscles;
      return dm && dm.length ? dm.map((id) => this.regionLabel(id)).join(" · ") + " (유산소)" : null;
    }
    const m = this.resolvedMapping(ex);
    if (!m || !m.primary) return null;
    const ids = Object.keys(m.primary);
    if (!ids.length) return null;
    const sec = Object.keys(m.secondary || {});
    let t = ids.map((id) => this.regionLabel(id)).join(" · ");
    if (sec.length) t += "  (보조: " + sec.map((id) => this.regionLabel(id)).join(" · ") + ")";
    return t;
  },
  // 자주 하는 운동 → 카탈로그ID 목록(최근 세션 빈도순, 현재 템플릿 미포함 우선)
  async frequentCatalogIds(tid, limit) {
    const out = [];
    try {
      const sessions = await window.FitlogDB.DB.recentSessions(40);
      const freq = new Map();
      sessions.forEach((s) => (s.exerciseResults || []).forEach((r) => {
        const ex = this.exercise(r.exerciseId);
        const cid = ex ? this.appExerciseCatalogId(ex) : ((window.FitlogCatalog.EXISTING_LINK || {})[r.exerciseId] || null);
        if (cid) freq.set(cid, (freq.get(cid) || 0) + 1);
      }));
      [...freq.entries()].sort((a, b) => b[1] - a[1]).forEach(([cid]) => out.push(cid));
    } catch (_) {}
    // 최근 기록이 적으면 대표 운동으로 보강
    ["barbell_bench_press", "barbell_squat", "lat_pulldown", "dumbbell_shoulder_press", "dumbbell_curl", "seated_cable_row"].forEach((c) => { if (!out.includes(c)) out.push(c); });
    return out.slice(0, limit || 6);
  },
  items() {
    const seeded = this.guidesOf(this.session.templateId).map((g) => ({ guide: g, exercise: this.exercise(g.exerciseId), res: this.session.results[g.exerciseId], isExtra: false }));
    return seeded.concat(this.session.extras.map((x) => ({ ...x, isExtra: true })));
  },

  show(view) {
    this.view = view;
    this._destroyHeatmaps();   // 탭 전환 시 활성 3D 뷰어 정리(기록 탭 재진입 시 새로 생성)
    document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== `view-${view}`));
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.view === view ? "true" : "false"));
    if (view === "today") this.renderToday();
    else if (view === "settings") this.renderSettings();
    else if (view === "history") this.renderHistory();
    else if (view === "guide") this.renderGuide();
    else if (view === "ai") this.renderAI();
    else this.renderPlaceholder(view);
  },

  // ---------------- 오늘 ----------------
  renderToday() {
    const root = document.getElementById("view-today"); root.textContent = "";
    const tpl = this.template(this.session.templateId);
    const d = this.sessionDate;
    const dateStr = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_KO[WD_KEYS[d.getDay()]]})`;

    const isToday = isoDate(d) === isoDate(new Date());
    const dateBadge = isToday ? null : el("div", { class: "past-date-badge", text: `📅 ${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")} 과거 기록 중` });
    const dateBtn = el("button", { class: "today-date-btn", "aria-label": "날짜 변경", onclick: () => this.openDateModal() },
      [document.createTextNode(dateStr), el("span", { class: "edit-hint", text: " ✎" })]);

    const select = el("select", { onchange: async (e) => { this.startSession(e.target.value); await this.loadLastResults(e.target.value); this.renderToday(); } },
      this.templates.map((t) => el("option", { value: t.id, ...(t.id === tpl.id ? { selected: "selected" } : {}) }, t.name)));

    root.appendChild(el("div", { class: "today-head" }, [
      dateBadge,
      el("div", { class: "head-row" }, [dateBtn, el("button", { class: "btn btn-sm add-ex", onclick: () => this.addExtra() }, "＋ 운동 추가")]),
      el("div", { class: "today-title", text: tpl.name }),
      el("div", { class: "today-actions" }, [el("div", { class: "select-wrap" }, [select]), el("button", { class: "btn btn-sm btn-ghost", onclick: () => window.FitlogTimer.testSound() }, "🎧 알림 테스트")]),
    ]));

    if (this.ended) { this.renderSummary(root); return; }
    this.items().forEach((it) => root.appendChild(this.renderCard(it)));
    if (this.session.cardio) root.appendChild(this.renderCardio());
    root.appendChild(el("button", { class: "btn btn-block btn-ghost", style: "margin-top:4px", onclick: () => { this.ended = true; window.FitlogTimer.cancel(); this.renderToday(); window.scrollTo(0, 0); } }, "오늘 운동 종료"));
  },

  renderCard(it) {
    const { guide, exercise: ex, res, isExtra } = it;
    if (this.isCardio(ex, guide, res)) return this.renderCardioExerciseCard(it);
    const targetMet = res.workSets.length >= guide.targetSets;
    const card = el("div", { class: "card" + (res.skipped ? " skipped" : targetMet ? " done" : "") });

    let nameNode;
    if (isExtra) nameNode = el("input", { class: "ex-name-input", type: "text", value: ex.name || "", placeholder: "운동 이름 (예: 무릎모아 앉았다 일어나기)", oninput: (e) => { ex.name = e.target.value; } });
    else nameNode = el("div", { class: "ex-name" }, [document.createTextNode(ex.name), guide.optional ? el("span", { class: "opt", text: "선택" }) : null]);
    card.appendChild(el("div", { class: "card-top" }, [nameNode, this.badgeFor(guide, ex, res)]));

    card.appendChild(el("div", { class: "guide-line", text: this.guideLine(ex, guide, isExtra) }));
    if (!isExtra) { const lm = this.lastMap[ex.id]; card.appendChild(el("div", { class: "last-line", text: lm ? `지난번  ${this.weightText(ex, lm.weight)} · ${lm.reps.join(" / ")}` : "지난번  기록 없음" })); }

    if (res.skipped) {
      card.appendChild(el("div", { class: "card-foot" }, [el("span", { class: "muted", text: "이번 운동 생략됨" }), el("button", { class: "link", onclick: () => { res.skipped = false; this.renderToday(); } }, "되돌리기")]));
      return card;
    }
    if (ex.warmupEnabled) card.appendChild(this.renderWarmup(guide, ex, res));

    const sets = el("div", { class: "sets" });
    res.workSets.forEach((s, i) => sets.appendChild(res.editingSet === i ? this.renderEditRow(res, i, ex) : this.renderRecordedRow(i, s, ex, i >= guide.targetSets, res)));
    const activeIdx = res.workSets.length;
    if (activeIdx < guide.targetSets) {
      sets.appendChild(this.renderActiveRow(guide, ex, res, activeIdx, false));
      for (let i = activeIdx + 1; i < guide.targetSets; i++) sets.appendChild(el("div", { class: "set-row" }, [el("span", { class: "set-no", text: `${i + 1}` }), el("span", { class: "wait", text: "대기" })]));
    } else {
      if (res.showExtra) sets.appendChild(this.renderActiveRow(guide, ex, res, activeIdx, true));
      else sets.appendChild(el("button", { class: "btn btn-sm btn-ghost add-set", onclick: () => { res.showExtra = true; this.renderToday(); } }, "＋ 세트 추가"));
    }
    card.appendChild(sets);

    if (this.activeTimerExerciseId === (isExtra ? ex.id : guide.exerciseId) && window.FitlogTimer.state) {
      const st = window.FitlogTimer.state;
      card.appendChild(el("div", { class: "countdown", id: "inline-cd" }, [
        el("div", { class: "cd-num", id: "inline-cd-num", text: window.FitlogTimer._mmss(window.FitlogTimer.remaining()) }),
        el("div", { class: "cd-label", id: "inline-cd-label", text: st.type === "exercise_rest" ? "다음 운동까지" : "다음 세트까지" }),
      ]));
    }

    card.appendChild(this.memoField(res));

    card.appendChild(el("div", { class: "card-foot" }, [
      (res.workSets.length > 0 && !isExtra)
        ? el("button", { class: "link", onclick: () => { if (window.confirm("이 운동의 본세트 기록을 초기화할까요? (워밍업·메모는 유지)")) { res.workSets = []; res.showExtra = false; res.editingSet = null; this.renderToday(); } } }, "본세트 초기화")
        : el("span", {}, ""),
      isExtra ? el("button", { class: "link danger", onclick: () => { this.session.extras = this.session.extras.filter((e2) => e2.exercise.id !== ex.id); this.renderToday(); } }, "삭제")
              : (!targetMet ? el("button", { class: "link danger", onclick: () => this.skipExercise(guide) }, "이번 운동 생략") : el("span", {}, "")),
    ]));
    return card;
  },

  memoField(res) {
    const input = el("input", { class: "memo-input", type: "text", value: res.notes || "", placeholder: "＋ 메모 (예: 우측 허리 통증)", oninput: (e) => { res.notes = e.target.value; } });
    return el("div", { class: "memo-row" }, [input]);
  },

  // 유산소 종목 카드 (오늘 화면) — 시간·속도·경사 입력 + 완료
  renderCardioExerciseCard(it) {
    const { guide: g, exercise: ex, res, isExtra } = it;
    const card = el("div", { class: "card cardio" + (res.done ? " done" : "") });
    card.appendChild(el("div", { class: "card-top" }, [
      el("div", { class: "ex-name" }, [document.createTextNode(ex.name || "유산소"), el("span", { class: "opt", text: "유산소" })]),
      res.done ? el("span", { class: "badge completed", text: "완료" }) : el("span", {}),
    ]));
    card.appendChild(el("div", { class: "guide-line", text: this.cardioGuideLine(g) }));
    const lm = this.lastMap[ex.id];
    if (lm && lm.cardio) card.appendChild(el("div", { class: "last-line", text: this.cardioActualLine(ex, lm.cardio, "지난번  ") }));
    const spec = this.cardioFieldSpec(ex);
    const mk = (key, label, step) => el("div", { class: "cardio-field" }, [el("label", { text: label }), this.dial(res.cardio, key, { step, min: 0, unit: "" })]);
    const fields = [mk("durationMinutes", "시간 (분)", 1)];
    if (spec.speed) fields.push(mk("speedKmh", "속도 (km/h)", 0.1));
    if (spec.incline) fields.push(mk("incline", "경사", 1));
    card.appendChild(el("div", { class: "cardio-grid", style: `grid-template-columns:repeat(${fields.length},1fr)` }, fields));
    card.appendChild(this.memoField(res));
    card.appendChild(el("div", { class: "card-foot" }, [
      el("button", { class: "btn btn-block " + (res.done ? "btn-ghost" : "btn-primary"), onclick: () => { res.done = !res.done; this.renderToday(); } }, res.done ? "유산소 완료 취소" : "✓ 유산소 완료"),
      isExtra ? el("button", { class: "link danger", onclick: () => { this.session.extras = this.session.extras.filter((e2) => e2.exercise.id !== ex.id); this.renderToday(); } }, "삭제") : null,
    ].filter(Boolean)));
    return card;
  },
  // 유산소 종목의 입력 필드 구성. 기존 유산소(플래그 없음)는 시간·속도·경사 모두(호환 유지).
  // 카탈로그 연결 종목은 supportsSpeed/supportsIncline 플래그에 따라 관련 필드만 표시. (섹션 4)
  cardioFieldSpec(ex) {
    const has = (k, def) => (ex && ex[k] !== undefined) ? !!ex[k] : def;
    return { duration: true, speed: has("supportsSpeed", true), incline: has("supportsIncline", true) };
  },
  cardioGuideLine(g, ex) {
    const spec = this.cardioFieldSpec(ex || this.exercise(g.exerciseId));
    const parts = [`${g.targetDurationMinutes != null ? g.targetDurationMinutes : "-"}분`];
    if (spec.speed) parts.push(`${g.targetSpeedKmh != null ? g.targetSpeedKmh : "-"}km/h`);
    if (spec.incline) parts.push(`경사 ${g.targetIncline != null ? g.targetIncline : "-"}`);
    return `목표  ${parts.join(" · ")}`;
  },
  cardioActualLine(ex, c, prefix) {
    const spec = this.cardioFieldSpec(ex);
    const parts = [`${c.durationMinutes}분`];
    if (spec.speed) parts.push(`${c.speedKmh}km/h`);
    if (spec.incline) parts.push(`경사 ${c.incline}`);
    return (prefix || "") + parts.join(" · ");
  },

  renderWarmup(guide, ex, res) {
    const box = el("div", { class: "warmup-box" });
    box.appendChild(el("div", { class: "warmup-head" }, [el("span", { class: "w-tag", text: "W" }), el("span", { text: "워밍업 · 판정 제외 · 입력 시 자동 기록" })]));
    if (guide.warmupSuggestions && guide.warmupSuggestions.length)
      box.appendChild(el("div", { class: "w-sug", text: "추천: " + guide.warmupSuggestions.map((w) => `${w.note ? w.note + " " : ""}${w.weight}kg×${w.reps}`).join(" · ") }));
    const rows = el("div", { class: "sets" });
    res.warmupSets.forEach((s, i) => {
      rows.appendChild(el("div", { class: "set-row warmup" }, [
        el("span", { class: "set-no", text: "W" }),
        this.dial(s, "weight", { step: 0.5, min: 0, unit: this.unitLabel(ex), allowNull: true }),
        this.dial(s, "reps", { step: 1, min: 0, unit: "회" }),
        el("div", { class: "w-actions" }, [el("span", { class: "w-saved", text: "✓ 기록됨" }), el("button", { class: "row-x", "aria-label": "삭제", onclick: () => { res.warmupSets.splice(i, 1); this.renderToday(); } }, "✕")]),
      ]));
    });
    box.appendChild(rows);
    box.appendChild(el("div", { class: "w-foot" }, [
      el("button", { class: "btn btn-sm btn-ghost", onclick: () => { const sug = guide.warmupSuggestions && guide.warmupSuggestions[0]; res.warmupSets.push({ weight: sug ? sug.weight : 0, reps: 10 }); this.renderToday(); } }, "＋ 워밍업 세트"),
      res.warmupSets.length > 0 ? el("button", { class: "link", onclick: () => { if (window.confirm("워밍업 세트만 초기화할까요? (본세트·메모는 유지)")) { res.warmupSets = []; this.renderToday(); } } }, "워밍업 초기화") : null,
    ].filter(Boolean)));
    return box;
  },

  renderRecordedRow(i, set, ex, isExtra, res) {
    return el("div", { class: "set-row done" + (isExtra ? " extra" : "") }, [
      el("span", { class: "set-no", text: isExtra ? `+${i + 1}` : `${i + 1}` }),
      el("div", { class: "set-recorded" }, [el("span", { class: "chk", text: "✓" }), el("span", { text: `${this.weightText(ex, set.weight)} · ${set.reps}회${isExtra ? "  (추가)" : ""}` })]),
      el("button", { class: "set-edit", "aria-label": "수정", onclick: () => { res.editingSet = i; this.renderToday(); } }, "수정"),
    ]);
  },

  renderActiveRow(guide, ex, res, i, isExtra) {
    const prev = res.workSets[res.workSets.length - 1];
    const lm = this.lastMap[ex.id];
    const defWeight = prev ? prev.weight : (lm && lm.weight != null ? lm.weight : (guide.targetWeight != null ? guide.targetWeight : null));
    const defReps = prev ? prev.reps : guide.minReps;
    const isLastTarget = !isExtra && i === guide.targetSets - 1;
    // 진행 중 입력값 보존: 타이머 종료 등으로 재렌더링돼도 사용자가 조정해둔 값이 날아가지 않게
    // (res.draftAt이 현재 세트 인덱스와 일치할 때만 재사용 — 세트가 넘어가면 자연히 새 기본값으로)
    const draft = (res.draftAt === i && res.draft) ? res.draft : { weight: defWeight, reps: defReps };
    res.draftAt = i; res.draft = draft;
    const btn = el("button", { class: "btn btn-block btn-primary", style: "margin-top:4px", onclick: () => this.completeSet(guide, ex, res, draft, isLastTarget, isExtra) },
      isExtra ? "✓ 추가 세트 기록" : (isLastTarget ? "✓ 운동 완료 · 다음 운동 준비" : "✓ 세트 완료"));
    const row = el("div", { class: "set-row" + (isExtra ? " extra-active" : "") }, [
      el("span", { class: "set-no", text: isExtra ? "＋" : `${i + 1}` }),
      this.dial(draft, "weight", { step: 0.5, min: 0, unit: this.unitLabel(ex), allowNull: true }),
      this.dial(draft, "reps", { step: 1, min: 0, unit: "회" }),
      el("div", { class: "set-complete" }, [btn]),
    ]);
    if (isExtra) row.appendChild(el("button", { class: "link", style: "grid-column:1/-1", onclick: () => { res.showExtra = false; res.draft = null; this.renderToday(); } }, "취소"));
    return row;
  },

  // 완료된 세트 수정 행 (수정 버튼 → 이 편집 행)
  renderEditRow(res, i, ex) {
    const set = res.workSets[i];
    const draft = { weight: set.weight, reps: set.reps };
    const save = () => { res.workSets[i] = { weight: draft.weight, reps: draft.reps }; res.editingSet = null; this.renderToday(); };
    const row = el("div", { class: "set-row extra-active" }, [
      el("span", { class: "set-no", text: `${i + 1}` }),
      this.dial(draft, "weight", { step: 0.5, min: 0, unit: this.unitLabel(ex), allowNull: true }),
      this.dial(draft, "reps", { step: 1, min: 0, unit: "회" }),
      el("div", { class: "set-complete" }, [el("button", { class: "btn btn-block btn-primary", style: "margin-top:4px", onclick: save }, "✓ 수정 저장")]),
    ]);
    row.appendChild(el("button", { class: "link", style: "grid-column:1/-1", onclick: () => { res.editingSet = null; this.renderToday(); } }, "취소"));
    return row;
  },

  // 드래그 다이얼: 세로로 밀어 값 조절(절충 가속), 짧게 탭하면 직접 입력.
  // obj[key]를 직접 변경. opts: { step, min, unit, decimals, allowNull, onChange }
  dial(obj, key, opts) {
    const step = opts.step, min = opts.min == null ? 0 : opts.min;
    const dec = opts.decimals == null ? (step < 1 ? 1 : 0) : opts.decimals;
    const unit = opts.unit || "";
    const fmt = (v) => (v == null || v === "") ? "–" : (dec ? Number(v).toFixed(dec) : String(Math.round(Number(v))));

    const wrap = el("div", { class: "dial" });
    const face = el("div", { class: "dial-face" });          // 왼쪽: 숫자 (탭 → 직접 입력)
    const grip = el("div", { class: "dial-grip", "aria-hidden": "true" }, [el("span", { class: "g-up", text: "▲" }), el("span", { class: "g-dn", text: "▼" })]); // 오른쪽: 드래그 핸들

    const paintFace = () => {
      face.textContent = "";
      face.appendChild(el("div", { class: "dial-mid" }, [el("div", { class: "dial-num", text: fmt(obj[key]) }), unit ? el("span", { class: "dial-unit", text: unit }) : null].filter(Boolean)));
    };

    // 탭 → 직접 입력 (click 핸들러 안에서 즉시 focus → iOS 키보드 확실히 뜸)
    let editing = false;
    face.addEventListener("click", () => {
      if (editing) return; editing = true;
      face.textContent = "";
      const input = el("input", { type: "text", inputmode: "decimal", class: "dial-input", value: obj[key] == null ? "" : String(obj[key]) });
      const mid = el("div", { class: "dial-mid" }, [input, unit ? el("span", { class: "dial-unit", text: unit }) : null].filter(Boolean));
      face.appendChild(mid);
      input.focus(); try { input.select(); } catch (_) {}
      const commit = () => {
        const raw = (input.value || "").trim().replace(/,/g, ".");
        if (raw === "") obj[key] = opts.allowNull ? null : min;
        else { let n = Number(raw); if (isNaN(n)) n = Number(obj[key]) || 0; obj[key] = Math.max(min, Number(n.toFixed(4))); }
        editing = false; paintFace(); opts.onChange && opts.onChange(obj[key]);
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    });

    // 오른쪽 그립 드래그 → 값 조절 (절충 가속). 숫자를 손가락이 가리지 않음.
    let dragging = false, lastY = 0, acc = 0;
    grip.addEventListener("pointerdown", (e) => {
      dragging = true; lastY = e.clientY; acc = 0;
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      wrap.classList.add("active"); e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return; e.preventDefault();
      const d = lastY - e.clientY; lastY = e.clientY;
      const factor = 1 + Math.min(Math.abs(d) / 6, 6);
      acc += (d / 8) * factor;
      const whole = Math.trunc(acc);
      if (whole !== 0) {
        acc -= whole;
        let v = (Number(obj[key]) || 0) + whole * step;
        v = Math.max(min, Math.round(v / step) * step);
        obj[key] = Number(v.toFixed(4));
        if (!editing) { const n = face.querySelector(".dial-num"); if (n) n.textContent = fmt(obj[key]); }
        opts.onChange && opts.onChange(obj[key]);
      }
    });
    const end = () => { if (!dragging) return; dragging = false; wrap.classList.remove("active"); };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);

    paintFace();
    wrap.appendChild(face);
    wrap.appendChild(grip);
    return wrap;
  },

  stepper(input, step, unit) {
    return el("div", { class: "stepper" }, [
      el("button", { type: "button", onclick: () => this.bump(input, -step, 0) }, "−"),
      el("div", { class: "stepper-mid" }, [input, el("span", { class: "unit", text: unit })]),
      el("button", { type: "button", onclick: () => this.bump(input, step, 0) }, "+"),
    ]);
  },

  completeSet(guide, ex, res, draft, isLastTarget, isExtra) {
    const weight = draft.weight == null || draft.weight === "" ? null : Number(draft.weight);
    const reps = Number(draft.reps) || 0;
    res.workSets.push({ weight, reps });
    res.draft = null; res.draftAt = null; // 완료된 세트의 임시값 정리 → 다음 세트는 새 기본값으로 시작
    if (isExtra) res.showExtra = false;
    this.activeTimerExerciseId = isExtra ? ex.id : guide.exerciseId;
    const useExercise = isLastTarget && !isExtra;
    window.FitlogTimer.start(useExercise ? "exercise_rest" : "set_rest", useExercise ? this.settings.exerciseRestSeconds : this.settings.setRestSeconds);
    this.renderToday();
  },
  skipExercise(guide) { this.session.results[guide.exerciseId].skipped = true; this.renderToday(); },
  addExtra() {
    const id = `extra-${++this._extraSeq}`;
    this.session.extras.push({ guide: { exerciseId: id, targetWeight: null, targetSets: 3, minReps: 1, maxReps: 999, optional: true, warmupSuggestions: [], notes: "" }, exercise: { id, name: "", sideMode: "total", warmupEnabled: false }, res: this.newRes() });
    this.renderToday();
    const inputs = document.querySelectorAll(".ex-name-input"); if (inputs.length) inputs[inputs.length - 1].focus();
  },
  bump(input, delta, min) {
    const cur = input.value === "" ? 0 : Number(input.value);
    let next = Math.round((cur + delta) * 100) / 100; if (min != null && next < min) next = min;
    input.value = next; input.dispatchEvent(new Event("input"));
  },

  // ---------------- 판정 ----------------
  evalExercise(guide, ex, res) {
    if (this.isCardio(ex, guide, res)) return { status: res.done ? "completed" : "not_started", direction: null };
    const judge = res.workSets.slice(0, guide.targetSets).map((s) => ({ setType: "work", reps: s.reps, completed: true }));
    return window.FitlogEval.evaluateExercise({ targetSets: guide.targetSets, minReps: guide.minReps, maxReps: guide.maxReps, sideMode: ex.sideMode, targetWeight: guide.targetWeight }, judge, { skipped: res.skipped });
  },
  badgeFor(guide, ex, res) {
    const { status, direction } = this.evalExercise(guide, ex, res);
    if (status === "not_started") return el("span", {});
    const map = { completed: "완료", volume_under: "볼륨 부족", skipped: "미실시", progression_candidate: direction === "decrease_assist" ? "보조↓ 후보" : "증량 후보" };
    return el("span", { class: `badge ${status}`, text: map[status] || "" });
  },
  statusLabel(st) { return { completed: "완료", progression_candidate: "증량 후보", volume_under: "볼륨 부족", skipped: "미실시", not_started: "미시작" }[st] || st; },
  guideLine(ex, g, isExtra) {
    if (this.isCardio(ex, g)) return this.cardioGuideLine(g);
    if (isExtra) return `직접 추가 · kg · ${g.targetSets}세트 (목표 자유)`;
    const w = g.targetWeight == null ? "중량 미정" : this.weightText(ex, g.targetWeight);
    return `가이드  ${w} · ${g.minReps}~${g.maxReps}회 · ${g.targetSets}세트`;
  },
  weightText(ex, w) { if (w == null) return "미정"; if (ex.sideMode === "per_hand") return `한 손 ${w}kg`; if (ex.sideMode === "assist") return `보조 ${w}kg`; return `${w}kg`; },
  unitLabel(ex) { return ex.sideMode === "per_hand" ? "kg/손" : ex.sideMode === "assist" ? "kg보조" : "kg"; },
  weightStep(ex, w) { if (ex.sideMode === "per_hand") return 1; const n = Number(w); return (!isNaN(n) && n > 0 && n < 10) ? 1 : 2.5; },

  // ---------------- 유산소 ----------------
  renderCardio() {
    const c = this.session.cardio;
    const card = el("div", { class: "card cardio" + (c.done ? " done" : "") });
    card.appendChild(el("div", { class: "card-top" }, [el("div", { class: "ex-name" }, "유산소 · 경사 걷기"), c.done ? el("span", { class: "badge completed", text: "완료" }) : el("span", {})]));
    const mk = (key, label, step) => el("div", { class: "cardio-field" }, [el("label", { text: label }), this.dial(c, key, { step, min: 0, unit: "" })]);
    card.appendChild(el("div", { class: "cardio-grid" }, [mk("incline", "경사", 1), mk("speedKmh", "속도 (km/h)", 0.1), mk("durationMinutes", "시간 (분)", 1)]));
    card.appendChild(el("button", { class: "btn btn-block " + (c.done ? "btn-ghost" : "btn-primary"), onclick: () => { c.done = !c.done; this.renderToday(); } }, c.done ? "유산소 완료 취소" : "✓ 유산소 완료"));
    return card;
  },

  // ---------------- 날짜 선택 모달 ----------------
  // 현재 세션에 입력된 내용이 있는지 확인 (세트·유산소 모두 체크)
  hasSessionInput() {
    const items = this.items();
    for (const it of items) {
      const res = it.res;
      if (!res) continue;
      if (res.kind === "cardio" && res.done) return true;
      if ((res.workSets && res.workSets.length > 0) || (res.warmupSets && res.warmupSets.length > 0)) return true;
    }
    const c = this.session && this.session.cardio;
    if (c && c.done) return true;
    return false;
  },

  openDateModal() {
    const overlay = el("div", { class: "modal-overlay" });
    const sheet = el("div", { class: "modal-sheet" });

    const title = el("div", { class: "modal-title", text: "날짜 선택" });
    const dateIn = el("input", { type: "date", class: "range-date", value: isoDate(this.sessionDate), max: isoDate(new Date()) });
    const err = el("div", { class: "range-err", hidden: true });

    const close = () => document.body.removeChild(overlay);

    const apply = () => {
      const val = dateIn.value;
      if (!val) { err.textContent = "날짜를 선택하세요."; err.hidden = false; return; }
      const [y, m, day] = val.split("-").map(Number);
      const newDate = new Date(y, m - 1, day);
      const newIso = isoDate(newDate);
      if (newIso === isoDate(this.sessionDate)) { close(); return; } // 같은 날짜면 그냥 닫기

      if (this.hasSessionInput()) {
        if (!window.confirm("날짜를 바꾸면 현재 기록 중인 운동 입력이 사라집니다.\n계속할까요?")) return;
      }
      close();
      this.sessionDate = newDate;
      this.startSession(this.session.templateId);
      this.loadLastResults(this.session.templateId).then(() => this.renderToday());
    };

    const todayBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => { dateIn.value = isoDate(new Date()); } }, "오늘로");
    const cancelBtn = el("button", { class: "btn btn-ghost", type: "button", onclick: close }, "취소");
    const applyBtn = el("button", { class: "btn btn-primary", type: "button", onclick: apply }, "적용");

    sheet.appendChild(title);
    sheet.appendChild(el("div", { class: "date-modal-field" }, [
      dateIn,
      todayBtn,
    ]));
    sheet.appendChild(err);
    sheet.appendChild(el("div", { class: "modal-actions" }, [cancelBtn, applyBtn]));
    overlay.appendChild(sheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    // iOS에서 input[type=date]는 탭하면 네이티브 date picker가 열림 — 자동으로 포커스
    setTimeout(() => dateIn.focus(), 50);
  },

  // ---------------- 종료 요약 + 저장 ----------------
  renderSummary(root) {
    const items = this.items();
    const results = items.map((it) => ({ optional: it.guide.optional, ...this.evalExercise(it.guide, it.exercise, it.res) }));
    const done = results.filter((r) => r.status === "completed" || r.status === "progression_candidate").length;
    const partial = results.filter((r) => r.status === "volume_under").length;
    const missed = results.filter((r) => r.status === "skipped" || r.status === "not_started").length;
    const rate = window.FitlogEval.completionRate(results);
    const c = this.session.cardio;
    const cardioRow = c ? el("div", { class: "row" }, [el("span", { text: "유산소" }), el("span", { text: c.done ? `${c.durationMinutes}분 완료` : "미완료" })]) : null;
    root.appendChild(el("div", { class: "summary" }, [
      el("h3", { text: "오늘 운동 종료" }),
      el("div", { class: "row" }, [el("span", { text: "완료" }), el("span", { text: `${done}` })]),
      el("div", { class: "row" }, [el("span", { text: "부분 완료" }), el("span", { text: `${partial}` })]),
      el("div", { class: "row" }, [el("span", { text: "미실시" }), el("span", { text: `${missed}` })]),
      el("div", { class: "row" }, [el("span", { text: "필수 완료율" }), el("span", { text: `${rate.done}/${rate.total}` })]),
      cardioRow,
      el("button", { class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: () => this.saveSession() }, "오늘 운동 저장"),
      el("button", { class: "btn btn-ghost btn-block", style: "margin-top:8px", onclick: () => { this.ended = false; this.renderToday(); } }, "계속 운동하기"),
    ]));
  },

  buildSession() {
    const d = this.sessionDate;
    const exerciseResults = this.items().map((it) => {
      const { guide: g, exercise: ex, res } = it;
      if (this.isCardio(ex, g, res)) {
        return {
          exerciseId: ex.id, exerciseName: ex.name || null, kind: "cardio", adhoc: !!it.isExtra,
          guideSnapshot: { targetDurationMinutes: g.targetDurationMinutes != null ? g.targetDurationMinutes : null, targetSpeedKmh: g.targetSpeedKmh != null ? g.targetSpeedKmh : null, targetIncline: g.targetIncline != null ? g.targetIncline : null },
          cardioActual: res.done ? { durationMinutes: res.cardio.durationMinutes, speedKmh: res.cardio.speedKmh, incline: res.cardio.incline } : null,
          sets: [],
          status: res.done ? "completed" : "not_started", skipReason: null, notes: res.notes || "",
        };
      }
      return {
        exerciseId: ex.id, exerciseName: ex.name || null, sideMode: ex.sideMode, adhoc: !!it.isExtra,
        guideSnapshot: { targetWeight: g.targetWeight, targetSets: g.targetSets, minReps: g.minReps, maxReps: g.maxReps },
        sets: [
          ...res.warmupSets.map((s) => ({ setNumber: 0, setType: "warmup", weight: s.weight, reps: s.reps, completed: true })),
          ...res.workSets.map((s, i) => ({ setNumber: i + 1, setType: "work", weight: s.weight, reps: s.reps, completed: true })),
        ],
        status: this.evalExercise(g, ex, res).status, skipReason: null, notes: res.notes || "",
      };
    });
    const c = this.session.cardio;
    const cardioRecord = c && c.done ? { type: c.type, incline: c.incline, speedKmh: c.speedKmh, durationMinutes: c.durationMinutes } : null;
    return {
      id: new Date().toISOString(), date: isoDate(d), weekday: WD_KEYS[d.getDay()], templateId: this.session.templateId, status: "completed",
      exerciseResults, cardio: cardioRecord,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  },

  async saveSession() {
    const session = this.buildSession();
    let savedOK = false;
    if (this.dbReady) { try { await window.FitlogDB.DB.put("workoutSessions", session); await this.loadLastResults(this.session.templateId); savedOK = true; } catch (e) { console.error("[Fitlog] 저장 실패", e); } }
    else console.log("[Fitlog] (DB 미사용) 세션:", session);

    const root = document.getElementById("view-today"); root.textContent = "";
    root.appendChild(el("div", { class: "summary saved-note" }, [
      el("h3", { text: savedOK ? "저장 완료 ✓" : "요약 생성됨" }),
      el("div", { class: "muted", text: savedOK ? "이 기기에 저장됐어요. 기록 탭에서 확인할 수 있어요." : "이 브라우저에서 저장을 쓸 수 없어 콘솔에만 출력했어요." }),
      el("button", { class: "btn btn-block", style: "margin-top:12px", onclick: () => this.show("history") }, "기록 보기"),
      el("button", { class: "btn btn-ghost btn-block", style: "margin-top:8px", onclick: async () => { this.startSession(this.session.templateId); await this.loadLastResults(this.session.templateId); this.ended = false; this.renderToday(); window.scrollTo(0, 0); } }, "새 운동 시작"),
    ]));
    window.scrollTo(0, 0);
  },

  // 한 줄 컴팩트 기간 선택 바 (기록·AI 공용). opts: { onApply(range), onReset(), extraButtons?[] }
  // 평소엔 한 줄만 차지하고, 터치하면 시작/종료일 설정 모달이 열린다. (섹션 5)
  rangeLabel(range) {
    // 로컬 날짜 기준 표시(UTC 변환 없음). 연도가 다르면 연도도 표시.
    const sY = range.start.slice(0, 4), eY = range.end.slice(0, 4);
    const md = (d) => d.slice(5).replace("-", ".");
    if (sY !== eY) return `${sY}.${md(range.start)} ~ ${eY}.${md(range.end)}`;
    return `${md(range.start)} ~ ${md(range.end)}`;
  },
  rangeControls(range, opts) {
    const bar = el("button", { class: "range-bar", type: "button", "aria-label": "분석 기간 설정",
      onclick: () => this.openRangeModal(range, opts) }, [
      el("span", { class: "range-bar-ico", text: "📅" }),
      el("span", { class: "range-bar-txt", text: this.rangeLabel(range) }),
      el("span", { class: "range-bar-caret", text: "▾" }),
    ]);
    const wrap = el("div", { class: "range-box" }, [bar]);
    if (opts.extraButtons && opts.extraButtons.length) {
      wrap.appendChild(el("div", { class: "range-actions" }, opts.extraButtons));
    }
    return wrap;
  },
  // 기간 선택 모달(바텀시트). draft를 따로 두고 '기간 적용'을 눌러야 반영. 취소/닫기는 기존 기간 유지.
  openRangeModal(range, opts) {
    const draft = { start: range.start, end: range.end };
    const startIn = el("input", { type: "date", class: "range-date", value: draft.start });
    const endIn = el("input", { type: "date", class: "range-date", value: draft.end });
    const err = el("div", { class: "range-err", hidden: true });
    startIn.addEventListener("change", () => { draft.start = startIn.value; err.hidden = true; });
    endIn.addEventListener("change", () => { draft.end = endIn.value; err.hidden = true; });

    const overlay = el("div", { class: "modal-overlay" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });   // 바깥 터치 = 취소(기존 유지)

    const apply = () => {
      const s = startIn.value || draft.start, e = endIn.value || draft.end;
      if (!s || !e) { err.textContent = "날짜를 선택하세요."; err.hidden = false; return; }
      if (s > e) { err.textContent = "시작일이 종료일보다 늦어요. 날짜를 다시 선택하세요."; err.hidden = false; return; }
      close(); opts.onApply({ start: s, end: e });
    };
    const recent7 = () => {
      const r = this.defaultRange();
      draft.start = r.start; draft.end = r.end; startIn.value = r.start; endIn.value = r.end; err.hidden = true;
    };
    const sheet = el("div", { class: "modal-sheet fitlog-anatomy" }, [
      el("div", { class: "modal-title", text: "분석 기간 설정" }),
      el("div", { class: "range-grid" }, [
        el("div", { class: "range-cell" }, [el("label", { text: "시작일" }), startIn]),
        el("div", { class: "range-cell" }, [el("label", { text: "종료일" }), endIn]),
      ]),
      err,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn btn-ghost", type: "button", onclick: recent7 }, "최근 7일"),
        el("button", { class: "btn btn-primary", type: "button", onclick: apply }, "기간 적용"),
      ]),
      el("button", { class: "modal-close", type: "button", onclick: close }, "닫기"),
    ]);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  },

  // ---------------- 근육 히트맵 ----------------
  _heatViewIndex: 0,   // 현재 시점(0~4, SVG 대체 화면용). 재렌더/기간변경에도 시점 유지.
  _heatSeq: 0,         // 비동기 요청 세대: 이전 기간 결과가 최신 화면을 덮지 않도록.
  _heatCtrls: null,    // 활성 3D 뷰어 컨트롤러 집합 (WebGL 컨텍스트 누수 방지용으로 명시적 destroy).

  // 활성 3D 뷰어를 모두 정리한다. 기록/상세 재렌더 및 탭 이탈 시 호출(컨텍스트 해제).
  _destroyHeatmaps() {
    if (!this._heatCtrls) { this._heatCtrls = new Set(); return; }
    for (const ctrl of this._heatCtrls) { try { ctrl.destroy(); } catch (_) {} }
    this._heatCtrls.clear();
  },
  // assets/ 와 data/ 를 포함하는 앱 루트 절대 URL(끝에 '/'). GitHub Pages 서브패스도 보존.
  // 오디오 요소(assets/sounds/rest-end.mp3)의 절대 src에서 역산 — dev(src/)·배포(평면) 모두 정확.
  _appRootURL() {
    try {
      const a = document.getElementById("rest-end-audio");
      const src = (a && a.src) ? a.src : new URL("assets/sounds/rest-end.mp3", document.baseURI).href;
      const root = src.replace(/assets\/sounds\/rest-end\.mp3.*$/, "");
      if (root && root !== src) return root;
    } catch (_) {}
    return new URL("./", document.baseURI).href;
  },
  regionLabelKo(id) {
    if (!this._regionLabels) {
      this._regionLabels = {};
      try { (window.FitlogCatalog.REGIONS_META.regions || []).forEach((r) => { this._regionLabels[r.id] = r.label_ko || r.id; }); } catch (_) {}
    }
    return this._regionLabels[id] || id;
  },
  // 히트맵 카드를 host에 비동기로 채운다. opts.sessionId 주면 그 세션만(날짜별 상세용).
  async mountHeatmap(host, sessions, range, opts) {
    opts = opts || {};
    const seq = ++this._heatSeq;
    if (!window.FitlogHeatmap || !window.FitlogCatalog) return;   // 자산 미로드 시 조용히 생략(기록 탭은 정상)

    // 카드 골격 (계산 전에도 배치가 안정적이도록 먼저 구성)
    const svgHolder = el("div", { class: "anat-svg", "aria-live": "polite" });
    const viewName = el("div", { class: "anat-viewname" });
    const prevBtn = el("button", { class: "anat-nav", type: "button", "aria-label": "이전 시점", text: "‹ 이전" });
    const nextBtn = el("button", { class: "anat-nav", type: "button", "aria-label": "다음 시점", text: "다음 ›" });
    const scoreWrap = el("div", { class: "anat-scores", hidden: true });
    const scoreToggle = el("button", { class: "anat-scores-toggle", type: "button", text: "근육별 상세 보기 ▾" });
    const notice = el("div", { class: "anat-notice", hidden: true });

    const card = el("div", { class: "card anat-card fitlog-anatomy" }, [
      el("div", { class: "anat-head", text: opts.sessionId ? "이 날짜의 근육 운동 부위" : "근육별 운동 현황" }),
      svgHolder,
      viewName,
      el("div", { class: "anat-navrow" }, [prevBtn, nextBtn]),
      el("div", { class: "anat-legend" }, [
        el("span", { class: "lg-swatch", style: "background:#65ba8b" }),
        el("span", { class: "lg-lbl", text: "적음" }),
        el("span", { class: "lg-swatch", style: "background:#dfaa58" }),
        el("span", { class: "lg-lbl", text: "중간" }),
        el("span", { class: "lg-swatch", style: "background:#d96161" }),
        el("span", { class: "lg-lbl", text: "많음" }),
      ]),
      el("div", { class: "anat-caption", text: "선택 기간 내 상대 운동량 · 실제 활성도가 아닌 가중 완료 세트 점수" }),
      notice,
      scoreToggle,
      scoreWrap,
    ]);
    host.textContent = ""; host.appendChild(card);

    // 계산: 데이터 변화 시에만. userMap은 DB에서.
    let userMap = {};
    try { if (window.FitlogDB.DB && window.FitlogDB.DB.userMuscleMapAll) userMap = await window.FitlogDB.DB.userMuscleMapAll(); } catch (_) {}
    if (seq !== this._heatSeq) return;   // 더 최신 요청이 들어옴 → 폐기

    const exById = {}; (this.exercises || []).forEach((e) => { exById[e.id] = e; });
    let result;
    try {
      result = window.FitlogHeatmap.compute(sessions, { start: range.start, end: range.end, sessionId: opts.sessionId || null, exDefsById: exById, userMap });
    } catch (e) { console.warn("[heatmap] 계산 실패", e); notice.hidden = false; notice.textContent = "히트맵 계산을 표시할 수 없어요."; return; }

    const colors = result.colors || {};
    const hasData = result.completedSets > 0 || result.cardioSeconds > 0;

    // 미매핑 안내 (근육 매핑 미설정 종목 / 제외 세트)
    if ((result.unmappedNames && result.unmappedNames.length) || result.unmappedSets > 0) {
      notice.hidden = false;
      const names = result.unmappedNames || [];
      notice.textContent = `근육 매핑 미설정 ${names.length}종${names.length ? " (" + names.join(", ") + ")" : ""} · 제외 ${result.unmappedSets}세트`;
    }

    // 근육별 상세(점수>0, 내림차순)
    const rows = Object.entries(result.scores || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (rows.length) {
      rows.forEach(([id, v]) => scoreWrap.appendChild(el("div", { class: "anat-score-row" }, [
        el("span", { text: this.regionLabelKo(id) }), el("span", { class: "num", text: v.toFixed(1) }),
      ])));
      scoreToggle.addEventListener("click", () => {
        const open = scoreWrap.hidden; scoreWrap.hidden = !open;
        scoreToggle.textContent = open ? "근육별 상세 닫기 ▴" : "근육별 상세 보기 ▾";
      });
    } else {
      scoreToggle.hidden = true;
      if (!hasData) { notice.hidden = false; notice.textContent = opts.sessionId ? "이 날짜에는 근력 운동 기록이 없어요." : "선택 기간에 근력 운동 기록이 없어요."; }
    }

    // ===== 인체 모델: 3D 우선, 실패 시 SVG 대체 =====
    // 뷰어에는 계산된 색상 객체만 전달한다(뷰어는 DB 조회·집계·계산을 하지 않음).
    svgHolder.classList.add("is-3d");
    const appRoot = this._appRootURL();
    let mod = null;
    try {
      mod = await import("./runtime/heatmap-3d.js");   // 기록 탭 진입 시 동적 로드(classic app.js 유지)
    } catch (e) { console.warn("[heatmap] 3D 모듈 로드 실패 → SVG 대체", e); mod = null; }
    if (seq !== this._heatSeq) return;   // 로딩 중 화면이 바뀜 → 폐기(더 최신 요청이 처리)

    if (mod && mod.createHeatmap3D) {
      let ctrl = null;
      try {
        ctrl = mod.createHeatmap3D(svgHolder, {
          baseURL: appRoot,
          colors,
          // 내부 SVG 대체 시 시점명 갱신. 순수 3D일 땐 onStatus가 회전 안내로 덮음.
          onView: (label) => { viewName.textContent = label ? (label + " · 좌우 드래그 회전") : ""; },
          onStatus: (st) => {
            if (!st || seq !== this._heatSeq) return;
            if (st.state === "3d") viewName.textContent = "좌우로 드래그해 회전";
            else if (st.state === "unavailable") {
              viewName.hidden = true; prevBtn.hidden = true; nextBtn.hidden = true;
              svgHolder.classList.remove("is-3d");
              if (!svgHolder.childElementCount) svgHolder.appendChild(el("div", { class: "anat-fallback", text: "인체 모델을 불러오지 못했어요. 색상 대신 아래 수치를 참고하세요." }));
              if (rows.length) { scoreWrap.hidden = false; scoreToggle.textContent = "근육별 상세 닫기 ▴"; }
            }
          },
        });
      } catch (e) { console.warn("[heatmap] 3D 생성 실패 → SVG 대체", e); ctrl = null; }

      if (ctrl) {
        // 로딩 중 화면이 바뀌었으면 즉시 폐기(늦은 응답이 화면을 되살리지 않게).
        if (seq !== this._heatSeq) { try { ctrl.destroy(); } catch (_) {} return; }
        this._heatCtrls.add(ctrl);
        viewName.textContent = "불러오는 중…";
        // 정면 / 후면 버튼 (3D·내부 SVG 대체 공통). 연속 회전은 드래그·화살표(뷰어 내부 처리).
        prevBtn.textContent = "정면"; prevBtn.setAttribute("aria-label", "정면 보기");
        nextBtn.textContent = "후면"; nextBtn.setAttribute("aria-label", "후면 보기");
        prevBtn.disabled = false; nextBtn.disabled = false;
        prevBtn.onclick = () => { try { ctrl.showFront(); } catch (_) {} };
        nextBtn.onclick = () => { try { ctrl.showBack(); } catch (_) {} };
        // ready 이후에도 화면이 바뀌었으면 정리(ready 완료가 3D 성공을 보장하지 않음).
        Promise.resolve(ctrl.ready).then(() => {
          if (seq !== this._heatSeq && this._heatCtrls.has(ctrl)) { try { ctrl.destroy(); } catch (_) {} this._heatCtrls.delete(ctrl); }
        }).catch(() => {});
        return;
      }
    }
    // 3D 모듈 자체 로드/생성 실패 → 기존 5시점 SVG 화면 유지
    svgHolder.classList.remove("is-3d");
    await this._renderSVGModel(svgHolder, viewName, prevBtn, nextBtn, colors, seq, rows, scoreWrap, scoreToggle);
  },

  // 기존 5시점 SVG 인체 화면(3D 모듈을 못 읽을 때 대체). 색상만 재사용하며 재계산하지 않는다.
  async _renderSVGModel(svgHolder, viewName, prevBtn, nextBtn, colors, seq, rows, scoreWrap, scoreToggle) {
    let views, svgCache;
    try {
      views = window.FitlogCatalog.REGIONS_META.views;
      svgCache = await window.FitlogHeatmap.loadViews();
    } catch (e) {
      console.warn("[heatmap] SVG 로드 실패", e);
      svgHolder.appendChild(el("div", { class: "anat-fallback", text: "인체 모델을 불러오지 못했어요. 색상 대신 아래 수치를 참고하세요." }));
      viewName.hidden = true; prevBtn.hidden = true; nextBtn.hidden = true;
      if (rows && rows.length) { scoreWrap.hidden = false; scoreToggle.textContent = "근육별 상세 닫기 ▴"; }
      return;
    }
    if (seq !== this._heatSeq) return;
    prevBtn.textContent = "‹ 이전"; nextBtn.textContent = "다음 ›";
    let idx = Math.min(Math.max(this._heatViewIndex, 0), views.length - 1);
    const showView = (i) => {
      idx = Math.min(Math.max(i, 0), views.length - 1);
      this._heatViewIndex = idx;
      const v = views[idx];
      const tpl = svgCache[v.id];
      svgHolder.textContent = "";
      if (tpl) {
        const svg = tpl.cloneNode(true);
        svg.removeAttribute("width"); svg.removeAttribute("height");   // 카드 폭에 맞춰 반응형
        svg.setAttribute("class", "anat-model");
        window.FitlogHeatmap.paint(svg, colors);
        svg.classList.add("anat-fade");
        svgHolder.appendChild(svg);
      }
      viewName.textContent = (v.label_ko || v.id);
      prevBtn.disabled = idx === 0; nextBtn.disabled = idx === views.length - 1;
    };
    prevBtn.onclick = () => showView(idx - 1);
    nextBtn.onclick = () => showView(idx + 1);
    this.wireHeatSwipe(svgHolder, () => showView(idx + 1), () => showView(idx - 1));
    showView(idx);
  },
  // 좌우 스와이프로 시점 전환. 세로 스크롤은 방해하지 않음(touch-action:pan-y, |dx|>|dy|×1.2, 35px).
  wireHeatSwipe(elm, onNext, onPrev) {
    let sx = 0, sy = 0, active = false, decided = false, horiz = false;
    const TH = 35, RATIO = 1.2;
    const down = (e) => { active = true; decided = false; horiz = false; sx = e.clientX; sy = e.clientY; };
    const move = (e) => {
      if (!active) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        decided = true; horiz = Math.abs(dx) > Math.abs(dy) * RATIO;   // 수평 의도 판정
      }
      if (horiz && e.cancelable) e.preventDefault();   // 수평일 때만 스크롤 억제
    };
    const up = (e) => {
      if (!active) return; active = false;
      if (!horiz) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) >= TH && Math.abs(dx) > Math.abs(dy) * RATIO) { if (dx < 0) onNext(); else onPrev(); }
    };
    const cancel = () => { active = false; };
    elm.addEventListener("pointerdown", down);
    elm.addEventListener("pointermove", move);
    elm.addEventListener("pointerup", up);
    elm.addEventListener("pointercancel", cancel);
    elm.addEventListener("pointerleave", cancel);
  },

  // ---------------- 기록 ----------------
  async renderHistory() {
    this._destroyHeatmaps();   // 이전 히트맵 뷰어 정리 후 재구성(컨텍스트 누수 방지)
    const root = document.getElementById("view-history"); root.textContent = "";
    root.appendChild(el("div", { class: "section-label", text: "기록" }));
    if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 저장을 쓸 수 없어요." })); return; }
    let sessions = [];
    try { sessions = await window.FitlogDB.DB.recentSessions(); } catch (e) { console.warn(e); }
    if (!sessions.length) { root.appendChild(el("div", { class: "placeholder", text: "아직 저장된 운동이 없어요. 오늘 운동을 저장하면 여기에 날짜별로 쌓여요." })); return; }

    // 분석 기간 선택
    root.appendChild(this.rangeControls(this.historyRange, {
      onApply: (r) => { this.historyRange = r; this.saveHistoryRange(); this.renderHistory(); },
      onReset: () => { this.historyRange = this.defaultRange(); this.saveHistoryRange(); this.renderHistory(); },
    }));

    const inRange = sessions.filter((s) => this.inRange(s.date, this.historyRange));
    root.appendChild(this.renderStats(inRange, this.historyRange));

    // 근육 히트맵 카드 (기간 연동). 컨테이너를 먼저 붙이고 비동기로 채운다(기록 목록을 막지 않음).
    const heatHost = el("div", { class: "heat-host" });
    root.appendChild(heatHost);
    this.mountHeatmap(heatHost, inRange, this.historyRange, {});

    root.appendChild(el("div", { class: "section-label", text: "날짜별 기록 (기간 내)" }));
    if (!inRange.length) { root.appendChild(el("div", { class: "placeholder", text: "선택한 기간에 저장된 운동이 없어요." })); return; }
    inRange.forEach((s) => {
      const tpl = this.template(s.templateId); const name = tpl ? tpl.name : (s.templateId || "운동");
      const md = s.date.slice(5).replace("-", "/"); const wk = WEEKDAY_KO[s.weekday] || "";
      const req = (s.exerciseResults || []).filter((r) => !r.adhoc);
      const doneN = req.filter((r) => r.status === "completed" || r.status === "progression_candidate").length;
      const hasCardio = s.cardio || (s.exerciseResults || []).some((r) => r.kind === "cardio" && r.cardioActual);
      root.appendChild(el("button", { class: "hist-row", onclick: () => { this.histEditEx = null; this.histCardioEdit = false; this.renderHistoryDetail(s.id); } }, [
        el("span", { class: "h-date", text: `${md} ${wk}` }), el("span", { class: "h-name", text: name }),
        el("span", { class: "h-status", text: `${doneN}/${req.length}${hasCardio ? " · 유산소" : ""}` }),
      ]));
    });
  },
  // 선택 기간 내 세션 배열로 요약 계산 (유산소 종목·세션 유산소 모두 반영)
  renderStats(sessions, range) {
    const CAT_KO = { back: "등", chest: "가슴", shoulder: "어깨", leg: "하체", arm: "팔", custom: "기타" };
    let totalWork = 0, cardioMin = 0, cardioCnt = 0, done = 0, under = 0, missed = 0;
    const byCat = {}; const progs = new Set();
    sessions.forEach((s) => {
      (s.exerciseResults || []).forEach((r) => {
        if (r.kind === "cardio") {
          if (r.cardioActual) { cardioMin += r.cardioActual.durationMinutes || 0; cardioCnt++; }
        } else {
          const work = (r.sets || []).filter((x) => x.setType === "work").length;
          totalWork += work;
          const ex = this.exercise(r.exerciseId); const cat = (ex && ex.category) || "custom";
          if (cat !== "cardio") byCat[cat] = (byCat[cat] || 0) + work;
        }
        if (r.status === "progression_candidate") { const ex = this.exercise(r.exerciseId); progs.add((ex && ex.name) || r.exerciseName || r.exerciseId); }
        if (!r.adhoc) {
          if (r.status === "completed" || r.status === "progression_candidate") done++;
          else if (r.status === "volume_under") under++;
          else if (r.status === "skipped" || r.status === "not_started") missed++;
        }
      });
      if (s.cardio) { cardioMin += s.cardio.durationMinutes || 0; cardioCnt++; }
    });
    const catStr = Object.keys(byCat).length ? Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${CAT_KO[c] || c} ${n}`).join(" · ") : "—";

    // 상단 기간 바에 이미 날짜가 표시되므로 제목은 날짜 없이 '운동 요약' (섹션 5)
    const box = el("div", { class: "summary stats" }, [
      el("h3", { text: "운동 요약" }),
      el("div", { class: "row" }, [el("span", { text: "운동 세션" }), el("span", { text: `${sessions.length}회` })]),
      el("div", { class: "row" }, [el("span", { text: "총 본세트" }), el("span", { text: `${totalWork}세트` })]),
      el("div", { class: "row" }, [el("span", { text: "부위별 세트" }), el("span", { text: catStr })]),
      el("div", { class: "row" }, [el("span", { text: "유산소" }), el("span", { text: cardioCnt ? `${cardioCnt}회 · ${cardioMin}분` : "—" })]),
      el("div", { class: "row" }, [el("span", { text: "수행 현황" }), el("span", { text: `완료 ${done} · 부족 ${under} · 미실시 ${missed}` })]),
    ]);
    if (progs.size) box.appendChild(el("div", { class: "prog-list" }, [el("div", { class: "prog-label", text: "증량 후보" }), el("div", { class: "prog-names", text: [...progs].join(", ") })]));
    return box;
  },
  fmtActual(work) {
    if (!work.length) return "—";
    const ws = work.map((w) => w.weight);
    const uniform = ws.every((w) => w === ws[0]) && ws[0] != null;
    if (uniform) return `${ws[0]}kg · ${work.map((w) => w.reps).join(" / ")}`;
    return work.map((w) => `${w.weight == null ? "-" : w.weight}kg×${w.reps}`).join(", ");
  },
  recomputeStatus(r) {
    const gs = r.guideSnapshot || {};
    const ex = this.exercise(r.exerciseId);
    const judge = (r.sets || []).filter((x) => x.setType === "work").slice(0, gs.targetSets || 99).map((x) => ({ setType: "work", reps: x.reps, completed: true }));
    if (r.status === "skipped") return "skipped";
    return window.FitlogEval.evaluateExercise({ targetSets: gs.targetSets || judge.length, minReps: gs.minReps || 0, maxReps: gs.maxReps || 999, sideMode: (ex && ex.sideMode) || "total", targetWeight: gs.targetWeight }, judge, {}).status;
  },
  async renderHistoryDetail(id) {
    this._destroyHeatmaps();   // 목록↔상세 전환 시 활성 뷰어 정리
    this.histOpenId = id;
    const root = document.getElementById("view-history"); root.textContent = "";
    root.appendChild(el("button", { class: "link", onclick: () => { this.histEditEx = null; this.histCardioEdit = false; this.renderHistory(); } }, "‹ 목록으로"));
    let s = null; try { s = await window.FitlogDB.DB.get("workoutSessions", id); } catch (e) { console.warn(e); }
    if (!s) { root.appendChild(el("div", { class: "placeholder", text: "기록을 찾을 수 없어요." })); return; }
    const tpl = this.template(s.templateId);
    root.appendChild(el("div", { class: "today-title", text: `${s.date} (${WEEKDAY_KO[s.weekday] || ""})` }));
    root.appendChild(el("div", { class: "muted", style: "margin:-8px 2px 10px", text: tpl ? tpl.name : s.templateId }));

    s.exerciseResults.forEach((r) => {
      const ex = this.exercise(r.exerciseId); const nm = (ex && ex.name) || r.exerciseName || r.exerciseId;
      const gs = r.guideSnapshot || {};

      if (r.kind === "cardio") {
        const card = el("div", { class: "card" });
        if (this.histEditEx === r.exerciseId) {
          const a = r.cardioActual || { durationMinutes: gs.targetDurationMinutes || 0, speedKmh: gs.targetSpeedKmh || 0, incline: gs.targetIncline || 0 };
          const draft = { durationMinutes: a.durationMinutes, speedKmh: a.speedKmh, incline: a.incline, notes: r.notes || "" };
          card.appendChild(el("div", { class: "ex-name" }, [document.createTextNode(nm), el("span", { class: "opt", text: "유산소" })]));
          card.appendChild(el("div", { class: "cardio-grid", style: "margin:10px 0" }, [
            el("div", { class: "cardio-field" }, [el("label", { text: "시간 (분)" }), this.dial(draft, "durationMinutes", { step: 1, min: 0, unit: "" })]),
            el("div", { class: "cardio-field" }, [el("label", { text: "속도 (km/h)" }), this.dial(draft, "speedKmh", { step: 0.1, min: 0, unit: "" })]),
            el("div", { class: "cardio-field" }, [el("label", { text: "경사" }), this.dial(draft, "incline", { step: 1, min: 0, unit: "" })]),
          ]));
          const memo = el("input", { class: "memo-input", type: "text", value: draft.notes, placeholder: "＋ 메모", oninput: (e) => { draft.notes = e.target.value; } });
          card.appendChild(el("div", { class: "memo-row" }, [memo]));
          const save = async () => {
            r.cardioActual = { durationMinutes: draft.durationMinutes, speedKmh: draft.speedKmh, incline: draft.incline };
            r.status = "completed"; r.notes = draft.notes; s.updatedAt = new Date().toISOString();
            try { await window.FitlogDB.DB.put("workoutSessions", s); } catch (e) { console.error(e); }
            this.histEditEx = null; this.renderHistoryDetail(id);
          };
          card.appendChild(el("div", { class: "gedit-actions", style: "grid-template-columns:1fr auto" }, [
            el("button", { class: "btn btn-primary", onclick: save }, "수정 저장"),
            el("button", { class: "btn btn-ghost", onclick: () => { this.histEditEx = null; this.renderHistoryDetail(id); } }, "취소"),
          ]));
        } else {
          card.appendChild(el("div", { class: "card-top" }, [el("div", { class: "ex-name" }, [document.createTextNode(nm), el("span", { class: "opt", text: "유산소" })]), el("span", { class: `badge ${r.status}`, text: this.statusLabel(r.status) })]));
          if (gs.targetDurationMinutes != null) card.appendChild(el("div", { class: "guide-line", text: `목표 ${gs.targetDurationMinutes}분 · ${gs.targetSpeedKmh}km/h · 경사 ${gs.targetIncline}` }));
          card.appendChild(el("div", { class: "guide-line", text: `실제 ${r.cardioActual ? `${r.cardioActual.durationMinutes}분 · ${r.cardioActual.speedKmh}km/h · 경사 ${r.cardioActual.incline}` : "미기록"}` }));
          if (r.notes) card.appendChild(el("div", { class: "memo-line", text: `메모 ${r.notes}` }));
          card.appendChild(el("div", { class: "card-foot" }, [el("span", {}, ""), el("button", { class: "btn btn-sm", onclick: () => { this.histEditEx = r.exerciseId; this.renderHistoryDetail(id); } }, "수정")]));
        }
        root.appendChild(card);
        return;
      }

      const work = (r.sets || []).filter((x) => x.setType === "work");
      const warm = (r.sets || []).filter((x) => x.setType === "warmup");
      const card = el("div", { class: "card" });

      if (this.histEditEx === r.exerciseId) {
        // 편집 모드: 각 세트 다이얼 + 메모
        const draft = { work: work.map((w) => ({ weight: w.weight, reps: w.reps })), warm: warm.map((w) => ({ weight: w.weight, reps: w.reps })), notes: r.notes || "" };
        card.appendChild(el("div", { class: "ex-name", text: nm }));
        if (draft.warm.length) card.appendChild(el("div", { class: "section-label", style: "margin:8px 2px 4px", text: "워밍업" }));
        draft.warm.forEach((w, i) => card.appendChild(el("div", { class: "set-row warmup" }, [el("span", { class: "set-no", text: "W" }), this.dial(w, "weight", { step: 0.5, min: 0, unit: "kg", allowNull: true }), this.dial(w, "reps", { step: 1, min: 0, unit: "회" }), el("span", {})])));
        card.appendChild(el("div", { class: "section-label", style: "margin:8px 2px 4px", text: "본세트" }));
        draft.work.forEach((w, i) => card.appendChild(el("div", { class: "set-row" }, [el("span", { class: "set-no", text: `${i + 1}` }), this.dial(w, "weight", { step: 0.5, min: 0, unit: "kg", allowNull: true }), this.dial(w, "reps", { step: 1, min: 0, unit: "회" }), el("span", {})])));
        const memo = el("input", { class: "memo-input", type: "text", value: draft.notes, placeholder: "＋ 메모", oninput: (e) => { draft.notes = e.target.value; } });
        card.appendChild(el("div", { class: "memo-row" }, [memo]));
        const save = async () => {
          r.sets = [
            ...draft.warm.map((w) => ({ setNumber: 0, setType: "warmup", weight: w.weight, reps: w.reps, completed: true })),
            ...draft.work.map((w, i) => ({ setNumber: i + 1, setType: "work", weight: w.weight, reps: w.reps, completed: true })),
          ];
          r.notes = draft.notes; r.status = this.recomputeStatus(r); s.updatedAt = new Date().toISOString();
          try { await window.FitlogDB.DB.put("workoutSessions", s); } catch (e) { console.error(e); }
          this.histEditEx = null; this.renderHistoryDetail(id);
        };
        card.appendChild(el("div", { class: "gedit-actions", style: "grid-template-columns:1fr auto" }, [
          el("button", { class: "btn btn-primary", onclick: save }, "수정 저장"),
          el("button", { class: "btn btn-ghost", onclick: () => { this.histEditEx = null; this.renderHistoryDetail(id); } }, "취소"),
        ]));
      } else {
        card.appendChild(el("div", { class: "card-top" }, [el("div", { class: "ex-name", text: nm }), el("span", { class: `badge ${r.status}`, text: this.statusLabel(r.status) })]));
        if (gs.targetWeight != null) card.appendChild(el("div", { class: "guide-line", text: `가이드 ${gs.targetWeight}kg · ${gs.minReps}~${gs.maxReps} × ${gs.targetSets}` }));
        if (warm.length) card.appendChild(el("div", { class: "last-line", text: `워밍업 ${warm.map((w) => `${w.weight == null ? "-" : w.weight}kg×${w.reps}`).join(" / ")}` }));
        card.appendChild(el("div", { class: "guide-line", text: `실제 ${this.fmtActual(work)}` }));
        if (r.notes) card.appendChild(el("div", { class: "memo-line", text: `메모 ${r.notes}` }));
        card.appendChild(el("div", { class: "card-foot" }, [el("span", {}, ""), el("button", { class: "btn btn-sm", onclick: () => { this.histEditEx = r.exerciseId; this.renderHistoryDetail(id); } }, "수정")]));
      }
      root.appendChild(card);
    });
    if (s.cardio) {
      const cd = el("div", { class: "card" });
      if (this.histCardioEdit) {
        const draft = { incline: s.cardio.incline, speedKmh: s.cardio.speedKmh, durationMinutes: s.cardio.durationMinutes };
        cd.appendChild(el("div", { class: "ex-name", text: "유산소" }));
        const f = (key, label, step) => el("div", { class: "cardio-field" }, [el("label", { text: label }), this.dial(draft, key, { step, min: 0, unit: "" })]);
        cd.appendChild(el("div", { class: "cardio-grid" }, [f("incline", "경사", 1), f("speedKmh", "속도 (km/h)", 0.1), f("durationMinutes", "시간 (분)", 1)]));
        const save = async () => {
          s.cardio.incline = draft.incline; s.cardio.speedKmh = draft.speedKmh; s.cardio.durationMinutes = draft.durationMinutes; s.updatedAt = new Date().toISOString();
          try { await window.FitlogDB.DB.put("workoutSessions", s); } catch (e) { console.error(e); }
          this.histCardioEdit = false; this.renderHistoryDetail(id);
        };
        cd.appendChild(el("div", { class: "gedit-actions", style: "grid-template-columns:1fr auto" }, [
          el("button", { class: "btn btn-primary", onclick: save }, "수정 저장"),
          el("button", { class: "btn btn-ghost", onclick: () => { this.histCardioEdit = false; this.renderHistoryDetail(id); } }, "취소"),
        ]));
      } else {
        cd.appendChild(el("div", { class: "card-top" }, [el("div", { class: "ex-name", text: "유산소" }), el("button", { class: "btn btn-sm", onclick: () => { this.histCardioEdit = true; this.renderHistoryDetail(id); } }, "수정")]));
        cd.appendChild(el("div", { class: "guide-line", text: `경사 ${s.cardio.incline} · ${s.cardio.speedKmh}km/h · ${s.cardio.durationMinutes}분` }));
      }
      root.appendChild(cd);
    }

    // 이 날짜의 근육 히트맵 (접기/펼치기). 메인 분석 기간은 바꾸지 않고 해당 세션만 계산. (섹션 15)
    if (window.FitlogHeatmap && window.FitlogCatalog) {
      const dayHost = el("div", { class: "heat-host" });
      const toggle = el("button", { class: "btn btn-sm btn-ghost btn-block", type: "button", style: "margin-top:10px",
        text: "이 날짜의 근육 부위 보기 ▾" });
      let open = false;
      toggle.addEventListener("click", () => {
        open = !open;
        toggle.textContent = open ? "이 날짜의 근육 부위 닫기 ▴" : "이 날짜의 근육 부위 보기 ▾";
        if (open && !dayHost.childElementCount) this.mountHeatmap(dayHost, [s], { start: s.date, end: s.date }, { sessionId: s.id });
        dayHost.hidden = !open;
      });
      dayHost.hidden = true;
      root.appendChild(toggle); root.appendChild(dayHost);
    }

    // 이 기록(세션) 전체 삭제 — 상세 안에서만 노출(기록 목록에서의 오삭제 방지). 확인 절차 필수.
    root.appendChild(el("div", { class: "hist-danger" }, [
      el("button", { class: "btn btn-block danger-btn", type: "button", onclick: () => this.deleteSession(s) }, "🗑 이 기록 전체 삭제"),
      el("div", { class: "hist-danger-note", text: "이 날짜의 이 세션 기록 전체가 삭제됩니다. 되돌릴 수 없어요." }),
    ]));
  },

  // 세션(하루 기록) 전체 삭제. 실수로 중복 저장한 기록 등을 상세에서 통째로 제거. 확인 후 삭제 → 목록으로.
  async deleteSession(s) {
    const tpl = this.template(s.templateId);
    const label = `${s.date} (${WEEKDAY_KO[s.weekday] || ""}) · ${tpl ? tpl.name : s.templateId}`;
    if (!window.confirm(`'${label}' 기록을 전체 삭제할까요?\n되돌릴 수 없습니다.`)) return;
    try { await window.FitlogDB.DB.delete("workoutSessions", s.id); }
    catch (e) { console.error("[Fitlog] 기록 삭제 실패", e); window.alert("삭제 중 오류가 발생했어요. 기록은 그대로 유지됩니다."); return; }
    this.histOpenId = null; this.histEditEx = null; this.histCardioEdit = false;
    this.renderHistory();
  },

  // ---------------- 가이드 편집 (Phase 3) ----------------
  async reloadDefs() {
    const DB = window.FitlogDB.DB;
    this.templates = (await DB.getAll("routineTemplates")).sort((a, b) => a.order - b.order);
    this.exercises = await DB.getAll("exercises");
    this.guides = await DB.getAll("routineGuides");
    try { this.userMap = await DB.userMuscleMapAll(); } catch (_) { this.userMap = this.userMap || {}; }
  },
  renderGuide() {
    const root = document.getElementById("view-guide"); root.textContent = "";
    root.appendChild(el("div", { class: "section-label", text: "가이드 편집" }));
    if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 편집/저장을 쓸 수 없어요." })); return; }
    const tid = this.guideEditTemplateId || this.templates[0].id;
    this.guideEditTemplateId = tid;

    const sel = el("select", { onchange: (e) => { this.guideEditTemplateId = e.target.value; this.editingGuideId = null; this.renderGuide(); } },
      this.templates.map((t) => el("option", { value: t.id, ...(t.id === tid ? { selected: "selected" } : {}) }, t.name)));
    root.appendChild(el("div", { class: "select-wrap", style: "margin:0 2px 8px" }, [sel]));

    root.appendChild(el("div", { class: "tpl-actions" }, [
      el("button", { class: "btn btn-sm", onclick: () => this.renameTemplate(tid) }, "이름 변경"),
      el("button", { class: "btn btn-sm danger-btn", onclick: () => this.deleteTemplate(tid) }, "템플릿 삭제"),
      el("button", { class: "btn btn-sm", onclick: () => this.addTemplate() }, "＋ 새 템플릿"),
    ]));

    const guides = this.guidesOf(tid);
    if (!guides.length) root.appendChild(el("div", { class: "placeholder", text: "이 템플릿에 운동이 없어요. 아래에서 추가하세요." }));
    guides.forEach((g, idx) => {
      const ex = this.exercise(g.exerciseId);
      root.appendChild(this.editingGuideId === g.id ? this.renderGuideEditor(g, ex, idx, guides.length) : this.renderGuideRow(g, ex));
    });
    root.appendChild(el("div", { class: "add-ex-row" }, [
      el("button", { class: "btn add-set add-ex-main", onclick: () => this.openAddExerciseFlow(tid) }, "＋ 운동 추가"),
    ]));

    root.appendChild(el("div", { class: "section-label", text: "요일 배정" }));
    root.appendChild(this.renderDayMap());
  },

  async addTemplate() {
    const name = (window.prompt("새 템플릿 이름 (예: 팔·복근)") || "").trim(); if (!name) return;
    const id = "tpl-" + Date.now();
    const order = Math.max(0, ...this.templates.map((t) => t.order)) + 1;
    try { await window.FitlogDB.DB.put("routineTemplates", { id, name, order, active: true }); await this.reloadDefs(); } catch (e) { console.error(e); }
    this.guideEditTemplateId = id; this.editingGuideId = null; this.renderGuide();
  },
  async renameTemplate(id) {
    const t = this.template(id); const name = (window.prompt("템플릿 이름", t.name) || "").trim(); if (!name) return;
    t.name = name; try { await window.FitlogDB.DB.put("routineTemplates", t); await this.reloadDefs(); } catch (e) { console.error(e); }
    this.renderGuide();
  },
  async deleteTemplate(id) {
    if (this.templates.length <= 1) { window.alert("템플릿은 최소 1개 필요해요."); return; }
    const t = this.template(id);
    if (!window.confirm(`'${t.name}' 템플릿과 그 안의 가이드를 삭제할까요? (기존 운동 기록은 그대로 남아요)`)) return;
    try {
      for (const g of this.guidesOf(id)) await window.FitlogDB.DB.delete("routineGuides", g.id);
      await window.FitlogDB.DB.delete("routineTemplates", id);
      const map = this.settings.dayTemplateMap; let changed = false;
      for (const k of Object.keys(map)) if (map[k] === id) { map[k] = null; changed = true; }
      if (changed) this.persistSettings();
      await this.reloadDefs();
    } catch (e) { console.error(e); }
    this.guideEditTemplateId = this.templates[0] && this.templates[0].id; this.editingGuideId = null; this.renderGuide();
  },
  // ───────── 운동 추가 플로우 (목록 선택 / 찾아보기 / 직접 만들기) ─────────
  openAddExerciseFlow(tid) {
    const overlay = el("div", { class: "modal-overlay" });
    const sheet = el("div", { class: "modal-sheet addex-sheet" });

    // iOS는 키보드가 떠도 레이아웃 뷰포트를 줄이지 않아 inset:0 오버레이의 시트가 키보드 뒤에 깔린다.
    // 오버레이를 실제 보이는 영역(visualViewport)에 맞추고, 키보드가 열리면 시트가 그 영역을 꽉 채운다.
    const SHEET_RATIO = 0.86;
    const MIN_H_PX = 200;
    const vv = window.visualViewport;
    let baseH = window.innerHeight;
    const fit = () => {
      baseH = Math.max(baseH, window.innerHeight);
      const vh = vv ? vv.height : window.innerHeight;
      const a = document.activeElement;
      const typing = !!a && sheet.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
      const kb = baseH - vh > 120 || (typing && vh < screen.height - 150);
      overlay.style.top = (vv ? vv.offsetTop : 0) + "px";
      overlay.style.bottom = "auto";
      overlay.style.height = vh + "px";
      overlay.classList.toggle("kb-open", kb);
      // 키보드가 열리면 보이는 영역을 채우되, 상단은 상태바·다이나믹 아일랜드(safe-area-top) 아래로
      sheet.style.height = kb
        ? "max(" + MIN_H_PX + "px, " + Math.floor(vh) + "px - env(safe-area-inset-top, 0px) - 10px)"
        : Math.max(Math.floor(vh * SHEET_RATIO), MIN_H_PX) + "px";
    };
    const fitSoon = () => { fit(); setTimeout(fit, 120); setTimeout(fit, 350); };
    fit();
    if (vv) { vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); }
    window.addEventListener("resize", fit);
    sheet.addEventListener("focusin", fitSoon);
    sheet.addEventListener("focusout", fitSoon);

    const close = () => {
      this._disposePreview(ctx);
      if (vv) { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); }
      window.removeEventListener("resize", fit);
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.appendChild(sheet); document.body.appendChild(overlay);
    // listState/searchState: 상세에서 돌아올 때 검색어·필터·스크롤 복원용. detailBack: 상세의 뒤로 목적지.
    const ctx = { tid, sheet, close, go: null, previewCtrl: null, previewGen: 0, listState: null, searchState: null, detailBack: "search" };
    ctx.go = (state, arg) => {
      this._disposePreview(ctx);   // 화면을 지우기 전에 동기적으로 3D 정리(WebGL 누수·늦은 로딩 방지)
      sheet.textContent = "";
      if (state === "list") this._addList(ctx);
      else if (state === "search") this._addSearch(ctx);
      else if (state === "create") this._addCreate(ctx, arg);
      else if (state === "detail") this._addDetail(ctx, arg);
      else this._addEntry(ctx);
    };
    ctx.go("entry");
  },
  _addHeader(ctx, title, backState) {
    return el("div", { class: "addex-head" }, [
      backState ? el("button", { class: "addex-back", type: "button", onclick: () => ctx.go(backState) }, "‹") : el("span", { class: "addex-back-spacer" }),
      el("div", { class: "addex-title", text: title }),
      el("button", { class: "addex-x", type: "button", onclick: ctx.close }, "✕"),
    ]);
  },
  _addToast(ctx, msg) {
    const t = el("div", { class: "addex-toast", text: msg });
    ctx.sheet.appendChild(t);
    setTimeout(() => { try { t.remove(); } catch (_) {} }, 1500);
  },
  _equipLabel(eq) {
    return ({ barbell: "바벨", dumbbell: "덤벨", machine: "머신", cable: "케이블", assisted_machine: "보조 머신", bodyweight: "맨몸", ez_bar: "이지바", smith_machine: "스미스", dip_station: "딥스", pullup_bar: "철봉", treadmill: "트레드밀", bike: "자전거", stepmill: "스텝밀", elliptical: "엘립티컬", rower: "로잉머신", per_side_stack: "케이블" })[eq] || "";
  },
  _catalogPartsText(c) {
    const m = this.catalogMappingById(c.id);
    if (!m) return null;
    if (c.exerciseType === "cardio") { const dm = m.descriptiveMuscles || []; return dm.length ? dm.map((id) => this.regionLabel(id)).join(" · ") : null; }
    const pri = Object.keys(m.primary || {}); if (!pri.length) return null;
    const sec = Object.keys(m.secondary || {});
    let t = pri.map((id) => this.regionLabel(id)).join(" · ");
    if (sec.length) t += "  (보조: " + sec.map((id) => this.regionLabel(id)).join(" · ") + ")";
    return t;
  },
  // 3D 운동 미리보기 자산(catalog-data.js EXERCISE_PREVIEWS). 없으면 null → 상세에 슬롯을 만들지 않음.
  _exercisePreviewAsset(catId) {
    const map = (window.FitlogCatalog && window.FitlogCatalog.EXERCISE_PREVIEWS) || {};
    return map[catId] || null;
  },
  // 히트맵(_heatCtrls)과 별개로 운동 추가 시트(ctx)마다 3D 컨트롤러 1개만 관리. import 완료를 기다리지 않는다.
  _disposePreview(ctx) {
    ctx.previewGen = (ctx.previewGen || 0) + 1;
    const ctrl = ctx.previewCtrl; ctx.previewCtrl = null;
    if (ctrl) { try { ctrl.destroy(); } catch (_) {} }
  },
  async _mountPreview(ctx, wrap, holder, playBtn, cid) {
    this._disposePreview(ctx);
    const gen = ctx.previewGen;
    const stale = () => gen !== ctx.previewGen || !holder.isConnected;
    const fail = () => { if (gen === ctx.previewGen) wrap.hidden = true; };   // 실패해도 설명·추가 버튼은 그대로
    try {
      const { createExercisePreview } = await import("./runtime/exercise-preview-3d.js");
      if (stale()) return;
      const ctrl = createExercisePreview(holder, {
        exerciseId: cid, baseURL: this._appRootURL(), autoplay: true,
        onStatus: ({ state }) => { if (state === "error" || state === "unavailable") fail(); },
      });
      ctx.previewCtrl = ctrl;
      await ctrl.ready;
      if (stale()) { try { ctrl.destroy(); } catch (_) {} return; }
      if (ctrl.getDiagnostics().state !== "ready") { fail(); return; }
      playBtn.disabled = false;
    } catch (_) { fail(); }
  },
  // 색은 runtime의 animation-muscle-map.json(주동 #ff825f / 보조 #e5bf70)과 맞춘다. 운동 부위 안내이지 활성도 측정이 아님.
  _buildPreview(ctx, c) {
    const holder = el("div", { class: "addex-preview" });
    const playBtn = el("button", { class: "addex-pv-btn", type: "button", disabled: "" }, "일시정지");
    playBtn.addEventListener("click", () => {
      const ctrl = ctx.previewCtrl; if (!ctrl) return;
      if (ctrl.getDiagnostics().playing) { ctrl.pause(); playBtn.textContent = "재생"; }
      else { ctrl.play(); playBtn.textContent = "일시정지"; }
    });
    const m = this.catalogMappingById(c.id) || {};
    const chip = (cls, label, obj) => {
      const ids = Object.keys(obj || {}); if (!ids.length) return null;
      return el("span", { class: "addex-pv-key" }, [el("i", { class: "addex-pv-dot " + cls }), label + " " + ids.map((id) => this.regionLabel(id)).join("·")]);
    };
    const wrap = el("div", { class: "addex-preview-wrap" }, [
      holder,
      el("div", { class: "addex-pv-bar" }, [playBtn, el("div", { class: "addex-pv-legend" }, [chip("pri", "주요", m.primary), chip("sec", "보조", m.secondary)])]),
      el("div", { class: "addex-pv-hint", text: "좌우로 밀면 시점이 돌아가요" }),
    ]);
    // 첫 await(import) 전에 호출자가 wrap을 DOM에 붙이므로, 이후 holder.isConnected 검사가 유효하다
    this._mountPreview(ctx, wrap, holder, playBtn, c.id);
    return wrap;
  },
  // ───────── 3D 기술 시제품 시험 화면 (설정 → 개발자) ─────────
  // 정식 미리보기(EXERCISE_PREVIEWS·운동 상세)와 분리: 품질 승인 전 자산을 일반 운동 목록에 노출하지 않는다.
  // 공유 인체 + 클립 + 장비 구조는 runtime/exercise-prototype-3d.js, 시트를 열 때만 로드한다.
  PROTO_3D_IDS: ["barbell_bench_press", "push_up", "lat_pulldown", "treadmill_incline_walk"],
  openProto3DLab() {
    const overlay = el("div", { class: "modal-overlay" });
    const sheet = el("div", { class: "modal-sheet proto-sheet" });
    const lab = { ctrl: null, closed: false, current: null };
    const close = () => {
      lab.closed = true;
      if (lab.ctrl) { try { lab.ctrl.destroy(); } catch (_) {} lab.ctrl = null; }
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const nameEl = el("div", { class: "proto-name" });
    const statusEl = el("div", { class: "proto-status", text: "준비 중…" });
    const holder = el("div", { class: "proto-view" });
    const playBtn = el("button", { class: "addex-pv-btn", type: "button", disabled: "" }, "일시정지");
    const legend = el("div", { class: "addex-pv-legend" });
    const chips = el("div", { class: "addex-chips proto-chips" });
    const label = (id) => (this.catalogById(id) || {}).label_ko || id;
    const renderChips = () => {
      chips.textContent = "";
      this.PROTO_3D_IDS.forEach((id) => chips.appendChild(el("button", { class: "addex-chip" + (lab.current === id ? " on" : ""), type: "button", onclick: () => pick(id) }, label(id))));
    };
    const pick = async (id) => {
      lab.current = id; renderChips();
      nameEl.textContent = label(id);
      const m = this.catalogMappingById(id) || {};
      const key = (cls, t, obj) => { const ids = Object.keys(obj || {}); return ids.length ? el("span", { class: "addex-pv-key" }, [el("i", { class: "addex-pv-dot " + cls }), t + " " + ids.map((r) => this.regionLabel(r)).join("·")]) : null; };
      legend.textContent = "";
      [key("pri", "주요", m.primary), key("sec", "보조", m.secondary)].forEach((n) => n && legend.appendChild(n));
      if (!legend.childNodes.length) legend.appendChild(el("span", { class: "addex-pv-key", text: "강조 부위 없음(유산소)" }));
      playBtn.disabled = true; playBtn.textContent = "일시정지";
      if (!lab.ctrl) return;
      // 앱 카탈로그 매핑의 primary/secondary 기준으로 강조(minor는 강조하지 않음)
      const st = await lab.ctrl.select(id, { muscles: { primary: m.primary || {}, secondary: m.secondary || {} } });
      if (lab.closed || lab.current !== id) return;
      playBtn.disabled = st !== "ready";
    };
    playBtn.addEventListener("click", () => {
      const c = lab.ctrl; if (!c) return;
      if (c.isPlaying()) { c.pause(); playBtn.textContent = "재생"; } else { c.play(); playBtn.textContent = "일시정지"; }
    });

    sheet.appendChild(el("div", { class: "addex-head" }, [
      el("span", { class: "addex-back-spacer" }),
      el("div", { class: "addex-title", text: "3D 시제품 시험" }),
      el("button", { class: "addex-x", type: "button", onclick: close }, "✕"),
    ]));
    sheet.appendChild(el("div", { class: "proto-body" }, [
      el("div", { class: "proto-warn" }, [
        el("span", { class: "proto-badge", text: "기술 시제품" }),
        el("span", { text: "품질 검증이 끝나지 않은 시험용 동작이에요. 자세 기준으로 참고하지 말고, 움직임·장비·구도·기기 동작만 확인해 주세요. 정식 운동 미리보기에는 등록되지 않았어요." }),
      ]),
      chips,
      el("div", { class: "proto-titlebar" }, [nameEl, el("span", { class: "proto-status-tag", text: "technical_prototype" })]),
      holder,
      el("div", { class: "addex-pv-bar" }, [playBtn, legend]),
      statusEl,
    ]));
    overlay.appendChild(sheet); document.body.appendChild(overlay);

    renderChips();
    const first = this.PROTO_3D_IDS[0];
    pick(first);
    import("./runtime/exercise-prototype-3d.js").then(({ createPrototypePreview }) => {
      if (lab.closed) return;
      lab.ctrl = createPrototypePreview(holder, {
        baseURL: this._appRootURL(),
        onStatus: ({ state, reason }) => {
          if (lab.closed || !lab.ctrl) return;
          const d = state === "ready" ? lab.ctrl.getDiagnostics() : null;
          statusEl.textContent = state === "ready"
            ? "로딩 " + d.lastLoadMs + "ms · 장비 " + (d.equipment.length ? d.equipment.join(", ") : "없음") + " · 좌우로 밀면 시점 회전"
            : (reason || state);
          statusEl.classList.toggle("err", state === "error" || state === "unavailable");
        },
      });
      pick(lab.current || first);
    }).catch(() => { if (!lab.closed) { statusEl.textContent = "시제품 모듈을 불러오지 못했어요."; statusEl.classList.add("err"); } });
  },
  // 카탈로그 행(목록·검색 공용). opts.detail=true면 이름 탭 시 상세로, opts.from은 상세의 뒤로 목적지.
  _addCatalogRow(ctx, c, opts) {
    opts = opts || {};
    const inGuide = this.catalogInGuide(ctx.tid, c.id);
    const addBtn = inGuide
      ? el("span", { class: "addex-added", text: "이미 추가됨" })
      : el("button", { class: "addex-add-btn", type: "button" }, "＋");
    if (!inGuide) addBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await this.addCatalogExerciseToGuide(ctx.tid, c.id);
      if (res.dup) this._addToast(ctx, "이미 추가된 운동이에요");
      else if (res.ok) this._addToast(ctx, res.ex.name + " 추가됨");
      else this._addToast(ctx, "추가하지 못했어요");
      addBtn.replaceWith(el("span", { class: "addex-added", text: "이미 추가됨" }));
      if (this.view === "guide") this.renderGuide();
    });
    const main = el("div", { class: "addex-item-main" + (opts.detail ? " tappable" : "") }, [
      el("div", { class: "addex-item-name" }, [c.label_ko || c.id, this._exercisePreviewAsset(c.id) ? el("span", { class: "addex-3d-badge", text: "3D" }) : null]),
      el("div", { class: "addex-item-sub", text: this.categoryLabel(c.category) + (c.equipment ? " · " + this._equipLabel(c.equipment) : "") }),
    ]);
    if (opts.detail) main.addEventListener("click", () => { ctx.detailBack = opts.from || "search"; ctx.go("detail", c.id); });
    return el("div", { class: "addex-item" }, [main, addBtn]);
  },
  _addQuickRow(ctx, cid) {
    const c = this.catalogById(cid); if (!c) return el("span");
    return this._addCatalogRow(ctx, c, {});
  },
  async _addEntry(ctx) {
    ctx.listState = null; ctx.searchState = null;   // 첫 화면에서 새로 들어가면 목록·검색은 초기 상태로
    ctx.sheet.appendChild(this._addHeader(ctx, "운동 추가", null));
    const body = el("div", { class: "addex-body" });
    ctx.sheet.appendChild(body);
    const freqWrap = el("div", { class: "addex-freq" });
    body.appendChild(freqWrap);
    body.appendChild(el("div", { class: "addex-menu" }, [
      el("button", { class: "addex-menu-btn", type: "button", onclick: () => ctx.go("list") }, [el("span", { text: "운동 목록 선택" }), el("span", { class: "addex-arrow", text: "›" })]),
      el("button", { class: "addex-menu-btn", type: "button", onclick: () => ctx.go("search") }, [el("span", { text: "운동 찾아보기" }), el("span", { class: "addex-arrow", text: "›" })]),
      el("button", { class: "addex-menu-btn addex-create-btn", type: "button", onclick: () => ctx.go("create") }, [el("span", { text: "＋ 직접 운동 만들기" })]),
    ]));
    const ids = await this.frequentCatalogIds(ctx.tid, 6);
    if (!ids.length) { freqWrap.remove(); return; }
    freqWrap.appendChild(el("div", { class: "addex-section-label", text: "자주 하는 운동" }));
    const listEl = el("div", { class: "addex-list" });
    ids.forEach((cid) => listEl.appendChild(this._addQuickRow(ctx, cid)));
    freqWrap.appendChild(listEl);
  },
  _addList(ctx) {
    // ── 구조: addex-head(고정) → addex-fixed-top(검색+칩, 고정) → addex-scroll-list(결과만 스크롤) ──
    // iOS Safari에서 overflow:auto 컨테이너 안의 sticky 검색창이 결과 개수 변화 시 튀는 문제 수정.
    ctx.sheet.appendChild(this._addHeader(ctx, "운동 목록 선택", "entry"));
    const state = ctx.listState || (ctx.listState = { q: "", type: "all", region: "all", scroll: 0 });
    const searchIn = el("input", { type: "search", class: "addex-search", placeholder: "운동 이름 검색", enterkeyhint: "search", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" });
    searchIn.value = state.q;
    const typeChips = el("div", { class: "addex-chips" });
    const regionChips = el("div", { class: "addex-chips addex-chips-region" });
    // 고정 영역(검색창 + 칩) — 스크롤 컨테이너 밖
    const fixedTop = el("div", { class: "addex-fixed-top" }, [searchIn, typeChips, regionChips]);
    ctx.sheet.appendChild(fixedTop);
    // 결과 목록만 스크롤
    const listEl = el("div", { class: "addex-list" });
    const scrollEl = el("div", { class: "addex-scroll-list" }, [listEl]);
    ctx.sheet.appendChild(scrollEl);
    const typeDefs = [["all", "전체"], ["strength", "근력"], ["cardio", "유산소"]];
    const regionDefs = [["all", "전체 부위"], ["chest", "가슴"], ["back", "등"], ["shoulders", "어깨"], ["biceps", "이두"], ["triceps", "삼두"], ["legs", "하체"], ["core", "코어"]];
    const renderList = () => {
      listEl.textContent = "";
      let items = this.catalogSearch(state.q, state.type, state.region);
      if (!state.q.trim()) items = items.slice().sort((a, b) => (a.label_ko || "").localeCompare(b.label_ko || "", "ko"));
      if (!items.length) { listEl.appendChild(el("div", { class: "addex-empty", text: "일치하는 운동이 없어요." })); return; }
      items.forEach((c) => listEl.appendChild(this._addCatalogRow(ctx, c, { detail: true, from: "list" })));
    };
    const renderTypeChips = () => {
      typeChips.textContent = "";
      typeDefs.forEach(([v, l]) => typeChips.appendChild(el("button", { class: "addex-chip" + (state.type === v ? " on" : ""), type: "button", onclick: () => { state.type = v; if (v === "cardio") state.region = "all"; renderTypeChips(); renderRegionChips(); renderList(); } }, l)));
    };
    const renderRegionChips = () => {
      regionChips.textContent = "";
      if (state.type === "cardio") return;
      regionDefs.forEach(([v, l]) => regionChips.appendChild(el("button", { class: "addex-chip" + (state.region === v ? " on" : ""), type: "button", onclick: () => { state.region = v; renderRegionChips(); renderList(); } }, l)));
    };
    searchIn.addEventListener("input", () => { state.q = searchIn.value; state.scroll = 0; renderList(); });
    scrollEl.addEventListener("scroll", () => { state.scroll = scrollEl.scrollTop; }, { passive: true });
    renderTypeChips(); renderRegionChips(); renderList();
    scrollEl.scrollTop = state.scroll;
  },
  _addSearch(ctx) {
    // ── 구조: addex-head(고정) → addex-fixed-top(검색창+힌트, 고정) → addex-scroll-list(결과만 스크롤) ──
    ctx.sheet.appendChild(this._addHeader(ctx, "운동 찾아보기", "entry"));
    const searchIn = el("input", { type: "search", class: "addex-search", placeholder: "이름·부위·기구·동작 설명", enterkeyhint: "search", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" });
    const hintEl = el("div", { class: "addex-hint", text: "예: ‘이두’, ‘케이블’, ‘서서 긴 바를 드는 운동’, ‘계단 올라가는 운동’" });
    // 고정 영역(검색창 + 힌트) — 스크롤 컨테이너 밖
    const fixedTop = el("div", { class: "addex-fixed-top" }, [searchIn, hintEl]);
    ctx.sheet.appendChild(fixedTop);
    // 결과 목록만 스크롤
    const listEl = el("div", { class: "addex-list" });
    const scrollEl = el("div", { class: "addex-scroll-list" }, [listEl]);
    ctx.sheet.appendChild(scrollEl);
    const state = ctx.searchState || (ctx.searchState = { q: "", scroll: 0 });
    searchIn.value = state.q;
    const render = () => {
      listEl.textContent = "";
      const q = searchIn.value.trim();
      if (!q) { listEl.appendChild(el("div", { class: "addex-empty", text: "검색어를 입력하면 관련 운동이 나와요." })); return; }
      const items = this.catalogSearch(q, "all", "all");
      if (!items.length) { listEl.appendChild(el("div", { class: "addex-empty", text: "관련 운동을 못 찾았어요. 부위나 기구 이름으로도 검색해 보세요." })); return; }
      items.slice(0, 20).forEach((c) => listEl.appendChild(this._addCatalogRow(ctx, c, { detail: true, from: "search" })));
    };
    searchIn.addEventListener("input", () => { state.q = searchIn.value; state.scroll = 0; render(); });
    scrollEl.addEventListener("scroll", () => { state.scroll = scrollEl.scrollTop; }, { passive: true });
    render();
    scrollEl.scrollTop = state.scroll;
    // 상세에서 돌아온 경우(검색어 있음)엔 키보드를 다시 띄우지 않고 결과를 바로 보여준다
    if (!state.q) setTimeout(() => { try { searchIn.focus(); } catch (_) {} }, 60);
  },
  _addDetail(ctx, cid) {
    const c = this.catalogById(cid);
    const back = ctx.detailBack || "search";
    ctx.sheet.appendChild(this._addHeader(ctx, "운동 상세", back));
    const body = el("div", { class: "addex-body" });
    ctx.sheet.appendChild(body);
    if (!c) { body.appendChild(el("div", { class: "addex-empty", text: "운동 정보를 찾을 수 없어요." })); return; }
    if (this._exercisePreviewAsset(c.id)) body.appendChild(this._buildPreview(ctx, c));   // 자산 있을 때만
    body.appendChild(el("div", { class: "addex-detail-name", text: c.label_ko || cid }));
    body.appendChild(el("div", { class: "addex-detail-meta", text: (c.exerciseType === "cardio" ? "유산소" : "근력") + " · " + this.categoryLabel(c.category) + (c.equipment ? " · " + this._equipLabel(c.equipment) : "") }));
    const parts = this._catalogPartsText(c);
    if (parts) body.appendChild(el("div", { class: "addex-detail-parts" }, [el("span", { class: "addex-detail-label", text: "주요 부위" }), el("span", { text: parts })]));
    if (c.notes) body.appendChild(el("div", { class: "addex-detail-notes", text: c.notes }));
    const inGuide = this.catalogInGuide(ctx.tid, c.id);
    if (inGuide) { body.appendChild(el("div", { class: "addex-added-lg", text: "이미 추가된 운동" })); return; }
    const btn = el("button", { class: "btn btn-primary addex-detail-add", type: "button" }, "이 운동 추가");
    btn.addEventListener("click", async () => {
      const res = await this.addCatalogExerciseToGuide(ctx.tid, c.id);
      if (res.ok) { if (this.view === "guide") this.renderGuide(); ctx.go(back); this._addToast(ctx, res.ex.name + " 추가됨"); }
      else if (res.dup) this._addToast(ctx, "이미 추가된 운동이에요");
    });
    body.appendChild(btn);
  },
  _addCreate(ctx, presetName) {
    // ── 구조: addex-head(고정) → addex-body(flex:1, 폼 전체 스크롤) ──
    // 직접 만들기는 검색 결과 없이 폼이므로 addex-body(flex:1, overflow:auto)를 그대로 사용.
    // addex-sheet가 overflow:hidden이므로 body가 남은 공간을 채우며 안전하게 스크롤.
    ctx.sheet.appendChild(this._addHeader(ctx, "직접 운동 만들기", "entry"));
    const body = el("div", { class: "addex-body" });
    ctx.sheet.appendChild(body);
    const nameIn = el("input", { type: "text", class: "addex-search", placeholder: "예: 케이블 크런치", value: presetName || "", autocomplete: "off", autocorrect: "off", autocapitalize: "off" });
    body.appendChild(el("div", { class: "addex-field" }, [el("label", { text: "운동 이름" }), nameIn]));
    let type = "strength";
    const tStrength = el("button", { class: "addex-chip on", type: "button" }, "근력");
    const tCardio = el("button", { class: "addex-chip", type: "button" }, "유산소");
    const setType = (t) => { type = t; tStrength.classList.toggle("on", t === "strength"); tCardio.classList.toggle("on", t === "cardio"); };
    tStrength.onclick = () => setType("strength"); tCardio.onclick = () => setType("cardio");
    body.appendChild(el("div", { class: "addex-field" }, [el("label", { text: "운동 유형" }), el("div", { class: "addex-chips" }, [tStrength, tCardio])]));
    const descIn = el("textarea", { class: "addex-textarea", placeholder: "동작 설명 (선택) — 나중에 AI 근육 매핑에 활용돼요", rows: "2" });
    body.appendChild(el("div", { class: "addex-field" }, [el("label", { text: "동작 설명 (선택)" }), descIn]));
    const simWrap = el("div", { class: "addex-sim" });
    body.appendChild(simWrap);
    const renderSim = () => {
      simWrap.textContent = "";
      const q = nameIn.value.trim(); if (q.length < 2) return;
      const close = this.catalogSearch(q, "all", "all").filter((c) => (c.label_ko || "").includes(q) || q.includes(c.label_ko || "") || (c.aliases || []).some((a) => a.includes(q))).slice(0, 3);
      if (!close.length) return;
      simWrap.appendChild(el("div", { class: "addex-sim-title", text: "이미 준비된 운동이 있어요" }));
      close.forEach((c) => simWrap.appendChild(el("div", { class: "addex-item" }, [
        el("div", { class: "addex-item-main" }, [el("div", { class: "addex-item-name", text: c.label_ko }), el("div", { class: "addex-item-sub", text: this.categoryLabel(c.category) })]),
        el("button", { class: "addex-add-btn wide", type: "button", onclick: async () => { const res = await this.addCatalogExerciseToGuide(ctx.tid, c.id); if (res.ok) { this._addToast(ctx, res.ex.name + " 추가됨"); if (this.view === "guide") this.renderGuide(); ctx.close(); } else if (res.dup) { this._addToast(ctx, "이미 추가된 운동이에요"); } } }, "이 운동 선택"),
      ])));
    };
    nameIn.addEventListener("input", renderSim); renderSim();
    const err = el("div", { class: "range-err addex-err", hidden: true });
    body.appendChild(err);
    body.appendChild(el("div", { class: "addex-note", text: "근육 매핑은 입력하지 않아도 돼요. 매핑이 없으면 근육 히트맵 집계에서만 빠지고, 기록은 정상 저장됩니다." }));
    const save = async () => {
      const name = nameIn.value.trim();
      if (!name) { err.textContent = "운동 이름을 입력하세요."; err.hidden = false; return; }
      const desc = descIn.value.trim();
      const exId = "ex-" + Date.now();
      const order = Math.max(0, ...this.guidesOf(ctx.tid).map((g) => g.order)) + 1;
      const cd = window.FitlogDB.SEED.cardioDefault;
      let ex, g;
      if (type === "cardio") {
        ex = { id: exId, name, category: "cardio", unit: "", sideMode: "none", kind: "cardio", warmupEnabled: false, active: true, supportsSpeed: true, supportsIncline: true, cardioCatalogId: null };
        if (desc) ex.description = desc;
        g = { id: "g-" + exId, templateId: ctx.tid, exerciseId: exId, order, kind: "cardio", targetDurationMinutes: cd.durationMinutes, targetSpeedKmh: cd.speedKmh, targetIncline: cd.incline, optional: false, notes: "" };
      } else {
        ex = { id: exId, name, category: "custom", unit: "kg", sideMode: "total", warmupEnabled: false, active: true };
        if (desc) ex.description = desc;
        g = { id: "g-" + exId, templateId: ctx.tid, exerciseId: exId, order, targetWeight: null, targetSets: 3, minReps: 8, maxReps: 12, optional: false, warmupSuggestions: [], notes: "" };
      }
      try {
        await window.FitlogDB.DB.put("exercises", ex);
        await window.FitlogDB.DB.put("routineGuides", g);
        await this.reloadDefs();
      } catch (e) { console.error(e); err.textContent = "저장 중 오류가 발생했어요."; err.hidden = false; return; }
      if (this.view === "guide") this.renderGuide();
      ctx.close();
    };
    body.appendChild(el("button", { class: "btn btn-primary addex-detail-add", type: "button", onclick: save }, "운동 만들기"));
    setTimeout(() => { try { nameIn.focus(); } catch (_) {} }, 60);
  },
  // 편집 화면 읽기 전용 부위 표시(자동 설정). 매핑 없으면 히트맵 제외 안내.
  _partsReadonly(ex) {
    if (ex && ex.kind === "cardio") {
      const parts = this.primaryPartsText(ex);
      return el("div", { class: "gedit-parts" }, [el("span", { class: "gedit-parts-label", text: "운동 부위" }),
        el("span", { class: "gedit-parts-val", text: parts || "유산소 · 근육 히트맵 제외" })]);
    }
    const parts = this.primaryPartsText(ex);
    if (parts) return el("div", { class: "gedit-parts" }, [el("span", { class: "gedit-parts-label", text: "주요 부위" }),
      el("span", { class: "gedit-parts-val", text: parts }), el("span", { class: "gedit-parts-auto", text: "자동 설정" })]);
    return el("div", { class: "gedit-parts none" }, [el("span", { class: "gedit-parts-label", text: "운동 부위" }),
      el("span", { class: "gedit-parts-val", text: "부위 정보 없음 · 근육 히트맵 집계에서 제외됩니다" })]);
  },
  renderGuideRow(g, ex) {
    return el("div", { class: "card" }, [
      el("div", { class: "card-top" }, [
        el("div", { class: "ex-name" }, [document.createTextNode(ex.name), this.isCardio(ex, g) ? el("span", { class: "opt", text: "유산소" }) : null, g.optional ? el("span", { class: "opt", text: "선택" }) : null, ex.warmupEnabled ? el("span", { class: "opt", text: "워밍업" }) : null]),
        el("button", { class: "btn btn-sm", onclick: () => { this.editingGuideId = g.id; this.renderGuide(); } }, "편집"),
      ]),
      el("div", { class: "guide-line", text: this.guideLine(ex, g, false) }),
    ]);
  },
  renderGuideEditor(g, ex, idx, total) {
    if (this.isCardio(ex, g)) return this.renderCardioGuideEditor(g, ex, idx, total);
    const wInput = el("input", { type: "number", inputmode: "decimal", value: g.targetWeight == null ? "" : g.targetWeight, placeholder: "미정" });
    const setsInput = el("input", { type: "number", inputmode: "numeric", value: g.targetSets });
    const minInput = el("input", { type: "number", inputmode: "numeric", value: g.minReps });
    const maxInput = el("input", { type: "number", inputmode: "numeric", value: g.maxReps });
    const notesInput = el("input", { type: "text", value: g.notes || "", placeholder: "메모" });
    const optChk = el("input", { type: "checkbox", ...(g.optional ? { checked: "checked" } : {}) });
    const warmChk = el("input", { type: "checkbox", ...(ex.warmupEnabled ? { checked: "checked" } : {}) });

    const field = (label, node) => el("div", { class: "gedit-field" }, [el("label", { text: label }), node]);
    const toggle = (label, chk) => el("label", { class: "gedit-toggle" }, [chk, el("span", { text: label })]);

    const save = async () => {
      g.targetWeight = wInput.value === "" ? null : Number(wInput.value);
      g.targetSets = Number(setsInput.value) || g.targetSets;
      g.minReps = Number(minInput.value); g.maxReps = Number(maxInput.value);
      if (g.minReps > g.maxReps) { const t = g.minReps; g.minReps = g.maxReps; g.maxReps = t; }
      g.optional = optChk.checked; g.notes = notesInput.value;
      const warmChanged = warmChk.checked !== ex.warmupEnabled; ex.warmupEnabled = warmChk.checked;
      const DB = window.FitlogDB.DB;
      try {
        await DB.put("routineGuides", g);
        if (warmChanged) await DB.put("exercises", ex);
        await this.reloadDefs();
      } catch (e) { console.error("[Fitlog] 가이드 저장 실패", e); }
      this.editingGuideId = null; this.renderGuide();
    };
    const promote = async () => { try { const w = await window.FitlogDB.DB.lastUsedWeight(g.exerciseId); if (w != null) wInput.value = w; } catch (_) {} };
    const move = async (dir) => {
      const list = this.guidesOf(this.guideEditTemplateId);
      const j = idx + dir; if (j < 0 || j >= list.length) return;
      const other = list[j]; const a = g.order; g.order = other.order; other.order = a;
      try { await window.FitlogDB.DB.put("routineGuides", g); await window.FitlogDB.DB.put("routineGuides", other); await this.reloadDefs(); } catch (e) { console.error(e); }
      this.renderGuide();
    };
    const del = async () => {
      if (!window.confirm(`'${ex.name}'을(를) 이 템플릿에서 제거할까요? (기존 기록은 그대로 남아요)`)) return;
      try { await window.FitlogDB.DB.delete("routineGuides", g.id); await this.reloadDefs(); } catch (e) { console.error(e); }
      this.editingGuideId = null; this.renderGuide();
    };

    return el("div", { class: "card gedit" }, [
      el("div", { class: "card-top" }, [el("div", { class: "ex-name", text: ex.name }),
        el("div", { class: "order-btns" }, [
          el("button", { class: "btn btn-sm", onclick: () => move(-1), ...(idx === 0 ? { disabled: "disabled" } : {}) }, "▲"),
          el("button", { class: "btn btn-sm", onclick: () => move(1), ...(idx === total - 1 ? { disabled: "disabled" } : {}) }, "▼"),
        ])]),
      el("div", { class: "gedit-grid" }, [
        field("중량", el("div", { class: "with-btn" }, [wInput, el("button", { class: "btn btn-sm btn-ghost", onclick: promote }, "지난값")])),
        field("목표 세트", setsInput), field("최소 반복", minInput), field("최대 반복", maxInput),
      ]),
      el("div", { class: "gedit-toggles" }, [toggle("선택 운동", optChk), toggle("워밍업 사용", warmChk)]),
      field("메모", notesInput),
      this._partsReadonly(ex),
      el("div", { class: "gedit-actions" }, [
        el("button", { class: "btn btn-primary", onclick: save }, "저장"),
        el("button", { class: "btn btn-ghost", onclick: () => { this.editingGuideId = null; this.renderGuide(); } }, "취소"),
        el("button", { class: "btn btn-ghost danger-btn", onclick: del }, "제거"),
      ]),
    ]);
  },
  // 기존/사용자 운동의 근육 매핑을 지정·수정(사용자 지정이 카탈로그보다 우선). 기록 자체는 변경하지 않음. (섹션 12)
  async openMuscleMapModal(ex) {
    const C = (window.FitlogCatalog && window.FitlogCatalog.CATALOG.exercises) || [];
    const M = (window.FitlogCatalog && window.FitlogCatalog.MUSCLE_MAP.mappings) || [];
    const catStrength = C.filter((e) => e.exerciseType === "strength");
    const regions = (window.FitlogCatalog && window.FitlogCatalog.REGIONS_META.regions) || [];
    let existing = {};
    try { const all = await window.FitlogDB.DB.userMuscleMapAll(); if (all[ex.id]) existing = all[ex.id]; } catch (_) {}
    const em = existing.mapping || {};

    const overlay = el("div", { class: "modal-overlay" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const err = el("div", { class: "range-err", hidden: true });

    const modeCatalog = el("input", { type: "radio", name: "mm", ...(existing.source === "similar" ? { checked: "checked" } : {}) });
    const modeDirect = el("input", { type: "radio", name: "mm", ...(existing.source !== "similar" ? { checked: "checked" } : {}) });
    const catSel = el("select", { class: "range-date" },
      [el("option", { value: "", text: "선택 안 함" })].concat(catStrength.map((e) => el("option", { value: e.id, ...(existing.catalogRef === e.id ? { selected: "selected" } : {}) }, e.label_ko || e.id))));
    const catBox = el("div", { class: "range-cell" }, [el("label", { text: "비슷한 카탈로그 운동의 매핑 재사용" }), catSel]);

    const primary = new Set(Object.keys(em.primary || {})), secondary = new Set(Object.keys(em.secondary || {}));
    const chipWrap = el("div", { class: "region-chips" });
    const repaint = () => chipWrap.querySelectorAll(".rchip").forEach((c) => {
      c.classList.toggle("is-primary", primary.has(c.dataset.rid));
      c.classList.toggle("is-secondary", secondary.has(c.dataset.rid));
    });
    regions.forEach((r) => {
      const chip = el("button", { type: "button", class: "rchip", "data-rid": r.id, text: r.label_ko || r.id });
      chip.addEventListener("click", () => {
        const id = r.id;
        if (primary.has(id)) { primary.delete(id); secondary.add(id); }
        else if (secondary.has(id)) { secondary.delete(id); }
        else { primary.add(id); }
        repaint();
      });
      chipWrap.appendChild(chip);
    });
    repaint();
    const directBox = el("div", { class: "range-cell" }, [
      el("label", { text: "부위 직접 선택 (탭: 주요 → 보조 → 해제)" }),
      el("div", { class: "region-legend", text: "🟩 주요 부위 · 🟧 보조 부위" }), chipWrap,
    ]);
    const syncMode = () => { catBox.hidden = !modeCatalog.checked; directBox.hidden = !modeDirect.checked; };
    modeCatalog.addEventListener("change", syncMode); modeDirect.addEventListener("change", syncMode);

    const save = async () => {
      let entry;
      if (modeCatalog.checked) {
        const cm = M.find((m) => m.exerciseId === catSel.value);
        if (!cm) { err.textContent = "카탈로그 운동을 선택하세요."; err.hidden = false; return; }
        entry = { catalogRef: catSel.value, source: "similar", mapping: { primary: { ...cm.primary }, secondary: { ...cm.secondary }, minor: { ...cm.minor } } };
      } else {
        if (!primary.size) { err.textContent = "주요 부위를 최소 1개 선택하세요."; err.hidden = false; return; }
        const toObj = (set, w) => { const o = {}; set.forEach((id) => (o[id] = w)); return o; };
        entry = { catalogRef: null, source: "direct", mapping: { primary: toObj(primary, 1), secondary: toObj(secondary, 0.5), minor: {} } };
      }
      try { await window.FitlogDB.DB.setUserMuscleMap(ex.id, entry); } catch (e) { console.error(e); }
      close(); if (this.view === "guide") this.renderGuide();
    };
    const clear = async () => {
      try { await window.FitlogDB.DB.deleteUserMuscleMap(ex.id); } catch (e) { console.error(e); }
      close(); if (this.view === "guide") this.renderGuide();
    };

    const sheet = el("div", { class: "modal-sheet fitlog-anatomy" }, [
      el("div", { class: "modal-title", text: `근육 매핑 · ${ex.name}` }),
      el("div", { class: "newex-hint", text: "사용자 지정 매핑은 카탈로그 기본 매핑보다 우선하며, 기존 기록의 히트맵도 이 매핑으로 다시 계산됩니다. 운동 기록 자체는 바뀌지 않습니다." }),
      el("div", { class: "newex-modes" }, [
        el("label", { class: "gedit-toggle" }, [modeCatalog, el("span", { text: "카탈로그 재사용" })]),
        el("label", { class: "gedit-toggle" }, [modeDirect, el("span", { text: "부위 직접 선택" })]),
      ]),
      catBox, directBox, err,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn btn-ghost", type: "button", onclick: close }, "취소"),
        el("button", { class: "btn btn-primary", type: "button", onclick: save }, "매핑 저장"),
      ]),
      existing.mapping ? el("button", { class: "modal-close", type: "button", onclick: clear }, "사용자 매핑 해제 (카탈로그 기본값으로)") : null,
    ]);
    syncMode();
    overlay.appendChild(sheet); document.body.appendChild(overlay);
  },
  renderCardioGuideEditor(g, ex, idx, total) {
    const draft = { targetDurationMinutes: g.targetDurationMinutes != null ? g.targetDurationMinutes : 30, targetSpeedKmh: g.targetSpeedKmh != null ? g.targetSpeedKmh : 4.8, targetIncline: g.targetIncline != null ? g.targetIncline : 12 };
    const notesInput = el("input", { type: "text", value: g.notes || "", placeholder: "메모" });
    const optChk = el("input", { type: "checkbox", ...(g.optional ? { checked: "checked" } : {}) });
    const field = (label, node) => el("div", { class: "gedit-field" }, [el("label", { text: label }), node]);
    const move = async (dir) => {
      const list = this.guidesOf(this.guideEditTemplateId);
      const j = idx + dir; if (j < 0 || j >= list.length) return;
      const other = list[j]; const a = g.order; g.order = other.order; other.order = a;
      try { await window.FitlogDB.DB.put("routineGuides", g); await window.FitlogDB.DB.put("routineGuides", other); await this.reloadDefs(); } catch (e) { console.error(e); }
      this.renderGuide();
    };
    const save = async () => {
      g.targetDurationMinutes = Number(draft.targetDurationMinutes) || 0;
      g.targetSpeedKmh = Number(draft.targetSpeedKmh) || 0;
      g.targetIncline = Number(draft.targetIncline) || 0;
      g.optional = optChk.checked; g.notes = notesInput.value; g.kind = "cardio";
      try { await window.FitlogDB.DB.put("routineGuides", g); await this.reloadDefs(); } catch (e) { console.error("[Fitlog] 유산소 가이드 저장 실패", e); }
      this.editingGuideId = null; this.renderGuide();
    };
    const del = async () => {
      if (!window.confirm(`'${ex.name}'을(를) 이 템플릿에서 제거할까요? (기존 기록은 그대로 남아요)`)) return;
      try { await window.FitlogDB.DB.delete("routineGuides", g.id); await this.reloadDefs(); } catch (e) { console.error(e); }
      this.editingGuideId = null; this.renderGuide();
    };
    return el("div", { class: "card gedit" }, [
      el("div", { class: "card-top" }, [
        el("div", { class: "ex-name" }, [document.createTextNode(ex.name), el("span", { class: "opt", text: "유산소" })]),
        el("div", { class: "order-btns" }, [
          el("button", { class: "btn btn-sm", onclick: () => move(-1), ...(idx === 0 ? { disabled: "disabled" } : {}) }, "▲"),
          el("button", { class: "btn btn-sm", onclick: () => move(1), ...(idx === total - 1 ? { disabled: "disabled" } : {}) }, "▼"),
        ])]),
      (() => {
        const spec = this.cardioFieldSpec(ex);
        const cells = [el("div", { class: "cardio-field" }, [el("label", { text: "목표 시간 (분)" }), this.dial(draft, "targetDurationMinutes", { step: 1, min: 0, unit: "" })])];
        if (spec.speed) cells.push(el("div", { class: "cardio-field" }, [el("label", { text: "목표 속도 (km/h)" }), this.dial(draft, "targetSpeedKmh", { step: 0.1, min: 0, unit: "" })]));
        if (spec.incline) cells.push(el("div", { class: "cardio-field" }, [el("label", { text: "목표 경사" }), this.dial(draft, "targetIncline", { step: 1, min: 0, unit: "" })]));
        return el("div", { class: "cardio-grid", style: `margin:12px 0;grid-template-columns:repeat(${cells.length},1fr)` }, cells);
      })(),
      el("div", { class: "gedit-toggles" }, [el("label", { class: "gedit-toggle" }, [optChk, el("span", { text: "선택 운동" })])]),
      field("메모", notesInput),
      el("div", { class: "gedit-actions" }, [
        el("button", { class: "btn btn-primary", onclick: save }, "저장"),
        el("button", { class: "btn btn-ghost", onclick: () => { this.editingGuideId = null; this.renderGuide(); } }, "취소"),
        el("button", { class: "btn btn-ghost danger-btn", onclick: del }, "제거"),
      ]),
    ]);
  },
  renderDayMap() {
    const map = this.settings.dayTemplateMap;
    const box = el("div", { class: "settings-group" });
    WD_KEYS.forEach((k) => {
      const sel = el("select", { onchange: (e) => { map[k] = e.target.value || null; this.persistSettings(); } }, [
        el("option", { value: "", ...(map[k] ? {} : { selected: "selected" }) }, "없음"),
        ...this.templates.map((t) => el("option", { value: t.id, ...(map[k] === t.id ? { selected: "selected" } : {}) }, t.name)),
      ]);
      box.appendChild(el("div", { class: "settings-row" }, [el("div", { class: "k", text: WEEKDAY_KO[k] + "요일" }), el("div", { class: "select-wrap" }, [sel])]));
    });
    return box;
  },

  // ---------------- 설정 ----------------
  renderSettings() {
    const root = document.getElementById("view-settings"); root.textContent = "";
    root.appendChild(el("div", { class: "section-label", text: "타이머" }));
    root.appendChild(el("div", { class: "settings-group" }, [this.settingRow("세트 사이 휴식", "초", "setRestSeconds"), this.settingRow("운동 사이 휴식", "초", "exerciseRestSeconds")]));
    root.appendChild(el("div", { class: "section-label", text: "알림" }));
    root.appendChild(el("div", { class: "settings-group" }, [el("div", { class: "settings-row" }, [el("div", {}, [el("div", { class: "k", text: "알림 사운드 테스트" }), el("div", { class: "sub", text: "운동 전 한 번 눌러 소리를 켜두세요" })]), el("button", { class: "btn btn-sm", onclick: () => window.FitlogTimer.testSound() }, "🎧 테스트")])]));
    root.appendChild(el("div", { class: "section-label", text: "데이터" }));
    const fileInput = el("input", { type: "file", accept: "application/json,.json", style: "display:none",
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        if (!window.confirm("복원하면 현재 기기의 데이터가 백업 파일 내용으로 완전히 교체됩니다. 계속할까요?")) { e.target.value = ""; return; }
        const r = await window.FitlogBackup.importAll(f); e.target.value = "";
        if (r.ok) { window.alert("복원 완료. 앱을 다시 불러옵니다."); location.reload(); }
        else window.alert("복원 실패: " + r.reason);
      } });
    root.appendChild(el("div", { class: "settings-group" }, [
      el("div", { class: "settings-row" }, [el("div", { class: "k", text: "운동기록 백업" }), el("button", { class: "btn btn-sm", onclick: () => window.FitlogBackup.exportAll() }, "JSON 내보내기")]),
      el("div", { class: "settings-row" }, [el("div", { class: "k", text: "백업 복원" }), el("button", { class: "btn btn-sm", onclick: () => fileInput.click() }, "파일 선택")]),
      fileInput,
      el("div", { class: "settings-row" }, [el("div", { class: "k", text: "전체 데이터 초기화" }), el("button", { class: "btn btn-sm danger-btn", onclick: () => this.wipeAll() }, "초기화")]),
    ]));
    root.appendChild(el("div", { class: "placeholder", text: this.dbReady ? "기록은 이 기기에만 저장됩니다. 기기를 바꾸거나 백업이 필요하면 JSON으로 내보내 두세요." : "이 브라우저에서 저장을 쓸 수 없어 임시로만 동작합니다." }));
    root.appendChild(el("div", { class: "section-label", text: "개발자 · 시험 기능" }));
    root.appendChild(el("div", { class: "settings-group" }, [el("div", { class: "settings-row" }, [
      el("div", {}, [el("div", { class: "k", text: "3D 시제품 시험" }), el("div", { class: "sub", text: "대표 4종 · 품질 검증 전 기술 시제품" })]),
      el("button", { class: "btn btn-sm", onclick: () => this.openProto3DLab() }, "열기"),
    ])]));
    // 버전 정보
    const verRow = el("div", { class: "settings-group", style: "margin-top:12px" }, [
      el("div", { class: "settings-row" }, [el("div", { class: "k", text: "앱 버전" }), el("div", { class: "sub", text: APP_VERSION + (window.FitlogVP ? " · 화면 " + window.FitlogVP.first + "→" + window.innerHeight + "/" + window.FitlogVP.screen + " · 보정 " + window.FitlogVP.nudges : "") })]),
    ]);
    const swRow = el("div", { class: "settings-row" }, [el("div", { class: "k", text: "캐시 버전" }), el("div", { class: "sub", id: "sw-cache-ver", text: "확인 중…" })]);
    verRow.firstChild.after(swRow);
    root.appendChild(verRow);
    if ("caches" in window) {
      caches.keys().then((keys) => {
        const sw = keys.find((k) => k.startsWith("fitlog-")) || "(없음)";
        const el2 = document.getElementById("sw-cache-ver"); if (el2) el2.textContent = sw;
      }).catch(() => { const el2 = document.getElementById("sw-cache-ver"); if (el2) el2.textContent = "(조회 실패)"; });
    } else { const el2 = document.getElementById("sw-cache-ver"); if (el2) el2.textContent = "(지원 안 됨)"; }
  },
  settingRow(k, unit, key) {
    const input = el("input", { type: "number", inputmode: "numeric", value: this.settings[key], onchange: (e) => { this.settings[key] = Number(e.target.value) || this.settings[key]; this.persistSettings(); } });
    return el("div", { class: "settings-row" }, [el("div", { class: "k", text: k }), el("div", { class: "inline-input" }, [input, el("span", { class: "sub", text: unit })])]);
  },
  persistSettings() { if (this.dbReady) window.FitlogDB.DB.put("settings", this.settings).catch(() => {}); },
  disabledRow(k) { return el("div", { class: "settings-row" }, [el("div", { class: "k", text: k }), el("button", { class: "btn btn-sm", disabled: "disabled" }, "준비 중")]); },
  async wipeAll() {
    if (!this.dbReady) return;
    if (!window.confirm("모든 운동기록과 가이드가 삭제됩니다. 계속할까요?")) return;
    if (!window.confirm("정말 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
    try { await window.FitlogDB.DB.clearAll(); location.reload(); } catch (e) { console.error(e); }
  },

  // ---------------- AI 코치 (Phase 4) ----------------
  // 지정 기간 내 세션을 세트별 원본 그대로 담아 프롬프트용 컨텍스트를 만든다(요약·통합 안 함).
  async gatherAIContext(range) {
    const all = await window.FitlogDB.DB.recentSessions();      // date desc
    const inRange = all.filter((s) => this.inRange(s.date, range));
    const progSet = {};
    const sessions = inRange.map((s) => {
      const tpl = this.template(s.templateId);
      const exercises = (s.exerciseResults || []).map((r) => {
        const ex = this.exercise(r.exerciseId);
        const name = (ex && ex.name) || r.exerciseName || r.exerciseId;
        if (r.status === "progression_candidate") progSet[r.exerciseId] = { name, direction: ex && ex.sideMode === "assist" ? "decrease_assist" : "increase" };
        const gs = r.guideSnapshot || {};
        if (r.kind === "cardio") {
          return { name, kind: "cardio", status: r.status, notes: r.notes || "",
            guideText: `${gs.targetDurationMinutes != null ? gs.targetDurationMinutes : "-"}분 / ${gs.targetSpeedKmh != null ? gs.targetSpeedKmh : "-"}km/h / 경사 ${gs.targetIncline != null ? gs.targetIncline : "-"}`,
            actualText: r.cardioActual ? `${r.cardioActual.durationMinutes}분 / ${r.cardioActual.speedKmh}km/h / 경사 ${r.cardioActual.incline}` : "미기록" };
        }
        const work = (r.sets || []).filter((x) => x.setType === "work");
        const warm = (r.sets || []).filter((x) => x.setType === "warmup");
        return { name, kind: "strength", status: r.status, notes: r.notes || "",
          guideText: `${gs.targetWeight == null ? "미정" : gs.targetWeight + "kg"} / ${gs.minReps}~${gs.maxReps}회 / ${gs.targetSets}세트`,
          targetSets: gs.targetSets,
          workSets: work.map((w) => ({ weight: w.weight, reps: w.reps })),
          warmSets: warm.map((w) => ({ weight: w.weight, reps: w.reps })),
          actualSetCount: work.length };
      });
      return { date: s.date, weekday: s.weekday, templateName: tpl ? tpl.name : s.templateId, cardio: s.cardio || null, exercises };
    });
    return {
      range, sessionCount: inRange.length,
      templates: this.templates, exercises: this.exercises, guides: this.guides, dayMap: this.settings.dayTemplateMap,
      sessions, progressions: Object.values(progSet),
      constraints: ["주 3회 (화·목·토 기본), 회당 약 90분", "유산소: 트레드밀 경사 걷기 30분", "데드리프트 계열 제외", "어시스트 종목은 보조중량을 낮출수록 어려워짐", "운동 경력 초반 단계, 과도한 증량 지양"],
    };
  },
  renderAI() {
    const root = document.getElementById("view-ai"); root.textContent = "";
    root.appendChild(el("div", { class: "section-label", text: "AI 코치" }));
    if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 사용할 수 없어요." })); return; }
    this.aiState = this.aiState || { prompt: "", input: "" }; // 탭 이동에도 유지(세션 한정)
    if (!this.aiRange) this.aiRange = { ...this.historyRange };  // 첫 진입 시 기록 탭 기간을 기본값으로

    // 1. 내보내기 — 생성했던 프롬프트가 있으면 복원
    const hasPrompt = !!this.aiState.prompt;
    const promptArea = el("textarea", { class: "ai-textarea", id: "ai-prompt", readonly: "readonly", rows: "8", hidden: !hasPrompt });
    promptArea.value = this.aiState.prompt || "";
    const rangeUI = this.rangeControls(this.aiRange, {
      onApply: (r) => { this.aiRange = r; this.renderAI(); },
      onReset: () => { this.aiRange = this.defaultRange(); this.renderAI(); },
      extraButtons: [el("button", { class: "btn btn-sm btn-ghost", onclick: () => { this.aiRange = { ...this.historyRange }; this.renderAI(); } }, "기록 탭 기간 가져오기")],
    });
    const exportCard = el("div", { class: "card" }, [
      el("h3", { class: "ai-h", text: "1. 분석용 프롬프트 만들기" }),
      el("div", { class: "muted", text: "선택한 기간의 실제 기록을 세트별로 담아 AI가 읽을 문장으로 만들어요. (기록 탭 기간과 독립적으로 조절 가능)" }),
      rangeUI,
      el("button", { class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "생성 중…";
        try { const ctx = await this.gatherAIContext(this.aiRange); this.aiState.prompt = window.FitlogAI.buildPrompt(ctx); promptArea.value = this.aiState.prompt; promptArea.hidden = false; document.getElementById("ai-copy").hidden = false; }
        finally { e.target.disabled = false; e.target.textContent = hasPrompt ? "프롬프트 다시 생성" : "프롬프트 생성"; }
      } }, hasPrompt ? "프롬프트 다시 생성" : "프롬프트 생성"),
      promptArea,
      el("button", { class: "btn btn-block", id: "ai-copy", style: "margin-top:8px", hidden: !hasPrompt, onclick: async () => {
        try { await navigator.clipboard.writeText(promptArea.value); window.alert("복사됐어요."); } catch (_) { promptArea.select && promptArea.select(); window.alert("길게 눌러 복사하세요."); }
      } }, "복사"),
    ]);
    root.appendChild(exportCard);

    // 2. 가져오기 — 붙여넣던 JSON 유지
    const inputArea = el("textarea", { class: "ai-textarea", id: "ai-input", rows: "6", placeholder: '{ "format": "fitlog-guide-update", ... }',
      oninput: (e) => { this.aiState.input = e.target.value; } });
    inputArea.value = this.aiState.input || "";
    const diffBox = el("div", { id: "ai-diff" });
    root.appendChild(el("div", { class: "card" }, [
      el("h3", { class: "ai-h", text: "2. AI 결과 붙여넣기" }),
      el("div", { class: "muted", text: "AI가 준 JSON을 그대로 붙여넣고 검증하세요. 변경안을 확인한 뒤 골라서 적용합니다." }),
      inputArea,
      el("button", { class: "btn btn-block", style: "margin-top:8px", onclick: () => { this.aiState.input = inputArea.value; this.validateAI(inputArea.value, diffBox); } }, "검증"),
      diffBox,
    ]));

    // 3. 특정일 교정 — 그날 운동+메모로 점검 프롬프트
    const corrArea = el("textarea", { class: "ai-textarea", id: "ai-corr", readonly: "readonly", rows: "8", hidden: true });
    const daySel = el("select", { id: "ai-day" }, [el("option", { value: "", selected: "selected" }, "날짜 불러오는 중…")]);
    const corrCard = el("div", { class: "card" }, [
      el("h3", { class: "ai-h", text: "3. 특정일 교정받기" }),
      el("div", { class: "muted", text: "특정 날짜 운동 하나를 골라 그날 기록·메모를 담은 점검용 프롬프트를 만듭니다. 통증·자세·중량 조정 등을 상담할 때 쓰세요." }),
      el("div", { class: "select-wrap", style: "margin-top:10px" }, [daySel]),
      el("button", { class: "btn btn-primary btn-block", style: "margin-top:8px", onclick: async () => {
        const sid = daySel.value; if (!sid) { window.alert("날짜를 선택하세요."); return; }
        const sess = await window.FitlogDB.DB.get("workoutSessions", sid);
        if (!sess) return;
        const text = window.FitlogAI.buildCorrectionPrompt(sess, { templates: this.templates, exercises: this.exercises, guides: this.guides });
        corrArea.value = text; corrArea.hidden = false; document.getElementById("ai-corr-copy").hidden = false;
      } }, "교정 프롬프트 생성"),
      corrArea,
      el("button", { class: "btn btn-block", id: "ai-corr-copy", style: "margin-top:8px", hidden: true, onclick: async () => {
        try { await navigator.clipboard.writeText(corrArea.value); window.alert("복사됐어요."); } catch (_) { corrArea.select && corrArea.select(); window.alert("길게 눌러 복사하세요."); }
      } }, "복사"),
    ]);
    root.appendChild(corrCard);
    // 날짜 목록 채우기
    window.FitlogDB.DB.recentSessions(30).then((sessions) => {
      daySel.textContent = "";
      daySel.appendChild(el("option", { value: "" }, sessions.length ? "날짜 선택…" : "저장된 운동 없음"));
      sessions.forEach((s) => { const tpl = this.template(s.templateId); daySel.appendChild(el("option", { value: s.id }, `${s.date} (${WEEKDAY_KO[s.weekday] || ""}) · ${tpl ? tpl.name : ""}`)); });
    }).catch(() => {});
  },
  // 붙여넣은 텍스트(설명+JSON 섞여도)에서 fitlog-guide-update JSON만 추출
  extractGuideJson(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    // 1) 통째로 JSON인 경우
    try { const o = JSON.parse(text); if (o && o.format === "fitlog-guide-update") return o; } catch (_) {}
    // 2) ```json … ``` 또는 ``` … ``` 코드블록들 시도
    const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
    for (const f of fences) { try { const o = JSON.parse(f.trim()); if (o && o.format === "fitlog-guide-update") return o; } catch (_) {} }
    // 3) format 키워드 근처의 중괄호 균형 파싱
    const idx = text.indexOf("fitlog-guide-update");
    if (idx !== -1) {
      let start = text.lastIndexOf("{", idx);
      while (start !== -1) {
        let depth = 0;
        for (let i = start; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") { depth--; if (depth === 0) { try { const o = JSON.parse(text.slice(start, i + 1)); if (o && o.format === "fitlog-guide-update") return o; } catch (_) {} break; } }
        }
        start = text.lastIndexOf("{", start - 1);
      }
    }
    return null;
  },
  validateAI(raw, diffBox) {
    diffBox.textContent = "";
    const obj = this.extractGuideJson(raw || "");
    if (!obj) {
      diffBox.appendChild(el("div", { class: "ai-err", text: "가이드 적용 JSON을 찾지 못했어요. AI 답변 중 ```json … ``` 부분(또는 fitlog-guide-update JSON)을 그대로 붙여넣었는지 확인하세요." })); return;
    }
    const ids = new Set(this.guides.map((g) => g.id));
    const v = window.FitlogAI.validate(obj, ids);
    if (!v.ok) { diffBox.appendChild(el("div", { class: "ai-err", text: "검증 실패: " + v.reason })); return; }

    this._pendingChanges = obj.changes;
    if (obj.summary) diffBox.appendChild(el("div", { class: "ai-summary", text: obj.summary }));

    obj.changes.forEach((c, i) => {
      const g = this.guides.find((x) => x.id === c.guideId);
      const ex = g && this.exercise(g.exerciseId);
      const title = ex ? ex.name : (c.guideId || "(새 운동)");
      const chk = el("input", { type: "checkbox", class: "ai-change-chk", checked: "checked", "data-i": i });
      const rows = [];
      if (c.action === "update" && g) {
        const after = window.FitlogAI.sanitizeAfter(c.after);
        const cmp = (label, cur, nxt, unit) => { if (nxt != null && nxt !== cur) rows.push(`${label} ${cur == null ? "미정" : cur}${unit} → ${nxt}${unit}`); };
        cmp("중량", g.targetWeight, after.targetWeight, "kg");
        cmp("세트", g.targetSets, after.targetSets, "");
        cmp("최소", g.minReps, after.minReps, "");
        cmp("최대", g.maxReps, after.maxReps, "");
      } else if (c.action === "remove") rows.push("이 운동을 가이드에서 제거");
      else if (c.action === "reorder") rows.push("순서 변경");
      else if (c.action === "add") rows.push("운동 추가");

      diffBox.appendChild(el("label", { class: "ai-change" }, [
        chk,
        el("div", { class: "ai-change-body" }, [
          el("div", { class: "ai-change-title" }, [document.createTextNode(title), el("span", { class: "ai-action", text: c.action })]),
          el("div", { class: "ai-change-diff", text: rows.length ? rows.join(" · ") : "변경 없음" }),
          c.reason ? el("div", { class: "ai-reason", text: c.reason }) : null,
        ]),
      ]));
    });
    diffBox.appendChild(el("button", { class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: () => this.applySelectedAI(diffBox) }, "선택 적용"));
    diffBox.appendChild(el("div", { class: "muted", style: "margin-top:6px", text: "적용해도 기존 운동 기록은 바뀌지 않아요. 이전 가이드는 이력에 저장됩니다." }));
  },
  async applySelectedAI(diffBox) {
    const boxes = [...diffBox.querySelectorAll(".ai-change-chk")];
    const selected = (this._pendingChanges || []).filter((c, i) => boxes[i] && boxes[i].checked);
    if (!selected.length) { window.alert("적용할 항목을 선택하세요."); return; }
    let n = 0;
    try { n = await this.applyChanges(selected); } catch (e) { console.error("[Fitlog] AI 적용 실패", e); }
    diffBox.textContent = "";
    diffBox.appendChild(el("div", { class: "ai-summary", text: `${n}건 적용됐어요. 가이드 탭에서 확인하세요.` }));
    diffBox.appendChild(el("button", { class: "btn btn-block", style: "margin-top:8px", onclick: () => this.show("guide") }, "가이드 보기"));
  },
  async applyChanges(changes) {
    const DB = window.FitlogDB.DB; let n = 0;
    for (const c of changes) {
      const g = this.guides.find((x) => x.id === c.guideId);
      if (c.action === "update" && g) {
        const before = { targetWeight: g.targetWeight, targetSets: g.targetSets, minReps: g.minReps, maxReps: g.maxReps, optional: g.optional, notes: g.notes };
        Object.assign(g, window.FitlogAI.sanitizeAfter(c.after));
        if (g.minReps > g.maxReps) { const t = g.minReps; g.minReps = g.maxReps; g.maxReps = t; }
        await DB.put("routineGuides", g);
        await DB.put("guideHistory", { id: "gh-" + Date.now() + "-" + n, changedAt: new Date().toISOString(), source: "ai-import", before, after: { targetWeight: g.targetWeight, targetSets: g.targetSets, minReps: g.minReps, maxReps: g.maxReps, optional: g.optional, notes: g.notes }, notes: c.reason || "" });
        n++;
      } else if (c.action === "remove" && g) {
        await DB.put("guideHistory", { id: "gh-" + Date.now() + "-" + n, changedAt: new Date().toISOString(), source: "ai-import", before: { ...g }, after: null, notes: c.reason || "제거" });
        await DB.delete("routineGuides", g.id); n++;
      } else if (c.action === "reorder" && g && c.after && c.after.order != null) {
        g.order = Number(c.after.order); await DB.put("routineGuides", g); n++;
      }
      // add: 안전상 이번 버전에선 건너뜀(운동/템플릿 신규 생성은 가이드 화면에서 직접)
    }
    await this.reloadDefs();
    return n;
  },

  renderPlaceholder(view) {
    const map = { ai: ["AI 코치", "프롬프트 생성/제안 반영은 Phase 4에서 연결됩니다."] };
    const root = document.getElementById(`view-${view}`); if (!root) return; root.textContent = "";
    const [title, sub] = map[view] || [view, ""];
    root.appendChild(el("div", { class: "section-label", text: title })); root.appendChild(el("div", { class: "placeholder", text: sub }));
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
window.FitlogApp = App;
