/**
 * Servidor estático mínimo para desarrollo (`npm run serve`).
 *
 * La app usa ES modules y un Web Worker: no funciona abriendo index.html con
 * doble clic (file://). Esto sirve la carpeta igual que lo hará GitHub Pages.
 * Cero dependencias a propósito.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const relative = normalize(url === '/' ? 'index.html' : url.replace(/^\/+/, ''));

  // Cortafuegos de path traversal: nada fuera de la raíz del proyecto.
  if (relative.startsWith('..') || relative.includes(`..${sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const filePath = join(ROOT, relative);
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`No encontrado: ${relative}`);
    return;
  }
  if (stats.isDirectory()) {
    res.writeHead(302, { Location: `${url.replace(/\/$/, '')}/index.html` }).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`\n  CronoWeb → http://localhost:${PORT}\n  (Ctrl+C para detener)\n`);
});
