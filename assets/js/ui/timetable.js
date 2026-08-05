/**
 * Renderizado de horarios.
 *
 * Cuatro vistas × dos formatos, todas construidas por la misma función:
 *
 *   VISTAS      grupo · profesor · materia · grado
 *   FORMATOS    técnico (para la dirección)  ·  alumnos (para pegar en el salón)
 *
 * El formato «técnico» es denso: abreviaturas, nombre del profesor, leyenda de
 * materias, tutor, conteo de horas. El formato «alumnos» es lo contrario: nombre
 * completo de la materia en grande, sin jerga, legible desde un metro de
 * distancia pegado en la puerta.
 *
 * Lo que se ve en pantalla ES el nodo que recibe html2canvas: no hay una segunda
 * plantilla de impresión que se pueda desincronizar.
 *
 * Restricciones autoimpuestas para que el PNG salga fiel: colores en rgb()/rgba()
 * calculados en JS (nada de color-mix/oklch), sin position:sticky ni transform
 * dentro de la tarjeta, y ancho de diseño fijo por tipo de vista.
 *
 * @module ui/timetable
 */

const PALETTE = [
  '#2563eb', '#dc2626', '#059669', '#b45309', '#0891b2', '#7c3aed',
  '#db2777', '#65a30d', '#ea580c', '#475569', '#0f766e', '#9333ea',
];

export const FORMATS = [
  { id: 'tecnico', label: 'Técnico', hint: 'Para la dirección: profesor, claves, leyenda y totales' },
  { id: 'alumnos', label: 'Para alumnos', hint: 'Letra grande, para imprimir y pegar en el salón' },
];

