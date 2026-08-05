"""
Validación de factibilidad (pre-vuelo).

Corre DESPUÉS de asignar tutores y ANTES de la búsqueda. Su trabajo es detectar en
milisegundos los problemas que ninguna cantidad de backtracking puede resolver, y
explicarlos en español para el director de la escuela —no para el programador.

Distingue:
  ERROR   -> imposible por construcción; se aborta la búsqueda (`status: infeasible`).
  WARNING -> muy probable que falten horas; se busca igual y se reporta al final.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Tuple

from ..models.schemas import Conflict, Severity
from .domain import ProblemContext


def validate(ctx: ProblemContext) -> List[Conflict]:
    conflicts: List[Conflict] = []
    conflicts += _check_group_capacity(ctx)
    conflicts += _check_eligibility(ctx)
    conflicts += _check_max_per_day(ctx)
    conflicts += _check_subject_capacity(ctx)
    conflicts += _check_global_capacity(ctx)
    conflicts += _check_teacher_availability(ctx)
    return conflicts


def has_blocking_errors(conflicts: List[Conflict]) -> bool:
    return any(c.severity is Severity.ERROR for c in conflicts)


# --------------------------------------------------------------------------- #
def _check_group_capacity(ctx: ProblemContext) -> List[Conflict]:
    """El plan de estudios no puede pedir más horas que celdas tiene el grupo."""
    out: List[Conflict] = []
    for gid in ctx.group_order:
        group = ctx.groups[gid]
        capacity = len(ctx.group_slots[gid])
        demand = group.total_weekly_hours
        if demand > capacity:
            out.append(
                Conflict(
                    severity=Severity.ERROR,
                    code="GROUP_OVER_CAPACITY",
                    message=(
                        f"El grupo {group.label} pide {demand} h a la semana pero su rejilla "
                        f"sólo tiene {capacity} espacios disponibles. Reduce horas del plan o "
                        "agrega bloques al horario."
                    ),
                    group_id=gid,
                    missing_hours=demand - capacity,
                )
            )
        elif demand < capacity * 0.5:
            out.append(
                Conflict(
                    severity=Severity.INFO,
                    code="GROUP_UNDERUSED",
                    message=(
                        f"El grupo {group.label} sólo ocupa {demand} de {capacity} espacios; "
                        "quedarán muchas horas libres."
                    ),
                    group_id=gid,
                )
            )
    return out


def _check_eligibility(ctx: ProblemContext) -> List[Conflict]:
    """Toda materia con horas debe tener al menos un profesor que pueda impartirla."""
    out: List[Conflict] = []
    for gid in ctx.group_order:
        group = ctx.groups[gid]
        for c in group.curriculum:
            if c.weekly_hours == 0:
                continue
            elig = ctx.eligible.get((gid, c.subject_id), tuple())
            subject_name = ctx.subjects[c.subject_id].name
            if not elig:
                reason = (
                    "el grupo no tiene tutor asignado"
                    if c.assign_to_tutor
                    else "ningún profesor la tiene en su lista de materias"
                )
                out.append(
                    Conflict(
                        severity=Severity.ERROR,
                        code="NO_ELIGIBLE_TEACHER",
                        message=(
                            f"{subject_name} en {group.label}: {reason}. "
                            "Asigna la materia a algún profesor."
                        ),
                        group_id=gid,
                        subject_id=c.subject_id,
                        missing_hours=c.weekly_hours,
                    )
                )
                continue

            # Elegible pero sin un solo hueco compartido con el grupo.
            usable = set()
            for tid in elig:
                usable |= ctx.teacher_slots[tid] & ctx.group_slots[gid]
            if not usable:
                out.append(
                    Conflict(
                        severity=Severity.ERROR,
                        code="NO_COMMON_SLOT",
                        message=(
                            f"{subject_name} en {group.label}: la disponibilidad de sus profesores "
                            "no coincide con ningún horario hábil del grupo."
                        ),
                        group_id=gid,
                        subject_id=c.subject_id,
                        missing_hours=c.weekly_hours,
                    )
                )
            elif len(usable) < c.weekly_hours:
                out.append(
                    Conflict(
                        severity=Severity.ERROR,
                        code="NOT_ENOUGH_COMMON_SLOTS",
                        message=(
                            f"{subject_name} en {group.label} necesita {c.weekly_hours} h pero sólo "
                            f"existen {len(usable)} horarios compatibles con sus profesores."
                        ),
                        group_id=gid,
                        subject_id=c.subject_id,
                        missing_hours=c.weekly_hours - len(usable),
                    )
                )
    return out


def _check_max_per_day(ctx: ProblemContext) -> List[Conflict]:
    """`weekly_hours` no puede exceder `max_per_day` × días."""
    out: List[Conflict] = []
    n_days = len(ctx.request.grid.days)
    for gid in ctx.group_order:
        group = ctx.groups[gid]
        for c in group.curriculum:
            ceiling = c.max_per_day * n_days
            if c.weekly_hours > ceiling:
                out.append(
                    Conflict(
                        severity=Severity.ERROR,
                        code="MAX_PER_DAY_TOO_LOW",
                        message=(
                            f"{ctx.subjects[c.subject_id].name} en {group.label}: {c.weekly_hours} h "
                            f"semanales no caben con un tope de {c.max_per_day} h/día en {n_days} días."
                        ),
                        group_id=gid,
                        subject_id=c.subject_id,
                        missing_hours=c.weekly_hours - ceiling,
                    )
                )
    return out


def _subject_demand(ctx: ProblemContext) -> Dict[str, int]:
    demand: Dict[str, int] = defaultdict(int)
    for gid in ctx.group_order:
        for c in ctx.groups[gid].curriculum:
            demand[c.subject_id] += c.weekly_hours
    return demand


def _check_subject_capacity(ctx: ProblemContext) -> List[Conflict]:
    """
    Por materia: horas pedidas vs. techo de horas que pueden cubrir sus profesores.

    Es una cota superior optimista (ignora que un profesor se reparte entre materias),
    así que rebasarla es un error duro; quedarse justo debajo es una advertencia.
    """
    out: List[Conflict] = []
    demand = _subject_demand(ctx)
    for sid, hours in demand.items():
        if hours == 0:
            continue
        capacity = 0
        slot_capacity = 0
        for tid in ctx.teacher_order:
            if sid in ctx.teachers[tid].subject_ids:
                capacity += ctx.teacher_max_weekly[tid]
                slot_capacity += len(ctx.teacher_slots[tid])
        # Las materias impartidas por el tutor se saltan: su capacidad se valida
        # vía _check_eligibility, profesor por profesor.
        bound_to_tutor = all(
            c.assign_to_tutor
            for gid in ctx.group_order
            for c in ctx.groups[gid].curriculum
            if c.subject_id == sid and c.weekly_hours
        )
        if bound_to_tutor:
            continue
        effective = min(capacity, slot_capacity)
        if effective < hours:
            out.append(
                Conflict(
                    severity=Severity.ERROR,
                    code="SUBJECT_CAPACITY",
                    message=(
                        f"{ctx.subjects[sid].name}: la escuela requiere {hours} h semanales y sus "
                        f"profesores sólo pueden cubrir {effective} h "
                        f"(carga máxima {capacity} h, disponibilidad {slot_capacity} h). "
                        "Contrata apoyo o baja las horas del plan."
                    ),
                    subject_id=sid,
                    missing_hours=hours - effective,
                )
            )
        elif effective < hours * 1.1:
            out.append(
                Conflict(
                    severity=Severity.WARNING,
                    code="SUBJECT_CAPACITY_TIGHT",
                    message=(
                        f"{ctx.subjects[sid].name} va muy justa: {hours} h requeridas contra "
                        f"{effective} h disponibles. Es probable que falten horas por acomodar."
                    ),
                    subject_id=sid,
                )
            )
    return out


def _check_global_capacity(ctx: ProblemContext) -> List[Conflict]:
    total_demand = ctx.required_hours
    total_capacity = sum(ctx.teacher_max_weekly.values())
    if total_demand > total_capacity:
        return [
            Conflict(
                severity=Severity.ERROR,
                code="GLOBAL_CAPACITY",
                message=(
                    f"La escuela requiere {total_demand} horas-clase semanales y la plantilla "
                    f"suma {total_capacity} horas contratadas. Faltan {total_demand - total_capacity} h."
                ),
                missing_hours=total_demand - total_capacity,
            )
        ]
    if total_demand > total_capacity * 0.95:
        return [
            Conflict(
                severity=Severity.WARNING,
                code="GLOBAL_CAPACITY_TIGHT",
                message=(
                    f"Se usará más del 95 % de la plantilla ({total_demand}/{total_capacity} h). "
                    "Con tan poco margen es normal que el horario quede con huecos difíciles."
                ),
            )
        ]
    return []


def _check_teacher_availability(ctx: ProblemContext) -> List[Conflict]:
    out: List[Conflict] = []
    for tid in ctx.teacher_order:
        teacher = ctx.teachers[tid]
        available = len(ctx.teacher_slots[tid])
        if teacher.max_weekly_hours > 0 and available == 0:
            out.append(
                Conflict(
                    severity=Severity.WARNING,
                    code="TEACHER_NO_AVAILABILITY",
                    message=(
                        f"{teacher.name} tiene {teacher.max_weekly_hours} h contratadas pero su "
                        "matriz de disponibilidad no deja ningún horario libre."
                    ),
                    teacher_id=tid,
                )
            )
        elif available < teacher.max_weekly_hours:
            out.append(
                Conflict(
                    severity=Severity.INFO,
                    code="TEACHER_AVAILABILITY_BELOW_CONTRACT",
                    message=(
                        f"{teacher.name} sólo está disponible {available} h de las "
                        f"{teacher.max_weekly_hours} h contratadas."
                    ),
                    teacher_id=tid,
                )
            )
    return out
