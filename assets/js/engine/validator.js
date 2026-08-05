/**
 * Validación de factibilidad — puerto JS de `backend/app/solver/validator.py`.
 *
 * Corre DESPUÉS de asignar tutores y ANTES de la búsqueda. Detecta en milisegundos
 * lo que ningún backtracking puede arreglar y lo explica en el idioma del director.
 *
 * error   -> se aborta la búsqueda (status: infeasible)
 * warning -> se busca igual, pero se avisa
 *
 * @module engine/validator
 */

import { groupLabel } from './contract.js';

const conflict = (severity, code, message, extra = {}) => ({
  severity, code, message,
  group_id: null, subject_id: null, teacher_id: null, missing_hours: null,
  ...extra,
});

export function validate(ctx) {
  return [
    ...checkGroupCapacity(ctx),
    ...checkEligibility(ctx),
    ...checkMaxPerDay(ctx),
    ...checkSubjectCapacity(ctx),
    ...checkGlobalCapacity(ctx),
    ...checkTeacherAvailability(ctx),
  ];
}

export const hasBlockingErrors = (conflicts) => conflicts.some((c) => c.severity === 'error');

// --------------------------------------------------------------------------- //
function checkGroupCapacity(ctx) {
  const out = [];
  for (const gid of ctx.groupOrder) {
    const group = ctx.groups.get(gid);
    const capacity = ctx.groupSlots.get(gid).size;
    const demand = group.curriculum.reduce((acc, c) => acc + c.weekly_hours, 0);
    if (demand > capacity) {
      out.push(conflict('error', 'GROUP_OVER_CAPACITY',
        `El grupo ${groupLabel(group)} pide ${demand} h a la semana pero su rejilla sólo tiene ` +
        `${capacity} espacios disponibles. Reduce horas del plan o agrega bloques al horario.`,
        { group_id: gid, missing_hours: demand - capacity }));
    } else if (demand < capacity * 0.5) {
      out.push(conflict('info', 'GROUP_UNDERUSED',
        `El grupo ${groupLabel(group)} sólo ocupa ${demand} de ${capacity} espacios; quedarán muchas horas libres.`,
        { group_id: gid }));
    }
  }
  return out;
}

function checkEligibility(ctx) {
  const out = [];
  for (const gid of ctx.groupOrder) {
    const group = ctx.groups.get(gid);
    const gSlots = ctx.groupSlots.get(gid);
    for (const entry of group.curriculum) {
      if (!entry.weekly_hours) continue;
      const elig = ctx.eligible.get(`${gid}|${entry.subject_id}`) || [];
      const subjectName = ctx.subjects.get(entry.subject_id)?.name || entry.subject_id;

      if (!elig.length) {
        const reason = entry.assign_to_tutor
          ? 'el grupo no tiene tutor asignado'
          : 'ningún profesor la tiene en su lista de materias';
        out.push(conflict('error', 'NO_ELIGIBLE_TEACHER',
          `${subjectName} en ${groupLabel(group)}: ${reason}. Asigna la materia a algún profesor.`,
          { group_id: gid, subject_id: entry.subject_id, missing_hours: entry.weekly_hours }));
        continue;
      }

      const usable = new Set();
      for (const tid of elig) {
        const tSlots = ctx.teacherSlots.get(tid);
        for (const slot of gSlots) if (tSlots.has(slot)) usable.add(slot);
      }
      if (!usable.size) {
        out.push(conflict('error', 'NO_COMMON_SLOT',
          `${subjectName} en ${groupLabel(group)}: la disponibilidad de sus profesores no coincide ` +
          'con ningún horario hábil del grupo.',
          { group_id: gid, subject_id: entry.subject_id, missing_hours: entry.weekly_hours }));
      } else if (usable.size < entry.weekly_hours) {
        out.push(conflict('error', 'NOT_ENOUGH_COMMON_SLOTS',
          `${subjectName} en ${groupLabel(group)} necesita ${entry.weekly_hours} h pero sólo existen ` +
          `${usable.size} horarios compatibles con sus profesores.`,
          { group_id: gid, subject_id: entry.subject_id, missing_hours: entry.weekly_hours - usable.size }));
      }
    }
  }
  return out;
}