export const VIEW_TYPES = [
  { id: 'group', label: 'Por grupo' },
  { id: 'teacher', label: 'Por profesor' },
  { id: 'grade', label: 'Por grado' },
  { id: 'subject', label: 'Por materia' },
];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return { r: 71, g: 85, b: 105 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export const rgba = (hex, alpha) => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const groupLabel = (group) => `${group.grade}${group.name}`;
const subjectShort = (subject) => subject.short_name || subject.name.slice(0, 6);
const slug = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/** Vista consolidada request+response; se calcula una vez por resultado. */
export function createView(request, response) {
  const subjects = new Map();
  request.subjects.forEach((subject, i) => {
    subjects.set(subject.id, { ...subject, color: subject.color || PALETTE[i % PALETTE.length] });
  });

  const grades = new Map();
  for (const group of request.groups) {
    if (!grades.has(group.grade)) grades.set(group.grade, []);
    grades.get(group.grade).push(group);
  }

  return {
    request,
    response,
    days: request.grid.days,
    blocks: request.grid.blocks,
    subjects,
    teachers: new Map(request.teachers.map((t) => [t.id, t])),
    groups: new Map(request.groups.map((g) => [g.id, g])),
    grades,
    tutorsByGroup: new Map((response.tutors || []).map((t) => [t.group_id, t])),
    branding: response.branding || { mode: 'simple', watermark_text: 'CronoWeb.com', watermark_required: true },
  };
}

const accentOf = (view) =>
  (view.branding.mode === 'custom' ? view.branding.primary_color || '#0f766e' : '#0f766e');

// --------------------------------------------------------------------------- //
// Encabezado, pie y marca de agua
// --------------------------------------------------------------------------- //
function renderHead(view, { title, subtitle, aside, format }) {
  const accent = accentOf(view);
  const head = el('div', 'cw-card__head');
  head.style.borderBottomColor = accent;

  if (view.branding.mode === 'custom' && view.branding.show_logo && view.branding.logo_data_url) {
    const logo = el('img', 'cw-card__logo');
    logo.src = view.branding.logo_data_url;
    logo.alt = '';
    head.appendChild(logo);
  }

  const titles = el('div', 'cw-card__titles');
  if (view.branding.mode === 'custom' && view.branding.school_name) {
    titles.appendChild(el('div', 'cw-card__school', view.branding.school_name));
  }
  const heading = el('div', 'cw-card__title', title);
  heading.style.color = view.branding.mode === 'custom' ? accent : '#0f172a';
  titles.appendChild(heading);
  if (subtitle) titles.appendChild(el('div', 'cw-card__meta', subtitle));
  head.appendChild(titles);

  // El bloque de datos técnicos no existe en el formato para alumnos.
  if (aside && format === 'tecnico') {
    const box = el('div', 'cw-card__aside');
    for (const [label, value] of aside) {
      const line = el('div');
      line.appendChild(el('b', null, value));
      line.appendChild(document.createTextNode(label));
      box.appendChild(line);
    }
    head.appendChild(box);
  }
  return head;
}

function renderWatermark(view, format) {
  const mark = el('div', 'cw-watermark');
  // El exportador verifica este nodo antes de rasterizar: la marca de agua es
  // regla de negocio del modo simple, no un adorno.
  mark.setAttribute('data-cw-watermark', '1');

  if (view.branding.mode === 'custom') {
    mark.classList.add('cw-watermark--soft');
    mark.appendChild(el('b', null, `Hecho con ${view.branding.watermark_text || 'CronoWeb.com'}`));
    return mark;
  }
  mark.appendChild(el('b', null, view.branding.watermark_text || 'CronoWeb.com'));
  if (format === 'tecnico') mark.appendChild(el('span', null, 'Horarios escolares automáticos'));
  return mark;
}

function renderFoot(view, { legendSubjectIds = [], note = null, format = 'tecnico' } = {}) {
  const foot = el('div', 'cw-card__foot');
  const left = el('div');
  left.style.flex = '1';

  // La leyenda de abreviaturas sólo tiene sentido si se usaron abreviaturas.
  if (format === 'tecnico' && legendSubjectIds.length) {
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
    left.appendChild(legend);
  }
  if (note) left.appendChild(el('div', 'cw-card__note', note));

  foot.appendChild(left);
  foot.appendChild(renderWatermark(view, format));
  return foot;
}

// --------------------------------------------------------------------------- //
// Tabla
// --------------------------------------------------------------------------- //
/**
 * Tabla genérica día × bloque.
 *
 * @param {Function} cellFor `(day, blockId) => Cell | Cell[] | null`
 *        Cell = `{subjectId, primary, secondary}`
 * @param {{format:string, columns?:Array}} config
 *        `columns` permite subdividir cada día (vista por grado): cada columna es
 *        `{key, label}` y `cellFor` recibe también la columna.
 */
function renderTable(view, cellFor, { format, columns = null }) {
  const accent = accentOf(view);
  const table = el('table', `cw-timetable cw-timetable--${format}`);
  const perDay = columns?.length || 1;

  const thead = el('thead');
  const headRow = el('tr');
  const corner = el('th', null, 'Hora');
  corner.style.backgroundColor = accent;
  if (columns) corner.rowSpan = 2;
  headRow.appendChild(corner);

  for (const day of view.days) {
    const th = el('th', null, day);
    th.style.backgroundColor = accent;
    if (columns) th.colSpan = perDay;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  if (columns) {
    const subRow = el('tr');
    for (const _day of view.days) {
      for (const column of columns) {
        const th = el('th', 'cw-subhead', column.label);
        th.style.backgroundColor = accent;
        subRow.appendChild(th);
      }
    }
    thead.appendChild(subRow);
  }
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const block of view.blocks) {
    const row = el('tr');

    if (block.kind === 'break') {
      row.className = 'cw-break';
      const td = el('td', null, `${block.label} · ${block.start} – ${block.end}`);
      td.colSpan = view.days.length * perDay + 1;
      row.appendChild(td);
      tbody.appendChild(row);
      continue;
    }

    const hour = el('td', 'cw-hour');
    hour.appendChild(el('b', null, block.label));
    hour.appendChild(document.createTextNode(`${block.start}–${block.end}`));
    row.appendChild(hour);

    for (const day of view.days) {
      for (const column of columns || [null]) {
        const raw = cellFor(day, block.id, column);
        const cells = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
        row.appendChild(renderCell(view, cells, format));
      }
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

function renderCell(view, cells, format) {
  const td = el('td', 'cw-cell');
  if (!cells.length) {
    td.classList.add('cw-cell--empty');
    if (format === 'alumnos') td.textContent = '—';
    return td;
  }

  // Una celda puede llevar varias entradas en la vista por materia (varios grupos
  // toman la misma materia a la misma hora, con distintos profesores).
  const color = view.subjects.get(cells[0].subjectId)?.color || '#475569';
  td.style.backgroundColor = rgba(color, format === 'alumnos' ? 0.16 : 0.1);
  td.style.borderLeft = `${format === 'alumnos' ? 4 : 3}px solid ${color}`;

  for (const cell of cells) {
    const cellColor = view.subjects.get(cell.subjectId)?.color || color;
    const primary = el('div', 'cw-cell__subject', cell.primary);
    primary.style.color = cellColor;
    td.appendChild(primary);
    if (cell.secondary) td.appendChild(el('div', 'cw-cell__teacher', cell.secondary));
  }
  return td;
}

// --------------------------------------------------------------------------- //
// API pública
// --------------------------------------------------------------------------- //
/**
 * Construye la tarjeta exportable de cualquier vista.
 *
 * @param {object} view resultado de `createView`
 * @param {{type:'group'|'teacher'|'grade'|'subject', id:string, format?:'tecnico'|'alumnos'}} spec
 * @returns {HTMLElement} nodo `.cw-card`
 */
export function renderTimetableCard(view, spec) {
  const format = spec.format === 'alumnos' ? 'alumnos' : 'tecnico';
  const builders = {
    group: buildGroupCard, teacher: buildTeacherCard, grade: buildGradeCard, subject: buildSubjectCard,
  };
  const builder = builders[spec.type] || buildGroupCard;

  const parts = builder(view, spec.id, format);
  const wide = spec.type === 'grade' || (spec.type === 'subject' && view.groups.size > 4);

  const card = el('figure', `cw-card cw-card--${view.branding.mode} cw-card--${format}${wide ? ' cw-card--wide' : ''}`);
  card.dataset.exportName = parts.filename;
  card.dataset.viewType = spec.type;
  card.dataset.viewId = spec.id;
  card.dataset.format = format;

  card.appendChild(renderHead(view, { ...parts.head, format }));
  card.appendChild(parts.table);
  card.appendChild(renderFoot(view, {
    legendSubjectIds: parts.legend || [],
    note: view.branding.mode === 'custom' ? view.branding.footer_note : null,
    format,
  }));
  return card;
}

// ── Grupo ─────────────────────────────────────────────────────────────────── //
function buildGroupCard(view, groupId, format) {
  const group = view.groups.get(groupId);
  const matrix = view.response.by_group?.[groupId] || {};
  const tutor = view.tutorsByGroup.get(groupId);
  const tutorName = tutor?.teacher_id ? view.teachers.get(tutor.teacher_id)?.name : null;

  const total = group.curriculum.reduce((acc, c) => acc + c.weekly_hours, 0);
  const placed = Object.values(matrix).reduce((acc, day) => acc + Object.keys(day).length, 0);
  const used = new Set();

  const table = renderTable(view, (day, blockId) => {
    const cell = matrix[day]?.[blockId];
    if (!cell) return null;
    used.add(cell.subject_id);
    const subject = view.subjects.get(cell.subject_id);
    return {
      subjectId: cell.subject_id,
      primary: format === 'alumnos' ? (subject?.name || cell.subject_id) : subjectShort(subject || {}),
      secondary: view.teachers.get(cell.teacher_id)?.name || cell.teacher_id,
    };
  }, { format });

  return {
    filename: `horario-grupo-${slug(groupLabel(group))}-${format}`,
    legend: [...used],
    table,
    head: {
      title: format === 'alumnos' ? `Grupo ${groupLabel(group)}` : `Horario ${groupLabel(group)}`,
      subtitle: format === 'alumnos'
        ? [view.branding.cycle_label, tutorName && `Tutor: ${tutorName}`].filter(Boolean).join(' · ')
        : [view.branding.cycle_label, group.shift && `Turno ${group.shift}`,
          `${placed} de ${total} h semanales`].filter(Boolean).join(' · '),
      aside: tutorName ? [['Tutor del grupo', tutorName]] : null,
    },
  };
}

// ── Profesor ──────────────────────────────────────────────────────────────── //
function buildTeacherCard(view, teacherId, format) {
  const teacher = view.teachers.get(teacherId);
  const matrix = view.response.by_teacher?.[teacherId] || {};
  const load = view.response.metrics?.teacher_load?.[teacherId];
  const used = new Set();

  const tutorOf = (view.response.tutors || [])
    .filter((t) => t.teacher_id === teacherId)
    .map((t) => groupLabel(view.groups.get(t.group_id)));

  const table = renderTable(view, (day, blockId) => {
    const cell = matrix[day]?.[blockId];
    if (!cell) return null;
    used.add(cell.subject_id);
    const subject = view.subjects.get(cell.subject_id);
    const group = view.groups.get(cell.group_id);
    return {
      subjectId: cell.subject_id,
      primary: format === 'alumnos' ? (subject?.name || cell.subject_id) : subjectShort(subject || {}),
      secondary: group ? `Grupo ${groupLabel(group)}` : cell.group_id,
    };
  }, { format });

  return {
    filename: `horario-profesor-${slug(teacher.name)}-${format}`,
    legend: [...used],
    table,
    head: {
      title: teacher.name,
      subtitle: [
        view.branding.cycle_label,
        tutorOf.length ? `Tutor de ${tutorOf.join(', ')}` : null,
      ].filter(Boolean).join(' · '),
      aside: load
        ? [['Horas asignadas', `${load.assigned}/${load.max}`], ['Horas muertas', String(load.gaps)]]
        : null,
    },
  };
}

// ── Grado (todos sus grupos en una sola hoja) ─────────────────────────────── //
function buildGradeCard(view, gradeName, format) {
  const groups = (view.grades.get(gradeName) || []).slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const columns = groups.map((group) => ({ key: group.id, label: group.name }));
  const used = new Set();

  const table = renderTable(view, (day, blockId, column) => {
    const cell = view.response.by_group?.[column.key]?.[day]?.[blockId];
    if (!cell) return null;
    used.add(cell.subject_id);
    const subject = view.subjects.get(cell.subject_id);
    return {
      subjectId: cell.subject_id,
      primary: subjectShort(subject || {}),
      // Con varios grupos por día el nombre completo no cabe: en ambos formatos
      // se usa abreviatura, y el profesor sólo en el técnico.
      secondary: format === 'tecnico'
        ? (view.teachers.get(cell.teacher_id)?.name || cell.teacher_id)
        : null,
    };
  }, { format, columns });

  const tutors = groups
    .map((group) => {
      const tutor = view.tutorsByGroup.get(group.id);
      const name = tutor?.teacher_id ? view.teachers.get(tutor.teacher_id)?.name : null;
      return name ? `${groupLabel(group)}: ${name}` : null;
    })
    .filter(Boolean);

  return {
    filename: `horario-grado-${slug(gradeName)}-${format}`,
    legend: [...used],
    table,
    head: {
      title: `Grado ${gradeName}`,
      subtitle: [view.branding.cycle_label, `${groups.length} grupo(s)`,
        tutors.length ? `Tutores — ${tutors.join(' · ')}` : null].filter(Boolean).join(' · '),
      aside: [['Grupos', String(groups.length)]],
    },
  };
}

// ── Materia (dónde y con quién se imparte en toda la escuela) ─────────────── //
function buildSubjectCard(view, subjectId, format) {
  const subject = view.subjects.get(subjectId);
  const byGroup = view.response.by_group || {};
  let hours = 0;
  const teachersUsed = new Set();

  const table = renderTable(view, (day, blockId) => {
    const cells = [];
    for (const [groupId, matrix] of Object.entries(byGroup)) {
      const cell = matrix?.[day]?.[blockId];
      if (!cell || cell.subject_id !== subjectId) continue;
      const group = view.groups.get(groupId);
      const teacherName = view.teachers.get(cell.teacher_id)?.name || cell.teacher_id;
      teachersUsed.add(cell.teacher_id);
      hours += 1;
      cells.push({
        subjectId,
        primary: group ? groupLabel(group) : groupId,
        secondary: format === 'tecnico' ? teacherName : null,
      });
    }
    return cells.length ? cells : null;
  }, { format });

  return {
    filename: `horario-materia-${slug(subject?.name || subjectId)}-${format}`,
    legend: [],
    table,
    head: {
      title: subject?.name || subjectId,
      subtitle: [view.branding.cycle_label,
        `${hours} h a la semana en toda la escuela`].filter(Boolean).join(' · '),
      aside: [['Horas', String(hours)], ['Profesores', String(teachersUsed.size)]],
    },
  };
}

/** Lista de elementos exportables de un tipo de vista, en orden de presentación. */
export function listTargets(view, type) {
  if (type === 'teacher') {
    return view.request.teachers
      .filter((t) => (view.response.metrics?.teacher_load?.[t.id]?.assigned || 0) > 0)
      .map((t) => ({ id: t.id, label: t.name }));
  }
  if (type === 'grade') {
    return [...view.grades.keys()].sort().map((grade) => ({ id: grade, label: `Grado ${grade}` }));
  }
  if (type === 'subject') {
    const scheduled = new Set((view.response.assignments || []).map((a) => a.subject_id));
    return view.request.subjects
      .filter((s) => scheduled.has(s.id))
      .map((s) => ({ id: s.id, label: s.name }));
  }
  return view.request.groups.map((g) => ({ id: g.id, label: `Grupo ${groupLabel(g)}` }));
}
