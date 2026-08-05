/**
 * Orquestador del motor local — puerto JS de `backend/app/solver/engine.py`.
 *
 * Pipeline idéntico al del backend:
 *   normalizar → compilar → tutores → bind tutorías → validar
 *   → [abortar si ERROR] → backtracking → reparar → índices → métricas
 *   → diagnóstico → branding
 *
 * @module engine
 */

import { resolveBranding } from './branding.js';
import { ContractError, normalizeRequest, SCHEMA_VERSION } from './contract.js';
import { bindTutorLessons, compileProblem } from './domain.js';
import { buildMetrics } from './metrics.js';
import { diagnoseUnplaced } from './report.js';
import { buildIndexMaps, Scheduler } from './scheduler.js';
import { assignTutors, tutorMap } from './tutors.js';
import { hasBlockingErrors, validate } from './validator.js';

export const ENGINE_ID = 'js-backtracking-1.0';
export { ContractError, normalizeRequest };

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const emptyMetrics = (ctx) => buildMetrics(ctx, new Map(), { restarts: 0, elapsedMs: 0, softScore: 0 });

/**
 * Genera el horario completo.
 * @param {object} rawRequest JSON crudo (se normaliza aquí)
 * @param {{plan?:string, onProgress?:Function}} [opts]
 * @returns {object} ScheduleResponse (mismo shape que el backend)
 */
export function generateSchedule(rawRequest, opts = {}) {
  const plan = opts.plan || 'free';
  const request = normalizeRequest(rawRequest);
  const ctx = compileProblem(request);
  let conflicts = [];

  // 1. Tutores primero: su resultado se vuelve restricción dura de las materias
  //    marcadas `assign_to_tutor` y bonificación suave del resto.
  const { tutors, conflicts: tutorConflicts } = assignTutors(ctx);
  conflicts = conflicts.concat(tutorConflicts);
  const byGroupTutor = tutorMap(tutors);
  bindTutorLessons(ctx, byGroupTutor);

  // 2. Pre-vuelo.
  const validation = validate(ctx);
  conflicts = conflicts.concat(validation);

  const { resolved: branding, conflicts: brandingConflicts } = resolveBranding(request.branding, plan);
  conflicts = conflicts.concat(brandingConflicts);

  if (hasBlockingErrors(validation)) {
    return {
      schema_version: SCHEMA_VERSION,
      status: 'infeasible',
      generated_at: nowIso(),
      engine: ENGINE_ID,
      tutors,
      assignments: [],
      by_group: {},
      by_teacher: {},
      conflicts,
      metrics: emptyMetrics(ctx),
      branding,
    };
  }

  // 3. Búsqueda.
  const scheduler = new Scheduler(ctx, byGroupTutor, request.options, opts.onProgress);
  const result = scheduler.solve();

  // 4. Salida estructurada.
  const lessons = new Map(ctx.lessons.map((l) => [l.uid, l]));
  const assignments = [...result.assignment.entries()]
    .sort((a, b) => a[1].slot - b[1].slot || (a[0] < b[0] ? -1 : 1))
    .map(([uid, { slot, teacherId }]) => ({
      group_id: lessons.get(uid).groupId,
      subject_id: lessons.get(uid).subjectId,
      teacher_id: teacherId,
      day: ctx.slots[slot].day,
      block_id: ctx.slots[slot].blockId,
    }));

  const { by_group, by_teacher } = buildIndexMaps(ctx, result.assignment);
  conflicts = conflicts.concat(diagnoseUnplaced(ctx, result.assignment, result.unplaced));

  const metrics = buildMetrics(ctx, result.assignment, {
    restarts: result.restarts,
    elapsedMs: result.elapsedMs,
    softScore: result.softScore,
  });

  let status;
  if (result.complete) status = 'ok';
  else if (request.options.allow_partial) status = 'partial';
  else status = 'infeasible';

  return {
    schema_version: SCHEMA_VERSION,
    status,
    generated_at: nowIso(),
    engine: ENGINE_ID,
    tutors,
    assignments,
    by_group,
    by_teacher,
    conflicts,
    metrics,
    branding,
  };
}

/** Pre-vuelo sin resolver: avisa de problemas mientras se capturan los datos. */
export function validateOnly(rawRequest, opts = {}) {
  const plan = opts.plan || 'free';
  const request = normalizeRequest(rawRequest);
  const ctx = compileProblem(request);

  const { tutors, conflicts: tutorConflicts } = assignTutors(ctx);
  bindTutorLessons(ctx, tutorMap(tutors));
  const { resolved: branding, conflicts: brandingConflicts } = resolveBranding(request.branding, plan);
  const conflicts = [...tutorConflicts, ...validate(ctx), ...brandingConflicts];

  return {
    schema_version: SCHEMA_VERSION,
    status: hasBlockingErrors(conflicts) ? 'infeasible' : 'ok',
    generated_at: nowIso(),
    engine: ENGINE_ID,
    tutors,
    assignments: [],
    by_group: {},
    by_teacher: {},
    conflicts,
    metrics: emptyMetrics(ctx),
    branding,
  };
}
