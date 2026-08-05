/**
 * Controlador de la aplicación CronoWeb.
 *
 * Une las piezas: escenario (JSON) → gateway (motor local o remoto) →
 * renderizado de horarios → exportación a PNG.
 *
 * Todo el estado vive en `state` y se persiste en localStorage, de modo que una
 * escuela puede cerrar la pestaña a media captura sin perder su trabajo.
 *
 * @module main
 */

import { exportNodeAsPng, exportNodesAsPng } from './export/png.js';
import { planFeatures } from './engine/branding.js';
import { GatewayError, SolverGateway } from './gateway.js';
import {
  renderConflictsPanel, renderKpis, renderLoadsPanel, renderStatusMessage, renderTutorsPanel,
} from './ui/panels.js';
import { createView, groupLabel, renderGroupTimetable, renderTeacherTimetable } from './ui/timetable.js';

const STORAGE_KEY = 'cronoweb.v1';
const DEMO_URL = new URL('backend/samples/demo_secundaria.json', document.baseURI).href;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// --------------------------------------------------------------------------- //
// Estado
// --------------------------------------------------------------------------- //
const state = {
  /**
   * Plan activo. Hoy no hay cobro: se resuelve por URL (`?plan=school`) o por lo
   * guardado en el navegador. Cuando exista licencia, este valor vendrá del
   * servidor y el resto de la app no cambia.
   */
  plan: 'free',
  mode: 'simple',
  scenarioText: '',
  branding: { school_name: '', cycle_label: '', primary_color: '#0f766e', footer_note: '', logo_data_url: null },
  options: { budget: 8, seed: 12345, engine: 'local', apiUrl: 'http://localhost:8000', scale: 3 },
  view: null,
  tab: 'groups',
  busy: false,
};

const gateway = new SolverGateway({ mode: 'local', plan: 'free' });

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: state.mode,
      scenarioText: state.scenarioText,
      branding: state.branding,
      options: state.options,
    }));
  } catch { /* modo privado o cuota llena: no es crítico */ }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) return false;
    Object.assign(state, {
      mode: saved.mode || 'simple',
      scenarioText: saved.scenarioText || '',
      branding: { ...state.branding, ...(saved.branding || {}) },
      options: { ...state.options, ...(saved.options || {}) },
    });
    return Boolean(saved.scenarioText);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Estado visual (barra superior)
// --------------------------------------------------------------------------- //
function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  $('status-dot').className = `cw-dot${kind ? ` cw-dot--${kind}` : ''}`;
}

function setBusy(busy, label = 'Calculando…') {
  state.busy = busy;
  $('btn-generate').disabled = busy;
  $('btn-validate').disabled = busy;
  $('btn-cancel').hidden = !busy;
  $('progress').hidden = !busy;
  if (busy) {
    setStatus(label, 'busy');
    $('progress').firstElementChild.style.width = '8%';
  }
}

function showScenarioErrors(title, issues = []) {
  const box = $('scenario-errors');
  box.textContent = '';
  if (!title) return;
  const msg = el('div', 'cw-msg cw-msg--error');
  msg.appendChild(el('b', null, title));
  if (issues.length) {
    const list = el('ul');
    list.style.cssText = 'margin:4px 0 0;padding-left:18px';
    for (const issue of issues.slice(0, 12)) list.appendChild(el('li', null, issue));
    if (issues.length > 12) list.appendChild(el('li', null, `…y ${issues.length - 12} más`));
    msg.appendChild(list);
  }
  box.appendChild(msg);
}

// --------------------------------------------------------------------------- //
// Escenario
// --------------------------------------------------------------------------- //
function parseScenario() {
  const text = $('scenario').value.trim();
  if (!text) throw new GatewayError('Captura o carga un escenario antes de generar el horario.');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GatewayError(`El JSON tiene un error de sintaxis: ${error.message}`);
  }
}

