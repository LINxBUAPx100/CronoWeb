"""
Núcleo CSP: backtracking cronológico con forward-checking, MRV, ordenamiento de
valores por costo suave, reinicios aleatorizados y reparación por cadenas de eyección.

────────────────────────────────────────────────────────────────────────────────
FLUJO DEL ALGORITMO
────────────────────────────────────────────────────────────────────────────────
 1. VARIABLES. Cada hora suelta de (grupo, materia) es una variable (`Lesson`).
    5 h de Matemáticas en 1°A = 5 variables. Total típico: 150-400.

 2. DOMINIO. Para cada variable, el conjunto de pares (slot, profesor) que
    satisfacen TODAS las restricciones duras en el estado actual:
      H1 el grupo está libre en ese slot          (un grupo = un salón)
      H2 el profesor está libre en ese slot       (sin cruces entre salones)
      H3 el slot cae en su matriz de disponibilidad
      H4 no rebasa su carga semanal ni diaria
      H5 no rebasa `max_per_day` de la materia en ese grupo
      H6 el profesor es elegible (imparte la materia / es fijo / es el tutor)

 3. SELECCIÓN DE VARIABLE (MRV). Se toma la variable con menor dominio actual
    —la más cerca de quedarse sin opciones—. El conteo se hace con corte temprano
    y sobre una muestra acotada (`mrv_sample`) porque recalcular el dominio de 400
    variables en cada nodo dominaría el costo total.

 4. ORDEN DE VALORES. Los pares candidatos se ordenan por costo SUAVE ascendente:
    repetición de materia el mismo día, huecos del profesor, materias pesadas por
    la tarde, afinidad del tutor con su grupo, profesor preferido, balance diario.
    Es un LCV pragmático: en lugar de contar podas futuras (caro), se usa el costo
    pedagógico, que empíricamente correlaciona con soluciones más fáciles de cerrar.

 5. PODA. `max_branch` limita cuántos valores se exploran por variable. Sacrifica
    completitud teórica a cambio de encontrar buenas soluciones rápido; los
    reinicios recuperan la diversidad perdida.

 6. REINICIOS. Al agotarse un intento (o el tiempo), se reinicia con ruido creciente
    en el desempate del orden de valores. Se conserva SIEMPRE la mejor asignación
    parcial vista (la de más horas colocadas).

 7. REPARACIÓN. Sobre el mejor parcial, para cada hora sin colocar se busca un
    hueco donde estorbe exactamente UNA clase ya puesta; se expulsa esa clase, se
    coloca la pendiente y se reubica la expulsada (cadena de eyección de longitud 1).
    Recupera de forma barata la mayoría de las horas que el backtracking dejó fuera.

 8. SALIDA. Nunca lanza por infactibilidad: devuelve el mejor horario posible más
    la lista exacta de horas que no cupieron, para que `report.py` las explique.
"""

from __future__ import annotations

import random
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

from ..models.schemas import SolverOptions
from .domain import Lesson, ProblemContext

# El backtracking recursa una vez por variable asignada.
_RECURSION_HEADROOM = 2000


class _Timeout(Exception):
    """Presupuesto de tiempo o de nodos agotado."""


@dataclass
class SolveResult:
    assignment: Dict[str, Tuple[int, str]]      # uid -> (slot_index, teacher_id)
    unplaced: List[str]                          # uids sin colocar
    restarts: int
    nodes: int
    elapsed_ms: int
    soft_score: float                            # penalización acumulada (menor = mejor)
    complete: bool


