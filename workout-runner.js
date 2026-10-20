/* workout-runner.js — 시간형 운동 · 좌우 운동 · 연속 세트
 * 세 가지를 분리한다:
 *   운동(카탈로그 MEASUREMENT / 직접 만든 운동의 measurementType·sides) = 어떻게 측정할 수 있는가
 *   루틴 항목(routineGuides: measurementType 덮어쓰기, targetDurationSeconds)   = 이번에 얼마나 할 것인가
 *   연속 세트(routineGuides.groupId + routineTemplates.groups[id] = {rounds, restSeconds}) = 무엇을 쉬지 않고 이어 할 것인가
 * 모든 새 필드는 선택(optional)이다. 없으면 reps / 좌우 없음 / 독립 운동으로 동작한다(기존 데이터 그대로).
 * 수행 타이머는 휴식 타이머와 같은 방식(절대 시각 기준: 남은 시간 = 마감 - Date.now())이고, 끝나면
 * 기존 휴식 타이머(FitlogTimer.start)와 기존 "얏호~"(FitlogTimer.playChime)를 그대로 쓴다.
 * 의존: app.js, my-workout.js — 그 다음에 로드
 */
(function () {
  const App = window.FitlogApp;
  const PREP_SECONDS = 3;          // 시간형 시작 전 준비(자세 전환) 시간 — 이 상수 한 곳에서 바꾼다. 휴식으로 기록하지 않는다.
  const DEFAULT_DURATION = 30;     // 목표 시간이 없을 때 기본값(초)
  const TICK_MS = 100;

  Object.assign(App, {
    PREP_SECONDS,
    run: null,          // 진행 중인 시간형/연속 세트 수행 상태(한 번에 하나)
    _runTicker: null,

    // ───────── 측정 방식 해석 (운동 → 루틴 항목) ─────────
    measureMetaOf(m) {
      if (!m) return { defaultType: "reps", allowed: ["reps"], sides: "none" };
      const def = m.defaultMeasurementType === "duration" ? "duration" : "reps";
      const allowed = (m.allowedMeasurementTypes || [def]).filter((x) => x === "reps" || x === "duration");
      return { defaultType: def, allowed: allowed.length ? allowed : [def], sides: m.sides === "leftRight" ? "leftRight" : "none" };
    },
    catalogMeasureMeta(catId) { return this.measureMetaOf(((window.FitlogCatalog || {}).MEASUREMENT || {})[catId]); },
    // 직접 만든 운동은 운동 자체의 measurementType·sides, 그 외는 카탈로그 메타(없으면 reps)
    exMeasureMeta(ex) {
      if (ex && (ex.measurementType === "duration" || ex.measurementType === "reps"))
        return { defaultType: ex.measurementType, allowed: [ex.measurementType], sides: ex.sides === "leftRight" ? "leftRight" : "none" };
      return this.catalogMeasureMeta(this.appExerciseCatalogId(ex));
    },
    guideMeasure(g, ex) {
      if (this.isCardio(ex, g)) return "cardio";
      const m = this.exMeasureMeta(ex);
      return g && m.allowed.includes(g.measurementType) ? g.measurementType : m.defaultType;
    },
    isDurationItem(g, ex) { return !!ex && this.guideMeasure(g, ex) === "duration"; },
    itemSides(g, ex) { return this.isDurationItem(g, ex) ? this.exMeasureMeta(ex).sides : "none"; },
    targetDur(g) { const n = Math.round(Number(g && g.targetDurationSeconds)); return n > 0 ? n : DEFAULT_DURATION; },
    fmtDur(sec) {
      if (sec == null || !Number.isFinite(Number(sec))) return "—";
      const s = Math.max(0, Math.round(Number(sec))), m = Math.floor(s / 60), r = s % 60;
      return m ? (r ? `${m}분 ${r}초` : `${m}분`) : `${r}초`;
    },
    durTargetText(g, ex) { return (this.itemSides(g, ex) === "leftRight" ? "좌·우 각 " : "") + this.fmtDur(this.targetDur(g)); },
    // 기록된 시간형 세트 1개 표시: "45초" / "좌 30초 · 우 27초"
    fmtDurSet(s) {
      if (!s) return "—";
      if (s.leftSeconds !== undefined || s.rightSeconds !== undefined) return `좌 ${this.fmtDur(s.leftSeconds)} · 우 ${this.fmtDur(s.rightSeconds)}`;
      return this.fmtDur(s.durationSeconds);
    },
    _mmss(sec) { sec = Math.max(0, Math.ceil(sec)); return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0"); },
    // 시간형 판정: 목표 세트 수만큼, 각 세트(좌우면 양쪽)가 목표 시간 이상이면 완료
    evalDuration(targetSets, target, sets, skipped) {
      if (skipped) return { status: "skipped", direction: null };
      if (!sets.length) return { status: "not_started", direction: null };
      if (sets.length < targetSets) return { status: "volume_under", direction: null };
      const ok = (v) => Number(v) >= target;
      const met = sets.slice(0, targetSets).every((s) => (s.leftSeconds !== undefined || s.rightSeconds !== undefined) ? ok(s.leftSeconds) && ok(s.rightSeconds) : ok(s.durationSeconds));
      return { status: met ? "completed" : "volume_under", direction: null };
    },

    // ───────── 연속 세트(루틴 구성) ─────────
    templateGroups(tid) { const t = this.template(tid); return (t && t.groups) || {}; },
    // 루틴을 실행/표시 단위로: 독립 운동 | 연속 세트(구성원 2개 이상). 그룹 구성원은 첫 구성원 자리에 모은다.
    routineBlocks(tid) {
      const gs = this.guidesOf(tid), groups = this.templateGroups(tid), count = {};
      gs.forEach((g) => { if (g.groupId && groups[g.groupId]) count[g.groupId] = (count[g.groupId] || 0) + 1; });
      const blocks = [], seen = new Set();
      gs.forEach((g) => {
        const gid = g.groupId;
        if (gid && groups[gid] && count[gid] >= 2) {
          if (seen.has(gid)) return; seen.add(gid);
          blocks.push({ type: "group", id: gid, meta: groups[gid], guides: gs.filter((x) => x.groupId === gid) });
        } else blocks.push({ type: "single", guide: g });
      });
      return blocks;
    },
    groupRoundsByGuide(tid) {
      const out = {};
      this.routineBlocks(tid).forEach((b) => { if (b.type === "group") b.guides.forEach((g) => { out[g.id] = { id: b.id, rounds: b.meta.rounds, restSeconds: b.meta.restSeconds }; }); });
      return out;
    },

    // ───────── 오늘: 블록 단위 렌더 ─────────
    renderTodayItems(root) {
      const items = this.items();
      const byGuide = new Map(items.filter((i) => !i.isExtra).map((i) => [i.guide.id, i]));
      this.routineBlocks(this.session.templateId).forEach((b) => {
        if (b.type === "group") {
          const its = b.guides.map((g) => byGuide.get(g.id)).filter((it) => it && it.exercise);
          if (its.length) root.appendChild(this.renderGroupCard(b, its));
        } else {
          const it = byGuide.get(b.guide.id); if (!it) return;
          root.appendChild(this.isDurationItem(it.guide, it.exercise) ? this.renderDurationCard(it) : this.renderCard(it));
        }
      });
      items.filter((i) => i.isExtra).forEach((it) => root.appendChild(this.renderCard(it)));
    },
    _inlineRest(key) {
      if (this.activeTimerExerciseId !== key || !window.FitlogTimer.state) return null;
      const T = window.FitlogTimer, st = T.state;
      return el("div", { class: "countdown", id: "inline-cd" }, [
        el("div", { class: "cd-num", id: "inline-cd-num", text: T._mmss(T.remaining()) }),
        el("div", { class: "cd-label", id: "inline-cd-label", text: st.type === "exercise_rest" ? "다음 운동까지" : "다음 세트까지" }),
      ]);
    },
    _lastDurLine(ex) {
      const lm = this.lastMap[ex.id];
      if (lm && lm.durText) return `지난번  ${lm.durText}`;
      if (lm && lm.reps) return `지난번  ${this.weightText(ex, lm.weight)} · ${lm.reps.join(" / ")}`;
      return "지난번  기록 없음";
    },

    // 단독 시간형 운동 카드
    renderDurationCard(it) {
      const { guide: g, exercise: ex, res } = it;
      const key = "x:" + ex.id;
      const st = this.evalExercise(g, ex, res).status;
      const targetMet = res.workSets.length >= g.targetSets;
      const card = el("div", { class: "card dur-card" + (res.skipped ? " skipped" : targetMet && !this._runIs(key) ? " done" : "") });
      card.appendChild(el("div", { class: "card-top" }, [
        el("div", { class: "ex-name" }, [document.createTextNode(ex.name), g.optional ? el("span", { class: "opt", text: "선택" }) : null]),
        st === "not_started" ? el("span", {}) : el("span", { class: `badge ${st}`, text: this.statusLabel(st) }),
      ]));
      card.appendChild(el("div", { class: "guide-line", text: `목표  ${this.durTargetText(g, ex)} · ${g.targetSets}세트` }));
      card.appendChild(el("div", { class: "last-line", text: this._lastDurLine(ex) }));
      if (res.skipped) {
        card.appendChild(el("div", { class: "card-foot" }, [el("span", { class: "muted", text: "이번 운동 생략됨" }), el("button", { class: "link", onclick: () => { res.skipped = false; this.renderToday(); } }, "되돌리기")]));
        return card;
      }
      if (res.workSets.length) {
        card.appendChild(el("div", { class: "dur-sets" }, res.workSets.map((s, i) => el("div", { class: "dur-set" }, [
          el("span", { class: "set-no", text: `${i + 1}세트` }), el("span", { class: "chk", text: "✓" }), el("span", { text: this.fmtDurSet(s) }),
        ]))));
      }
      card.appendChild(this._runPanel(key, { setNo: res.workSets.length + 1, total: g.targetSets, previewSec: this.targetDur(g), lr: this.itemSides(g, ex) === "leftRight", done: targetMet, startLabel: "버티기 시작" }));
      const rest = this._inlineRest(key); if (rest) card.appendChild(rest);
      card.appendChild(this.memoField(res));
      card.appendChild(el("div", { class: "card-foot" }, [
        res.workSets.length > 0 && !this._runIs(key)
          ? el("button", { class: "link", onclick: () => { if (window.confirm("이 운동의 기록을 초기화할까요? (메모는 유지)")) { res.workSets = []; this.renderToday(); } } }, "기록 초기화")
          : el("span", {}, ""),
        !targetMet && !this._runIs(key) ? el("button", { class: "link danger", onclick: () => this.skipExercise(g) }, "이번 운동 생략") : el("span", {}, ""),
      ]));
      return card;
    },

    // 연속 세트 카드: 항목 목록 + 수행 영역. 마지막 단계가 끝날 때만 휴식.
    renderGroupCard(b, its) {
      const key = "g:" + b.id;
      const gp = (this.session.groupProgress || {})[b.id] || 0;
      const rounds = b.meta.rounds, skipped = its.every((i) => i.res.skipped);
      const running = this._runIs(key), done = gp >= rounds && !running;
      const card = el("div", { class: "card group-card" + (skipped ? " skipped" : done ? " done" : "") });
      card.appendChild(el("div", { class: "card-top" }, [
        el("div", { class: "ex-name" }, [document.createTextNode("연속 세트"), el("span", { class: "opt", text: `${running || !done ? gp + 1 : gp} / ${rounds}세트` })]),
        done ? el("span", { class: "badge completed", text: "완료" }) : el("span", {}),
      ]));
      card.appendChild(el("div", { class: "guide-line", text: `${rounds}세트 · 세트 후 휴식 ${this.fmtDur(b.meta.restSeconds)}` }));
      const cur = running ? this.run.steps[this.run.idx] : null;
      const list = el("div", { class: "grp-items" });
      its.forEach((it, n) => {
        const { guide: g, exercise: ex, res } = it;
        const dur = this.isDurationItem(g, ex);
        const tgt = dur ? this.durTargetText(g, ex) : `${g.targetWeight == null ? "" : this.weightText(ex, g.targetWeight) + " · "}${g.minReps}~${g.maxReps}회`;
        const recs = res.workSets.map((s) => dur ? this.fmtDurSet(s) : `${this.weightText(ex, s.weight)}×${s.reps}`);
        list.appendChild(el("div", { class: "grp-item" + (cur && cur.exId === ex.id ? " current" : "") }, [
          el("span", { class: "grp-no", text: String(n + 1) }),
          el("span", { class: "grp-main" }, [el("span", { class: "grp-name", text: ex.name }), recs.length ? el("span", { class: "grp-recs", text: "✓ " + recs.join(" / ") }) : null]),
          el("span", { class: "grp-tgt", text: tgt }),
        ]));
      });
      card.appendChild(list);
      if (skipped) {
        card.appendChild(el("div", { class: "card-foot" }, [el("span", { class: "muted", text: "이번 연속 세트 생략됨" }), el("button", { class: "link", onclick: () => { its.forEach((i) => { i.res.skipped = false; }); this.renderToday(); } }, "되돌리기")]));
        return card;
      }
      card.appendChild(this._runPanel(key, { setNo: gp + 1, total: rounds, done: gp >= rounds, startLabel: "연속 세트 시작", group: true }));
      const rest = this._inlineRest(key); if (rest) card.appendChild(rest);
      its.forEach((it) => { const m = this.memoField(it.res); m.querySelector("input").placeholder = `＋ 메모 · ${it.exercise.name}`; card.appendChild(m); });
      card.appendChild(el("div", { class: "card-foot" }, [
        el("span", {}, ""),
        !done && !running ? el("button", { class: "link danger", onclick: () => { its.forEach((i) => { i.res.skipped = true; }); this.renderToday(); } }, "이번 연속 세트 생략") : el("span", {}, ""),
      ]));
      return card;
    },

    // 수행 영역: 대기(시작 버튼) / 준비 3·2·1 / 수행 카운트다운 / 중단 선택지 / (연속 세트의) 횟수 입력
    _runPanel(key, o) {
      const r = this._runIs(key) ? this.run : null;
      const box = el("div", { class: "run-panel" });
      if (!r) {
        if (o.done) {
          box.appendChild(el("button", { class: "btn btn-sm btn-ghost add-set", type: "button", onclick: () => this.startRun(key) }, "＋ 한 세트 더"));
          return box;
        }
        box.appendChild(el("div", { class: "run-label", text: `${o.setNo}세트` + (o.total ? ` / ${o.total}` : "") }));
        if (o.previewSec) box.appendChild(el("div", { class: "run-num idle", text: (o.lr ? "좌·우 각 " : "") + this._mmss(o.previewSec) }));
        box.appendChild(el("button", { class: "btn btn-primary btn-block btn-lg run-main", type: "button", onclick: () => this.startRun(key) }, o.startLabel));
        return box;
      }
      const st = r.steps[r.idx], ex = this.exercise(st.exId);
      const who = (ex ? ex.name : "") + (st.side === "left" ? " · 왼쪽" : st.side === "right" ? " · 오른쪽" : "");
      const roundTxt = `${o.setNo}세트`;
      const now = Date.now();
      if (r.phase === "preparing") {
        box.classList.add("prep");
        box.appendChild(el("div", { class: "run-label", id: "run-label", text: `준비 · ${who}` }));
        box.appendChild(el("div", { class: "run-num big", id: "run-num", text: String(Math.max(1, Math.ceil((r.prepEndsAt - now) / 1000))) }));
        box.appendChild(el("button", { class: "btn btn-block btn-lg run-stop", type: "button", onclick: () => this.stopRun() }, "취소"));
      } else if (r.phase === "performing") {
        box.classList.add("perform");
        box.appendChild(el("div", { class: "run-label", id: "run-label", text: `${who} · ${roundTxt}` }));
        box.appendChild(el("div", { class: "run-num big", id: "run-num", text: this._mmss((r.endsAt - now) / 1000) }));
        box.appendChild(el("button", { class: "btn btn-block btn-lg run-stop danger-btn", type: "button", onclick: () => this.stopRun() }, "중단"));
      } else if (r.phase === "stopped") {
        const e = r.elapsed, tgt = st.target;
        box.classList.add("stopped");
        box.appendChild(el("div", { class: "run-label", text: `${who} · 중단됨` }));
        box.appendChild(el("div", { class: "run-stopped", text: `${this.fmtDur(e)} 수행 · 목표 ${this.fmtDur(tgt)}` }));
        if (e >= 1) box.appendChild(el("button", { class: "btn btn-primary btn-block btn-lg", type: "button", onclick: () => this.runRecordContinue() }, `${this.fmtDur(e)}로 기록하고 계속`));
        box.appendChild(el("button", { class: "btn btn-block btn-lg", type: "button", onclick: () => this.runRetry() }, "다시 시작"));
        box.appendChild(el("button", { class: "btn btn-ghost btn-block btn-lg", type: "button", onclick: () => this.runEndHere() }, o.group ? "이번 연속 세트 여기서 끝내기" : "이번 세트 여기서 끝내기"));
      } else if (r.phase === "reps") {
        box.classList.add("reps");
        const g = this._guideOf(st.exId), res = this.session.results[st.exId];
        const prev = res.workSets.filter((s) => s.reps !== undefined).slice(-1)[0], lm = this.lastMap[st.exId];
        const draft = res.runDraft || (res.runDraft = {
          weight: prev ? prev.weight : (lm && lm.weight != null ? lm.weight : (g && g.targetWeight != null ? g.targetWeight : null)),
          reps: prev ? prev.reps : (g ? g.minReps : 10) });
        const last = r.idx === r.steps.length - 1;
        box.appendChild(el("div", { class: "run-label", text: `${who} · ${roundTxt}` }));
        box.appendChild(el("div", { class: "set-row run-reps" }, [
          el("span", { class: "set-no", text: String(o.setNo) }),
          this.dial(draft, "weight", { step: 0.5, min: 0, unit: ex ? this.unitLabel(ex) : "kg", allowNull: true }),
          this.dial(draft, "reps", { step: 1, min: 0, unit: "회" }),
        ]));
        box.appendChild(el("button", { class: "btn btn-primary btn-block btn-lg run-main", type: "button", onclick: () => this.runRepsDone() }, last ? "✓ 완료 · 휴식" : "✓ 완료 · 다음"));
        box.appendChild(el("button", { class: "btn btn-ghost btn-block", type: "button", onclick: () => this.runEndHere() }, "이번 연속 세트 여기서 끝내기"));
      }
      return box;
    },

    // ───────── 수행 엔진 (상태: idle(run=null) → preparing → performing → (stopped) → 다음 단계 / reps → … → 세트 완료 → 기존 휴식) ─────────
    _runIs(key) { return !!this.run && this.run.key === key; },
    _guideOf(exId) { return this.items().find((i) => !i.isExtra && i.exercise && i.exercise.id === exId)?.guide || null; },
    _runSteps(key) {
      const tid = this.session.templateId, steps = [];
      const add = (g) => {
        const ex = this.exercise(g.exerciseId); if (!ex || this.isCardio(ex, g)) return;
        if (this.isDurationItem(g, ex)) {
          const t = this.targetDur(g);
          if (this.itemSides(g, ex) === "leftRight") { steps.push({ exId: ex.id, side: "left", kind: "duration", target: t }); steps.push({ exId: ex.id, side: "right", kind: "duration", target: t }); }
          else steps.push({ exId: ex.id, side: null, kind: "duration", target: t });
        } else steps.push({ exId: ex.id, side: null, kind: "reps" });
      };
      if (key.startsWith("g:")) { const b = this.routineBlocks(tid).find((x) => x.type === "group" && x.id === key.slice(2)); if (b) b.guides.forEach(add); }
      else { const g = this.guidesOf(tid).find((x) => x.exerciseId === key.slice(2)); if (g) add(g); }
      return steps;
    },
    _audioInit() {
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!this._actx && C) this._actx = new C();
        if (this._actx && this._actx.state === "suspended") this._actx.resume().catch(() => {});
      } catch (_) {}
    },
    // 준비 카운트다운 소리(Web Audio, 외부 파일 없음): 삑(880Hz 짧게) ×3, 시작 "땡~"(1319Hz 길게 감쇠)
    _tone(kind) {
      if (this.settings && this.settings.soundEnabled === false) return;
      const c = this._actx; if (!c) return;
      try {
        if (c.state === "suspended") c.resume().catch(() => {});
        const t = c.currentTime, o = c.createOscillator(), gn = c.createGain();
        const start = kind === "start", dur = start ? 0.7 : 0.12;
        o.type = "sine"; o.frequency.value = start ? 1318.5 : 880;
        gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(start ? 0.45 : 0.35, t + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(gn); gn.connect(c.destination); o.start(t); o.stop(t + dur + 0.03);
        this._toneCount = (this._toneCount || 0) + 1;
      } catch (_) {}
    },
    _ensureTicker() { if (!this._runTicker) this._runTicker = setInterval(() => this._tick(), TICK_MS); },
    _stopTicker() { if (this._runTicker) { clearInterval(this._runTicker); this._runTicker = null; } },
    _resetRun() { this.run = null; this._stopTicker(); },
    _renderRun() { if (this.view === "today" && !this.ended) this.renderToday(); },

    startRun(key) {   // 사용자 탭(제스처)에서만 호출 → 여기서 Web Audio 언락
      this._audioInit();
      const steps = this._runSteps(key);
      if (!steps.length) return;
      window.FitlogTimer.cancel(); this.activeTimerExerciseId = null;   // 쉬는 중 시작하면 휴식 종료
      window.FitlogTimer.keepAwakeOn();
      this._stopTicker();
      this.run = { key, steps, idx: 0, partial: {}, recorded: false, phase: null };
      this._enterStep(Date.now(), false);
      this._renderRun();
    },
    // t: 이 단계가 시작되는 시각(앞 단계 마감 시각 그대로 이어서 → 백그라운드 복귀 후에도 누적 오차 없음)
    _enterStep(t, afterChime) {
      const r = this.run, st = r.steps[r.idx];
      if (st.kind === "duration") {
        Object.assign(r, { phase: "preparing", prepEndsAt: t + PREP_SECONDS * 1000, startedAt: null, endsAt: null, elapsed: 0,
          lastBeep: afterChime ? PREP_SECONDS : null });   // 방금 "얏호~"가 울렸으면 첫 삑은 겹치지 않게 생략
        this._ensureTicker();
        if (!this._inTick) this._tick();   // 따라잡기 루프 안에서는 바깥 루프가 이어서 처리(중복 소리 방지)
      } else { r.phase = "reps"; this._stopTicker(); }
    },
    _tick() {
      const r = this.run; if (!r) { this._stopTicker(); return; }
      const now = Date.now(); let changed = false, chime = false;
      this._inTick = true;
      try {
      for (let guard = 0; guard < 64 && r === this.run; guard++) {
        if (r.phase === "preparing") {
          if (now >= r.prepEndsAt) {
            if (now - r.prepEndsAt < 1500) this._tone("start");   // 늦게 따라잡은 경우엔 시작음 생략
            r.phase = "performing"; r.startedAt = r.prepEndsAt; r.endsAt = r.startedAt + r.steps[r.idx].target * 1000;
            changed = true; continue;
          }
          const s = Math.ceil((r.prepEndsAt - now) / 1000);
          if (s !== r.lastBeep) { if (r.lastBeep === null || s < r.lastBeep) this._tone("beep"); r.lastBeep = s; }
          break;
        }
        if (r.phase === "performing" && now >= r.endsAt) {
          chime = true; changed = true;
          this._completeStep(r.steps[r.idx].target, r.endsAt, true);
          continue;
        }
        break;
      }
      } finally { this._inTick = false; }
      if (chime) window.FitlogTimer.playChime();   // 기존 "얏호~" 재사용(따라잡기로 여러 단계가 끝나도 한 번만)
      if (changed) this._renderRun(); else this._paintRun(now);
    },
    _paintRun(now) {
      const r = this.run, n = document.getElementById("run-num"); if (!r || !n) return;
      if (r.phase === "preparing") n.textContent = String(Math.max(1, Math.ceil((r.prepEndsAt - now) / 1000)));
      else if (r.phase === "performing") n.textContent = this._mmss((r.endsAt - now) / 1000);
    },
    // 한 단계 기록(좌우 운동은 오른쪽까지 끝나야 세트 1개로 저장)
    _recordDuration(st, sec) {
      const r = this.run, res = this.session.results[st.exId];
      if (st.side === "left") (r.partial[st.exId] = r.partial[st.exId] || {}).left = sec;
      else if (st.side === "right") {
        const p = r.partial[st.exId] || {};
        res.workSets.push({ leftSeconds: p.left !== undefined ? p.left : null, rightSeconds: sec });
        delete r.partial[st.exId];
      } else res.workSets.push({ durationSeconds: sec });
      r.recorded = true;
    },
    _completeStep(sec, t, fromTimer) {
      const r = this.run;
      this._recordDuration(r.steps[r.idx], sec);
      this._advance(t, fromTimer);
    },
    _advance(t, afterChime) {
      const r = this.run;
      r.idx++;
      if (r.idx >= r.steps.length) this._finishRound(true);
      else this._enterStep(t, afterChime);
    },
    // 세트(연속 세트면 한 바퀴) 끝: 여기서만 기존 휴식 타이머를 시작한다
    _finishRound(withRest) {
      const r = this.run; if (!r) return;
      Object.keys(r.partial).forEach((exId) => {   // 왼쪽만 하고 끝낸 경우도 실제 시간은 남긴다
        const p = r.partial[exId]; if (p.left !== undefined) this.session.results[exId].workSets.push({ leftSeconds: p.left, rightSeconds: null });
      });
      this._resetRun();
      if (!r.recorded) return;
      let type = "set_rest", sec = this.settings.setRestSeconds;
      if (r.key.startsWith("g:")) {
        const gid = r.key.slice(2), gp = this.session.groupProgress || (this.session.groupProgress = {});
        gp[gid] = (gp[gid] || 0) + 1;
        const b = this.routineBlocks(this.session.templateId).find((x) => x.type === "group" && x.id === gid);
        const last = b && gp[gid] === b.meta.rounds;
        sec = last ? this.settings.exerciseRestSeconds : (b ? b.meta.restSeconds : sec); type = last ? "exercise_rest" : "set_rest";
      } else {
        const g = this._guideOf(r.key.slice(2)), done = this.session.results[r.key.slice(2)].workSets.length;
        if (g && done === g.targetSets) { type = "exercise_rest"; sec = this.settings.exerciseRestSeconds; }
      }
      if (withRest) { this.activeTimerExerciseId = r.key; window.FitlogTimer.start(type, sec); }
    },
    stopRun() {
      const r = this.run; if (!r) return;
      const now = Date.now();
      if (r.phase === "preparing") {
        if (r.idx === 0 && !r.recorded && !Object.keys(r.partial).length) { this._resetRun(); this._renderRun(); return; }
        r.elapsed = 0;
      } else if (r.phase === "performing") {
        r.elapsed = Math.min(r.steps[r.idx].target, Math.max(0, Math.floor((now - r.startedAt) / 1000)));
      } else return;
      r.phase = "stopped"; this._stopTicker();
      this._renderRun();
    },
    runRecordContinue() {   // A. 실제 수행 시간으로 기록하고 다음 단계로
      const r = this.run; if (!r || r.phase !== "stopped") return;
      this._audioInit();
      this._completeStep(r.elapsed, Date.now(), false);
      this._renderRun();
    },
    runRetry() {            // B. 같은 단계(같은 쪽) 다시
      const r = this.run; if (!r || r.phase !== "stopped") return;
      this._audioInit();
      this._enterStep(Date.now(), false);
      this._renderRun();
    },
    runEndHere() {          // C. 이번 세트/연속 세트 종료(그때까지의 실제 시간은 기록, 휴식은 시작하지 않음)
      const r = this.run; if (!r) return;
      if (r.phase === "stopped" && r.elapsed >= 1) this._recordDuration(r.steps[r.idx], r.elapsed);
      this._finishRound(false);
      this._renderRun();
    },
    runRepsDone() {         // 연속 세트 안의 횟수형 단계 완료 → 다음 단계(휴식 없음)
      const r = this.run; if (!r || r.phase !== "reps") return;
      this._audioInit();
      const st = r.steps[r.idx], res = this.session.results[st.exId], d = res.runDraft || {};
      res.workSets.push({ weight: d.weight == null || d.weight === "" ? null : Number(d.weight), reps: Number(d.reps) || 0 });
      res.runDraft = null; r.recorded = true;
      this._advance(Date.now(), false);
      this._renderRun();
    },

    // ───────── 기록 상세: 시간형 카드(보기·수정) ─────────
    _histDurationCard(s, r, id, nm) {
      const card = el("div", { class: "card" });
      const gs = r.guideSnapshot || {};
      const lr = r.sides === "leftRight";
      const work = (r.sets || []).filter((x) => x.setType === "work");
      const tag = r.group ? el("span", { class: "opt", text: "연속 세트" }) : null;
      if (this.histEditEx === r.exerciseId) {
        const draft = { sets: work.map((w) => lr ? { l: w.leftSeconds, r: w.rightSeconds } : { d: w.durationSeconds }), notes: r.notes || "" };
        card.appendChild(el("div", { class: "ex-name" }, [document.createTextNode(nm), tag]));
        draft.sets.forEach((d, i) => {
          card.appendChild(el("div", { class: "section-label", style: "margin:10px 2px 4px", text: `${i + 1}세트` }));
          if (lr) card.appendChild(el("div", { class: "cardio-grid", style: "grid-template-columns:1fr 1fr" }, [
            el("div", { class: "cardio-field" }, [el("label", { text: "왼쪽 (초)" }), this.dial(d, "l", { step: 1, min: 0, unit: "초", allowNull: true })]),
            el("div", { class: "cardio-field" }, [el("label", { text: "오른쪽 (초)" }), this.dial(d, "r", { step: 1, min: 0, unit: "초", allowNull: true })]),
          ]));
          else card.appendChild(el("div", { class: "cardio-field" }, [el("label", { text: "수행 시간 (초)" }), this.dial(d, "d", { step: 1, min: 0, unit: "초" })]));
        });
        const memo = el("input", { class: "memo-input", type: "text", value: draft.notes, placeholder: "＋ 메모", oninput: (e) => { draft.notes = e.target.value; } });
        card.appendChild(el("div", { class: "memo-row" }, [memo]));
        const save = async () => {
          const warm = (r.sets || []).filter((x) => x.setType === "warmup");
          r.sets = [...warm, ...draft.sets.map((d, i) => lr
            ? { setNumber: i + 1, setType: "work", leftSeconds: d.l == null ? null : Number(d.l), rightSeconds: d.r == null ? null : Number(d.r), completed: true }
            : { setNumber: i + 1, setType: "work", durationSeconds: Number(d.d) || 0, completed: true })];
          r.notes = draft.notes; r.status = this.recomputeStatus(r); s.updatedAt = new Date().toISOString();
          try { await window.FitlogDB.DB.put("workoutSessions", s); } catch (e) { console.error(e); }
          this.histEditEx = null; this.renderHistoryDetail(id);
        };
        card.appendChild(el("div", { class: "gedit-actions", style: "grid-template-columns:1fr auto" }, [
          el("button", { class: "btn btn-primary", onclick: save }, "수정 저장"),
          el("button", { class: "btn btn-ghost", onclick: () => { this.histEditEx = null; this.renderHistoryDetail(id); } }, "취소"),
        ]));
        return card;
      }
      card.appendChild(el("div", { class: "card-top" }, [el("div", { class: "ex-name" }, [document.createTextNode(nm), tag]), el("span", { class: `badge ${r.status}`, text: this.statusLabel(r.status) })]));
      if (gs.targetDurationSeconds != null) card.appendChild(el("div", { class: "guide-line", text: `목표 ${lr ? "좌·우 각 " : ""}${this.fmtDur(gs.targetDurationSeconds)} · ${gs.targetSets}세트` }));
      if (work.length) card.appendChild(el("div", { class: "dur-sets" }, work.map((w, i) => el("div", { class: "dur-set" }, [el("span", { class: "set-no", text: `${i + 1}세트` }), el("span", { text: this.fmtDurSet(w) })]))));
      else card.appendChild(el("div", { class: "guide-line", text: "실제 —" }));
      if (r.notes) card.appendChild(el("div", { class: "memo-line", text: `메모 ${r.notes}` }));
      card.appendChild(el("div", { class: "card-foot" }, [el("span", {}, ""), el("button", { class: "btn btn-sm", onclick: () => { this.histEditEx = r.exerciseId; this.renderHistoryDetail(id); } }, "수정")]));
      return card;
    },

    // ───────── 루틴 편집: 시간형 항목 편집기(기존 편집기와 같은 저장·취소·제거·▲▼ 흐름) ─────────
    _measureSwitch(g, ex) {
      const m = this.exMeasureMeta(ex);
      if (m.allowed.length < 2) return null;
      const cur = this.guideMeasure(g, ex);
      const chip = (type, label) => el("button", { class: "fx-chip" + (cur === type ? " on" : ""), type: "button", onclick: async () => {
        if (cur === type) return;
        g.measurementType = type;
        if (type === "duration" && !(g.targetDurationSeconds > 0)) g.targetDurationSeconds = DEFAULT_DURATION;
        try { await window.FitlogDB.DB.put("routineGuides", g); await this.reloadDefs(); } catch (e) { console.error(e); }
        this.renderGuide();
      } }, label);
      return el("div", { class: "gedit-field" }, [el("label", { text: "기록 방식" }), el("div", { class: "fx-chips static" }, [chip("reps", "반복 횟수"), chip("duration", "시간")])]);
    },
    renderDurationGuideEditor(g, ex, idx, total) {
      const lr = this.itemSides(g, ex) === "leftRight";
      const grouped = !!this.groupRoundsByGuide(g.templateId)[g.id];
      const cur = this.targetDur(g);
      const minIn = el("input", { type: "number", inputmode: "numeric", min: "0", value: Math.floor(cur / 60), "aria-label": "분" });
      const secIn = el("input", { type: "number", inputmode: "numeric", min: "0", max: "59", value: cur % 60, "aria-label": "초" });
      const setsInput = el("input", { type: "number", inputmode: "numeric", value: g.targetSets });
      const notesInput = el("input", { type: "text", value: g.notes || "", placeholder: "메모" });
      const optChk = el("input", { type: "checkbox", ...(g.optional ? { checked: "checked" } : {}) });
      const err = el("div", { class: "range-err", hidden: true });
      const field = (label, node) => el("div", { class: "gedit-field" }, [el("label", { text: label }), node]);
      const save = async () => {
        const total = (Number(minIn.value) || 0) * 60 + (Number(secIn.value) || 0);
        if (!(total >= 1)) { err.textContent = "시간을 1초 이상으로 입력하세요."; err.hidden = false; return; }
        g.targetDurationSeconds = Math.round(total);
        if (!grouped) g.targetSets = Number(setsInput.value) || g.targetSets;
        g.optional = optChk.checked; g.notes = notesInput.value;
        try { await window.FitlogDB.DB.put("routineGuides", g); await this.reloadDefs(); } catch (e) { console.error("[Fitlog] 가이드 저장 실패", e); }
        this.editingGuideId = null; this.renderGuide();
      };
      const del = async () => {
        if (!window.confirm(`'${ex.name}'을(를) 이 루틴에서 제거할까요? (기존 기록은 그대로 남아요)`)) return;
        try { await window.FitlogDB.DB.delete("routineGuides", g.id); await this.reloadDefs(); } catch (e) { console.error(e); }
        this.editingGuideId = null; this.renderGuide();
      };
      return el("div", { class: "card gedit" }, [
        el("div", { class: "card-top" }, [el("div", { class: "ex-name" }, [document.createTextNode(ex.name), el("span", { class: "opt", text: lr ? "좌우 각각 · 시간" : "시간" })]),
          el("div", { class: "order-btns" }, [
            el("button", { class: "btn btn-sm", onclick: () => this.moveGuide(g, -1), ...(this.canMoveGuide(g, -1) ? {} : { disabled: "disabled" }) }, "▲"),
            el("button", { class: "btn btn-sm", onclick: () => this.moveGuide(g, 1), ...(this.canMoveGuide(g, 1) ? {} : { disabled: "disabled" }) }, "▼"),
          ])]),
        this._measureSwitch(g, ex),
        el("div", { class: "gedit-grid" }, [
          field(lr ? "좌·우 각 시간" : "시간", el("div", { class: "dur-input" }, [minIn, el("span", { text: "분" }), secIn, el("span", { text: "초" })])),
          grouped ? field("세트", el("div", { class: "gedit-note", text: "연속 세트 반복 횟수를 따라요" })) : field("세트", setsInput),
        ]),
        err,
        el("div", { class: "gedit-toggles" }, [el("label", { class: "gedit-toggle" }, [optChk, el("span", { text: "선택 운동" })])]),
        field("메모", notesInput),
        this._partsReadonly(ex),
        el("div", { class: "gedit-actions" }, [
          el("button", { class: "btn btn-primary", onclick: save }, "저장"),
          el("button", { class: "btn btn-ghost", onclick: () => { this.editingGuideId = null; this.renderGuide(); } }, "취소"),
          el("button", { class: "btn btn-ghost danger-btn", onclick: del }, "제거"),
        ]),
      ]);
    },
    // 편집기 ▲▼: 연속 세트 밖에서는 블록 단위(그룹을 통째로 건너뜀), 그룹 안에서는 그룹 안에서만 이동
    _moveTarget(g, dir) {
      const blocks = this.routineBlocks(g.templateId);
      const bi = blocks.findIndex((b) => b.type === "group" ? b.guides.some((x) => x.id === g.id) : b.guide.id === g.id);
      if (bi < 0) return null;
      const b = blocks[bi];
      if (b.type === "group") { const i = b.guides.findIndex((x) => x.id === g.id), j = i + dir; return j >= 0 && j < b.guides.length ? { blocks, inGroup: b, i, j } : null; }
      const j = bi + dir; return j >= 0 && j < blocks.length ? { blocks, bi, j } : null;
    },
    canMoveGuide(g, dir) { return !!this._moveTarget(g, dir); },
    async moveGuide(g, dir) {
      const mt = this._moveTarget(g, dir); if (!mt) return;
      let order;
      if (mt.inGroup) {
        const gs = mt.inGroup.guides.slice(); [gs[mt.i], gs[mt.j]] = [gs[mt.j], gs[mt.i]];
        order = mt.blocks.flatMap((b) => b === mt.inGroup ? gs : (b.type === "group" ? b.guides : [b.guide]));
      } else {
        const bl = mt.blocks.slice(); [bl[mt.bi], bl[mt.j]] = [bl[mt.j], bl[mt.bi]];
        order = bl.flatMap((b) => b.type === "group" ? b.guides : [b.guide]);
      }
      await this.saveGuideOrder(order);
      this.renderGuide();
    },
    async saveGuideOrder(guides) {
      try {
        for (let i = 0; i < guides.length; i++) if (guides[i].order !== i + 1) { guides[i].order = i + 1; await window.FitlogDB.DB.put("routineGuides", guides[i]); }
        await this.reloadDefs();
      } catch (e) { console.error("[Fitlog] 순서 저장 실패", e); }
    },
  });

  // 앱 복귀 시 수행 타이머 즉시 재계산(절대 시각 기준이라 경과 시간이 그대로 반영됨)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && App.run) { App._audioInit && App._actx && App._actx.state === "suspended" && App._actx.resume().catch(() => {}); App._tick(); }
  });
})();
