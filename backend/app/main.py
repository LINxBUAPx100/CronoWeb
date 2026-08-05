"""
CronoWeb API.

El MVP publicado en GitHub Pages NO necesita este servidor: el mismo algoritmo
corre en el navegador (`assets/js/engine/`). Este backend existe para el modo de
pago —cálculos grandes, licencias por escuela, persistencia e integraciones— y
respeta exactamente el mismo contrato JSON, de modo que el frontend cambia de
motor con una bandera (`?engine=remote`).

Arranque local:
    py -m pip install -r backend/requirements.txt
    py -m uvicorn backend.app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes_schedule import router as schedule_router
from .core.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("cronoweb")

app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="Generador de horarios escolares por satisfacción de restricciones (CSP).",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-CronoWeb-Plan"],
)

app.include_router(schedule_router)


@app.get("/api/v1/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "version": settings.version, "engine": "python-backtracking-1.0"}


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """
    422 legible.

    Pydantic devuelve rutas tipo `body.groups.0.curriculum.2.weekly_hours`; se
    traducen a un mensaje plano para poder pintarlo tal cual en el UI.
    """
    detalles = []
    for err in exc.errors():
        campo = ".".join(str(p) for p in err.get("loc", []) if p != "body")
        detalles.append({"campo": campo or "(raíz)", "error": err.get("msg", "dato inválido")})
    logger.warning("Petición inválida: %s", detalles)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "status": "invalid_request",
            "message": "Los datos enviados no cumplen el contrato de CronoWeb.",
            "errors": detalles,
        },
    )


@app.exception_handler(Exception)
async def unhandled_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Error no controlado", exc_info=exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "status": "error",
            "message": "Ocurrió un error inesperado al generar el horario.",
        },
    )


# Sirve el mismo frontend estático que se publica en GitHub Pages, para poder
# probar el modo remoto sin montar un segundo servidor.
if settings.serve_frontend:
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    if (root / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(root), html=True), name="frontend")