/** Ensambla la petición: escenario + opciones del panel + branding del modo activo. */
function buildPayload() {
  const scenario = parseScenario();
  const features = planFeatures(state.plan);

  const payload = {
    ...scenario,
    options: {
      ...(scenario.options || {}),
      time_budget_seconds: Math.min(features.max_time_budget_seconds, Number(state.options.budget) || 8),
      seed: Number(state.options.seed) || 12345,
    },
    branding: state.mode === 'custom'
      ? {
        mode: 'custom',
        school_name: state.branding.school_name || null,
        cycle_label: state.branding.cycle_label || null,
        primary_color: state.branding.primary_color || '#0f766e',
        footer_note: state.branding.footer_note || null,
        logo_data_url: state.branding.logo_data_url || null,
      }
      : { mode: 'simple', cycle_label: state.branding.cycle_label || null },
  };
  return payload;
}

async function loadDemo() {
  setStatus('Cargando ejemplo…', 'busy');
  try {
    const response = await fetch(DEMO_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const demo = await response.json();
    $('scenario').value = JSON.stringify(demo, null, 2);
    state.scenarioText = $('scenario').value;
    state.branding.cycle_label = demo.branding?.cycle_label || '';
    $('brand-cycle').value = state.branding.cycle_label;
    showScenarioErrors(null);
    persist();
    setStatus('Ejemplo cargado: secundaria de 6 grupos', 'ok');
  } catch (error) {
    setStatus('No se pudo cargar el ejemplo', 'error');
    showScenarioErrors(
      'No se pudo cargar el escenario de ejemplo.',
      [`${error.message}. Si abriste el archivo con doble clic, sírvelo por http (npm run serve).`],
    );
  }
}

// --------------------------------------------------------------------------- //
// Ejecución
// --------------------------------------------------------------------------- //
async function run(kind) {
  if (state.busy) return;

  let payload;
  try {
    payload = buildPayload();
    showScenarioErrors(null);
  } catch (error) {
    showScenarioErrors(error.message, error.issues || []);
    setStatus('Datos inválidos', 'error');
    return;
  }

  gateway.configure({ mode: state.options.engine, apiUrl: state.options.apiUrl, plan: state.plan });
  setBusy(true, kind === 'validate' ? 'Revisando datos…' : 'Calculando horario…');

  try {
    const response = kind === 'validate'
      ? await gateway.validate(payload)
      : await gateway.generate(payload, {
        onProgress: ({ placed, required, attempt }) => {
          const pct = required ? Math.round((placed / required) * 100) : 0;
          $('progress').firstElementChild.style.width = `${Math.max(8, pct)}%`;
          setStatus(`Calculando… ${pct} % (intento ${attempt + 1})`, 'busy');
        },
      });

    // El payload normalizado por el motor no vuelve en la respuesta; para el
    // renderizado se usa el escenario tal cual lo capturó la escuela.
    state.view = createView(payload, response);
    renderResults();

    const kindMap = { ok: 'ok', partial: 'warn', infeasible: 'error' };
    const labelMap = {
      ok: 'Horario completo',
      partial: `Horario parcial · faltan ${response.metrics.required_hours - response.metrics.placed_hours} h`,
      infeasible: 'Los datos no permiten generar el horario',
    };
    setStatus(labelMap[response.status] || response.status, kindMap[response.status] || '');
  } catch (error) {
    const isGateway = error instanceof GatewayError;
    showScenarioErrors(
      isGateway ? error.message : `Error inesperado: ${error.message}`,
      isGateway ? error.issues : [],
    );
    setStatus('Error al generar', 'error');
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------------------------- //
// Render de resultados
// --------------------------------------------------------------------------- //
function renderResults() {
  const view = state.view;
  const results = $('results');
  results.textContent = '';

  if (!view) {
    results.appendChild(el('div', 'cw-empty', 'Genera un horario para ver los resultados.'));
    return;
  }

  // Resumen
  const kpis = $('kpis');
  kpis.textContent = '';
  kpis.appendChild(renderKpis(view));
  $('summary').hidden = false;

  const errors = (view.response.conflicts || []).filter((c) => c.severity === 'error').length;
  const warnings = (view.response.conflicts || []).filter((c) => c.severity === 'warning').length;
  $('conflict-count').textContent = errors || warnings ? `(${errors + warnings})` : '';

  results.appendChild(renderStatusMessage(view));

  const hasSchedule = (view.response.assignments || []).length > 0;
  $('btn-export-all').disabled = !hasSchedule;
  $('btn-print').disabled = !hasSchedule;

  if (state.tab === 'groups' || state.tab === 'teachers') {
    if (!hasSchedule) {
      results.appendChild(el('div', 'cw-empty',
        'Todavía no hay horario que mostrar. Corrige los problemas de la pestaña «Avisos».'));
      return;
    }
    const ids = state.tab === 'groups'
      ? view.request.groups.map((g) => g.id)
      : view.request.teachers
        .filter((t) => (view.response.metrics?.teacher_load?.[t.id]?.assigned || 0) > 0)
        .map((t) => t.id);

    for (const id of ids) {
      results.appendChild(renderCardWrapper(view, id, state.tab));
    }
    return;
  }

  const panel = { tutors: renderTutorsPanel, loads: renderLoadsPanel, conflicts: renderConflictsPanel }[state.tab];
  const box = el('div');
  box.style.padding = '0 2px 6px';
  box.appendChild(panel(view));
  results.appendChild(box);
}

/** Tarjeta + barra de herramientas (la barra NO entra en el PNG). */
function renderCardWrapper(view, id, tab) {
  const card = tab === 'groups' ? renderGroupTimetable(view, id) : renderTeacherTimetable(view, id);

  const wrap = el('div', 'cw-card-wrap');
  const toolbar = el('div', 'cw-card-toolbar');
  const title = tab === 'groups'
    ? `Grupo ${groupLabel(view.groups.get(id))}`
    : view.teachers.get(id).name;
  toolbar.appendChild(el('strong', null, title));
  toolbar.appendChild(el('div', 'cw-topbar__spacer'));

  const button = el('button', 'cw-btn cw-btn--sm cw-btn--primary', 'Descargar PNG');
  button.type = 'button';
  button.addEventListener('click', () => downloadCard(card, button));
  toolbar.appendChild(button);

  wrap.appendChild(toolbar);
  wrap.appendChild(card);
  return wrap;
}

// --------------------------------------------------------------------------- //
// Exportación
// --------------------------------------------------------------------------- //
function exportOptions() {
  const branding = state.view?.response?.branding || {};
  return {
    scale: Number(state.options.scale) || 3,
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
        if (name) setStatus(`Exportando ${i + 1} de ${total}: ${name}…`, 'busy');
      },
    });
    setStatus(
      failed.length
        ? `${exported.length} PNG descargados · ${failed.length} fallaron`
        : `${exported.length} PNG descargados`,
      failed.length ? 'warn' : 'ok',
    );
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------------------- //
// Modo simple / personalizado
// --------------------------------------------------------------------------- //
function applyMode() {
  const custom = state.mode === 'custom';
  $('mode-simple').setAttribute('aria-pressed', String(!custom));
  $('mode-custom').setAttribute('aria-pressed', String(custom));
  $('branding-custom-fields').hidden = !custom;
  $('branding-simple-note').hidden = custom;
  persist();
}

function requestCustomMode() {
  const features = planFeatures(state.plan);
  if (!features.custom_branding) {
    showScenarioErrors(
      'El modo personalizado (logo y nombre de la escuela) es parte del plan Escuela.',
      [
        'Plan Escuela: $1,800 MXN al año por plantel — hasta 60 grupos y 200 profesores.',
        'El modo simple es gratuito y genera el horario completo, con la marca CronoWeb.com.',
      ],
    );
    setStatus('Modo personalizado no incluido en este plan', 'warn');
    return;
  }
  state.mode = 'custom';
  applyMode();
}

function readLogoFile(file) {
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) {
    setStatus('El logotipo pesa más de 1.5 MB; usa una versión más ligera', 'warn');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    // Se guarda como data URL: así viaja dentro del JSON y html2canvas puede
    // rasterizarlo sin problemas de CORS.
    state.branding.logo_data_url = String(reader.result);
    persist();
    setStatus('Logotipo cargado', 'ok');
  };
  reader.onerror = () => setStatus('No se pudo leer el logotipo', 'error');
  reader.readAsDataURL(file);
}

// --------------------------------------------------------------------------- //
// Arranque
// --------------------------------------------------------------------------- //
function bindEvents() {
  $('btn-demo').addEventListener('click', loadDemo);
  $('btn-generate').addEventListener('click', () => run('generate'));
  $('btn-validate').addEventListener('click', () => run('validate'));
  $('btn-cancel').addEventListener('click', () => {
    gateway.cancel();
    setBusy(false);
    setStatus('Cálculo cancelado', 'warn');
  });

  $('scenario').addEventListener('input', (event) => {
    state.scenarioText = event.target.value;
    persist();
  });

  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('scenario').value = String(reader.result);
      state.scenarioText = $('scenario').value;
      persist();
      setStatus(`Escenario importado: ${file.name}`, 'ok');
    };
    reader.readAsText(file);
    event.target.value = '';
  });

  $('btn-export-json').addEventListener('click', () => {
    const blob = new Blob([$('scenario').value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cronoweb-escenario.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  $('opt-budget').addEventListener('change', (e) => { state.options.budget = Number(e.target.value); persist(); });
  $('opt-seed').addEventListener('change', (e) => { state.options.seed = Number(e.target.value); persist(); });
  $('opt-scale').addEventListener('change', (e) => { state.options.scale = Number(e.target.value); persist(); });
  $('opt-api').addEventListener('change', (e) => { state.options.apiUrl = e.target.value; persist(); });
  $('opt-engine').addEventListener('change', (e) => {
    state.options.engine = e.target.value;
    $('field-api').hidden = e.target.value !== 'remote';
    persist();
  });

  $('mode-simple').addEventListener('click', () => { state.mode = 'simple'; applyMode(); });
  $('mode-custom').addEventListener('click', requestCustomMode);

  for (const field of ['school', 'cycle', 'color', 'note']) {
    const key = { school: 'school_name', cycle: 'cycle_label', color: 'primary_color', note: 'footer_note' }[field];
    $(`brand-${field}`).addEventListener('input', (e) => { state.branding[key] = e.target.value; persist(); });
  }
  $('brand-logo').addEventListener('change', (e) => readLogoFile(e.target.files?.[0]));

  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.view;
      for (const other of document.querySelectorAll('[role="tab"]')) {
        other.setAttribute('aria-selected', String(other === tab));
      }
      renderResults();
    });
  }

  $('btn-export-all').addEventListener('click', downloadAll);
  $('btn-print').addEventListener('click', () => window.print());
}

