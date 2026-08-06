/**
 * Verificación del modelo de captura: periodos de preparatoria y respaldos.
 *
 * El motor tiene su propia batería (`verify-engine.mjs`); ésta cubre la capa de
 * arriba, que es donde vive la regla que más fácil se rompe sin darse cuenta:
 * en prepa el grado ES un periodo («3er semestre») y en los demás niveles no
 * existe tal cosa. Si eso se desajusta, dos semestres pueden acabar con el
 * mismo id de grupo y el horario sale revuelto sin que nada falle.
 *
 *   node tools/verify-model.mjs
 */

import {
  allGroups, createEmptyModel, createGrade, createSubject, ensureTerm, gradeLabel,
  isPrepa, migrateModel, planOf, reviewModel, setTerm, syncPlans, termLabel,
} from '../assets/js/model/school.js';
import { modelToScenario, scenarioToModel } from '../assets/js/model/serialize.js';
import { normalizeRequest } from '../assets/js/engine/contract.js';

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

/** Prepa con seis periodos, un grupo cada uno y tres materias de 5 h. */
function prepaDeSeisPeriodos(system = 'semestral') {
  const model = createEmptyModel();
  for (const nombre of ['Español', 'Matemáticas', 'Química']) {
    model.subjects.push(createSubject(model, nombre));
  }
  model.teachers.push({
    id: 'T1', name: 'Ana', subjectIds: model.subjects.map((s) => s.id),
    maxWeekly: 40, maxDaily: null, canBeTutor: true, blocked: [], tutorPriority: 0, notes: '',
  });

  const primero = createGrade(model, '1');
  primero.level = 'preparatoria';
  ensureTerm(primero, system);
  model.grades.push(primero);
  // Los cinco restantes heredan nivel y modalidad, y toman el periodo libre.
  for (let i = 0; i < 5; i += 1) model.grades.push(createGrade(model));

  syncPlans(model);
  for (const grade of model.grades) {
    for (const entry of planOf(model, grade)) entry.hours = 5;
  }
  return model;
}

// --------------------------------------------------------------------------- //
// Periodos
// --------------------------------------------------------------------------- //
test('los grados de prepa se numeran solos del 1° al 6° periodo', () => {
  const model = prepaDeSeisPeriodos();
  assert(model.grades.length === 6, 'no quedaron seis grados');
  assert(model.grades.every(isPrepa), 'algún grado no heredó preparatoria');
  assert(model.grades.map((g) => g.term).join() === '1,2,3,4,5,6',
    `periodos ${model.grades.map((g) => g.term)}`);
});

test('el número de grado sigue al periodo, para que los ids no choquen', () => {
  const model = prepaDeSeisPeriodos();
  assert(model.grades.map((g) => g.name).join() === '1,2,3,4,5,6', 'grade.name se desincronizó');
  const ids = allGroups(model).map((g) => g.id);
  assert(new Set(ids).size === ids.length, `ids repetidos: ${ids}`);
});

test('semestres, cuatrimestres y trimestres valen los mismos seis periodos', () => {
  for (const [system, esperado] of [
    ['semestral', '3er semestre'],
    ['cuatrimestral', '3er cuatrimestre'],
    ['trimestral', '3er trimestre'],
  ]) {
    const model = prepaDeSeisPeriodos(system);
    assert(model.grades.length === 6, `${system}: no llegó a seis periodos`);
    assert(gradeLabel(model.grades[2]) === esperado,
      `${system}: dijo «${gradeLabel(model.grades[2])}» en vez de «${esperado}»`);
    assert(gradeLabel(model.grades[5]) === esperado.replace('3er', '6°').replace('3° ', '6° '),
      `${system}: el sexto periodo dijo «${gradeLabel(model.grades[5])}»`);
  }
});

test('la modalidad anual sólo tiene tres periodos y recorta los de más', () => {
  const model = prepaDeSeisPeriodos();
  const grade = model.grades[5];
  grade.termSystem = 'anual';
  setTerm(grade, grade.term);
  assert(grade.term === 3, `quedó en el periodo ${grade.term}`);
  assert(gradeLabel(grade) === '3er año', `dijo «${gradeLabel(grade)}»`);
});

test('los demás niveles no tienen periodo y se siguen leyendo «1°»', () => {
  const model = prepaDeSeisPeriodos();
  const grade = model.grades[0];
  grade.level = 'primaria';
  assert(!isPrepa(grade), 'siguió contando como prepa');
  assert(gradeLabel(grade) === '1°', `dijo «${gradeLabel(grade)}»`);
  assert(allGroups(model)[0].termLabel === null, 'le colgó una etiqueta de periodo');
});

test('el grupo se anuncia con su periodo: «3er semestre A»', () => {
  const model = prepaDeSeisPeriodos();
  assert(allGroups(model)[2].fullLabel === '3er semestre A',
    `dijo «${allGroups(model)[2].fullLabel}»`);
});

