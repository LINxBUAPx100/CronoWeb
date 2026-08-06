/**
 * Modelo de captura de la escuela.
 *
 * Es la estructura que edita el director desde los formularios. NO es el contrato
 * del motor: `model/serialize.js` la traduce al JSON de `docs/CONTRACT.md` y de
 * vuelta. Esa separación es a propósito:
 *
 *   · el contrato está optimizado para el solver (rejilla explícita, plan por
 *     grupo, matrices de disponibilidad por bloque);
 *   · este modelo está optimizado para la persona (hora de inicio + duración,
 *     plan de estudios por GRADO —no por grupo—, disponibilidad como casillas).
 *
 * Traducir una vez al generar es mucho más barato que obligar a la escuela a
 * pensar como el algoritmo.
 *
 * @module model/school
 */

export const PALETTE = [
  '#2f4b7c', '#a03225', '#2e6b4f', '#a06a1e', '#37697e', '#6b4a91',
  '#a83a63', '#5b7a2a', '#b5541f', '#4a4e57', '#16736b', '#7a4b2a',
];

export const DAY_PRESETS = {
  'lun-vie': ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'],
  'lun-sab': ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
};

/** Genera ids cortos y estables por familia (S1, T1, G1…). */
export function nextId(prefix, existing) {
  const used = new Set(existing.map((item) => item.id));
  let n = existing.length + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// --------------------------------------------------------------------------- //
// Rejilla horaria: se calcula, no se captura
// --------------------------------------------------------------------------- //
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '07:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 7) * 60 + (Number.isFinite(m) ? m : 0);
};

