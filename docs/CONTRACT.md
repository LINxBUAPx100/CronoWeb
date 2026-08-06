# CronoWeb — Contrato de datos v1

Este documento es la **única fuente de verdad** del formato JSON. Los dos motores
(`assets/js/engine/*` en el navegador y `backend/app/solver/*` en Python) deben
implementar exactamente este contrato. Si cambias uno, cambia el otro.

- `schema_version`: `"1.0"` (obligatorio; el motor rechaza versiones mayores).
- Todos los IDs son strings, únicos dentro de su colección, y sensibles a mayúsculas.
- Los días son etiquetas libres (`"LUN"`, `"Lunes"`, `"Mon"`), pero deben coincidir
  carácter por carácter entre `grid.days` y las matrices de disponibilidad.

---

## 1. Entrada — `ScheduleRequest`

```jsonc
{
  "schema_version": "1.0",
  "tenant_id": "esc-benito-juarez",        // opcional hoy; clave del futuro multi-tenant SaaS

  // ── X: franja horaria ────────────────────────────────────────────────
  "grid": {
    "days": ["LUN", "MAR", "MIE", "JUE", "VIE"],
    "blocks": [
      { "id": "B1", "label": "1a", "start": "07:00", "end": "07:50", "kind": "class" },
      { "id": "R1", "label": "Receso", "start": "09:30", "end": "09:50", "kind": "break" }
      // kind: "class" (asignable) | "break" (se dibuja, nunca se asigna)
    ]
  },

  // ── Materias ─────────────────────────────────────────────────────────
  "subjects": [
    {
      "id": "MAT",
      "name": "Matemáticas",
      "short_name": "Mat",           // opcional, para la celda del horario
      "color": "#2563eb",            // opcional, hex; el UI genera uno si falta
      "prefers_morning": true,       // soft: empuja la materia a bloques tempranos
      "room_requirement": null       // reservado v2 (laboratorios/talleres)
    }
  ],

  // ── Y: profesores ────────────────────────────────────────────────────
  "teachers": [
    {
      "id": "T01",
      "name": "María Luna",
      "subject_ids": ["MAT", "FIS"],
      "max_weekly_hours": 22,
      "max_daily_hours": 6,          // opcional (default: nº de bloques de clase por día)
      "availability_mode": "blacklist",   // "blacklist" (default) | "whitelist"
      "availability": { "VIE": ["B1", "B2"] },
      "can_be_tutor": true,
      "tutor_priority": 0,           // mayor = se prefiere como tutor
      "notes": "Trabaja en otra escuela los viernes por la mañana"
    }
  ],

  // ── Z/W: grados y grupos ─────────────────────────────────────────────
  "groups": [
    {
      "id": "1A",
      "grade": "1",                  // Z
      "name": "A",                   // W
      "level": "secundaria",         // opcional · "primaria" | "secundaria" | "preparatoria"
      "term_label": null,            // opcional · sólo prepa: "3er semestre", "2° cuatrimestre"
      "shift": "matutino",           // opcional, informativo
      "blocked_slots": [{ "day": "VIE", "block_id": "B7" }],   // el grupo no recibe clase ahí
      "curriculum": [
        {
          "subject_id": "MAT",
          "weekly_hours": 5,
          "max_per_day": 2,          // hard: máximo de horas de esa materia al día
          "preferred_teacher_id": null,  // soft
          "fixed_teacher_id": null,      // hard: fuerza a ese profesor
          "assign_to_tutor": false       // hard: la imparte el tutor del grupo (p.ej. Tutoría)
        }
      ]
    }
  ],

  "options": { /* SolverOptions, ver §3 */ },
  "branding": { /* Branding, ver §4 */ }
}
```

### Semántica de `availability` (Hard Constraint #2)

La matriz es un diccionario `día -> [block_id...]`.

| `availability_mode` | `availability` | Significado |
|---|---|---|
| cualquiera | `null` o `{}` | Disponible en **toda** la rejilla |
| `"blacklist"` | `{"VIE": ["B1"]}` | Disponible en todo **excepto** VIE-B1 |
| `"blacklist"` | `{"VIE": []}` | Lista vacía = **nada bloqueado** ese día |
| `"whitelist"` | `{"LUN": ["B1","B2"]}` | Disponible **solo** LUN-B1 y LUN-B2; el resto de la semana queda bloqueado |

`"blacklist"` es el default porque el caso real es "tengo estas horas ocupadas".
El UI escribe siempre matrices completas, así que el modo es indistinto ahí.

---

## 2. Salida — `ScheduleResponse`

