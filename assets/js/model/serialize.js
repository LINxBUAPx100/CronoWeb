/**
 * Traducción entre el modelo de captura y el contrato del motor.
 *
 *   modelToScenario()  modelo (formularios)  →  JSON de docs/CONTRACT.md
 *   scenarioToModel()  JSON del contrato     →  modelo (formularios)
 *
 * La ida se usa cada vez que se genera un horario. La vuelta se usa al abrir un
 * respaldo o el escenario de ejemplo, y es lo que permite que la escuela nunca
 * vea el JSON: entra como archivo y sale como formulario lleno.
 *
 * @module model/serialize
 */

import {
  buildBlocks, createEmptyModel, DAY_PRESETS, groupIdOf, PALETTE,
} from './school.js';

/** Etiqueta corta de día para los encabezados de tabla ("Lunes" → "LUN"). */
export const shortDay = (day) => String(day).slice(0, 3).toUpperCase();

// --------------------------------------------------------------------------- //
// Modelo → contrato
// --------------------------------------------------------------------------- //
/**
 * @param {object} model
 * @param {{mode?:'simple'|'custom', budget?:number, seed?:number}} [opts]
 * @returns {object} ScheduleRequest listo para el motor
 */
export function modelToScenario(model, opts = {}) {
  const { blocks } = buildBlocks(model.time);
  const classBlocks = blocks.filter((b) => b.kind === 'class');
  const days = model.time.days.map(shortDay);

  const subjects = model.subjects.map((subject, i) => ({
    id: subject.id,
    name: subject.name.trim() || `Materia ${i + 1}`,
    short_name: (subject.short || '').trim() || abbreviate(subject.name),
    color: subject.color || PALETTE[i % PALETTE.length],
    prefers_morning: Boolean(subject.prefersMorning),
    room_requirement: null,
  }));

  const teachers = model.teachers.map((teacher, i) => ({
    id: teacher.id,
    name: teacher.name.trim() || `Profesor ${i + 1}`,
    subject_ids: [...teacher.subjectIds],
    max_weekly_hours: Math.max(0, Number(teacher.maxWeekly) || 0),
    max_daily_hours: teacher.maxDaily == null ? classBlocks.length : Number(teacher.maxDaily),
    availability_mode: 'blacklist',
    availability: blockedToMatrix(teacher.blocked, days),
    can_be_tutor: teacher.canBeTutor !== false,
    tutor_priority: Number(teacher.tutorPriority) || 0,
    notes: teacher.notes || null,
  }));

  // El plan se captura por GRADO y aquí se expande a cada uno de sus grupos:
  // es la forma en que las escuelas piensan el plan de estudios.
  const groups = [];
  for (const grade of model.grades) {
    const curriculum = grade.plan
      .filter((entry) => Number(entry.hours) > 0)
      .map((entry) => ({
        subject_id: entry.subjectId,
        weekly_hours: Number(entry.hours),
        max_per_day: Math.max(1, Number(entry.maxPerDay) || 2),
        preferred_teacher_id: entry.preferredTeacherId || null,
        fixed_teacher_id: entry.assignToTutor ? null : (entry.fixedTeacherId || null),
        assign_to_tutor: Boolean(entry.assignToTutor),
      }));

    for (const group of grade.groups) {
      groups.push({
        id: groupIdOf(grade, group),
        grade: grade.name,
        name: group.name,
        shift: grade.shift || null,
        blocked_slots: group.blockedSlots || [],
        curriculum: curriculum.map((entry) => ({ ...entry })),
      });
    }
  }

  const custom = opts.mode === 'custom';
  return {
    schema_version: '1.0',
    tenant_id: null,
    grid: { days, blocks },
    subjects,
    teachers,
    groups,
    options: {
      time_budget_seconds: Number(opts.budget) || 8,
      max_restarts: 6,
      max_branch: 8,
      mrv_sample: 48,
      seed: Number(opts.seed) || 12345,
      enable_repair: true,
      allow_partial: true,
    },
    branding: {
      mode: custom ? 'custom' : 'simple',
      school_name: custom ? (model.school.name || null) : null,
      logo_data_url: custom ? (model.school.logo || null) : null,
      primary_color: custom ? (model.school.primaryColor || '#22375c') : '#22375c',
      cycle_label: model.school.cycle || null,
      footer_note: custom ? (model.school.footerNote || null) : null,
    },
  };
}

