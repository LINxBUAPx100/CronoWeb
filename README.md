# CronoWeb

**Generador de horarios escolares automáticos.** Captura la rejilla de horas, las
materias, los profesores (con su disponibilidad real) y los grupos; CronoWeb acomoda
la semana completa sin cruces de profesores y exporta cada horario como PNG listo
para imprimir o mandar por WhatsApp.

El modo simple funciona **entero en el navegador**: sin instalar nada, sin servidor
y sin que los datos de la escuela salgan de la computadora.

---

## Arranque rápido

```bash
npm run serve
```

Abre <http://localhost:5173>, pulsa **Cargar ejemplo** y luego **Generar horario**.
El escenario de ejemplo es una secundaria de 6 grupos, 12 profesores y 198 horas
semanales; se resuelve completo en ~40 ms.

> Tiene que servirse por `http://`. Abrir `index.html` con doble clic no funciona:
> el navegador bloquea los ES modules y los Web Workers en `file://`.

---

## Interfaz

El diseño completo está especificado en **[DESIGN.md](DESIGN.md)**; `assets/css/app.css`
lo implementa y nada más.

**Concepto: «documento oficial bien hecho».** Azul institucional: marino `#14417c`
para la estructura (encabezados, títulos, reglas, foco) y azul vivo `#0f6fd1` sólo
para la acción (botón primario, paso activo, la marca). Un solo hue en dos
intensidades, para que los tres estados —rojo, ámbar, verde— signifiquen algo en
lugar de competir con la marca.

Tipografía: **Archivo** en la interfaz y los titulares, **Archivo Narrow** dentro
de la tabla del horario —donde el ancho es oro: «Form. Cívica y Ética» cabe en un
renglón y con cualquier otra familia se parte en dos—. Ambas OFL y alojadas en el
repositorio (`assets/fonts/`, 88 KB), porque la app debe abrir sin internet.

Una sola superficie continua: la jerarquía se construye con espacio en blanco,
peso y ancho tipográfico, y líneas de un píxel — no con paneles anidados.
Las únicas cajas que quedan son las que representan algo físico — la hoja
imprimible y los controles.

**Responsiva de verdad**, verificada sin desbordamiento horizontal en las cinco
pantallas a 390 px:

- **≤ 900 px** — el riel de pasos pasa a ser una barra horizontal desplazable
  bajo el encabezado.
- **≤ 640 px** — los formularios se apilan en una columna, el selector de modo
  se muda a Ajustes (no cabe junto al botón principal) y los objetivos táctiles
  crecen.
- Las tablas anchas y los horarios de 980–1400 px se desplazan **dentro de su
  propio marco**; la página nunca se mueve en horizontal.

---

## Captura: cuatro pasos, cero código

Nadie en la escuela ve JSON ni toca archivos. La captura son formularios:

| Paso | Qué se llena |
|---|---|
| **1 · Horario** | Nombre de la escuela, ciclo, días de clase, hora de inicio, duración de cada clase (estándar 60 min), número de clases al día y recesos. Las horas de cada bloque **se calculan solas** y se muestran en vivo. |
| **2 · Materias** | Nombre, abreviatura (lo que se ve en la celda), color —con paleta de un clic— y si conviene darla temprano. Botón para cargar de golpe las materias comunes de secundaria. |
| **3 · Profesores** | Materias que imparte (chips de un clic), horas máximas por semana y por día, si puede ser tutor, y una **cuadrícula de disponibilidad**: se hace clic en las horas en que NO puede dar clase. Hay atajos para bloquear un día entero o una hora de toda la semana. |
| **4 · Grados y grupos** | Nivel del grado (kínder / primaria / secundaria / preparatoria), sus grupos (A, B, C…) y su plan de estudios: horas por semana, máximo por día, si la imparte el tutor y si tiene profesor fijo. Un contador marca en verde o rojo si el plan cabe en la semana. |

### Niveles y periodos

**Un plantel puede tener varios niveles.** Cada grado se marca como kínder,
primaria, secundaria o preparatoria; los grados se agrupan por nivel en la
captura y en las hojas («1° de primaria»). Cuando conviven dos niveles, los ids
internos de grupo llevan prefijo (`P1A`, `S1A`) — si no, el «1° A» de primaria y
el de secundaria serían el mismo grupo para el motor y el horario saldría
revuelto. Con un solo nivel el id sigue siendo `1A`, que es lo que la escuela
escribe.

**En preparatoria el grado es un periodo.** Al marcar un grado como preparatoria
se despliega su periodo: **1er a 6° semestre** —o cuatrimestres o trimestres, que
valen los mismos seis periodos del bachillerato, o la modalidad anual, que son
tres años—. Cada periodo es un grado con sus propios grupos y su propio plan de
estudios: el 1er y el 3er semestre existen al mismo tiempo, se calculan juntos y
salen en hojas distintas («3er semestre A»), con el periodo también en el nombre
del archivo. Kínder, primaria y secundaria no tienen periodos y no muestran nada
de esto: ahí un grado es un año y se captura como número.

