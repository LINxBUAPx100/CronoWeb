/**
 * Controlador de la aplicación CronoWeb.
 *
 *   formularios (ui/studio) → modelo (model/school) → contrato (model/serialize)
 *   → motor (gateway: worker local o API) → horarios (ui/timetable) → PNG
 *
 * La escuela nunca ve JSON: entra por formularios y sale como imagen. El contrato
 * sigue existiendo, pero como formato de respaldo y de intercambio, no como
 * interfaz de usuario.
 *
 * @module main
 */

import { planFeatures } from './engine/branding.js';
import { exportNodeAsPng, exportNodesAsPng } from './export/png.js';
import { GatewayError, SolverGateway } from './gateway.js';
import {
  allGroups, createEmptyModel, createGrade, createSubject, createTeacher, migrateModel,
  reviewModel, syncPlans,
} from './model/school.js';
import { createEditSession, isDirty, rebuildResponse, resetSession, undo } from './model/edit.js';
import { modelToScenario, scenarioToModel } from './model/serialize.js';
import { h, mount } from './ui/dom.js';
import { attachEditor } from './ui/editor.js';
import {
  renderConflictsPanel, renderKpis, renderLoadsPanel, renderStatusMessage, renderTutorsPanel,
} from './ui/panels.js';
import { modelSummary, renderStudio, SCREENS } from './ui/studio.js';
import {
  createView, FORMATS, listTargets, renderTimetableCard, VIEW_TYPES,
} from './ui/timetable.js';

/** Plan por omisión. Ver la nota en `init()`: hoy el modo Pro está abierto. */
const DEFAULT_PLAN = 'school';

const STORAGE_KEY = 'cronoweb.model.v2';
const PREFS_KEY = 'cronoweb.prefs.v2';
const DEMO_URL = new URL('backend/samples/demo_secundaria.json', document.baseURI).href;

const $ = (id) => document.getElementById(id);

const NAV = [
  ...SCREENS.map((screen, i) => ({ ...screen, step: String(i + 1) })),
  { id: 'resultados', label: 'Horarios', hint: 'Ver, imprimir y descargar', step: '5' },
  { id: 'ajustes', label: 'Ajustes', hint: 'Cálculo, imagen e identidad', step: '·' },
];

// --------------------------------------------------------------------------- //
// Estado
// --------------------------------------------------------------------------- //
const state = {
  plan: DEFAULT_PLAN,
  mode: 'simple',
  model: createEmptyModel(),
  screen: 'horario',
  /**
   * `budget`, `seed`, `scale`, `engine` y `apiUrl` ya NO se editan desde la
   * interfaz: son decisiones técnicas con una respuesta correcta para el 99 % de
   * las escuelas (ocho segundos alcanzan, 3× es calidad de imprenta, y calcular
   * en el navegador es lo que hace que los datos no salgan de la computadora).
   * Exponerlas sólo servía para que alguien las moviera sin saber qué hacían.
   * La semilla la cambia el botón «Otra variante» de la pantalla de horarios.
   *
   * `tuning` sí es de la escuela: son las tres reglas de acomodo que una
   * dirección tiene opinión sobre ellas, en español y sin números.
   */
  prefs: {
    budget: 8,
    seed: 12345,
    scale: 3,
    engine: 'local',
    apiUrl: 'http://localhost:8000',
    tuning: { gaps: 'normal', morning: 'normal', repeat: 'normal' },
  },
  view: null,
  resultTab: 'horarios',
  viewType: 'group',
  format: 'tecnico',
  busy: false,
  // Edición manual: sesión de model/edit.js + qué grupo se está editando.
  editSession: null,
  editingGroup: null,
  editStatus: '',
  editorHandle: null,
};

const gateway = new SolverGateway({ mode: 'local', plan: DEFAULT_PLAN });

const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.model));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: state.mode, prefs: state.prefs }));
  } catch { /* modo privado o cuota llena: no es crítico */ }
  updateRailStats();
};

