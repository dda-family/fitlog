/* exercise-finder.js — 운동 찾기(독립 라이브러리) + 공용 운동 상세 + 루틴에 추가
 * 한 화면 상태(ctx)로 목록 → 상세 → (루틴 선택 | 직접 만들기)를 같은 컨테이너 안에서 전환한다(바텀시트 없음).
 *   - 하단 '운동 찾기' 탭: ctx.mode = "browse", root = #view-find
 *   - 루틴 상세의 '+ 운동 추가': ctx.mode = "addToRoutine", ctx.target = { id } | { draft }, root = 내 운동 › 루틴 영역
 * 3D: 기존 런타임을 그대로 재사용(정식 미리보기 exercise-preview-3d.js, 그 외 3D 자산은 exercise-prototype-3d.js).
 *     상세에 들어갈 때만 1개 생성, 화면을 떠나거나 다시 그릴 때 _disposeExViewer()로 반드시 destroy.
 * 의존: app.js, my-workout.js
 */
(function () {
  const App = window.FitlogApp;
  const GROUPS = [["all", "전체"], ["chest", "가슴"], ["back", "등"], ["shoulders", "어깨"], ["arm", "팔"], ["legs", "하체"], ["core", "코어"], ["cardio", "유산소"]];
  const groupOf = (c) => (c.exerciseType === "cardio" || c.category === "cardio") ? "cardio" : (c.category === "biceps" || c.category === "triceps") ? "arm" : c.category;
  const STOP = new Set(["운동", "동작", "하는", "하기", "그리고"]);
  const tokenize = (q) => q.split(/\s+/).map((t) => t.replace(/(을|를|이|가|은|는|의|로|으로|에서|에|와|과|도|들)$/g, "")).filter((t) => t && !STOP.has(t));

  Object.assign(App, {
    _exViewer: null, _exViewerGen: 0,

    newFinderCtx(o) {
      return Object.assign({ root: null, mode: "browse", target: null, screen: "list", entry: o.screen || "list", q: "", group: "all", scroll: 0, detail: null, onExit: null }, o);
    },
    enterFind(opts) {
      const root = document.getElementById("view-find");
      if (!this.findCtx) this.findCtx = this.newFinderCtx({ mode: "browse" });
      this.findCtx.root = root;
      if (opts.fromNav) { this.findCtx.screen = "list"; this.findCtx.detail = null; }
      this.renderFinder(this.findCtx);
    },

    // ───────── 검색 인덱스: 이름·영문·별칭·부위·장비·주동근/보조근·동작 키워드 ─────────
    _finderIndex() {
      if (this._fIndex) return this._fIndex;
      const KW = (window.FitlogCatalog && window.FitlogCatalog.SEARCH_KEYWORDS) || {};
      this._fIndex = this._catExercises().map((c) => {
        const m = this.catalogMappingById(c.id) || {};
        const pri = Object.keys(m.primary || {}), sec = Object.keys(m.secondary || {}), desc = m.descriptiveMuscles || [];
        const lbl = (ids) => ids.map((id) => this.regionLabel(id));
        const muscles = (pri.length ? lbl(pri.concat(sec)) : lbl(desc)).join(" · ");
        const grp = groupOf(c), grpLabel = (GROUPS.find((g) => g[0] === grp) || [])[1] || "";
        const hay = [c.label_ko, c.label_en, ...(c.aliases || []), this.categoryLabel(c.category), grpLabel, this._equipLabel(c.equipment), c.equipment, ...lbl(pri), ...lbl(sec), ...lbl(desc), KW[c.id] || ""].join(" ").toLowerCase();
        return { c, group: grp, name: (c.label_ko || "").toLowerCase(), aliases: (c.aliases || []).map((a) => a.toLowerCase()), hay, muscles };
      });
      return this._fIndex;
    },
    finderSearch(query, group) {
      let list = this._finderIndex().filter((x) => group === "all" || x.group === group);
      const q = (query || "").trim().toLowerCase();
      const tokens = tokenize(q);
      if (!tokens.length) return list.slice().sort((a, b) => a.c.label_ko.localeCompare(b.c.label_ko, "ko"));
      const score = (x, needAll) => {
        let s = 0, hit = 0;
        tokens.forEach((t) => { if (x.name.includes(t)) { s += 3; hit++; } else if (x.hay.includes(t)) { s += 1; hit++; } });
        if (needAll && hit < tokens.length) return 0;
        if (q.length >= 2 && (x.name.includes(q) || x.aliases.some((a) => a.includes(q)))) s += 5;
        return s;
      };
      // 모든 단어가 맞는 운동 우선(예: '가슴 덤벨'), 없으면 일부만 맞아도 후보로
      let scored = list.map((x) => ({ x, s: score(x, true) })).filter((r) => r.s > 0);
      if (!scored.length) scored = list.map((x) => ({ x, s: score(x, false) })).filter((r) => r.s > 0);
      scored.sort((a, b) => b.s - a.s || a.x.c.label_ko.localeCompare(b.x.c.label_ko, "ko"));
      return scored.map((r) => r.x);
    },
    _proto3DSet() { return this._p3d || (this._p3d = new Set(this.PROTO_3D_IDS)); },
    has3D(catId) { return !!catId && (!!this._exercisePreviewAsset(catId) || this._proto3DSet().has(catId)); },

    // ───────── 대상 루틴 판별·추가 ─────────
    _targetName(ctx) {
      const t = ctx.target; if (!t) return "";
      if (t.draft) return (t.draft.name || "").trim() || "새 루틴";
      const tpl = this.template(t.id); return tpl ? tpl.name : "";
    },
    _inTarget(ctx, d) {
      const t = ctx.target; if (!t || !d) return false;
      if (t.draft) return t.draft.items.some((it) => (d.catId && it.catId === d.catId) || (!d.catId && d.exId && it.exId === d.exId));
      return this._inRoutine(t.id, d);
    },
    _inRoutine(tid, d) { return d.catId ? this.catalogInGuide(tid, d.catId) : (d.exId ? this.guideHasExercise(tid, d.exId) : false); },
    // 루틴에 항목 추가(카탈로그 운동은 기존 addCatalogExerciseToGuide — 같은 운동이면 기존 운동ID 재사용)
    async _addItemToRoutine(tid, it) {
      if (it.catId) return this.addCatalogExerciseToGuide(tid, it.catId);
      if (it.exId) return this.addAppExerciseToGuide(tid, it.exId);
      if (it.custom) return this.createCustomExerciseInRoutine(tid, it.custom);
      return { ok: false };
    },
    async addAppExerciseToGuide(tid, exId) {
      const ex = this.exercise(exId); if (!ex) return { ok: false };
      if (this.guideHasExercise(tid, ex.id)) return { ok: false, dup: true, ex };
      const order = Math.max(0, ...this.guidesOf(tid).map((g) => g.order)) + 1;
      const cd = window.FitlogDB.SEED.cardioDefault;
      const spec = this.cardioFieldSpec(ex);
      const g = this.isCardio(ex)
        ? { id: "g-" + ex.id + "-" + Date.now(), templateId: tid, exerciseId: ex.id, order, kind: "cardio",
            targetDurationMinutes: cd.durationMinutes, targetSpeedKmh: spec.speed ? cd.speedKmh : null, targetIncline: spec.incline ? cd.incline : null, optional: false, notes: "" }
        : { id: "g-" + ex.id + "-" + Date.now(), templateId: tid, exerciseId: ex.id, order,
            targetWeight: null, targetSets: 3, minReps: 8, maxReps: 12, optional: false, warmupSuggestions: [], notes: "" };
      if (!this.isCardio(ex) && this.exMeasureMeta(ex).allowed.includes("duration")) g.targetDurationSeconds = 30;
      await window.FitlogDB.DB.put("routineGuides", g);
      await this.reloadDefs();
      return { ok: true, ex, g };
    },
    // 직접 만든 운동(카탈로그에 없음) — 기존 '직접 운동 만들기'와 같은 데이터 형태
    async createCustomExerciseInRoutine(tid, { name, type, desc, measurementType, sides }) {
      let exId = "ex-" + Date.now();
      for (let i = 2; this.exercise(exId); i++) exId = "ex-" + Date.now() + "-" + i;   // 새 루틴 저장 시 연속 생성 충돌 방지
      const order = Math.max(0, ...this.guidesOf(tid).map((g) => g.order)) + 1;
      const cd = window.FitlogDB.SEED.cardioDefault;
      let ex, g;
      if (type === "cardio") {
        ex = { id: exId, name, category: "cardio", unit: "", sideMode: "none", kind: "cardio", warmupEnabled: false, active: true, supportsSpeed: true, supportsIncline: true, cardioCatalogId: null };
        g = { id: "g-" + exId, templateId: tid, exerciseId: exId, order, kind: "cardio", targetDurationMinutes: cd.durationMinutes, targetSpeedKmh: cd.speedKmh, targetIncline: cd.incline, optional: false, notes: "" };
      } else {
        ex = { id: exId, name, category: "custom", unit: "kg", sideMode: "total", warmupEnabled: false, active: true };
        g = { id: "g-" + exId, templateId: tid, exerciseId: exId, order, targetWeight: null, targetSets: 3, minReps: 8, maxReps: 12, optional: false, warmupSuggestions: [], notes: "" };
        // 기록 방식(선택 필드): 시간형이면 운동 자체에 저장, 루틴 항목엔 목표 시간
        if (measurementType === "duration") {
          ex.measurementType = "duration"; ex.sides = sides === "leftRight" ? "leftRight" : "none";
          g.targetDurationSeconds = 30;
        }
      }
      if (desc) ex.description = desc;
      await window.FitlogDB.DB.put("exercises", ex);
      await window.FitlogDB.DB.put("routineGuides", g);
      await this.reloadDefs();
      return { ok: true, ex, g };
    },
    async _finderAdd(ctx, d, nameForToast) {
      const t = ctx.target;
      if (t.draft) {
        if (!this._inTarget(ctx, d)) t.draft.items.push(d.catId ? { catId: d.catId } : { exId: d.exId });
        return true;
      }
      try {
        const res = await this._addItemToRoutine(t.id, d.catId ? { catId: d.catId } : { exId: d.exId });
        if (res.dup) { this.toast("이미 이 루틴에 있어요"); return false; }
        if (!res.ok) { this.toast("추가하지 못했어요"); return false; }
      } catch (e) { console.error("[Fitlog] 운동 추가 실패", e); this.toast("추가하지 못했어요"); return false; }
      return true;
    },

    // ───────── 렌더 진입점 ─────────
    renderFinder(ctx) {
      this._disposeExViewer();   // 화면을 지우기 전에 동기적으로 3D 정리(WebGL 누수·늦은 로딩 방지)
      const root = ctx.root; if (!root) return;
      root.textContent = "";
      if (ctx.screen === "detail") this._finderDetail(ctx);
      else if (ctx.screen === "picker") this._finderPicker(ctx);
      else if (ctx.screen === "create") this._finderCreate(ctx);
      else this._finderList(ctx);
    },
    _finderGo(ctx, screen, patch) {
      if (ctx.screen === "list" && screen !== "list") ctx.scroll = window.scrollY;
      Object.assign(ctx, patch || {}, { screen });
      this.renderFinder(ctx);
      window.scrollTo(0, screen === "list" ? ctx.scroll : 0);
    },
    _finderBackFromDetail(ctx) {
      if (ctx.entry === "detail" && ctx.onExit) ctx.onExit();
      else this._finderGo(ctx, "list");
    },

    // ───────── 목록(3D 없음 — 가벼운 텍스트 행) ─────────
    _finderList(ctx) {
      const I = this._ICO, icon = this._icon;
      const add = ctx.mode === "addToRoutine";
      const top = el("div", { class: "fx-top" });
      if (add) {
        top.appendChild(this._subHead("운동 추가", () => ctx.onExit && ctx.onExit()));
        top.appendChild(el("div", { class: "fx-target", text: `${this._targetName(ctx)}에 추가` }));
      } else top.appendChild(el("h1", { class: "page-title", text: "운동 찾기" }));
      const search = el("input", { type: "search", class: "fx-search", placeholder: "운동 이름, 근육, 장비 검색", enterkeyhint: "search", "aria-label": "운동 검색",
        autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" });
      search.value = ctx.q;
      const chips = el("div", { class: "fx-chips", role: "tablist" });
      top.appendChild(el("div", { class: "fx-search-wrap" }, [icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>', "ui-ico fx-search-ico"), search]));
      top.appendChild(chips);
      ctx.root.appendChild(top);
      const list = el("div", { class: "group-list fx-list" });
      ctx.root.appendChild(list);
      const paintChips = () => {
        chips.textContent = "";
        GROUPS.forEach(([k, label]) => chips.appendChild(el("button", { class: "fx-chip" + (ctx.group === k ? " on" : ""), type: "button", role: "tab", "aria-selected": ctx.group === k ? "true" : "false",
          onclick: () => { if (ctx.group === k) return; ctx.group = k; paintChips(); paintList(); window.scrollTo(0, 0); } }, label)));
      };
      const paintList = () => {
        list.textContent = "";
        const items = this.finderSearch(ctx.q, ctx.group);
        if (!items.length) list.appendChild(el("div", { class: "gl-empty", text: "일치하는 운동이 없어요. 부위나 장비 이름으로도 검색해 보세요." }));
        items.forEach((x) => {
          const c = x.c, inT = add && this._inTarget(ctx, { catId: c.id });
          list.appendChild(el("button", { class: "gl-row fx-row", type: "button", onclick: () => this._finderGo(ctx, "detail", { detail: { catId: c.id } }) }, [
            el("span", { class: "gl-stack" }, [
              el("span", { class: "gl-title" }, [c.label_ko || c.id, this.has3D(c.id) ? el("span", { class: "fx-3d", text: "3D" }) : null]),
              el("span", { class: "gl-sub", text: this.categoryLabel(c.category) + (c.equipment ? " · " + this._equipLabel(c.equipment) : "") }),
              x.muscles ? el("span", { class: "fx-mus", text: x.muscles }) : null,
            ]),
            inT ? el("span", { class: "fx-added", text: "추가됨" }) : icon(I.chev, "ui-ico gl-chev"),
          ]));
        });
        if (add) list.appendChild(el("button", { class: "gl-row gl-add", type: "button", onclick: () => this._finderGo(ctx, "create") }, "＋ 직접 운동 만들기"));
      };
      search.addEventListener("input", () => { ctx.q = search.value; paintList(); });
      search.addEventListener("keydown", (e) => { if (e.key === "Enter") search.blur(); });
      paintChips(); paintList();
    },

    // ───────── 공용 운동 상세 ─────────
    _finderDetail(ctx) {
      const d = ctx.detail || {};
      const ex = d.exId ? this.exercise(d.exId) : (d.catId ? this.findAppExerciseByCatalogId(d.catId) : null);
      const catId = d.catId || (ex ? this.appExerciseCatalogId(ex) : null);
      const c = catId ? this.catalogById(catId) : null;
      const root = ctx.root;
      if (!c && !ex) {
        root.appendChild(this._subHead("운동 상세", () => this._finderBackFromDetail(ctx)));
        root.appendChild(el("div", { class: "placeholder", text: "운동 정보를 찾을 수 없어요." }));
        return;
      }
      const title = (d.exId && ex) ? ex.name : (c ? c.label_ko : ex.name);
      root.appendChild(this._subHead(title, () => this._finderBackFromDetail(ctx)));
      const meta = c ? this.categoryLabel(c.category) + (c.equipment ? " · " + this._equipLabel(c.equipment) : "") : (this.isCardio(ex) ? "유산소 · 직접 만든 운동" : "직접 만든 운동");
      root.appendChild(el("div", { class: "fx-meta", text: meta }));

      // 3D: 자산이 있는 운동만. 없으면 안내만 두고 나머지 정보는 그대로.
      if (catId && this.has3D(catId)) root.appendChild(this._buildExViewer(catId));
      else root.appendChild(el("div", { class: "fx-3d-none", text: "이 운동은 아직 3D 동작이 없어요." }));

      // 근육: 사용자 지정 매핑 > 카탈로그 매핑(히트맵과 같은 우선순위)
      const cm = c ? this.catalogMappingById(c.id) : null;
      const m = (ex && this.resolvedMapping(ex)) || cm || null;
      const lbl = (obj) => Object.keys(obj || {}).map((id) => this.regionLabel(id)).join(" · ");
      const info = el("div", { class: "fx-info" });
      const sec = (k, v) => info.appendChild(el("div", { class: "fx-sec" }, [el("div", { class: "fx-sec-k", text: k }), el("div", { class: "fx-sec-v", text: v })]));
      const cardio = c ? c.exerciseType === "cardio" : this.isCardio(ex);
      if (cardio) {
        const dm = (cm && cm.descriptiveMuscles) || [];
        sec("주로 쓰는 부위", dm.length ? dm.map((id) => this.regionLabel(id)).join(" · ") : "유산소 · 근육 히트맵 집계 제외");
      } else if (m && Object.keys(m.primary || {}).length) {
        sec("주동근", lbl(m.primary));
        if (Object.keys(m.secondary || {}).length) sec("보조근", lbl(m.secondary));
      } else sec("근육", "근육 정보가 아직 없어요.");
      // 설명: 데이터에 있는 것만 표시(없는 내용을 지어내지 않음). howTo/cautions는 데이터가 생기면 자동 표시.
      const mm = ex ? this.exMeasureMeta(ex) : this.catalogMeasureMeta(catId);
      if (!cardio && mm.defaultType === "duration") sec("기본 기록 방식", mm.sides === "leftRight" ? "시간 · 좌우 각각 수행" : "시간");
      const txt = (v) => Array.isArray(v) ? v.join("\n") : v;
      if (c && c.howTo) sec("운동 방법", txt(c.howTo));
      if (c && c.cautions) sec("주의사항", txt(c.cautions));
      if (c && c.notes) sec("참고", c.notes);
      if (ex && ex.description) sec("설명", ex.description);
      root.appendChild(info);

      // CTA
      const dd = { catId: c ? c.id : null, exId: ex ? ex.id : null };
      if (ctx.mode === "addToRoutine") {
        const name = this._targetName(ctx);
        if (this._inTarget(ctx, dd)) root.appendChild(el("button", { class: "btn btn-block fx-cta", type: "button", disabled: "" }, `이미 ${name}에 있어요`));
        else {
          const btn = el("button", { class: "btn btn-primary btn-block fx-cta", type: "button" }, `${name}에 추가`);
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            const ok = await this._finderAdd(ctx, dd);
            if (!ok) { btn.disabled = false; return; }
            this.toast(`${title} · ${name}에 추가했어요`);
            ctx.onExit && ctx.onExit();
          });
          root.appendChild(btn);
        }
      } else {
        root.appendChild(el("button", { class: "btn btn-primary btn-block fx-cta", type: "button", onclick: () => this._finderGo(ctx, "picker") }, "루틴에 추가"));
      }
    },

    // 서비스용 3D 뷰어 영역: 자동 반복 · 재생/일시정지 · 드래그 회전(런타임 내장) · 시점 초기화. 기술 옵션 없음.
    _buildExViewer(catId) {
      const holder = el("div", { class: "fx-3d-view" });
      const playBtn = el("button", { class: "fx-3d-btn", type: "button", disabled: "" }, "일시정지");
      const resetBtn = el("button", { class: "fx-3d-btn", type: "button", disabled: "" }, "시점 초기화");
      const formal = !!this._exercisePreviewAsset(catId);
      const hint = el("div", { class: "fx-3d-hint", text: formal ? "좌우로 밀면 시점이 돌아가요" : "좌우로 밀면 시점이 돌아가요 · 참고용 동작이라 실제 자세와 다를 수 있어요" });
      const wrap = el("div", { class: "fx-3d-wrap" }, [holder, el("div", { class: "fx-3d-bar" }, [playBtn, resetBtn]), hint]);
      playBtn.addEventListener("click", () => {
        const v = this._exViewer; if (!v) return;
        if (v.isPlaying()) { v.pause(); playBtn.textContent = "재생"; } else { v.play(); playBtn.textContent = "일시정지"; }
      });
      resetBtn.addEventListener("click", () => { const v = this._exViewer; if (v) v.resetView(); });
      const fail = () => { wrap.replaceWith(el("div", { class: "fx-3d-none", text: "3D 동작을 불러오지 못했어요. 운동 정보는 아래에서 확인할 수 있어요." })); };
      // 호출자가 wrap을 DOM에 붙인 뒤(첫 await 이후) holder.isConnected 검사가 유효하다
      this._mountExViewer(holder, catId, { ready: () => { playBtn.disabled = false; resetBtn.disabled = false; }, fail });
      return wrap;
    },
    // 상세 화면당 뷰어 1개. gen으로 늦게 끝난 로딩을 폐기하고, 만든 즉시 _exViewer에 등록해 정리 대상에 포함한다.
    async _mountExViewer(holder, catId, ui) {
      this._disposeExViewer();
      const gen = this._exViewerGen;
      const stale = () => gen !== this._exViewerGen || !holder.isConnected;
      const drop = (v) => { if (this._exViewer === v) this._disposeExViewer(); };
      const fail = () => { if (!stale()) { const v = this._exViewer; ui.fail(); drop(v); } };
      const base = this._appRootURL();
      try {
        if (this._exercisePreviewAsset(catId)) {
          const { createExercisePreview } = await import("./runtime/exercise-preview-3d.js");
          if (stale()) return;
          const ctrl = createExercisePreview(holder, { exerciseId: catId, baseURL: base, autoplay: true,
            onStatus: ({ state }) => { if (state === "error" || state === "unavailable") fail(); } });
          const v = { ctrl, play: () => ctrl.play(), pause: () => ctrl.pause(), isPlaying: () => ctrl.getDiagnostics().playing, resetView: () => ctrl.resetView(), destroy: () => ctrl.destroy() };
          this._exViewer = v;
          await ctrl.ready;
          if (stale()) { drop(v); return; }
          if (ctrl.getDiagnostics().state !== "ready") { fail(); return; }
        } else {
          const { createPrototypePreview } = await import("./runtime/exercise-prototype-3d.js");
          if (stale()) return;
          const ctrl = createPrototypePreview(holder, { baseURL: base });
          const v = { ctrl, play: () => ctrl.play(), pause: () => ctrl.pause(), isPlaying: () => ctrl.isPlaying(), resetView: () => ctrl.resetView(), destroy: () => ctrl.destroy() };
          this._exViewer = v;
          const mm = this.catalogMappingById(catId) || {};
          const st = await ctrl.select(catId, { muscles: { primary: mm.primary || {}, secondary: mm.secondary || {}, minor: mm.minor || {} } });
          if (stale()) { drop(v); return; }
          if (st !== "ready") { fail(); return; }
        }
        ui.ready();
      } catch (e) { console.warn("[exercise-3d] 불러오기 실패", e); fail(); }
    },
    _disposeExViewer() {
      this._exViewerGen++;
      const v = this._exViewer; this._exViewer = null;
      if (v) { try { v.destroy(); } catch (_) {} }
    },

    // ───────── 루틴 선택(독립 운동 찾기 → 루틴에 추가) ─────────
    _finderPicker(ctx) {
      const d = ctx.detail || {};
      const ex = d.exId ? this.exercise(d.exId) : (d.catId ? this.findAppExerciseByCatalogId(d.catId) : null);
      const c = d.catId ? this.catalogById(d.catId) : (ex ? this.catalogById(this.appExerciseCatalogId(ex)) : null);
      const name = (d.exId && ex) ? ex.name : (c ? c.label_ko : (ex && ex.name) || "");
      const dd = { catId: c ? c.id : null, exId: ex ? ex.id : null };
      const root = ctx.root;
      root.appendChild(this._subHead("루틴 선택", () => this._finderGo(ctx, "detail")));
      root.appendChild(el("div", { class: "rt-hint", text: `${name}을(를) 추가할 루틴을 선택하세요.` }));
      const list = el("div", { class: "group-list" });
      this.templates.forEach((t) => {
        const inT = this._inRoutine(t.id, dd);
        list.appendChild(el("button", { class: "gl-row", type: "button", disabled: inT ? "" : null, onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          try {
            const res = await this._addItemToRoutine(t.id, dd.catId ? { catId: dd.catId } : { exId: dd.exId });
            if (res.dup) this.toast("이미 이 루틴에 있어요");
            else if (res.ok) this.toast(`${t.name}에 추가했어요`);
            else { this.toast("추가하지 못했어요"); btn.disabled = false; return; }
          } catch (err) { console.error(err); this.toast("추가하지 못했어요"); btn.disabled = false; return; }
          this._finderGo(ctx, "detail");
        } }, [
          el("span", { class: "gl-stack" }, [el("span", { class: "gl-title", text: t.name }), el("span", { class: "gl-sub", text: `${this.guidesOf(t.id).length}개 운동` })]),
          inT ? el("span", { class: "fx-added", text: "추가됨" }) : el("span", { class: "fx-plus", "aria-hidden": "true", text: "＋" }),
        ]));
      });
      root.appendChild(list);
    },

    // ───────── 직접 운동 만들기(카탈로그에 없는 운동) — 기존 입력 항목 그대로, 전체 화면 ─────────
    _finderCreate(ctx) {
      const root = ctx.root;
      root.appendChild(this._subHead("직접 운동 만들기", () => this._finderGo(ctx, "list")));
      root.appendChild(el("div", { class: "fx-target", text: `${this._targetName(ctx)}에 추가` }));
      const nameIn = el("input", { type: "text", class: "text-input", placeholder: "예: 케이블 크런치", value: ctx.q || "", autocomplete: "off", autocorrect: "off", autocapitalize: "off" });
      root.appendChild(el("label", { class: "field-label", text: "운동 이름" })); root.appendChild(nameIn);
      let type = "strength";
      const tS = el("button", { class: "fx-chip on", type: "button" }, "근력"), tC = el("button", { class: "fx-chip", type: "button" }, "유산소");
      const setType = (t) => { type = t; tS.classList.toggle("on", t === "strength"); tC.classList.toggle("on", t === "cardio"); };
      tS.onclick = () => setType("strength"); tC.onclick = () => setType("cardio");
      root.appendChild(el("label", { class: "field-label", text: "운동 유형" })); root.appendChild(el("div", { class: "fx-chips static" }, [tS, tC]));
      // 근력 운동의 기록 방식 · 좌우 구분(좌우 각각은 시간 기록에서 쓴다)
      let measure = "reps", sides = "none";
      const mR = el("button", { class: "fx-chip on", type: "button" }, "반복 횟수"), mD = el("button", { class: "fx-chip", type: "button" }, "시간");
      const sN = el("button", { class: "fx-chip on", type: "button" }, "없음"), sLR = el("button", { class: "fx-chip", type: "button" }, "좌우 각각 수행");
      const sideWrap = el("div", { hidden: true }, [el("label", { class: "field-label", text: "좌우 구분" }), el("div", { class: "fx-chips static" }, [sN, sLR])]);
      const paintM = () => {
        mR.classList.toggle("on", measure === "reps"); mD.classList.toggle("on", measure === "duration");
        sN.classList.toggle("on", sides === "none"); sLR.classList.toggle("on", sides === "leftRight");
        measureWrap.hidden = type !== "strength"; sideWrap.hidden = type !== "strength" || measure !== "duration";
      };
      mR.onclick = () => { measure = "reps"; sides = "none"; paintM(); }; mD.onclick = () => { measure = "duration"; paintM(); };
      sN.onclick = () => { sides = "none"; paintM(); }; sLR.onclick = () => { sides = "leftRight"; paintM(); };
      const measureWrap = el("div", {}, [el("label", { class: "field-label", text: "기록 방식" }), el("div", { class: "fx-chips static" }, [mR, mD])]);
      tS.addEventListener("click", paintM); tC.addEventListener("click", paintM);
      root.appendChild(measureWrap); root.appendChild(sideWrap);
      const descIn = el("textarea", { class: "text-input text-area", placeholder: "동작 설명 (선택) — 나중에 AI 근육 매핑에 활용돼요", rows: "2" });
      root.appendChild(el("label", { class: "field-label", text: "동작 설명 (선택)" })); root.appendChild(descIn);
      const sim = el("div", { class: "fx-sim" }); root.appendChild(sim);
      const paintSim = () => {
        sim.textContent = "";
        const q = nameIn.value.trim(); if (q.length < 2) return;
        const close = this.finderSearch(q, "all").filter((x) => x.name.includes(q.toLowerCase()) || q.includes(x.c.label_ko) || x.aliases.some((a) => a.includes(q.toLowerCase()))).slice(0, 3);
        if (!close.length) return;
        sim.appendChild(el("div", { class: "field-label", text: "이미 준비된 운동이 있어요" }));
        const l = el("div", { class: "group-list" });
        close.forEach((x) => l.appendChild(el("button", { class: "gl-row", type: "button", onclick: () => this._finderGo(ctx, "detail", { detail: { catId: x.c.id } }) }, [
          el("span", { class: "gl-stack" }, [el("span", { class: "gl-title", text: x.c.label_ko }), el("span", { class: "gl-sub", text: this.categoryLabel(x.c.category) })]),
          this._icon(this._ICO.chev, "ui-ico gl-chev"),
        ])));
        sim.appendChild(l);
      };
      nameIn.addEventListener("input", paintSim); paintSim();
      const err = el("div", { class: "range-err", hidden: true }); root.appendChild(err);
      root.appendChild(el("div", { class: "rt-hint", text: "근육 매핑은 입력하지 않아도 돼요. 매핑이 없으면 근육 히트맵 집계에서만 빠지고, 기록은 정상 저장됩니다." }));
      const btn = el("button", { class: "btn btn-primary btn-block fx-cta", type: "button" }, "운동 만들기");
      btn.addEventListener("click", async () => {
        const name = nameIn.value.trim();
        if (!name) { err.textContent = "운동 이름을 입력하세요."; err.hidden = false; return; }
        const custom = { name, type, desc: descIn.value.trim(), ...(type === "strength" && measure === "duration" ? { measurementType: "duration", sides } : {}) };
        btn.disabled = true;
        if (ctx.target.draft) ctx.target.draft.items.push({ custom });
        else {
          try { await this.createCustomExerciseInRoutine(ctx.target.id, custom); }
          catch (e) { console.error(e); err.textContent = "저장 중 오류가 발생했어요."; err.hidden = false; btn.disabled = false; return; }
        }
        this.toast(`${name} · ${this._targetName(ctx)}에 추가했어요`);
        ctx.onExit && ctx.onExit();
      });
      root.appendChild(btn);
      setTimeout(() => { try { nameIn.focus(); } catch (_) {} }, 60);
    },
  });
})();
