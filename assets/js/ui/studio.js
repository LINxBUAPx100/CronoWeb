/**
 * Pantallas de captura ("estudio"). Aquí la escuela llena todo con formularios:
 * horario, materias, profesores, grados y grupos. No hay JSON a la vista.
 *
 * Regla de re-render que evita el bug clásico de perder el foco al escribir:
 * los campos de texto y número mutan el modelo SIN redibujar; sólo los cambios
 * estructurales (agregar/quitar filas, marcar casillas que afectan a otra parte)
 * disparan un redibujado de la pantalla. Cada pantalla se construye de cero al
 * entrar, así que nunca queda información vieja.
 *
 * @module ui/studio
 */

import {
  allGroups, buildBlocks, createGrade, createSubject, createTeacher, DAY_PRESETS,
  PALETTE, removeSubject, removeTeacher, syncPlans, weeklyCapacity,
} from '../model/school.js';
import { abbreviate, shortDay } from '../model/serialize.js';
import { button, checkbox, clear, field, h, iconButton, input, mount, select } from './dom.js';

export const SCREENS = [
  { id: 'horario', label: 'Horario', hint: 'Días, hora de inicio y duración' },
  { id: 'materias', label: 'Materias', hint: 'Nombre, color y prioridad' },
  { id: 'profesores', label: 'Profesores', hint: 'Materias, carga y disponibilidad' },
  { id: 'grupos', label: 'Grados y grupos', hint: 'Plan de estudios por grado' },
];

/**
 * @param {HTMLElement} container
 * @param {{model:object, screen:string, save:Function, rerender:Function}} ctx
 */
export function renderStudio(container, ctx) {
  const screens = {
    horario: screenHorario,
    materias: screenMaterias,
    profesores: screenProfesores,
    grupos: screenGrupos,
  };
  mount(container, (screens[ctx.screen] || screenHorario)(ctx));
}

const sectionTitle = (title, description, action) =>
  h('div.cw-section-head',
    h('div', h('h3', title), description && h('p', description)),
    action);

// =========================================================================== //
// 1 · Horario
// =========================================================================== //
function screenHorario(ctx) {
  const { model, save } = ctx;
  const preview = h('div.cw-grid-preview');

  const refresh = () => mount(preview, gridPreview(model));

  const dayToggles = h('div.cw-daygrid',
    DAY_PRESETS['lun-sab'].map((day) => {
      const active = model.time.days.includes(day);
      return button(day.slice(0, 3), () => {
        const set = new Set(model.time.days);
        if (set.has(day)) set.delete(day);
        else set.add(day);
        // Se conserva el orden natural de la semana, no el de los clics.
        model.time.days = DAY_PRESETS['lun-sab'].filter((d) => set.has(d));
        save();
        ctx.rerender();
      }, `cw-chip${active ? ' cw-chip--on' : ''}`);
    }));

  const breaksBox = h('div');
  const renderBreaks = () => {
    mount(breaksBox,
      model.time.breaks.map((pause, i) => h('div.cw-break-row',
        h('span', 'Después de la clase'),
        input('number', pause.afterClass, (v) => { pause.afterClass = v; save(); refresh(); },
          { min: 1, max: model.time.classesPerDay - 1, class: 'cw-narrow' }),
        h('span', 'durante'),
        input('number', pause.minutes, (v) => { pause.minutes = v; save(); refresh(); },
          { min: 5, max: 90, step: 5, class: 'cw-narrow' }),
        h('span', 'min ·'),
        input('text', pause.label, (v) => { pause.label = v; save(); }, { class: 'cw-mid' }),
        iconButton('✕', 'Quitar receso', () => {
          model.time.breaks.splice(i, 1);
          save(); renderBreaks(); refresh();
        }))),
      model.time.breaks.length === 0 && h('p.cw-hint', 'Sin recesos. Agrega uno si tu escuela tiene receso.'));
  };
  renderBreaks();

  const form = h('div.cw-form-grid',
    field('Nombre de la escuela',
      input('text', model.school.name, (v) => { model.school.name = v; save(); },
        { placeholder: 'Escuela Secundaria General N.º 12' }),
      'Aparece en los horarios del modo personalizado.'),
    field('Ciclo escolar',
      input('text', model.school.cycle, (v) => { model.school.cycle = v; save(); },
        { placeholder: 'Ciclo 2026-2027' })),
    field('Hora de inicio',
      input('time', model.time.startTime, (v) => { model.time.startTime = v; save(); refresh(); })),
    field('Duración de cada clase',
      input('number', model.time.classMinutes, (v) => { model.time.classMinutes = v; save(); refresh(); },
        { min: 20, max: 180, step: 5 }),
      'En minutos. Lo estándar es 60.'),
    field('Clases por día',
      input('number', model.time.classesPerDay, (v) => {
        model.time.classesPerDay = v; save(); refresh();
      }, { min: 1, max: 16 })),
  );

  return h('div',
    sectionTitle('Horario de la escuela',
      'Con estos datos CronoWeb calcula solo las horas de cada clase.'),
    form,
    h('div.cw-subsection',
      h('h4', 'Días de clase'),
      dayToggles),
    h('div.cw-subsection',
      h('h4', 'Recesos'),
      breaksBox,
      button('+ Agregar receso', () => {
        model.time.breaks.push({ afterClass: Math.ceil(model.time.classesPerDay / 2), minutes: 20, label: 'Receso' });
        save(); renderBreaks(); refresh();
      }, 'cw-btn cw-btn--sm')),
    h('div.cw-subsection',
      h('h4', 'Así queda la jornada'),
      (refresh(), preview)),
  );
}

