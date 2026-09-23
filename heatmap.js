/* heatmap.js — 근육 히트맵 계산 + Fitlog 어댑터 + SVG 시각화
 * 계산부(palette/dayNumber/scoreColors/calculate)는 패키지 validation/reference-heatmap.mjs를
 * 그대로 이식(동작 동일 보장). Fitlog 기록을 참조 계약 형태로 변환하는 어댑터만 추가한다.
 * 원본 운동 기록은 절대 수정하지 않고 메모리 객체만 만든다.
 */
(function () {
  // ===== 패키지 참조 계산 (동작 동일) =====
  const palette = { none: "#46535f", low: "#65ba8b", mid: "#dfaa58", high: "#d96161" };
  function dayNumber(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Expected YYYY-MM-DD");
    const t = Date.parse(value + "T00:00:00Z");
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
    return t / 86400000;
  }
  function scoreColors(scores) {
    const values = Object.values(scores);
    if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new Error("Invalid score");
    const denominator = Math.max(4, ...values);
    const mix = (a, b, t) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("");
    const colors = Object.fromEntries(Object.entries(scores).map(([id, s]) => {
      const q = Math.min(1, s / denominator);
      return [id, s === 0 ? palette.none : q <= 0.5 ? mix(palette.low, palette.mid, q * 2) : mix(palette.mid, palette.high, (q - 0.5) * 2)];
    }));
    return { denominator, colors };
  }
  function calculate({ sessions, startDate, endDate, catalog, mapping, regionIds, sessionId = null }) {
    const start = dayNumber(startDate), end = dayNumber(endDate);
    if (start > end) throw new Error("Reversed range");
    const scores = Object.fromEntries(regionIds.map((id) => [id, 0]));
    const exercises = new Map(catalog.exercises.map((e) => [e.id, e]));
    const maps = new Map(mapping.mappings.map((m) => [m.exerciseId, m]));
    const warnings = []; const unmapped = new Set(); const seenSessions = new Set();
    let completedSets = 0, mappedSets = 0, cardioSeconds = 0, workoutCount = 0;
    for (const session of sessions) {
      if (session.deleted === true || session.status !== "completed") continue;
      let day; try { day = dayNumber(session.localDate); } catch { warnings.push("invalid_session_date"); continue; }
      if (day < start || day > end || (sessionId !== null && session.id !== sessionId)) continue;
      if (typeof session.id !== "string" || !session.id) { warnings.push("missing_session_id"); continue; }
      if (seenSessions.has(session.id)) { warnings.push("duplicate_session:" + session.id); continue; }
      seenSessions.add(session.id); let hasWork = false; const seenRecords = new Set();
      for (const record of session.exercises || []) {
        if (record.deleted === true) continue;
        if (typeof record.recordId !== "string" || !record.recordId) { warnings.push("missing_record_id"); continue; }
        if (seenRecords.has(record.recordId)) { warnings.push("duplicate_record:" + record.recordId); continue; }
        seenRecords.add(record.recordId);
        const e = exercises.get(record.catalogId); const map = maps.get(record.catalogId);
        if (record.exerciseType === "cardio") {
          if (record.status === "completed" && Number.isFinite(record.durationSeconds) && record.durationSeconds > 0) { cardioSeconds += record.durationSeconds; hasWork = true; }
          if (!e || !map) unmapped.add(record.recordId);
          continue;
        }
        if (record.exerciseType !== "strength") { warnings.push("unknown_type:" + record.recordId); continue; }
        const seenSets = new Set(); let n = 0;
        for (const set of record.sets || []) {
          if (set.deleted === true || set.status !== "completed" || set.isWarmup === true) continue;
          if (typeof set.id !== "string" || !set.id) { warnings.push("missing_set_id"); continue; }
          if (seenSets.has(set.id)) { warnings.push("duplicate_set:" + set.id); continue; }
          seenSets.add(set.id);
          if (![0.5, 1].includes(set.setFactor)) { warnings.push("invalid_set_factor:" + set.id); continue; }
          const field = e ? (e.supportsReps ? "reps" : "durationSeconds") : (record.measure === "duration" ? "durationSeconds" : "reps");
          if (!Number.isFinite(set[field]) || set[field] <= 0) { warnings.push("invalid_completed_set:" + set.id); continue; }
          n += set.setFactor;
        }
        if (n === 0) continue;
        hasWork = true; completedSets += n;
        if (!e || !map) { unmapped.add(record.recordId); continue; }
        if (e.exerciseType !== "strength" || map.policy !== "weighted_completed_sets") { warnings.push("type_mismatch:" + record.recordId); unmapped.add(record.recordId); continue; }
        const pairs = [...Object.entries(map.primary), ...Object.entries(map.secondary), ...Object.entries(map.minor)];
        if (!Object.keys(map.primary).length || new Set(pairs.map(([m]) => m)).size !== pairs.length || pairs.some(([m, w]) => !(m in scores) || ![1, 0.5, 0.25].includes(w))) { warnings.push("invalid_mapping:" + record.catalogId); unmapped.add(record.recordId); continue; }
        mappedSets += n;
        for (const [muscle, weight] of pairs) scores[muscle] += n * weight;
      }
      if (hasWork) workoutCount++;
    }
    return { scores, ...scoreColors(scores), completedSets, mappedSets, unmappedSets: completedSets - mappedSets, cardioSeconds, workoutCount, periodDays: end - start + 1, unmappedRecordIds: [...unmapped], warnings };
  }

  // ===== Fitlog → 참조 계약 어댑터 (원본 미변경) =====
  // 기존 앱 운동ID → 카탈로그ID 결정: 사용자매핑 > 운동에 저장된 catalogId > 패키지 링크 > null
  function effectiveCatalogId(exId, exDef, userMap) {
    if (userMap && userMap[exId] && userMap[exId].mapping) return "user:" + exId;
    if (exDef && exDef.catalogId) return exDef.catalogId;
    const link = window.FitlogCatalog.EXISTING_LINK;
    if (link[exId]) return link[exId];
    return null;
  }
  // 사용자 지정 매핑을 포함한 런타임 catalog/mapping 확장본
  function buildAugmented(userMap) {
    const base = window.FitlogCatalog;
    const catalog = { exercises: base.CATALOG.exercises.slice() };
    const mapping = { mappings: base.MUSCLE_MAP.mappings.slice() };
    for (const exId of Object.keys(userMap || {})) {
      const um = userMap[exId]; if (!um || !um.mapping) continue;
      const cid = "user:" + exId;
      catalog.exercises.push({ id: cid, exerciseType: "strength", supportsReps: true });
      mapping.mappings.push({ exerciseId: cid, policy: "weighted_completed_sets", primary: um.mapping.primary || {}, secondary: um.mapping.secondary || {}, minor: um.mapping.minor || {} });
    }
    return { catalog, mapping };
  }
  // Fitlog 세션 배열 → 참조 계약 세션 배열
  function toContract(sessions, exDefsById, userMap) {
    const SC = window.FitlogCatalog.SESSION_CARDIO_CATALOG_ID;
    return (sessions || []).map((s) => {
      const exercises = [];
      (s.exerciseResults || []).forEach((r) => {
        const exDef = exDefsById[r.exerciseId];
        const recordId = s.id + "::" + r.exerciseId;
        if (r.kind === "cardio") {
          exercises.push({ recordId, catalogId: effectiveCatalogId(r.exerciseId, exDef, userMap), exerciseType: "cardio", status: r.cardioActual ? "completed" : "not_started", durationSeconds: r.cardioActual ? (Number(r.cardioActual.durationMinutes) || 0) * 60 : 0 });
        } else {
          const work = (r.sets || []).filter((x) => x.setType === "work");
          const sets = work.map((w, i) => ({ id: recordId + ":" + i, status: "completed", isWarmup: false, setFactor: 1, reps: Number(w.reps) || 0 }));
          exercises.push({ recordId, catalogId: effectiveCatalogId(r.exerciseId, exDef, userMap), exerciseType: "strength", sets });
        }
      });
      // 세션 고정 유산소(경사 걷기)
      if (s.cardio && s.cardio.durationMinutes) exercises.push({ recordId: s.id + "::session-cardio", catalogId: SC, exerciseType: "cardio", status: "completed", durationSeconds: (Number(s.cardio.durationMinutes) || 0) * 60 });
      return { id: s.id, localDate: s.date, status: s.status || "completed", deleted: false, exercises };
    });
  }

  // 앱에서 호출: 기록/기간/사용자매핑으로 히트맵 결과 계산
  function compute(sessions, opts) {
    const base = window.FitlogCatalog;
    const exDefsById = opts.exDefsById || {};
    const userMap = opts.userMap || {};
    const contract = toContract(sessions, exDefsById, userMap);
    const aug = buildAugmented(userMap);
    const result = calculate({ sessions: contract, startDate: opts.start, endDate: opts.end, catalog: aug.catalog, mapping: aug.mapping, regionIds: base.REGION_IDS, sessionId: opts.sessionId || null });
    // 미매핑 종목(근력만) 집계: catalogId 없는 strength 레코드
    const linkOf = (exId) => effectiveCatalogId(exId, exDefsById[exId], userMap);
    const unmappedNames = new Set();
    (sessions || []).forEach((s) => {
      if ((opts.sessionId && s.id !== opts.sessionId) || s.date < opts.start || s.date > opts.end) return;
      (s.exerciseResults || []).forEach((r) => {
        if (r.kind === "cardio") return;
        const work = (r.sets || []).filter((x) => x.setType === "work");
        if (!work.length) return;
        if (!linkOf(r.exerciseId)) { const ex = exDefsById[r.exerciseId]; unmappedNames.add((ex && ex.name) || r.exerciseName || r.exerciseId); }
      });
    });
    result.unmappedNames = [...unmappedNames];
    return result;
  }

  // ===== SVG 로딩·색칠·시점 전환 UI =====
  const _svgCache = {};   // viewId → SVGElement(template)
  function anatomyBase() {
    try {
      const a = document.getElementById("rest-end-audio");
      if (a && a.src) return a.src.replace(/sounds\/rest-end\.mp3.*$/, "anatomy/");
    } catch (_) {}
    return "assets/anatomy/";
  }
  function viewFileName(v) {
    // REGIONS_META.views[].file 예: "assets/anatomy/human_front.svg" → 파일명만 사용
    const f = (v.file || "").split("/").pop();
    return f || ("human_" + v.id + ".svg");
  }
  async function loadViews() {
    const views = window.FitlogCatalog.REGIONS_META.views;
    const base = anatomyBase();
    await Promise.all(views.map(async (v) => {
      if (_svgCache[v.id]) return;
      const res = await fetch(base + viewFileName(v) + "?v=" + window.FitlogCatalog.packageVersion);
      if (!res.ok) throw new Error("SVG 로드 실패: " + v.id);
      const doc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
      if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") throw new Error("유효하지 않은 SVG: " + v.id);
      _svgCache[v.id] = doc.documentElement;
    }));
    return _svgCache;
  }
  function paint(svg, colors) {
    svg.querySelectorAll("[data-muscle]").forEach((node) => node.setAttribute("fill", colors[node.dataset.muscle] || palette.none));
  }

  window.FitlogHeatmap = { palette, dayNumber, scoreColors, calculate, compute, toContract, buildAugmented, effectiveCatalogId, loadViews, paint, _svgCache };
})();
