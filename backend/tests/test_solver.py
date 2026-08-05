"""
Pruebas del motor.

El test central es `assert_hard_constraints`: un verificador INDEPENDIENTE del
solver que revisa el horario producido contra el enunciado original. Si el solver
se rompe, esta función lo detecta aunque el solver crea que todo salió bien.

    py -m pytest backend/tests -q
"""

from __future__ import annotations

import copy
import json
from collections import defaultdict
from pathlib import Path

import pytest

from backend.app.core.branding import resolve_branding
from backend.app.models.schemas import (
    AvailabilityMode,
    Branding,
    BrandingMode,
    ScheduleRequest,
    ScheduleResponse,
    Severity,
    SolveStatus,
)
from backend.app.solver.engine import generate_schedule

SAMPLE = Path(__file__).resolve().parents[1] / "samples" / "demo_secundaria.json"


@pytest.fixture(scope="module")
def demo_payload() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# Verificador independiente
# --------------------------------------------------------------------------- #
def assert_hard_constraints(request: ScheduleRequest, response: ScheduleResponse) -> None:
    teachers = {t.id: t for t in request.teachers}
    groups = {g.id: g for g in request.groups}
    class_blocks = {b.id for b in request.grid.class_blocks}
    tutor_of = {t.group_id: t.teacher_id for t in response.tutors}

    teacher_slot: dict[tuple[str, str, str], str] = {}
    group_slot: dict[tuple[str, str, str], str] = {}
    weekly = defaultdict(int)
    daily = defaultdict(int)
    per_day_subject = defaultdict(int)
    placed = defaultdict(int)

    for a in response.assignments:
        assert a.block_id in class_blocks, f"{a.block_id} no es un bloque de clase"
        assert a.day in request.grid.days, f"{a.day} no existe en la rejilla"

        # H1/H2 — sin cruces: una sola clase por (profesor, día, bloque) y por (grupo, día, bloque).
        tkey = (a.teacher_id, a.day, a.block_id)
        assert tkey not in teacher_slot, f"CRUCE: {a.teacher_id} en dos lugares en {a.day}-{a.block_id}"
        teacher_slot[tkey] = a.group_id

        gkey = (a.group_id, a.day, a.block_id)
        assert gkey not in group_slot, f"CRUCE: grupo {a.group_id} con dos clases en {a.day}-{a.block_id}"
        group_slot[gkey] = a.teacher_id

        # H3 — disponibilidad.
        teacher = teachers[a.teacher_id]
        matrix = teacher.availability or {}
        if matrix:
            listed = a.block_id in set(matrix.get(a.day, []))
            if teacher.availability_mode is AvailabilityMode.WHITELIST:
                assert listed, f"{a.teacher_id} asignado fuera de su whitelist ({a.day}-{a.block_id})"
            else:
                assert not listed, f"{a.teacher_id} asignado en hora bloqueada ({a.day}-{a.block_id})"

        # H6 — elegibilidad.
        entry = next(c for c in groups[a.group_id].curriculum if c.subject_id == a.subject_id)
        if entry.assign_to_tutor:
            assert a.teacher_id == tutor_of[a.group_id], "materia de tutoría impartida por quien no es tutor"
        elif entry.fixed_teacher_id:
            assert a.teacher_id == entry.fixed_teacher_id, "no se respetó fixed_teacher_id"
        else:
            assert a.subject_id in teacher.subject_ids, f"{a.teacher_id} no imparte {a.subject_id}"

        weekly[a.teacher_id] += 1
        daily[(a.teacher_id, a.day)] += 1
        per_day_subject[(a.group_id, a.subject_id, a.day)] += 1
        placed[(a.group_id, a.subject_id)] += 1

    # H4 — cargas.
    for tid, hours in weekly.items():
        assert hours <= teachers[tid].max_weekly_hours, f"{tid} rebasa su carga semanal"
    for (tid, _day), hours in daily.items():
        cap = teachers[tid].max_daily_hours or len(class_blocks)
        assert hours <= cap, f"{tid} rebasa su carga diaria"

    # H5 — tope diario por materia; y horas exactas del plan.
    for gid, group in groups.items():
        for c in group.curriculum:
            for day in request.grid.days:
                assert per_day_subject[(gid, c.subject_id, day)] <= c.max_per_day, (
                    f"{gid}/{c.subject_id} excede max_per_day en {day}"
                )
            assert placed[(gid, c.subject_id)] <= c.weekly_hours, (
                f"{gid}/{c.subject_id} tiene MÁS horas que las pedidas"
            )

    # Slots bloqueados del grupo.
    for gid, group in groups.items():
        for blocked in group.blocked_slots:
            assert (gid, blocked.day, blocked.block_id) not in group_slot, (
                f"{gid} recibió clase en un bloque bloqueado"
            )


