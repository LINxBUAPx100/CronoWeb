"""
CronoWeb — Contrato de datos (Pydantic v2).

Implementa `docs/CONTRACT.md`. Toda validación *estructural* (tipos, rangos,
integridad referencial) vive aquí; la validación *de factibilidad* (¿alcanzan las
horas? ¿hay profesor para esta materia?) vive en `app/solver/validator.py`.

Separarlas importa: lo de aquí devuelve HTTP 422 (el cliente mandó basura), lo del
validador devuelve HTTP 200 con `status: "infeasible"` (el cliente mandó datos
correctos pero imposibles, y merece un reporte legible, no un stack trace).
"""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0"


# --------------------------------------------------------------------------- #
# Enums
# --------------------------------------------------------------------------- #
class BlockKind(str, Enum):
    CLASS = "class"
    BREAK = "break"


class AvailabilityMode(str, Enum):
    BLACKLIST = "blacklist"
    WHITELIST = "whitelist"


class BrandingMode(str, Enum):
    SIMPLE = "simple"
    CUSTOM = "custom"


class SolveStatus(str, Enum):
    OK = "ok"
    PARTIAL = "partial"
    INFEASIBLE = "infeasible"


class Severity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# --------------------------------------------------------------------------- #
# X — Rejilla horaria
# --------------------------------------------------------------------------- #
class Block(_Base):
    id: str = Field(min_length=1, max_length=16)
    label: str = Field(min_length=1, max_length=32)
    start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    kind: BlockKind = BlockKind.CLASS

    @model_validator(mode="after")
    def _end_after_start(self) -> "Block":
        if self.end <= self.start:  # comparación lexicográfica válida en HH:MM
            raise ValueError(f"Bloque {self.id}: 'end' ({self.end}) debe ser mayor que 'start' ({self.start})")
        return self


class TimeGrid(_Base):
    days: List[str] = Field(min_length=1, max_length=7)
    blocks: List[Block] = Field(min_length=1, max_length=24)

    @field_validator("days")
    @classmethod
    def _unique_days(cls, v: List[str]) -> List[str]:
        if len(set(v)) != len(v):
            raise ValueError("grid.days contiene días repetidos")
        return v

    @model_validator(mode="after")
    def _unique_blocks(self) -> "TimeGrid":
        ids = [b.id for b in self.blocks]
        if len(set(ids)) != len(ids):
            raise ValueError("grid.blocks contiene ids repetidos")
        if not any(b.kind is BlockKind.CLASS for b in self.blocks):
            raise ValueError("grid.blocks debe tener al menos un bloque de tipo 'class'")
        return self

    @property
    def class_blocks(self) -> List[Block]:
        return [b for b in self.blocks if b.kind is BlockKind.CLASS]


# --------------------------------------------------------------------------- #
# Materias
# --------------------------------------------------------------------------- #
class Subject(_Base):
    id: str = Field(min_length=1, max_length=24)
    name: str = Field(min_length=1, max_length=80)
    short_name: Optional[str] = Field(default=None, max_length=16)
    color: Optional[str] = Field(default=None, pattern=r"^#(?:[0-9a-fA-F]{3}){1,2}$")
    prefers_morning: bool = False
    room_requirement: Optional[str] = None  # reservado v2

    @property
    def display_short(self) -> str:
        return self.short_name or self.name[:6]


# --------------------------------------------------------------------------- #
# Y — Profesores
# --------------------------------------------------------------------------- #
class Teacher(_Base):
    id: str = Field(min_length=1, max_length=24)
    name: str = Field(min_length=1, max_length=80)
    subject_ids: List[str] = Field(default_factory=list)
    max_weekly_hours: int = Field(ge=0, le=80)
    max_daily_hours: Optional[int] = Field(default=None, ge=0, le=24)
    availability_mode: AvailabilityMode = AvailabilityMode.BLACKLIST
    availability: Optional[Dict[str, List[str]]] = None
    can_be_tutor: bool = True
    tutor_priority: int = Field(default=0, ge=-100, le=100)
    notes: Optional[str] = Field(default=None, max_length=280)


# --------------------------------------------------------------------------- #
# Z / W — Grados y grupos
# --------------------------------------------------------------------------- #
class SlotRef(_Base):
    day: str
    block_id: str


class CurriculumEntry(_Base):
    subject_id: str
    weekly_hours: int = Field(ge=0, le=40)
    max_per_day: int = Field(default=2, ge=1, le=24)
    preferred_teacher_id: Optional[str] = None
    fixed_teacher_id: Optional[str] = None
    assign_to_tutor: bool = False

    @model_validator(mode="after")
    def _exclusive_teacher_rules(self) -> "CurriculumEntry":
        if self.assign_to_tutor and self.fixed_teacher_id:
            raise ValueError("'assign_to_tutor' y 'fixed_teacher_id' son mutuamente excluyentes")
        return self