function checkMaxPerDay(ctx) {
  const out = [];
  const nDays = ctx.nDays;
  for (const gid of ctx.groupOrder) {
    const group = ctx.groups.get(gid);
    for (const entry of group.curriculum) {
      const ceiling = entry.max_per_day * nDays;
      if (entry.weekly_hours > ceiling) {
        const subjectName = ctx.subjects.get(entry.subject_id)?.name || entry.subject_id;
        out.push(conflict('error', 'MAX_PER_DAY_TOO_LOW',
          `${subjectName} en ${groupLabel(group)}: ${entry.weekly_hours} h semanales no caben con un ` +
          `tope de ${entry.max_per_day} h/día en ${nDays} días.`,
          { group_id: gid, subject_id: entry.subject_id, missing_hours: entry.weekly_hours - ceiling }));
      }
    }
  }
  return out;
}

function checkSubjectCapacity(ctx) {
  const out = [];
  const demand = new Map();
  const boundToTutor = new Map();
  for (const gid of ctx.groupOrder) {
    for (const entry of ctx.groups.get(gid).curriculum) {
      demand.set(entry.subject_id, (demand.get(entry.subject_id) || 0) + entry.weekly_hours);
      if (entry.weekly_hours) {
        const prev = boundToTutor.get(entry.subject_id);
        boundToTutor.set(entry.subject_id, prev === undefined ? entry.assign_to_tutor : prev && entry.assign_to_tutor);
      }
    }
  }

  for (const [sid, hours] of demand) {
    if (!hours || boundToTutor.get(sid)) continue;   // las tutorías se validan por elegibilidad
    let capacity = 0;
    let slotCapacity = 0;
    for (const tid of ctx.teacherOrder) {
      if (ctx.teachers.get(tid).subject_ids.includes(sid)) {
        capacity += ctx.teacherMaxWeekly.get(tid);
        slotCapacity += ctx.teacherSlots.get(tid).size;
      }
    }
    const effective = Math.min(capacity, slotCapacity);
    const subjectName = ctx.subjects.get(sid)?.name || sid;
    if (effective < hours) {
      out.push(conflict('error', 'SUBJECT_CAPACITY',
        `${subjectName}: la escuela requiere ${hours} h semanales y sus profesores sólo pueden cubrir ` +
        `${effective} h (carga máxima ${capacity} h, disponibilidad ${slotCapacity} h). ` +
        'Contrata apoyo o baja las horas del plan.',
        { subject_id: sid, missing_hours: hours - effective }));
    } else if (effective < hours * 1.1) {
      out.push(conflict('warning', 'SUBJECT_CAPACITY_TIGHT',
        `${subjectName} va muy justa: ${hours} h requeridas contra ${effective} h disponibles. ` +
        'Es probable que falten horas por acomodar.',
        { subject_id: sid }));
    }
  }
  return out;
}

function checkGlobalCapacity(ctx) {
  const demand = ctx.requiredHours;
  let capacity = 0;
  for (const cap of ctx.teacherMaxWeekly.values()) capacity += cap;

  if (demand > capacity) {
    return [conflict('error', 'GLOBAL_CAPACITY',
      `La escuela requiere ${demand} horas-clase semanales y la plantilla suma ${capacity} horas ` +
      `contratadas. Faltan ${demand - capacity} h.`,
      { missing_hours: demand - capacity })];
  }
  if (demand > capacity * 0.95) {
    return [conflict('warning', 'GLOBAL_CAPACITY_TIGHT',
      `Se usará más del 95 % de la plantilla (${demand}/${capacity} h). Con tan poco margen es normal ` +
      'que el horario quede con huecos difíciles.')];
  }
  return [];
}

function checkTeacherAvailability(ctx) {
  const out = [];
  for (const tid of ctx.teacherOrder) {
    const teacher = ctx.teachers.get(tid);
    const available = ctx.teacherSlots.get(tid).size;
    if (teacher.max_weekly_hours > 0 && available === 0) {
      out.push(conflict('warning', 'TEACHER_NO_AVAILABILITY',
        `${teacher.name} tiene ${teacher.max_weekly_hours} h contratadas pero su matriz de ` +
        'disponibilidad no deja ningún horario libre.',
        { teacher_id: tid }));
    } else if (available < teacher.max_weekly_hours) {
      out.push(conflict('info', 'TEACHER_AVAILABILITY_BELOW_CONTRACT',
        `${teacher.name} sólo está disponible ${available} h de las ${teacher.max_weekly_hours} h contratadas.`,
        { teacher_id: tid }));
    }
  }
  return out;
}
