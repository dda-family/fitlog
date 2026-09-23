/* ai-bridge.js — AI 코치 (DATA_SPEC §15~§17, PRODUCT_SPEC §13)
 * API 미호출. 프롬프트 텍스트 생성 + 사용자가 받아온 JSON 검증. (적용은 app.js)
 */
const AiBridge = {
  // 분석용 프롬프트 텍스트 생성. ctx는 app.js에서 조립(기간 내 세션·세트 원본 포함).
  buildPrompt(ctx) {
    const { templates, exercises, guides, dayMap, sessions, sessionCount, range, progressions, constraints } = ctx;
    const WD = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
    const exName = (id) => (exercises.find((e) => e.id === id) || {}).name || id;
    const tplName = (id) => (templates.find((t) => t.id === id) || {}).name || id;

    let s = "";
    s += "너는 내 웨이트 트레이닝 코치야. 아래 내 현재 루틴·가이드·기간 내 실제 기록을 보고 분석해줘.\n";
    s += "① 먼저 사람이 읽기 편하게 분석과 조언을 자유롭게 설명해줘.\n";
    s += "② 그런 다음, 가이드에 반영할 변경안이 있으면 맨 마지막에 [가이드 적용 JSON] 형식으로 JSON을 따로 코드블록(```json)에 담아줘. 이 JSON은 내가 그대로 복사해 앱에 붙여넣어 가이드에 적용할 거야. 변경할 게 없으면 JSON은 생략해도 돼.\n\n";

    s += `[분석 기간] ${range.start} ~ ${range.end} (실제 수행 세션 ${sessionCount}개)\n`;

    s += "\n[제약]\n";
    (constraints || []).forEach((c) => (s += "- " + c + "\n"));

    s += "\n[요일 배정]\n";
    Object.keys(dayMap || {}).forEach((k) => { if (dayMap[k]) s += `${WD[k]} → ${tplName(dayMap[k])}\n`; });

    s += "\n[현재 가이드]  (guideId | 템플릿 | 운동 | 현재 목표)\n";
    (guides || []).forEach((g) => {
      const nm = exName(g.exerciseId), t = tplName(g.templateId);
      if (g.kind === "cardio") {
        s += `${g.id} | ${t} | ${nm} | 유산소 ${g.targetDurationMinutes != null ? g.targetDurationMinutes : "-"}분 · ${g.targetSpeedKmh != null ? g.targetSpeedKmh : "-"}km/h · 경사 ${g.targetIncline != null ? g.targetIncline : "-"}${g.optional ? " (선택)" : ""}\n`;
      } else {
        const w = g.targetWeight == null ? "미정" : g.targetWeight + "kg";
        s += `${g.id} | ${t} | ${nm} | ${w} · ${g.minReps}~${g.maxReps}회 x${g.targetSets}${g.optional ? " (선택)" : ""}\n`;
      }
    });

    s += "\n[실제 운동 기록]  (기간 내 세션별 · 가이드와 별개인 실제 수행값. 세트별 중량/반복수를 통합하지 않고 원본 그대로)\n";
    if (!sessions || !sessions.length) {
      s += "이 기간에 저장된 운동 기록이 없습니다.\n";
    } else {
      sessions.forEach((sess) => {
        s += `\n■ ${sess.date} (${WD[sess.weekday] || ""}) · ${sess.templateName}\n`;
        (sess.exercises || []).forEach((r) => {
          s += `  · ${r.name} [${r.status}]\n`;
          if (r.kind === "cardio") {
            s += `     가이드: ${r.guideText}\n`;
            s += `     실제: ${r.actualText}\n`;
          } else {
            s += `     가이드: ${r.guideText}\n`;
            if (r.warmSets && r.warmSets.length) s += `     워밍업: ${r.warmSets.map((w) => `${w.weight == null ? "-" : w.weight}kg×${w.reps}`).join(", ")}\n`;
            if (r.workSets && r.workSets.length) {
              s += `     실제 ${r.actualSetCount}세트: ${r.workSets.map((w, i) => `${i + 1}) ${w.weight == null ? "-" : w.weight}kg×${w.reps}회`).join("  ")}\n`;
              if (r.targetSets != null && r.targetSets !== r.actualSetCount) s += `     (목표 세트 ${r.targetSets} → 실제 ${r.actualSetCount})\n`;
            } else {
              s += `     실제: 기록 없음\n`;
            }
          }
          if (r.notes) s += `     메모: ${r.notes}\n`;
        });
        if (sess.cardio) s += `  · [세션 유산소] 경사 ${sess.cardio.incline} · ${sess.cardio.speedKmh}km/h · ${sess.cardio.durationMinutes}분\n`;
      });
    }

    if ((progressions || []).length) {
      s += "\n[증량 후보]\n";
      progressions.forEach((p) => { s += `- ${p.name} (${p.direction === "decrease_assist" ? "보조중량↓ = 난이도↑" : "중량↑"})\n`; });
    }

    s += "\n[가이드 적용 JSON]  (설명을 마친 뒤, 변경안이 있으면 아래 형식으로 코드블록에 담아줘)\n";
    s += "```json\n";
    s += JSON.stringify({
      format: "fitlog-guide-update", version: 1, summary: "변경 요약 한두 줄",
      changes: [{ guideId: "g-...", action: "update", before: { targetWeight: 28, targetSets: 3, minReps: 8, maxReps: 12 }, after: { targetWeight: 32, targetSets: 3, minReps: 8, maxReps: 12 }, reason: "이유" }],
    }, null, 2);
    s += "\n```\n";
    s += "\n허용 action: update(수정) / remove(제거) / reorder(순서변경). guideId는 위 [현재 가이드] 목록의 값을 그대로 사용.\n";
    s += "어시스트 종목(보조 중량)은 난이도를 올리려면 targetWeight를 '낮춰야' 함에 유의.\n";
    return s;
  },

  // 특정일 교정 프롬프트: 그날 운동·실제세트·메모로 점검 + (필요시) 가이드 적용 JSON까지
  buildCorrectionPrompt(session, ctx) {
    const { templates, exercises, guides } = ctx;
    const WD = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
    const exName = (id) => (exercises.find((e) => e.id === id) || {}).name || id;
    const tplName = (id) => (templates.find((t) => t.id === id) || {}).name || id;
    const guideIdOf = (exId) => {
      const g = (guides || []).find((x) => x.exerciseId === exId && x.templateId === session.templateId) || (guides || []).find((x) => x.exerciseId === exId);
      return g ? g.id : null;
    };
    let s = "";
    s += "너는 내 웨이트 트레이닝 코치야. 아래는 특정 날짜 내 운동 기록과 메모야.\n";
    s += "① 먼저 점검해줘: 메모의 통증·불편이 있으면 원인 가능성, 그날 무게/횟수 조정이 적절했는지, 다음에 어떻게 하면 좋을지(자세·중량·대체운동 등)를 편하게 설명해줘. 데드리프트 계열은 내가 의도적으로 제외 중이야.\n";
    s += "② 그 결과 가이드(기본 목표)를 바꾸는 게 좋겠으면, 맨 마지막에 [가이드 적용 JSON] 형식으로 JSON을 코드블록(```json)에 따로 담아줘. 내가 그대로 앱에 붙여넣어 적용할 거야. 바꿀 게 없으면 JSON은 생략해도 돼.\n\n";
    s += `[날짜] ${session.date} (${WD[session.weekday] || ""}) · ${tplName(session.templateId)}\n\n`;
    s += "[운동별 기록]  (guideId | 운동 | 상태)\n";
    (session.exerciseResults || []).forEach((r) => {
      const work = (r.sets || []).filter((x) => x.setType === "work");
      const warm = (r.sets || []).filter((x) => x.setType === "warmup");
      const gid = guideIdOf(r.exerciseId);
      s += `\n- ${gid || "(가이드없음)"} | ${exName(r.exerciseId)} [${r.status}]\n`;
      if (warm.length) s += `  워밍업: ${warm.map((w) => `${w.weight == null ? "-" : w.weight}kg×${w.reps}`).join(", ")}\n`;
      s += `  실제: ${work.length ? work.map((w) => `${w.weight == null ? "-" : w.weight}kg×${w.reps}`).join(", ") : "—"}\n`;
      if (r.notes) s += `  메모: ${r.notes}\n`;
    });
    if (session.cardio) s += `\n[유산소] 경사 ${session.cardio.incline} · ${session.cardio.speedKmh}km/h · ${session.cardio.durationMinutes}분\n`;
    s += "\n[가이드 적용 JSON]  (설명 뒤에, 가이드를 바꿀 때만 아래 형식으로 코드블록에 담아줘)\n";
    s += "```json\n";
    s += JSON.stringify({ format: "fitlog-guide-update", version: 1, summary: "변경 요약", changes: [{ guideId: "g-...", action: "update", after: { targetWeight: 20, minReps: 8, maxReps: 12 }, reason: "우측 허리 통증으로 중량 하향" }] }, null, 2);
    s += "\n```\n";
    s += "허용 action: update / remove / reorder. guideId는 위 [운동별 기록]의 값을 그대로 사용.\n";
    return s;
  },

  // AI 반환 JSON 검증 — DATA_SPEC §17. guideIds(Set) 주면 존재 여부까지 검사.
  validate(obj, guideIds) {
    if (!obj || obj.format !== "fitlog-guide-update") return { ok: false, reason: "format이 fitlog-guide-update가 아닙니다." };
    if (obj.version !== 1) return { ok: false, reason: "지원하지 않는 version입니다." };
    if (!Array.isArray(obj.changes) || !obj.changes.length) return { ok: false, reason: "changes 배열이 비어 있습니다." };
    for (const c of obj.changes) {
      if (!["update", "add", "remove", "reorder"].includes(c.action)) return { ok: false, reason: `허용되지 않은 action: ${c.action}` };
      if (guideIds && c.action !== "add" && c.guideId && !guideIds.has(c.guideId)) return { ok: false, reason: `없는 guideId: ${c.guideId}` };
      const a = c.after || {};
      if (a.minReps != null && a.maxReps != null && Number(a.minReps) > Number(a.maxReps)) return { ok: false, reason: "minReps가 maxReps보다 큽니다." };
      if (a.targetWeight != null && Number(a.targetWeight) < 0) return { ok: false, reason: "중량이 음수입니다." };
      if (a.targetSets != null && Number(a.targetSets) < 1) return { ok: false, reason: "세트 수가 1 미만입니다." };
    }
    return { ok: true };
  },

  // after에서 허용된 필드만 정제
  sanitizeAfter(after) {
    const out = {}; if (!after) return out;
    if ("targetWeight" in after) out.targetWeight = after.targetWeight === null ? null : Number(after.targetWeight);
    if (after.targetSets != null) out.targetSets = Math.max(1, Math.round(Number(after.targetSets)));
    if (after.minReps != null) out.minReps = Math.round(Number(after.minReps));
    if (after.maxReps != null) out.maxReps = Math.round(Number(after.maxReps));
    if (typeof after.optional === "boolean") out.optional = after.optional;
    if (typeof after.notes === "string") out.notes = after.notes;
    return out;
  },
};
window.FitlogAI = AiBridge;
