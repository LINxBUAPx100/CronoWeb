"""
Asignación de tutores — se ejecuta ANTES del cálculo del horario.

Requisito de negocio:
  1. Cada grupo debe tener un tutor.
  2. La asignación es 1 a 1 (un profesor no es tutor de dos grupos).
  3. Sólo si |grupos| > |profesores elegibles| se permite repetir, y se repite
     priorizando a los profesores de MENOR carga horaria.

Modelado: emparejamiento bipartito máximo (grupos ↔ profesores). No es un problema
de asignación con costo (Hungarian) porque el objetivo primario es *cardinalidad*
—maximizar cuántos grupos reciben tutor exclusivo— y sólo secundariamente calidad.
Se obtiene calidad ordenando la lista de candidatos de cada grupo por preferencia:
Kuhn toma el primer candidato libre, así que el orden actúa como función de costo
sin el O(n³) del Hungarian ni su rigidez.

Carga horaria estimada: los tutores se deciden antes de existir el horario, así que
no hay carga real. Se estima repartiendo las horas de cada (grupo, materia) entre
los profesores elegibles a partes iguales. Es un proxy insesgado y suficiente para
ordenar; el reporte final expone la carga real para que la escuela pueda ajustar.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from ..models.schemas import Conflict, Severity, TutorAssignment
from .domain import ProblemContext


def estimate_teacher_loads(ctx: ProblemContext) -> Dict[str, float]:
    """Reparto proporcional de la demanda entre profesores elegibles."""
    loads: Dict[str, float] = {tid: 0.0 for tid in ctx.teacher_order}
    for gid in ctx.group_order:
        for c in ctx.groups[gid].curriculum:
            elig = ctx.eligible.get((gid, c.subject_id), tuple())
            if not elig or c.weekly_hours == 0:
                continue
            share = c.weekly_hours / len(elig)
            for tid in elig:
                if tid in loads:
                    loads[tid] += share
    return loads


def _teaching_hours_in_group(ctx: ProblemContext, teacher_id: str, group_id: str) -> int:
    """Horas del plan del grupo que este profesor podría impartir (afinidad)."""
    teacher = ctx.teachers[teacher_id]
    total = 0
    for c in ctx.groups[group_id].curriculum:
        if c.assign_to_tutor:
            continue
        if c.fixed_teacher_id == teacher_id or (
            not c.fixed_teacher_id and c.subject_id in teacher.subject_ids
        ):
            total += c.weekly_hours
    return total


def _candidate_lists(
    ctx: ProblemContext, loads: Dict[str, float], require_affinity: bool
) -> Dict[str, List[str]]:
    """
    Candidatos por grupo, ordenados de mejor a peor.

    Preferencia = afinidad (horas que le daría al grupo) + prioridad manual
                  − carga estimada. Empates resueltos por id para reproducibilidad.
    """
    result: Dict[str, List[str]] = {}
    for gid in ctx.group_order:
        scored: List[Tuple[float, str]] = []
        for tid in ctx.teacher_order:
            teacher = ctx.teachers[tid]
            if not teacher.can_be_tutor:
                continue
            affinity = _teaching_hours_in_group(ctx, tid, gid)
            if require_affinity and affinity == 0:
                continue
            score = 3.0 * affinity + 2.0 * teacher.tutor_priority - 0.5 * loads.get(tid, 0.0)
            scored.append((-score, tid))
        scored.sort()
        result[gid] = [tid for _, tid in scored]
    return result


def _kuhn_matching(group_ids: List[str], candidates: Dict[str, List[str]]) -> Dict[str, str]:
    """
    Emparejamiento bipartito máximo (algoritmo de Kuhn / caminos aumentantes).

    Devuelve group_id -> teacher_id. O(V·E), de sobra para el tamaño de una escuela
    (decenas de grupos × decenas de profesores).
    """
    match_teacher_to_group: Dict[str, str] = {}

    def try_augment(gid: str, visited: set) -> bool:
        for tid in candidates.get(gid, []):
            if tid in visited:
                continue
            visited.add(tid)
            holder = match_teacher_to_group.get(tid)
            # Libre, o su actual dueño puede reubicarse en otro candidato.
            if holder is None or try_augment(holder, visited):
                match_teacher_to_group[tid] = gid
                return True
        return False

    for gid in group_ids:
        try_augment(gid, set())

    return {gid: tid for tid, gid in match_teacher_to_group.items()}


def assign_tutors(ctx: ProblemContext) -> Tuple[List[TutorAssignment], List[Conflict]]:
    """
    Flujo:
      1. Estimar cargas.
      2. Intentar matching 1-a-1 exigiendo afinidad (el tutor da clase a su grupo).
      3. Si quedan grupos sin tutor, repetir el matching relajando la afinidad.
      4. Los grupos que sigan sin tutor sólo pueden resolverse compartiendo:
         se elige al profesor con menos grupos tutorados y, a igualdad, menor carga.
    """
    conflicts: List[Conflict] = []
    loads = estimate_teacher_loads(ctx)
    group_ids = list(ctx.group_order)

    eligible_pool = [tid for tid in ctx.teacher_order if ctx.teachers[tid].can_be_tutor]
    if not eligible_pool:
        conflicts.append(
            Conflict(
                severity=Severity.ERROR,
                code="NO_TUTOR_CANDIDATES",
                message="Ningún profesor tiene 'can_be_tutor': no es posible asignar tutores.",
            )
        )
        return [TutorAssignment(group_id=g, teacher_id=None, reason="sin candidatos") for g in group_ids], conflicts

    # Paso 2 — matching con afinidad.
    strict = _kuhn_matching(group_ids, _candidate_lists(ctx, loads, require_affinity=True))
    reasons: Dict[str, str] = {gid: "matching 1-a-1 con afinidad" for gid in strict}

    # Paso 3 — relajar afinidad sólo para los grupos que quedaron sueltos.
    pending = [gid for gid in group_ids if gid not in strict]
    if pending:
        relaxed_candidates = _candidate_lists(ctx, loads, require_affinity=False)
        # Se preservan los emparejamientos ya logrados fijando sus profesores.
        taken = set(strict.values())
        for gid in pending:
            relaxed_candidates[gid] = [t for t in relaxed_candidates[gid] if t not in taken]
        extra = _kuhn_matching(pending, relaxed_candidates)
        for gid, tid in extra.items():
            strict[gid] = tid
            reasons[gid] = "matching 1-a-1 sin afinidad (no imparte materias del grupo)"

    # Paso 4 — compartir tutor (sólo cuando ya no quedan profesores libres).
    assigned_count: Dict[str, int] = defaultdict(int)
    for tid in strict.values():
        assigned_count[tid] += 1

    still_pending = [gid for gid in group_ids if gid not in strict]
    if still_pending:
        conflicts.append(
            Conflict(
                severity=Severity.WARNING,
                code="TUTORS_SHARED",
                message=(
                    f"Hay {len(group_ids)} grupos y sólo {len(eligible_pool)} profesores elegibles "
                    f"como tutor: {len(still_pending)} grupo(s) comparten tutor, priorizando a los "
                    "profesores con menor carga."
                ),
            )
        )
        for gid in still_pending:
            # Menos grupos tutorados primero; a igualdad, menor carga estimada.
            best = min(eligible_pool, key=lambda t: (assigned_count[t], loads.get(t, 0.0), t))
            strict[gid] = best
            assigned_count[best] += 1
            reasons[gid] = "tutor compartido (menor carga disponible)"

    # Un profesor con más de un grupo marca a TODOS sus grupos como compartidos,
    # para que el UI muestre el caso completo y no sólo el último asignado.
    shared_teachers = {tid for tid, n in assigned_count.items() if n > 1}

    tutors = [
        TutorAssignment(
            group_id=gid,
            teacher_id=strict.get(gid),
            shared=strict.get(gid) in shared_teachers,
            estimated_load=round(loads.get(strict.get(gid, ""), 0.0), 2),
            reason=reasons.get(gid, ""),
        )
        for gid in group_ids
    ]
    return tutors, conflicts


def tutor_map(tutors: List[TutorAssignment]) -> Dict[str, Optional[str]]:
    return {t.group_id: t.teacher_id for t in tutors}