function gridPreview(model) {
  const { blocks, endTime } = buildBlocks(model.time);
  const capacity = weeklyCapacity(model);

  // La jornada como una franja continua en vez de una caja por bloque: se lee de
  // un vistazo y ocupa una fracción del espacio.
  return h('div',
    h('div.cw-timeline',
      blocks.map((block) => h('div', { class: `cw-timeline__seg${block.kind === 'break' ? ' is-break' : ''}` },
        h('b', block.kind === 'break' ? block.label : block.label.replace('a', '')),
        h('span', block.start)))),
    h('p.cw-hint',
      `De ${model.time.startTime} a ${endTime}. Cada grupo tiene ${capacity} espacios ` +
      `a la semana (${model.time.classesPerDay} clases × ${model.time.days.length} días).`));
}

// =========================================================================== //
// 2 · Materias
// =========================================================================== //
function screenMaterias(ctx) {
  const { model, save } = ctx;

  const rows = model.subjects.map((subject) => {
    const swatch = h('span.cw-swatch', { style: { backgroundColor: subject.color } });

    return h('tr',
      h('td',
        input('text', subject.name, (v) => { subject.name = v; save(); },
          { placeholder: 'Matemáticas' })),
      h('td',
        input('text', subject.short, (v) => { subject.short = v; save(); },
          { placeholder: abbreviate(subject.name), class: 'cw-narrow' })),
      h('td',
        h('div.cw-color-cell',
          swatch,
          input('color', subject.color, (v) => {
            subject.color = v;
            swatch.style.backgroundColor = v;
            save();
          }),
          h('div.cw-palette',
            PALETTE.slice(0, 8).map((color) => h('button', {
              type: 'button',
              class: 'cw-palette__dot',
              title: color,
              style: { backgroundColor: color },
              onClick: () => { subject.color = color; swatch.style.backgroundColor = color; save(); ctx.rerender(); },
            }))))),
      h('td', { style: { textAlign: 'center' } },
        checkbox(subject.prefersMorning, (v) => { subject.prefersMorning = v; save(); })),
      h('td',
        iconButton('✕', `Eliminar ${subject.name || 'materia'}`, () => {
          if (!confirm(`¿Eliminar ${subject.name || 'esta materia'}? Se quitará de todos los planes de estudio.`)) return;
          removeSubject(model, subject.id);
          save(); ctx.rerender();
        })),
    );
  });

  const table = h('table.cw-datatable.cw-editable',
    h('thead', h('tr',
      h('th', 'Materia'),
      h('th', { style: { width: '110px' } }, 'Abreviatura'),
      h('th', { style: { width: '190px' } }, 'Color'),
      h('th', { style: { width: '110px', textAlign: 'center' } }, 'De mañana'),
      h('th', { style: { width: '44px' } }, ''))),
    h('tbody', rows.length ? rows : h('tr', h('td', { colSpan: 5 },
      h('div.cw-empty', 'Agrega la primera materia para empezar.')))));

  return h('div',
    sectionTitle('Materias', 'La abreviatura es lo que se ve en cada celda del horario impreso.',
      button('+ Agregar materia', () => {
        model.subjects.push(createSubject(model));
        syncPlans(model);
        save(); ctx.rerender();
      }, 'cw-btn cw-btn--primary cw-btn--sm')),
    h('div.cw-scroll-x', table),
    h('p.cw-hint',
      'Marca «De mañana» en las materias que conviene dar temprano (Matemáticas, Español…): ' +
      'CronoWeb intentará colocarlas en los primeros bloques.'),
    model.subjects.length > 0 && button('Cargar materias comunes de secundaria', () => {
      addCommonSubjects(model);
      save(); ctx.rerender();
    }, 'cw-btn cw-btn--sm'));
}

