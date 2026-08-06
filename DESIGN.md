# CronoWeb — Especificación visual

Fuente de verdad del diseño. `assets/css/app.css` implementa esto y nada más;
si algo se ve distinto en el código, el código está mal.

---

## 1 · Tema visual y atmósfera

**Concepto: «Documento oficial bien hecho».**
La herramienta vive en una escuela: oficios, formatos sellados, hojas pegadas en
la puerta del salón. El diseño no lo disimula con estética de SaaS — lo adopta:
el azul de los documentos oficiales, una grotesca robusta en dos anchos como la
señalética institucional, y cero decoración.

**Palabras clave:** oficial · azul · institucional · sobrio · legible.

**Definición en una frase:** un expediente escolar bien diseñado, no un panel de
control genérico.

**Por qué NO lo anterior:** `teal-700 + slate-100` es la paleta por defecto de
Tailwind. Es el uniforme de todo producto generado en 2024-2026 y por eso «se ve
hecho con IA». El problema no era el turquesa, era la ausencia de decisión.

**Un hue, dos intensidades, dos roles.**

- **Azul marino `#14417c`** = estructura. Encabezados de tabla, títulos de hoja,
  reglas, foco, chips activos.
- **Azul vivo `#0f6fd1`** = acción. Sólo botón primario, paso activo y la marca.

Que ambos sean el mismo hue es la decisión clave: la interfaz se lee de una
pieza y los tres estados —rojo, ámbar, verde— quedan libres para significar algo,
en vez de competir con la marca. Se descartaron guinda, verde pino, grafito+ámbar
y neutro alto contraste comparándolos con la web completa: el guinda obliga a
mover el rojo de error a naranja, y el verde pino colisiona con el verde de
«éxito».

---

## 2 · Paleta de color

```css
:root {
  /* ── Fondo y tinta ─────────────────────────────────────────────── */
  --paper:        #f2f5f9;   /* fondo de aplicación */
  --paper-2:      #eef2f7;   /* zonas hundidas, segmentos */
  --surface:      #ffffff;   /* hojas, tarjetas, campos */

  --ink:          #101a2b;   /* texto principal   15.8:1 sobre el fondo */
  --ink-2:        #5a677d;   /* texto secundario   5.4:1 */
  --ink-3:        #7b899c;   /* terciario          3.4:1 · sólo etiquetas y no-texto */
  --line:         #dfe6ef;   /* divisores visibles */
  --line-soft:    #edf1f6;   /* divisores internos */

  /* ── Azul marino · ESTRUCTURA ──────────────────────────────────── */
  --brand:        #14417c;   /* blanco encima 10.5:1 */
  --brand-2:      #1c579f;
  --brand-soft:   #e8eff8;
  --brand-line:   #bcd0e8;

  /* ── Azul vivo · ACCIÓN (uso escaso) ───────────────────────────── */
  --accent:       #0f6fd1;   /* blanco encima 4.9:1 (AA texto normal) */
  --accent-2:     #0b57a8;
  --accent-soft:  #e6f1fd;
  --accent-line:  #b6d6f6;

  /* ── Estados ───────────────────────────────────────────────────── */
  --error:        #b42318;  --error-bg:  #fef3f2;  --error-line:  #fecdca;
  --warn:         #b54708;  --warn-bg:   #fffaeb;  --warn-line:   #fedf89;
  --ok:           #067647;  --ok-bg:     #ecfdf3;  --ok-line:     #abefc6;
  --info:         #1c579f;  --info-bg:   #e8eff8;  --info-line:   #bcd0e8;
}
```

**El estado `info` reutiliza el azul de marca a propósito.** Cuatro colores de
estado + un acento propio = cinco hues compitiendo. Al fundir «informativo» con
la marca quedan cuatro roles legibles: azul (marca e informativo),
rojo (error), ámbar (aviso), verde (éxito).

**Ventaja sobre la paleta anterior:** con marca y acción en azul, ningún estado
comparte hue con la interfaz. Antes la terracota y el rojo de error eran vecinos
y había que separarlos por saturación y contexto; ahora la distinción es
automática.

### Paleta de materias (12 colores)

