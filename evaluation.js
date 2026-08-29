/* evaluation.js — 세트/운동 판정 (DATA_SPEC §8, PRODUCT_SPEC §8)
 * 순수 함수. work 세트만 판정에 사용(warmup 제외). 자동 증량 금지.
 * 이 파일은 스펙과 1:1로 대응하는 참조 구현이다.
 */

// 세트 판정: "under" | "in_range" | "over"
function evaluateSet(reps, minReps, maxReps) {
  if (reps < minReps) return "under";
  if (reps <= maxReps) return "in_range";
  return "over";
}

// 운동 판정.
// exercise: { targetSets, minReps, maxReps, optional, sideMode, targetWeight }
// sets: [{ setType:"work"|"warmup", reps, completed }]
// opts: { skipped:boolean }
// 반환: { status, direction }
//   status: "not_started" | "skipped" | "volume_under" | "completed" | "progression_candidate"
//   direction: null | "increase" | "decrease_assist"   (progression_candidate일 때만)
function evaluateExercise(exercise, sets, opts = {}) {
  const { targetSets, minReps, maxReps, sideMode } = exercise;

  if (opts.skipped) return { status: "skipped", direction: null };

  const work = (sets || []).filter((s) => s.setType === "work");
  if (work.length === 0) return { status: "not_started", direction: null };

  const done = work.filter((s) => s.completed);
  if (done.length < targetSets) return { status: "volume_under", direction: null };

  const allAtLeastMax = done.every((s) => s.reps >= maxReps);
  const allAtLeastMin = done.every((s) => s.reps >= minReps);

  if (allAtLeastMax) {
    const direction = sideMode === "assist" ? "decrease_assist" : "increase";
    return { status: "progression_candidate", direction };
  }
  if (allAtLeastMin) return { status: "completed", direction: null };
  return { status: "volume_under", direction: null };
}

// 증량 후보 문구 (UI 표기용) — 어시스트 역방향 반영
function progressionLabel(direction) {
  if (direction === "increase") return "증량 후보 (중량 ↑ 고려)";
  if (direction === "decrease_assist") return "난이도 상향 후보 (보조중량 ↓ 고려)";
  return "";
}

// 전체 완료율 (DATA_SPEC §9): 필수 운동만 분모.
// results: [{ optional:boolean, status }]
function completionRate(results) {
  const required = results.filter((r) => !r.optional);
  if (required.length === 0) return { done: 0, total: 0, rate: 0 };
  const isDone = (s) => s === "completed" || s === "progression_candidate";
  const done = required.filter((r) => isDone(r.status)).length;
  return { done, total: required.length, rate: done / required.length };
}

window.FitlogEval = { evaluateSet, evaluateExercise, progressionLabel, completionRate };