const COMMON_SUBJECTS = [
  ['Español', 'Esp', true], ['Matemáticas', 'Mat', true], ['Ciencias', 'Cie', true],
  ['Historia', 'His', false], ['Geografía', 'Geo', false], ['Formación Cívica y Ética', 'FCyE', false],
  ['Inglés', 'Ing', false], ['Educación Física', 'EdFís', false], ['Artes', 'Art', false],
  ['Tecnología', 'Tec', false], ['Tutoría', 'Tut', false],
];

function addCommonSubjects(model) {
  const existing = new Set(model.subjects.map((s) => s.name.trim().toLowerCase()));
  for (const [name, short, morning] of COMMON_SUBJECTS) {
    if (existing.has(name.toLowerCase())) continue;
    const subject = createSubject(model, name);
    subject.short = short;
    subject.prefersMorning = morning;
    model.subjects.push(subject);
  }
  syncPlans(model);
}

// =========================================================================== //
// 3 · Profesores
// =========================================================================== //
function screenProfesores(ctx) {
  const { model, save } = ctx;
  const { blocks } = buildBlocks(model.time);
  const classBlocks = blocks.filter((b) => b.kind === 'class');
  const capacity = classBlocks.length * model.time.days.length;

  const list = h('div.cw-list',
    model.teachers.map((teacher) => teacherRow(ctx, teacher, classBlocks, capacity)));

  return h('div',
    sectionTitle('Profesores',
      'Marca qué materias imparte cada quien y bloquea las horas en que no puede estar.',
      button('+ Agregar profesor', () => {
        model.teachers.push(createTeacher(model));
        save(); ctx.rerender();
      }, 'cw-btn cw-btn--primary cw-btn--sm')),
    model.teachers.length
      ? list
      : h('div.cw-empty', 'Agrega al primer profesor para continuar.'));
}