test('una prepa completa pasa la revisión previa sin errores', () => {
  const model = prepaDeSeisPeriodos();
  const errores = reviewModel(model).filter((i) => i.level === 'error');
  assert(errores.length === 0, errores.map((e) => e.message).join(' / '));
});

// --------------------------------------------------------------------------- //
// Contrato: ida y vuelta
// --------------------------------------------------------------------------- //
test('el periodo viaja al contrato y sobrevive a la validación', () => {
  const scenario = modelToScenario(prepaDeSeisPeriodos());
  assert(scenario.groups[2].term_label === '3er semestre', `mandó «${scenario.groups[2].term_label}»`);
  assert(normalizeRequest(scenario).groups[2].term_label === '3er semestre',
    'normalizeRequest se comió term_label');
});

test('abrir un respaldo devuelve los periodos y su modalidad', () => {
  for (const system of ['semestral', 'cuatrimestral', 'trimestral']) {
    const { model } = scenarioToModel(modelToScenario(prepaDeSeisPeriodos(system)));
    assert(model.grades.length === 6, `${system}: volvieron ${model.grades.length} grados`);
    assert(model.grades.every(isPrepa), `${system}: no volvieron como preparatoria`);
    assert(model.grades.map((g) => g.term).join() === '1,2,3,4,5,6',
      `${system}: volvieron los periodos ${model.grades.map((g) => g.term)}`);
    // «cuatrimestre» contiene «trimestre»: si se lee mal, la escuela abre su
    // respaldo y descubre que le cambiaron la modalidad.
    assert(model.grades.every((g) => g.termSystem === system),
      `${system}: volvió como ${model.grades[0].termSystem}`);
    assert(termLabel(model.grades[4]) === termLabel(prepaDeSeisPeriodos(system).grades[4]),
      `${system}: la etiqueta no se reconstruyó igual`);
  }
});

test('el plan de estudios sobrevive la ida y vuelta', () => {
  const { model } = scenarioToModel(modelToScenario(prepaDeSeisPeriodos()));
  const horas = planOf(model, model.grades[0]).reduce((n, e) => n + e.hours, 0);
  assert(horas === 15, `volvieron ${horas} h en vez de 15`);
});

// --------------------------------------------------------------------------- //
// Respaldos anteriores
// --------------------------------------------------------------------------- //
const respaldoViejo = () => ({
  version: 2,
  school: { name: 'X', cycle: '2026' },
  time: { startTime: '07:00', classMinutes: 60, classesPerDay: 7, days: ['Lunes'], breaks: [] },
  // Los periodos eran del plantel entero y el plan se guardaba por periodo.
  terms: { system: 'semestral', current: 2 },
  subjects: [{ id: 'S1', name: 'Mat', short: '', color: '#000', prefersMorning: false }],
  teachers: [],
  grades: [
    {
      id: 'G1', name: '2', level: 'preparatoria', shift: 'matutino',
      groups: [{ name: 'A', blockedSlots: [] }],
      plans: {
        1: [{ subjectId: 'S1', hours: 3, maxPerDay: 2, assignToTutor: false }],
        2: [{ subjectId: 'S1', hours: 7, maxPerDay: 2, assignToTutor: false }],
      },
    },
    {
      id: 'G2', name: '1', level: 'primaria', shift: 'matutino',
      groups: [{ name: 'A', blockedSlots: [] }],
      // Respaldo aún más viejo: un solo plan por grado.
      plan: [{ subjectId: 'S1', hours: 4, maxPerDay: 2, assignToTutor: false }],
    },
  ],
});

test('un respaldo con pestañas de periodo se abre sin perder el plan activo', () => {
  const model = migrateModel(respaldoViejo());
  assert(model.terms === undefined, 'quedó el sistema de periodos global');
  assert(model.grades[0].plans === undefined, 'quedaron los planes por periodo');
  assert(model.grades[0].plan[0].hours === 7, `conservó ${model.grades[0].plan[0].hours} h`);
  assert(model.grades[0].term === 2 && model.grades[0].termSystem === 'semestral',
    'la prepa no recuperó su periodo');
  assert(model.grades[1].term === undefined, 'le puso periodo a la primaria');
  assert(model.grades[1].plan[0].hours === 4, 'perdió el plan del respaldo más viejo');
});

test('los bimestres del modelo viejo caen en semestres', () => {
  const viejo = respaldoViejo();
  viejo.terms = { system: 'bimestral', current: 1 };
  const model = migrateModel(viejo);
  assert(model.grades[0].termSystem === 'semestral', `quedó en ${model.grades[0].termSystem}`);
});

// --------------------------------------------------------------------------- //
console.log(`\nModelo de captura — ${results.length} pruebas\n`);
console.log(results.join('\n'));
console.log(failures ? `\n${failures} prueba(s) fallaron` : '\ntodas las pruebas pasaron');
process.exit(failures ? 1 : 0);
