/**
 * Verificación del motor JS contra el mismo escenario que usa el backend.
 *
 * Es el espejo de `backend/tests/test_solver.py`: incluye un verificador
 * INDEPENDIENTE de restricciones duras, para que un horario con cruces nunca
 * pase desapercibido aunque el solver crea que terminó bien.
 *
 *   node tools/verify-engine.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { generateSchedule } from '../assets/js/engine/index.js';
import { resolveBranding } from '../assets/js/engine/branding.js';
import {
  applyMove, candidatesFor, createEditSession, isDirty, rebuildResponse, resetSession, undo,
} from '../assets/js/model/edit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(readFileSync(join(ROOT, 'backend/samples/demo_secundaria.json'), 'utf8'));

let failures = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${name}\n       ${error.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// --------------------------------------------------------------------------- //
// Verificador independiente de restricciones duras
// --------------------------------------------------------------------------- //
function assertHardConstraints(request, response) {
  const teachers = new Map(request.teachers.map((t) => [t.id, t]));
  const groups = new Map(request.groups.map((g) => [g.id, g]));
  const classBlocks = new Set(request.grid.blocks.filter((b) => b.kind === 'class').map((b) => b.id));
  const tutorOf = new Map(response.tutors.map((t) => [t.group_id, t.teacher_id]));

  const teacherSlot = new Set();
  const groupSlot = new Set();
  const weekly = new Map();
  const daily = new Map();
  const perDaySubject = new Map();
  const placed = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const a of response.assignments) {
    assert(classBlocks.has(a.block_id), `${a.block_id} no es bloque de clase`);
    assert(request.grid.days.includes(a.day), `${a.day} no existe en la rejilla`);

    // H1/H2 — sin cruces.
    const tk = `${a.teacher_id}|${a.day}|${a.block_id}`;
    assert(!teacherSlot.has(tk), `CRUCE: ${a.teacher_id} en dos lugares en ${a.day}-${a.block_id}`);
    teacherSlot.add(tk);
    const gk = `${a.group_id}|${a.day}|${a.block_id}`;
    assert(!groupSlot.has(gk), `CRUCE: grupo ${a.group_id} con dos clases en ${a.day}-${a.block_id}`);
    groupSlot.add(gk);

    // H3 — disponibilidad.
    const teacher = teachers.get(a.teacher_id);
    const matrix = teacher.availability;
    if (matrix && Object.keys(matrix).length) {
      const listed = (matrix[a.day] || []).includes(a.block_id);
      if (teacher.availability_mode === 'whitelist') {
        assert(listed, `${a.teacher_id} fuera de su whitelist (${a.day}-${a.block_id})`);
      } else {
        assert(!listed, `${a.teacher_id} en hora bloqueada (${a.day}-${a.block_id})`);
      }
    }

    // H6 — elegibilidad.
    const entry = groups.get(a.group_id).curriculum.find((c) => c.subject_id === a.subject_id);
    if (entry.assign_to_tutor) {
      assert(a.teacher_id === tutorOf.get(a.group_id), 'tutoría impartida por quien no es tutor');
    } else if (entry.fixed_teacher_id) {
      assert(a.teacher_id === entry.fixed_teacher_id, 'no se respetó fixed_teacher_id');
    } else {
      assert(teacher.subject_ids.includes(a.subject_id), `${a.teacher_id} no imparte ${a.subject_id}`);
    }

    bump(weekly, a.teacher_id);
    bump(daily, `${a.teacher_id}|${a.day}`);
    bump(perDaySubject, `${a.group_id}|${a.subject_id}|${a.day}`);
    bump(placed, `${a.group_id}|${a.subject_id}`);
  }

  // H4 — cargas.
  for (const [tid, hours] of weekly) {
    assert(hours <= teachers.get(tid).max_weekly_hours, `${tid} rebasa su carga semanal`);
  }
  for (const [key, hours] of daily) {
    const tid = key.split('|')[0];
    const cap = teachers.get(tid).max_daily_hours ?? classBlocks.size;
    assert(hours <= cap, `${tid} rebasa su carga diaria`);
  }

  // H5 — tope diario por materia y horas del plan.
  for (const [gid, group] of groups) {
    for (const c of group.curriculum) {
      for (const day of request.grid.days) {
        const n = perDaySubject.get(`${gid}|${c.subject_id}|${day}`) || 0;
        assert(n <= c.max_per_day, `${gid}/${c.subject_id} excede max_per_day en ${day}`);
      }
      const n = placed.get(`${gid}|${c.subject_id}`) || 0;
      assert(n <= c.weekly_hours, `${gid}/${c.subject_id} tiene más horas que las pedidas`);
    }
    for (const blocked of group.blocked_slots) {
      assert(!groupSlot.has(`${gid}|${blocked.day}|${blocked.block_id}`), `${gid} usó un bloque bloqueado`);
    }
  }
}

// --------------------------------------------------------------------------- //
console.log('\nCronoWeb · verificación del motor JS\n');

const base = generateSchedule(demo, { plan: 'free' });
console.log(
  `  escenario demo: ${base.metrics.placed_hours}/${base.metrics.required_hours} h · ` +
  `huecos=${base.metrics.teacher_gaps} · score=${base.metrics.soft_score} · ` +
  `reinicios=${base.metrics.restarts} · ${base.metrics.elapsed_ms} ms\n`,
);

test('el escenario demo se resuelve al 100 %', () => {
  assert(base.status === 'ok', `status=${base.status}: ${base.conflicts.map((c) => c.message).join(' | ')}`);
  assert(base.metrics.placed_hours === base.metrics.required_hours, 'faltaron horas');
});

test('no hay cruces ni violaciones de restricciones duras', () => {
  assertHardConstraints(demo, base);
});

test('todas las horas del plan de estudios quedan cubiertas', () => {
  const count = new Map();
  for (const a of base.assignments) {
    const k = `${a.group_id}|${a.subject_id}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  for (const g of demo.groups) {
    for (const c of g.curriculum) {
      assert(
        (count.get(`${g.id}|${c.subject_id}`) || 0) === c.weekly_hours,
        `${g.id}/${c.subject_id}: ${count.get(`${g.id}|${c.subject_id}`) || 0} de ${c.weekly_hours} h`,
      );
    }
  }
});

test('tutores 1 a 1 cuando sobran profesores', () => {
  const ids = base.tutors.map((t) => t.teacher_id);
  assert(ids.length === demo.groups.length, 'falta algún grupo por tutor');
  assert(ids.every(Boolean), 'hay grupos sin tutor');
  assert(new Set(ids).size === ids.length, 'hay tutores repetidos habiendo profesores libres');
  assert(!base.tutors.some((t) => t.shared), 'se marcó tutor compartido sin necesidad');
});

test('tutores compartidos cuando faltan profesores (por menor carga)', () => {
  const payload = clone(demo);
  payload.teachers.forEach((t, i) => { t.can_be_tutor = i < 4; });
  const res = generateSchedule(payload, { plan: 'free' });
  const ids = res.tutors.map((t) => t.teacher_id);
  assert(ids.every(Boolean), 'hay grupos sin tutor');
  assert(new Set(ids).size === 4, `se usaron ${new Set(ids).size} tutores distintos, se esperaban 4`);
  assert(res.conflicts.some((c) => c.code === 'TUTORS_SHARED'), 'no se avisó del tutor compartido');
});

test('la disponibilidad estricta se respeta', () => {
  const diasT10 = new Set(base.assignments.filter((a) => a.teacher_id === 'T10').map((a) => a.day));
  assert([...diasT10].every((d) => ['LUN', 'MIE', 'VIE'].includes(d)), 'T10 asignado fuera de su whitelist');
  assert(!base.assignments.some((a) => a.teacher_id === 'T02' && a.day === 'VIE'), 'T02 asignado en viernes');
});

test('materia sin profesor ⇒ infactible con diagnóstico', () => {
  const payload = clone(demo);
  payload.teachers.forEach((t) => { t.subject_ids = t.subject_ids.filter((s) => s !== 'MAT'); });
  const res = generateSchedule(payload, { plan: 'free' });
  assert(res.status === 'infeasible', `status=${res.status}`);
  assert(res.conflicts.some((c) => c.code === 'NO_ELIGIBLE_TEACHER'), 'sin conflicto NO_ELIGIBLE_TEACHER');
  assert(res.assignments.length === 0, 'no debería devolver asignaciones');
});

test('plan más grande que la rejilla ⇒ infactible', () => {
  const payload = clone(demo);
  payload.groups[0].curriculum[0].weekly_hours = 40;
  const res = generateSchedule(payload, { plan: 'free' });
  assert(res.status === 'infeasible', `status=${res.status}`);
  assert(res.conflicts.some((c) => c.code === 'GROUP_OVER_CAPACITY'), 'sin conflicto GROUP_OVER_CAPACITY');
});

test('horario parcial: reporta horas faltantes y lo colocado es válido', () => {
  const payload = clone(demo);
  payload.teachers.forEach((t) => { if (t.subject_ids.includes('ESP')) t.max_weekly_hours = 8; });
  payload.options.time_budget_seconds = 3;
  const res = generateSchedule(payload, { plan: 'free' });
  assert(['partial', 'infeasible'].includes(res.status), `status=${res.status}`);
  assert(res.conflicts.some((c) => c.missing_hours), 'no explicó qué horas faltaron');
  if (res.status === 'partial') assertHardConstraints(payload, res);
});

test('fixed_teacher_id se respeta', () => {
  const payload = clone(demo);
  payload.groups[0].curriculum.forEach((c) => { if (c.subject_id === 'MAT') c.fixed_teacher_id = 'T03'; });
  const res = generateSchedule(payload, { plan: 'free' });
  const mat = res.assignments.filter((a) => a.group_id === '1A' && a.subject_id === 'MAT');
  assert(mat.length > 0 && mat.every((a) => a.teacher_id === 'T03'), 'no se respetó el profesor fijo');
  assertHardConstraints(payload, res);
});

test('resultado reproducible con la misma semilla', () => {
  const firma = (r) => r.assignments
    .map((a) => `${a.group_id}${a.subject_id}${a.teacher_id}${a.day}${a.block_id}`).sort().join(',');
  assert(firma(base) === firma(generateSchedule(clone(demo), { plan: 'free' })), 'resultados distintos');
});

test('plan free degrada el modo personalizado y conserva la marca de agua', () => {
  const { resolved, conflicts } = resolveBranding(
    { mode: 'custom', school_name: 'Secundaria X', logo_data_url: 'data:image/png;base64,AAA' },
    'free',
  );
  assert(resolved.mode === 'simple', 'no degradó a simple');
  assert(resolved.school_name === null && resolved.logo_data_url === null, 'filtró datos de la escuela');
  assert(resolved.watermark_required && resolved.watermark_text === 'CronoWeb.com', 'perdió la marca de agua');
  assert(conflicts.some((c) => c.code === 'BRANDING_DOWNGRADED'), 'no avisó de la degradación');
});

test('plan escuela permite personalización y mantiene el crédito', () => {
  const { resolved } = resolveBranding(
    { mode: 'custom', school_name: 'Secundaria X', logo_data_url: 'data:image/png;base64,AAA' },
    'school',
  );
  assert(resolved.mode === 'custom' && resolved.show_logo, 'no habilitó el modo personalizado');
  assert(resolved.watermark_required, 'la marca de agua debe sobrevivir incluso en plan de pago');
});

test('el motor JS y el backend producen métricas equivalentes', () => {
  // Mismo contrato ⇒ misma cantidad de horas requeridas y colocadas.
  assert(base.metrics.required_hours === 198, `required=${base.metrics.required_hours}`);
  assert(base.engine === 'js-backtracking-1.0', `engine=${base.engine}`);
});

// --------------------------------------------------------------------------- //
// Edición manual (model/edit.js)
// --------------------------------------------------------------------------- //
const editRequest = clone(demo);
const editBase = generateSchedule(editRequest, { plan: 'free' });

test('cada movimiento propuesto produce un horario válido', () => {
  // Se recorren varias clases y se aplica su PRIMER destino sugerido; tras cada
  // movimiento el horario COMPLETO vuelve a pasar por el verificador
  // independiente. Si la validación del editor tuviera un hueco, se cae aquí.
  const session = createEditSession(editRequest, editBase);
  let aplicados = 0;

  for (const index of [0, 7, 19, 33, 52, 80]) {
    if (index >= session.assignments.length) continue;
    const options = candidatesFor(session, index);
    if (!options.size) continue;
    const target = [...options.values()][0];
    const result = applyMove(session, index, target.day, target.blockId);
    assert(result.ok, `movimiento rechazado: ${result.error}`);
    aplicados += 1;
    assertHardConstraints(editRequest, rebuildResponse(editRequest, editBase, session.assignments));
  }
  assert(aplicados >= 4, `sólo se pudieron aplicar ${aplicados} movimientos`);
});

test('el editor rechaza los movimientos que crean un cruce', () => {
  const session = createEditSession(editRequest, editBase);
  const source = session.assignments[0];
  const clash = session.assignments.find(
    (a, i) => i > 0 && a.teacher_id === source.teacher_id && a.group_id !== source.group_id,
  );
  assert(clash, 'el escenario debería tener un profesor con dos grupos');

  const options = candidatesFor(session, 0);
  assert(!options.has(`c|${clash.day}|${clash.block_id}`), 'se ofreció una casilla que genera cruce');

  const result = applyMove(session, 0, clash.day, clash.block_id);
  assert(!result.ok, 'se permitió un movimiento que crea un cruce');
});

test('la disponibilidad del profesor se respeta al mover', () => {
  const session = createEditSession(editRequest, editBase);
  // T02 no trabaja los viernes: ninguna de sus clases puede ofrecer un viernes.
  const index = session.assignments.findIndex((a) => a.teacher_id === 'T02');
  assert(index >= 0, 'no se encontró clase de T02');
  for (const [, target] of candidatesFor(session, index)) {
    assert(target.day !== 'VIE', 'se ofreció viernes a un profesor que no trabaja viernes');
  }
});

test('mover no cambia el total de horas de ninguna materia', () => {
  const session = createEditSession(editRequest, editBase);
  const contar = (list) => {
    const m = new Map();
    for (const a of list) {
      const k = `${a.group_id}|${a.subject_id}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const antes = contar(session.assignments);
  for (const index of [3, 11, 40]) {
    const options = candidatesFor(session, index);
    if (options.size) {
      const t = [...options.values()][0];
      applyMove(session, index, t.day, t.blockId);
    }
  }
  const despues = contar(session.assignments);
  for (const [key, n] of antes) assert(despues.get(key) === n, `cambió el total de ${key}`);
});

test('deshacer y restaurar devuelven el horario original', () => {
  const session = createEditSession(editRequest, editBase);
  const firma = (list) => list.map((a) => `${a.group_id}${a.subject_id}${a.day}${a.block_id}`).sort().join();
  const original = firma(session.assignments);

  const target = [...candidatesFor(session, 5).values()][0];
  assert(target, 'la clase 5 no tenía destinos');
  applyMove(session, 5, target.day, target.blockId);
  assert(isDirty(session), 'no se marcó como editado');
  assert(firma(session.assignments) !== original, 'el movimiento no cambió nada');

  assert(undo(session), 'deshacer falló');
  assert(firma(session.assignments) === original, 'deshacer no restauró el horario');
  assert(!isDirty(session), 'sigue marcado como editado tras deshacer');

  applyMove(session, 5, target.day, target.blockId);
  resetSession(session);
  assert(firma(session.assignments) === original, 'restaurar no devolvió el original');
});

test('las métricas y los índices se recalculan tras editar', () => {
  const session = createEditSession(editRequest, editBase);
  const target = [...candidatesFor(session, 2).values()][0];
  applyMove(session, 2, target.day, target.blockId);
  const rebuilt = rebuildResponse(editRequest, editBase, session.assignments);

  assert(rebuilt.assignments.length === editBase.assignments.length, 'se perdieron clases');
  assert(Number.isFinite(rebuilt.metrics.teacher_gaps), 'las horas muertas no se recalcularon');
  const cargaTotal = Object.values(rebuilt.metrics.teacher_load).reduce((a, l) => a + l.assigned, 0);
  assert(cargaTotal === editBase.metrics.placed_hours, 'la suma de cargas no cuadra');

  const moved = session.assignments[2];
  assert(rebuilt.by_group[moved.group_id][moved.day][moved.block_id]?.subject_id === moved.subject_id,
    'by_group no se reconstruyó');
  assert(rebuilt.by_teacher[moved.teacher_id][moved.day][moved.block_id]?.group_id === moved.group_id,
    'by_teacher no se reconstruyó');
});

console.log(results.join('\n'));
console.log(`\n${failures ? `${failures} prueba(s) FALLARON` : 'todas las pruebas pasaron'}\n`);
process.exit(failures ? 1 : 0);