function teacherRow(ctx, teacher, classBlocks, capacity) {
  const { model, save } = ctx;
  const body = h('div.cw-row__detail', { hidden: !teacher._open });

  const blockedCount = teacher.blocked.length;
  const caret = h('span.cw-caret', teacher._open ? '▾' : '▸');

  const item = h('div', { class: `cw-list__item${teacher._open ? ' is-open' : ''}` });

  const summary = h('div.cw-row',
    h('button.cw-row__toggle', {
      type: 'button',
      title: 'Ver u ocultar el detalle',
      onClick: () => {
        teacher._open = !teacher._open;
        // El detalle se construye la primera vez que se abre. Con 200 profesores,
        // pintar de entrada todas las cuadrículas serían ~8000 nodos inútiles.
        if (teacher._open && !body.dataset.built) buildDetail();
        body.hidden = !teacher._open;
        caret.textContent = teacher._open ? '▾' : '▸';
        item.classList.toggle('is-open', teacher._open);
      },
    }, caret),
    input('text', teacher.name, (v) => { teacher.name = v; save(); },
      { placeholder: 'Nombre del profesor', class: 'cw-teacher-name' }),
    h('div.cw-row__meta',
      h('span.cw-tag', `${teacher.subjectIds.length} materia(s)`),
      h('span.cw-tag', `${teacher.maxWeekly} h/semana`),
      blockedCount
        ? h('span.cw-tag.cw-tag--shared', `${blockedCount} h bloqueadas`)
        : h('span.cw-tag', 'sin restricciones'),
      teacher.canBeTutor ? null : h('span.cw-tag', 'no tutor')),
    iconButton('✕', `Eliminar ${teacher.name || 'profesor'}`, () => {
      if (!confirm(`¿Eliminar a ${teacher.name || 'este profesor'}?`)) return;
      removeTeacher(model, teacher.id);
      save(); ctx.rerender();
    }));

  // ── Detalle (se construye la primera vez que se abre la fila) ─────────
  function buildDetail() {
    body.dataset.built = '1';

    const subjectPicker = h('div.cw-chips',
      model.subjects.length
        ? model.subjects.map((subject) => {
          const on = teacher.subjectIds.includes(subject.id);
          return h('button', {
            type: 'button',
            class: `cw-chip${on ? ' cw-chip--on' : ''}`,
            style: on ? { borderColor: subject.color, color: subject.color } : null,
            onClick: (event) => {
              const idx = teacher.subjectIds.indexOf(subject.id);
              if (idx >= 0) teacher.subjectIds.splice(idx, 1);
              else teacher.subjectIds.push(subject.id);
              save();
              const active = teacher.subjectIds.includes(subject.id);
              event.currentTarget.classList.toggle('cw-chip--on', active);
              event.currentTarget.style.borderColor = active ? subject.color : '';
              event.currentTarget.style.color = active ? subject.color : '';
              summary.querySelector('.cw-tag').textContent = `${teacher.subjectIds.length} materia(s)`;
            },
          }, subject.name || 'Sin nombre');
        })
        : h('p.cw-hint', 'Primero captura las materias.'));

    const loadRow = h('div.cw-form-grid.cw-form-grid--3',
      field('Horas máximas por semana',
        input('number', teacher.maxWeekly, (v) => { teacher.maxWeekly = v; save(); }, { min: 0, max: 80 }),
        `El grupo completo son ${capacity} h.`),
      field('Horas máximas por día',
        input('number', teacher.maxDaily ?? '', (v) => { teacher.maxDaily = v || null; save(); },
          { min: 0, max: 16, placeholder: `Sin tope (${classBlocks.length})` })),
      field('Puede ser tutor de grupo',
        h('div', checkbox(teacher.canBeTutor, (v) => { teacher.canBeTutor = v; save(); ctx.rerender(); },
          'Sí, puede ser tutor'))));

    mount(body,
      h('div.cw-subsection', h('h4', 'Materias que imparte'), subjectPicker),
      h('div.cw-subsection', loadRow),
      h('div.cw-subsection',
        h('h4', 'Disponibilidad'),
        h('p.cw-hint', 'Haz clic en las horas en que NO puede dar clase (otro trabajo, comisión, etc.).'),
        availabilityGrid(ctx, teacher, classBlocks, summary)),
      h('div.cw-subsection',
        field('Nota interna',
          input('text', teacher.notes, (v) => { teacher.notes = v; save(); },
            { placeholder: 'Trabaja en otra escuela los viernes' }))));
  }

  if (teacher._open) buildDetail();

  item.appendChild(summary);
  item.appendChild(body);
  return item;
}