Se asignan a las materias y se usan como texto (100 %) y como tinte de celda
(10 %). Todos se mantienen entre 38 % y 46 % de luminosidad para que el texto sea
legible sobre blanco Y sobre su propio tinte, y están desaturados lo suficiente
para convivir con el fondo azul claro de la aplicación.

```
#14417c marino    #a72b2b ladrillo   #1f6b4f pino      #9a6410 ocre
#2a6f8f pizarra   #6a3fa0 uva        #a13066 vino      #4f6d1f olivo
#b0531c naranja   #414a57 grafito    #0f6a72 jade      #7a4a2c café
```

**Prohibido** en esta paleta: `#22c55e`, `#3b82f6`, `#8b5cf6` y demás colores 500
de Tailwind. Son fluorescentes sobre papel y delatan la plantilla.

---

## 3 · Tipografía

**Una familia, dos anchos: Archivo y Archivo Narrow.** OFL y **alojadas en el
repositorio** (`assets/fonts/`, 88 KB): la app tiene que funcionar sin internet y
en GitHub Pages, así que no hay `@import` de Google Fonts.

| Ancho | Dónde | Por qué |
|---|---|---|
| **Archivo** | interfaz, titulares, cifras, nombres de día, número de hora | grotesca robusta; los titulares en 700 tienen peso sin gritar |
| **Archivo Narrow** | dentro de la tabla del horario | el ancho es oro en una celda: **«Form. Cívica y Ética» cabe en un renglón** y con cualquier otra familia se parte en dos |

Medido en el escenario de ejemplo (198 clases, formato técnico): **0 nombres de
materia partidos en dos renglones**. Con la tipografía anterior se partían en
todas las celdas de Formación Cívica y Ética.

En el formato para alumnos el cuerpo crece a 20 px y algunos nombres largos sí
vuelven a partirse (12 de 198): ahí es correcto, porque el tamaño manda sobre la
compacidad.

**Descartadas y por qué:**
- *Instrument Serif + DM Sans* (versión anterior) — el serif de alto contraste
  daba aire de invitación de boda, no de documento escolar, y no tiene negrita.
- *Source Serif + Source Sans* — correcta pero sin carácter propio.
- *IBM Plex Sans* — buena, pero más ancha: obliga a partir nombres de materia.
- *Libre Franklin* — sólida; perdió contra Archivo por el mismo motivo de ancho.

```css
@font-face {
  font-family: 'Archivo';
  src: url('../fonts/archivo-latin-400-normal.woff2') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
/* + 600 y 700, y los tres pesos de 'Archivo Narrow' */

--font-display: 'Archivo', -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-ui:      'Archivo', -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-narrow:  'Archivo Narrow', 'Archivo', 'Segoe UI', Roboto, sans-serif;
```

### Escala

| Rol | Familia | Tamaño / interlínea | Peso | Tracking |
|---|---|---|---|---|
| Título de pantalla (`h3`) | Archivo | 30px / 1.14 | 700 | −0.025em |
| Título de resultados (`h2`) | Archivo | 30px / 1.14 | 700 | −0.025em |
| Título de hoja | Archivo | 31px / 1.06 | 700 | −0.035em |
| Título hoja «alumnos» | Archivo | 68px / 1.06 | 700 | −0.045em |
| Cifra de métrica | Archivo | 29px / 1.1 | 700 | −0.03em |
| Número de hora (hoja) | Archivo | 19px / 1 | 700 | −0.03em |
| Nombre en fila (profesor) | Archivo | 14.5px | 500 | 0 |
| Cuerpo | Archivo | 14px / 1.55 | 400 | 0 |
| Etiqueta de campo | Archivo | 12.5px | 500 | 0 |
| Encabezado de columna | Archivo | 11px | 700 | 0.07em, MAYÚS |
| Nombre de día (hoja) | Archivo | 10.5px | 700 | 0.17em, MAYÚS |
| **Celda de horario** | **Archivo Narrow** | 12.5px | 700 | −0.005em |
| **Profesor en la celda** | **Archivo Narrow** | 10.5px | 400 | 0 |

**La jerarquía es de peso y ancho, no de familia.** Con una sola grotesca en dos
anchos, 700 vs 400 y 30px vs 12px bastan para separar cuatro niveles, y todo se
ve del mismo producto.

