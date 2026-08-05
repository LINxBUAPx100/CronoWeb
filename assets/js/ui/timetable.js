/**
 * Renderizado de la tabla de horario.
 *
 * `renderGroupTimetable()` construye la TARJETA EXPORTABLE completa (encabezado,
 * tabla, leyenda y marca de agua). Es exactamente el nodo que recibe html2canvas,
 * así que lo que se ve en pantalla es lo que sale en el PNG — sin una segunda
 * plantilla que se pueda desincronizar.
 *
 * Restricciones autoimpuestas para que la exportación sea fiel:
 *   · colores siempre en rgb()/rgba() calculados en JS (nada de color-mix/oklch)
 *   · nada de position:sticky ni transform dentro de la tarjeta
 *   · ancho fijo definido en CSS (.cw-card) para que el PNG no dependa del monitor
 *
 * @module ui/timetable
 */

const PALETTE = [
  '#2563eb', '#dc2626', '#059669', '#b45309', '#0891b2', '#7c3aed',
  '#db2777', '#65a30d', '#ea580c', '#475569', '#0f766e', '#9333ea',
];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** #rrggbb → {r,g,b}. Tolera formato corto (#rgb). */
function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return { r: 71, g: 85, b: 105 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const rgba = (hex, alpha) => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Construye una vista consolidada request+response. Se calcula UNA vez por
 * resultado y la comparten todos los renderizadores.
 */
export function createView(request, response) {
  const subjects = new Map();
  request.subjects.forEach((subject, i) => {
    subjects.set(subject.id, { ...subject, color: subject.color || PALETTE[i % PALETTE.length] });
  });

  return {
    request,
    response,
    days: request.grid.days,
    blocks: request.grid.blocks,
    subjects,
    teachers: new Map(request.teachers.map((t) => [t.id, t])),
    groups: new Map(request.groups.map((g) => [g.id, g])),
    tutorsByGroup: new Map((response.tutors || []).map((t) => [t.group_id, t])),
    branding: response.branding || { mode: 'simple', watermark_text: 'CronoWeb.com', watermark_required: true },
  };
}

const groupLabel = (group) => `${group.grade}${group.name}`;
const subjectShort = (subject) => subject.short_name || subject.name.slice(0, 6);

// --------------------------------------------------------------------------- //
// Encabezado y pie de la tarjeta
// --------------------------------------------------------------------------- //
function renderHead(view, { title, subtitle, aside }) {
  const { branding } = view;
  const accent = branding.mode === 'custom' ? branding.primary_color || '#0f766e' : '#0f766e';

  const head = el('div', 'cw-card__head');
  head.style.borderBottomColor = accent;

  if (branding.mode === 'custom' && branding.show_logo && branding.logo_data_url) {
    const logo = el('img', 'cw-card__logo');
    logo.src = branding.logo_data_url;
    logo.alt = '';
    head.appendChild(logo);
  }

  const titles = el('div', 'cw-card__titles');
  if (branding.mode === 'custom' && branding.school_name) {
    titles.appendChild(el('div', 'cw-card__school', branding.school_name));
  }
  const h = el('div', 'cw-card__title', title);
  h.style.color = branding.mode === 'custom' ? accent : '#0f172a';
  titles.appendChild(h);
  if (subtitle) titles.appendChild(el('div', 'cw-card__meta', subtitle));
  head.appendChild(titles);

  if (aside) {
    const box = el('div', 'cw-card__aside');
    aside.forEach(([label, value]) => {
      const line = el('div');
      line.appendChild(el('b', null, value));
      line.appendChild(document.createTextNode(label));
      box.appendChild(line);
    });
    head.appendChild(box);
  }
  return head;
}

function renderWatermark(view) {
  const { branding } = view;
  const mark = el('div', 'cw-watermark');
  // Marcado explícito: el exportador comprueba que este nodo exista antes de
  // rasterizar. La marca de agua es la regla de negocio, no un adorno.
  mark.setAttribute('data-cw-watermark', '1');

  if (branding.mode === 'custom') {
    mark.classList.add('cw-watermark--soft');
    mark.appendChild(el('b', null, `Hecho con ${branding.watermark_text || 'CronoWeb.com'}`));
  } else {
    mark.appendChild(el('b', null, branding.watermark_text || 'CronoWeb.com'));
    mark.appendChild(el('span', null, 'Horarios escolares automáticos'));
  }
  return mark;
}

function renderFoot(view, { legendSubjectIds = [], note = null } = {}) {
  const foot = el('div', 'cw-card__foot');
  const legend = el('div', 'cw-card__legend');

  for (const sid of legendSubjectIds) {
    const subject = view.subjects.get(sid);
    if (!subject) continue;
    const item = el('span');
    const swatch = el('i');
    swatch.style.backgroundColor = subject.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(`${subjectShort(subject)} · ${subject.name}`));
    legend.appendChild(item);
  }

  const left = el('div');
  left.style.flex = '1';
  left.appendChild(legend);
  if (note) left.appendChild(el('div', 'cw-card__note', note));
  foot.appendChild(left);
  foot.appendChild(renderWatermark(view));
  return foot;
}

// --------------------------------------------------------------------------- //
// Tabla
// --------------------------------------------------------------------------- //
/**
 * Cuerpo de la tabla. `cellFor(day, blockId)` devuelve
 * `{ subjectId, primary, secondary } | null`.
 */
