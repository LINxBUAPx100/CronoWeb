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
  '#14417c', '#a72b2b', '#1f6b4f', '#9a6410', '#2a6f8f', '#6a3fa0',
  '#a13066', '#4f6d1f', '#b0531c', '#414a57', '#0f6a72', '#7a4a2c',
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
    school: { name: '', cycle: '', logo: null, primaryColor: '#14417c', footerNote: '' },
    time: {
      startTime: '07:00',
      classMinutes: 60,
      classesPerDay: 7,
      days: [...DAY_PRESETS['lun-vie']],
      breaks: [{ afterClass: 3, minutes: 20, label: 'Receso' }],
    },
    // Sistema de periodos del plantel. «anual» = un solo horario para todo el
    // ciclo; los demás guardan un plan de estudios por periodo.
    terms: { system: 'anual', current: 1 },
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

/**
 * Niveles educativos. Una misma escuela puede tener los tres (colegios
 * particulares con primaria, secundaria y prepa en el mismo predio), y entonces
 * «1° A» existe tres veces: por eso el nivel es parte de la identidad del grupo,
 * no una etiqueta decorativa.
 */
export const LEVELS = [
  { id: 'kinder', label: 'Kínder', short: 'Kínder', prefix: 'K', grades: 3 },
  { id: 'primaria', label: 'Primaria', short: 'Prim.', prefix: 'P', grades: 6 },
  { id: 'secundaria', label: 'Secundaria', short: 'Sec.', prefix: 'S', grades: 3 },
  { id: 'preparatoria', label: 'Preparatoria', short: 'Prepa', prefix: 'B', grades: 3 },
];

/**
 * Sistemas de periodos.
 *
 * Una primaria trabaja todo el año con el mismo horario; una prepa cambia de
 * materias cada semestre y una universidad cada cuatrimestre. Por eso el plan de
 * estudios se guarda POR PERIODO (`grade.plans`) y no una sola vez: en el 1er
 * semestre pueden llevar Química y en el 2° Física, y ambos horarios tienen que
 * poder existir y exportarse por separado.
 */
export const TERM_SYSTEMS = [
  { id: 'anual', label: 'Anual', unit: 'Ciclo', count: 1 },
  { id: 'semestral', label: 'Semestres', unit: 'semestre', count: 2 },
  { id: 'cuatrimestral', label: 'Cuatrimestres', unit: 'cuatrimestre', count: 3 },
  { id: 'bimestral', label: 'Bimestres', unit: 'bimestre', count: 5 },
];

export const termSystemOf = (model) =>
  TERM_SYSTEMS.find((t) => t.id === model?.terms?.system) || TERM_SYSTEMS[0];

export const termCount = (model) => termSystemOf(model).count;

/** Periodo activo, siempre dentro del rango del sistema elegido. */
export const currentTerm = (model) =>
  Math.min(Math.max(1, Number(model?.terms?.current) || 1), termCount(model));

/** «1er semestre», «3er cuatrimestre», «4° bimestre», «Ciclo completo». */
export function termLabel(model, n = currentTerm(model)) {
  const system = termSystemOf(model);
  if (system.count === 1) return 'Ciclo completo';
  const ordinal = n === 1 ? '1er' : n === 3 ? '3er' : `${n}°`;
  return `${ordinal} ${system.unit}`;
}

/**
 * Plan de estudios del grado para el periodo activo.
 *
 * Si el periodo todavía no tiene plan se copia el del periodo anterior (o el
 * primero): al pasar de semestre casi nada cambia, y empezar de una tabla vacía
 * obligaría a recapturar once materias para cambiar dos.
 */
export function planOf(model, grade, term = currentTerm(model)) {
  grade.plans ||= {};
  if (!grade.plans[term]) {
    const previo = grade.plans[term - 1] || grade.plans[1] || Object.values(grade.plans)[0] || [];
    grade.plans[term] = previo.map((entry) => ({ ...entry }));
  }
  return grade.plans[term];
}

