"""
Resolución de branding según el plan.

Regla de negocio: la marca de agua **CronoWeb.com** nunca desaparece del PNG.
En modo simple es el sello grande; en modo personalizado se degrada a crédito
discreto al pie. Si un plan sin `custom_branding` pide modo personalizado, se
degrada silenciosamente a simple y se devuelve un conflicto `info` (no un error:
el horario sí se generó).
"""

from __future__ import annotations

from typing import List, Tuple

from ..models.schemas import Branding, BrandingMode, Conflict, ResolvedBranding, Severity
from .config import plan_features

WATERMARK_TEXT = "CronoWeb.com"


def resolve_branding(branding: Branding, plan: str) -> Tuple[ResolvedBranding, List[Conflict]]:
    features = plan_features(plan)
    conflicts: List[Conflict] = []

    wants_custom = branding.mode is BrandingMode.CUSTOM
    allowed_custom = wants_custom and features.custom_branding
    downgraded = wants_custom and not features.custom_branding

    if downgraded:
        conflicts.append(
            Conflict(
                severity=Severity.INFO,
                code="BRANDING_DOWNGRADED",
                message=(
                    f"El plan «{features.label}» no incluye personalización; "
                    "el horario se generó en modo simple con marca de agua CronoWeb.com."
                ),
            )
        )

    if allowed_custom:
        resolved = ResolvedBranding(
            mode=BrandingMode.CUSTOM,
            plan=features.key,
            school_name=branding.school_name,
            logo_data_url=branding.logo_data_url,
            primary_color=branding.primary_color,
            cycle_label=branding.cycle_label,
            footer_note=branding.footer_note,
            show_logo=bool(branding.logo_data_url),
            watermark_text=WATERMARK_TEXT,
            # En plan de pago la marca sigue presente, pero como crédito al pie.
            watermark_required=not features.remove_watermark,
            downgraded=False,
        )
    else:
        # Modo simple: se descarta todo dato de identidad de la escuela.
        resolved = ResolvedBranding(
            mode=BrandingMode.SIMPLE,
            plan=features.key,
            school_name=None,
            logo_data_url=None,
            primary_color="#14417c",
            cycle_label=branding.cycle_label,
            footer_note=None,
            show_logo=False,
            watermark_text=WATERMARK_TEXT,
            watermark_required=True,
            downgraded=downgraded,
        )

    return resolved, conflicts
