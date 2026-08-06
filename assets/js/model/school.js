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

export const levelOf = (grade) => LEVELS.find((l) => l.id === grade?.level) || LEVELS[1];

// --------------------------------------------------------------------------- //
// Periodos: sólo existen en preparatoria
// --------------------------------------------------------------------------- //
/**
 * Sistemas de periodos del bachillerato.
 *
 * En kínder, primaria y secundaria un grado es un año y punto: «2° B» significa
 * lo mismo en septiembre que en mayo. En preparatoria no: el grupo ES su
 * periodo —«3er semestre A»—, y cada periodo lleva materias distintas. Por eso
 * el selector aparece SÓLO cuando el grado es de preparatoria, y por eso vive
 * en el grado y no en la escuela: un mismo plantel puede tener el bachillerato
 * semestral por la mañana y el cuatrimestral por la tarde.
 *
 * Los tres sistemas no anuales cubren los mismos seis periodos del bachillerato
 * (los tres años completos); lo que cambia es cómo los nombra la escuela.
 */
export const TERM_SYSTEMS = [
  { id: 'semestral', label: 'Semestres', unit: 'semestre', count: 6 },
  { id: 'cuatrimestral', label: 'Cuatrimestres', unit: 'cuatrimestre', count: 6 },
  { id: 'trimestral', label: 'Trimestres', unit: 'trimestre', count: 6 },
  { id: 'anual', label: 'Anual', unit: 'año', count: 3 },
];

export const DEFAULT_TERM_SYSTEM = 'semestral';

/** ¿Este grado se captura por periodos? Sólo la preparatoria. */
export const isPrepa = (grade) => levelOf(grade).id === 'preparatoria';

export const termSystemOf = (grade) =>
  TERM_SYSTEMS.find((t) => t.id === grade?.termSystem)
  || TERM_SYSTEMS.find((t) => t.id === DEFAULT_TERM_SYSTEM);

export const termCountOf = (grade) => termSystemOf(grade).count;

/** Periodo del grado, siempre dentro del rango del sistema elegido. */
export const termOf = (grade) =>
  Math.min(Math.max(1, Number(grade?.term) || 1), termCountOf(grade));

const ordinal = (n) => (n === 1 ? '1er' : n === 3 ? '3er' : `${n}°`);

/** «1er semestre», «3er cuatrimestre», «2° año». */
export function termLabel(grade, n = termOf(grade)) {
  return `${ordinal(n)} ${termSystemOf(grade).unit}`;
}

/**
 * Cómo se nombra el grado en pantalla y en el horario impreso: «3er semestre»
 * en prepa, «2°» en los demás niveles.
 */
export const gradeLabel = (grade) =>
  (isPrepa(grade) ? termLabel(grade) : `${grade?.name ?? ''}°`);

/** Igual, pero para meterlo en una frase: «el 3er semestre», «el grado 2». */
export const gradeTitle = (grade) =>
  (isPrepa(grade) ? termLabel(grade) : `grado ${grade?.name || '(sin nombre)'}`);

/**
 * Fija el periodo de un grado de prepa.
 *
 * `grade.name` se mantiene igual al número de periodo porque de ahí salen los
 * ids de grupo («3A») y la columna `grade` del contrato: si se separaran, el
 * 3er semestre y el 4° acabarían compartiendo id.
 */
export function setTerm(grade, n) {
  grade.term = Math.min(Math.max(1, Number(n) || 1), termCountOf(grade));
  grade.name = String(grade.term);
  return grade;
}

/** Al marcar «Preparatoria» el grado estrena periodo; conserva el número si cabe. */
export function ensureTerm(grade, systemId = DEFAULT_TERM_SYSTEM) {
  grade.termSystem = TERM_SYSTEMS.some((t) => t.id === grade.termSystem)
    ? grade.termSystem
    : systemId;
  return setTerm(grade, grade.term || Number(grade.name) || 1);
}

/** Plan de estudios del grado. Uno por grado: en prepa el grado ya ES el periodo. */
export function planOf(model, grade) {
  grade.plan ||= model.subjects.map((subject) => ({
    subjectId: subject.id,
    hours: 0,
    maxPerDay: 2,
    assignToTutor: false,
  }));
  return grade.plan;
}

/**
 * Migra respaldos anteriores.
 *
 * Hubo una versión en que los periodos eran del plantel entero y el plan se
 * guardaba por periodo (`grade.plans = {1:[…], 2:[…]}`) con una pestaña global
 * para cambiar de semestre. Nunca terminó de funcionar: obligaba a ver el
 * horario de un solo periodo a la vez y no servía para lo que las prepas
 * realmente hacen, que es tener 1° y 3er semestre al mismo tiempo. Ahora cada
 * grado es un periodo, así que del respaldo viejo se conserva el plan del
 * periodo que estaba activo.
 */