# --------------------------------------------------------------------------- #
def test_demo_se_resuelve_completo(demo_payload):
    request = ScheduleRequest.model_validate(demo_payload)
    response = generate_schedule(request, plan="free")

    assert response.status is SolveStatus.OK, [c.message for c in response.conflicts]
    assert response.metrics.placed_hours == response.metrics.required_hours
    assert_hard_constraints(request, response)


def test_todas_las_horas_del_plan_quedan_cubiertas(demo_payload):
    request = ScheduleRequest.model_validate(demo_payload)
    response = generate_schedule(request, plan="free")

    colocadas = defaultdict(int)
    for a in response.assignments:
        colocadas[(a.group_id, a.subject_id)] += 1
    for g in request.groups:
        for c in g.curriculum:
            assert colocadas[(g.id, c.subject_id)] == c.weekly_hours


def test_tutores_uno_a_uno_cuando_sobran_profesores(demo_payload):
    request = ScheduleRequest.model_validate(demo_payload)
    response = generate_schedule(request, plan="free")

    asignados = [t.teacher_id for t in response.tutors]
    assert len(response.tutors) == len(request.groups)
    assert all(t is not None for t in asignados)
    assert len(set(asignados)) == len(asignados), "hay tutores repetidos habiendo profesores libres"
    assert not any(t.shared for t in response.tutors)


def test_tutores_se_comparten_cuando_faltan_profesores(demo_payload):
    """Con menos profesores elegibles que grupos, se permite repetir por menor carga."""
    payload = copy.deepcopy(demo_payload)
    for i, teacher in enumerate(payload["teachers"]):
        teacher["can_be_tutor"] = i < 4          # sólo 4 candidatos para 6 grupos
    request = ScheduleRequest.model_validate(payload)
    response = generate_schedule(request, plan="free")

    asignados = [t.teacher_id for t in response.tutors]
    assert all(t is not None for t in asignados)
    assert len(set(asignados)) == 4
    assert sum(1 for t in response.tutors if t.shared) >= 2
    assert any(c.code == "TUTORS_SHARED" for c in response.conflicts)


def test_disponibilidad_estricta_se_respeta(demo_payload):
    """T10 sólo asiste LUN/MIE/VIE (whitelist) y T02 no trabaja los viernes (blacklist)."""
    request = ScheduleRequest.model_validate(demo_payload)
    response = generate_schedule(request, plan="free")

    dias_t10 = {a.day for a in response.assignments if a.teacher_id == "T10"}
    assert dias_t10 <= {"LUN", "MIE", "VIE"}
    assert not any(a.teacher_id == "T02" and a.day == "VIE" for a in response.assignments)


def test_materia_sin_profesor_es_infactible(demo_payload):
    payload = copy.deepcopy(demo_payload)
    for teacher in payload["teachers"]:
        teacher["subject_ids"] = [s for s in teacher["subject_ids"] if s != "MAT"]
    response = generate_schedule(ScheduleRequest.model_validate(payload), plan="free")

    assert response.status is SolveStatus.INFEASIBLE
    assert any(c.code == "NO_ELIGIBLE_TEACHER" for c in response.conflicts)
    assert response.assignments == []


