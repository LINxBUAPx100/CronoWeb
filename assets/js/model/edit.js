/**
 * Edición manual del horario generado, con validación en vivo.
 *
 * Ningún horario sobrevive al primer lunes: el maestro de Artes pide no entrar a
 * primera hora, la dirección quiere Matemáticas más temprano. Antes la única
 * salida era regenerar todo y perder los ajustes previos. Aquí se puede mover una
 * clase de casilla y el sistema **sólo permite movimientos que respetan las
 * mismas restricciones duras que usó el motor**, así que un horario editado a
 * mano sigue siendo un horario válido.
 *
 * Este módulo es DOM-free a propósito: son funciones puras sobre
 * (request, assignments), y por eso se puede probar en Node igual que el motor
 * (`tools/verify-engine.mjs`).
 *
 * Alcance deliberado: **mover y permutar, nunca borrar ni crear**. Así el total
 * de horas por materia queda intacto y el plan de estudios se sigue cumpliendo;
 * un botón de «quitar clase» rompería esa garantía en silencio.
 *
 * @module model/edit
 */

const cellKey = (a, b, c) => `${a}|${b}|${c}`;

/**
 * Contexto de validación derivado de la petición. Se calcula una vez por sesión
 * de edición; no cambia al mover clases.
 */
export function buildEditContext(request) {
  const classBlocks = request.grid.blocks.filter((b) => b.kind !== 'break');
  const teachers = new Map(request.teachers.map((t) => [t.id, t]));
  const groups = new Map(request.groups.map((g) => [g.id, g]));

  // Slots prohibidos por disponibilidad del profesor.
  const teacherBlocked = new Map();
  for (const teacher of request.teachers) {
    const blocked = new Set();
    const matrix = teacher.availability;
    if (matrix && Object.keys(matrix).length) {
      const whitelist = teacher.availability_mode === 'whitelist';
      for (const day of request.grid.days) {
        const listed = new Set(matrix[day] || []);
        for (const block of classBlocks) {
          const isBlocked = whitelist ? !listed.has(block.id) : listed.has(block.id);
          if (isBlocked) blocked.add(`${day}|${block.id}`);
        }
      }
    }
    teacherBlocked.set(teacher.id, blocked);
  }

  const groupBlocked = new Map();
  for (const group of request.groups) {
    groupBlocked.set(group.id, new Set((group.blocked_slots || []).map((s) => `${s.day}|${s.block_id}`)));
  }

  return {
    days: request.grid.days,
    classBlocks,
    classBlockIds: new Set(classBlocks.map((b) => b.id)),
    teachers,
    groups,
    teacherBlocked,
    groupBlocked,
    maxDaily: new Map(request.teachers.map((t) => [t.id, t.max_daily_hours ?? classBlocks.length])),
    maxPerDay: new Map(
      request.groups.flatMap((g) => g.curriculum.map((c) => [`${g.id}|${c.subject_id}`, c.max_per_day])),
    ),
  };
}

/** Sesión de edición: copia de trabajo + historial para deshacer. */
export function createEditSession(request, response) {
  return {
    ctx: buildEditContext(request),
    original: response.assignments.map((a) => ({ ...a })),
    assignments: response.assignments.map((a) => ({ ...a })),
    history: [],
    moves: 0,
  };
}

export const isDirty = (session) => session.moves > 0;

/**
 * ¿Cabe `candidate` (una asignación hipotética) en (day, blockId)?
 *
 * `ignore` son índices que se consideran ya retirados del horario — es lo que
 * permite validar una permuta: ambas clases salen del tablero y se comprueba si
 * entran en su nuevo sitio.
 *
 * @returns {string|null} `null` si cabe; si no, el motivo en español.
 */