function hydrateForm() {
  $('scenario').value = state.scenarioText;
  $('opt-budget').value = state.options.budget;
  $('opt-seed').value = state.options.seed;
  $('opt-scale').value = String(state.options.scale);
  $('opt-engine').value = state.options.engine;
  $('opt-api').value = state.options.apiUrl;
  $('field-api').hidden = state.options.engine !== 'remote';
  $('brand-school').value = state.branding.school_name || '';
  $('brand-cycle').value = state.branding.cycle_label || '';
  $('brand-color').value = state.branding.primary_color || '#0f766e';
  $('brand-note').value = state.branding.footer_note || '';
}

async function init() {
  // Plan: `?plan=school` sirve para demostrar el modo personalizado a una escuela
  // antes de que exista el cobro. Se recuerda en el navegador.
  const urlPlan = new URLSearchParams(location.search).get('plan');
  if (urlPlan) localStorage.setItem('cronoweb.plan', urlPlan);
  state.plan = localStorage.getItem('cronoweb.plan') || 'free';
  gateway.configure({ plan: state.plan });

  const hadScenario = restore();
  hydrateForm();
  applyMode();
  bindEvents();

  if (!hadScenario) await loadDemo();
  else setStatus('Escenario recuperado de tu navegador', 'ok');

  const features = planFeatures(state.plan);
  if (features.key !== 'free') {
    document.querySelector('.cw-brand__tag').textContent = `Plan ${features.label}`;
  }
}

init();
