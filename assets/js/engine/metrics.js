/**
 * Métricas de calidad — puerto JS de `backend/app/solver/metrics.py`.
 * @module engine/metrics
 */

/**
 * Horas muertas por profesor: bloques libres entre su primera y su última clase
 * de cada día. Es la métrica que más reclaman los docentes.
 * @returns {Map<string, number>}
 */
export function teacherGaps(ctx, assignment) {
  const perDay = new Map();
  const lessons = new Map(ctx.lessons.map((l) => [l.uid, l]));

  for (const [uid, { slot, teacherId }] of assignment) {
    void lessons.get(uid);
    const s = ctx.slots[slot];
    const key = `${teacherId}|${s.dayIndex}`;
    if (!perDay.has(key)) perDay.set(key, []);
    perDay.get(key).push(s.blockIndex);
  }

  const gaps = new Map(ctx.teacherOrder.map((tid) => [tid, 0]));
  for (const [key, blocks] of perDay) {
    if (blocks.length <= 1) continue;
    const tid = key.slice(0, key.lastIndexOf('|'));
    const span = Math.max(...blocks) - Math.min(...blocks) + 1;
    gaps.set(tid, (gaps.get(tid) || 0) + (span - blocks.length));
  }
  return gaps;
}

export function buildMetrics(ctx, assignment, { restarts, elapsedMs, softScore }) {
  const placed = assignment.size;
  const required = ctx.requiredHours;
  const gaps = teacherGaps(ctx, assignment);

  const assignedHours = new Map(ctx.teacherOrder.map((tid) => [tid, 0]));
  for (const [, { teacherId }] of assignment) {
    assignedHours.set(teacherId, (assignedHours.get(teacherId) || 0) + 1);
  }

  const teacherLoad = {};
  for (const tid of ctx.teacherOrder) {
    const cap = ctx.teacherMaxWeekly.get(tid) || 0;
    const assigned = assignedHours.get(tid) || 0;
    teacherLoad[tid] = {
      assigned,
      max: cap,
      utilization: cap ? Math.round((assigned / cap) * 1000) / 1000 : 0,
      gaps: gaps.get(tid) || 0,
    };
  }

  let totalGaps = 0;
  for (const g of gaps.values()) totalGaps += g;

  return {
    required_hours: required,
    placed_hours: placed,
    fill_rate: required ? Math.round((placed / required) * 10000) / 10000 : 1,
    teacher_gaps: totalGaps,
    soft_score: softScore,
    restarts,
    elapsed_ms: elapsedMs,
    teacher_load: teacherLoad,
  };
}
