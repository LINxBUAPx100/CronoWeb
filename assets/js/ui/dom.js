/**
 * Utilidades mínimas de DOM.
 *
 * No es un framework: son cuatro funciones para no repetir
 * `document.createElement` trescientas veces. Se construye con nodos reales
 * (nada de innerHTML con datos del usuario), así que no hay superficie de XSS
 * aunque una escuela escriba `<script>` en el nombre de una materia.
 *
 * @module ui/dom
 */

/**
 * @param {string} tag  etiqueta, admite `div.clase.otra`
 * @param {object|string|Node|Array} [props] atributos, o directamente los hijos
 * @param {...(string|Node|Array|null|false)} children
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name);
  if (classes.length) node.className = classes.join(' ');

  const isProps = props && typeof props === 'object' && !Array.isArray(props) && !(props instanceof Node);
  if (isProps) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = `${node.className} ${value}`.trim();
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== 'list') {
        node[key] = value;
      } else {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
  } else if (props != null) {
    children.unshift(props);
  }

  append(node, children);
  return node;
}

function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false || child === '') continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export const mount = (node, ...children) => append(clear(node), children);

/** Campo etiquetado: `field('Nombre', input, 'ayuda')`. */
export const field = (label, control, hint) =>
  h('label.cw-field', h('span', label), control, hint && h('small', hint));

/** Input controlado: llama `onInput(value)` en cada cambio. */
export function input(type, value, onInput, attrs = {}) {
  const node = h('input', { type, value: value ?? '', ...attrs });
  const handler = () => onInput(type === 'number' ? Number(node.value) : node.value);
  node.addEventListener(type === 'color' || type === 'checkbox' ? 'change' : 'input', handler);
  if (type === 'number') node.addEventListener('change', handler);
  return node;
}

export function checkbox(checked, onChange, label) {
  const box = h('input', { type: 'checkbox', checked: Boolean(checked) });
  box.addEventListener('change', () => onChange(box.checked));
  return label
    ? h('label.cw-check', box, h('span', label))
    : box;
}

export function select(options, value, onChange, attrs = {}) {
  const node = h('select', attrs,
    options.map(([val, text]) => h('option', { value: val, selected: String(val) === String(value) }, text)));
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

export const button = (label, onClick, className = 'cw-btn') =>
  h('button', { type: 'button', class: className, onClick }, label);

/** Botón de icono para borrar filas. */
export const iconButton = (label, title, onClick, className = 'cw-icon-btn') =>
  h('button', { type: 'button', class: className, title, 'aria-label': title, onClick }, label);
