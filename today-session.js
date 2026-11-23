/* today-session.js — 오늘 운동 세션 전용 조작 (v38, docs/DECISIONS.md)
 * 원칙: 저장된 루틴(routineTemplates·routineGuides)과 오늘의 세션(App.session)을 분리한다.
 *   여기의 조작(오늘에서 삭제 · 오늘 순서 변경 · 오늘 운동 추가)은 App.session만 바꾸고 DB의 루틴은 절대 건드리지 않는다.
 *   영구적인 루틴 수정은 내 운동 › 루틴(my-workout.js)에서만.
 * 세션 구조(선택 필드): session.order = 블록 키 배열, session.removed = { 키: true }
 *   블록 키: "s:<guideId>" 독립 운동 · "g:<groupId>" 연속 세트 · "e:<extraId>" 오늘 추가 운동
 * 실행 취소/다시 실행: 경로 패치 저널 — 명령 = { id, label, ps: [{ p: 세션 기준 경로, b: 전, a: 후 }], fx: { rest } }
 *   경로 조각 "#<id>"는 배열에서 exercise.id가 같은 원소(오늘 추가 운동)를 가리킨다. 전체 상태 복제는 하지 않는다.
 * 남은 시간·↶↷ 표시: 따로 띠 없이 큰 제목 줄 + 스크롤 시 접힌 헤더(#today-mini) + 다른 탭에선 하단 "오늘" 탭(v39).
 *   접힌 헤더 오른쪽 ⇅ = 순서 변경, ＋ = 운동 추가(v40·v41).
 * 진행 중 세션 임시 저장: localStorage(동기 → 갑작스런 새로고침에도 남음). 정식 기록(workoutSessions)·백업과 분리.
 * 당겨서 새로고침 방지: CSS overscroll-behavior + iOS 보조 가드(최상단에서 아래로 당기는 첫 touchmove만 막음).
 * 의존: app.js · my-workout.js(_subHead·_wireReorderDrag·toast·아이콘) · workout-runner.js(routineBlocks·run) — 그 다음에 로드
 */