/** Cuadrícula clicable de horas bloqueadas (días × bloques). */
function availabilityGrid(ctx, teacher, classBlocks, summary) {
  const { model, save } = ctx;
  const blocked = new Set(teacher.blocked);

  const updateSummary = () => {
    teacher.blocked = [...blocked];
    save();
    const tag = summary.querySelectorAll('.cw-tag')[2];
    if (tag) {
      tag.textContent = blocked.size ? `${blocked.size} h bloqueadas` : 'sin restricciones';
      tag.className = blocked.size ? 'cw-tag cw-tag--shared' : 'cw-tag';
    }
  };

  const cellFor = (dayIndex, block) => {
    const key = `${dayIndex}|${block.id}`;
    const cell = h('button', {
      type: 'button',
      class: `cw-avail${blocked.has(key) ? ' is-blocked' : ''}`,
      title: `${model.time.days[dayIndex]} ${block.start}`,
      onClick: () => {
        if (blocked.has(key)) blocked.delete(key);
        else blocked.add(key);
        cell.classList.toggle('is-blocked', blocked.has(key));
        updateSummary();
      },
    }, blocked.has(key) ? '✕' : '');
    return cell;
  };

  const table = h('table.cw-avail-grid',
    h('thead', h('tr',
      h('th', ''),
      model.time.days.map((day, dayIndex) => h('th',
        h('button', {
          type: 'button', class: 'cw-linkish', title: `Bloquear/liberar todo el ${day}`,
          onClick: () => {
            const keys = classBlocks.map((b) => `${dayIndex}|${b.id}`);
            const allBlocked = keys.every((k) => blocked.has(k));
            keys.forEach((k) => (allBlocked ? blocked.delete(k) : blocked.add(k)));
            updateSummary();
            redraw();
          },
        }, shortDay(day)))))),
    h('tbody'));

  const redraw = () => {
    const tbody = table.querySelector('tbody');
    clear(tbody);
    for (const block of classBlocks) {
      tbody.appendChild(h('tr',
        h('th',
          h('button', {
            type: 'button', class: 'cw-linkish', title: 'Bloquear/liberar esta hora toda la semana',
            onClick: () => {
              const keys = model.time.days.map((_, i) => `${i}|${block.id}`);
              const allBlocked = keys.every((k) => blocked.has(k));
              keys.forEach((k) => (allBlocked ? blocked.delete(k) : blocked.add(k)));
              updateSummary();
              redraw();
            },
          }, block.start)),
        model.time.days.map((_, dayIndex) => h('td', cellFor(dayIndex, block)))));
    }
  };
  redraw();

  return h('div',
    h('div.cw-scroll-x', table),
    h('div.cw-avail-actions',
      button('Liberar todo', () => { blocked.clear(); updateSummary(); redraw(); }, 'cw-btn cw-btn--sm'),
      button('Bloquear todo', () => {
        model.time.days.forEach((_, i) => classBlocks.forEach((b) => blocked.add(`${i}|${b.id}`)));
        updateSummary(); redraw();
      }, 'cw-btn cw-btn--sm')));
}

// =========================================================================== //
// 4 · Grados y grupos
// =========================================================================== //
function screenGrupos(ctx) {
  const { model, save } = ctx;
  syncPlans(model);

  return h('div',
    sectionTitle('Grados y grupos',
      'El plan de estudios se captura una vez por grado y aplica a todos sus grupos.',
      button('+ Agregar grado', () => {
        const grade = createGrade(model, String(model.grades.length + 1));
        model.grades.push(grade);
        save(); ctx.rerender();
      }, 'cw-btn cw-btn--primary cw-btn--sm')),
    model.grades.length
      ? model.grades.map((grade) => gradeCard(ctx, grade))
      : h('div.cw-empty', 'Agrega el primer grado (1°, 2°, 3°…).'));
}