class Group(_Base):
    id: str = Field(min_length=1, max_length=24)
    grade: str = Field(min_length=1, max_length=24)
    name: str = Field(min_length=1, max_length=24)
    # Nivel educativo ("primaria" | "secundaria" | "preparatoria"). Opcional y
    # libre a propósito: el solver no lo usa, pero viaja para las etiquetas y
    # para distinguir el 1°A de primaria del 1°A de secundaria.
    level: Optional[str] = Field(default=None, max_length=24)
    # Periodo del bachillerato ("3er semestre", "2° cuatrimestre"). Sólo lo traen
    # los grupos de preparatoria, donde el grupo ES su periodo. Como `level`, el
    # solver no lo usa: viaja para que la hoja impresa diga lo que la prepa dice.
    term_label: Optional[str] = Field(default=None, max_length=32)
    shift: Optional[str] = Field(default=None, max_length=24)
    blocked_slots: List[SlotRef] = Field(default_factory=list)
    curriculum: List[CurriculumEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_subjects(self) -> "Group":
        ids = [c.subject_id for c in self.curriculum]
        if len(set(ids)) != len(ids):
            raise ValueError(f"Grupo {self.id}: una materia aparece dos veces en el plan de estudios")
        return self

    @property
    def label(self) -> str:
        return f"{self.grade}{self.name}"

    @property
    def total_weekly_hours(self) -> int:
        return sum(c.weekly_hours for c in self.curriculum)


# --------------------------------------------------------------------------- #
# Opciones del solver
# --------------------------------------------------------------------------- #
class SoftWeights(_Base):
    """Costos de las restricciones suaves. Menor costo = mejor horario."""

    same_day_repeat: float = 6.0        # repetir materia el mismo día
    teacher_gap: float = 3.0            # hueco (hora muerta) en el día del profesor
    morning_preference: float = 1.5     # materia 'prefers_morning' en bloque tardío
    tutor_affinity: float = -4.0        # bonificación: el tutor da clase a su grupo
    preferred_teacher: float = 2.5      # no respetar 'preferred_teacher_id'
    daily_balance: float = 0.75         # concentrar demasiadas horas del profesor en un día
    late_block_penalty: float = 0.5     # empuja a llenar temprano y dejar libre el final
    teacher_utilization: float = 5.0    # penaliza acercarse al tope semanal del profesor


class SolverOptions(_Base):
    time_budget_seconds: float = Field(default=8.0, gt=0, le=120)
    max_restarts: int = Field(default=6, ge=0, le=100)
    max_branch: int = Field(default=8, ge=0, le=512)   # 0 = sin poda
    mrv_sample: int = Field(default=48, ge=1, le=5000)
    seed: int = 12345
    enable_repair: bool = True
    allow_partial: bool = True
    weights: SoftWeights = Field(default_factory=SoftWeights)


# --------------------------------------------------------------------------- #
# Branding / planes
# --------------------------------------------------------------------------- #
class Branding(_Base):
    mode: BrandingMode = BrandingMode.SIMPLE
    school_name: Optional[str] = Field(default=None, max_length=120)
    logo_data_url: Optional[str] = Field(default=None, max_length=2_000_000)
    primary_color: str = Field(default="#14417c", pattern=r"^#(?:[0-9a-fA-F]{3}){1,2}$")
    cycle_label: Optional[str] = Field(default=None, max_length=60)
    footer_note: Optional[str] = Field(default=None, max_length=160)

    @field_validator("logo_data_url")
    @classmethod
    def _only_data_urls(cls, v: Optional[str]) -> Optional[str]:
        # Se embebe en el DOM y luego en el PNG: sólo data: URLs de imagen.
        # Evita que html2canvas intente cargar un host remoto (y falle por CORS).
        if v and not v.startswith("data:image/"):
            raise ValueError("logo_data_url debe ser una data URL de imagen (data:image/...)")
        return v


class ResolvedBranding(_Base):
    """Branding efectivo tras aplicar el plan del tenant. Es lo que el UI debe pintar."""

    mode: BrandingMode
    plan: str
    school_name: Optional[str] = None
    logo_data_url: Optional[str] = None
    primary_color: str = "#14417c"
    cycle_label: Optional[str] = None
    footer_note: Optional[str] = None
    show_logo: bool = False
    watermark_text: str = "CronoWeb.com"
    watermark_required: bool = True
    downgraded: bool = False


# --------------------------------------------------------------------------- #
# Request raíz
# --------------------------------------------------------------------------- #
class ScheduleRequest(_Base):
    schema_version: str = SCHEMA_VERSION
    tenant_id: Optional[str] = Field(default=None, max_length=64)
    grid: TimeGrid
    subjects: List[Subject] = Field(min_length=1)
    teachers: List[Teacher] = Field(min_length=1)
    groups: List[Group] = Field(min_length=1)
    options: SolverOptions = Field(default_factory=SolverOptions)
    branding: Branding = Field(default_factory=Branding)

    @field_validator("schema_version")
    @classmethod
    def _supported_version(cls, v: str) -> str:
        major = v.split(".")[0]
        if major != SCHEMA_VERSION.split(".")[0]:
            raise ValueError(f"schema_version {v} no soportada; se espera {SCHEMA_VERSION}")
        return v

    @model_validator(mode="after")
    def _referential_integrity(self) -> "ScheduleRequest":
        """Integridad referencial: todo ID citado debe existir. Falla rápido y claro."""
        errors: List[str] = []

        def _dupes(kind: str, ids: List[str]) -> None:
            seen, dup = set(), set()
            for i in ids:
                (dup if i in seen else seen).add(i)
            if dup:
                errors.append(f"{kind} con id duplicado: {sorted(dup)}")

        subject_ids = {s.id for s in self.subjects}
        teacher_ids = {t.id for t in self.teachers}
        day_set = set(self.grid.days)
        block_ids = {b.id for b in self.grid.blocks}
        class_block_ids = {b.id for b in self.grid.class_blocks}

        _dupes("subjects", [s.id for s in self.subjects])
        _dupes("teachers", [t.id for t in self.teachers])
        _dupes("groups", [g.id for g in self.groups])

        for t in self.teachers:
            unknown = sorted(set(t.subject_ids) - subject_ids)
            if unknown:
                errors.append(f"Profesor {t.id}: materias inexistentes {unknown}")
            for day, blocks in (t.availability or {}).items():
                if day not in day_set:
                    errors.append(f"Profesor {t.id}: día '{day}' no existe en grid.days")
                bad = sorted(set(blocks) - block_ids)
                if bad:
                    errors.append(f"Profesor {t.id}: bloques inexistentes {bad} en '{day}'")

        for g in self.groups:
            for slot in g.blocked_slots:
                if slot.day not in day_set:
                    errors.append(f"Grupo {g.id}: blocked_slots usa día inexistente '{slot.day}'")
                if slot.block_id not in block_ids:
                    errors.append(f"Grupo {g.id}: blocked_slots usa bloque inexistente '{slot.block_id}'")
            for c in g.curriculum:
                if c.subject_id not in subject_ids:
                    errors.append(f"Grupo {g.id}: materia inexistente '{c.subject_id}'")
                for field_name in ("preferred_teacher_id", "fixed_teacher_id"):
                    tid = getattr(c, field_name)
                    if tid and tid not in teacher_ids:
                        errors.append(f"Grupo {g.id}/{c.subject_id}: {field_name} inexistente '{tid}'")

        if not class_block_ids:
            errors.append("No hay bloques asignables (kind='class') en la rejilla")

        if errors:
            raise ValueError("; ".join(errors))
        return self


# --------------------------------------------------------------------------- #
# Response
# --------------------------------------------------------------------------- #
class TutorAssignment(_Base):
    group_id: str
    teacher_id: Optional[str]
    shared: bool = False
    estimated_load: float = 0.0
    reason: str = ""


class Assignment(_Base):
    group_id: str
    subject_id: str
    teacher_id: str
    day: str
    block_id: str


class Conflict(_Base):
    severity: Severity
    code: str
    message: str
    group_id: Optional[str] = None
    subject_id: Optional[str] = None
    teacher_id: Optional[str] = None
    missing_hours: Optional[int] = None


class TeacherLoad(_Base):
    assigned: int
    max: int
    utilization: float
    gaps: int = 0


class Metrics(_Base):
    required_hours: int
    placed_hours: int
    fill_rate: float
    teacher_gaps: int
    soft_score: float
    restarts: int
    elapsed_ms: int
    teacher_load: Dict[str, TeacherLoad] = Field(default_factory=dict)


class CellView(_Base):
    subject_id: str
    teacher_id: Optional[str] = None
    group_id: Optional[str] = None


class ScheduleResponse(_Base):
    schema_version: str = SCHEMA_VERSION
    status: SolveStatus
    generated_at: str
    engine: str
    tutors: List[TutorAssignment] = Field(default_factory=list)
    assignments: List[Assignment] = Field(default_factory=list)
    by_group: Dict[str, Dict[str, Dict[str, CellView]]] = Field(default_factory=dict)
    by_teacher: Dict[str, Dict[str, Dict[str, CellView]]] = Field(default_factory=dict)
    conflicts: List[Conflict] = Field(default_factory=list)
    metrics: Optional[Metrics] = None
    branding: Optional[ResolvedBranding] = None