/** "Formación Cívica y Ética" → "FCyE"; "Español" → "Espa". */
export function abbreviate(name) {
  const clean = String(name || '').trim();
  if (!clean) return '—';
  const words = clean.split(/\s+/).filter((w) => w.length > 2);
  if (words.length >= 2) {
    return words.map((w) => w[0].toUpperCase()).join('').slice(0, 5);
  }
  return clean.slice(0, 5);
}

/** `["0|B1", "3|B4"]` → `{ LUN: ["B1"], JUE: ["B4"] }` */
function blockedToMatrix(blocked, days) {
  const matrix = {};
  for (const key of blocked || []) {
    const [dayIndex, blockId] = String(key).split('|');
    const day = days[Number(dayIndex)];
    if (!day || !blockId) continue;
    (matrix[day] ||= []).push(blockId);
  }
  return Object.keys(matrix).length ? matrix : null;
}

// --------------------------------------------------------------------------- //
// Contrato → modelo
// --------------------------------------------------------------------------- //
/**
 * Reconstruye el modelo de captura desde un escenario del contrato.
 *
 * La rejilla se re-deduce: se toma la hora de inicio del primer bloque, la
 * duración del primero de clase y los recesos se detectan por su posición. Si el
 * archivo trae bloques de duración irregular, se conserva la duración del primero
 * y se avisa — el editor visual trabaja con clases de duración uniforme.
 *
 * @returns {{model:object, warnings:string[]}}
 */
