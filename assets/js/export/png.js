/**
 * Exportación del horario a PNG de alta calidad con html2canvas.
 *
 * Puntos que hacen la diferencia entre un PNG servible y uno que la escuela no
 * puede imprimir:
 *
 *  1. ESCALA EXPLÍCITA. html2canvas usa `devicePixelRatio` por defecto, así que la
 *     misma escuela obtendría 1× en una laptop vieja y 2× en una pantalla Retina.
 *     Aquí la escala la elige el usuario (2× pantalla, 3× impresión, 4× cartel) y
 *     se fija a mano.
 *  2. FUENTES CARGADAS. Sin esperar a `document.fonts.ready`, la primera
 *     exportación sale con la fuente de respaldo y distinta métrica.
 *  3. ANCHO FIJO EN EL CLON. En pantalla la tarjeta puede encogerse
 *     (`max-width:100%`); en el clon se restaura su ancho de diseño para que el
 *     PNG salga idéntico en cualquier monitor.
 *  4. MARCA DE AGUA VERIFICADA. Antes de rasterizar se comprueba que el nodo
 *     `[data-cw-watermark]` exista en el clon; si alguien lo borró con el
 *     inspector, se vuelve a inyectar. Es la regla de negocio del modo simple.
 *  5. CARGA BAJO DEMANDA. La librería (≈200 KB) se descarga la primera vez que se
 *     exporta, no al abrir la página.
 *
 * @module export/png
 */

const HTML2CANVAS_URL = new URL('../../vendor/html2canvas.min.js', import.meta.url).href;

let loaderPromise = null;

/** Carga html2canvas una sola vez (UMD → `window.html2canvas`). */
export function ensureHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HTML2CANVAS_URL;
    script.async = true;
    script.onload = () => (window.html2canvas
      ? resolve(window.html2canvas)
      : reject(new Error('html2canvas se cargó pero no quedó disponible en window.')));
    script.onerror = () => {
      loaderPromise = null;
      reject(new Error('No se pudo cargar html2canvas desde assets/vendor/html2canvas.min.js'));
    };
    document.head.appendChild(script);
  });
  return loaderPromise;
}

/** Nombre de archivo seguro en Windows, macOS y Linux. */
export function safeFilename(name, extension = 'png') {
  const base = String(name || 'horario')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quita acentos
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'horario';
  return `${base}.${extension}`;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) {
      // Respaldo para navegadores sin toBlob: data URL → Blob.
      try {
        const parts = canvas.toDataURL('image/png').split(',');
        const binary = atob(parts[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (error) {
        reject(error);
      }
      return;
    }
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('El navegador no pudo generar la imagen.'))),
      'image/png',
      1.0,
    );
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Se libera en el siguiente tick: revocarlo de inmediato cancela la descarga
  // en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Prepara el clon antes de rasterizar. Recibe el documento clonado que crea
 * html2canvas en un iframe aislado; nada de lo que se toque aquí afecta la página.
 */
function prepareClone(clonedDoc, marker, { watermarkRequired, watermarkText, designWidth }) {
  // (0) Congelar animaciones y transiciones en el clon.
  //
  // html2canvas clona el documento en un iframe: cualquier animación con
  // fill-mode 'both' vuelve a empezar y se rasteriza su PRIMER fotograma. Si ese
  // fotograma es `opacity: 0` —como la animación de entrada de pantalla— el PNG
  // sale en blanco. Es un fallo silencioso: no lanza error, sólo entrega una
  // imagen vacía. Congelarlo aquí lo vuelve imposible por construcción.
  const freeze = clonedDoc.createElement('style');
  freeze.textContent =
    '*, *::before, *::after { animation: none !important; transition: none !important; }';
  clonedDoc.head.appendChild(freeze);

  const clone = clonedDoc.querySelector(`[data-cw-export="${marker}"]`);
  if (!clone) return;

  // Las marcas del modo edición son ayuda de pantalla, no parte del documento.
  clone.classList.remove('is-editing');
  clone.querySelectorAll('.is-editing-selected, .is-editing-target, .is-editing-swap')
    .forEach((node) => node.classList.remove('is-editing-selected', 'is-editing-target', 'is-editing-swap'));

  // (3) ancho de diseño garantizado
  clone.style.maxWidth = 'none';
  if (designWidth) clone.style.width = `${designWidth}px`;
  clone.style.margin = '0';
  clone.style.boxShadow = 'none';
  clone.style.backgroundColor = '#ffffff';

  // Nada dentro de la tarjeta debe quedar recortado por scroll.
  clone.querySelectorAll('*').forEach((node) => {
    const style = clonedDoc.defaultView.getComputedStyle(node);
    if (style.overflow !== 'visible') node.style.overflow = 'visible';
  });

  // (4) la marca de agua no es negociable en modo simple
  if (watermarkRequired && !clone.querySelector('[data-cw-watermark]')) {
    const mark = clonedDoc.createElement('div');
    mark.setAttribute('data-cw-watermark', '1');
    mark.style.cssText =
      'text-align:right;font:700 15px -apple-system,Segoe UI,Roboto,sans-serif;' +
      'color:#0f6fd1;padding:8px 0 0;';
    mark.textContent = watermarkText || 'CronoWeb.com';
    clone.appendChild(mark);
  }
}