export function migrateModel(model) {
  const legacy = model.terms || null;
  const legacySystem = LEGACY_SYSTEMS[legacy?.system] || DEFAULT_TERM_SYSTEM;
  const legacyCurrent = Math.max(1, Number(legacy?.current) || 1);

  for (const grade of model.grades || []) {
    if (!Array.isArray(grade.plan) && grade.plans) {
      grade.plan = grade.plans[legacyCurrent] || grade.plans[1] || Object.values(grade.plans)[0] || [];
    }
    delete grade.plans;
    grade.plan ||= [];
    if (isPrepa(grade)) ensureTerm(grade, legacySystem);
  }
  delete model.terms;
  return model;
}

/** Los bimestres del modelo viejo no eran periodos de plan de estudios. */
const LEGACY_SYSTEMS = {
  anual: 'anual',
  semestral: 'semestral',
  cuatrimestral: 'cuatrimestral',
  trimestral: 'trimestral',
  bimestral: 'semestral',
};

/** ¿La escuela mezcla niveles? Decide si los ids de grupo necesitan prefijo. */
export const hasMixedLevels = (model) =>
  new Set(model.grades.map((g) => levelOf(g).id)).size > 1;

export function createGrade(model, name = '') {
  // Se hereda el nivel del último grado capturado: quien está dando de alta
  // seis grados de primaria no quiere elegir «primaria» seis veces.
  const previo = model.grades[model.grades.length - 1];
  const grade = {
    id: nextId('G', model.grades),
    name,
    level: previo ? levelOf(previo).id : 'secundaria',
    shift: previo?.shift || 'matutino',
    // `blockedSlots` guarda horas en que ese grupo no recibe clase (llegada tarde,
    // taller externo). Se conserva de los respaldos aunque aún no se edite aquí.
    groups: [{ name: 'A', blockedSlots: [] }],
    // Plan de estudios por GRADO: todos los grupos del grado comparten materias
    // y horas. En prepa el grado es un periodo, así que el plan es el de ese
    // semestre/cuatrimestre.
    plan: model.subjects.map((subject) => ({
      subjectId: subject.id,
      hours: 0,
      maxPerDay: 2,
      assignToTutor: false,
    })),
  };
  // En prepa el nuevo grado toma el primer periodo libre del mismo sistema: dar
  // de alta los seis semestres es «+ Agregar grado» seis veces, sin corregir.
  if (isPrepa(grade)) {
    grade.termSystem = previo?.termSystem || DEFAULT_TERM_SYSTEM;
    setTerm(grade, nextFreeTerm(model, grade));
  }
  return grade;
}

/** Primer periodo del sistema que ningún otro grado de prepa esté usando. */
export function nextFreeTerm(model, grade) {
  const usados = new Set(model.grades
    .filter((g) => g !== grade && isPrepa(g) && g.termSystem === grade.termSystem)
    .map((g) => termOf(g)));
  for (let n = 1; n <= termCountOf(grade); n += 1) {
    if (!usados.has(n)) return n;
  }
  return termOf(grade);
}

/** Mantiene el plan de cada grado sincronizado con el catálogo de materias. */
export function syncPlans(model) {
  migrateModel(model);
  const alive = new Set(model.subjects.map((s) => s.id));
  for (const grade of model.grades) {
    const plan = planOf(model, grade);
    const known = new Set(plan.map((entry) => entry.subjectId));
    for (const subject of model.subjects) {
      if (!known.has(subject.id)) {
        plan.push({ subjectId: subject.id, hours: 0, maxPerDay: 2, assignToTutor: false });
      }
    }
    grade.plan = plan.filter((entry) => alive.has(entry.subjectId));
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

/** Etiqueta humana: «1° A de primaria», «3er semestre A». */
export const groupFullLabel = (grade, group) =>
  (isPrepa(grade)
    ? `${termLabel(grade)} ${group.name}`
    : `${grade.name}° ${group.name} de ${levelOf(grade).label.toLowerCase()}`);

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
        // Viaja al contrato para que la hoja impresa diga «3er semestre A» y no
        // «3° A»: el motor no lo usa, pero es lo que la prepa espera leer.
        termLabel: isPrepa(grade) ? termLabel(grade) : null,
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
    const título = gradeTitle(grade);
    if (!grade.groups.length) {
      issues.push({ level: 'error', message: `El ${título} no tiene grupos.`, screen: 'grupos' });
    }
    const hours = planOf(model, grade).reduce((acc, entry) => acc + (Number(entry.hours) || 0), 0);
    if (hours === 0) {
      issues.push({
        level: 'error',
        message: `El ${título} no tiene horas en su plan de estudios.`,
        screen: 'grupos',
      });
    } else if (hours > capacity) {
      issues.push({
        level: 'error',
        message: `El ${título} pide ${hours} h y sólo caben ${capacity} en la semana.`,
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
          message: `Nadie imparte ${subject?.name || entry.subjectId} y el ${título} la lleva ${entry.hours} h.`,
          screen: 'profesores',
        });
      }
    }
  }

  const ids = allGroups(model).map((g) => g.id);
  if (new Set(ids).size !== ids.length) {
    issues.push({
      level: 'error',
      message: 'Hay dos grupos con el mismo nombre y nivel (dos "1A" de secundaria, o dos grados ' +
        'de prepa en el mismo semestre con el grupo A). Cámbiale la letra o el periodo a uno.',
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
