"""Endpoints del generador de horarios."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, status

from ..core.config import PLAN_FEATURES, plan_features, settings
from ..models.schemas import ScheduleRequest, ScheduleResponse
from ..solver.engine import generate_schedule, validate_only

router = APIRouter(prefix="/api/v1", tags=["schedule"])

_SAMPLES_DIR = Path(__file__).resolve().parents[2] / "samples"


def _resolve_plan(x_cronoweb_plan: Optional[str]) -> str:
    """
    Resolución de plan.

    Hoy: header opcional + default de configuración. Mañana: se cambia esta función
    por una consulta de licencia (tenant -> plan) y nada más del código se entera.
    """
    return (x_cronoweb_plan or settings.default_plan).lower()


def _enforce_plan_limits(request: ScheduleRequest, plan: str) -> None:
    features = plan_features(plan)
    if len(request.groups) > features.max_groups:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(
                f"El plan «{features.label}» permite hasta {features.max_groups} grupos "
                f"y se enviaron {len(request.groups)}."
            ),
        )
    if len(request.teachers) > features.max_teachers:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(
                f"El plan «{features.label}» permite hasta {features.max_teachers} profesores "
                f"y se enviaron {len(request.teachers)}."
            ),
        )
    # El presupuesto de CPU se recorta en silencio: es un límite de infraestructura,
    # no un error del usuario.
    if request.options.time_budget_seconds > features.max_time_budget_seconds:
        request.options.time_budget_seconds = features.max_time_budget_seconds


@router.post("/schedule/generate", response_model=ScheduleResponse)
def post_generate(
    request: ScheduleRequest,
    x_cronoweb_plan: Optional[str] = Header(default=None, alias="X-CronoWeb-Plan"),
) -> ScheduleResponse:
    plan = _resolve_plan(x_cronoweb_plan)
    _enforce_plan_limits(request, plan)
    return generate_schedule(request, plan=plan)


@router.post("/schedule/validate", response_model=ScheduleResponse)
def post_validate(
    request: ScheduleRequest,
    x_cronoweb_plan: Optional[str] = Header(default=None, alias="X-CronoWeb-Plan"),
) -> ScheduleResponse:
    plan = _resolve_plan(x_cronoweb_plan)
    _enforce_plan_limits(request, plan)
    return validate_only(request, plan=plan)


@router.get("/plans")
def get_plans() -> dict:
    return {
        "currency": "MXN",
        "plans": [
            {
                "key": p.key,
                "label": p.label,
                "price_year": p.price_mxn_year,
                "custom_branding": p.custom_branding,
                "max_groups": p.max_groups,
                "max_teachers": p.max_teachers,
                "persistence": p.persistence,
                "api_access": p.api_access,
                "notes": p.notes,
            }
            for p in PLAN_FEATURES.values()
        ],
    }


@router.get("/samples/demo")
def get_demo_sample() -> dict:
    """Escenario de ejemplo (secundaria de 6 grupos) para probar el motor de inmediato."""
    path = _SAMPLES_DIR / "demo_secundaria.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Ejemplo no disponible en esta instalación")
    return json.loads(path.read_text(encoding="utf-8"))