**Números tabulares obligatorios** (`font-variant-numeric: tabular-nums`) en
horas, contadores y cifras: sin ellos `07:00` y `11:30` tienen anchos distintos y
la columna de horas baila.

**Prohibido:** Inter, Poppins, Montserrat como titular; mezclar una tercera
familia; usar Archivo Narrow para texto de formulario (a 13 px cansa la vista);
y pedir pesos que no están descargados —el navegador los simula y se ven sucios—:
sólo existen 400, 600 y 700 de cada ancho.

---

## 4 · Componentes

### Botón

```css
.cw-btn {
  font-family: var(--font-ui); font-size: 13px; font-weight: 500;
  padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
  transition: background .14s ease, border-color .14s ease, transform .06s ease;
}
.cw-btn:hover      { background: var(--paper); border-color: #d6cec0; }
.cw-btn:active     { transform: translateY(1px); }
.cw-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.cw-btn[disabled]  { opacity: .45; cursor: not-allowed; }

.cw-btn--primary        { background: var(--accent); border-color: var(--accent); color: #fff; }
.cw-btn--primary:hover  { background: var(--accent-2); border-color: var(--accent-2); }
.cw-btn--ghost          { border-color: transparent; background: transparent; color: var(--brand); }
.cw-btn--ghost:hover    { background: var(--brand-soft); }
```

### Campo

Reposo con borde `--line`; hover `#d6cec0`; foco borde `--brand` + halo
`0 0 0 3px var(--brand-soft)`. Dentro de tablas editables el borde sólo aparece
al apuntar o escribir.

### Paso del riel

Reposo texto `--ink-2`; hover fondo `--paper`; **activo** fondo `--accent-soft`,
texto `--accent-2`, número en círculo azul sólido. Deshabilitado 40 % opacidad.

### Hoja imprimible — composición editorial

**El color codifica la materia UNA vez: en el nombre.** La versión anterior lo
codificaba tres veces —fondo tintado + borde izquierdo + texto de color— en las
33 celdas de la semana. Ese exceso de tinta es exactamente lo que hace que un
horario parezca plantilla descargada: mucha decoración, ninguna jerarquía.

| Elemento | Antes | Ahora |
|---|---|---|
| Encabezado de días | banda azul rellena, texto blanco | versalitas sobre regla de 2px |
| Celda | fondo al 10 % + borde de color + texto de color | sólo el nombre en color |
| Rejilla | borde completo en las cuatro caras | hairline horizontal; vertical al 40 % |
| Columna de hora | etiqueta «1a» + rango, mismo tamaño | número en serif 21px + rango 9px |
| Celda vacía | relleno gris | nada |
| Pie | línea de 1px | regla de 2px, leyenda en versalitas |

En el formato **para alumnos** el color vuelve como **pleca vertical de 3-4px** a
la izquierda de cada clase: a un metro de distancia hace falta un ancla no
tipográfica para saltar de materia en materia. En el formato **técnico** no hay
pleca — se lee de cerca y de frente.

El marco de pantalla (`.cw-sheet__frame`) sí lleva radio 14px y sombra; la hoja
en sí no lleva ninguna, porque html2canvas no rasteriza `box-shadow`.

### Mensaje

Radio 10px, borde 1px del color de estado, fondo tenue, texto oscuro del mismo
hue. Título en 500, cuerpo en 400.

---

## 5 · Layout

- Rejilla: `232px` (riel) + `minmax(0, 1fr)` (trabajo). Nunca `1fr` a secas.
- Ancho de contenido: `1120px`; resultados sin límite.
- Escala de espacio: **4 / 6 / 8 / 12 / 16 / 22 / 30 / 44 px**.
- Radios: 6 (chips internos) · 8 (controles) · 10 (mensajes) · 14 (hojas).
- Una sola superficie continua: separadores de 1px, nunca cajas anidadas.

---

## 6 · Profundidad

Tres niveles y ni uno más:

| Nivel | Uso | Valor |
|---|---|---|
| 0 | Todo el chrome | sin sombra, sólo líneas |
| 1 | Controles activos / segmentos | `0 1px 2px rgba(27,26,23,.08)` |
| 2 | Hoja imprimible | `0 1px 3px rgba(27,26,23,.07), 0 14px 34px -10px rgba(27,26,23,.16)` |