/**
 * Exporta un nodo del DOM como PNG y dispara la descarga.
 *
 * @param {HTMLElement} node nodo a rasterizar (típicamente una `.cw-card`)
 * @param {object} [options]
 * @param {string} [options.filename] nombre sin extensión
 * @param {number} [options.scale=3] 2 = pantalla, 3 = impresión, 4 = cartel
 * @param {string} [options.background='#ffffff']
 * @param {boolean} [options.watermarkRequired=true]
 * @param {string} [options.watermarkText='CronoWeb.com']
 * @param {boolean} [options.download=true] `false` devuelve el Blob sin descargar
 * @returns {Promise<{blob:Blob, filename:string, width:number, height:number}>}
 */
export async function exportNodeAsPng(node, options = {}) {
  if (!node) throw new Error('No hay nada que exportar.');

  const {
    filename = node.dataset?.exportName || 'horario',
    scale = 3,
    background = '#ffffff',
    watermarkRequired = true,
    watermarkText = 'CronoWeb.com',
    download = true,
  } = options;

  const html2canvas = await ensureHtml2Canvas();

  // (2) sin esto la primera exportación usa la fuente de respaldo
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* navegador sin Font Loading API */ }
  }

  // Marca temporal para localizar este nodo dentro del documento clonado.
  const marker = `cw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  node.dataset.cwExport = marker;

  // Ancho de diseño real (el CSS fija .cw-card a 980px; en móvil se encoge).
  const designWidth = Math.max(node.scrollWidth, Number.parseFloat(getComputedStyle(node).width) || 0);

  let canvas;
  try {
    canvas = await html2canvas(node, {
      scale,                          // (1) escala explícita, no devicePixelRatio
      backgroundColor: background,
      useCORS: true,                  // logos servidos desde otro origen
      allowTaint: false,              // un canvas contaminado no se puede exportar
      logging: false,
      imageTimeout: 15000,
      removeContainer: true,
      scrollX: 0,
      scrollY: 0,
      windowWidth: Math.max(document.documentElement.clientWidth, designWidth + 80),
      windowHeight: Math.max(document.documentElement.clientHeight, node.scrollHeight + 80),
      onclone: (clonedDoc) => prepareClone(clonedDoc, marker, {
        watermarkRequired, watermarkText, designWidth,
      }),
    });
  } catch (error) {
    throw new Error(`No se pudo generar la imagen: ${error?.message || error}`);
  } finally {
    delete node.dataset.cwExport;
  }

  const blob = await canvasToBlob(canvas);
  const name = safeFilename(filename);
  if (download) triggerDownload(blob, name);

  return { blob, filename: name, width: canvas.width, height: canvas.height };
}

/**
 * Exporta varios nodos en serie.
 *
 * En serie a propósito: rasterizar 20 grupos en paralelo dispara el uso de memoria
 * y los navegadores bloquean ráfagas de descargas. Entre archivos se cede el hilo
 * para que la interfaz siga respondiendo y el navegador no agrupe las descargas.
 *
 * @param {HTMLElement[]} nodes
 * @param {object} [options] mismas que `exportNodeAsPng`, más `onProgress(i, total, filename)`
 * @returns {Promise<{exported:string[], failed:{filename:string, error:string}[]}>}
 */
export async function exportNodesAsPng(nodes, options = {}) {
  const { onProgress, delayMs = 350, ...rest } = options;
  const exported = [];
  const failed = [];

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const name = node.dataset?.exportName || `horario-${i + 1}`;
    if (onProgress) onProgress(i, nodes.length, name);
    try {
      const result = await exportNodeAsPng(node, { ...rest, filename: name });
      exported.push(result.filename);
    } catch (error) {
      failed.push({ filename: name, error: error?.message || String(error) });
    }
    if (i < nodes.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (onProgress) onProgress(nodes.length, nodes.length, null);
  return { exported, failed };
}