function restore() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (prefs) {
      state.mode = prefs.mode || 'simple';
      const guardadas = prefs.prefs || {};
      Object.assign(state.prefs, guardadas);
      // `tuning` es más nuevo que los respaldos: se rellena campo por campo para
      // que un ajuste añadido después no llegue como `undefined` al selector.
      state.prefs.tuning = { gaps: 'normal', morning: 'normal', repeat: 'normal', ...(guardadas.tuning || {}) };
    }
    const model = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (model?.subjects) {
      // Los respaldos viejos traen los periodos como una pestaña del plantel
      // (`model.terms` + `grade.plans`); migrateModel los pasa al esquema actual
      // —un grado por periodo— sin que la escuela pierda nada.
      state.model = migrateModel(model);
      syncPlans(state.model);
      return true;
    }
  } catch { /* respaldo corrupto: se arranca limpio */ }
  return false;
}

// --------------------------------------------------------------------------- //
// Barra de estado
// --------------------------------------------------------------------------- //
function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  $('status-dot').className = `cw-dot${kind ? ` cw-dot--${kind}` : ''}`;
}

function setBusy(busy, label = 'Calculando…') {
  state.busy = busy;
  $('btn-generate').disabled = busy;
  $('progress').hidden = !busy;
  if (busy) {
    setStatus(label, 'busy');
    $('progress').firstElementChild.style.width = '8%';
  }
}

// --------------------------------------------------------------------------- //
// Navegación
// --------------------------------------------------------------------------- //
function renderNav() {
  mount($('steps'),
    NAV.map((item) => {
      const active = state.screen === item.id;
      const disabled = item.id === 'resultados' && !state.view;
      return h('li',
        h('button', {
          type: 'button',
          class: `cw-step${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`,
          disabled,
          onClick: () => goTo(item.id),
        },
        h('span.cw-step__num', item.step),
        h('span.cw-step__text', h('b', item.label), h('small', item.hint))));
    }));
}

