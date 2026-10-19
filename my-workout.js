/* my-workout.js — 내 운동 탭: 기록(주간·월간·기간 탐색) | 루틴(한 주간 루틴 = 언제, 내 루틴 = 무엇)
 * 데이터 구조는 그대로 재사용한다(스키마 변경 없음):
 *   routineTemplates = 루틴, routineGuides = 루틴 안의 운동, settings.dayTemplateMap = 요일 배정(null = 휴식)
 * 기록 요약(renderStats)·근육 히트맵(mountHeatmap)·기록 상세/수정/메모(renderHistoryDetail)·
 * 운동 편집기(renderGuideEditor)는 app.js의 기존 함수를 그대로 호출한다.
 * 의존: app.js(App, el, isoDate, WEEKDAY_KO, WD_KEYS) — app.js 다음, DOMContentLoaded 전에 로드
 */
(function () {
  const App = window.FitlogApp;
  const DAY_FULL = { sun: "일요일", mon: "월요일", tue: "화요일", wed: "수요일", thu: "목요일", fri: "금요일", sat: "토요일" };
  const WD_SHORT = ["일", "월", "화", "수", "목", "금", "토"];

  // 로컬 날짜 계산(UTC 변환 없음 — isoDate와 같은 기준)
  const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const weekStart = (d) => addDays(d, -d.getDay());   // 일요일 시작
  const md = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일`;
  function rangeText(start, end) {
    const a = fromIso(start), b = fromIso(end), y = new Date().getFullYear();
    const sameY = a.getFullYear() === b.getFullYear();
    const fa = (!sameY || a.getFullYear() !== y) ? `${a.getFullYear()}년 ${md(a)}` : md(a);
    const fb = !sameY ? `${b.getFullYear()}년 ${md(b)}` : md(b);
    return `${fa} - ${fb}`;
  }
  // 고정 문자열로만 만드는 작은 outline 아이콘(24×24, currentColor)
  function icon(inner, cls) {
    const t = document.createElement("span");
    t.innerHTML = `<svg class="${cls || "ui-ico"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    return t.firstChild;
  }
  const ICO = {
    back: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
    prev: '<path d="m14.5 6-6 6 6 6"/>',
    next: '<path d="m9.5 6 6 6-6 6"/>',
    chev: '<path d="m9.5 6 6 6-6 6"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
    grip: '<path d="M5 8h14M5 12h14M5 16h14"/>',
    up: '<path d="m6 14.5 6-6 6 6"/>',
    down: '<path d="m6 9.5 6 6 6-6"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  };

  Object.assign(App, {
    _icon: icon, _ICO: ICO,
    _histSeq: 0,

    // ───────── 공용: 하위 화면 헤더 · 토스트 ─────────
    _subHead(title, onBack, right) {
      return el("div", { class: "sub-head" }, [
        el("button", { class: "sub-back", type: "button", "aria-label": "뒤로", onclick: onBack }, [icon(ICO.back)]),
        el("div", { class: "sub-title", text: title }),
        right || el("span", { class: "sub-spacer" }),
      ]);
    },
    toast(msg) {
      const old = document.querySelector(".app-toast"); if (old) old.remove();
      const t = el("div", { class: "app-toast", role: "status", text: msg });
      document.body.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 1700);
    },

    // ───────── 내 운동 셸 ─────────
    enterMy(opts) {
      const m = this.my || (this.my = { tab: "history", screen: "home" });
      if (opts.fromNav) {
        // 하단 탭에서 새로 진입하면 항상 기록(오늘이 있는 주)부터
        Object.assign(m, { tab: "history", screen: "home", finder: null, draft: null, weekDraft: null, reorder: null });
        this.histNav = null; this.histEditEx = null; this.histCardioEdit = false; this.editingGuideId = null;
      } else if (opts.myTab) { m.tab = opts.myTab; m.screen = "home"; }
      this.renderMy();
      window.scrollTo(0, 0);
    },
    renderMy() {
      const m = this.my || (this.my = { tab: "history", screen: "home" });
      this._disposeExViewer();
      const head = document.getElementById("my-head");
      const hist = document.getElementById("view-history");
      const rout = document.getElementById("my-routine");
      const pushed = m.tab === "routine" && m.screen !== "home";   // 루틴 하위 화면은 자체 헤더(← 제목)
      head.hidden = pushed;
      if (!pushed) this._renderMyHead(head, m);
      hist.hidden = m.tab !== "history"; rout.hidden = m.tab !== "routine";
      if (m.tab === "history") { rout.textContent = ""; this.renderHistory(); }
      else { this._heatSeq++; this._destroyHeatmaps(); hist.textContent = ""; this.renderRoutine(rout); }
    },
    _renderMyHead(head, m) {
      head.textContent = "";
      const seg = (key, label) => el("button", { class: "seg-btn", type: "button", role: "tab", "aria-selected": m.tab === key ? "true" : "false",
        onclick: () => { if (m.tab === key && m.screen === "home") return; m.tab = key; m.screen = "home"; this.editingGuideId = null; this.renderMy(); window.scrollTo(0, 0); } }, label);
      head.appendChild(el("h1", { class: "page-title", text: "내 운동" }));
      head.appendChild(el("div", { class: "seg", role: "tablist" }, [seg("history", "기록"), seg("routine", "루틴")]));
    },

    // ═════════ 기록: 주간(기본) · 월간 달력(날짜 이동) · 기간 보기 ═════════
    _histNavState() {
      if (!this.histNav) this.histNav = { mode: "week", date: isoDate(new Date()), panel: null, month: null, period: null, preset: null, custom: null };
      return this.histNav;
    },
    async renderHistory() {
      this._destroyHeatmaps();   // 이전 히트맵 뷰어 정리 후 재구성(컨텍스트 누수 방지)
      const seq = ++this._histSeq;
      const root = document.getElementById("view-history"); root.textContent = "";
      if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 저장을 쓸 수 없어요." })); return; }
      let sessions = [];
      try { sessions = await window.FitlogDB.DB.recentSessions(); } catch (e) { console.warn(e); }
      if (seq !== this._histSeq || this.view !== "my") return;   // 그 사이 화면이 바뀜
      this._histSessions = sessions;
      this._histDates = new Set(sessions.map((s) => s.date));
      root.textContent = "";
      this._histNavHost = el("div", { class: "hist-nav-host" });
      this._histContentHost = el("div", { class: "hist-content" });
      root.appendChild(this._histNavHost); root.appendChild(this._histContentHost);
      this._paintHistNav(); this._paintHistContent();
    },
    // 날짜 탐색 영역만 다시 그린다(패널 열기·월 이동은 아래 기록/3D를 건드리지 않음)
    _paintHistNav() {
      const host = this._histNavHost; if (!host) return;
      const nav = this._histNavState(), dates = this._histDates || new Set();
      host.textContent = "";
      host.appendChild(this._histNavBar(nav));
      if (nav.panel === "calendar") host.appendChild(this._histCalendar(nav, dates));
      else if (nav.panel === "period") host.appendChild(this._histPeriodPanel(nav));
      else if (nav.mode === "week") host.appendChild(this._histWeekStrip(nav, dates));
    },
    // 선택 날짜/기간 기준 기존 콘텐츠: 운동 요약 → 근육별 3D 현황 → 기록 카드
    _paintHistContent() {
      const host = this._histContentHost; if (!host) return;
      this._heatSeq++; this._destroyHeatmaps();
      host.textContent = "";
      const nav = this._histNavState(), sessions = this._histSessions || [];
      if (!sessions.length) { host.appendChild(el("div", { class: "placeholder", text: "아직 저장된 운동이 없어요. 오늘 운동을 저장하면 여기에 날짜별로 쌓여요." })); return; }
      const range = nav.mode === "period" ? nav.period : { start: nav.date, end: nav.date };
      const inRange = sessions.filter((s) => this.inRange(s.date, range));
      if (!inRange.length) {
        host.appendChild(el("div", { class: "placeholder", text: nav.mode === "period" ? "선택한 기간에 저장된 운동이 없어요." : "이 날짜에는 저장된 운동이 없어요." }));
        return;
      }
      host.appendChild(this.renderStats(inRange, range));
      // 근육 히트맵 카드 (기간 연동). 컨테이너를 먼저 붙이고 비동기로 채운다(기록 목록을 막지 않음).
      const heatHost = el("div", { class: "heat-host" });
      host.appendChild(heatHost);
      this.mountHeatmap(heatHost, inRange, range, {});
      host.appendChild(el("div", { class: "section-label", text: nav.mode === "period" ? `운동 기록 · ${inRange.length}회` : "운동 기록" }));
      inRange.forEach((s) => host.appendChild(this._histRow(s)));   // 최신순(날짜별로 이어짐)
    },
    // 날짜별 기록 카드(기존 목록 행 그대로). 탭하면 기존 상세(수정·메모·삭제)로.
    _histRow(s) {
      const tpl = this.template(s.templateId); const name = tpl ? tpl.name : (s.templateId || "운동");
      const mdTxt = s.date.slice(5).replace("-", "/"); const wk = WEEKDAY_KO[s.weekday] || "";
      const req = (s.exerciseResults || []).filter((r) => !r.adhoc);
      const doneN = req.filter((r) => r.status === "completed" || r.status === "progression_candidate").length;
      const hasCardio = s.cardio || (s.exerciseResults || []).some((r) => r.kind === "cardio" && r.cardioActual);
      return el("button", { class: "hist-row", onclick: () => { this.histEditEx = null; this.histCardioEdit = false; this._heatSeq++; this.renderHistoryDetail(s.id); window.scrollTo(0, 0); } }, [
        el("span", { class: "h-date", text: `${mdTxt} ${wk}` }), el("span", { class: "h-name", text: name }),
        el("span", { class: "h-status", text: `${doneN}/${req.length}${hasCardio ? " · 유산소" : ""}` }),
      ]);
    },
    _selectHistDate(iso) {
      const nav = this._histNavState();
      nav.date = iso; nav.mode = "week"; nav.panel = null;
      this._paintHistNav(); this._paintHistContent();
    },
    _histNavBar(nav) {
      const isWeek = nav.mode === "week";
      let label;
      if (isWeek) { const ws = weekStart(fromIso(nav.date)); label = rangeText(isoDate(ws), isoDate(addDays(ws, 6))); }
      else label = rangeText(nav.period.start, nav.period.end);
      const shift = (n) => this._selectHistDate(isoDate(addDays(fromIso(nav.date), 7 * n)));
      const left = isWeek
        ? [el("button", { class: "hn-chev", type: "button", "aria-label": "지난주", onclick: () => shift(-1) }, [icon(ICO.prev)]),
           el("div", { class: "hn-label", text: label }),
           el("button", { class: "hn-chev", type: "button", "aria-label": "다음주", onclick: () => shift(1) }, [icon(ICO.next)])]
        : [el("div", { class: "hn-label", text: label }),
           el("button", { class: "hn-exit", type: "button", onclick: () => { nav.mode = "week"; nav.panel = null; this._paintHistNav(); this._paintHistContent(); } }, "주간 보기")];
      const calOpen = nav.panel === "calendar";
      const calBtn = el("button", { class: "hn-btn" + (calOpen ? " on" : ""), type: "button", "aria-label": "월간 달력", "aria-expanded": calOpen ? "true" : "false",
        onclick: () => {
          if (calOpen) nav.panel = null;
          else { const base = fromIso(nav.mode === "period" ? nav.period.end : nav.date); nav.month = new Date(base.getFullYear(), base.getMonth(), 1); nav.panel = "calendar"; }
          this._paintHistNav();
        } }, [icon(ICO.cal)]);
      const perOpen = nav.panel === "period";
      const perBtn = el("button", { class: "hn-btn hn-btn-text" + (perOpen || nav.mode === "period" ? " on" : ""), type: "button", "aria-expanded": perOpen ? "true" : "false",
        onclick: () => { nav.panel = perOpen ? null : "period"; this._paintHistNav(); } }, "기간");
      return el("div", { class: "hist-nav" }, [el("div", { class: "hn-left" }, left), el("div", { class: "hn-right" }, [calBtn, perBtn])]);
    },
    _histWeekStrip(nav, dates) {
      const sel = nav.date, today = isoDate(new Date());
      const ws = weekStart(fromIso(sel));
      const strip = el("div", { class: "week-strip" });
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i), iso = isoDate(d), has = dates.has(iso);
        strip.appendChild(el("button", {
          class: "wk-day" + (iso === sel ? " sel" : "") + (iso === today ? " today" : ""), type: "button",
          "aria-pressed": iso === sel ? "true" : "false",
          "aria-label": `${md(d)} ${WD_SHORT[i]}요일${iso === today ? " 오늘" : ""}${has ? " 기록 있음" : ""}`,
          onclick: () => { if (Date.now() - (this._wkSwipedAt || 0) < 400) return; this._selectHistDate(iso); },
        }, [
          el("span", { class: "wk-wd", text: WD_SHORT[i] }),
          el("span", { class: "wk-num", text: String(d.getDate()) }),
          el("span", { class: "wk-dot" + (has ? " on" : "") }),
        ]));
      }
      // 좌우 스와이프로 주 이동(세로 스크롤은 방해하지 않음 — 기존 스와이프 판정 재사용)
      const swipe = (n) => { this._wkSwipedAt = Date.now(); this._selectHistDate(isoDate(addDays(fromIso(nav.date), 7 * n))); };
      this.wireHeatSwipe(strip, () => swipe(1), () => swipe(-1));
      return strip;
    },
    _histCalendar(nav, dates) {
      const cur = nav.month || new Date(fromIso(nav.date).getFullYear(), fromIso(nav.date).getMonth(), 1);
      const y = cur.getFullYear(), mo = cur.getMonth();
      const today = isoDate(new Date()), sel = nav.mode === "week" ? nav.date : null;
      const go = (n) => { nav.month = new Date(y, mo + n, 1); this._paintHistNav(); };
      const grid = el("div", { class: "cal-grid" });
      WD_SHORT.forEach((w) => grid.appendChild(el("span", { class: "cal-wd", text: w })));
      const first = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate();
      for (let i = 0; i < first; i++) grid.appendChild(el("span", { class: "cal-blank" }));
      for (let d = 1; d <= days; d++) {
        const iso = isoDate(new Date(y, mo, d));
        grid.appendChild(el("button", { class: "cal-day" + (iso === sel ? " sel" : "") + (iso === today ? " today" : ""), type: "button",
          "aria-label": `${mo + 1}월 ${d}일${dates.has(iso) ? " 기록 있음" : ""}`, onclick: () => this._selectHistDate(iso) }, [
          el("span", { class: "wk-num", text: String(d) }), el("span", { class: "wk-dot" + (dates.has(iso) ? " on" : "") }),
        ]));
      }
      return el("div", { class: "cal-panel" }, [
        el("div", { class: "cal-head" }, [
          el("button", { class: "hn-chev", type: "button", "aria-label": "이전 달", onclick: () => go(-1) }, [icon(ICO.prev)]),
          el("div", { class: "cal-title", text: `${y}년 ${mo + 1}월` }),
          el("button", { class: "hn-chev", type: "button", "aria-label": "다음 달", onclick: () => go(1) }, [icon(ICO.next)]),
        ]),
        grid,
      ]);
    },
    _periodPreset(key) {
      const t = new Date(), y = t.getFullYear(), m = t.getMonth(), d = t.getDate();
      let a, b;
      if (key === "4w") { a = addDays(t, -27); b = t; }
      else if (key === "thisMonth") { a = new Date(y, m, 1); b = new Date(y, m + 1, 0); }
      else if (key === "lastMonth") { a = new Date(y, m - 1, 1); b = new Date(y, m, 0); }
      else if (key === "3m") { a = new Date(y, m - 3, d + 1); b = t; }
      else return null;
      return { start: isoDate(a), end: isoDate(b) };
    },
    _applyPeriod(range, key) {
      const nav = this._histNavState();
      Object.assign(nav, { mode: "period", period: range, preset: key, panel: null });
      this.historyRange = { start: range.start, end: range.end }; this.saveHistoryRange();   // AI 코치 '기록 기간 가져오기'와 공유
      this._paintHistNav(); this._paintHistContent();
      window.scrollTo(0, 0);
    },
    _histPeriodPanel(nav) {
      const opts = [["4w", "최근 4주"], ["thisMonth", "이번 달"], ["lastMonth", "지난 달"], ["3m", "최근 3개월"]];
      const box = el("div", { class: "period-panel group-list" });
      const cur = nav.mode === "period" ? nav.preset : null;
      opts.forEach(([k, label]) => {
        const r = this._periodPreset(k);
        box.appendChild(el("button", { class: "gl-row period-opt" + (cur === k ? " on" : ""), type: "button", onclick: () => this._applyPeriod(r, k) }, [
          el("span", { class: "gl-main", text: label }), el("span", { class: "gl-val", text: rangeText(r.start, r.end) }),
        ]));
      });
      const customOpen = !!nav.custom;
      box.appendChild(el("button", { class: "gl-row period-opt" + (cur === "custom" ? " on" : ""), type: "button", "aria-expanded": customOpen ? "true" : "false",
        onclick: () => {
          if (customOpen) nav.custom = null;
          else { const base = nav.mode === "period" ? nav.period : this._periodPreset("4w"); nav.custom = { start: base.start, end: base.end }; }
          this._paintHistNav();
        } }, [el("span", { class: "gl-main", text: "직접 설정" }), icon(customOpen ? ICO.up : ICO.down, "ui-ico gl-chev")]));
      if (customOpen) {
        const c = nav.custom;
        const sIn = el("input", { type: "date", class: "range-date", value: c.start, "aria-label": "시작일" });
        const eIn = el("input", { type: "date", class: "range-date", value: c.end, "aria-label": "종료일" });
        const err = el("div", { class: "range-err", hidden: true });
        sIn.addEventListener("change", () => { c.start = sIn.value; err.hidden = true; });
        eIn.addEventListener("change", () => { c.end = eIn.value; err.hidden = true; });
        box.appendChild(el("div", { class: "period-custom" }, [
          el("div", { class: "range-grid" }, [
            el("div", { class: "range-cell" }, [el("label", { text: "시작일" }), sIn]),
            el("div", { class: "range-cell" }, [el("label", { text: "종료일" }), eIn]),
          ]),
          err,
          el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => {
            const s = sIn.value || c.start, e = eIn.value || c.end;
            if (!s || !e) { err.textContent = "날짜를 선택하세요."; err.hidden = false; return; }
            if (s > e) { err.textContent = "시작일이 종료일보다 늦어요. 날짜를 다시 선택하세요."; err.hidden = false; return; }
            nav.custom = null; this._applyPeriod({ start: s, end: e }, "custom");
          } }, "이 기간 보기"),
        ]));
      }
      return box;
    },

    // ═════════ 루틴: 한 주간 루틴(언제) + 내 루틴(무엇) ═════════
    renderRoutine(root) {
      const m = this.my;
      root.textContent = "";
      if (!this.dbReady) { root.appendChild(el("div", { class: "placeholder", text: "이 브라우저에서 편집/저장을 쓸 수 없어요." })); return; }
      if (m.screen === "week") return this._routineWeekEdit(root, m);
      if (m.screen === "weekDay") return this._routineWeekDay(root, m);
      if (m.screen === "new") return this._routineNew(root, m);
      if (m.screen === "finder" && m.finder) { m.finder.root = root; return this.renderFinder(m.finder); }
      if (m.screen === "detail" || m.screen === "reorder") {
        const t = this.template(m.routineId);
        if (!t) { m.screen = "home"; return this._routineHome(root, m); }
        this.guideEditTemplateId = t.id;   // 기존 편집기의 ▲▼ 이동이 참조
        if (m.screen === "reorder") return this._routineReorder(root, m, t);
        if (this.editingGuideId) return this._routineGuideEdit(root, m, t);
        return this._routineDetail(root, m, t);
      }
      m.screen = "home";
      return this._routineHome(root, m);
    },
    _goRoutine(screen, patch) { Object.assign(this.my, patch || {}, { screen }); this.renderMy(); window.scrollTo(0, 0); },
    _routineName(id) { const t = id ? this.template(id) : null; return t ? t.name : "휴식"; },

    _routineHome(root, m) {
      const map = this.settings.dayTemplateMap || {};
      root.appendChild(el("div", { class: "rt-sec-head" }, [
        el("h2", { class: "rt-sec-title", text: "한 주간 루틴" }),
        el("button", { class: "rt-link", type: "button", onclick: () => this._goRoutine("week", { weekDraft: { ...map } }) }, ["편집", icon(ICO.chev, "ui-ico rt-link-ico")]),
      ]));
      const week = el("div", { class: "group-list week-list" });
      WD_KEYS.forEach((k) => {
        const rest = !(map[k] && this.template(map[k]));
        week.appendChild(el("div", { class: "gl-row static" }, [
          el("span", { class: "gl-day", text: DAY_FULL[k] }),
          el("span", { class: "gl-val" + (rest ? " rest" : ""), text: this._routineName(rest ? null : map[k]) }),
        ]));
      });
      root.appendChild(week);

      root.appendChild(el("div", { class: "rt-sec-head rt-sec-gap" }, [el("h2", { class: "rt-sec-title", text: "내 루틴" })]));
      const list = el("div", { class: "group-list" });
      this.templates.forEach((t) => {
        const n = this.guidesOf(t.id).length;
        list.appendChild(el("button", { class: "gl-row", type: "button", onclick: () => { this.editingGuideId = null; this._goRoutine("detail", { routineId: t.id }); } }, [
          el("span", { class: "gl-stack" }, [el("span", { class: "gl-title", text: t.name }), el("span", { class: "gl-sub", text: `${n}개 운동` })]),
          icon(ICO.chev, "ui-ico gl-chev"),
        ]));
      });
      list.appendChild(el("button", { class: "gl-row gl-add", type: "button", onclick: () => this._goRoutine("new", { draft: { name: "", items: [] } }) }, "＋ 새 루틴"));
      root.appendChild(list);
    },

    // 한 주간 루틴 편집: 요일마다 저장된 루틴 하나(또는 휴식). 같은 루틴을 여러 요일에 배정해도 된다.
    _routineWeekEdit(root, m) {
      const draft = m.weekDraft || (m.weekDraft = { ...(this.settings.dayTemplateMap || {}) });
      const saved = this.settings.dayTemplateMap || {};
      const dirty = WD_KEYS.some((k) => (draft[k] || null) !== (saved[k] || null));
      root.appendChild(this._subHead("한 주간 루틴", () => {
        if (dirty && !window.confirm("저장하지 않은 요일 배정이 있어요. 저장하지 않고 나갈까요?")) return;
        this._goRoutine("home", { weekDraft: null });
      }));
      root.appendChild(el("div", { class: "rt-hint", text: "요일별로 사용할 루틴을 선택하세요." }));
      const list = el("div", { class: "group-list week-list" });
      WD_KEYS.forEach((k) => {
        const id = draft[k] && this.template(draft[k]) ? draft[k] : null;
        list.appendChild(el("button", { class: "gl-row", type: "button", onclick: () => this._goRoutine("weekDay", { weekDay: k }) }, [
          el("span", { class: "gl-day", text: DAY_FULL[k] }),
          el("span", { class: "gl-val" + (id ? "" : " rest"), text: this._routineName(id) }),
          icon(ICO.chev, "ui-ico gl-chev"),
        ]));
      });
      root.appendChild(list);
      root.appendChild(el("button", { class: "btn btn-primary btn-block rt-save", type: "button", onclick: () => {
        const next = {};
        WD_KEYS.forEach((k) => { next[k] = draft[k] && this.template(draft[k]) ? draft[k] : null; });
        this.settings.dayTemplateMap = next;
        this.persistSettings();
        this._syncTodayAfterMapChange();
        this._goRoutine("home", { weekDraft: null });
        this.toast("한 주간 루틴을 저장했어요");
      } }, "저장"));
    },
    _routineWeekDay(root, m) {
      const k = m.weekDay, draft = m.weekDraft || {};
      const cur = draft[k] && this.template(draft[k]) ? draft[k] : null;
      root.appendChild(this._subHead(`${DAY_FULL[k]} 루틴`, () => this._goRoutine("week")));
      const list = el("div", { class: "group-list", role: "radiogroup", "aria-label": `${DAY_FULL[k]} 루틴` });
      const opt = (id, label) => list.appendChild(el("button", { class: "gl-row radio-row", type: "button", role: "radio", "aria-checked": cur === id ? "true" : "false",
        onclick: () => { draft[k] = id; this._goRoutine("week"); } }, [el("span", { class: "radio-dot" }), el("span", { class: "gl-main", text: label })]));
      opt(null, "휴식");
      this.templates.forEach((t) => opt(t.id, t.name));
      root.appendChild(list);
    },
    // 요일 배정이 바뀌면, 오늘 아직 아무것도 입력하지 않은 세션은 새 배정 루틴으로 바꿔 둔다.
    _syncTodayAfterMapChange() {
      if (!this.session || this.ended || this.hasSessionInput()) return;
      if (isoDate(this.sessionDate) !== isoDate(new Date())) return;
      const want = this.settings.dayTemplateMap[WD_KEYS[new Date().getDay()]] || (this.templates[0] && this.templates[0].id);
      if (want && want !== this.session.templateId && this.template(want)) { this.startSession(want); this.loadLastResults(want); }
    },

    // 루틴 상세: 운동 = 무엇. 요일은 표시하지 않는다.
    _routineDetail(root, m, t) {
      const guides = this.guidesOf(t.id);
      const menuBtn = el("button", { class: "sub-more", type: "button", "aria-label": "루틴 옵션", "aria-haspopup": "menu" }, [icon(ICO.more)]);
      const head = this._subHead(t.name, () => this._goRoutine("home"), menuBtn);
      const menu = this._routineMenu(m, t);
      menu.hidden = true;
      head.appendChild(menu);   // 헤더 기준 겹쳐 뜨는 작은 메뉴(본문을 밀지 않음)
      root.appendChild(head);
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        if (!menu.hidden) {
          // 바깥을 누르면 메뉴만 닫는다(아래 행이 함께 눌리지 않도록 그 클릭은 소비)
          const off = (ev) => {
            if (menu.contains(ev.target)) return;
            menu.hidden = true; document.removeEventListener("click", off, true);
            if (menu.isConnected) { ev.stopPropagation(); ev.preventDefault(); }
          };
          setTimeout(() => document.addEventListener("click", off, true), 0);
        }
      });
      root.appendChild(el("div", { class: "rt-count", text: `${guides.length}개 운동` }));
      const list = el("div", { class: "group-list" });
      if (!guides.length) list.appendChild(el("div", { class: "gl-empty", text: "아직 운동이 없어요. 아래에서 추가하세요." }));
      guides.forEach((g) => {
        const ex = this.exercise(g.exerciseId); if (!ex) return;
        const line = this.guideLine(ex, g, false).replace(/^(가이드|목표)\s+/, "");
        list.appendChild(el("div", { class: "gl-row ex-row" }, [
          el("button", { class: "ex-row-main", type: "button", onclick: () => this._openRoutineExercise(m, ex) }, [
            el("span", { class: "gl-stack" }, [
              el("span", { class: "gl-title" }, [ex.name, g.optional ? el("span", { class: "gl-tag", text: "선택" }) : null, ex.warmupEnabled ? el("span", { class: "gl-tag", text: "워밍업" }) : null]),
              el("span", { class: "gl-sub", text: line }),
            ]),
            icon(ICO.chev, "ui-ico gl-chev"),
          ]),
          el("button", { class: "ex-row-edit", type: "button", "aria-label": `${ex.name} 편집`, onclick: () => { this.editingGuideId = g.id; this.renderMy(); window.scrollTo(0, 0); } }, "편집"),
        ]));
      });
      root.appendChild(list);
      root.appendChild(el("button", { class: "btn btn-block rt-add-ex", type: "button", onclick: () => {
        this._goRoutine("finder", { finder: this.newFinderCtx({ mode: "addToRoutine", target: { id: t.id }, onExit: () => this._goRoutine("detail", { finder: null }) }) });
      } }, "＋ 운동 추가"));
    },
    // 루틴 운동 행 → 공용 운동 상세(3D·근육·설명). 뒤로 가면 루틴 상세.
    _openRoutineExercise(m, ex) {
      const catId = this.appExerciseCatalogId(ex);
      this._goRoutine("finder", { finder: this.newFinderCtx({ mode: "browse", screen: "detail", detail: { catId, exId: ex.id }, onExit: () => this._goRoutine("detail", { finder: null }) }) });
    },
    // 기존 가이드 편집기(중량·세트·반복·선택·워밍업·메모·▲▼·제거)를 그대로 쓴다. 저장/취소 후 renderGuide → 루틴 상세.
    _routineGuideEdit(root, m, t) {
      const guides = this.guidesOf(t.id);
      const idx = guides.findIndex((g) => g.id === this.editingGuideId);
      const g = guides[idx], ex = g && this.exercise(g.exerciseId);
      if (!g || !ex) { this.editingGuideId = null; return this._routineDetail(root, m, t); }
      root.appendChild(this._subHead("운동 편집", () => { this.editingGuideId = null; this.renderMy(); }));
      root.appendChild(this.renderGuideEditor(g, ex, idx, guides.length));
    },
    _routineMenu(m, t) {
      const item = (label, fn, cls) => el("button", { class: "rt-menu-item" + (cls ? " " + cls : ""), type: "button", role: "menuitem", onclick: fn }, label);
      return el("div", { class: "rt-menu", role: "menu" }, [
        item("이름 변경", () => this.renameRoutine(t.id)),
        item("운동 순서 변경", () => this._goRoutine("reorder", { reorder: this.guidesOf(t.id).map((g) => g.id) })),
        item("루틴 복제", () => this.duplicateRoutine(t.id)),
        item("루틴 삭제", () => this.deleteRoutine(t.id), "danger"),
      ]);
    },
    async renameRoutine(id) {
      const t = this.template(id); if (!t) return;
      const name = (window.prompt("루틴 이름", t.name) || "").trim(); if (!name || name === t.name) { this.renderMy(); return; }
      t.name = name;
      try { await window.FitlogDB.DB.put("routineTemplates", t); await this.reloadDefs(); } catch (e) { console.error(e); }
      this.renderMy();
    },
    async duplicateRoutine(id) {
      const t = this.template(id); if (!t) return;
      const nid = "tpl-" + Date.now();
      const order = Math.max(0, ...this.templates.map((x) => x.order || 0)) + 1;
      const DB = window.FitlogDB.DB;
      try {
        await DB.put("routineTemplates", { id: nid, name: `${t.name} 복사본`, order, active: true });
        const gs = this.guidesOf(id);
        for (let i = 0; i < gs.length; i++) {
          const copy = JSON.parse(JSON.stringify(gs[i]));
          copy.id = `g-${copy.exerciseId}-${Date.now()}-${i}`; copy.templateId = nid;
          await DB.put("routineGuides", copy);
        }
        await this.reloadDefs();
      } catch (e) { console.error("[Fitlog] 루틴 복제 실패", e); window.alert("복제 중 오류가 발생했어요."); return; }
      this._goRoutine("detail", { routineId: nid });
      this.toast("루틴을 복제했어요");
    },
    async deleteRoutine(id) {
      const t = this.template(id); if (!t) return;
      if (this.templates.length <= 1) { window.alert("루틴은 최소 1개 필요해요."); this.renderMy(); return; }
      if (this.session && this.session.templateId === id && this.hasSessionInput()) {
        window.alert("오늘 진행 중인 운동이 이 루틴을 사용하고 있어요. 오늘 운동을 저장하거나 다른 루틴으로 바꾼 뒤 삭제하세요."); this.renderMy(); return;
      }
      if (!window.confirm(`'${t.name}' 루틴을 삭제할까요?\n배정된 요일은 휴식으로 바뀌고, 지난 운동 기록은 그대로 남아요.`)) { this.renderMy(); return; }
      try {
        for (const g of this.guidesOf(id)) await window.FitlogDB.DB.delete("routineGuides", g.id);
        await window.FitlogDB.DB.delete("routineTemplates", id);
        const map = this.settings.dayTemplateMap; let changed = false;
        for (const k of Object.keys(map)) if (map[k] === id) { map[k] = null; changed = true; }
        if (changed) this.persistSettings();
        await this.reloadDefs();
      } catch (e) { console.error(e); }
      if (this.session && this.session.templateId === id) {   // 입력 없는 오늘 세션은 남은 루틴으로
        const want = this.settings.dayTemplateMap[WD_KEYS[new Date().getDay()]] || this.templates[0].id;
        this.startSession(want); this.loadLastResults(want);
      }
      this._goRoutine("home");
      this.toast("루틴을 삭제했어요");
    },

    // 운동 순서 변경: ☰ 손잡이를 Pointer Events로 끌기(iPhone 터치 포함) + ▲▼ 보조 버튼. 완료 시 한 번에 저장.
    _routineReorder(root, m, t) {
      const ids = (m.reorder || []).filter((id) => this.guidesOf(t.id).some((g) => g.id === id));
      m.reorder = ids;
      const done = async () => {
        const DB = window.FitlogDB.DB;
        try {
          for (let i = 0; i < ids.length; i++) {
            const g = this.guides.find((x) => x.id === ids[i]);
            if (g && g.order !== i + 1) { g.order = i + 1; await DB.put("routineGuides", g); }
          }
          await this.reloadDefs();
        } catch (e) { console.error("[Fitlog] 순서 저장 실패", e); }
        this._goRoutine("detail", { reorder: null });
      };
      root.appendChild(this._subHead("운동 순서 변경", () => this._goRoutine("detail", { reorder: null }),
        el("button", { class: "sub-action", type: "button", onclick: done }, "완료")));
      root.appendChild(el("div", { class: "rt-hint", text: "☰를 눌러 끌거나 ▲▼로 순서를 바꾸세요." }));
      const list = el("div", { class: "group-list reorder-list" });
      const paint = () => {
        list.textContent = "";
        ids.forEach((id, i) => {
          const g = this.guides.find((x) => x.id === id), ex = g && this.exercise(g.exerciseId);
          const handle = el("span", { class: "ro-handle", "aria-hidden": "true" }, [icon(ICO.grip)]);
          const row = el("div", { class: "gl-row ro-row", "data-id": id }, [
            handle,
            el("span", { class: "gl-main", text: ex ? ex.name : id }),
            el("button", { class: "ro-btn", type: "button", "aria-label": "위로", disabled: i === 0 ? "" : null, onclick: () => { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; paint(); } }, [icon(ICO.up)]),
            el("button", { class: "ro-btn", type: "button", "aria-label": "아래로", disabled: i === ids.length - 1 ? "" : null, onclick: () => { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; paint(); } }, [icon(ICO.down)]),
          ]);
          this._wireReorderDrag(handle, row, list, () => { const next = [...list.children].map((r) => r.dataset.id); ids.splice(0, ids.length, ...next); paint(); });
          list.appendChild(row);
        });
      };
      paint();
      root.appendChild(list);
    },
    _wireReorderDrag(handle, row, list, onDrop) {
      let pid = null, startY = 0;
      handle.addEventListener("pointerdown", (e) => {
        if (pid !== null) return;
        pid = e.pointerId; startY = e.clientY;
        try { handle.setPointerCapture(pid); } catch (_) {}
        row.classList.add("dragging"); e.preventDefault();
      });
      handle.addEventListener("pointermove", (e) => {
        if (e.pointerId !== pid) return;
        e.preventDefault();
        let dy = e.clientY - startY;
        const prev = row.previousElementSibling, next = row.nextElementSibling;
        const swap = (other, before) => {
          const top0 = row.offsetTop;
          list.insertBefore(row, before);
          startY += row.offsetTop - top0;   // 레이아웃 이동만큼 기준점 보정 → 손가락 아래 유지
          dy = e.clientY - startY;
        };
        if (next && dy > next.offsetHeight / 2) swap(next, next.nextElementSibling);
        else if (prev && -dy > prev.offsetHeight / 2) swap(prev, prev);
        row.style.transform = `translateY(${dy}px)`;
      });
      const end = (e) => {
        if (e.pointerId !== pid) return;
        pid = null; row.style.transform = ""; row.classList.remove("dragging");
        onDrop();
      };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },

    // 새 루틴: 이름 먼저. 저장 전까지 운동은 메모리 draft에만(저장 안 한 루틴의 고아 데이터 방지).
    _routineNew(root, m) {
      const draft = m.draft || (m.draft = { name: "", items: [] });
      const dirty = () => !!(draft.name.trim() || draft.items.length);
      root.appendChild(this._subHead("새 루틴", () => {
        if (dirty() && !window.confirm("작성 중인 새 루틴을 저장하지 않고 나갈까요?")) return;
        this._goRoutine("home", { draft: null });
      }));
      const nameIn = el("input", { type: "text", class: "text-input", value: draft.name, placeholder: "예: 등 · 어깨 · 이두", maxlength: "40", autocomplete: "off",
        oninput: (e) => { draft.name = e.target.value; err.hidden = true; } });
      const err = el("div", { class: "range-err", hidden: true });
      root.appendChild(el("label", { class: "field-label", text: "루틴 이름" }));
      root.appendChild(nameIn);
      root.appendChild(err);
      root.appendChild(el("div", { class: "rt-sec-head rt-sec-gap" }, [el("h2", { class: "rt-sec-title", text: "운동" })]));
      const list = el("div", { class: "group-list" });
      if (!draft.items.length) list.appendChild(el("div", { class: "gl-empty", text: "아직 추가한 운동이 없습니다." }));
      draft.items.forEach((it, i) => {
        const info = this._draftItemInfo(it);
        list.appendChild(el("div", { class: "gl-row" }, [
          el("span", { class: "gl-stack" }, [el("span", { class: "gl-title", text: info.name }), el("span", { class: "gl-sub", text: info.sub })]),
          el("button", { class: "ro-btn", type: "button", "aria-label": `${info.name} 빼기`, onclick: () => { draft.items.splice(i, 1); this.renderMy(); } }, [icon(ICO.x)]),
        ]));
      });
      root.appendChild(list);
      const needName = () => {
        if (draft.name.trim()) return false;
        err.textContent = "루틴 이름을 먼저 입력하세요."; err.hidden = false; nameIn.focus(); return true;
      };
      root.appendChild(el("button", { class: "btn btn-block rt-add-ex", type: "button", onclick: () => {
        if (needName()) return;
        this._goRoutine("finder", { finder: this.newFinderCtx({ mode: "addToRoutine", target: { draft }, onExit: () => this._goRoutine("new", { finder: null }) }) });
      } }, "＋ 운동 추가"));
      root.appendChild(el("button", { class: "btn btn-primary btn-block rt-save", type: "button", onclick: async (e) => {
        if (needName()) return;
        const btn = e.currentTarget; btn.disabled = true;
        const id = await this.saveNewRoutine(draft);
        if (!id) { btn.disabled = false; window.alert("저장 중 오류가 발생했어요."); return; }
        this._goRoutine("detail", { draft: null, routineId: id });
        this.toast("새 루틴을 만들었어요");
      } }, "저장"));
      if (!draft.name) setTimeout(() => { try { nameIn.focus(); } catch (_) {} }, 60);
    },
    _draftItemInfo(it) {
      if (it.catId) { const c = this.catalogById(it.catId); return { name: (c && c.label_ko) || it.catId, sub: c ? this.categoryLabel(c.category) + (c.equipment ? " · " + this._equipLabel(c.equipment) : "") : "" }; }
      if (it.exId) { const ex = this.exercise(it.exId); return { name: (ex && ex.name) || it.exId, sub: "내 운동" }; }
      if (it.custom) return { name: it.custom.name, sub: it.custom.type === "cardio" ? "직접 만든 유산소" : "직접 만든 운동" };
      return { name: "", sub: "" };
    },
    async saveNewRoutine(draft) {
      const id = "tpl-" + Date.now();
      const order = Math.max(0, ...this.templates.map((t) => t.order || 0)) + 1;
      try {
        await window.FitlogDB.DB.put("routineTemplates", { id, name: draft.name.trim(), order, active: true });
        await this.reloadDefs();
        for (const it of draft.items) await this._addItemToRoutine(id, it);
        await this.reloadDefs();
        return id;
      } catch (e) { console.error("[Fitlog] 새 루틴 저장 실패", e); return null; }
    },
  });

  // 입력 중에는 하단 탭바를 숨겨 키보드·검색창과 겹치지 않게 한다(iOS는 키보드가 떠도 fixed 요소 위치를 바꾸지 않음).
  const typing = (t) => t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !/^(checkbox|radio|button|file|range)$/i.test(t.type)));
  // 포커스된 입력칸이 재렌더로 DOM에서 빠지면 focusout이 오지 않을 수 있어, 탭 직후에도 다시 확인한다.
  const syncTyping = () => { const a = document.activeElement; document.body.classList.toggle("is-typing", !!(typing(a) && a.isConnected)); };
  document.addEventListener("focusin", (e) => { if (typing(e.target)) document.body.classList.add("is-typing"); });
  document.addEventListener("focusout", () => setTimeout(syncTyping, 0));
  document.addEventListener("click", () => setTimeout(syncTyping, 60), true);
})();