export function whyNot(session, candidate, day, blockId, ignore = new Set()) {
  const { ctx, assignments } = session;

  if (!ctx.classBlockIds.has(blockId)) return 'Ese bloque no es de clase.';
  if (!ctx.days.includes(day)) return 'Ese día no existe en la rejilla.';
  if (ctx.groupBlocked.get(candidate.group_id)?.has(`${day}|${blockId}`)) {
    return 'El grupo no recibe clase en ese horario.';
  }
  if (ctx.teacherBlocked.get(candidate.teacher_id)?.has(`${day}|${blockId}`)) {
    const name = ctx.teachers.get(candidate.teacher_id)?.name || candidate.teacher_id;
    return `${name} no está disponible en ese horario.`;
  }

  let teacherDay = 0;
  let subjectDay = 0;
  const perDayCap = ctx.maxPerDay.get(`${candidate.group_id}|${candidate.subject_id}`) ?? 99;

  for (let i = 0; i < assignments.length; i += 1) {
    if (ignore.has(i)) continue;
    const a = assignments[i];

    if (a.day === day && a.block_id === blockId) {
      if (a.group_id === candidate.group_id) return 'OCUPADO_GRUPO';
      if (a.teacher_id === candidate.teacher_id) {
        const name = ctx.teachers.get(a.teacher_id)?.name || a.teacher_id;
        const other = ctx.groups.get(a.group_id);
        return `${name} ya da clase a ${other ? other.grade + other.name : a.group_id} en ese horario.`;
      }
    }
    if (a.day === day) {
      if (a.teacher_id === candidate.teacher_id) teacherDay += 1;
      if (a.group_id === candidate.group_id && a.subject_id === candidate.subject_id) subjectDay += 1;
    }
  }

  const dailyCap = ctx.maxDaily.get(candidate.teacher_id) ?? 99;
  if (teacherDay + 1 > dailyCap) {
    const name = ctx.teachers.get(candidate.teacher_id)?.name || candidate.teacher_id;
    return `${name} llegaría a ${teacherDay + 1} h ese día (su tope es ${dailyCap}).`;
  }
  if (subjectDay + 1 > perDayCap) {
    return `Serían ${subjectDay + 1} h de esa materia el mismo día (el tope del plan es ${perDayCap}).`;
  }
  return null;
}

/**
 * Casillas a las que se puede llevar la clase `index`.
 *
 * @returns {Map<string, {day, blockId, kind:'move'|'swap', withIndex:number|null, label:string}>}
 *          indexada por `"día|bloque"`.
 */
export function candidatesFor(session, index) {
  const { ctx, assignments } = session;
  const source = assignments[index];
  const out = new Map();
  if (!source) return out;

  for (const day of ctx.days) {
    for (const block of ctx.classBlocks) {
      if (day === source.day && block.id === source.block_id) continue;

      // ¿Quién ocupa esa casilla EN EL MISMO GRUPO? Es el candidato a permuta.
      const occupantIndex = assignments.findIndex(
        (a, i) => i !== index && a.group_id === source.group_id && a.day === day && a.block_id === block.id,
      );

      if (occupantIndex < 0) {
        if (whyNot(session, source, day, block.id, new Set([index])) === null) {
          out.set(cellKey('c', day, block.id), {
            day, blockId: block.id, kind: 'move', withIndex: null, label: 'Mover aquí',
          });
        }
        continue;
      }

      // Permuta: las dos clases salen del tablero y se comprueban en su destino.
      const occupant = assignments[occupantIndex];
      const ignore = new Set([index, occupantIndex]);
      const a = whyNot(session, source, day, block.id, ignore);
      const b = whyNot(session, occupant, source.day, source.block_id, ignore);
      if (a === null && b === null) {
        out.set(cellKey('c', day, block.id), {
          day, blockId: block.id, kind: 'swap', withIndex: occupantIndex, label: 'Intercambiar',
        });
      }
    }
  }
  return out;
}

/**
 * Aplica el movimiento (o la permuta) y lo apunta en el historial.
 * @returns {{ok:boolean, error?:string, kind?:'move'|'swap'}}
 */