function gradeCard(ctx, grade) {
  const { model, save } = ctx;
  const capacity = weeklyCapacity(model);
  const totalTag = h('span.cw-tag');

  const refreshTotal = () => {
    const total = grade.plan.reduce((acc, entry) => acc + (Number(entry.hours) || 0), 0);
    totalTag.textContent = `${total} de ${capacity} h`;
    totalTag.className = total > capacity ? 'cw-tag cw-tag--danger'
      : total === 0 ? 'cw-tag' : 'cw-tag cw-tag--ok';
  };

  // ── Grupos del grado ──────────────────────────────────────────────────
  const groupsBox = h('div.cw-chips');
  const renderGroups = () => {
    mount(groupsBox,
      grade.groups.map((group, i) => h('span.cw-chip.cw-chip--group',
        input('text', group.name, (v) => { group.name = v.toUpperCase(); save(); },
          { class: 'cw-chip-input', maxlength: 3 }),
        iconButton('✕', 'Quitar grupo', () => {
          grade.groups.splice(i, 1);
          save(); renderGroups();
        }, 'cw-icon-btn cw-icon-btn--tiny'))),
      button('+ Grupo', () => {
        const letters = 'ABCDEFGHIJKL';
        const used = new Set(grade.groups.map((g) => g.name));
        const next = [...letters].find((l) => !used.has(l)) || String(grade.groups.length + 1);
        grade.groups.push({ name: next, blockedSlots: [] });
        save(); renderGroups();
      }, 'cw-btn cw-btn--sm'));
  };
  renderGroups();

  // ── Plan de estudios ──────────────────────────────────────────────────
  const planRows = model.subjects.map((subject) => {
    const entry = grade.plan.find((e) => e.subjectId === subject.id);
    return h('tr',
      h('td',
        h('span.cw-swatch.cw-swatch--sm', { style: { backgroundColor: subject.color } }),
        subject.name || 'Sin nombre'),
      h('td',
        input('number', entry.hours, (v) => { entry.hours = Math.max(0, v || 0); save(); refreshTotal(); },
          { min: 0, max: 40, class: 'cw-narrow' })),
      h('td',
        input('number', entry.maxPerDay, (v) => { entry.maxPerDay = Math.max(1, v || 1); save(); },
          { min: 1, max: 8, class: 'cw-narrow' })),
      h('td', { style: { textAlign: 'center' } },
        checkbox(entry.assignToTutor, (v) => { entry.assignToTutor = v; save(); })),
      h('td',
        select(
          [['', 'Cualquiera'],
            ...model.teachers
              .filter((t) => t.subjectIds.includes(subject.id))
              .map((t) => [t.id, t.name || t.id])],
          entry.fixedTeacherId || '',
          (v) => { entry.fixedTeacherId = v || null; save(); },
          { class: 'cw-mid', disabled: entry.assignToTutor },
        )));
  });

  const planTable = h('table.cw-datatable.cw-editable',
    h('thead', h('tr',
      h('th', 'Materia'),
      h('th', { style: { width: '90px' } }, 'Horas/sem'),
      h('th', { style: { width: '90px' } }, 'Máx/día'),
      h('th', { style: { width: '90px', textAlign: 'center' } }, 'La da el tutor'),
      h('th', { style: { width: '170px' } }, 'Profesor fijo'))),
    h('tbody', planRows.length ? planRows
      : h('tr', h('td', { colSpan: 5 }, h('div.cw-empty', 'Primero captura las materias.')))));

  refreshTotal();

  return h('section.cw-block',
    h('div.cw-block__head',
      h('div.cw-grade-title',
        h('span', 'Grado'),
        input('text', grade.name, (v) => { grade.name = v; save(); },
          { class: 'cw-grade-input', placeholder: '1' })),
      select([['matutino', 'Matutino'], ['vespertino', 'Vespertino'], ['', 'Sin turno']],
        grade.shift, (v) => { grade.shift = v; save(); }, { class: 'cw-mid' }),
      totalTag,
      iconButton('✕', 'Eliminar grado', () => {
        if (!confirm(`¿Eliminar el grado ${grade.name} y sus ${grade.groups.length} grupo(s)?`)) return;
        model.grades = model.grades.filter((g) => g.id !== grade.id);
        save(); ctx.rerender();
      })),
    h('div.cw-subsection', h('h4', 'Grupos'), groupsBox),
    h('div.cw-subsection', h('h4', 'Plan de estudios'), h('div.cw-scroll-x', planTable),
      h('p.cw-hint',
        '«La da el tutor» sirve para Tutoría: la impartirá el profesor que quede como ' +
        'tutor del grupo. «Profesor fijo» obliga a que esa materia la dé una persona concreta.')));
}

/** Resumen para la barra lateral. */
export function modelSummary(model) {
  const groups = allGroups(model).length;
  const hours = model.grades.reduce((acc, grade) => {
    const perGroup = grade.plan.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0);
    return acc + perGroup * grade.groups.length;
  }, 0);
  const capacity = model.teachers.reduce((acc, t) => acc + (Number(t.maxWeekly) || 0), 0);
  return { groups, hours, capacity, subjects: model.subjects.length, teachers: model.teachers.length };
}
