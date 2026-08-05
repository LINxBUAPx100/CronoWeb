"""
Orquestador: JSON de entrada -> ScheduleResponse.

Pipeline (el mismo, paso por paso, que el motor JS del navegador):

    compile → tutores → bind tutorías → validar → [abortar si ERROR]
            → backtracking → reparar → índices → métricas → diagnóstico → branding
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List

from ..core.branding import resolve_branding
from ..core.config import ENGINE_ID
from ..models.schemas import (
    Assignment,
    CellView,
    Conflict,
    ScheduleRequest,
    ScheduleResponse,
    Severity,
    SolveStatus,
)
from .domain import bind_tutor_lessons, compile_problem
from .metrics import build_metrics
from .report import diagnose_unplaced
from .scheduler import Scheduler, build_index_maps
from .tutors import assign_tutors, tutor_map
from .validator import has_blocking_errors, validate


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def generate_schedule(request: ScheduleRequest, plan: str = "free") -> ScheduleResponse:
    ctx = compile_problem(request)
    conflicts: List[Conflict] = []

    # 1. Tutores primero: su resultado se vuelve restricción dura de las materias
    #    marcadas `assign_to_tutor` y bonificación suave del resto.
    tutors, tutor_conflicts = assign_tutors(ctx)
    conflicts += tutor_conflicts
    by_group_tutor = tutor_map(tutors)
    bind_tutor_lessons(ctx, by_group_tutor)

    # 2. Pre-vuelo.
    validation = validate(ctx)
    conflicts += validation

    resolved_branding, branding_conflicts = resolve_branding(request.branding, plan)
    conflicts += branding_conflicts

    if has_blocking_errors(validation):
        # Imposible por construcción: no se quema tiempo de CPU buscando.
        return ScheduleResponse(
            status=SolveStatus.INFEASIBLE,
            generated_at=_now_iso(),
            engine=ENGINE_ID,
            tutors=tutors,
            conflicts=conflicts,
            metrics=build_metrics(ctx, {}, restarts=0, elapsed_ms=0, soft_score=0.0),
            branding=resolved_branding,
        )

    # 3. Búsqueda.
    scheduler = Scheduler(ctx, by_group_tutor, request.options)
    result = scheduler.solve()

    # 4. Salida estructurada.
    lessons = {l.uid: l for l in ctx.lessons}
    assignments = [
        Assignment(
            group_id=lessons[uid].group_id,
            subject_id=lessons[uid].subject_id,
            teacher_id=teacher_id,
            day=ctx.slots[slot].day,
            block_id=ctx.slots[slot].block_id,
        )
        for uid, (slot, teacher_id) in sorted(
            result.assignment.items(), key=lambda kv: (kv[1][0], kv[0])
        )
    ]

    raw_group, raw_teacher = build_index_maps(ctx, result.assignment)
    by_group = {
        gid: {day: {bid: CellView(**cell) for bid, cell in blocks.items()} for day, blocks in days.items()}
        for gid, days in raw_group.items()
    }
    by_teacher = {
        tid: {day: {bid: CellView(**cell) for bid, cell in blocks.items()} for day, blocks in days.items()}
        for tid, days in raw_teacher.items()
    }

    conflicts += diagnose_unplaced(ctx, result.assignment, result.unplaced)

    metrics = build_metrics(
        ctx,
        result.assignment,
        restarts=result.restarts,
        elapsed_ms=result.elapsed_ms,
        soft_score=result.soft_score,
    )

    if result.complete:
        status = SolveStatus.OK
    elif request.options.allow_partial:
        status = SolveStatus.PARTIAL
    else:
        status = SolveStatus.INFEASIBLE

    return ScheduleResponse(
        status=status,
        generated_at=_now_iso(),
        engine=ENGINE_ID,
        tutors=tutors,
        assignments=assignments,
        by_group=by_group,
        by_teacher=by_teacher,
        conflicts=conflicts,
        metrics=metrics,
        branding=resolved_branding,
    )


def validate_only(request: ScheduleRequest, plan: str = "free") -> ScheduleResponse:
    """Pre-vuelo sin resolver: útil para avisar en el UI mientras se capturan datos."""
    ctx = compile_problem(request)
    tutors, tutor_conflicts = assign_tutors(ctx)
    bind_tutor_lessons(ctx, tutor_map(tutors))
    conflicts = tutor_conflicts + validate(ctx)
    resolved_branding, branding_conflicts = resolve_branding(request.branding, plan)
    conflicts += branding_conflicts

    status = SolveStatus.INFEASIBLE if has_blocking_errors(conflicts) else SolveStatus.OK
    return ScheduleResponse(
        status=status,
        generated_at=_now_iso(),
        engine=ENGINE_ID,
        tutors=tutors,
        conflicts=conflicts,
        metrics=build_metrics(ctx, {}, restarts=0, elapsed_ms=0, soft_score=0.0),
        branding=resolved_branding,
    )
