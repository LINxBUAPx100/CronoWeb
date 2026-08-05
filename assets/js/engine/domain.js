/**
 * Compilación del problema (puerto JS de `backend/app/solver/domain.py`).
 *
 * Traduce la petición normalizada a estructuras indexadas por entero. En el
 * navegador esto importa todavía más que en Python: el hot loop del backtracking
 * corre en un Web Worker sin JIT warm-up garantizado, así que se evita cualquier
 * búsqueda por string dentro de la búsqueda.
 *
 * @module engine/domain
 */

/**
 * @typedef {{index:number, day:string, dayIndex:number, blockId:string,
 *            blockIndex:number, label:string}} Slot
 * @typedef {{uid:string, groupId:string, subjectId:string, occurrence:number,
 *            eligible:string[], maxPerDay:number, preferredTeacher:?string,
 *            assignToTutor:boolean, difficulty:number}} Lesson
 */

/**
 * Traduce la matriz de disponibilidad a un Set de índices de slot permitidos.
 * Reglas en `docs/CONTRACT.md` §1.
 * @returns {Set<number>}
 */
function teacherAvailableSlots(teacher, slots) {
  const matrix = teacher.availability;
  if (!matrix || Object.keys(matrix).length === 0) {
    return new Set(slots.map((s) => s.index));
  }
  if (teacher.availability_mode === 'whitelist') {
    const allowed = new Set();
    for (const slot of slots) {
      const list = matrix[slot.day];
      if (Array.isArray(list) && list.includes(slot.blockId)) allowed.add(slot.index);
    }
    return allowed;
  }
  // blacklist
  const blocked = new Set();
  for (const [day, list] of Object.entries(matrix)) {
    for (const blockId of list || []) blocked.add(`${day}|${blockId}`);
  }
  return new Set(slots.filter((s) => !blocked.has(`${s.day}|${s.blockId}`)).map((s) => s.index));
}

/**
 * @param {object} request petición ya normalizada
 * @returns {object} contexto compilado
 */
export function compileProblem(request) {
  const classBlocks = request.grid.blocks.filter((b) => b.kind === 'class');

  /** @type {Slot[]} */
  const slots = [];
  const slotsByDay = request.grid.days.map(() => []);
  let index = 0;
  request.grid.days.forEach((day, dayIndex) => {
    classBlocks.forEach((block, blockIndex) => {
      slots.push({ index, day, dayIndex, blockId: block.id, blockIndex, label: `${day} ${block.label}` });
      slotsByDay[dayIndex].push(index);
      index += 1;
    });
  });

  const subjects = new Map(request.subjects.map((s) => [s.id, s]));
  const teachers = new Map(request.teachers.map((t) => [t.id, t]));
  const groups = new Map(request.groups.map((g) => [g.id, g]));
  const teacherOrder = request.teachers.map((t) => t.id);
  const groupOrder = request.groups.map((g) => g.id);

  const teacherSlots = new Map(request.teachers.map((t) => [t.id, teacherAvailableSlots(t, slots)]));
  const teacherMaxWeekly = new Map(request.teachers.map((t) => [t.id, t.max_weekly_hours]));
  const teacherMaxDaily = new Map(
    request.teachers.map((t) => [t.id, t.max_daily_hours ?? classBlocks.length]),
  );

  const slotLookup = new Map(slots.map((s) => [`${s.day}|${s.blockId}`, s.index]));
  const groupSlots = new Map();
  for (const group of request.groups) {
    const set = new Set(slots.map((s) => s.index));
    for (const blocked of group.blocked_slots) {
      const idx = slotLookup.get(`${blocked.day}|${blocked.block_id}`);
      if (idx !== undefined) set.delete(idx);
    }
    groupSlots.set(group.id, set);
  }

  // Elegibilidad (grupo|materia) -> profesores.
  const eligible = new Map();
  for (const group of request.groups) {
    for (const entry of group.curriculum) {
      const key = `${group.id}|${entry.subject_id}`;
      if (entry.assign_to_tutor) {
        eligible.set(key, []); // se resuelve tras asignar tutores
      } else if (entry.fixed_teacher_id) {
        eligible.set(key, [entry.fixed_teacher_id]);
      } else {
        eligible.set(
          key,
          request.teachers.filter((t) => t.subject_ids.includes(entry.subject_id)).map((t) => t.id),
        );
      }
    }
  }

  const ctx = {
    request,
    slots,
    slotsByDay,
    dayOfSlot: slots.map((s) => s.dayIndex),
    blockOfSlot: slots.map((s) => s.blockIndex),
    nBlocksPerDay: classBlocks.length,
    nDays: request.grid.days.length,
    subjects,
    teachers,
    groups,
    teacherOrder,
    groupOrder,
    teacherSlots,
    groupSlots,
    teacherMaxWeekly,
    teacherMaxDaily,
    eligible,
    /** @type {Lesson[]} */
    lessons: [],
    requiredHours: 0,
  };

  buildLessons(ctx);
  return ctx;
}

/** Explota el plan de estudios en variables de una hora. */
function buildLessons(ctx) {
  /** @type {Lesson[]} */
  const lessons = [];
  for (const gid of ctx.groupOrder) {
    for (const entry of ctx.groups.get(gid).curriculum) {
      const elig = ctx.eligible.get(`${gid}|${entry.subject_id}`) || [];
      for (let k = 0; k < entry.weekly_hours; k += 1) {
        lessons.push({
          uid: `${gid}|${entry.subject_id}|${k}`,
          groupId: gid,
          subjectId: entry.subject_id,
          occurrence: k,
          eligible: elig,
          maxPerDay: entry.max_per_day,
          preferredTeacher: entry.preferred_teacher_id,
          assignToTutor: entry.assign_to_tutor,
          difficulty: 0,
        });
      }
    }
  }
  ctx.lessons = lessons;
  ctx.requiredHours = lessons.length;
  scoreDifficulty(ctx);
}

/** Dificultad ≈ tamaño del dominio inicial (cota superior barata). */
export function scoreDifficulty(ctx) {
  for (const lesson of ctx.lessons) {
    const gSlots = ctx.groupSlots.get(lesson.groupId);
    let total = 0;
    for (const tid of lesson.eligible) {
      const tSlots = ctx.teacherSlots.get(tid);
      if (!tSlots) continue;
      for (const slot of gSlots) if (tSlots.has(slot)) total += 1;
    }
    lesson.difficulty = lesson.eligible.length ? total : 0.5;
  }
}

/**
 * Segunda pasada: las materias `assign_to_tutor` sólo puede impartirlas el tutor.
 * Por eso los tutores se resuelven ANTES del horario.
 * @param {object} ctx
 * @param {Map<string,?string>} tutorByGroup
 */
export function bindTutorLessons(ctx, tutorByGroup) {
  for (const lesson of ctx.lessons) {
    if (!lesson.assignToTutor) continue;
    const tutor = tutorByGroup.get(lesson.groupId);
    lesson.eligible = tutor ? [tutor] : [];
    ctx.eligible.set(`${lesson.groupId}|${lesson.subjectId}`, lesson.eligible);
  }
  scoreDifficulty(ctx);
}

/** Intersección de dos Sets como array ordenado (uso en precálculo, no en el hot loop). */
export function intersectSorted(a, b) {
  const out = [];
  for (const v of a) if (b.has(v)) out.push(v);
  out.sort((x, y) => x - y);
  return out;
}