Sombras **cálidas** (base `27,26,23`, no `0,0,0`): un negro puro sobre papel
cálido se ve sucio.

---

## 7 · Animación e interacción — nivel L1

**Decisión: L1 (estático refinado), no L2/L3.** Esta es una herramienta de
trabajo, no una landing page: el director captura 200 profesores y genera
horarios. Reveals al hacer scroll, parallax y pin sabotearían la tarea. Los
requisitos de «signature motion» de la skill aplican a páginas de aterrizaje;
aquí serían ruido y costo de FPS. Si algún día hay landing comercial, esa página
sí va a L2.

Lo que sí hay:

```css
/* Entrada suave al cambiar de pantalla */
@keyframes cw-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
#studio > *, #results-panel > *, #settings-panel > * { animation: cw-rise .22s ease-out both; }

/* Transiciones sólo en propiedades baratas */
transition: background .14s ease, border-color .14s ease, color .14s ease;

/* Barra de progreso del cálculo */
.cw-progress > i { transition: width .25s ease; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

Regla dura: nada anima `width`, `height`, `top`, `left` ni `filter`.

---

## 8 · Reglas y anti-patrones

**Sí**

1. Dos familias con roles distintos: serif titula, sans opera.
2. Terracota sólo para acción; azul tinta para todo lo estructural.
3. Colores como variables CSS — excepto dentro de `.cw-card` (ver §9).
4. Jerarquía por familia y peso antes que por tamaño.
5. Números tabulares en cualquier cifra que se apile en columna.
6. Separadores de 1px en vez de cajas.
7. Sombras cálidas, nunca negro puro.
8. Todo control interactivo con estado `:hover` **y** `:focus-visible`.
9. Un solo botón de acción visible a la vez: la barra superior ya tiene el
   primario permanente («Generar horario»), así que el resto son secundarios.

**No**

1. **No** colores 500 de Tailwind (`#14b8a6`, `#3b82f6`, `#8b5cf6`…).
2. **No** un tercer color de acento — dos roles son el presupuesto completo.
3. **No** `color-mix()`, `oklch()` ni gradientes dentro de `.cw-card`:
   html2canvas 1.4.1 no los rasteriza igual y el PNG saldría distinto de la
   pantalla.
4. **No** `@import` de Google Fonts ni ningún CDN: la app debe abrir sin internet.
5. **No** sombras en el chrome de la aplicación; sólo la hoja imprimible flota.
6. **No** animar scroll, ni parallax, ni pin en las pantallas de captura.
7. **No** texto gris claro (`--ink-3`) por debajo de 14 px para contenido real;
   sólo etiquetas y elementos no textuales.
8. **No** más de dos pesos por familia en la misma pantalla.
9. **No** emoji como iconografía.
10. **No** `::before`/`::after` decorativos dentro de `.cw-card`: html2canvas los
    materializa como nodos reales durante el clonado, **antes** del hook que
    limpia el clon, así que terminan impresos en el PNG.
11. **No** animaciones con `fill-mode: both` que arranquen en `opacity: 0` sobre
    nodos exportables: html2canvas clona el DOM, la animación reinicia y el PNG
    sale en blanco. El exportador congela animaciones en el clon, pero la regla
    sigue en pie.

---

## 9 · Responsivo

| Punto de corte | Comportamiento |
|---|---|
| `> 900px` | Riel lateral fijo de 232px, contenido a 1120px |
| `≤ 900px` | El riel pasa a barra horizontal desplazable bajo el encabezado |
| `≤ 640px` | Formularios a una columna; el selector de modo se muda a Ajustes; título de pantalla 25px |
| `pointer: coarse` | Objetivos táctiles ≥ 44px de alto, celdas de disponibilidad de 32px |

Las tablas anchas y las hojas de 980-1400px se desplazan **dentro de su propio
marco** (`overflow-x: auto`); la página nunca se mueve en horizontal. Verificado
sin desbordamiento a 390px en las cinco pantallas.

### La hoja imprimible es una excepción deliberada

Dentro de `.cw-card` los colores van en hex/rgba literales y el ancho es fijo
(980 / 1080 / 1400px según la vista). No es descuido: ese nodo lo rasteriza
html2canvas y el PNG debe salir idéntico en cualquier monitor. El diseño
responsivo se aplica al marco que la contiene, no a la hoja.