```jsonc
{
  "status": "ok",            // "ok" | "partial" | "infeasible"
  "generated_at": "2026-08-04T18:00:00Z",
  "engine": "python-backtracking-1.0",   // o "js-backtracking-1.0"

  "tutors": [
    { "group_id": "1A", "teacher_id": "T01", "shared": false,
      "estimated_load": 18.5, "reason": "matching 1-a-1 óptimo" }
  ],

  "assignments": [
    { "group_id": "1A", "subject_id": "MAT", "teacher_id": "T01",
      "day": "LUN", "block_id": "B1" }
  ],

  "by_group":   { "1A": { "LUN": { "B1": {"subject_id":"MAT","teacher_id":"T01"} } } },
  "by_teacher": { "T01": { "LUN": { "B1": {"subject_id":"MAT","group_id":"1A"} } } },

  "conflicts": [
    { "severity": "error",            // "error" | "warning" | "info"
      "code": "UNPLACED_HOURS",
      "message": "Faltaron 2 h de Matemáticas en 3B: ningún profesor elegible tiene huecos libres.",
      "group_id": "3B", "subject_id": "MAT", "teacher_id": null, "missing_hours": 2 }
  ],

  "metrics": {
    "required_hours": 198, "placed_hours": 198, "fill_rate": 1.0,
    "teacher_gaps": 17,
    // soft_score = PENALIZACIÓN acumulada de las restricciones suaves.
    // Menor es mejor. Sólo es comparable entre corridas del MISMO escenario
    // con los MISMOS pesos.
    "soft_score": 1295.39,
    "restarts": 0, "elapsed_ms": 41,
    "teacher_load": { "T01": { "assigned": 22, "max": 24, "utilization": 0.917, "gaps": 2 } }
  },

  "branding": { "mode": "simple", "watermark_text": "CronoWeb.com",
                "watermark_required": true, "show_logo": false, ... }
}
```

`status`:
- `ok` — 100 % de las horas colocadas, cero conflictos `error`.
- `partial` — hay solución pero incompleta; `conflicts` explica exactamente qué faltó.
- `infeasible` — la validación previa detectó que el problema no tiene solución
  (p. ej. una materia sin profesor elegible). No se ejecuta la búsqueda.

---

## 3. `SolverOptions`

| Campo | Default | Qué hace |
|---|---|---|
| `time_budget_seconds` | `8.0` | Presupuesto duro de búsqueda. Al agotarse devuelve el mejor parcial. |
| `max_restarts` | `6` | Reinicios aleatorizados (diversifica el orden de valores). |
| `max_branch` | `8` | Ramas exploradas por variable (poda; `0` = sin límite). |
| `mrv_sample` | `48` | Cuántas variables se evalúan al elegir la más restringida (acota el costo del MRV). |
| `seed` | `12345` | Semilla → resultados reproducibles. |
| `enable_repair` | `true` | Fase de reparación por cadenas de eyección sobre el mejor parcial. |
| `allow_partial` | `true` | Si es `false`, un parcial se reporta como `infeasible`. |
| `weights` | ver abajo | Pesos de las restricciones suaves. |

`weights` (costo: menor es mejor):

| Peso | Default | Penaliza |
|---|---|---|
| `same_day_repeat` | 6.0 | repetir la misma materia el mismo día |
| `teacher_gap` | 3.0 | crear una hora muerta en el día del profesor |
| `morning_preference` | 1.5 | materia `prefers_morning` en bloque tardío |
| `tutor_affinity` | −4.0 | **bonificación**: el tutor da clase a su propio grupo |
| `preferred_teacher` | 2.5 | no respetar `preferred_teacher_id` |
| `daily_balance` | 0.75 | concentrar horas del profesor en un solo día |
| `late_block_penalty` | 0.5 | llenar los últimos bloques del día |
| `teacher_utilization` | 5.0 | acercarse al tope semanal del profesor |

`teacher_utilization` no es cosmético: sin él el solver satura al primer profesor
elegible de cada materia y se queda sin margen para los últimos grupos. En el
escenario de ejemplo, activarlo fue la diferencia entre 197/198 h en 8 s y
198/198 h en 41 ms.

---

## 4. `Branding` y planes

```jsonc
"branding": {
  "mode": "simple",              // "simple" | "custom"
  "school_name": null,
  "logo_data_url": null,         // data:image/... (se embebe en el PNG)
  "primary_color": "#14417c",
  "cycle_label": "Ciclo 2026-2027",
  "footer_note": null
}
```

- **Modo simple** (gratis / MVP en GitHub Pages): sin logo, sin nombre de escuela.
  Marca de agua obligatoria **CronoWeb.com** en pantalla y en el PNG exportado.
- **Modo personalizado** (plan de pago): logo, nombre, color y pie de página propios;
  la marca de agua se reduce a un crédito discreto.

El backend **resuelve** el branding según el plan del tenant (`backend/app/core/config.py`,
`PLAN_FEATURES`): si un cliente en plan `free` pide `mode: "custom"`, la respuesta
lo degrada a `simple` y añade un conflicto `info`. El motor local del navegador
aplica la misma regla con `plan: "free"` fijo. Así el gating vive en un solo lugar
el día que se conecte el cobro.
