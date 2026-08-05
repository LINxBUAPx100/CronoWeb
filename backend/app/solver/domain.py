"""
Compilación del problema: del JSON de entrada a estructuras indexadas por entero.

El solver nunca vuelve a tocar los modelos Pydantic. Todo se traduce una sola vez a
listas y sets indexados por posición, porque el backtracking hace millones de
comprobaciones de pertenencia y `dict[str]` en el hot loop cuesta caro.

Vocabulario:
  slot   = par (día, bloque de clase) aplanado a un entero 0..S-1
  lesson = una hora suelta de (grupo, materia). Un plan con 5 h de Matemáticas
           en 1°A genera 5 lessons independientes. Son las variables del CSP.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

from ..models.schemas import (
    AvailabilityMode,
    Group,
    ScheduleRequest,
    Subject,
    Teacher,
)


@dataclass(frozen=True, slots=True)
class Slot:
    index: int
    day: str
    day_index: int
    block_id: str
    block_index: int      # posición dentro del día, sólo bloques de clase
    label: str


@dataclass(slots=True)
class Lesson:
    """Una variable del CSP: una hora de una materia para un grupo."""

    uid: str
    group_id: str
    subject_id: str
    occurrence: int
    eligible_teachers: Tuple[str, ...]
    max_per_day: int
    preferred_teacher: Optional[str]
    assign_to_tutor: bool
    # Dificultad estática: menor = más difícil de colocar. Se usa como orden base
    # y como criterio de desempate del MRV.
    difficulty: float = 0.0


@dataclass
class ProblemContext:
    """Vista compilada e inmutable del problema."""

    request: ScheduleRequest
    slots: List[Slot]
    slots_by_day: List[List[int]]                 # day_index -> [slot_index...]
    day_of_slot: List[int]
    block_of_slot: List[int]
    n_blocks_per_day: int

    subjects: Dict[str, Subject]
    teachers: Dict[str, Teacher]
    groups: Dict[str, Group]
    teacher_order: List[str]
    group_order: List[str]

    teacher_slots: Dict[str, Set[int]]            # slots donde el profesor SÍ puede
    group_slots: Dict[str, Set[int]]              # slots donde el grupo SÍ recibe clase
    teacher_max_weekly: Dict[str, int]
    teacher_max_daily: Dict[str, int]

    eligible: Dict[Tuple[str, str], Tuple[str, ...]]   # (group,subject) -> profesores
    lessons: List[Lesson] = field(default_factory=list)
    required_hours: int = 0

    # ------------------------------------------------------------------ #
    def slot_index(self, day: str, block_id: str) -> Optional[int]:
        for s in self.slots:
            if s.day == day and s.block_id == block_id:
                return s.index
        return None


# --------------------------------------------------------------------------- #
# Disponibilidad
# --------------------------------------------------------------------------- #
def _teacher_available_slots(teacher: Teacher, slots: Sequence[Slot]) -> Set[int]:
    """
    Traduce la matriz de disponibilidad a un set de slots permitidos.

    Ver `docs/CONTRACT.md` §1: sin matriz => disponible siempre; blacklist => se
    quitan los listados; whitelist => sólo los listados (un día ausente queda fuera).
    """
    matrix = teacher.availability or {}
    if not matrix:
        return {s.index for s in slots}

    if teacher.availability_mode is AvailabilityMode.WHITELIST:
        allowed: Set[int] = set()
        for s in slots:
            if s.block_id in set(matrix.get(s.day, [])):
                allowed.add(s.index)
        return allowed

    # blacklist
    blocked = {(day, bid) for day, bids in matrix.items() for bid in bids}
    return {s.index for s in slots if (s.day, s.block_id) not in blocked}


# --------------------------------------------------------------------------- #
# Compilación
# --------------------------------------------------------------------------- #
def compile_problem(request: ScheduleRequest) -> ProblemContext:
    grid = request.grid
    class_blocks = grid.class_blocks

    slots: List[Slot] = []
    slots_by_day: List[List[int]] = [[] for _ in grid.days]
    idx = 0
    for d_i, day in enumerate(grid.days):
        for b_i, block in enumerate(class_blocks):
            slots.append(
                Slot(
                    index=idx,
                    day=day,
                    day_index=d_i,
                    block_id=block.id,
                    block_index=b_i,
                    label=f"{day} {block.label}",
                )
            )
            slots_by_day[d_i].append(idx)
            idx += 1

    subjects = {s.id: s for s in request.subjects}
    teachers = {t.id: t for t in request.teachers}
    groups = {g.id: g for g in request.groups}

    teacher_slots = {t.id: _teacher_available_slots(t, slots) for t in request.teachers}
    teacher_max_weekly = {t.id: t.max_weekly_hours for t in request.teachers}
    teacher_max_daily = {
        t.id: (t.max_daily_hours if t.max_daily_hours is not None else len(class_blocks))
        for t in request.teachers
    }

    # Slots hábiles por grupo (se descuentan los bloqueados por el propio grupo).
    all_slots = {s.index for s in slots}
    slot_lookup = {(s.day, s.block_id): s.index for s in slots}
    group_slots: Dict[str, Set[int]] = {}
    for g in request.groups:
        blocked = {
            slot_lookup[(b.day, b.block_id)]
            for b in g.blocked_slots
            if (b.day, b.block_id) in slot_lookup
        }
        group_slots[g.id] = all_slots - blocked

    # Elegibilidad (grupo, materia) -> profesores.
    # `fixed_teacher_id` gana sobre la lista de materias del profesor: es una orden
    # explícita de la dirección de la escuela, no una sugerencia.
    eligible: Dict[Tuple[str, str], Tuple[str, ...]] = {}
    for g in request.groups:
        for c in g.curriculum:
            if c.assign_to_tutor:
                # Se resuelve en `bind_tutor_lessons` una vez asignados los tutores.
                eligible[(g.id, c.subject_id)] = tuple()
            elif c.fixed_teacher_id:
                eligible[(g.id, c.subject_id)] = (c.fixed_teacher_id,)
            else:
                eligible[(g.id, c.subject_id)] = tuple(
                    t.id for t in request.teachers if c.subject_id in t.subject_ids
                )

    ctx = ProblemContext(
        request=request,
        slots=slots,
        slots_by_day=slots_by_day,
        day_of_slot=[s.day_index for s in slots],
        block_of_slot=[s.block_index for s in slots],
        n_blocks_per_day=len(class_blocks),
        subjects=subjects,
        teachers=teachers,
        groups=groups,
        teacher_order=[t.id for t in request.teachers],
        group_order=[g.id for g in request.groups],
        teacher_slots=teacher_slots,
        group_slots=group_slots,
        teacher_max_weekly=teacher_max_weekly,
        teacher_max_daily=teacher_max_daily,
        eligible=eligible,
    )
    _build_lessons(ctx)
    return ctx


def _build_lessons(ctx: ProblemContext) -> None:
    """Explota el plan de estudios en variables de una hora y las puntúa por dificultad."""
    lessons: List[Lesson] = []
    for gid in ctx.group_order:
        group = ctx.groups[gid]
        for c in group.curriculum:
            elig = ctx.eligible[(gid, c.subject_id)]
            for k in range(c.weekly_hours):
                lessons.append(
                    Lesson(
                        uid=f"{gid}|{c.subject_id}|{k}",
                        group_id=gid,
                        subject_id=c.subject_id,
                        occurrence=k,
                        eligible_teachers=elig,
                        max_per_day=c.max_per_day,
                        preferred_teacher=c.preferred_teacher_id,
                        assign_to_tutor=c.assign_to_tutor,
                    )
                )
    ctx.lessons = lessons
    ctx.required_hours = len(lessons)
    score_difficulty(ctx)


def score_difficulty(ctx: ProblemContext) -> None:
    """
    Dificultad ≈ tamaño del dominio inicial (slots viables × profesores elegibles).

    Es una cota superior barata que ignora las colisiones; sirve como orden base
    "primero lo más difícil", que es lo que evita el 80 % de los backtracks.
    """
    for lesson in ctx.lessons:
        g_slots = ctx.group_slots[lesson.group_id]
        total = 0
        for tid in lesson.eligible_teachers:
            total += len(g_slots & ctx.teacher_slots[tid])
        # Sin profesor todavía (assign_to_tutor) => se trata como muy restringida.
        lesson.difficulty = float(total) if lesson.eligible_teachers else 0.5


def bind_tutor_lessons(ctx: ProblemContext, tutor_by_group: Dict[str, Optional[str]]) -> None:
    """
    Segunda pasada: las materias marcadas `assign_to_tutor` sólo pueden ser impartidas
    por el tutor ya asignado al grupo. Por eso los tutores se resuelven ANTES del
    horario: aquí es donde esa decisión se convierte en una restricción dura.
    """
    for lesson in ctx.lessons:
        if not lesson.assign_to_tutor:
            continue
        tutor = tutor_by_group.get(lesson.group_id)
        lesson.eligible_teachers = (tutor,) if tutor else tuple()
        ctx.eligible[(lesson.group_id, lesson.subject_id)] = lesson.eligible_teachers
    score_difficulty(ctx)
