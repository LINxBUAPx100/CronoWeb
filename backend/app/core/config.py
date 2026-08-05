"""
Configuración y catálogo de planes.

Hoy el MVP corre 100 % en el navegador (GitHub Pages) y este backend es opcional.
Cuando exista cobro, este archivo es el único lugar donde se decide qué puede hacer
cada plan: el resto del código sólo pregunta `plan_features(plan)`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List

ENGINE_ID = "python-backtracking-1.0"


@dataclass(frozen=True)
class PlanFeatures:
    """Límites y capacidades de un plan comercial."""

    key: str
    label: str
    price_mxn_year: int
    custom_branding: bool          # logo + nombre de escuela en el PNG
    remove_watermark: bool         # nunca es True hoy: la marca es el canal de adquisición
    max_groups: int
    max_teachers: int
    max_time_budget_seconds: float
    persistence: bool              # guardar escenarios en servidor (v2)
    api_access: bool               # integración con control escolar (v2)
    notes: str = ""


# El precio ancla es $1,800 MXN/año por escuela. Los tramos superiores existen para
# no re-arquitecturar el día que una zona escolar quiera 20 planteles.
PLAN_FEATURES: Dict[str, PlanFeatures] = {
    "free": PlanFeatures(
        key="free",
        label="Modo simple",
        price_mxn_year=0,
        custom_branding=False,
        remove_watermark=False,
        max_groups=12,
        max_teachers=40,
        max_time_budget_seconds=10.0,
        persistence=False,
        api_access=False,
        notes="Uso local en el navegador. Marca de agua CronoWeb.com obligatoria.",
    ),
    "school": PlanFeatures(
        key="school",
        label="Escuela",
        price_mxn_year=1800,
        custom_branding=True,
        remove_watermark=False,
        max_groups=60,
        max_teachers=200,
        max_time_budget_seconds=60.0,
        persistence=True,
        api_access=False,
    ),
    "zone": PlanFeatures(
        key="zone",
        label="Zona escolar",
        price_mxn_year=12000,
        custom_branding=True,
        remove_watermark=False,
        max_groups=600,
        max_teachers=2000,
        max_time_budget_seconds=120.0,
        persistence=True,
        api_access=True,
    ),
}

DEFAULT_PLAN = "free"


def plan_features(plan: str | None) -> PlanFeatures:
    """Devuelve las capacidades del plan; cae a `free` ante cualquier valor desconocido."""
    return PLAN_FEATURES.get((plan or DEFAULT_PLAN).lower(), PLAN_FEATURES[DEFAULT_PLAN])


@dataclass
class Settings:
    app_name: str = "CronoWeb API"
    version: str = "1.0.0"
    # Orígenes permitidos: el sitio de GitHub Pages y desarrollo local.
    cors_origins: List[str] = field(
        default_factory=lambda: [
            o.strip()
            for o in os.getenv(
                "CRONOWEB_CORS_ORIGINS",
                "https://linxbuapx100.github.io,https://cronoweb.com,"
                "http://localhost:5173,http://localhost:8000,http://127.0.0.1:8000",
            ).split(",")
            if o.strip()
        ]
    )
    # Resolución de plan. Sin base de datos todavía: se toma de un header o del env.
    default_plan: str = os.getenv("CRONOWEB_DEFAULT_PLAN", DEFAULT_PLAN)
    serve_frontend: bool = os.getenv("CRONOWEB_SERVE_FRONTEND", "1") == "1"
    max_request_bytes: int = int(os.getenv("CRONOWEB_MAX_REQUEST_BYTES", 8 * 1024 * 1024))


settings = Settings()
