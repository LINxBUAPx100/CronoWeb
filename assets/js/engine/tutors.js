/**
 * Asignación de tutores — puerto JS de `backend/app/solver/tutors.py`.
 *
 * Emparejamiento bipartito máximo (Kuhn) grupos ↔ profesores:
 *   1. 1 a 1 exigiendo afinidad (que el tutor dé clase a su grupo).
 *   2. 1 a 1 relajando la afinidad para los grupos que quedaron sueltos.
 *   3. Sólo si siguen faltando profesores, se comparte tutor priorizando
 *      a quien tiene MENOR carga estimada.
 *
 * @module engine/tutors
 */

/**
 * Carga estimada: los tutores se deciden antes de que exista el horario, así que
 * se reparten las horas de cada (grupo, materia) entre sus profesores elegibles.
 * @returns {Map<string, number>}
 */
export function estimateTeacherLoads(ctx) {
  const loads = new Map(ctx.teacherOrder.map((tid) => [tid, 0]));
  for (const gid of ctx.groupOrder) {
    for (const entry of ctx.groups.get(gid).curriculum) {
      const elig = ctx.eligible.get(`${gid}|${entry.subject_id}`) || [];
      if (!elig.length || !entry.weekly_hours) continue;
      const share = entry.weekly_hours / elig.length;
      for (const tid of elig) {
        if (loads.has(tid)) loads.set(tid, loads.get(tid) + share);
      }
    }
  }
  return loads;
}

/** Horas del plan del grupo que este profesor podría impartir. */
function teachingHoursInGroup(ctx, teacherId, groupId) {
  const teacher = ctx.teachers.get(teacherId);
  let total = 0;
  for (const entry of ctx.groups.get(groupId).curriculum) {
    if (entry.assign_to_tutor) continue;
    const canTeach = entry.fixed_teacher_id
      ? entry.fixed_teacher_id === teacherId
      : teacher.subject_ids.includes(entry.subject_id);
    if (canTeach) total += entry.weekly_hours;
  }
  return total;
}

/**
 * Candidatos por grupo, del mejor al peor. El ORDEN es la función de costo:
 * Kuhn toma el primer candidato libre, así que ordenar equivale a preferir.
 */
function candidateLists(ctx, loads, requireAffinity) {
  const result = new Map();
  for (const gid of ctx.groupOrder) {
    const scored = [];
    for (const tid of ctx.teacherOrder) {
      const teacher = ctx.teachers.get(tid);
      if (!teacher.can_be_tutor) continue;
      const affinity = teachingHoursInGroup(ctx, tid, gid);
      if (requireAffinity && affinity === 0) continue;
      const score = 3 * affinity + 2 * teacher.tutor_priority - 0.5 * (loads.get(tid) || 0);
      scored.push([-score, tid]);
    }
    scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    result.set(gid, scored.map(([, tid]) => tid));
  }
  return result;
}

/**
 * Emparejamiento bipartito máximo por caminos aumentantes (algoritmo de Kuhn).
 * @returns {Map<string,string>} groupId -> teacherId
 */
function kuhnMatching(groupIds, candidates) {
  /** @type {Map<string,string>} teacherId -> groupId */
  const matchTeacher = new Map();

  const tryAugment = (gid, visited) => {
    for (const tid of candidates.get(gid) || []) {
      if (visited.has(tid)) continue;
      visited.add(tid);
      const holder = matchTeacher.get(tid);
      // Libre, o su dueño actual puede reubicarse en otro candidato.
      if (holder === undefined || tryAugment(holder, visited)) {
        matchTeacher.set(tid, gid);
        return true;
      }
    }
    return false;
  };

  for (const gid of groupIds) tryAugment(gid, new Set());

  const result = new Map();
  for (const [tid, gid] of matchTeacher) result.set(gid, tid);
  return result;
}

/**
 * @returns {{tutors: object[], conflicts: object[]}}
 */
export function assignTutors(ctx) {
  const conflicts = [];
  const loads = estimateTeacherLoads(ctx);
  const groupIds = [...ctx.groupOrder];
  const pool = ctx.teacherOrder.filter((tid) => ctx.teachers.get(tid).can_be_tutor);

  if (!pool.length) {
    conflicts.push({
      severity: 'error',
      code: 'NO_TUTOR_CANDIDATES',
      message: "Ningún profesor tiene activado 'puede ser tutor': no es posible asignar tutores.",
    });
    return {
      tutors: groupIds.map((gid) => ({
        group_id: gid, teacher_id: null, shared: false, estimated_load: 0, reason: 'sin candidatos',
      })),
      conflicts,
    };
  }

  // Paso 1 — con afinidad.
  const matched = kuhnMatching(groupIds, candidateLists(ctx, loads, true));
  const reasons = new Map([...matched.keys()].map((gid) => [gid, 'matching 1-a-1 con afinidad']));

  // Paso 2 — relajando afinidad, sólo para los grupos sueltos.
  const pending = groupIds.filter((gid) => !matched.has(gid));
  if (pending.length) {
    const relaxed = candidateLists(ctx, loads, false);
    const taken = new Set(matched.values());
    for (const gid of pending) {
      relaxed.set(gid, (relaxed.get(gid) || []).filter((tid) => !taken.has(tid)));
    }
    for (const [gid, tid] of kuhnMatching(pending, relaxed)) {
      matched.set(gid, tid);
      reasons.set(gid, 'matching 1-a-1 sin afinidad (no imparte materias del grupo)');
    }
  }

  // Paso 3 — compartir sólo si ya no quedan profesores libres.
  const usage = new Map();
  for (const tid of matched.values()) usage.set(tid, (usage.get(tid) || 0) + 1);

  const stillPending = groupIds.filter((gid) => !matched.has(gid));
  if (stillPending.length) {
    conflicts.push({
      severity: 'warning',
      code: 'TUTORS_SHARED',
      message:
        `Hay ${groupIds.length} grupos y sólo ${pool.length} profesores elegibles como tutor: ` +
        `${stillPending.length} grupo(s) comparten tutor, priorizando a los de menor carga.`,
    });
    for (const gid of stillPending) {
      let best = pool[0];
      for (const tid of pool) {
        const a = [usage.get(tid) || 0, loads.get(tid) || 0, tid];
        const b = [usage.get(best) || 0, loads.get(best) || 0, best];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) best = tid;
      }
      matched.set(gid, best);
      usage.set(best, (usage.get(best) || 0) + 1);
      reasons.set(gid, 'tutor compartido (menor carga disponible)');
    }
  }

  // Un profesor con más de un grupo marca a TODOS sus grupos como compartidos.
  const sharedTeachers = new Set([...usage.entries()].filter(([, n]) => n > 1).map(([tid]) => tid));

  const tutors = groupIds.map((gid) => {
    const tid = matched.get(gid) ?? null;
    return {
      group_id: gid,
      teacher_id: tid,
      shared: tid !== null && sharedTeachers.has(tid),
      estimated_load: Math.round((loads.get(tid) || 0) * 100) / 100,
      reason: reasons.get(gid) || '',
    };
  });

  return { tutors, conflicts };
}

/** @returns {Map<string,?string>} */
export const tutorMap = (tutors) => new Map(tutors.map((t) => [t.group_id, t.teacher_id]));
