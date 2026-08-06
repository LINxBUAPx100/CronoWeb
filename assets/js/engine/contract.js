/**
 * Contrato de datos en el navegador: defaults + validación estructural.
 *
 * Equivale a lo que Pydantic hace en el backend (`backend/app/models/schemas.py`).
 * Sin esto, un JSON con un campo faltante reventaría a mitad del solver con un
 * `undefined` incomprensible; aquí falla temprano y con un mensaje en español.
 *
 * @module engine/contract
 */

export const SCHEMA_VERSION = '1.0';

export const DEFAULT_WEIGHTS = Object.freeze({
  same_day_repeat: 6.0,
  teacher_gap: 3.0,
  morning_preference: 1.5,
  tutor_affinity: -4.0,
  preferred_teacher: 2.5,
  daily_balance: 0.75,
  late_block_penalty: 0.5,
  teacher_utilization: 5.0,
});

export const DEFAULT_OPTIONS = Object.freeze({
  time_budget_seconds: 8.0,
  max_restarts: 6,
  max_branch: 8,
  mrv_sample: 48,
  seed: 12345,
  enable_repair: true,
  allow_partial: true,
});

export const DEFAULT_BRANDING = Object.freeze({
  mode: 'simple',
  school_name: null,
  logo_data_url: null,
  primary_color: '#22375c',
  cycle_label: null,
  footer_note: null,
});