function renderTable(view, cellFor) {
  const accent = view.branding.mode === 'custom'
    ? view.branding.primary_color || '#0f766e'
    : '#0f766e';

  const table = el('table', 'cw-timetable');

  const thead = el('thead');
  const headRow = el('tr');
  const corner = el('th', null, 'Hora');
  corner.style.backgroundColor = accent;
  headRow.appendChild(corner);
  for (const day of view.days) {
    const th = el('th', null, day);
    th.style.backgroundColor = accent;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const block of view.blocks) {
    const row = el('tr');

    // Los recesos ocupan una banda completa: son parte del horario que la escuela
    // publica, aunque nunca se les asigne clase.
    if (block.kind === 'break') {
      row.className = 'cw-break';
      const td = el('td', null, `${block.label} · ${block.start} – ${block.end}`);
      td.colSpan = view.days.length + 1;
      row.appendChild(td);
      tbody.appendChild(row);
      continue;
    }

    const hour = el('td', 'cw-hour');
    hour.appendChild(el('b', null, block.label));
    hour.appendChild(document.createTextNode(`${block.start}–${block.end}`));
    row.appendChild(hour);

    for (const day of view.days) {
      const data = cellFor(day, block.id);
      const td = el('td', 'cw-cell');
      if (!data) {
        td.classList.add('cw-cell--empty');
        row.appendChild(td);
        continue;
      }
      const subject = view.subjects.get(data.subjectId);
      const color = subject?.color || '#475569';
      // Tinte calculado en JS: html2canvas rasteriza rgba() de forma fiable.
      td.style.backgroundColor = rgba(color, 0.1);
      td.style.borderLeft = `3px solid ${color}`;

      const primary = el('div', 'cw-cell__subject', data.primary);
      primary.style.color = color;
      td.appendChild(primary);
      if (data.secondary) td.appendChild(el('div', 'cw-cell__teacher', data.secondary));
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

// --------------------------------------------------------------------------- //
// API pública
// --------------------------------------------------------------------------- //
/**
 * Renderiza el horario de UN grupo como tarjeta exportable.
 *
 * @param {object} view resultado de `createView`
 * @param {string} groupId
 * @returns {HTMLElement} nodo `.cw-card` listo para pantalla y para html2canvas
 */
export function renderGroupTimetable(view, groupId) {
  const group = view.groups.get(groupId);
  const matrix = view.response.by_group?.[groupId] || {};
  const tutor = view.tutorsByGroup.get(groupId);
  const tutorName = tutor?.teacher_id ? view.teachers.get(tutor.teacher_id)?.name : null;

  const card = el('figure', `cw-card cw-card--${view.branding.mode}`);
  card.dataset.exportName = `horario-${groupLabel(group)}`;
  card.dataset.groupId = groupId;

  const totalHours = group.curriculum.reduce((acc, c) => acc + c.weekly_hours, 0);
  const placed = Object.values(matrix).reduce((acc, day) => acc + Object.keys(day).length, 0);

  card.appendChild(renderHead(view, {
    title: `Horario ${groupLabel(group)}`,
    subtitle: [
      view.branding.cycle_label,
      group.shift ? `Turno ${group.shift}` : null,
      `${placed} de ${totalHours} h semanales`,
    ].filter(Boolean).join(' · '),
    aside: tutorName ? [['Tutor del grupo', tutorName]] : null,
  }));

  const used = new Set();
  card.appendChild(renderTable(view, (day, blockId) => {
    const cell = matrix[day]?.[blockId];
    if (!cell) return null;
    used.add(cell.subject_id);
    const subject = view.subjects.get(cell.subject_id);
    return {
      subjectId: cell.subject_id,
      primary: subject ? subjectShort(subject) : cell.subject_id,
      secondary: view.teachers.get(cell.teacher_id)?.name || cell.teacher_id,
    };
  }));

  card.appendChild(renderFoot(view, {
    legendSubjectIds: [...used],
    note: view.branding.mode === 'custom' ? view.branding.footer_note : null,
  }));
  return card;
}

/**
 * Renderiza el horario de UN profesor (misma tarjeta, otra perspectiva).
 * Es la vista que pide el docente y la que evita el 90 % de las quejas.
 */
export function renderTeacherTimetable(view, teacherId) {
  const teacher = view.teachers.get(teacherId);
  const matrix = view.response.by_teacher?.[teacherId] || {};
  const load = view.response.metrics?.teacher_load?.[teacherId];

  const card = el('figure', `cw-card cw-card--${view.branding.mode}`);
  card.dataset.exportName = `horario-${teacher.name.replace(/\s+/g, '-').toLowerCase()}`;
  card.dataset.teacherId = teacherId;

  const tutorOf = (view.response.tutors || [])
    .filter((t) => t.teacher_id === teacherId)
    .map((t) => groupLabel(view.groups.get(t.group_id)));

  card.appendChild(renderHead(view, {
    title: teacher.name,
    subtitle: [
      view.branding.cycle_label,
      tutorOf.length ? `Tutor de ${tutorOf.join(', ')}` : null,
    ].filter(Boolean).join(' · '),
    aside: load
      ? [['Horas asignadas', `${load.assigned}/${load.max}`], ['Horas muertas', String(load.gaps)]]
      : null,
  }));

  const used = new Set();
  card.appendChild(renderTable(view, (day, blockId) => {
    const cell = matrix[day]?.[blockId];
    if (!cell) return null;
    used.add(cell.subject_id);
    const subject = view.subjects.get(cell.subject_id);
    const group = view.groups.get(cell.group_id);
    return {
      subjectId: cell.subject_id,
      primary: subject ? subjectShort(subject) : cell.subject_id,
      secondary: group ? `Grupo ${groupLabel(group)}` : cell.group_id,
    };
  }));

  card.appendChild(renderFoot(view, { legendSubjectIds: [...used] }));
  return card;
}

export { groupLabel, subjectShort, rgba };