class _State:
    """Estado mutable de la búsqueda. Todo O(1) para poder deshacerse igual de rápido."""

    __slots__ = (
        "ctx",
        "group_slot",
        "teacher_slot",
        "assignment",
        "teacher_week",
        "teacher_day",
        "subject_day",
    )

    def __init__(self, ctx: ProblemContext) -> None:
        n_slots = len(ctx.slots)
        n_days = len(ctx.request.grid.days)
        self.ctx = ctx
        self.group_slot: Dict[str, List[Optional[str]]] = {
            gid: [None] * n_slots for gid in ctx.group_order
        }
        self.teacher_slot: Dict[str, List[Optional[str]]] = {
            tid: [None] * n_slots for tid in ctx.teacher_order
        }
        self.assignment: Dict[str, Tuple[int, str]] = {}
        self.teacher_week: Dict[str, int] = {tid: 0 for tid in ctx.teacher_order}
        self.teacher_day: Dict[str, List[int]] = {
            tid: [0] * n_days for tid in ctx.teacher_order
        }
        # (group_id, subject_id) -> horas por día
        self.subject_day: Dict[Tuple[str, str], List[int]] = {}

    # -- mutación ---------------------------------------------------------- #
    def place(self, lesson: Lesson, slot: int, teacher_id: str) -> None:
        ctx = self.ctx
        day = ctx.day_of_slot[slot]
        self.group_slot[lesson.group_id][slot] = lesson.uid
        self.teacher_slot[teacher_id][slot] = lesson.uid
        self.assignment[lesson.uid] = (slot, teacher_id)
        self.teacher_week[teacher_id] += 1
        self.teacher_day[teacher_id][day] += 1
        key = (lesson.group_id, lesson.subject_id)
        counters = self.subject_day.get(key)
        if counters is None:
            counters = [0] * len(ctx.request.grid.days)
            self.subject_day[key] = counters
        counters[day] += 1

    def unplace(self, lesson: Lesson) -> None:
        slot, teacher_id = self.assignment.pop(lesson.uid)
        day = self.ctx.day_of_slot[slot]
        self.group_slot[lesson.group_id][slot] = None
        self.teacher_slot[teacher_id][slot] = None
        self.teacher_week[teacher_id] -= 1
        self.teacher_day[teacher_id][day] -= 1
        self.subject_day[(lesson.group_id, lesson.subject_id)][day] -= 1

    def subject_count(self, group_id: str, subject_id: str, day: int) -> int:
        counters = self.subject_day.get((group_id, subject_id))
        return counters[day] if counters else 0


