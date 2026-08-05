"""Métricas de calidad del horario generado."""

from __future__ import annotations

from typing import Dict, Tuple

from ..models.schemas import Metrics, TeacherLoad
from .domain import ProblemContext


def teacher_gaps(ctx: ProblemContext, assignment: Dict[str, Tuple[int, str]]) -> Dict[str, int]:
    """
    Horas muertas por profesor: bloques libres entre su primera y su última clase
    de cada día. Es la métrica que más reclaman los docentes, así que se reporta
    aparte del score agregado.
    """
    per_day: Dict[Tuple[str, int], list] = {}
    for _uid, (slot_index, teacher_id) in assignment.items():
        slot = ctx.slots[slot_index]
        per_day.setdefault((teacher_id, slot.day_index), []).append(slot.block_index)

    gaps = {tid: 0 for tid in ctx.teacher_order}
    for (teacher_id, _day), blocks in per_day.items():
        if len(blocks) > 1:
            gaps[teacher_id] += (max(blocks) - min(blocks) + 1) - len(blocks)
    return gaps


def build_metrics(
    ctx: ProblemContext,
    assignment: Dict[str, Tuple[int, str]],
    *,
    restarts: int,
    elapsed_ms: int,
    soft_score: float,
) -> Metrics:
    placed = len(assignment)
    required = ctx.required_hours
    gaps = teacher_gaps(ctx, assignment)

    assigned_hours: Dict[str, int] = {tid: 0 for tid in ctx.teacher_order}
    for _uid, (_slot, teacher_id) in assignment.items():
        assigned_hours[teacher_id] += 1

    loads: Dict[str, TeacherLoad] = {}
    for tid in ctx.teacher_order:
        cap = ctx.teacher_max_weekly[tid]
        loads[tid] = TeacherLoad(
            assigned=assigned_hours[tid],
            max=cap,
            utilization=round(assigned_hours[tid] / cap, 3) if cap else 0.0,
            gaps=gaps[tid],
        )

    return Metrics(
        required_hours=required,
        placed_hours=placed,
        fill_rate=round(placed / required, 4) if required else 1.0,
        teacher_gaps=sum(gaps.values()),
        soft_score=soft_score,
        restarts=restarts,
        elapsed_ms=elapsed_ms,
        teacher_load=loads,
    )