El botón **Generar horario** revisa antes de calcular: si falta algo, salta al paso
donde está el problema y lo explica —«Nadie imparte Inglés y el grado 1 la lleva
4 h»— en vez de fallar con un error técnico.

Todo se guarda solo en el navegador. **Guardar respaldo** descarga un archivo con
la escuela completa y **Abrir respaldo** la restaura tal cual, con todos los
formularios llenos.

---

## Exportación: cuatro vistas × dos formatos

| Vista | Para qué sirve |
|---|---|
| **Por grupo** | El horario del salón. |
| **Por profesor** | Lo que cada docente pide el primer día. |
| **Por grado** | Todos los grupos del grado en una hoja, lado a lado por día. La vista de la dirección. |
| **Por materia** | Dónde y con quién se imparte una materia en toda la escuela. Para la coordinación académica. |

| Formato | Cómo se ve |
|---|---|
| **Técnico** | Denso: abreviaturas, nombre del profesor, tutor, leyenda de materias y conteo de horas. Para la dirección. |
| **Para alumnos** | Nombre completo de la materia en letra grande, sin datos técnicos ni leyenda. Para imprimir y pegar afuera del salón. |

Cualquier combinación se descarga como PNG con **Descargar PNG**, o todas de golpe
con **Descargar todas**. La calidad se elige en Ajustes: 2× pantalla, 3× impresión,
4× cartel.

---

## Ajustar el horario a mano

Ningún horario sobrevive al primer lunes. En la vista **Por grupo**, el botón
**Editar** permite mover clases de casilla:

1. Se toca una clase — se iluminan sus destinos válidos: **verde** donde la
   casilla está libre, **ámbar** donde se intercambiaría con la clase que ya
   está ahí.
2. Se toca el destino y el cambio se aplica.
3. **Deshacer** (hasta 50 pasos) y **Restaurar** vuelven atrás; `Esc` cancela la
   selección.

**Sólo se ilumina lo que es válido.** Cada destino pasa por las mismas
restricciones duras que usó el motor —cruces, disponibilidad, carga semanal y
diaria, tope de horas por materia al día—, así que es imposible crear un horario
roto a mano. Lo que no se ilumina no se puede hacer, y no hace falta un mensaje
de error después del hecho.

Se puede **mover y permutar, nunca borrar ni crear**: el total de horas de cada
materia queda intacto y el plan de estudios se sigue cumpliendo.

Las métricas (horas muertas, cargas por profesor) se recalculan en cada cambio, y
los PNG salen limpios: el exportador quita las marcas de edición del clon antes de
rasterizar — verificado comparando los archivos byte a byte.

### Otros atajos

- **Otra variante** — regenera con otra semilla. Mismo plan, otro horario igual de
  válido, por si la dirección quiere comparar opciones.
- **Duplicar grado** — copia grupos y plan de estudios completo con el siguiente
  número libre. Los grados de una escuela comparten casi todo.
- **Duplicar profesor** — copia materias, carga y disponibilidad.

---

## Dos motores, un solo contrato

El mismo algoritmo está implementado dos veces contra el mismo JSON
(`docs/CONTRACT.md`). El frontend elige cuál usar con un desplegable; el resto de
la aplicación no se entera.

| | Motor local | Motor servidor |
|---|---|---|
| Dónde corre | Web Worker del navegador | FastAPI (`backend/`) |
| Código | `assets/js/engine/` | `backend/app/solver/` |
| Hosting | GitHub Pages (estático) | cualquier VPS / contenedor |
| Privacidad | los datos nunca salen del equipo | viajan al servidor |
| Para qué | **modo simple, hoy** | escuelas grandes, licencias, integraciones |

Ambos producen resultados idénticos en el escenario de ejemplo: 198/198 h,
17 horas muertas, `soft_score` 1295.39.

---

## Cómo funciona el algoritmo

Problema de satisfacción de restricciones (CSP) resuelto con **backtracking**
—no algoritmo genético: en horarios escolares las restricciones duras dominan y el
backtracking bien podado converge en milisegundos donde un GA todavía anda
explorando población inicial.

```
compilar → asignar tutores → validar factibilidad → [abortar si es imposible]
        → backtracking → reparación → métricas → diagnóstico
```

**Variables.** Cada hora suelta de (grupo, materia) es una variable. 5 h de
Matemáticas en 1°A = 5 variables. Un escenario típico tiene 150-400.

**Restricciones duras.**