const toClock = (minutes) => {
  const total = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Construye los bloques a partir de hora de inicio, duración y recesos.
 *
 * La escuela captura tres números; el resto (horas de cada clase, dónde caen los
 * recesos, a qué hora termina la jornada) se deriva. Es la diferencia entre
 * llenar 3 campos y llenar 16 filas a mano.
 *
 * @returns {{blocks:Array, endTime:string}}
 */
export function buildBlocks(time) {
  const classMinutes = Math.max(20, Math.min(180, Number(time.classMinutes) || 60));
  const count = Math.max(1, Math.min(16, Number(time.classesPerDay) || 7));
  const breaks = [...(time.breaks || [])]
    .filter((b) => Number(b.afterClass) >= 1 && Number(b.afterClass) < count)
    .sort((a, b) => a.afterClass - b.afterClass);

  const blocks = [];
  let cursor = toMinutes(time.startTime);
  let breakSeq = 0;

  for (let i = 1; i <= count; i += 1) {
    const start = cursor;
    cursor += classMinutes;
    blocks.push({
      id: `B${i}`,
      label: `${i}a`,
      start: toClock(start),
      end: toClock(cursor),
      kind: 'class',
    });

    for (const pause of breaks.filter((b) => Number(b.afterClass) === i)) {
      const minutes = Math.max(5, Math.min(90, Number(pause.minutes) || 20));
      breakSeq += 1;
      const bStart = cursor;
      cursor += minutes;
      blocks.push({
        id: `R${breakSeq}`,
        label: pause.label || 'Receso',
        start: toClock(bStart),
        end: toClock(cursor),
        kind: 'break',
      });
    }
  }
  return { blocks, endTime: toClock(cursor) };
}

/** Slots asignables por grupo a la semana = clases/día × días. */
export const weeklyCapacity = (model) =>
  (Number(model.time.classesPerDay) || 0) * (model.time.days?.length || 0);

// --------------------------------------------------------------------------- //
// Modelo
// --------------------------------------------------------------------------- //
export function createEmptyModel() {
  return {
    version: 2,
    school: { name: '', cycle: '', logo: null, primaryColor: '#22375c', footerNote: '' },
    time: {
      startTime: '07:00',
      classMinutes: 60,
      classesPerDay: 7,
      days: [...DAY_PRESETS['lun-vie']],
      breaks: [{ afterClass: 3, minutes: 20, label: 'Receso' }],
    },
    subjects: [],
    teachers: [],
    grades: [],
  };
}

export function createSubject(model, name = '') {
  return {
    id: nextId('S', model.subjects),
    name,
    short: '',
    color: PALETTE[model.subjects.length % PALETTE.length],
    prefersMorning: false,
  };
}

export function createTeacher(model, name = '') {
  return {
    id: nextId('T', model.teachers),
    name,
    subjectIds: [],
    maxWeekly: 25,
    maxDaily: null,          // null = sin tope propio (se usa el nº de clases/día)
    canBeTutor: true,
    /**
     * Horas NO disponibles, como claves `"<índice de día>|<id de bloque>"`.
     * Se guarda lo bloqueado (no lo libre) porque el caso normal es "puedo casi
     * siempre, salvo estas horas": así el default de un profesor nuevo es correcto.
     */
    blocked: [],
    /**
     * Preferencia manual como tutor. Todavía no hay campo en la interfaz, pero se
     * conserva al abrir un respaldo: perder datos en silencio al reabrir un archivo
     * es peor que no poder editarlos.
     */
    tutorPriority: 0,
    notes: '',
  };
}

export function createGrade(model, name = '') {
  return {
    id: nextId('G', model.grades),
    name,
    shift: 'matutino',
    // `blockedSlots` guarda horas en que ese grupo no recibe clase (llegada tarde,
    // taller externo). Se conserva de los respaldos aunque aún no se edite aquí.
    groups: [{ name: 'A', blockedSlots: [] }],
    // Plan de estudios por GRADO: todos sus grupos comparten materias y horas.
    plan: model.subjects.map((subject) => ({
      subjectId: subject.id,
      hours: 0,
      maxPerDay: 2,
      assignToTutor: false,
    })),
  };
}

/** Mantiene el plan de cada grado sincronizado con el catálogo de materias. */
export function syncPlans(model) {
  for (const grade of model.grades) {
    const known = new Set(grade.plan.map((entry) => entry.subjectId));
    for (const subject of model.subjects) {
      if (!known.has(subject.id)) {
        grade.plan.push({ subjectId: subject.id, hours: 0, maxPerDay: 2, assignToTutor: false });
      }
    }
    const alive = new Set(model.subjects.map((s) => s.id));
    grade.plan = grade.plan.filter((entry) => alive.has(entry.subjectId));
  }
}

/** Al borrar una materia hay que limpiar todas sus referencias. */
export function removeSubject(model, subjectId) {
  model.subjects = model.subjects.filter((s) => s.id !== subjectId);
  for (const teacher of model.teachers) {
    teacher.subjectIds = teacher.subjectIds.filter((id) => id !== subjectId);
  }
  syncPlans(model);
}

export function removeTeacher(model, teacherId) {
  model.teachers = model.teachers.filter((t) => t.id !== teacherId);
}

export const groupIdOf = (grade, group) => `${grade.name}${group.name}`.replace(/\s+/g, '');

/** Todos los grupos del plantel, aplanados, con su grado. */
export function allGroups(model) {
  const out = [];
  for (const grade of model.grades) {
    for (const group of grade.groups) {
      out.push({ id: groupIdOf(grade, group), grade, group, label: `${grade.name}${group.name}` });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Revisión previa (antes de llamar al motor)
// --------------------------------------------------------------------------- //
/**
 * Problemas que el director puede arreglar SIN entender el algoritmo.
 * El validador del motor hace el análisis fino; esto atrapa los olvidos.
 *
 * @returns {{level:'error'|'warning', message:string, screen:string}[]}
 */
export function reviewModel(model) {
  const issues = [];
  const capacity = weeklyCapacity(model);

  if (!model.time.days?.length) {
    issues.push({ level: 'error', message: 'No hay días de clase seleccionados.', screen: 'horario' });
  }
  if (!model.subjects.length) {
    issues.push({ level: 'error', message: 'Todavía no hay materias capturadas.', screen: 'materias' });
  }
  if (!model.teachers.length) {
    issues.push({ level: 'error', message: 'Todavía no hay profesores capturados.', screen: 'profesores' });
  }
  if (!model.grades.length) {
    issues.push({ level: 'error', message: 'Todavía no hay grados ni grupos capturados.', screen: 'grupos' });
  }

  for (const subject of model.subjects) {
    if (!subject.name.trim()) {
      issues.push({ level: 'error', message: 'Hay una materia sin nombre.', screen: 'materias' });
    }
  }

  for (const teacher of model.teachers) {
    if (!teacher.name.trim()) {
      issues.push({ level: 'error', message: 'Hay un profesor sin nombre.', screen: 'profesores' });
    } else if (!teacher.subjectIds.length) {
      issues.push({
        level: 'warning',
        message: `${teacher.name} no tiene materias asignadas: no se le podrá dar ninguna clase.`,
        screen: 'profesores',
      });
    }
  }

  for (const grade of model.grades) {
    if (!grade.groups.length) {
      issues.push({
        level: 'error',
        message: `El grado ${grade.name || '(sin nombre)'} no tiene grupos.`,
        screen: 'grupos',
      });
    }
    const hours = grade.plan.reduce((acc, entry) => acc + (Number(entry.hours) || 0), 0);
    if (hours === 0) {
      issues.push({
        level: 'error',
        message: `El grado ${grade.name || '(sin nombre)'} no tiene horas en su plan de estudios.`,
        screen: 'grupos',
      });
    } else if (hours > capacity) {
      issues.push({
        level: 'error',
        message: `El grado ${grade.name} pide ${hours} h y sólo caben ${capacity} en la semana.`,
        screen: 'grupos',
      });
    }

    // Una materia con horas pero sin nadie que la imparta es el error nº 1 en la
    // captura real: se detecta aquí y se nombra en cristiano.
    for (const entry of grade.plan) {
      if (!entry.hours || entry.assignToTutor) continue;
      const canTeach = model.teachers.some((t) => t.subjectIds.includes(entry.subjectId));
      if (!canTeach) {
        const subject = model.subjects.find((s) => s.id === entry.subjectId);
        issues.push({
          level: 'error',
          message: `Nadie imparte ${subject?.name || entry.subjectId} y el grado ${grade.name} la lleva ${entry.hours} h.`,
          screen: 'profesores',
        });
      }
    }
  }

  const ids = allGroups(model).map((g) => g.id);
  if (new Set(ids).size !== ids.length) {
    issues.push({
      level: 'error',
      message: 'Hay dos grupos con el mismo nombre (por ejemplo dos "1A"). Cámbiale la letra a uno.',
      screen: 'grupos',
    });
  }

  // Deduplica mensajes idénticos (p. ej. varias materias sin nombre).
  const seen = new Set();
  return issues.filter((issue) => {
    if (seen.has(issue.message)) return false;
    seen.add(issue.message);
    return true;
  });
}