class Scheduler:
    """Motor de resolución. Una instancia por petición (no es thread-safe)."""

    def __init__(
        self,
        ctx: ProblemContext,
        tutor_by_group: Dict[str, Optional[str]],
        options: SolverOptions,
    ) -> None:
        self.ctx = ctx
        self.options = options
        self.weights = options.weights
        self.tutor_by_group = tutor_by_group
        self.state = _State(ctx)
        self.rng = random.Random(options.seed)

        self._lessons: Dict[str, Lesson] = {l.uid: l for l in ctx.lessons}
        # Slots utilizables por par (grupo, profesor): intersección precomputada.
        # Se consulta en el hot loop, así que se guarda como tupla ordenada.
        self._pair_slots: Dict[Tuple[str, str], Tuple[int, ...]] = {}
        for gid in ctx.group_order:
            g_slots = ctx.group_slots[gid]
            for tid in ctx.teacher_order:
                inter = g_slots & ctx.teacher_slots[tid]
                if inter:
                    self._pair_slots[(gid, tid)] = tuple(sorted(inter))

        self._ordered_uids: List[str] = [l.uid for l in ctx.lessons]
        self._deadline = 0.0
        self._nodes = 0
        self._noise = 0.0
        self._best: Dict[str, Tuple[int, str]] = {}
        self._best_count = -1

    # ------------------------------------------------------------------ #
    # API pública
    # ------------------------------------------------------------------ #
    def solve(self) -> SolveResult:
        started = time.monotonic()
        self._deadline = started + self.options.time_budget_seconds
        sys.setrecursionlimit(max(sys.getrecursionlimit(), len(self.ctx.lessons) + _RECURSION_HEADROOM))

        # Las horas sin ningún profesor elegible se apartan: meterlas al CSP haría
        # fallar cada rama sin aportar información. El validador ya las reportó.
        solvable = [l for l in self.ctx.lessons if l.eligible_teachers]
        impossible = [l.uid for l in self.ctx.lessons if not l.eligible_teachers]

        # Orden base: primero lo más difícil (dominio inicial más pequeño). El orden
        # es estable y se reutiliza en cada nodo para el muestreo del MRV.
        base_order = sorted(solvable, key=lambda l: (l.difficulty, l.uid))
        self._ordered_uids = [l.uid for l in base_order]

        restarts = 0
        complete = False
        for attempt in range(self.options.max_restarts + 1):
            restarts = attempt
            self.state = _State(self.ctx)
            self.rng = random.Random(self.options.seed + attempt * 7919)
            # El ruido crece con cada reinicio: el primer intento es determinista y
            # puramente guiado por el costo; los siguientes exploran alternativas.
            self._noise = 0.0 if attempt == 0 else 0.35 * attempt

            remaining = {l.uid for l in base_order}
            try:
                complete = self._search(remaining)
            except _Timeout:
                complete = False
            self._track_best()
            if complete or time.monotonic() >= self._deadline:
                break

        # Reconstrucción del mejor parcial + reparación.
        self._restore(self._best)
        if not complete and self.options.enable_repair:
            self._repair(deadline=min(self._deadline + 1.5, started + self.options.time_budget_seconds * 1.5))

        placed = set(self.state.assignment)
        unplaced = [l.uid for l in solvable if l.uid not in placed] + impossible

        return SolveResult(
            assignment=dict(self.state.assignment),
            unplaced=unplaced,
            restarts=restarts,
            nodes=self._nodes,
            elapsed_ms=int((time.monotonic() - started) * 1000),
            soft_score=round(self.total_soft_cost(), 2),
            complete=not unplaced,
        )

    # ------------------------------------------------------------------ #
    # Búsqueda
    # ------------------------------------------------------------------ #
    def _search(self, remaining: Set[str]) -> bool:
        if not remaining:
            return True

        self._nodes += 1
        if self._nodes % 512 == 0 and time.monotonic() > self._deadline:
            raise _Timeout

        uid = self._select_variable(remaining)
        lesson = self._lessons[uid]
        candidates = self._candidates(lesson)
        if not candidates:
            # Forward-checking implícito: dominio vacío ⇒ esta rama está muerta.
            self._track_best()
            return False

        branch = self.options.max_branch or len(candidates)
        remaining.discard(uid)
        for slot, teacher_id in candidates[:branch]:
            self.state.place(lesson, slot, teacher_id)
            if len(self.state.assignment) > self._best_count:
                self._track_best()
            if self._search(remaining):
                return True
            self.state.unplace(lesson)
        remaining.add(uid)
        return False

    def _select_variable(self, remaining: Set[str]) -> str:
        """
        MRV acotado con ruptura de simetría.

        Dos detalles que valen más que el heurístico en sí:

        · SIMETRÍA. Las 5 horas de Matemáticas de 1°A son variables intercambiables:
          permutarlas genera 5! ramas idénticas. Al muestrear se toma sólo la primera
          ocurrencia pendiente de cada (grupo, materia) —el orden estático garantiza
          que sea siempre la misma—, lo que colapsa ese factorial a una sola rama.
          En el escenario de 6 grupos esto reduce 198 variables a ~66 clases.

        · COSTO. Se recorre una lista pre-ordenada por dificultad en vez de ordenar
          `remaining` en cada nodo (era O(n log n) por nodo, el gasto dominante).

        Corta en cuanto encuentra dominio ≤ 1: ninguna otra puede ser más restringida.
        """
        sample_limit = self.options.mrv_sample
        best_uid: Optional[str] = None
        best_size = 1 << 30
        seen_pairs: Set[Tuple[str, str]] = set()
        sampled = 0

        for uid in self._ordered_uids:
            if uid not in remaining:
                continue
            lesson = self._lessons[uid]
            pair = (lesson.group_id, lesson.subject_id)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)

            size = self._domain_size(lesson, cap=best_size)
            if size < best_size:
                best_uid, best_size = uid, size
                if size <= 1:
                    return best_uid
            elif best_uid is None:
                best_uid = uid

            sampled += 1
            if sampled >= sample_limit:
                break

        # `remaining` nunca está vacío aquí (lo comprueba `_search`).
        return best_uid if best_uid is not None else next(iter(remaining))

    def _domain_size(self, lesson: Lesson, cap: int) -> int:
        """Cuenta pares (slot, profesor) viables, con corte temprano en `cap`."""
        st = self.state
        ctx = self.ctx
        gid = lesson.group_id
        g_row = st.group_slot[gid]
        total = 0
        for tid in lesson.eligible_teachers:
            if st.teacher_week[tid] >= ctx.teacher_max_weekly[tid]:
                continue
            slots = self._pair_slots.get((gid, tid))
            if not slots:
                continue
            t_row = st.teacher_slot[tid]
            t_day = st.teacher_day[tid]
            max_daily = ctx.teacher_max_daily[tid]
            for slot in slots:
                if g_row[slot] is not None or t_row[slot] is not None:
                    continue
                day = ctx.day_of_slot[slot]
                if t_day[day] >= max_daily:
                    continue
                if st.subject_count(gid, lesson.subject_id, day) >= lesson.max_per_day:
                    continue
                total += 1
                if total >= cap:
                    return total
        return total

    def _candidates(self, lesson: Lesson) -> List[Tuple[int, str]]:
        """Pares viables ordenados por costo suave ascendente (+ ruido de reinicio)."""
        st = self.state
        ctx = self.ctx
        gid = lesson.group_id
        g_row = st.group_slot[gid]
        scored: List[Tuple[float, int, str]] = []

        for tid in lesson.eligible_teachers:
            if st.teacher_week[tid] >= ctx.teacher_max_weekly[tid]:
                continue
            slots = self._pair_slots.get((gid, tid))
            if not slots:
                continue
            t_row = st.teacher_slot[tid]
            t_day = st.teacher_day[tid]
            max_daily = ctx.teacher_max_daily[tid]
            for slot in slots:
                if g_row[slot] is not None or t_row[slot] is not None:
                    continue
                day = ctx.day_of_slot[slot]
                if t_day[day] >= max_daily:
                    continue
                if st.subject_count(gid, lesson.subject_id, day) >= lesson.max_per_day:
                    continue
                cost = self._soft_cost(lesson, slot, tid)
                if self._noise:
                    cost += self.rng.uniform(0.0, self._noise)
                scored.append((cost, slot, tid))

        scored.sort(key=lambda x: (x[0], x[1], x[2]))
        return [(slot, tid) for _, slot, tid in scored]

    # ------------------------------------------------------------------ #
    # Restricciones suaves
    # ------------------------------------------------------------------ #
    def _soft_cost(self, lesson: Lesson, slot: int, teacher_id: str) -> float:
        ctx = self.ctx
        st = self.state
        w = self.weights
        day = ctx.day_of_slot[slot]
        block = ctx.block_of_slot[slot]
        cost = 0.0

        # S1 — evitar repetir la misma materia el mismo día (aunque `max_per_day` lo permita).
        cost += w.same_day_repeat * st.subject_count(lesson.group_id, lesson.subject_id, day)

        # S2 — huecos del profesor: coste marginal real de insertar aquí.
        cost += w.teacher_gap * self._gap_delta(teacher_id, day, block)

        # S3 — materias que rinden más temprano.
        if ctx.subjects[lesson.subject_id].prefers_morning:
            cost += w.morning_preference * block

        # S4 — el tutor da clase a su propio grupo (bonificación: peso negativo).
        if self.tutor_by_group.get(lesson.group_id) == teacher_id:
            cost += w.tutor_affinity

        # S5 — profesor preferido por la dirección.
        if lesson.preferred_teacher and lesson.preferred_teacher != teacher_id:
            cost += w.preferred_teacher

        # S6 — repartir la carga del profesor entre días.
        cost += w.daily_balance * st.teacher_day[teacher_id][day]

        # S7 — llenar temprano para liberar las últimas horas del día.
        cost += w.late_block_penalty * block

        # S8 — repartir entre profesores según capacidad RESTANTE, no absoluta.
        #      Sin esto el solver satura al primer profesor elegible de cada materia
        #      y luego no le quedan horas para los grupos que faltan: es la causa
        #      número uno de horarios que quedan a 1-2 horas de completarse.
        cap = ctx.teacher_max_weekly[teacher_id]
        if cap:
            cost += w.teacher_utilization * (st.teacher_week[teacher_id] / cap)
        return cost

    def _gap_delta(self, teacher_id: str, day: int, block: int) -> int:
        """
        Cuántos huecos NUEVOS crea colocar al profesor en (día, bloque).

        Hueco = bloque libre entre dos clases del mismo día. Se compara el tramo
        ocupado antes y después de la inserción; es O(bloques/día).
        """
        ctx = self.ctx
        row = self.state.teacher_slot[teacher_id]
        occupied = [ctx.block_of_slot[s] for s in ctx.slots_by_day[day] if row[s] is not None]
        if not occupied:
            return 0
        before = (max(occupied) - min(occupied) + 1) - len(occupied)
        occupied.append(block)
        after = (max(occupied) - min(occupied) + 1) - len(occupied)
        return max(0, after - before)

    def total_soft_cost(self) -> float:
        """Penalización total del horario final (menor = mejor). Recalculada desde cero."""
        snapshot = dict(self.state.assignment)
        probe = _State(self.ctx)
        total = 0.0
        # Se reconstruye en el mismo orden en que se leerá el horario para que el
        # número sea reproducible y comparable entre corridas.
        for uid, (slot, tid) in sorted(snapshot.items(), key=lambda kv: (kv[1][0], kv[0])):
            lesson = self._lessons[uid]
            real_state, self.state = self.state, probe
            total += self._soft_cost(lesson, slot, tid)
            self.state = real_state
            probe.place(lesson, slot, tid)
        return total

    # ------------------------------------------------------------------ #
    # Mejor parcial / restauración
    # ------------------------------------------------------------------ #
    def _track_best(self) -> None:
        if len(self.state.assignment) > self._best_count:
            self._best_count = len(self.state.assignment)
            self._best = dict(self.state.assignment)

    def _restore(self, assignment: Dict[str, Tuple[int, str]]) -> None:
        self.state = _State(self.ctx)
        for uid, (slot, tid) in assignment.items():
            self.state.place(self._lessons[uid], slot, tid)

    # ------------------------------------------------------------------ #
    # Reparación por cadenas de eyección
    # ------------------------------------------------------------------ #
    def _repair(self, deadline: float) -> None:
        pending = [
            l.uid
            for l in self.ctx.lessons
            if l.eligible_teachers and l.uid not in self.state.assignment
        ]
        progress = True
        while pending and progress and time.monotonic() < deadline:
            progress = False
            for uid in list(pending):
                if time.monotonic() >= deadline:
                    break
                lesson = self._lessons[uid]
                direct = self._candidates(lesson)
                if direct:
                    slot, tid = direct[0]
                    self.state.place(lesson, slot, tid)
                    pending.remove(uid)
                    progress = True
                elif self._eject_and_place(lesson):
                    pending.remove(uid)
                    progress = True

    def _eject_and_place(self, lesson: Lesson) -> bool:
        """
        Busca un (slot, profesor) donde estorbe exactamente una clase ya colocada,
        la expulsa, coloca `lesson` y reubica a la expulsada. Si no se puede
        reubicar, revierte todo. Cadena de longitud 1: barata y sin riesgo de ciclos.
        """
        st = self.state
        ctx = self.ctx
        gid = lesson.group_id

        for tid in lesson.eligible_teachers:
            slots = self._pair_slots.get((gid, tid))
            if not slots:
                continue
            max_daily = ctx.teacher_max_daily[tid]
            for slot in slots:
                day = ctx.day_of_slot[slot]
                blockers = {
                    x
                    for x in (st.group_slot[gid][slot], st.teacher_slot[tid][slot])
                    if x is not None
                }
                if len(blockers) != 1:
                    continue
                victim = self._lessons[next(iter(blockers))]
                # La víctima ocupa exactamente este slot: es quien bloquea el par.
                victim_slot, victim_teacher = st.assignment[victim.uid]

                st.unplace(victim)
                # Tras expulsar hay que revalidar los topes duros que no dependen
                # de la ocupación (carga semanal/diaria y max_per_day).
                fits = (
                    st.teacher_week[tid] < ctx.teacher_max_weekly[tid]
                    and st.teacher_day[tid][day] < max_daily
                    and st.subject_count(gid, lesson.subject_id, day) < lesson.max_per_day
                    and st.group_slot[gid][slot] is None
                    and st.teacher_slot[tid][slot] is None
                )
                if fits:
                    st.place(lesson, slot, tid)
                    relocation = self._candidates(victim)
                    if relocation:
                        v_slot, v_tid = relocation[0]
                        st.place(victim, v_slot, v_tid)
                        return True
                    st.unplace(lesson)

                # Rollback completo: la víctima vuelve a su sitio original.
                st.place(victim, victim_slot, victim_teacher)
        return False


def build_index_maps(
    ctx: ProblemContext, assignment: Dict[str, Tuple[int, str]]
) -> Tuple[Dict[str, Dict[str, Dict[str, dict]]], Dict[str, Dict[str, Dict[str, dict]]]]:
    """Convierte la asignación plana en las matrices `by_group` y `by_teacher`."""
    by_group: Dict[str, Dict[str, Dict[str, dict]]] = {
        gid: {day: {} for day in ctx.request.grid.days} for gid in ctx.group_order
    }
    by_teacher: Dict[str, Dict[str, Dict[str, dict]]] = {
        tid: {day: {} for day in ctx.request.grid.days} for tid in ctx.teacher_order
    }
    lessons = {l.uid: l for l in ctx.lessons}
    for uid, (slot_index, teacher_id) in assignment.items():
        lesson = lessons[uid]
        slot = ctx.slots[slot_index]
        by_group[lesson.group_id][slot.day][slot.block_id] = {
            "subject_id": lesson.subject_id,
            "teacher_id": teacher_id,
        }
        by_teacher[teacher_id][slot.day][slot.block_id] = {
            "subject_id": lesson.subject_id,
            "group_id": lesson.group_id,
        }
    return by_group, by_teacher