| | Regla |
|---|---|
| H1 | Un grupo no puede tener dos clases en el mismo bloque |
| H2 | Un profesor no puede estar en dos salones a la vez, ni dar dos materias a la vez |
| H3 | Nadie se asigna fuera de su matriz de disponibilidad |
| H4 | No se rebasa la carga máxima semanal ni la diaria |
| H5 | No se rebasa el tope de horas por día de cada materia |
| H6 | Sólo imparte quien puede: lista de materias, profesor fijo o tutor del grupo |

**Restricciones suaves** (costo, menor es mejor): no repetir materia el mismo día,
minimizar horas muertas del profesor, materias pesadas por la mañana, que el tutor
dé clase a su grupo, respetar profesor preferido, balancear la carga entre días y
entre profesores, y dejar libres los últimos bloques. Pesos configurables en
`options.weights`.

**Las cuatro decisiones que hacen que resuelva rápido:**

1. **Ruptura de simetría.** Las 5 horas de Matemáticas de 1°A son intercambiables;
   permutarlas genera 5! ramas idénticas. Al elegir variable sólo se considera la
   primera hora pendiente de cada (grupo, materia). En el ejemplo, esto llevó el
   cálculo de 8 s incompletos a 41 ms completos.
2. **MRV acotado.** Se toma la variable con menos opciones disponibles, evaluando
   una muestra acotada para que el heurístico no cueste más que la búsqueda.
3. **Balanceo por capacidad restante.** El peso `teacher_utilization` evita que el
   solver sature al primer profesor elegible y deje las últimas horas sin dueño.
4. **Reinicios + reparación.** Si un intento se atora, se reinicia con ruido
   creciente conservando siempre el mejor parcial; al final, una fase de cadenas de
   eyección (expulsar una clase y reubicarla) recupera las horas sueltas.

**Nunca falla en silencio.** Si no existe solución perfecta devuelve la mejor
posible más un reporte que dice exactamente qué horas faltaron y por qué:

> *Faltaron 2 h de Historia en 1°B. Sus profesores (Norma Cruz, Pedro Anaya) ya
> llegaron a su carga máxima semanal. Sube su tope de horas o reparte la materia
> con otro docente.*

### Tutores: por qué van antes que el horario

La asignación de tutor es un **emparejamiento bipartito máximo** (algoritmo de
Kuhn) entre grupos y profesores, no un ciclo de "a ver a quién le toca":

1. 1 a 1 exigiendo afinidad (que el tutor sí dé clase a ese grupo).
2. 1 a 1 relajando la afinidad para los grupos que quedaron sueltos.
3. Sólo si los grupos superan a los profesores elegibles se repite tutor,
   priorizando al de **menor carga estimada**.

Se resuelve primero porque su resultado es una entrada del horario: las materias
marcadas `assign_to_tutor` (típicamente Tutoría) sólo puede darlas el tutor, y el
solver bonifica que el tutor tenga clases con su propio grupo.

---

## Estructura

```
index.html                   la app (GitHub Pages sirve esto)
assets/
  css/app.css
  js/
    main.js                  controlador de la interfaz
    gateway.js               enruta a motor local o remoto
    model/
      school.js              ← MODELO DE CAPTURA (lo que editan los formularios)
      serialize.js           traduce modelo ⇄ contrato del motor
      edit.js                edición manual validada (puro, probado en Node)
    ui/
      studio.js              las cuatro pantallas de captura
      editor.js              modo edición sobre la hoja renderizada
      dom.js                 utilidades mínimas de DOM
      timetable.js           render de horarios (4 vistas × 2 formatos)
      panels.js              tutores, cargas, avisos
    export/png.js            html2canvas → PNG
    engine/                  ← MOTOR JS
      contract.js            defaults + validación estructural
      domain.js              compilación a índices enteros
      tutors.js              emparejamiento bipartito
      validator.js           factibilidad previa
      scheduler.js           backtracking + reparación
      metrics.js  report.js  branding.js
      worker.js              Web Worker
  vendor/html2canvas.min.js  incluida: la app funciona sin internet
backend/                     ← MOTOR PYTHON (mismo contrato)
  app/solver/                domain · tutors · validator · scheduler · metrics · report · engine
  app/api/ app/core/ app/models/
  samples/demo_secundaria.json
  tests/test_solver.py
docs/CONTRACT.md             formato JSON — fuente de verdad de ambos motores
tools/serve.mjs              servidor estático de desarrollo
tools/verify-engine.mjs      pruebas del motor JS
tools/verify-model.mjs       pruebas del modelo de captura (periodos, respaldos)
```

---

## Pruebas

```bash
node tools/verify-engine.mjs
```

```bash
node tools/verify-model.mjs
```

```bash
.venv/Scripts/python.exe -m pytest backend/tests -q
```