export function applyMove(session, index, day, blockId) {
  const source = session.assignments[index];
  if (!source) return { ok: false, error: 'La clase ya no existe.' };

  const occupantIndex = session.assignments.findIndex(
    (a, i) => i !== index && a.group_id === source.group_id && a.day === day && a.block_id === blockId,
  );
  const ignore = new Set(occupantIndex >= 0 ? [index, occupantIndex] : [index]);

  const problem = whyNot(session, source, day, blockId, ignore);
  if (problem) {
    return { ok: false, error: problem === 'OCUPADO_GRUPO' ? 'Esa casilla ya está ocupada.' : problem };
  }

  let occupantProblem = null;
  if (occupantIndex >= 0) {
    occupantProblem = whyNot(session, session.assignments[occupantIndex], source.day, source.block_id, ignore);
    if (occupantProblem) return { ok: false, error: `No se puede intercambiar: ${occupantProblem}` };
  }

  session.history.push(session.assignments.map((a) => ({ ...a })));
  if (session.history.length > 50) session.history.shift();

  const from = { day: source.day, block_id: source.block_id };
  source.day = day;
  source.block_id = blockId;
  if (occupantIndex >= 0) {
    session.assignments[occupantIndex].day = from.day;
    session.assignments[occupantIndex].block_id = from.block_id;
  }
  session.moves += 1;
  return { ok: true, kind: occupantIndex >= 0 ? 'swap' : 'move' };
}

export function undo(session) {
  const previous = session.history.pop();
  if (!previous) return false;
  session.assignments = previous;
  session.moves = Math.max(0, session.moves - 1);
  return true;
}

export function resetSession(session) {
  session.assignments = session.original.map((a) => ({ ...a }));
  session.history = [];
  session.moves = 0;
}

// --------------------------------------------------------------------------- //
// Reconstrucción de la respuesta
// --------------------------------------------------------------------------- //
/**
 * Regenera `by_group`, `by_teacher` y las métricas dependientes a partir de las
 * asignaciones editadas. Los conflictos y los tutores no cambian: mover una clase
 * no altera ni el diagnóstico del motor ni el emparejamiento de tutores.
 */
export function rebuildResponse(request, response, assignments) {
  const days = request.grid.days;
  const classBlocks = request.grid.blocks.filter((b) => b.kind !== 'break');
  const blockIndex = new Map(classBlocks.map((b, i) => [b.id, i]));

  const byGroup = {};
  const byTeacher = {};
  for (const g of request.groups) byGroup[g.id] = Object.fromEntries(days.map((d) => [d, {}]));
  for (const t of request.teachers) byTeacher[t.id] = Object.fromEntries(days.map((d) => [d, {}]));

  const perTeacherDay = new Map();
  const assigned = new Map(request.teachers.map((t) => [t.id, 0]));

  for (const a of assignments) {
    if (byGroup[a.group_id]?.[a.day]) {
      byGroup[a.group_id][a.day][a.block_id] = { subject_id: a.subject_id, teacher_id: a.teacher_id };
    }
    if (byTeacher[a.teacher_id]?.[a.day]) {
      byTeacher[a.teacher_id][a.day][a.block_id] = { subject_id: a.subject_id, group_id: a.group_id };
    }
    assigned.set(a.teacher_id, (assigned.get(a.teacher_id) || 0) + 1);
    const key = `${a.teacher_id}|${a.day}`;
    if (!perTeacherDay.has(key)) perTeacherDay.set(key, []);
    perTeacherDay.get(key).push(blockIndex.get(a.block_id) ?? 0);
  }

  // Horas muertas: bloques libres entre la primera y la última clase de cada día.
  const gaps = new Map(request.teachers.map((t) => [t.id, 0]));
  for (const [key, blocks] of perTeacherDay) {
    if (blocks.length <= 1) continue;
    const tid = key.slice(0, key.lastIndexOf('|'));
    const span = Math.max(...blocks) - Math.min(...blocks) + 1;
    gaps.set(tid, (gaps.get(tid) || 0) + (span - blocks.length));
  }

  const teacherLoad = {};
  let totalGaps = 0;
  for (const t of request.teachers) {
    const g = gaps.get(t.id) || 0;
    totalGaps += g;
    teacherLoad[t.id] = {
      assigned: assigned.get(t.id) || 0,
      max: t.max_weekly_hours,
      utilization: t.max_weekly_hours
        ? Math.round(((assigned.get(t.id) || 0) / t.max_weekly_hours) * 1000) / 1000 : 0,
      gaps: g,
    };
  }

  return {
    ...response,
    assignments: assignments.map((a) => ({ ...a })),
    by_group: byGroup,
    by_teacher: byTeacher,
    metrics: { ...response.metrics, teacher_gaps: totalGaps, teacher_load: teacherLoad },
  };
}