(function () {
  const App = window.FitlogApp;
  const HIST_MAX = 30;
  const SAVE_KEY = "fitlog-active-session";
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // 을/를 — 받침 유무(한글이 아니면 "을(를)")
  const josa = (w) => {
    const c = String(w || "").trim().slice(-1).charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? "을" : "를";
    return "을(를)";
  };
  const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  Object.assign(App, {
    _hist: { undo: [], redo: [] },
    _cmdSeq: 0,
    pendingRecovery: null,
    todayMode: null,          // null | "reorder"
    sessionSaved: false,

    // ───────── 오늘 블록(오늘 순서 · 오늘에서 삭제 반영) ─────────
    _baseBlocks() {
      const blocks = this.routineBlocks(this.session.templateId).map((b) => ({ ...b, key: b.type === "group" ? "g:" + b.id : "s:" + b.guide.id }));
      return blocks.concat((this.session.extras || []).map((x) => ({ type: "extra", key: "e:" + x.exercise.id, extra: x })));
    },
    // session.order를 현재 블록과 맞춘다. 새로 생긴 블록(루틴 편집으로 늘어난 운동 등)은 원래 앞 블록 바로 뒤에 넣는다.
    _syncOrder() {
      const s = this.session; if (!s) return;
      if (!Array.isArray(s.order)) s.order = [];
      if (!s.removed || typeof s.removed !== "object") s.removed = {};
      if (!s.groupProgress) s.groupProgress = {};
      const base = this._baseBlocks().map((b) => b.key), known = new Set(base);
      const order = s.order.filter((k) => known.has(k));
      base.forEach((k, i) => {
        if (order.includes(k)) return;
        let at = 0;
        for (let j = i - 1; j >= 0; j--) { const p = order.indexOf(base[j]); if (p >= 0) { at = p + 1; break; } }
        order.splice(at, 0, k);
      });
      if (!same(order, s.order)) s.order = order;
    },
    todayBlocks() {
      this._syncOrder();
      const by = new Map(this._baseBlocks().map((b) => [b.key, b]));
      return this.session.order.filter((k) => by.has(k) && !this.session.removed[k]).map((k) => by.get(k));
    },
    _itemKey(it) { return it.isExtra ? "e:" + it.exercise.id : "s:" + it.guide.id; },
    _rp(it) { return it.isExtra ? ["extras", "#" + it.exercise.id, "res"] : ["results", it.guide.exerciseId]; },
    _blockResList(b) {
      if (b.type === "group") return b.guides.map((g) => this.session.results[g.exerciseId]).filter(Boolean);
      if (b.type === "single") return [this.session.results[b.guide.exerciseId]].filter(Boolean);
      return [b.extra.res];
    },
    _resStarted(r) { return !!r && ((r.workSets && r.workSets.length > 0) || (r.warmupSets && r.warmupSets.length > 0) || !!r.done || !!r.skipped); },
    _blockRunning(b) {
      if (!this.run) return false;
      if (b.type === "group") return this.run.key === "g:" + b.id;
      return b.type === "single" && this.run.key === "x:" + b.guide.exerciseId;
    },
    _blockHasRecords(b) {
      if (b.type === "group" && (this.session.groupProgress[b.id] || 0) > 0) return true;
      return this._blockResList(b).some((r) => (r.workSets && r.workSets.length > 0) || (r.warmupSets && r.warmupSets.length > 0) || !!r.done);
    },
    // 오늘 순서 변경은 아직 시작하지 않은 블록만(완료·진행 중·생략은 제자리)
    _blockMovable(b) {
      if (this._blockRunning(b)) return false;
      if (b.type === "group" && (this.session.groupProgress[b.id] || 0) > 0) return false;
      return !this._blockResList(b).some((r) => this._resStarted(r));
    },
    _movableKeys() { return this.session ? this.todayBlocks().filter((b) => this._blockMovable(b)).map((b) => b.key) : []; },
    _blockName(b) {
      if (b.type === "group") return "연속 세트";
      if (b.type === "extra") return (b.extra.exercise.name || "").trim() || "직접 추가한 운동";
      return (this.exercise(b.guide.exerciseId) || {}).name || "운동";
    },

    // ───────── 실행 취소 저널 ─────────
    _key(o, seg) {
      if (typeof seg === "string" && seg[0] === "#" && Array.isArray(o)) return o.findIndex((x) => x && x.exercise && x.exercise.id === seg.slice(1));
      return seg;
    },
    _resolve(path, create) {
      let o = this.session;
      for (let i = 0; i < path.length - 1; i++) {
        if (o == null) return null;
        const k = this._key(o, path[i]); if (k === -1) return null;
        if (o[k] == null) { if (!create) return null; o[k] = {}; }
        o = o[k];
      }
      if (o == null) return null;
      const k = this._key(o, path[path.length - 1]);
      return k === -1 ? null : { o, k };
    },
    _getP(path) { const r = this._resolve(path, false); return r ? r.o[r.k] : undefined; },
    _setP(path, v) {
      const r = this._resolve(path, true); if (!r) return;
      if (v === undefined && !Array.isArray(r.o)) delete r.o[r.k]; else r.o[r.k] = clone(v);
    },
    _snapPaths(paths) {
      const T = window.FitlogTimer;
      return { paths, b: paths.map((p) => clone(this._getP(p))), t0: T.state ? T.state.startedAt : null };
    },
    // 스냅샷 이후 바뀐 경로만 명령으로 기록. 그 사이 새 휴식이 시작됐으면 그 휴식도 이 명령의 효과(fx)로 묶는다.
    _commitSnap(label, snap) {
      const ps = snap.paths.map((p, i) => ({ p, b: snap.b[i], a: clone(this._getP(p)) })).filter((x) => !same(x.b, x.a));
      const T = window.FitlogTimer, st = T.state;
      const fx = st && st.running && st.startedAt !== snap.t0 ? { rest: { type: st.type, sec: st.durationSeconds, key: this.activeTimerExerciseId, at: st.startedAt } } : null;
      return this._pushCmd(label, ps, fx);
    },
    _pushCmd(label, ps, fx) {
      ps = (ps || []).filter((x) => !same(x.b, x.a));
      if (!ps.length && !fx) return null;
      const cmd = { id: ++this._cmdSeq, label, ps: ps.map((x) => ({ p: x.p, b: clone(x.b), a: clone(x.a) })), ...(fx ? { fx } : {}) };
      this._hist.undo.push(cmd);
      if (this._hist.undo.length > HIST_MAX) this._hist.undo.splice(0, this._hist.undo.length - HIST_MAX);
      this._hist.redo = [];
      this._persist(); this._updateUndoUI();
      return cmd;
    },
    // 오늘 세션을 바꾸는 사용자 동작 한 번 = 명령 하나. paths = 이 동작이 바꾸는 최소 경로들.
    _act(label, paths, fn) {
      const snap = this._snapPaths(paths);
      fn();
      const cmd = this._commitSnap(label, snap);
      if (this.view === "today") this.renderToday();
      return cmd;
    },
    // 텍스트 입력(메모·운동 이름): 입력 중엔 바로 반영, 입력을 마치면(change) 1단위로 기록
    _journalInput(input, path, label) {
      let before;
      input.addEventListener("focus", () => { before = this._getP(path) || ""; });
      input.addEventListener("change", () => { const after = this._getP(path) || ""; this._pushCmd(label, [{ p: path, b: before, a: after }]); before = after; });
      return input;
    },
    _histReset() { this._hist = { undo: [], redo: [] }; this.sessionSaved = false; this._updateUndoUI(); },
    // 시간형 준비·버티기·중단 선택·연속 세트 진행 중에는 비활성(수행 엔진과 충돌 방지 — 기존 "중단"을 쓴다)
    _histLocked() { return !!this.run || this.ended || !!this.pendingRecovery || this.todayMode === "reorder"; },
    canUndo() { return this._hist.undo.length > 0 && !this._histLocked(); },
    canRedo() { return this._hist.redo.length > 0 && !this._histLocked(); },
    undo() {
      if (!this.canUndo()) return;
      const c = this._hist.undo.pop();
      for (let i = c.ps.length - 1; i >= 0; i--) this._setP(c.ps[i].p, c.ps[i].b);
      // 이 동작이 시작한 휴식이 아직 돌고 있으면 함께 취소
      const T = window.FitlogTimer;
      if (c.fx && c.fx.rest && T.state && T.state.startedAt === c.fx.rest.at) { T.cancel(); this.activeTimerExerciseId = null; }
      this._hist.redo.push(c);
      this._afterHist("실행 취소", c);
    },
    redo() {
      if (!this.canRedo()) return;
      const c = this._hist.redo.pop();
      c.ps.forEach((x) => this._setP(x.p, x.a));
      // 다시 실행 = 지금 시점 기준의 새 휴식(지난 시각은 복원하지 않음)
      if (c.fx && c.fx.rest) {
        const T = window.FitlogTimer;
        this.activeTimerExerciseId = c.fx.rest.key; T.start(c.fx.rest.type, c.fx.rest.sec); c.fx.rest.at = T.state.startedAt;
      }
      this._hist.undo.push(c);
      this._afterHist("다시 실행", c);
    },
    _afterHist(verb, c) {
      document.querySelectorAll(".app-snack").forEach((n) => n.remove());
      this._syncOrder();
      if (this.view === "today") this.renderToday(); else { this._persist(); this._updateUndoUI(); }
      this.toast(`${verb} · ${c.label}`);
    },
    // ↶↷는 두 곳(큰 제목 줄 · 접힌 헤더)에 있다 — 같은 상태로 함께 갱신
    _updateUndoUI() {
      const cu = this.canUndo(), cr = this.canRedo();
      const lu = cu ? this._hist.undo[this._hist.undo.length - 1].label : "", lr = cr ? this._hist.redo[this._hist.redo.length - 1].label : "";
      document.querySelectorAll(".js-undo").forEach((b) => { b.disabled = !cu; b.setAttribute("aria-label", lu ? `실행 취소: ${lu}` : "실행 취소"); });
      document.querySelectorAll(".js-redo").forEach((b) => { b.disabled = !cr; b.setAttribute("aria-label", lr ? `다시 실행: ${lr}` : "다시 실행"); });
    },
    _titleTools() {
      const svg = (d) => { const t = document.createElement("span"); t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`; return t.firstChild; };
      return el("div", { class: "title-tools" }, [
        el("span", { class: "live-pill js-live", hidden: "hidden" }),
        el("button", { class: "undo-btn js-undo", type: "button", "aria-label": "실행 취소", disabled: "disabled", onclick: () => this.undo() }, [svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>')]),
        el("button", { class: "undo-btn js-redo", type: "button", "aria-label": "다시 실행", disabled: "disabled", onclick: () => this.redo() }, [svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>')]),
      ]);
    },
    // 지금 보여 줄 남은 시간: 버티기/준비(수행 엔진) > 휴식 > 방금 끝난 휴식(2초)
    _liveStatus() {
      const r = this.run, now = Date.now();
      if (r && r.phase === "preparing") return { cls: "prep", text: `준비 ${Math.max(1, Math.ceil((r.prepEndsAt - now) / 1000))}`, label: "준비 중" };
      if (r && r.phase === "performing") return { cls: "run", text: this._mmss((r.endsAt - now) / 1000), label: "버티기 남은 시간" };
      const T = window.FitlogTimer;
      if (T.state && T.state.running) return { cls: "rest", text: T._mmss(T.remaining()), label: T.state.type === "exercise_rest" ? "다음 운동까지 휴식" : "휴식 남은 시간" };
      if (this._restEndedAt && now - this._restEndedAt < 2500) return { cls: "ended", text: "휴식 끝", label: "휴식 끝" };
      return null;
    },
    _paintLive() {
      const st = this._liveStatus();
      document.querySelectorAll(".js-live").forEach((n) => {
        if (!st) { n.hidden = true; return; }
        n.hidden = false; n.className = "live-pill js-live " + st.cls; n.textContent = st.text; n.setAttribute("aria-label", `${st.label} ${st.text}`);
      });
      // 다른 탭에 있을 때: 하단 "오늘" 탭 라벨이 남은 시간(휴식·버티기)
      const tab = document.querySelector('.tab[data-view="today"]'), lbl = tab && tab.querySelector(".tab-label");
      if (lbl) {
        const on = !!st && this.view !== "today" && st.cls !== "ended";
        tab.classList.toggle("live", on); lbl.textContent = on ? st.text : "오늘";
      }
    },
    // 큰 제목이 화면 위로 지나가면 접힌 헤더를 보여 준다(iOS 큰 제목 방식)
    _syncMini() {
      const title = this.view === "today" && document.querySelector("#view-today .title-row");
      const on = !!title && document.body.classList.contains("today-active") && this.todayMode !== "reorder" && title.getBoundingClientRect().bottom < 8;
      document.body.classList.toggle("mini-on", on);
      const t = document.getElementById("tm-title");
      if (t && this.session) t.textContent = (this.template(this.session.templateId) || {}).name || "";
      const ro = document.querySelector("#today-mini .js-mini-reorder");
      if (ro && this.session) ro.disabled = !!(this.ended || this.run || this._movableKeys().length < 2);
    },
    _setTodayActive(on) { document.body.classList.toggle("today-active", !!on); this._updateUndoUI(); this._paintLive(); this._syncMini(); },
    // ───────── 화면 위치 유지(v42) ─────────
    // 오늘 화면은 다시 그릴 때 통째로 비웠다가 채운다. 그 사이 레이아웃을 읽으면(접힌 헤더 계산 등) 문서가 짧아져
    // 스크롤이 0으로 잘린다 → "세트 완료 = 맨 위로" 버그. 다시 그리기 전 기준 카드(data-key)와 그 화면 위치를
    // 기억했다가, 다 그린 뒤 같은 카드가 같은 자리에 오도록 되돌린다. 텍스트·운동명으로 찾지 않는다.
    _viewBand() {
      const mini = document.getElementById("today-mini"), tab = document.getElementById("tabbar");
      return { top: mini ? mini.getBoundingClientRect().height : 0, bottom: tab ? tab.getBoundingClientRect().top : window.innerHeight };
    },
    _todayCards(root) { return [...root.querySelectorAll(":scope > [data-key]")]; },
    _captureAnchor(root) {
      const a = { y: window.scrollY };
      if (this.view !== "today" || !root || root.hidden) return a;
      const band = this._viewBand(), cards = this._todayCards(root);
      const inBand = (n) => { const r = n.getBoundingClientRect(); return r.bottom > band.top && r.top < band.bottom; };
      // 방금 사용자가 누른 카드(1.5초 안) — 그 카드가 이번 동작의 주인공
      a.intent = this._tapKey && Date.now() - (this._tapAt || 0) < 1500 ? this._tapKey : null;
      const own = a.intent && cards.find((c) => c.dataset.key === a.intent);
      const stable = own && inBand(own) ? own : cards.find((c) => c.getBoundingClientRect().bottom > band.top);
      if (stable) { a.key = stable.dataset.key; a.top = stable.getBoundingClientRect().top; }
      return a;
    },
    _restoreAnchor(root, a) {
      if (!a) return;
      window.scrollTo(0, a.y);
      const find = (k) => this._todayCards(root).find((c) => c.dataset.key === k);
      const n = a.key && find(a.key);
      if (n) { const d = n.getBoundingClientRect().top - a.top; if (Math.abs(d) > 1) window.scrollBy(0, d); }
      // 누른 카드는 다음 입력 위치(다음 세트 줄·수행 패널)가 화면 안에 들어오게 최소한만 이동
      const own = a.intent && find(a.intent);
      if (own) { const act = own.querySelector(".set-row .set-complete"); this._ensureVisible(act ? act.closest(".set-row") : (own.querySelector("#inline-cd") || own.querySelector(".run-panel"))); }
    },
    _ensureVisible(n) {
      if (!n) return;
      const band = this._viewBand(), r = n.getBoundingClientRect(), pad = 8;
      if (r.top < band.top + pad) window.scrollBy(0, r.top - band.top - pad);
      else if (r.bottom > band.bottom - pad) window.scrollBy(0, Math.min(r.bottom - band.bottom + pad, r.top - band.top - pad));
    },
    // 휴식이 끝나 다시 그릴 때: 방금 끝낸 카드가 완료 상태이고 화면에 보이고 있었다면 다음 할 운동 카드를 보여 준다.
    // (휴식 시작 순간엔 움직이지 않음 — 방금 기록한 내용을 확인할 수 있게)
    _restEndRender() {
      const root = document.getElementById("view-today");
      const from = document.getElementById("inline-cd"), card = from && from.closest("[data-key]");
      const band = this._viewBand();
      const wasVisible = !!card && (() => { const r = card.getBoundingClientRect(); return r.bottom > band.top && r.top < band.bottom; })();
      const fromKey = card && card.dataset.key;
      this.renderToday();
      if (!fromKey || !wasVisible) return;
      const cards = this._todayCards(root), i = cards.findIndex((c) => c.dataset.key === fromKey);
      if (i < 0 || !cards[i].classList.contains("done")) return;
      const next = cards.slice(i + 1).find((c) => !c.classList.contains("done") && !c.classList.contains("skipped"));
      if (!next) return;
      const r = next.getBoundingClientRect();
      if (r.top >= band.top && r.top < band.bottom - 160) return;   // 이미 다음 카드 머리가 잘 보임
      window.scrollTo({ top: window.scrollY + r.top - band.top - 8, behavior: "smooth" });
    },
    _afterTodayRender() {
      if (this.todayMode !== "reorder" && this._reorderY != null) { window.scrollTo(0, this._reorderY); this._reorderY = null; }
      this._persist(); this._updateUndoUI(); this._paintLive(); this._syncMini();
    },

    // 스낵바: [되돌리기]는 같은 실행 취소 스택의 undo()를 부른다(그 동작이 아직 맨 위일 때만)
    snack(msg, cmd) {
      document.querySelectorAll(".app-toast, .app-snack").forEach((n) => n.remove());
      const t = el("div", { class: "app-snack", role: "status" }, [
        el("span", { class: "snack-msg", text: msg }),
        el("button", { class: "snack-btn", type: "button", onclick: () => {
          t.remove();
          const top = this._hist.undo[this._hist.undo.length - 1];
          if (top && top.id === cmd.id) this.undo();
        } }, "되돌리기"),
      ]);
      document.body.appendChild(t);
      clearTimeout(this._snackTimer);
      this._snackTimer = setTimeout(() => { try { t.remove(); } catch (_) {} }, 5000);
    },
    // 작은 확인 시트(취소 / 확인 라벨 지정). Promise<boolean>
    _confirmSheet(msg, okLabel) {
      return new Promise((resolve) => {
        const overlay = el("div", { class: "modal-overlay" });
        const done = (v) => { try { overlay.remove(); } catch (_) {} resolve(v); };
        overlay.appendChild(el("div", { class: "modal-sheet confirm-sheet", role: "alertdialog", "aria-modal": "true" }, [
          el("div", { class: "confirm-msg", text: msg }),
          el("div", { class: "modal-actions" }, [
            el("button", { class: "btn btn-ghost", type: "button", onclick: () => done(false) }, "취소"),
            el("button", { class: "btn danger-btn", type: "button", onclick: () => done(true) }, okLabel || "확인"),
          ]),
        ]));
        overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
        document.body.appendChild(overlay);
      });
    },

    // ───────── 생략 · 오늘에서 삭제 ─────────
    _footActions(nodes) { return el("div", { class: "foot-actions" }, nodes.filter(Boolean)); },
    _removeLink(x) {
      const key = x.key || this._itemKey(x);
      const b = this.todayBlocks().find((y) => y.key === key);
      if (!b || this._blockRunning(b)) return null;
      return el("button", { class: "link danger", type: "button", onclick: () => this.removeFromToday(b) }, "오늘에서 삭제");
    },
    async removeFromToday(b) {
      if (this._blockRunning(b)) return;
      if (this._blockHasRecords(b) && !(await this._confirmSheet("이미 기록한 세트가 있습니다.\n오늘 운동에서 삭제할까요?", "삭제"))) return;
      const name = this._blockName(b);
      const cmd = this._act("오늘에서 삭제", [["removed", b.key]], () => { this.session.removed[b.key] = true; });
      if (cmd) this.snack(`${name}${josa(name)} 오늘 운동에서 삭제했어요.`, cmd);
    },
    setSkipped(rps, val, name) {
      const cmd = this._act(val ? "운동 생략" : "생략 되돌림", rps.map((rp) => [...rp, "skipped"]), () => rps.forEach((rp) => { const r = this._getP(rp); if (r) r.skipped = val; }));
      if (cmd && val) this.snack(`${name || "운동"}${josa(name || "운동")} 이번엔 생략했어요.`, cmd);
    },

    // ───────── 오늘 순서 변경(오늘 세션만 — 루틴 순서는 그대로) ─────────
    openTodayReorder() {
      if (this.run || this._movableKeys().length < 2) return;
      this.todayMode = "reorder"; this._reorderDraft = this._movableKeys(); this._reorderY = window.scrollY;   // 끝나면 보던 위치로
      document.querySelectorAll(".app-snack").forEach((n) => n.remove());
      this.renderToday(); window.scrollTo(0, 0);
    },
    renderTodayReorder(root) {
      const blocks = this.todayBlocks(), by = new Map(blocks.map((b) => [b.key, b]));
      const movable = new Set(this._movableKeys());
      const ids = (this._reorderDraft || []).filter((k) => movable.has(k));
      movable.forEach((k) => { if (!ids.includes(k)) ids.push(k); });
      this._reorderDraft = ids;
      const close = () => { this.todayMode = null; this._reorderDraft = null; this.renderToday(); };
      const done = () => {
        const cur = this._movableKeys();
        this.todayMode = null; this._reorderDraft = null;
        if (same(cur, ids)) { this.renderToday(); return; }
        const cmd = this._act("순서 변경", [["order"]], () => {
          const mov = new Set(ids), q = ids.slice();
          this.session.order = this.session.order.map((k) => (mov.has(k) ? q.shift() : k));
        });
        if (cmd) this.snack("오늘 순서를 바꿨어요. 루틴 순서는 그대로예요.", cmd);
      };
      const label = (b) => b.type === "group" ? "연속 세트 · " + b.guides.map((g) => (this.exercise(g.exerciseId) || {}).name).join(" + ") : this._blockName(b);
      root.appendChild(this._subHead("오늘 순서 변경", close, el("button", { class: "sub-action", type: "button", onclick: done }, "완료")));
      root.appendChild(el("div", { class: "rt-hint", text: "아직 시작하지 않은 운동만 옮길 수 있어요. ☰를 끌거나 ▲▼로 바꾸세요. 오늘만 바뀌고 저장된 루틴 순서는 그대로예요." }));
      const list = el("div", { class: "group-list reorder-list" });
      const icon = this._icon, ICO = this._ICO;
      const paint = () => {
        list.textContent = "";
        ids.forEach((id, i) => {
          const b = by.get(id);
          const handle = el("span", { class: "ro-handle", "aria-hidden": "true" }, [icon(ICO.grip)]);
          const row = el("div", { class: "gl-row ro-row" + (b.type === "group" ? " ro-group" : ""), "data-id": id }, [
            handle,
            el("span", { class: "gl-main", text: label(b) }),
            el("button", { class: "ro-btn", type: "button", "aria-label": `${label(b)} 위로`, disabled: i === 0 ? "" : null, onclick: () => { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; paint(); } }, [icon(ICO.up)]),
            el("button", { class: "ro-btn", type: "button", "aria-label": `${label(b)} 아래로`, disabled: i === ids.length - 1 ? "" : null, onclick: () => { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; paint(); } }, [icon(ICO.down)]),
          ]);
          this._wireReorderDrag(handle, row, list, () => { const next = [...list.children].map((r) => r.dataset.id); ids.splice(0, ids.length, ...next); paint(); });
          list.appendChild(row);
        });
      };
      paint();
      root.appendChild(list);
      const fixed = blocks.filter((b) => !movable.has(b.key));
      if (fixed.length) {
        root.appendChild(el("div", { class: "section-label", style: "margin:18px 2px 6px", text: "제자리 (완료 · 진행 중 · 생략)" }));
        root.appendChild(el("div", { class: "group-list" }, fixed.map((b) => el("div", { class: "gl-row ro-fixed" }, [el("span", { class: "gl-main", text: label(b) })]))));
      }
    },

    // ───────── 진행 중 세션 임시 저장 · 복구 ─────────
    _sessionMeaningful() {
      const s = this.session; if (!s) return false;
      if (this._hist.undo.length || this.hasSessionInput() || (s.extras && s.extras.length) || Object.keys(s.removed || {}).length) return true;
      return this.items().some((it) => it.res && (it.res.skipped || (it.res.notes || "").trim()));
    },
    _persist() {
      if (this.pendingRecovery || this.run || !this.session || this.sessionSaved) return;   // 수행 엔진 동작 중에는 직전 상태 유지
      if (!this._sessionMeaningful()) { this._clearSaved(); return; }
      const st = window.FitlogTimer.state;
      const rest = st && st.running ? { type: st.type, startedAt: st.startedAt, endsAt: st.endsAt, key: this.activeTimerExerciseId } : null;
      const items = this.items();
      const data = {
        v: 1, savedAt: new Date().toISOString(), date: isoDate(this.sessionDate), session: this.session, ended: !!this.ended,
        hist: this._hist, cmdSeq: this._cmdSeq, extraSeq: this._extraSeq, rest,
        summary: { name: (this.template(this.session.templateId) || {}).name || "", total: items.length, started: items.filter((it) => this._resStarted(it.res)).length },
      };
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { console.warn("[Fitlog] 진행 중 세션 임시 저장 실패", e); }
    },
    _loadSaved() {
      try {
        const raw = localStorage.getItem(SAVE_KEY); if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || d.v !== 1 || !d.session || !d.session.results || !this.template(d.session.templateId) || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || "")) { this._clearSaved(); return null; }
        return d;
      } catch (_) { this._clearSaved(); return null; }
    },
    _clearSaved() { try { localStorage.removeItem(SAVE_KEY); } catch (_) {} },
    renderRecovery(root) {
      const d = this.pendingRecovery, sm = d.summary || {};
      const dt = fromIso(d.date), isToday = d.date === isoDate(new Date());
      const when = isToday ? "오늘" : `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WEEKDAY_KO[WD_KEYS[dt.getDay()]]})`;
      root.appendChild(el("div", { class: "card recovery" }, [
        el("div", { class: "recovery-title", text: "진행 중이던 운동이 있어요." }),
        el("div", { class: "recovery-name", text: sm.name || (this.template(d.session.templateId) || {}).name || "" }),
        el("div", { class: "recovery-sub", text: `${when} · ${sm.total || 0}개 운동 중 ${sm.started || 0}개 진행` }),
        el("button", { class: "btn btn-primary btn-block btn-lg", type: "button", onclick: () => this.resumeSaved() }, "계속하기"),
        el("button", { class: "btn btn-ghost btn-block", type: "button", style: "margin-top:8px", onclick: () => {
          if (!window.confirm("진행 중이던 운동 입력을 지우고 새로 시작할까요?\n(저장된 기록과 루틴은 그대로예요)")) return;
          this._clearSaved(); this.pendingRecovery = null; this.renderToday();
        } }, "새로 시작"),
      ]));
    },
    async resumeSaved() {
      const d = this.pendingRecovery; if (!d) return;
      window.FitlogTimer.unlock();   // 사용자 탭 → 소리·화면 유지 언락
      this.pendingRecovery = null;
      this._resetRun();
      this.sessionDate = fromIso(d.date);
      this.session = d.session;
      if (!Array.isArray(this.session.extras)) this.session.extras = [];
      this.ended = !!d.ended; this.todayMode = null; this.sessionSaved = false;
      this._hist = d.hist && Array.isArray(d.hist.undo) && Array.isArray(d.hist.redo) ? d.hist : { undo: [], redo: [] };
      this._cmdSeq = Math.max(this._cmdSeq, d.cmdSeq || 0);
      const seqs = this.session.extras.map((x) => Number(String(x.exercise.id).replace(/^extra-/, "")) || 0);
      this._extraSeq = Math.max(this._extraSeq, d.extraSeq || 0, ...seqs);
      this._ensureSessionResults();
      // 휴식이 아직 남아 있었으면 남은 시간으로 이어서(실행 취소가 그 휴식을 알아보도록 시작 시각을 바꿔 둔다)
      const T = window.FitlogTimer, rest = d.rest;
      if (rest && rest.endsAt - Date.now() > 1000) {
        this.activeTimerExerciseId = rest.key;
        T.start(rest.type, Math.ceil((rest.endsAt - Date.now()) / 1000));
        [...this._hist.undo, ...this._hist.redo].forEach((c) => { if (c.fx && c.fx.rest && c.fx.rest.at === rest.startedAt) c.fx.rest.at = T.state.startedAt; });
      }
      await this.loadLastResults(this.session.templateId);
      this.renderToday(); window.scrollTo(0, 0);
    },
  });

  // 접힌 헤더의 ↶↷ + 스크롤에 따라 접힌 헤더 표시
  document.querySelectorAll("#today-mini .js-undo").forEach((b) => b.addEventListener("click", () => App.undo()));
  document.querySelectorAll("#today-mini .js-redo").forEach((b) => b.addEventListener("click", () => App.redo()));
  // 스크롤해 내려온 상태에서도 바로 운동 추가(v40) — 맨 위 "＋ 운동 추가"와 같은 동작
  document.querySelectorAll("#today-mini .js-mini-add").forEach((b) => b.addEventListener("click", () => App.addExtra()));
  document.querySelectorAll("#today-mini .js-mini-reorder").forEach((b) => b.addEventListener("click", () => App.openTodayReorder()));
  // 오늘 화면에서 누른 카드 기억(화면 위치 유지의 기준, v42) — 버튼 핸들러보다 먼저(캡처 단계)
  const vt = document.getElementById("view-today");
  if (vt) vt.addEventListener("click", (e) => { const c = e.target.closest && e.target.closest("[data-key]"); if (c && c.parentElement === vt) { App._tapKey = c.dataset.key; App._tapAt = Date.now(); } }, true);
  let miniRaf = 0;
  window.addEventListener("scroll", () => { if (!miniRaf) miniRaf = requestAnimationFrame(() => { miniRaf = 0; App._syncMini(); }); }, { passive: true });

  // 앱을 떠나거나 숨길 때도 한 번 더 저장(입력 중이던 메모·이름 포함)
  const flush = () => { try { App._persist(); } catch (_) {} };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  // 당겨서 새로고침 방지(iOS 보조 가드). CSS overscroll-behavior가 1차.
  // 문서가 맨 위이고, 손가락 아래 안쪽 스크롤 영역이 맨 위이며, 첫 움직임이 아래 방향 세로일 때만 그 제스처를 막는다.
  // 가로 스와이프·일반 스크롤·안쪽 스크롤·다이얼/드래그(Pointer Events)는 그대로.
  (function guardPullToRefresh() {
    let track = false, decided = false, block = false, sx = 0, sy = 0;
    const innerScrolled = (t) => {
      for (let n = t; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        if (n.scrollTop > 0) { const oy = getComputedStyle(n).overflowY; if (oy === "auto" || oy === "scroll") return true; }
      }
      return false;
    };
    document.addEventListener("touchstart", (e) => {
      decided = false; block = false;
      if (e.touches.length !== 1) { track = false; return; }
      const top = (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
      track = top && !innerScrolled(e.target);
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!track) return;
      if (!decided) {
        const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
        decided = true; block = dy > 0 && dy >= Math.abs(dx);
      }
      if (block && e.cancelable) e.preventDefault();
    }, { passive: false });
  })();
})();
