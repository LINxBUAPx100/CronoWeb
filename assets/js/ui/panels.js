/**
 * Paneles auxiliares del resultado: métricas, tutores, cargas y avisos.
 *
 * Todo lo que aquí se muestra sale tal cual del `ScheduleResponse`; no hay
 * cálculos duplicados fuera del motor.
 *
 * @module ui/panels
 */

import { groupLabel } from './timetable.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const SEVERITY_LABEL = { error: 'Problema', warning: 'Advertencia', info: 'Nota' };

/** Tarjetas de resumen. */
export function renderKpis(view) {
  const m = view.response.metrics;
  const frag = document.createDocumentFragment();
  if (!m) return frag;

  const errors = (view.response.conflicts || []).filter((c) => c.severity === 'error').length;
  const stats = [
    [`${m.placed_hours}/${m.required_hours}`, 'Horas colocadas', false],
    [`${Math.round(m.fill_rate * 100)} %`, 'Cobertura del plan', false],
    [String(m.teacher_gaps), 'Horas muertas', false],
    [String(errors), errors === 1 ? 'Problema por resolver' : 'Problemas por resolver', errors > 0],
    [`${(m.elapsed_ms / 1000).toFixed(2)} s`, 'Tiempo de cálculo', false],
  ];

  for (const [value, label, alert] of stats) {
    const stat = el('div', `cw-stat${alert ? ' cw-stat--alert' : ''}`);
    stat.appendChild(el('b', null, value));
    stat.appendChild(el('span', null, label));
    frag.appendChild(stat);
  }
  return frag;
}

/** Estado global del resultado, en una frase. */
export function renderStatusMessage(view) {
  const { status } = view.response;
  const m = view.response.metrics;
  const missing = m ? m.required_hours - m.placed_hours : 0;

  if (status === 'ok') {
    return message('ok', 'Horario completo',
      'Todas las horas del plan de estudios quedaron acomodadas sin cruces de profesores.');
  }
  if (status === 'partial') {
    return message('warning', `Horario al ${Math.round((m?.fill_rate || 0) * 100)} %`,
      `Quedaron ${missing} hora(s) sin acomodar. Abajo se explica exactamente cuáles y por qué; ` +
      'lo demás ya es un horario válido y utilizable.');
  }
  return message('error', 'Los datos no permiten generar un horario',
    'Hay que corregir los problemas señalados antes de volver a intentarlo.');
}

function message(kind, title, text) {
  const box = el('div', `cw-msg cw-msg--${kind}`);
  box.appendChild(el('b', null, title));
  box.appendChild(document.createTextNode(text));
  return box;
}

/** Tabla de tutores (resultado del emparejamiento previo al horario). */
export function renderTutorsPanel(view) {
  const wrap = el('div');
  const tutors = view.response.tutors || [];
  if (!tutors.length) {
    wrap.appendChild(el('div', 'cw-empty', 'Todavía no hay tutores asignados.'));
    return wrap;
  }

  const shared = tutors.filter((t) => t.shared).length;
  wrap.appendChild(message(
    shared ? 'warning' : 'info',
    shared ? 'Hay tutores compartidos' : 'Asignación 1 a 1',
    shared
      ? `${shared} grupo(s) comparten tutor porque no alcanzan los profesores elegibles. ` +
        'Se repartió priorizando a los de menor carga estimada.'
      : 'Cada grupo tiene un tutor exclusivo. La carga mostrada es la estimación usada para decidir ' +
        'el emparejamiento, antes de calcular el horario.',
  ));

  const table = el('table', 'cw-datatable');
  table.innerHTML =
    '<thead><tr><th>Grupo</th><th>Tutor</th><th>Carga estimada</th><th>Criterio</th></tr></thead>';
  const tbody = el('tbody');

  for (const tutor of tutors) {
    const group = view.groups.get(tutor.group_id);
    const teacher = tutor.teacher_id ? view.teachers.get(tutor.teacher_id) : null;
    const row = el('tr');
    row.appendChild(el('td', null, group ? groupLabel(group) : tutor.group_id));

    const nameCell = el('td');
    nameCell.appendChild(document.createTextNode(teacher?.name || '— sin tutor —'));
    if (tutor.shared) nameCell.appendChild(el('span', 'cw-tag cw-tag--shared', ' compartido'));
    row.appendChild(nameCell);

    row.appendChild(el('td', null, `${tutor.estimated_load} h`));
    row.appendChild(el('td', null, tutor.reason || '—'));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  const scroller = el('div', 'cw-scroll-x');
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  return wrap;
}

/** Cargas reales por profesor, con barra de utilización. */
export function renderLoadsPanel(view) {
  const loads = view.response.metrics?.teacher_load || {};
  const wrap = el('div');
  const table = el('table', 'cw-datatable');
  table.innerHTML =
    '<thead><tr><th>Profesor</th><th>Materias</th><th>Horas</th>' +
    '<th style="width:140px">Utilización</th><th>Horas muertas</th></tr></thead>';
  const tbody = el('tbody');

  const rows = Object.entries(loads).sort((a, b) => b[1].assigned - a[1].assigned);
  for (const [tid, load] of rows) {
    const teacher = view.teachers.get(tid);
    const row = el('tr');
    row.appendChild(el('td', null, teacher?.name || tid));
    row.appendChild(el('td', null, (teacher?.subject_ids || [])
      .map((s) => view.subjects.get(s)?.short_name || s).join(', ') || '—'));
    row.appendChild(el('td', null, `${load.assigned} / ${load.max}`));

    const barCell = el('td');
    const bar = el('div', load.utilization >= 0.98 ? 'cw-bar cw-bar--full' : 'cw-bar');
    const fill = el('i');
    fill.style.width = `${Math.min(100, Math.round(load.utilization * 100))}%`;
    bar.appendChild(fill);
    barCell.appendChild(bar);
    row.appendChild(barCell);

    row.appendChild(el('td', null, String(load.gaps)));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  const scroller = el('div', 'cw-scroll-x');
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  return wrap;
}

/** Avisos ordenados por gravedad, con el contexto de grupo/materia/profesor. */
export function renderConflictsPanel(view) {
  const wrap = el('div');
  const conflicts = [...(view.response.conflicts || [])];
  if (!conflicts.length) {
    wrap.appendChild(el('div', 'cw-empty', 'Sin avisos: los datos y el horario están limpios.'));
    return wrap;
  }

  const rank = { error: 0, warning: 1, info: 2 };
  conflicts.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));

  for (const conflict of conflicts) {
    const box = el('div', `cw-msg cw-msg--${conflict.severity}`);

    const context = [];
    if (conflict.group_id) {
      const group = view.groups.get(conflict.group_id);
      context.push(`Grupo ${group ? groupLabel(group) : conflict.group_id}`);
    }
    if (conflict.subject_id) context.push(view.subjects.get(conflict.subject_id)?.name || conflict.subject_id);
    if (conflict.teacher_id) context.push(view.teachers.get(conflict.teacher_id)?.name || conflict.teacher_id);

    box.appendChild(el('b', null,
      `${SEVERITY_LABEL[conflict.severity] || conflict.severity}${context.length ? ` · ${context.join(' · ')}` : ''}`));
    box.appendChild(document.createTextNode(conflict.message));
    box.appendChild(el('div', null, ''));
    box.appendChild(el('code', null, conflict.code));
    wrap.appendChild(box);
  }
  return wrap;
}