export function scenarioToModel(scenario) {
  const warnings = [];
  const model = createEmptyModel();
  const blocks = scenario?.grid?.blocks || [];
  const classBlocks = blocks.filter((b) => b.kind !== 'break');

  // ── Días ──────────────────────────────────────────────────────────────
  const rawDays = scenario?.grid?.days || [];
  model.time.days = rawDays.length ? rawDays.map(expandDay) : [...DAY_PRESETS['lun-vie']];

  // ── Horario ───────────────────────────────────────────────────────────
  if (classBlocks.length) {
    model.time.startTime = classBlocks[0].start || '07:00';
    model.time.classesPerDay = classBlocks.length;
    const minutes = diffMinutes(classBlocks[0].start, classBlocks[0].end);
    model.time.classMinutes = minutes || 60;

    const irregular = classBlocks.some((b) => diffMinutes(b.start, b.end) !== minutes);
    if (irregular) {
      warnings.push(
        'El archivo tenía clases de distinta duración. Se unificaron a ' +
        `${minutes} minutos; revisa la pestaña Horario.`,
      );
    }

    model.time.breaks = [];
    let classCount = 0;
    for (const block of blocks) {
      if (block.kind === 'break') {
        model.time.breaks.push({
          afterClass: classCount,
          minutes: diffMinutes(block.start, block.end) || 20,
          label: block.label || 'Receso',
        });
      } else {
        classCount += 1;
      }
    }
  }

  // ── Materias ──────────────────────────────────────────────────────────
  model.subjects = (scenario?.subjects || []).map((subject, i) => ({
    id: subject.id || `S${i + 1}`,
    name: subject.name || `Materia ${i + 1}`,
    short: subject.short_name || '',
    color: subject.color || PALETTE[i % PALETTE.length],
    prefersMorning: Boolean(subject.prefers_morning),
  }));

  // ── Profesores ────────────────────────────────────────────────────────
  const shortDays = (scenario?.grid?.days || []).map(String);
  const classIds = classBlocks.map((b) => b.id);
  model.teachers = (scenario?.teachers || []).map((teacher, i) => ({
    id: teacher.id || `T${i + 1}`,
    name: teacher.name || `Profesor ${i + 1}`,
    subjectIds: [...(teacher.subject_ids || [])],
    maxWeekly: Number(teacher.max_weekly_hours) || 0,
    maxDaily: teacher.max_daily_hours ?? null,
    canBeTutor: teacher.can_be_tutor !== false,
    blocked: matrixToBlocked(teacher, shortDays, classIds),
    tutorPriority: Number(teacher.tutor_priority) || 0,
    notes: teacher.notes || '',
  }));

  // ── Grados y grupos ───────────────────────────────────────────────────
  // Los grupos del contrato se agrupan por su campo `grade`, y el plan se toma
  // del primer grupo de cada grado (en el contrato es idéntico para todos).
  const byGrade = new Map();
  for (const group of scenario?.groups || []) {
    const key = group.grade ?? group.id;
    if (!byGrade.has(key)) byGrade.set(key, []);
    byGrade.get(key).push(group);
  }

  model.grades = [...byGrade.entries()].map(([gradeName, groupList], i) => {
    const first = groupList[0];
    const planned = new Map((first.curriculum || []).map((c) => [c.subject_id, c]));

    const divergent = groupList.some((g) => (g.curriculum || []).length !== (first.curriculum || []).length);
    if (divergent) {
      warnings.push(
        `Los grupos del grado ${gradeName} traían planes de estudio distintos. ` +
        `Se tomó el de ${first.id} para todo el grado.`,
      );
    }

    return {
      id: `G${i + 1}`,
      name: String(gradeName),
      shift: first.shift || 'matutino',
      groups: groupList.map((g) => ({ name: g.name || g.id, blockedSlots: g.blocked_slots || [] })),
      plan: model.subjects.map((subject) => {
        const entry = planned.get(subject.id);
        return {
          subjectId: subject.id,
          hours: entry ? Number(entry.weekly_hours) || 0 : 0,
          maxPerDay: entry ? Number(entry.max_per_day) || 2 : 2,
          assignToTutor: Boolean(entry?.assign_to_tutor),
          preferredTeacherId: entry?.preferred_teacher_id || null,
          fixedTeacherId: entry?.fixed_teacher_id || null,
        };
      }),
    };
  });

  // ── Identidad ─────────────────────────────────────────────────────────
  const branding = scenario?.branding || {};
  model.school = {
    name: branding.school_name || '',
    cycle: branding.cycle_label || '',
    logo: branding.logo_data_url || null,
    primaryColor: branding.primary_color || '#22375c',
    footerNote: branding.footer_note || '',
  };

  return { model, warnings };
}

/** `{ LUN: ["B1"] }` (o whitelist) → `["0|B1"]` de horas bloqueadas. */
function matrixToBlocked(teacher, days, classIds) {
  const matrix = teacher.availability;
  if (!matrix || !Object.keys(matrix).length) return [];

  const blocked = [];
  const whitelist = teacher.availability_mode === 'whitelist';
  days.forEach((day, dayIndex) => {
    const listed = new Set(matrix[day] || []);
    for (const blockId of classIds) {
      // whitelist: bloqueado = lo que NO está listado. blacklist: lo que sí.
      const isBlocked = whitelist ? !listed.has(blockId) : listed.has(blockId);
      if (isBlocked) blocked.push(`${dayIndex}|${blockId}`);
    }
  });
  return blocked;
}

const DAY_NAMES = {
  LUN: 'Lunes', MAR: 'Martes', MIE: 'Miércoles', MIÉ: 'Miércoles',
  JUE: 'Jueves', VIE: 'Viernes', SAB: 'Sábado', SÁB: 'Sábado', DOM: 'Domingo',
};

const expandDay = (day) => DAY_NAMES[String(day).toUpperCase()] || String(day);

function diffMinutes(start, end) {
  const [sh, sm] = String(start || '').split(':').map(Number);
  const [eh, em] = String(end || '').split(':').map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  return (eh * 60 + em) - (sh * 60 + sm);
}
