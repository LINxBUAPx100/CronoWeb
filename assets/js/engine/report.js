/**
 * Diagnóstico de horas no colocadas — puerto JS de `backend/app/solver/report.py`.
 *
 * "No se pudo" no le sirve a una escuela. Para cada (grupo, materia) con horas
 * faltantes se determina la causa dominante y se redacta la acción que la destraba.
 *
 * @module engine/report
 */

import { groupLabel } from './contract.js';

export function diagnoseUnplaced(ctx, assignment, unplacedUids) {
  if (!unplacedUids.length) return [];

  const lessons = new Map(ctx.lessons.map((l) => [l.uid, l]));
  const grouped = new Map();
  for (const uid of unplacedUids) {
    const lesson = lessons.get(uid);
    const key = `${lesson.groupId}|${lesson.subjectId}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  const groupBusy = new Map();
  const teacherBusy = new Map();
  const teacherHours = new Map();
  for (const [uid, { slot, teacherId }] of assignment) {
    const lesson = lessons.get(uid);
    if (!groupBusy.has(lesson.groupId)) groupBusy.set(lesson.groupId, new Set());
    groupBusy.get(lesson.groupId).add(slot);
    if (!teacherBusy.has(teacherId)) teacherBusy.set(teacherId, new Set());
    teacherBusy.get(teacherId).add(slot);
    teacherHours.set(teacherId, (teacherHours.get(teacherId) || 0) + 1);
  }

  const out = [];
  for (const [key, missing] of [...grouped.entries()].sort()) {
    const [gid, sid] = key.split('|');
    const group = ctx.groups.get(gid);
    const subject = ctx.subjects.get(sid);
    const reason = explain(ctx, gid, sid, groupBusy.get(gid) || new Set(), teacherBusy, teacherHours);
    out.push({
      severity: 'error',
      code: 'UNPLACED_HOURS',
      message: `Faltaron ${missing} h de ${subject?.name || sid} en ${groupLabel(group)}. ${reason}`,
      group_id: gid,
      subject_id: sid,
      teacher_id: null,
      missing_hours: missing,
    });
  }
  return out;
}

function explain(ctx, gid, sid, groupBusy, teacherBusy, teacherHours) {
  const eligible = ctx.eligible.get(`${gid}|${sid}`) || [];
  if (!eligible.length) {
    return 'Ningún profesor puede impartirla: asígnala a alguien de la plantilla.';
  }

  const freeGroup = new Set([...ctx.groupSlots.get(gid)].filter((s) => !groupBusy.has(s)));
  if (!freeGroup.size) {
    return 'El grupo ya no tiene espacios libres en su rejilla; su plan de estudios llena la semana.';
  }

  const saturated = [];
  const noOverlap = [];
  for (const tid of eligible) {
    const teacher = ctx.teachers.get(tid);
    if ((teacherHours.get(tid) || 0) >= ctx.teacherMaxWeekly.get(tid)) {
      saturated.push(teacher.name);
      continue;
    }
    const busy = teacherBusy.get(tid) || new Set();
    const tSlots = ctx.teacherSlots.get(tid);
    const overlap = [...freeGroup].some((s) => tSlots.has(s) && !busy.has(s));
    if (!overlap) noOverlap.push(teacher.name);
  }

  if (saturated.length && saturated.length === eligible.length) {
    return `Sus profesores (${saturated.join(', ')}) ya llegaron a su carga máxima semanal. ` +
      'Sube su tope de horas o reparte la materia con otro docente.';
  }
  if (noOverlap.length && noOverlap.length + saturated.length === eligible.length) {
    return `Las horas libres del grupo no coinciden con la disponibilidad de ${noOverlap.join(', ')} ` +
      '(o ya están dando clase a otro grupo en esos bloques). Libera disponibilidad o mueve otras materias.';
  }
  return 'Sí existen huecos sueltos, pero ninguno compatible al mismo tiempo con el grupo y con sus ' +
    "profesores. Suele resolverse ampliando la disponibilidad de un docente, subiendo 'máx. por día' " +
    'de la materia, o dando más segundos de cálculo.';
}