function goTo(screen) {
  state.screen = screen;
  const isResults = screen === 'resultados';
  const isSettings = screen === 'ajustes';
  $('studio-panel').hidden = isResults || isSettings;
  $('settings-panel').hidden = !isSettings;
  $('results-panel').hidden = !isResults;

  if (!isResults && !isSettings) renderScreen();
  if (isResults) renderResults();
  // El nombre y el ciclo se pueden haber editado en el paso 1: al entrar a
  // Ajustes los campos se rellenan otra vez con lo que dice el modelo.
  if (isSettings) hydrateSettings();
  renderNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderScreen() {
  renderStudio($('studio'), {
    model: state.model,
    screen: state.screen,
    save,
    rerender: renderScreen,
  });
  renderReview();

  const index = SCREENS.findIndex((s) => s.id === state.screen);
  $('btn-prev').disabled = index <= 0;
  $('btn-next').textContent = index === SCREENS.length - 1 ? 'Revisar y generar →' : 'Siguiente →';
}

/** Avisos de captura de la pantalla actual (los del motor van en Resultados). */
function renderReview() {
  const issues = reviewModel(state.model);
  const box = $('review');
  const mine = issues.filter((issue) => issue.screen === state.screen);

  if (!mine.length) {
    mount(box, issues.length
      ? h('span.cw-hint', `Faltan datos en otros pasos (${issues.length}).`)
      : h('span.cw-hint.cw-hint--ok', 'Datos completos en este paso.'));
    return;
  }
  mount(box, mine.slice(0, 3).map((issue) =>
    h('div', { class: `cw-msg cw-msg--${issue.level === 'error' ? 'error' : 'warning'} cw-msg--tight` },
      issue.message)));
}

function updateRailStats() {
  const s = modelSummary(state.model);
  mount($('rail-stats'),
    s.levels && h('div', h('b', s.levels)),
    h('div', h('b', String(s.groups)), ' grupos'),
    h('div', h('b', String(s.teachers)), ' profesores'),
    h('div', h('b', `${s.hours} h`), ' por semana'));
}

// --------------------------------------------------------------------------- //
// Generación
// --------------------------------------------------------------------------- //
/**
 * Traduce las tres preferencias de Ajustes a los pesos del motor.
 *
 * La escuela elige en español —«evitarlas a toda costa»— y aquí se convierte al
 * número que el solver usa como costo. La tabla vive en un solo sitio para que
 * afinar los valores sea tocar cinco líneas y no buscar constantes por toda la
 * app; los `normal` son exactamente los defaults del contrato.
 */
function tuningWeights(tuning = {}) {
  const escala = { off: 0, normal: 1, alta: 2.5 };
  const factor = (key) => escala[tuning[key]] ?? 1;
  return {
    teacher_gap: 3.0 * factor('gaps'),
    morning_preference: 1.5 * factor('morning'),
    same_day_repeat: 6.0 * factor('repeat'),
  };
}

async function generate(options = {}) {
  if (state.busy) return;

  if (options.newVariant) {
    // Otra semilla = otro horario igualmente válido. Se guarda para que el
    // resultado siga siendo reproducible si mañana se regenera.
    state.prefs.seed = (Number(state.prefs.seed) || 12345) + 1;
    save();
  }

  const issues = reviewModel(state.model);
  const blocking = issues.filter((issue) => issue.level === 'error');
  if (blocking.length) {
    goTo(blocking[0].screen);
    setStatus(blocking[0].message, 'error');
    return;
  }

  const scenario = modelToScenario(state.model, {
    mode: state.mode,
    budget: state.prefs.budget,
    seed: state.prefs.seed,
    weights: tuningWeights(state.prefs.tuning),
  });

  gateway.configure({ mode: state.prefs.engine, apiUrl: state.prefs.apiUrl, plan: state.plan });
  setBusy(true);

  try {
    const response = await gateway.generate(scenario, {
      onProgress: ({ placed, required, attempt }) => {
        const pct = required ? Math.round((placed / required) * 100) : 0;
        $('progress').firstElementChild.style.width = `${Math.max(8, pct)}%`;
        setStatus(`Acomodando horas… ${pct} % (intento ${attempt + 1})`, 'busy');
      },
    });

    state.view = createView(scenario, response);
    discardEditing();
    goTo('resultados');

    const labels = {
      ok: ['Horario completo', 'ok'],
      partial: [`Faltaron ${response.metrics.required_hours - response.metrics.placed_hours} h por acomodar`, 'warn'],
      infeasible: ['Los datos no permiten generar el horario', 'error'],
    };
    const [text, kind] = labels[response.status] || [response.status, ''];
    setStatus(text, kind);
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : `Error inesperado: ${error.message}`;
    setStatus(message, 'error');
    alert(message + (error.issues?.length ? `\n\n· ${error.issues.join('\n· ')}` : ''));
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------------------------- //
// Resultados
// --------------------------------------------------------------------------- //
function renderResultControls() {
  mount($('view-types'),
    VIEW_TYPES.map((type) => h('button', {
      type: 'button',
      class: `cw-seg__btn${state.viewType === type.id ? ' is-on' : ''}`,
      onClick: () => { state.viewType = type.id; renderResults(); },
    }, type.label)));

  mount($('formats'),
    FORMATS.map((format) => h('button', {
      type: 'button',
      class: `cw-seg__btn${state.format === format.id ? ' is-on' : ''}`,
      title: format.hint,
      onClick: () => { state.format = format.id; renderResults(); },
    }, format.label)));
}

function renderResults() {
  const view = state.view;
  const results = $('results');
  detachEditor();
  if (!view) {
    mount(results, h('div.cw-empty', 'Genera un horario para ver los resultados.'));
    return;
  }

  mount($('kpis'), renderKpis(view));
  $('kpis').hidden = false;

  const conflicts = view.response.conflicts || [];
  const relevant = conflicts.filter((c) => c.severity !== 'info').length;
  $('conflict-count').textContent = relevant ? `(${relevant})` : '';

  const hasSchedule = (view.response.assignments || []).length > 0;
  $('btn-export-all').disabled = !hasSchedule;
  $('btn-print').disabled = !hasSchedule;
  $('btn-variant').disabled = state.busy;
  $('edited-tag').hidden = !(state.editSession && isDirty(state.editSession));
  $('exportbar').hidden = state.resultTab !== 'horarios';

  if (state.resultTab !== 'horarios') {
    const panel = { tutors: renderTutorsPanel, loads: renderLoadsPanel, conflicts: renderConflictsPanel }[state.resultTab];
    mount(results, h('div', { style: { padding: '0 2px 6px' } }, panel(view)));
    return;
  }

  renderResultControls();
  const children = [renderStatusMessage(view)];

  if (!hasSchedule) {
    children.push(h('div.cw-empty',
      'Todavía no hay horario que mostrar. Revisa la pestaña «Avisos» para saber qué corregir.'));
    mount(results, children);
    return;
  }

  const targets = listTargets(view, state.viewType);
  if (!targets.length) {
    children.push(h('div.cw-empty', 'No hay nada que mostrar en esta vista.'));
  }
  const cards = new Map();
  for (const target of targets) {
    const { node, card } = sheet(view, target);
    cards.set(target.id, card);
    children.push(node);
  }
  mount(results, children);

  // El editor se engancha DESPUÉS de montar: necesita las celdas ya en el DOM.
  if (state.editingGroup && cards.has(state.editingGroup)) {
    state.editorHandle = attachEditor(cards.get(state.editingGroup), ensureEditSession(), {
      groupId: state.editingGroup,
      onChange: commitEdit,
      onStatus: (text) => {
        state.editStatus = text;
        const box = $(`edit-status-${state.editingGroup}`);
        if (box) box.textContent = text;
      },
    });
  }
}

/**
 * Una hoja: título, acciones y la tarjeta imprimible. La barra NO entra en el PNG.
 * El marco tiene scroll propio para que en celular la hoja se desplace sin
 * romper el ancho de la página.
 */
function sheet(view, target) {
  // El nombre del archivo lo arma renderTimetableCard: en prepa ya trae el
  // periodo («horario-3er-semestre-…»), porque cada grado ES un periodo.
  const card = renderTimetableCard(view, { type: state.viewType, id: target.id, format: state.format });

  const download = h('button.cw-btn.cw-btn--sm', { type: 'button' }, 'Descargar PNG');
  download.addEventListener('click', () => downloadCard(card, download));

  const bar = h('div.cw-sheet__bar',
    h('strong', target.label),
    h('span.cw-tag', state.format === 'alumnos' ? 'Para alumnos' : 'Técnico'),
    h('div.cw-topbar__spacer'));

  // Editar sólo tiene sentido por grupo: es la rejilla donde una casilla equivale
  // a una decisión («esta clase, a esta hora»).
  if (state.viewType === 'group') {
    const editing = state.editingGroup === target.id;
    if (editing) {
      const session = ensureEditSession();
      bar.appendChild(h('button.cw-btn.cw-btn--sm', {
        type: 'button',
        disabled: !session.history.length,
        onClick: () => { if (undo(session)) commitEdit('Se deshizo el último cambio.'); },
      }, 'Deshacer'));
      bar.appendChild(h('button.cw-btn.cw-btn--sm', {
        type: 'button',
        disabled: !isDirty(session),
        onClick: () => { resetSession(session); commitEdit('Se restauró el horario generado.'); },
      }, 'Restaurar'));
    }
    bar.appendChild(h('button', {
      type: 'button',
      class: `cw-btn cw-btn--sm${editing ? ' cw-btn--primary' : ''}`,
      onClick: () => {
        detachEditor();
        state.editingGroup = editing ? null : target.id;
        renderResults();
      },
    }, editing ? 'Terminar edición' : 'Editar'));
  }
  bar.appendChild(download);

  const parts = [bar];
  if (state.editingGroup === target.id) {
    parts.push(h('div.cw-edit-hint', { id: `edit-status-${target.id}` }, state.editStatus || 'Toca una clase para moverla.'));
  }
  parts.push(h('div.cw-sheet__frame', card));
  return { node: h('div.cw-sheet', parts), card };
}

// --------------------------------------------------------------------------- //
// Edición manual
// --------------------------------------------------------------------------- //
function ensureEditSession() {
  if (!state.editSession) {
    state.editSession = createEditSession(state.view.request, state.view.response);
  }
  return state.editSession;
}

// --------------------------------------------------------------------------- //
// Toggle para ocultar/mostrar la sección inferior de la barra lateral
// --------------------------------------------------------------------------- //
function initRailFooterToggle() {
  const RAIL = document.querySelector('.cw-rail');
  if (!RAIL) return;
  const FOOT = RAIL.querySelector('.cw-rail__foot');
  if (!FOOT) return;

  const key = 'cronoweb.railCollapsed';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-toggle-railfoot';
  btn.className = 'cw-rail__toggle';

  const collapsed = localStorage.getItem(key) === 'true';
  if (collapsed) RAIL.classList.add('cw-rail--collapsed');
  btn.textContent = RAIL.classList.contains('cw-rail--collapsed') ? 'Mostrar opciones' : 'Ocultar opciones';

  btn.addEventListener('click', () => {
    const now = RAIL.classList.toggle('cw-rail--collapsed');
    localStorage.setItem(key, now ? 'true' : 'false');
    btn.textContent = now ? 'Mostrar opciones' : 'Ocultar opciones';
  });

  RAIL.insertBefore(btn, FOOT);
}

initRailFooterToggle();

function detachEditor() {
  if (state.editorHandle) {
    state.editorHandle.destroy();
    state.editorHandle = null;
  }
}

/** Vuelca las asignaciones editadas al resultado y redibuja. */
function commitEdit(message) {
  const session = ensureEditSession();
  detachEditor();
  const rebuilt = rebuildResponse(state.view.request, state.view.response, session.assignments);
  state.view = createView(state.view.request, rebuilt);
  if (message) state.editStatus = message;
  renderResults();
  setStatus(
    isDirty(session)
      ? `Horario editado a mano · ${session.moves} cambio(s)`
      : 'Horario tal como lo generó CronoWeb',
    isDirty(session) ? 'warn' : 'ok',
  );
}

function discardEditing() {
  detachEditor();
  state.editSession = null;
  state.editingGroup = null;
  state.editStatus = '';
}

// --------------------------------------------------------------------------- //
// Exportación
// --------------------------------------------------------------------------- //
function exportOptions() {
  const branding = state.view?.response?.branding || {};
  return {
    scale: Number(state.prefs.scale) || 3,
    background: '#ffffff',
    // La marca de agua la decide el motor según el plan, no el cliente.
    watermarkRequired: branding.watermark_required !== false,
    watermarkText: branding.watermark_text || 'CronoWeb.com',
  };
}

async function downloadCard(card, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Generando…';
  try {
    const { filename } = await exportNodeAsPng(card, exportOptions());
    setStatus(`Descargado ${filename}`, 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function downloadAll() {
  const cards = [...$('results').querySelectorAll('.cw-card')];
  if (!cards.length) return;

  const button = $('btn-export-all');
  button.disabled = true;
  try {
    const { exported, failed } = await exportNodesAsPng(cards, {
      ...exportOptions(),
      onProgress: (i, total, name) => {
        if (name) setStatus(`Descargando ${i + 1} de ${total}: ${name}…`, 'busy');
      },
    });
    setStatus(
      failed.length ? `${exported.length} imágenes descargadas · ${failed.length} fallaron`
        : `${exported.length} imágenes descargadas`,
      failed.length ? 'warn' : 'ok',
    );
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------------------- //
// Respaldos y ejemplo
// --------------------------------------------------------------------------- //
function downloadBackup() {
  // El respaldo es el escenario en formato de contrato: sirve para reabrirlo aquí
  // y también para mandarlo al soporte o al backend.
  const scenario = modelToScenario(state.model, { mode: state.mode });
  const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const name = (state.model.school.name || 'cronoweb').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  link.href = url;
  link.download = `${name}-respaldo.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus('Respaldo descargado', 'ok');
}

function loadScenario(scenario, source) {
  const { model, warnings } = scenarioToModel(scenario);
  state.model = model;
  syncPlans(state.model);
  state.view = null;
  save();
  goTo('horario');
  setStatus(`${source} cargado`, warnings.length ? 'warn' : 'ok');
  if (warnings.length) alert(`Se cargó con ajustes:\n\n· ${warnings.join('\n· ')}`);
}

async function loadDemo() {
  setStatus('Cargando ejemplo…', 'busy');
  try {
    const response = await fetch(DEMO_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    loadScenario(await response.json(), 'Ejemplo de secundaria');
  } catch (error) {
    setStatus('No se pudo cargar el ejemplo', 'error');
    alert(`No se pudo cargar el ejemplo: ${error.message}`);
  }
}

// --------------------------------------------------------------------------- //
// Modo simple / personalizado
// --------------------------------------------------------------------------- //
function applyMode() {
  const custom = state.mode === 'custom';
  $('mode-simple').setAttribute('aria-pressed', String(!custom));
  $('mode-custom').setAttribute('aria-pressed', String(custom));
  // Espejo en Ajustes: en celular es el único visible.
  $('mode-simple-2').classList.toggle('is-on', !custom);
  $('mode-custom-2').classList.toggle('is-on', custom);
  $('branding-custom-fields').hidden = !custom;
  $('branding-simple-note').hidden = custom;
  save();
}

function requestCustomMode() {
  const features = planFeatures(state.plan);
  if (!features.custom_branding) {
    setStatus('El modo personalizado es parte del plan Escuela', 'warn');
    alert(
      'El modo personalizado (logotipo y nombre de la escuela en los horarios) ' +
      'es parte del plan Escuela: $1,800 MXN al año por plantel, hasta 60 grupos ' +
      'y 200 profesores.\n\nEl modo simple es gratuito y genera el horario completo, ' +
      'con la marca CronoWeb.com.',
    );
    return;
  }
  state.mode = 'custom';
  applyMode();
  goTo('ajustes');
}

function readLogoFile(file) {
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) {
    setStatus('El logotipo pesa más de 1.5 MB; usa una versión más ligera', 'warn');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    // Data URL: viaja dentro del escenario y html2canvas la rasteriza sin CORS.
    state.model.school.logo = String(reader.result);
    save();
    setStatus('Logotipo cargado', 'ok');
  };
  reader.onerror = () => setStatus('No se pudo leer el logotipo', 'error');
  reader.readAsDataURL(file);
}

// --------------------------------------------------------------------------- //
// Escenario inicial para una escuela nueva
// --------------------------------------------------------------------------- //
function seedNewModel() {
  const model = createEmptyModel();
  state.model = model;

  // Arrancar con la hoja en blanco total desanima; se deja el esqueleto de una
  // secundaria típica para que el primer clic ya muestre algo reconocible.
  for (const [name, short, morning] of [
    ['Español', 'Esp', true], ['Matemáticas', 'Mat', true], ['Ciencias', 'Cie', true],
    ['Historia', 'His', false], ['Inglés', 'Ing', false], ['Educación Física', 'EdFís', false],
  ]) {
    const subject = createSubject(model, name);
    subject.short = short;
    subject.prefersMorning = morning;
    model.subjects.push(subject);
  }
  model.teachers.push(createTeacher(model));
  const grade = createGrade(model, '1');
  model.grades.push(grade);
  syncPlans(model);
  state.view = null;
  save();
}

// --------------------------------------------------------------------------- //
// Eventos
// --------------------------------------------------------------------------- //
function bindEvents() {
  $('btn-generate').addEventListener('click', () => generate());
  $('btn-variant').addEventListener('click', () => generate({ newVariant: true }));

  $('btn-prev').addEventListener('click', () => {
    const i = SCREENS.findIndex((s) => s.id === state.screen);
    if (i > 0) goTo(SCREENS[i - 1].id);
  });
  $('btn-next').addEventListener('click', () => {
    const i = SCREENS.findIndex((s) => s.id === state.screen);
    if (i < SCREENS.length - 1) goTo(SCREENS[i + 1].id);
    else generate();
  });

  // Los mismos cuatro botones viven en la barra lateral y en Ajustes: la barra
  // se puede plegar y en celular no se ve, así que Ajustes es el sitio donde
  // siempre están.
  const onDataAction = (ids, handler) => {
    for (const id of ids) $(id).addEventListener('click', handler);
  };
  onDataAction(['btn-demo', 'btn-demo-2'], loadDemo);
  onDataAction(['btn-backup', 'btn-backup-2'], downloadBackup);
  onDataAction(['btn-restore', 'btn-restore-2'], () => $('file-input').click());
  onDataAction(['btn-reset', 'btn-reset-2'], () => {
    if (!confirm('¿Borrar todos los datos capturados y empezar de cero?')) return;
    seedNewModel();
    goTo('horario');
    setStatus('Listo para capturar', 'ok');
  });

  $('file-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadScenario(JSON.parse(String(reader.result)), `Respaldo ${file.name}`);
      } catch (error) {
        setStatus('El archivo no es un respaldo válido de CronoWeb', 'error');
        alert(`No se pudo leer el archivo: ${error.message}`);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  });

  for (const [id, key] of [['opt-gaps', 'gaps'], ['opt-morning', 'morning'], ['opt-repeat', 'repeat']]) {
    $(id).addEventListener('change', (e) => { state.prefs.tuning[key] = e.target.value; save(); });
  }

  for (const id of ['mode-simple', 'mode-simple-2']) {
    $(id).addEventListener('click', () => { state.mode = 'simple'; applyMode(); });
  }
  for (const id of ['mode-custom', 'mode-custom-2']) {
    $(id).addEventListener('click', requestCustomMode);
  }
  // El nombre y el ciclo también se capturan en el paso 1: los dos campos
  // escriben en el mismo modelo y cada pantalla se reconstruye al entrar, así
  // que no hay forma de que se desincronicen.
  $('brand-name').addEventListener('input', (e) => { state.model.school.name = e.target.value; save(); });
  $('brand-cycle').addEventListener('input', (e) => { state.model.school.cycle = e.target.value; save(); });
  $('brand-color').addEventListener('change', (e) => { state.model.school.primaryColor = e.target.value; save(); });
  $('brand-note').addEventListener('input', (e) => { state.model.school.footerNote = e.target.value; save(); });
  $('brand-logo').addEventListener('change', (e) => readLogoFile(e.target.files?.[0]));

  for (const tab of $('result-tabs').querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      state.resultTab = tab.dataset.view;
      for (const other of $('result-tabs').querySelectorAll('[role="tab"]')) {
        other.setAttribute('aria-selected', String(other === tab));
      }
      renderResults();
    });
  }

  $('btn-export-all').addEventListener('click', downloadAll);
  $('btn-print').addEventListener('click', () => window.print());
}

function hydrateSettings() {
  $('opt-gaps').value = state.prefs.tuning.gaps;
  $('opt-morning').value = state.prefs.tuning.morning;
  $('opt-repeat').value = state.prefs.tuning.repeat;
  $('brand-name').value = state.model.school.name || '';
  $('brand-cycle').value = state.model.school.cycle || '';
  $('brand-color').value = state.model.school.primaryColor || '#14417c';
  $('brand-note').value = state.model.school.footerNote || '';
}

function init() {
  // Mientras no exista el cobro, el plan Escuela está abierto para todos: es la
  // única forma de probar y afinar el modo personalizado —logotipo, nombre y
  // color en la hoja— antes de ponerle precio. `?plan=free` sigue sirviendo para
  // ver cómo se degrada. Cuando haya licencias, este valor vendrá del servidor y
  // DEFAULT_PLAN vuelve a 'free'.
  const urlPlan = new URLSearchParams(location.search).get('plan');
  if (urlPlan) localStorage.setItem('cronoweb.plan', urlPlan);
  state.plan = localStorage.getItem('cronoweb.plan') || DEFAULT_PLAN;
  gateway.configure({ plan: state.plan });

  const hadData = restore();
  if (!hadData) seedNewModel();

  hydrateSettings();
  applyMode();
  bindEvents();
  updateRailStats();
  goTo('horario');

  const features = planFeatures(state.plan);
  if (features.key !== 'free') {
    document.querySelector('.cw-brand__tag').textContent = `Plan ${features.label}`;
  }
  setStatus(hadData ? 'Datos recuperados de este navegador' : 'Listo para capturar', 'ok');
  if (!hadData && !allGroups(state.model).length) setStatus('Listo para capturar', 'ok');
}

init();