def test_plan_de_estudios_mas_grande_que_la_rejilla(demo_payload):
    payload = copy.deepcopy(demo_payload)
    payload["groups"][0]["curriculum"][0]["weekly_hours"] = 40   # 40 + resto > 40 slots
    response = generate_schedule(ScheduleRequest.model_validate(payload), plan="free")

    assert response.status is SolveStatus.INFEASIBLE
    assert any(c.code == "GROUP_OVER_CAPACITY" for c in response.conflicts)


def test_horario_parcial_reporta_horas_faltantes(demo_payload):
    """Al recortar la plantilla, el motor devuelve el mejor parcial + diagnóstico."""
    payload = copy.deepcopy(demo_payload)
    for teacher in payload["teachers"]:
        if "ESP" in teacher["subject_ids"]:
            teacher["max_weekly_hours"] = 8          # 16 h para 30 h de Español
    payload["options"]["time_budget_seconds"] = 3.0
    request = ScheduleRequest.model_validate(payload)
    response = generate_schedule(request, plan="free")

    assert response.status in (SolveStatus.PARTIAL, SolveStatus.INFEASIBLE)
    faltantes = [c for c in response.conflicts if c.missing_hours]
    assert faltantes, "un horario incompleto debe explicar qué horas faltaron"
    if response.status is SolveStatus.PARTIAL:
        # Lo que sí colocó tiene que ser válido: nunca se entrega un horario con cruces.
        assert_hard_constraints(request, response)


def test_fixed_teacher_se_respeta(demo_payload):
    payload = copy.deepcopy(demo_payload)
    for c in payload["groups"][0]["curriculum"]:
        if c["subject_id"] == "MAT":
            c["fixed_teacher_id"] = "T03"
    request = ScheduleRequest.model_validate(payload)
    response = generate_schedule(request, plan="free")

    mat = [a for a in response.assignments if a.group_id == "1A" and a.subject_id == "MAT"]
    assert mat and all(a.teacher_id == "T03" for a in mat)
    assert_hard_constraints(request, response)


def test_resultado_reproducible_con_la_misma_semilla(demo_payload):
    request = ScheduleRequest.model_validate(demo_payload)
    a = generate_schedule(request, plan="free")
    b = generate_schedule(ScheduleRequest.model_validate(demo_payload), plan="free")
    firma = lambda r: sorted((x.group_id, x.subject_id, x.teacher_id, x.day, x.block_id) for x in r.assignments)
    assert firma(a) == firma(b)


# --------------------------------------------------------------------------- #
# Branding / planes
# --------------------------------------------------------------------------- #
def test_plan_free_degrada_a_modo_simple():
    branding = Branding(
        mode=BrandingMode.CUSTOM,
        school_name="Secundaria Benito Juárez",
        logo_data_url="data:image/png;base64,AAA",
        primary_color="#ff0000",
    )
    resolved, conflicts = resolve_branding(branding, "free")

    assert resolved.mode is BrandingMode.SIMPLE
    assert resolved.school_name is None and resolved.logo_data_url is None
    assert resolved.watermark_required and resolved.watermark_text == "CronoWeb.com"
    assert any(c.code == "BRANDING_DOWNGRADED" and c.severity is Severity.INFO for c in conflicts)


def test_plan_escuela_permite_personalizacion():
    branding = Branding(
        mode=BrandingMode.CUSTOM,
        school_name="Secundaria Benito Juárez",
        logo_data_url="data:image/png;base64,AAA",
    )
    resolved, conflicts = resolve_branding(branding, "school")

    assert resolved.mode is BrandingMode.CUSTOM
    assert resolved.school_name == "Secundaria Benito Juárez"
    assert resolved.show_logo is True
    # La marca de agua sobrevive incluso en el plan de pago (crédito al pie).
    assert resolved.watermark_required is True
    assert conflicts == []
