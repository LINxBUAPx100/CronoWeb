/**
 * Núcleo CSP en el navegador — puerto JS de `backend/app/solver/scheduler.py`.
 * El flujo completo del algoritmo está documentado en la cabecera de ese archivo.
 *
 * Resumen: backtracking con forward-checking + MRV con ruptura de simetría +
 * ordenamiento de valores por costo suave + reinicios aleatorizados + reparación
 * por cadenas de eyección. Siempre devuelve el mejor horario alcanzado, aunque
 * sea parcial.
 *
 * Diferencia de implementación con Python: aquí TODO se indexa por enteros y el
 * estado vive en TypedArrays. Es la única forma de que 200-400 variables se
 * resuelvan en decenas de milisegundos dentro de un Web Worker.
 *
 * @module engine/scheduler
 */

/** PRNG determinista (mulberry32): misma semilla ⇒ mismo horario. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class TimeoutSignal extends Error {}

export class Scheduler {
  /**
   * @param {object} ctx contexto compilado (engine/domain.js)
   * @param {Map<string,?string>} tutorByGroup
   * @param {object} options SolverOptions normalizadas
   * @param {(progress:object)=>void} [onProgress]
   */
  constructor(ctx, tutorByGroup, options, onProgress) {
    this.ctx = ctx;
    this.options = options;
    this.w = options.weights;
    this.onProgress = onProgress || null;

    // ── Índices enteros ────────────────────────────────────────────────
    this.teacherIdx = new Map(ctx.teacherOrder.map((tid, i) => [tid, i]));
    this.groupIdx = new Map(ctx.groupOrder.map((gid, i) => [gid, i]));
    this.nTeachers = ctx.teacherOrder.length;
    this.nGroups = ctx.groupOrder.length;
    this.nSlots = ctx.slots.length;
    this.nDays = ctx.nDays;

    this.dayOfSlot = Int32Array.from(ctx.dayOfSlot);
    this.blockOfSlot = Int32Array.from(ctx.blockOfSlot);
    this.maxWeekly = Int32Array.from(ctx.teacherOrder.map((tid) => ctx.teacherMaxWeekly.get(tid)));
    this.maxDaily = Int32Array.from(ctx.teacherOrder.map((tid) => ctx.teacherMaxDaily.get(tid)));
    this.tutorOfGroup = Int32Array.from(
      ctx.groupOrder.map((gid) => {
        const tid = tutorByGroup.get(gid);
        return tid != null && this.teacherIdx.has(tid) ? this.teacherIdx.get(tid) : -1;
      }),
    );

    // ── Lecciones ──────────────────────────────────────────────────────
    const pairKeys = [];
    const pairIndex = new Map();
    this.lessons = ctx.lessons.map((lesson, i) => {
      const pairKey = `${lesson.groupId}|${lesson.subjectId}`;
      if (!pairIndex.has(pairKey)) {
        pairIndex.set(pairKey, pairKeys.length);
        pairKeys.push(pairKey);
      }
      const subject = ctx.subjects.get(lesson.subjectId);
      return {
        i,
        uid: lesson.uid,
        groupId: lesson.groupId,
        subjectId: lesson.subjectId,
        g: this.groupIdx.get(lesson.groupId),
        pair: pairIndex.get(pairKey),
        eligible: Int32Array.from(
          lesson.eligible.filter((tid) => this.teacherIdx.has(tid)).map((tid) => this.teacherIdx.get(tid)),
        ),
        maxPerDay: lesson.maxPerDay,
        preferred: lesson.preferredTeacher != null ? this.teacherIdx.get(lesson.preferredTeacher) ?? -1 : -1,
        morning: subject?.prefers_morning ? 1 : 0,
        difficulty: lesson.difficulty,
      };
    });
    this.nLessons = this.lessons.length;
    this.nPairs = pairKeys.length;

    // ── Slots utilizables por par (grupo, profesor) ────────────────────
    // Se consulta en cada nodo; precomputarlo evita intersecciones en el hot loop.
    this.pairSlots = new Map();
    for (const gid of ctx.groupOrder) {
      const gSlots = ctx.groupSlots.get(gid);
      const g = this.groupIdx.get(gid);
      for (const tid of ctx.teacherOrder) {
        const tSlots = ctx.teacherSlots.get(tid);
        const t = this.teacherIdx.get(tid);
        const list = [];
        for (const slot of gSlots) if (tSlots.has(slot)) list.push(slot);
        if (list.length) {
          list.sort((a, b) => a - b);
          this.pairSlots.set(g * this.nTeachers + t, Int32Array.from(list));
        }
      }
    }

    this.reset();
    this.deadline = 0;
    this.nodes = 0;
    this.noise = 0;
    this.rand = mulberry32(options.seed);
    this.best = null;
    this.bestCount = -1;
    this.orderedIdx = this.lessons.map((l) => l.i);
  }

  // ------------------------------------------------------------------ //
  // Estado
  // ------------------------------------------------------------------ //
  reset() {
    const { nGroups, nTeachers, nSlots, nDays, nLessons, nPairs } = this;
    this.groupSlot = new Int32Array(nGroups * nSlots).fill(-1);
    this.teacherSlot = new Int32Array(nTeachers * nSlots).fill(-1);
    this.aSlot = new Int32Array(nLessons).fill(-1);
    this.aTeacher = new Int32Array(nLessons).fill(-1);
    this.teacherWeek = new Int32Array(nTeachers);
    this.teacherDay = new Int32Array(nTeachers * nDays);
    this.subjectDay = new Int32Array(nPairs * nDays);
    this.placedCount = 0;
  }

  place(lesson, slot, t) {
    const day = this.dayOfSlot[slot];
    this.groupSlot[lesson.g * this.nSlots + slot] = lesson.i;
    this.teacherSlot[t * this.nSlots + slot] = lesson.i;
    this.aSlot[lesson.i] = slot;
    this.aTeacher[lesson.i] = t;
    this.teacherWeek[t] += 1;
    this.teacherDay[t * this.nDays + day] += 1;
    this.subjectDay[lesson.pair * this.nDays + day] += 1;
    this.placedCount += 1;
  }

  unplace(lesson) {
    const slot = this.aSlot[lesson.i];
    const t = this.aTeacher[lesson.i];
    const day = this.dayOfSlot[slot];
    this.groupSlot[lesson.g * this.nSlots + slot] = -1;
    this.teacherSlot[t * this.nSlots + slot] = -1;
    this.aSlot[lesson.i] = -1;
    this.aTeacher[lesson.i] = -1;
    this.teacherWeek[t] -= 1;
    this.teacherDay[t * this.nDays + day] -= 1;
    this.subjectDay[lesson.pair * this.nDays + day] -= 1;
    this.placedCount -= 1;
  }

  // ------------------------------------------------------------------ //
  // API
  // ------------------------------------------------------------------ //
  solve() {
    const started = performance.now();
    this.deadline = started + this.options.time_budget_seconds * 1000;

    // Las horas sin profesor elegible se apartan: sólo harían fallar cada rama.
    const solvable = this.lessons.filter((l) => l.eligible.length > 0);
    const impossible = this.lessons.filter((l) => l.eligible.length === 0);

    // Primero lo más difícil. Orden estable, reutilizado por el MRV en cada nodo.
    const ordered = [...solvable].sort((a, b) => a.difficulty - b.difficulty || (a.uid < b.uid ? -1 : 1));
    this.orderedIdx = ordered.map((l) => l.i);

    let restarts = 0;
    let complete = false;

    for (let attempt = 0; attempt <= this.options.max_restarts; attempt += 1) {
      restarts = attempt;
      this.reset();
      this.rand = mulberry32(this.options.seed + attempt * 7919);
      // Primer intento determinista; los siguientes exploran con ruido creciente.
      this.noise = attempt === 0 ? 0 : 0.35 * attempt;

      const remaining = new Set(this.orderedIdx);
      try {
        complete = this.search(remaining);
      } catch (err) {
        if (!(err instanceof TimeoutSignal)) throw err;
        complete = false;
      }
      this.trackBest();
      if (this.onProgress) {
        this.onProgress({ attempt, placed: this.bestCount, required: this.nLessons, complete });
      }
      if (complete || performance.now() >= this.deadline) break;
    }

    this.restore(this.best || new Map());
    if (!complete && this.options.enable_repair) {
      this.repair(Math.min(this.deadline + 1500, started + this.options.time_budget_seconds * 1500));
    }

    const assignment = new Map();
    for (const lesson of this.lessons) {
      if (this.aSlot[lesson.i] >= 0) {
        assignment.set(lesson.uid, {
          slot: this.aSlot[lesson.i],
          teacherId: this.ctx.teacherOrder[this.aTeacher[lesson.i]],
        });
      }
    }
    const unplaced = [
      ...solvable.filter((l) => this.aSlot[l.i] < 0).map((l) => l.uid),
      ...impossible.map((l) => l.uid),
    ];

    return {
      assignment,
      unplaced,
      restarts,
      nodes: this.nodes,
      elapsedMs: Math.round(performance.now() - started),
      softScore: Math.round(this.totalSoftCost() * 100) / 100,
      complete: unplaced.length === 0,
    };
  }

  // ------------------------------------------------------------------ //
  // Búsqueda
  // ------------------------------------------------------------------ //
  search(remaining) {
    if (remaining.size === 0) return true;

    this.nodes += 1;
    if ((this.nodes & 511) === 0 && performance.now() > this.deadline) throw new TimeoutSignal();

    const lesson = this.lessons[this.selectVariable(remaining)];
    const candidates = this.candidates(lesson);
    if (!candidates.length) {
      this.trackBest();
      return false;   // dominio vacío ⇒ rama muerta (forward-checking implícito)
    }

    const branch = this.options.max_branch || candidates.length;
    const limit = Math.min(branch, candidates.length);
    remaining.delete(lesson.i);
    for (let k = 0; k < limit; k += 1) {
      const { slot, t } = candidates[k];
      this.place(lesson, slot, t);
      if (this.placedCount > this.bestCount) this.trackBest();
      if (this.search(remaining)) return true;
      this.unplace(lesson);
    }
    remaining.add(lesson.i);
    return false;
  }

  /**
   * MRV con ruptura de simetría: las N horas de una misma (grupo, materia) son
   * intercambiables, así que sólo se considera la primera pendiente de cada par.
   * Eso colapsa N! ramas idénticas a una sola y es la diferencia entre resolver
   * una secundaria en 40 ms o no resolverla en 8 s.
   */
  selectVariable(remaining) {
    const limit = this.options.mrv_sample;
    const seenPairs = new Set();
    let bestIdx = -1;
    let bestSize = Infinity;
    let sampled = 0;

    for (const idx of this.orderedIdx) {
      if (!remaining.has(idx)) continue;
      const lesson = this.lessons[idx];
      if (seenPairs.has(lesson.pair)) continue;
      seenPairs.add(lesson.pair);

      const size = this.domainSize(lesson, bestSize);
      if (size < bestSize) {
        bestIdx = idx;
        bestSize = size;
        if (size <= 1) return bestIdx;
      } else if (bestIdx < 0) {
        bestIdx = idx;
      }
      sampled += 1;
      if (sampled >= limit) break;
    }
    return bestIdx >= 0 ? bestIdx : remaining.values().next().value;
  }

  /** Cuenta pares (slot, profesor) viables, con corte temprano en `cap`. */
  domainSize(lesson, cap) {
    const { nSlots, nDays } = this;
    const gBase = lesson.g * nSlots;
    let total = 0;
    for (let e = 0; e < lesson.eligible.length; e += 1) {
      const t = lesson.eligible[e];
      if (this.teacherWeek[t] >= this.maxWeekly[t]) continue;
      const slots = this.pairSlots.get(lesson.g * this.nTeachers + t);
      if (!slots) continue;
      const tBase = t * nSlots;
      for (let s = 0; s < slots.length; s += 1) {
        const slot = slots[s];
        if (this.groupSlot[gBase + slot] >= 0 || this.teacherSlot[tBase + slot] >= 0) continue;
        const day = this.dayOfSlot[slot];
        if (this.teacherDay[t * nDays + day] >= this.maxDaily[t]) continue;
        if (this.subjectDay[lesson.pair * nDays + day] >= lesson.maxPerDay) continue;
        total += 1;
        if (total >= cap) return total;
      }
    }
    return total;
  }

  /** Pares viables ordenados por costo suave ascendente (+ ruido del reinicio). */
  candidates(lesson) {
    const { nSlots, nDays } = this;
    const gBase = lesson.g * nSlots;
    const out = [];
    for (let e = 0; e < lesson.eligible.length; e += 1) {
      const t = lesson.eligible[e];
      if (this.teacherWeek[t] >= this.maxWeekly[t]) continue;
      const slots = this.pairSlots.get(lesson.g * this.nTeachers + t);
      if (!slots) continue;
      const tBase = t * nSlots;
      for (let s = 0; s < slots.length; s += 1) {
        const slot = slots[s];
        if (this.groupSlot[gBase + slot] >= 0 || this.teacherSlot[tBase + slot] >= 0) continue;
        const day = this.dayOfSlot[slot];
        if (this.teacherDay[t * nDays + day] >= this.maxDaily[t]) continue;
        if (this.subjectDay[lesson.pair * nDays + day] >= lesson.maxPerDay) continue;
        let cost = this.softCost(lesson, slot, t);
        if (this.noise) cost += this.rand() * this.noise;
        out.push({ cost, slot, t });
      }
    }
    out.sort((a, b) => a.cost - b.cost || a.slot - b.slot || a.t - b.t);
    return out;
  }

  // ------------------------------------------------------------------ //
  // Restricciones suaves
  // ------------------------------------------------------------------ //
  softCost(lesson, slot, t) {
    const w = this.w;
    const day = this.dayOfSlot[slot];
    const block = this.blockOfSlot[slot];
    let cost = 0;

    // S1 — no repetir la misma materia el mismo día.
    cost += w.same_day_repeat * this.subjectDay[lesson.pair * this.nDays + day];
    // S2 — huecos del profesor.
    cost += w.teacher_gap * this.gapDelta(t, day, block);
    // S3 — materias que rinden más temprano.
    if (lesson.morning) cost += w.morning_preference * block;
    // S4 — el tutor da clase a su grupo (peso negativo = bonificación).
    if (this.tutorOfGroup[lesson.g] === t) cost += w.tutor_affinity;
    // S5 — profesor preferido por la dirección.
    if (lesson.preferred >= 0 && lesson.preferred !== t) cost += w.preferred_teacher;
    // S6 — repartir la carga del profesor entre días.
    cost += w.daily_balance * this.teacherDay[t * this.nDays + day];
    // S7 — llenar temprano y liberar el final del día.
    cost += w.late_block_penalty * block;
    // S8 — repartir entre profesores según capacidad restante. Sin esto el solver
    //      satura al primer profesor elegible y deja horas sueltas al final.
    const cap = this.maxWeekly[t];
    if (cap) cost += w.teacher_utilization * (this.teacherWeek[t] / cap);
    return cost;
  }

  /** Huecos NUEVOS que crea colocar al profesor en (día, bloque). */
  gapDelta(t, day, block) {
    const slots = this.ctx.slotsByDay[day];
    const tBase = t * this.nSlots;
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let i = 0; i < slots.length; i += 1) {
      if (this.teacherSlot[tBase + slots[i]] >= 0) {
        const b = this.blockOfSlot[slots[i]];
        if (b < min) min = b;
        if (b > max) max = b;
        count += 1;
      }
    }
    if (count === 0) return 0;
    const before = max - min + 1 - count;
    const nmin = Math.min(min, block);
    const nmax = Math.max(max, block);
    const after = nmax - nmin + 1 - (count + 1);
    return Math.max(0, after - before);
  }

  /** Penalización total del horario final (menor = mejor). */
  totalSoftCost() {
    const snapshot = [];
    for (const lesson of this.lessons) {
      if (this.aSlot[lesson.i] >= 0) snapshot.push([lesson, this.aSlot[lesson.i], this.aTeacher[lesson.i]]);
    }
    snapshot.sort((a, b) => a[1] - b[1] || (a[0].uid < b[0].uid ? -1 : 1));

    const saved = {
      groupSlot: this.groupSlot, teacherSlot: this.teacherSlot, aSlot: this.aSlot,
      aTeacher: this.aTeacher, teacherWeek: this.teacherWeek, teacherDay: this.teacherDay,
      subjectDay: this.subjectDay, placedCount: this.placedCount,
    };
    this.reset();
    let total = 0;
    for (const [lesson, slot, t] of snapshot) {
      total += this.softCost(lesson, slot, t);
      this.place(lesson, slot, t);
    }
    Object.assign(this, saved);
    return total;
  }

  // ------------------------------------------------------------------ //
  // Mejor parcial / restauración
  // ------------------------------------------------------------------ //
  trackBest() {
    if (this.placedCount > this.bestCount) {
      this.bestCount = this.placedCount;
      const snap = new Map();
      for (const lesson of this.lessons) {
        if (this.aSlot[lesson.i] >= 0) snap.set(lesson.i, [this.aSlot[lesson.i], this.aTeacher[lesson.i]]);
      }
      this.best = snap;
    }
  }

  restore(snapshot) {
    this.reset();
    for (const [i, [slot, t]] of snapshot) this.place(this.lessons[i], slot, t);
  }

  // ------------------------------------------------------------------ //
  // Reparación por cadenas de eyección
  // ------------------------------------------------------------------ //
  repair(deadline) {
    let pending = this.lessons.filter((l) => l.eligible.length && this.aSlot[l.i] < 0);
    let progress = true;
    while (pending.length && progress && performance.now() < deadline) {
      progress = false;
      const next = [];
      for (const lesson of pending) {
        if (performance.now() >= deadline) {
          next.push(lesson);
          continue;
        }
        const direct = this.candidates(lesson);
        if (direct.length) {
          this.place(lesson, direct[0].slot, direct[0].t);
          progress = true;
        } else if (this.ejectAndPlace(lesson)) {
          progress = true;
        } else {
          next.push(lesson);
        }
      }
      pending = next;
    }
  }

  /**
   * Busca un (slot, profesor) donde estorbe EXACTAMENTE una clase ya colocada,
   * la expulsa, coloca la pendiente y reubica a la expulsada. Si no se puede
   * reubicar, revierte. Cadena de longitud 1: barata y sin ciclos.
   */
  ejectAndPlace(lesson) {
    const { nSlots, nDays } = this;
    const gBase = lesson.g * nSlots;

    for (let e = 0; e < lesson.eligible.length; e += 1) {
      const t = lesson.eligible[e];
      const slots = this.pairSlots.get(lesson.g * this.nTeachers + t);
      if (!slots) continue;
      const tBase = t * nSlots;

      for (let s = 0; s < slots.length; s += 1) {
        const slot = slots[s];
        const a = this.groupSlot[gBase + slot];
        const b = this.teacherSlot[tBase + slot];
        const blockers = new Set([a, b].filter((x) => x >= 0));
        if (blockers.size !== 1) continue;

        const victim = this.lessons[[...blockers][0]];
        const victimSlot = this.aSlot[victim.i];
        const victimTeacher = this.aTeacher[victim.i];
        const day = this.dayOfSlot[slot];

        this.unplace(victim);
        const fits =
          this.teacherWeek[t] < this.maxWeekly[t] &&
          this.teacherDay[t * nDays + day] < this.maxDaily[t] &&
          this.subjectDay[lesson.pair * nDays + day] < lesson.maxPerDay &&
          this.groupSlot[gBase + slot] < 0 &&
          this.teacherSlot[tBase + slot] < 0;

        if (fits) {
          this.place(lesson, slot, t);
          const relocation = this.candidates(victim);
          if (relocation.length) {
            this.place(victim, relocation[0].slot, relocation[0].t);
            return true;
          }
          this.unplace(lesson);
        }
        this.place(victim, victimSlot, victimTeacher);   // rollback
      }
    }
    return false;
  }
}

/**
 * Convierte la asignación plana en las matrices `by_group` y `by_teacher`.
 * @returns {{by_group:object, by_teacher:object}}
 */
export function buildIndexMaps(ctx, assignment) {
  const byGroup = {};
  const byTeacher = {};
  for (const gid of ctx.groupOrder) {
    byGroup[gid] = Object.fromEntries(ctx.request.grid.days.map((d) => [d, {}]));
  }
  for (const tid of ctx.teacherOrder) {
    byTeacher[tid] = Object.fromEntries(ctx.request.grid.days.map((d) => [d, {}]));
  }
  const lessons = new Map(ctx.lessons.map((l) => [l.uid, l]));

  for (const [uid, { slot, teacherId }] of assignment) {
    const lesson = lessons.get(uid);
    const s = ctx.slots[slot];
    byGroup[lesson.groupId][s.day][s.blockId] = { subject_id: lesson.subjectId, teacher_id: teacherId };
    byTeacher[teacherId][s.day][s.blockId] = { subject_id: lesson.subjectId, group_id: lesson.groupId };
  }
  return { by_group: byGroup, by_teacher: byTeacher };
}
