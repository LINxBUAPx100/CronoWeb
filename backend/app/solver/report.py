"""
Diagnóstico de las horas que no se pudieron colocar.

Devolver "no se pudo" no sirve a una escuela. Para cada (grupo, materia) con horas
faltantes se determina la CAUSA dominante inspeccionando el estado final, y se
redacta en el idioma del director, con la acción concreta que lo destraba.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Tuple

from ..models.schemas import Conflict, Severity
from .domain import ProblemContext


def diagnose_unplaced(
    ctx: ProblemContext,
    assignment: Dict[str, Tuple[int, str]],
    unplaced_uids: List[str],
) -> List[Conflict]:
    if not unplaced_uids:
        return []

    lessons = {l.uid: l for l in ctx.lessons}
    grouped: Dict[Tuple[str, str], int] = defaultdict(int)
    for uid in unplaced_uids:
        lesson = lessons[uid]
        grouped[(lesson.group_id, lesson.subject_id)] += 1

    # Ocupación resultante, para poder explicar quién estorbó.
    group_busy: Dict[str, set] = defaultdict(set)
    teacher_busy: Dict[str, set] = defaultdict(set)
    teacher_hours: Dict[str, int] = defaultdict(int)
    for uid, (slot, tid) in assignment.items():
        group_busy[lessons[uid].group_id].add(slot)
        teacher_busy[tid].add(slot)
        teacher_hours[tid] += 1

    conflicts: List[Conflict] = []
    for (gid, sid), missing in sorted(grouped.items()):
        group = ctx.groups[gid]
        subject = ctx.subjects[sid]
        elig = ctx.eligible.get((gid, sid), tuple())
        reason = _explain(
            ctx, gid, sid, elig, group_busy[gid], teacher_busy, teacher_hours
        )
        conflicts.append(
            Conflict(
                severity=Severity.ERROR,
                code="UNPLACED_HOURS",
                message=(
                    f"Faltaron {missing} h de {subject.name} en {group.label}. {reason}"
                ),
                group_id=gid,
                subject_id=sid,
                missing_hours=missing,
            )
        )
    return conflicts


def _explain(
    ctx: ProblemContext,
    gid: str,
    sid: str,
    eligible: Tuple[str, ...],
    group_busy: set,
    teacher_busy: Dict[str, set],
    teacher_hours: Dict[str, int],
) -> str:
    if not eligible:
        return "Ningún profesor puede impartirla: asígnala a alguien de la plantilla."

    free_group = ctx.group_slots[gid] - group_busy
    if not free_group:
        return "El grupo ya no tiene espacios libres en su rejilla; su plan de estudios llena la semana."

    saturated: List[str] = []
    no_overlap: List[str] = []
    for tid in eligible:
        teacher = ctx.teachers[tid]
        if teacher_hours[tid] >= ctx.teacher_max_weekly[tid]:
            saturated.append(teacher.name)
            continue
        if not (ctx.teacher_slots[tid] & free_group) - teacher_busy[tid]:
            no_overlap.append(teacher.name)

    if saturated and len(saturated) == len(eligible):
        nombres = ", ".join(saturated)
        return (
            f"Sus profesores ({nombres}) ya llegaron a su carga máxima semanal. "
            "Sube su tope de horas o reparte la materia con otro docente."
        )
    if no_overlap and len(no_overlap) + len(saturated) == len(eligible):
        nombres = ", ".join(no_overlap)
        return (
            f"Las horas libres del grupo no coinciden con la disponibilidad de {nombres} "
            "(o ya están dando clase a otro grupo en esos bloques). "
            "Libera disponibilidad o mueve otras materias del grupo."
        )
    return (
        "Sí existen huecos sueltos, pero ninguno compatible al mismo tiempo con el grupo "
        "y con sus profesores. Suele resolverse ampliando la disponibilidad de un docente, "
        "subiendo 'max_per_day' de la materia, o dando más segundos de cálculo."
    )
