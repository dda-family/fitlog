/* ai-bridge.js — AI 코치 (DATA_SPEC §15~§17, PRODUCT_SPEC §13)
 * API 미호출. 프롬프트 텍스트 생성 + 사용자가 받아온 JSON 검증. (적용은 app.js)
 */
const AiBridge = {
  // 분석용 프롬프트 텍스트 생성. ctx는 app.js에서 조립.
  buildPrompt(ctx) {
    const { templates, exercises, guides, dayMap, recent, progressions, constraints } = ctx;
    const WD = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
    const exName = (id) => (exercises.find((e) => e.id === id) || {}).name || id;
    const tplName = (id) => (templates.find((t) => t.id === id) || {}).name || id;

    let s = "";
    s += "너는 내 웨이트 트레이닝 코치야. 아래 내 현재 루틴·가이드·최근 기록을 보고 가이드 변경안을 제안해줘.\n";
    s += "반드시 맨 아래 [반환 형식]의 JSON만 정확히 채워서 답해. 설명은 summary와 각 change의 reason에만 써. 코드블록(```)이나 다른 문장은 넣지 마.\n\n";

    s += "[제약]\n";
    (constraints || []).forEach((c) => (s += "- " + c + "\n"));

    s += "\n[요일 배정]\n";
    Object.keys(dayMap || {}).forEach((k) => { if (dayMap[k]) s += `${WD[k]} → ${tplName(dayMap[k])}\n`; });

    s += "\n[현재 가이드]  (guideId | 템플릿 | 운동 | 현재 설정)\n";
    (guides || []).forEach((g) => {
      const w = g.targetWeight == null ? "미정" : g.targetWeight + "kg";
      s += `${g.id} | ${tplName(g.templateId)} | ${exName(g.exerciseId)} | ${w} · ${g.minReps}~${g.maxReps}회 x${g.targetSets}${g.optional ? " (선택)" : ""}\n`;
    });

    s += "\n[최근 4주 기록]  (운동 | 세션별 본세트 반복수)\n";
    if ((recent || []).length) recent.forEach((r) => { s += `${exName(r.exerciseId)} | ${r.records.map((rec) => rec.join("/")).join("  |  ")}\n`; });
    else s += "(아직 기록 없음)\n";

    if ((progressions || []).length) {
      s += "\n[증량 후보]\n";
      progressions.forEach((p) => { s += `- ${exName(p.exerciseId)} (${p.direction === "decrease_assist" ? "보조중량↓ = 난이도↑" : "중량↑"})\n`; });
    }

    s += "\n[반환 형식]  (이 JSON 형식만, 코드블록 없이)\n";
    s += JSON.stringify({
      format: "fitlog-guide-update", version: 1, summary: "변경 요약 한두 줄",
      changes: [{ guideId: "g-...", action: "update", before: { targetWeight: 28, targetSets: 3, minReps: 8, maxReps: 12 }, after: { targetWeight: 32, targetSets: 3, minReps: 8, maxReps: 12 }, reason: "이유" }],
    }, null, 2);
    s += "\n\n허용 action: update(수정) / remove(제거) / reorder(순서변경). guideId는 위 [현재 가이드] 목록의 값을 그대로 사용.\n";
    s += "어시스트 종목(보조 중량)은 난이도를 올리려면 targetWeight를 '낮춰야' 함에 유의.\n";
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
