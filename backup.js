/* backup.js — JSON 백업 export/import (DATA_SPEC §12~§14, §18)
 * 전체 덮어쓰기 방식. import 실패 시 기존 데이터 복구(메모리 스냅샷).
 */
const Backup = {
  STORES: ["settings", "exercises", "routineTemplates", "routineGuides", "workoutSessions", "guideHistory"],

  async exportAll() {
    const DB = window.FitlogDB.DB; await DB.open();
    const data = {
      app: "fitlog", schemaVersion: 1, exportedAt: new Date().toISOString(),
      settings: await DB.get("settings", "app-settings"),
      exercises: await DB.getAll("exercises"),
      routineTemplates: await DB.getAll("routineTemplates"),
      routineGuides: await DB.getAll("routineGuides"),
      workoutSessions: await DB.getAll("workoutSessions"),
      guideHistory: await DB.getAll("guideHistory"),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `fitlog-backup-${data.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return data;
  },

  validate(obj) {
    if (!obj || obj.app !== "fitlog") return { ok: false, reason: "형식이 Fitlog 백업이 아닙니다." };
    if (obj.schemaVersion !== 1) return { ok: false, reason: "지원하지 않는 스키마 버전입니다." };
    const required = ["settings", "exercises", "routineTemplates", "routineGuides", "workoutSessions", "guideHistory"];
    for (const k of required) if (!(k in obj)) return { ok: false, reason: `필드 누락: ${k}` };
    return { ok: true };
  },

  async _snapshot(DB) {
    const snap = {};
    for (const s of this.STORES) snap[s] = await DB.getAll(s);
    return snap;
  },
  async _restore(DB, snap) {
    await DB.clearAll();
    for (const s of this.STORES) for (const x of (snap[s] || [])) await DB.put(s, x);
  },

  // 파일 → 파싱 → 검증 → (스냅샷) → 덮어쓰기. 실패 시 스냅샷으로 복구.
  async importAll(file) {
    let text;
    try { text = await file.text(); } catch (e) { return { ok: false, reason: "파일을 읽을 수 없습니다." }; }
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, reason: "JSON 파싱 실패" }; }
    const v = this.validate(obj); if (!v.ok) return v;

    const DB = window.FitlogDB.DB; await DB.open();
    const snap = await this._snapshot(DB);
    try {
      await DB.clearAll();
      if (obj.settings) await DB.put("settings", obj.settings);
      for (const x of (obj.exercises || [])) await DB.put("exercises", x);
      for (const x of (obj.routineTemplates || [])) await DB.put("routineTemplates", x);
      for (const x of (obj.routineGuides || [])) await DB.put("routineGuides", x);
      for (const x of (obj.workoutSessions || [])) await DB.put("workoutSessions", x);
      for (const x of (obj.guideHistory || [])) await DB.put("guideHistory", x);
      return { ok: true };
    } catch (e) {
      try { await this._restore(DB, snap); } catch (_) {}
      return { ok: false, reason: "복원 중 오류가 발생해 기존 데이터를 유지했습니다." };
    }
  },
};
window.FitlogBackup = Backup;