/** Migra modelos guardados antes de que existieran los periodos. */
export function migrateModel(model) {
  model.terms ||= { system: 'anual', current: 1 };
  for (const grade of model.grades || []) {
    if (Array.isArray(grade.plan) && !grade.plans) {
      grade.plans = { 1: grade.plan };
      delete grade.plan;
    }
    grade.plans ||= { 1: [] };
  }
  return model;
}

export const levelOf = (grade) => LEVELS.find((l) => l.id === grade?.level) || LEVELS[1];

/** ¿La escuela mezcla niveles? Decide si los ids de grupo necesitan prefijo. */
export const hasMixedLevels = (model) =>
  new Set(model.grades.map((g) => levelOf(g).id)).size > 1;

export function createGrade(model, name = '') {
  return {
    id: nextId('G', model.grades),
    name,
    // Se hereda el nivel del último grado capturado: quien está dando de alta
    // seis grados de primaria no quiere elegir «primaria» seis veces.
    level: model.grades.length ? levelOf(model.grades[model.grades.length - 1]).id : 'secundaria',
    shift: 'matutino',
    // `blockedSlots` guarda horas en que ese grupo no recibe clase (llegada tarde,
    // taller externo). Se conserva de los respaldos aunque aún no se edite aquí.
    groups: [{ name: 'A', blockedSlots: [] }],
    // Plan de estudios por GRADO y por PERIODO: todos los grupos del grado
    // comparten materias y horas dentro del mismo periodo.
    plans: {
      1: model.subjects.map((subject) => ({
        subjectId: subject.id,
        hours: 0,
        maxPerDay: 2,
        assignToTutor: false,
      })),
    },
  };
}

/** Mantiene el plan de cada grado sincronizado con el catálogo de materias. */
export function syncPlans(model) {
  migrateModel(model);
  const alive = new Set(model.subjects.map((s) => s.id));
  for (const grade of model.grades) {
    // Todos los periodos, no sólo el activo: si se agrega una materia estando en
    // el 2° semestre, el 1° no puede quedarse con una tabla desincronizada.
    for (const [term, plan] of Object.entries(grade.plans)) {
      const known = new Set(plan.map((entry) => entry.subjectId));
      for (const subject of model.subjects) {
        if (!known.has(subject.id)) {
          plan.push({ subjectId: subject.id, hours: 0, maxPerDay: 2, assignToTutor: false });
        }
      }
      grade.plans[term] = plan.filter((entry) => alive.has(entry.subjectId));
    }
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

/**
 * Id de grupo.
 *
 * Sin prefijo mientras la escuela tenga un solo nivel —«1A» es lo que la escuela
 * escribe y lo que espera ver en los respaldos—. En cuanto convive más de un
 * nivel se antepone su letra (P/S/B), porque si no el «1A» de primaria y el de
 * secundaria serían el mismo grupo para el motor y el horario saldría revuelto.
 */
export const groupIdOf = (grade, group, prefix = '') =>
  `${prefix}${grade.name}${group.name}`.replace(/\s+/g, '');

/** Etiqueta humana: «1° A de primaria». */
export const groupFullLabel = (grade, group) =>
  `${grade.name}° ${group.name} de ${levelOf(grade).label.toLowerCase()}`;

/** Todos los grupos del plantel, aplanados, con su grado y nivel. */
export function allGroups(model) {
  const mixed = hasMixedLevels(model);
  const out = [];
  for (const grade of model.grades) {
    const level = levelOf(grade);
    for (const group of grade.groups) {
      out.push({
        id: groupIdOf(grade, group, mixed ? level.prefix : ''),
        grade,
        group,
        level,
        label: `${grade.name}${group.name}`,
        fullLabel: groupFullLabel(grade, group),
      });
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
    const hours = planOf(model, grade).reduce((acc, entry) => acc + (Number(entry.hours) || 0), 0);
    if (hours === 0) {
      issues.push({
        level: 'error',
        message: `El grado ${grade.name || '(sin nombre)'} no tiene horas en su plan de estudios`
          + `${termCount(model) > 1 ? ` del ${termLabel(model)}` : ''}.`,
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
    for (const entry of planOf(model, grade)) {
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
      message: 'Hay dos grupos con el mismo nombre y nivel (por ejemplo dos "1A" de secundaria). ' +
        'Cámbiale la letra a uno.',
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