Las dos suites incluyen un **verificador independiente del solver**: recorre el
horario producido y revisa una por una las restricciones duras contra el enunciado
original. Un horario con cruces no puede pasar aunque el solver crea que terminó
bien.

Cubren: escenario completo, cruces, disponibilidad estricta (whitelist y
blacklist), tutores 1-a-1, tutores compartidos por falta de profesores, materia sin
profesor, plan más grande que la rejilla, horario parcial con diagnóstico, profesor
fijo, reproducibilidad por semilla y degradación de branding por plan.

La edición manual tiene su propio bloque de pruebas: **cada movimiento que el
editor ofrece se aplica y el horario resultante vuelve a pasar por el verificador
independiente**. Si la validación tuviera un hueco, se cae ahí. También se prueba
que rechaza los cruces, que respeta la disponibilidad, que el total de horas por
materia no cambia, y que deshacer y restaurar devuelven el original exacto.

`tools/verify-model.mjs` cubre la capa de captura, donde los errores no revientan
sino que salen mal impresos: que en prepa el grado y su periodo no se
desincronicen —si lo hicieran, dos semestres compartirían id de grupo y el
horario saldría revuelto sin que nada fallara—, que las cuatro modalidades den
las etiquetas correctas, que el periodo sobreviva la ida y vuelta al contrato y
que los respaldos anteriores se abran sin perder el plan de estudios.

---

## Backend (opcional, para el plan de pago)

```bash
py -m venv .venv
.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
.venv/Scripts/python.exe -m uvicorn backend.app.main:app --reload --port 8000
```

| Endpoint | Qué hace |
|---|---|
| `POST /api/v1/schedule/generate` | genera el horario |
| `POST /api/v1/schedule/validate` | sólo revisa factibilidad |
| `GET /api/v1/plans` | catálogo de planes y precios |
| `GET /api/v1/samples/demo` | escenario de ejemplo |
| `GET /api/v1/health` | salud del servicio |

Documentación interactiva en <http://localhost:8000/docs>.
El plan se resuelve con el header `X-CronoWeb-Plan` (hoy) o con una consulta de
licencia (mañana): sólo hay que cambiar `_resolve_plan` en
`backend/app/api/routes_schedule.py`.

---

## Modos de presentación y planes

**Modo simple** — gratuito, es el foco actual. Sin logotipos ni nombre de escuela.
Cada PNG lleva la marca **CronoWeb.com**. La marca no es decoración: el exportador
verifica que el nodo exista antes de rasterizar y lo reinyecta si falta.

**Modo personalizado** — logotipo, nombre de la escuela, color y pie de página
propios; la marca de agua baja a un crédito discreto. Corresponde al plan Escuela
(**$1,800 MXN al año** por plantel).

El gating vive en un solo archivo por motor (`assets/js/engine/branding.js` y
`backend/app/core/config.py`). Si un plan sin personalización la pide, la respuesta
se degrada a simple y añade un aviso `info` — nunca falla la generación.

Para demostrarle el modo personalizado a una escuela antes de que exista el cobro:
`index.html?plan=school`.

---

## Publicar en GitHub Pages

El repositorio **es** el sitio: no hay build, no hay dependencias y todo —fuentes,
html2canvas, el escenario de ejemplo— está versionado, así que funciona incluso
sin internet una vez cargado.

### Configuración (una sola vez)

**Settings → Pages → Source: GitHub Actions.**

El workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publica en
cada push a `main`. Antes de publicar corre `tools/verify-engine.mjs`: si el motor
se rompe, el sitio no se actualiza.

> **No uses «Deploy from a branch».** Ese es el builder clásico, que pasa el repo
> por Jekyll y, cuando se atora, no deja ni log ni mensaje: el estado se queda en
> «building» para siempre y el sitio responde 404 sin explicar por qué. Con el
> workflow cada despliegue tiene su log en la pestaña **Actions**.

El sitio queda en `https://<usuario>.github.io/CronoWeb/`. Todas las rutas del
frontend son relativas, así que servir desde un subdirectorio funciona sin cambiar
nada.

`backend/samples/demo_secundaria.json` también se publica —de ahí carga el
ejemplo—. El backend de Python no se ejecuta en Pages: está ahí para cuando haga
falta el modo servidor.

---

## Lo que sigue

El contrato JSON ya está estable, así que todo esto es aditivo:

- **Importar desde Excel.** Las escuelas ya tienen su plantilla en hojas de cálculo.
- **Exportar a PDF de varias páginas** (todos los grupos en un documento) y a Excel.
- **Aulas y laboratorios** como recurso aparte (`room_requirement` ya está reservado
  en el contrato).
- **Persistencia y licencias** en el backend para el plan de pago.
