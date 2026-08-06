/**
 * Modo edición sobre una hoja de horario ya renderizada.
 *
 * Toda la lógica de qué se puede mover vive en `model/edit.js` (funciones puras
 * y probadas). Aquí sólo se traduce a clics:
 *
 *   1. clic en una clase  → se marca y se iluminan sus destinos válidos
 *   2. clic en un destino → se mueve o se intercambia
 *   3. clic fuera / Esc   → se cancela
 *
 * Los destinos se distinguen: verde = casilla libre, ámbar = permuta con la clase
 * que ya está ahí. Lo que no se ilumina, no es posible — el usuario nunca puede
 * crear un cruce, así que no hace falta un mensaje de error después del hecho.
 *
 * @module ui/editor
 */

import { applyMove, candidatesFor } from '../model/edit.js';

const CLASSES = {
  selected: 'is-editing-selected',
  move: 'is-editing-target',
  swap: 'is-editing-swap',
};

/**
 * Activa el modo edición en una tarjeta de grupo.
 *
 * @param {HTMLElement} card nodo `.cw-card` de una vista «Por grupo»
 * @param {object} session sesión de `model/edit.js`
 * @param {{groupId:string, onChange:Function, onStatus:Function}} opts
 * @returns {{destroy:Function}} para desactivar el modo
 */
export function attachEditor(card, session, { groupId, onChange, onStatus }) {
  let selected = null;      // índice en session.assignments
  let candidates = new Map();

  const cells = [...card.querySelectorAll('.cw-cell[data-day][data-block]')];
  const cellAt = (day, block) => cells.find((c) => c.dataset.day === day && c.dataset.block === block);

  const clearMarks = () => {
    for (const cell of cells) {
      cell.classList.remove(CLASSES.selected, CLASSES.move, CLASSES.swap);
      cell.removeAttribute('title');
    }
  };

  const cancel = () => {
    selected = null;
    candidates = new Map();
    clearMarks();
    onStatus('Toca una clase para moverla.');
  };

  const indexAt = (day, block) => session.assignments.findIndex(
    (a) => a.group_id === groupId && a.day === day && a.block_id === block,
  );

  const select = (index) => {
    selected = index;
    candidates = candidatesFor(session, index);
    clearMarks();

    const a = session.assignments[index];
    const origin = cellAt(a.day, a.block_id);
    if (origin) origin.classList.add(CLASSES.selected);

    for (const [, target] of candidates) {
      const cell = cellAt(target.day, target.blockId);
      if (!cell) continue;
      cell.classList.add(target.kind === 'swap' ? CLASSES.swap : CLASSES.move);
      cell.title = target.label;
    }

    const libres = [...candidates.values()].filter((c) => c.kind === 'move').length;
    const permutas = candidates.size - libres;
    onStatus(
      candidates.size
        ? `${libres} casilla(s) libre(s) y ${permutas} intercambio(s) posibles. Toca el destino.`
        : 'Esa clase no se puede mover a ningún otro horario sin romper una restricción.',
    );
  };

  const onClick = (event) => {
    const cell = event.target.closest('.cw-cell[data-day][data-block]');
    if (!cell || !card.contains(cell)) return;
    event.preventDefault();

    const { day, block } = cell.dataset;
    const target = candidates.get(`c|${day}|${block}`);

    if (selected !== null && target) {
      const result = applyMove(session, selected, day, block);
      if (!result.ok) {
        onStatus(result.error);
        return;
      }
      onStatus(result.kind === 'swap' ? 'Clases intercambiadas.' : 'Clase movida.');
      selected = null;
      candidates = new Map();
      onChange();                       // main.js vuelve a dibujar la hoja
      return;
    }

    const index = indexAt(day, block);
    if (index < 0) {                    // casilla vacía sin selección previa
      cancel();
      return;
    }
    if (index === selected) {
      cancel();
      return;
    }
    select(index);
  };

  const onKey = (event) => { if (event.key === 'Escape') cancel(); };

  card.classList.add('is-editing');
  card.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  onStatus('Toca una clase para moverla.');

  return {
    destroy() {
      card.classList.remove('is-editing');
      card.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      clearMarks();
    },
  };
}
