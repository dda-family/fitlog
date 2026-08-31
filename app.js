/* app.js — Phase 2 (IndexedDB 저장 연결)
 * 오늘 화면 + 운동 카드 + 세트 입력 + 타이머 + 워밍업 + 유산소 + 즉석 운동 + 기록 조회 + 설정.
 * 정의(템플릿/운동/가이드)와 설정은 DB에서 로드(최초 실행 시 SEED로 시드). 세션은 DB에 저장.
 * 의존: FitlogDB, FitlogEval, FitlogTimer
 */

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
      this.settings = (await FDB.DB.get("settings", "app-settings")) || this.defaultSettings();
      this.dbReady = true;
    } catch (e) {
      console.warn("[Fitlog] IndexedDB 사용 불가 → SEED 폴백", e);
      this.templates = [...FDB.SEED.templates].sort((a, b) => a.order - b.order);
      this.exercises = FDB.SEED.exercises; this.guides = FDB.SEED.guides;
      this.settings = this.defaultSettings(); this.dbReady = false;
    }
    const todayKey = WD_KEYS[new Date().getDay()];
    const suggested = this.settings.dayTemplateMap[todayKey] || this.templates[0].id;
    this.startSession(suggested);
    await this.loadLastResults(suggested);
    this.show("today");
  },
  defaultSettings() {
    return { id: "app-settings", setRestSeconds: 90, exerciseRestSeconds: 180, soundEnabled: true, dayTemplateMap: window.FitlogDB.SEED.dayTemplateMap, schemaVersion: 1 };
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
    this.guidesOf(templateId).forEach((g) => { results[g.exerciseId] = this.newRes(); });
    const c = window.FitlogDB.SEED.cardioDefault;
    this.session = { templateId, results, extras: [], cardio: { type: c.type, incline: c.incline, speedKmh: c.speedKmh, durationMinutes: c.durationMinutes, done: false } };
    this.ended = false;
  },
  newRes() { return { workSets: [], warmupSets: [], skipped: false, showExtra: false, notes: "" }; },

  async loadLastResults(templateId) {
    this.lastMap = {};
    if (!this.dbReady) return;
    try {
      const sessions = await window.FitlogDB.DB.recentSessions();
      for (const g of this.guidesOf(templateId)) {
        for (const s of sessions) {
          const r = (s.exerciseResults || []).find((x) => x.exerciseId === g.exerciseId);
          if (r) { const work = (r.sets || []).filter((x) => x.setType === "work"); if (work.length) { this.lastMap[g.exerciseId] = { weight: work[0].weight, reps: work.map((w) => w.reps), date: s.date }; break; } }
        }
      }
    } catch (e) { console.warn(e); }
  },

  template(id) { return (this.templates || []).find((t) => t.id === id); },
  exercise(id) { return (this.exercises || []).find((e) => e.id === id); },
  guidesOf(templateId) { return (this.guides || []).filter((g) => g.templateId === templateId).sort((a, b) => a.order - b.order); },
  items() {
    const seeded = this.guidesOf(this.session.templateId).map((g) => ({ guide: g, exercise: this.exercise(g.exerciseId), res: this.session.results[g.exerciseId], isExtra: false }));
    return seeded.concat(this.session.extras.map((x) => ({ ...x, isExtra: true })));
  },

  show(view) {
    this.view = view;
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

    const dateInput = el("input", { type: "date", id: "date-input", value: isoDate(d), style: "position:absolute;opacity:0;width:1px;height:1px;pointer-events:none",
      onchange: (e) => { if (e.target.value) { const [y, m, day] = e.target.value.split("-").map(Number); this.sessionDate = new Date(y, m - 1, day); this.renderToday(); } } });
    const dateBtn = el("button", { class: "today-date-btn", "aria-label": "날짜 변경", onclick: () => { try { dateInput.showPicker(); } catch (_) { dateInput.click(); } } },
      [document.createTextNode(dateStr), el("span", { class: "edit-hint", text: "›" })]);

    const select = el("select", { onchange: async (e) => { this.startSession(e.target.value); await this.loadLastResults(e.target.value); this.renderToday(); } },
      this.templates.map((t) => el("option", { value: t.id, ...(t.id === tpl.id ? { selected: "selected" } : {}) }, t.name)));

    root.appendChild(el("div", { class: "today-head" }, [
      el("div", { class: "head-row" }, [dateBtn, dateInput, el("button", { class: "btn btn-sm add-ex", onclick: () => this.addExtra() }, "＋ 운동 추가")]),
      el("div", { class: "today-title", text: tpl.name }),
      el("div", { class: "today-actions" }, [el("div", { class: "select-wrap" }, [select]), el("button", { class: "btn btn-sm btn-ghost", onclick: () => window.FitlogTimer.testSound() }, "🎧 알림 테스트")]),
    ]));

    if (this.ended) { this.renderSummary(root); return; }
    this.items().forEach((it) => root.appendChild(this.renderCard(it)));
    root.appendChild(this.renderCardio());
    root.appendChild(el("button", { class: "btn btn-block btn-ghost", style: "margin-top:4px", onclick: () => { this.ended = true; window.FitlogTimer.cancel(); this.renderToday(); window.scrollTo(0, 0); } }, "오늘 운동 종료"));
  },

  renderCard(it) {
    const { guide, exercise: ex, res, isExtra } = it;
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
    const draft = { weight: defWeight, reps: defReps };
    const btn = el("button", { class: "btn btn-block btn-primary", style: "margin-top:4px", onclick: () => this.completeSet(guide, ex, res, draft, isLastTarget, isExtra) },
      isExtra ? "✓ 추가 세트 기록" : (isLastTarget ? "✓ 운동 완료 · 다음 운동 준비" : "✓ 세트 완료"));
    const row = el("div", { class: "set-row" + (isExtra ? " extra-active" : "") }, [
      el("span", { class: "set-no", text: isExtra ? "＋" : `${i + 1}` }),
      this.dial(draft, "weight", { step: 0.5, min: 0, unit: this.unitLabel(ex), allowNull: true }),
      this.dial(draft, "reps", { step: 1, min: 0, unit: "회" }),
      el("div", { class: "set-complete" }, [btn]),
    ]);
    if (isExtra) row.appendChild(el("button", { class: "link", style: "grid-column:1/-1", onclick: () => { res.showExtra = false; this.renderToday(); } }, "취소"));
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

  // ---------------- 종료 요약 + 저장 ----------------
  renderSummary(root) {
    const items = this.items();
    const results = items.map((it) => ({ optional: it.guide.optional, ...this.evalExercise(it.guide, it.exercise, it.res) }));
    const done = results.filter((r) => r.status === "completed" || r.status === "progression_candidate").length;
    const partial = results.filter((r) => r.status === "volume_under").length;
    const missed = results.filter((r) => r.status === "skipped" || r.status === "not_started").length;
    const rate = window.FitlogEval.completionRate(results);
    const c = this.session.cardio;
    root.appendChild(el("div", { class: "summary" }, [
      el("h3", { text: "오늘 운동 종료" }),
      el("div", { class: "row" }, [el("span", { text: "완료" }), el("span", { text: `${done}` })]),
      el("div", { class: "row" }, [el("span", { text: "부분 완료" }), el("span", { text: `${partial}` })]),
      el("div", { class: "row" }, [el("span", { text: "미실시" }), el("span", { text: `${missed}` })]),
      el("div", { class: "row" }, [el("span", { text: "필수 완료율" }), el("span", { text: `${rate.done}/${rate.total}` })]),
      el("div", { class: "row" }, [el("span", { text: "유산소" }), el("span", { text: c.done ? `${c.durationMinutes}분 완료` : "미완료" })]),
      el("button", { class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: () => this.saveSession() }, "오늘 운동 저장"),
      el("button", { class: "btn btn-ghost btn-block", style: "margin-top:8px", onclick: () => { this.ended = false; this.renderToday(); } }, "계속 운동하기"),
    ]));
  },

  buildSession() {
    const d = this.sessionDate;
    const exerciseResults = this.items().map((it) => {
      const { guide: g, exercise: ex, res } = it;
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
    return {
      id: new Date().toISOString(), date: isoDate(d), weekday: WD_KEYS[d.getDay()], templateId: this.session.templateId, status: "completed",
      exerciseResults, cardio: c.done ? { type: c.type, incline: c.incline, speedKmh: c.speedKmh, durationMinutes: c.durationMinutes } : null,
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

  // ---------------- 기록 ----------------
  async renderHistory() {
    const root = document.getElementById("view-history"); root.textContent = "";
    root.appendChild(el("div", { class: "section-label", text: "기록" }));
    if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 저장을 쓸 수 없어요." })); return; }
    let sessions = [];
    try { sessions = await window.FitlogDB.DB.recentSessions(); } catch (e) { console.warn(e); }
    if (!sessions.length) { root.appendChild(el("div", { class: "placeholder", text: "아직 저장된 운동이 없어요. 오늘 운동을 저장하면 여기에 날짜별로 쌓여요." })); return; }
    root.appendChild(this.renderStats(sessions));
    root.appendChild(el("div", { class: "section-label", text: "날짜별 기록" }));
    sessions.forEach((s) => {
      const tpl = this.template(s.templateId); const name = tpl ? tpl.name : (s.templateId || "운동");
      const md = s.date.slice(5).replace("-", "/"); const wk = WEEKDAY_KO[s.weekday] || "";
      const req = (s.exerciseResults || []).filter((r) => !r.adhoc);
      const doneN = req.filter((r) => r.status === "completed" || r.status === "progression_candidate").length;
      root.appendChild(el("button", { class: "hist-row", onclick: () => { this.histEditEx = null; this.histCardioEdit = false; this.renderHistoryDetail(s.id); } }, [
        el("span", { class: "h-date", text: `${md} ${wk}` }), el("span", { class: "h-name", text: name }),
        el("span", { class: "h-status", text: `${doneN}/${req.length}${s.cardio ? " · 유산소" : ""}` }),
      ]));
    });
  },
  renderStats(sessions) {
    const CAT_KO = { back: "등", chest: "가슴", shoulder: "어깨", leg: "하체", arm: "팔", custom: "기타" };
    const cutoff = isoDate(new Date(Date.now() - 6 * 86400000)); // 최근 7일(오늘 포함)
    const recent = sessions.filter((s) => s.date >= cutoff);
    let totalWork = 0, cardioMin = 0, cardioCnt = 0;
    const byCat = {}; const progs = new Set();
    recent.forEach((s) => {
      (s.exerciseResults || []).forEach((r) => {
        const work = (r.sets || []).filter((x) => x.setType === "work").length;
        totalWork += work;
        const ex = this.exercise(r.exerciseId); const cat = (ex && ex.category) || "custom";
        byCat[cat] = (byCat[cat] || 0) + work;
        if (r.status === "progression_candidate") progs.add((ex && ex.name) || r.exerciseName || r.exerciseId);
      });
      if (s.cardio) { cardioMin += s.cardio.durationMinutes || 0; cardioCnt++; }
    });
    const catStr = Object.keys(byCat).length ? Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${CAT_KO[c] || c} ${n}`).join(" · ") : "—";

    const box = el("div", { class: "summary stats" }, [
      el("h3", { text: "최근 7일 요약" }),
      el("div", { class: "row" }, [el("span", { text: "운동 세션" }), el("span", { text: `${recent.length}회` })]),
      el("div", { class: "row" }, [el("span", { text: "총 본세트" }), el("span", { text: `${totalWork}세트` })]),
      el("div", { class: "row" }, [el("span", { text: "부위별 세트" }), el("span", { text: catStr })]),
      el("div", { class: "row" }, [el("span", { text: "유산소" }), el("span", { text: cardioCnt ? `${cardioCnt}회 · ${cardioMin}분` : "—" })]),
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
      const work = (r.sets || []).filter((x) => x.setType === "work");
      const warm = (r.sets || []).filter((x) => x.setType === "warmup");
      const gs = r.guideSnapshot || {};
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
  },

  // ---------------- 가이드 편집 (Phase 3) ----------------
  async reloadDefs() {
    const DB = window.FitlogDB.DB;
    this.templates = (await DB.getAll("routineTemplates")).sort((a, b) => a.order - b.order);
    this.exercises = await DB.getAll("exercises");
    this.guides = await DB.getAll("routineGuides");
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
    root.appendChild(el("button", { class: "btn btn-block btn-ghost add-set", style: "margin-top:2px", onclick: () => this.addExerciseToTemplate(tid) }, "＋ 종목 추가"));

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
  async addExerciseToTemplate(tid) {
    const name = (window.prompt("추가할 운동 이름 (예: 케이블 크런치)") || "").trim(); if (!name) return;
    const exId = "ex-" + Date.now();
    const order = Math.max(0, ...this.guidesOf(tid).map((g) => g.order)) + 1;
    const ex = { id: exId, name, category: "custom", unit: "kg", sideMode: "total", warmupEnabled: false, active: true };
    const g = { id: "g-" + exId, templateId: tid, exerciseId: exId, order, targetWeight: null, targetSets: 3, minReps: 8, maxReps: 12, optional: false, warmupSuggestions: [], notes: "" };
    try { await window.FitlogDB.DB.put("exercises", ex); await window.FitlogDB.DB.put("routineGuides", g); await this.reloadDefs(); } catch (e) { console.error(e); }
    this.editingGuideId = g.id; this.renderGuide();
  },
  renderGuideRow(g, ex) {
    return el("div", { class: "card" }, [
      el("div", { class: "card-top" }, [
        el("div", { class: "ex-name" }, [document.createTextNode(ex.name), g.optional ? el("span", { class: "opt", text: "선택" }) : null, ex.warmupEnabled ? el("span", { class: "opt", text: "워밍업" }) : null]),
        el("button", { class: "btn btn-sm", onclick: () => { this.editingGuideId = g.id; this.renderGuide(); } }, "편집"),
      ]),
      el("div", { class: "guide-line", text: this.guideLine(ex, g, false) }),
    ]);
  },
  renderGuideEditor(g, ex, idx, total) {
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
  async gatherAIContext() {
    const sessions = await window.FitlogDB.DB.recentSessions();
    const cutoff = isoDate(new Date(Date.now() - 27 * 86400000)); // 최근 4주
    const recentSessions = sessions.filter((s) => s.date >= cutoff);
    const recMap = {}, progSet = {};
    recentSessions.forEach((s) => {
      (s.exerciseResults || []).forEach((r) => {
        const work = (r.sets || []).filter((x) => x.setType === "work").map((x) => x.reps);
        if (work.length) (recMap[r.exerciseId] = recMap[r.exerciseId] || []).push(work);
        if (r.status === "progression_candidate") { const ex = this.exercise(r.exerciseId); progSet[r.exerciseId] = { exerciseId: r.exerciseId, direction: ex && ex.sideMode === "assist" ? "decrease_assist" : "increase" }; }
      });
    });
    const recent = Object.keys(recMap).map((id) => ({ exerciseId: id, records: recMap[id].slice(0, 5) }));
    return {
      templates: this.templates, exercises: this.exercises, guides: this.guides, dayMap: this.settings.dayTemplateMap,
      recent, progressions: Object.values(progSet),
      constraints: ["주 3회 (화·목·토 기본), 회당 약 90분", "유산소: 트레드밀 경사 걷기 30분", "데드리프트 계열 제외", "어시스트 종목은 보조중량을 낮출수록 어려워짐", "운동 경력 초반 단계, 과도한 증량 지양"],
    };
  },
  renderAI() {
    const root = document.getElementById("view-ai"); root.textContent = "";
    root.appendChild(el("div", { class: "section-label", text: "AI 코치" }));
    if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 사용할 수 없어요." })); return; }
    this.aiState = this.aiState || { prompt: "", input: "" }; // 탭 이동에도 유지(세션 한정)

    // 1. 내보내기 — 생성했던 프롬프트가 있으면 복원
    const hasPrompt = !!this.aiState.prompt;
    const promptArea = el("textarea", { class: "ai-textarea", id: "ai-prompt", readonly: "readonly", rows: "8", hidden: !hasPrompt });
    promptArea.value = this.aiState.prompt || "";
    const exportCard = el("div", { class: "card" }, [
      el("h3", { class: "ai-h", text: "1. 분석용 프롬프트 만들기" }),
      el("div", { class: "muted", text: "현재 루틴·최근 4주 기록을 AI가 읽을 문장으로 만들어요. 복사해서 ChatGPT/Claude에 붙여넣고, 받은 JSON을 아래 2번에 붙여넣으세요." }),
      el("button", { class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "생성 중…";
        try { const ctx = await this.gatherAIContext(); this.aiState.prompt = window.FitlogAI.buildPrompt(ctx); promptArea.value = this.aiState.prompt; promptArea.hidden = false; document.getElementById("ai-copy").hidden = false; }
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