/** Error de contrato: el JSON de entrada está mal formado. */
export class ContractError extends Error {
  /** @param {string[]} issues */
  constructor(issues) {
    super(`Datos inválidos: ${issues.length} problema(s)`);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (v, fallback = null) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const int = (v, fallback) => (Number.isFinite(v) ? Math.trunc(v) : fallback);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const bool = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback);

/**
 * Rellena defaults y valida estructura + integridad referencial.
 * @param {object} raw
 * @returns {object} petición normalizada
 * @throws {ContractError}
 */
export function normalizeRequest(raw) {
  const issues = [];
  if (!isObj(raw)) throw new ContractError(['El cuerpo debe ser un objeto JSON']);

  const version = str(raw.schema_version, SCHEMA_VERSION);
  if (version.split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
    issues.push(`schema_version ${version} no soportada (se espera ${SCHEMA_VERSION})`);
  }

  // ── Rejilla ──────────────────────────────────────────────────────────
  const grid = isObj(raw.grid) ? raw.grid : {};
  const days = asArray(grid.days).map((d) => str(d)).filter(Boolean);
  if (!days.length) issues.push('grid.days no puede estar vacío');
  if (new Set(days).size !== days.length) issues.push('grid.days tiene días repetidos');

  const blocks = asArray(grid.blocks).map((b, i) => ({
    id: str(b?.id, `B${i + 1}`),
    label: str(b?.label, `${i + 1}`),
    start: str(b?.start, '00:00'),
    end: str(b?.end, '00:00'),
    kind: b?.kind === 'break' ? 'break' : 'class',
  }));
  if (!blocks.length) issues.push('grid.blocks no puede estar vacío');
  if (new Set(blocks.map((b) => b.id)).size !== blocks.length) issues.push('grid.blocks tiene ids repetidos');
  if (!blocks.some((b) => b.kind === 'class')) issues.push('Se requiere al menos un bloque de clase');

  const blockIds = new Set(blocks.map((b) => b.id));
  const daySet = new Set(days);

  // ── Materias ─────────────────────────────────────────────────────────
  const subjects = asArray(raw.subjects).map((s, i) => ({
    id: str(s?.id, `S${i + 1}`),
    name: str(s?.name, `Materia ${i + 1}`),
    short_name: str(s?.short_name),
    color: str(s?.color),
    prefers_morning: bool(s?.prefers_morning),
    room_requirement: str(s?.room_requirement),
  }));
  if (!subjects.length) issues.push('Debes capturar al menos una materia');
  const subjectIds = new Set(subjects.map((s) => s.id));

  // ── Profesores ───────────────────────────────────────────────────────
  const nClassBlocks = blocks.filter((b) => b.kind === 'class').length;
  const teachers = asArray(raw.teachers).map((t, i) => {
    const id = str(t?.id, `T${String(i + 1).padStart(2, '0')}`);
    const availability = isObj(t?.availability) ? t.availability : null;
    if (availability) {
      for (const [day, list] of Object.entries(availability)) {
        if (!daySet.has(day)) issues.push(`Profesor ${id}: día '${day}' no existe en la rejilla`);
        for (const bid of asArray(list)) {
          if (!blockIds.has(bid)) issues.push(`Profesor ${id}: bloque '${bid}' no existe`);
        }
      }
    }
    const subjectList = asArray(t?.subject_ids).map((s) => str(s)).filter(Boolean);
    for (const sid of subjectList) {
      if (!subjectIds.has(sid)) issues.push(`Profesor ${id}: materia inexistente '${sid}'`);
    }
    return {
      id,
      name: str(t?.name, id),
      subject_ids: subjectList,
      max_weekly_hours: Math.max(0, int(t?.max_weekly_hours, 0)),
      max_daily_hours: t?.max_daily_hours == null ? nClassBlocks : Math.max(0, int(t.max_daily_hours, nClassBlocks)),
      availability_mode: t?.availability_mode === 'whitelist' ? 'whitelist' : 'blacklist',
      availability,
      can_be_tutor: bool(t?.can_be_tutor, true),
      tutor_priority: int(t?.tutor_priority, 0),
      notes: str(t?.notes),
    };
  });
  if (!teachers.length) issues.push('Debes capturar al menos un profesor');
  const teacherIds = new Set(teachers.map((t) => t.id));

  // ── Grupos ───────────────────────────────────────────────────────────
  const groups = asArray(raw.groups).map((g, i) => {
    const id = str(g?.id, `G${i + 1}`);
    const curriculum = asArray(g?.curriculum).map((c) => {
      const sid = str(c?.subject_id, '');
      if (!subjectIds.has(sid)) issues.push(`Grupo ${id}: materia inexistente '${sid}'`);
      for (const field of ['preferred_teacher_id', 'fixed_teacher_id']) {
        const tid = str(c?.[field]);
        if (tid && !teacherIds.has(tid)) issues.push(`Grupo ${id}/${sid}: ${field} inexistente '${tid}'`);
      }
      return {
        subject_id: sid,
        weekly_hours: Math.max(0, int(c?.weekly_hours, 0)),
        max_per_day: Math.max(1, int(c?.max_per_day, 2)),
        preferred_teacher_id: str(c?.preferred_teacher_id),
        fixed_teacher_id: str(c?.fixed_teacher_id),
        assign_to_tutor: bool(c?.assign_to_tutor),
      };
    });
    const seen = new Set();
    for (const c of curriculum) {
      if (seen.has(c.subject_id)) issues.push(`Grupo ${id}: la materia '${c.subject_id}' está dos veces`);
      seen.add(c.subject_id);
    }
    return {
      id,
      grade: str(g?.grade, id),
      name: str(g?.name, ''),
      shift: str(g?.shift),
      blocked_slots: asArray(g?.blocked_slots)
        .map((b) => ({ day: str(b?.day, ''), block_id: str(b?.block_id, '') }))
        .filter((b) => b.day && b.block_id),
      curriculum,
    };
  });
  if (!groups.length) issues.push('Debes capturar al menos un grupo');
  if (new Set(groups.map((g) => g.id)).size !== groups.length) issues.push('Hay grupos con id repetido');

  if (issues.length) throw new ContractError(issues);

  const options = { ...DEFAULT_OPTIONS, ...(isObj(raw.options) ? raw.options : {}) };
  options.time_budget_seconds = Math.min(120, Math.max(0.5, num(options.time_budget_seconds, 8)));
  options.max_restarts = Math.max(0, int(options.max_restarts, 6));
  options.max_branch = Math.max(0, int(options.max_branch, 8));
  options.mrv_sample = Math.max(1, int(options.mrv_sample, 48));
  options.seed = int(options.seed, 12345);
  options.weights = { ...DEFAULT_WEIGHTS, ...(isObj(raw.options?.weights) ? raw.options.weights : {}) };

  return {
    schema_version: SCHEMA_VERSION,
    tenant_id: str(raw.tenant_id),
    grid: { days, blocks },
    subjects,
    teachers,
    groups,
    options,
    branding: { ...DEFAULT_BRANDING, ...(isObj(raw.branding) ? raw.branding : {}) },
  };
}

/** Etiqueta legible de un grupo: "1A". */
export const groupLabel = (group) => `${group.grade}${group.name}`;

/** Nombre corto de materia para la celda del horario. */
export const subjectShort = (subject) => subject.short_name || subject.name.slice(0, 6);
