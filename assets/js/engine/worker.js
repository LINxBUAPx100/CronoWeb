/**
 * Web Worker del motor local.
 *
 * El backtracking bloquea el hilo donde corre. Ejecutarlo aquí mantiene la
 * interfaz viva (barra de progreso, botón de cancelar) incluso si una escuela
 * grande consume los 10 s completos de presupuesto.
 *
 * Protocolo:
 *   → { type: 'generate' | 'validate', id, payload, plan }
 *   ← { type: 'progress', id, attempt, placed, required }
 *   ← { type: 'result',   id, response }
 *   ← { type: 'error',    id, message, issues? }
 *
 * @module engine/worker
 */

import { ContractError, generateSchedule, validateOnly } from './index.js';

self.addEventListener('message', (event) => {
  const { type, id, payload, plan } = event.data || {};

  try {
    if (type === 'generate') {
      const response = generateSchedule(payload, {
        plan,
        onProgress: (p) => self.postMessage({ type: 'progress', id, ...p }),
      });
      self.postMessage({ type: 'result', id, response });
      return;
    }
    if (type === 'validate') {
      self.postMessage({ type: 'result', id, response: validateOnly(payload, { plan }) });
      return;
    }
    self.postMessage({ type: 'error', id, message: `Operación desconocida: ${type}` });
  } catch (error) {
    if (error instanceof ContractError) {
      self.postMessage({ type: 'error', id, message: error.message, issues: error.issues });
    } else {
      self.postMessage({
        type: 'error',
        id,
        message: error?.message || 'Error inesperado en el motor de horarios',
        stack: error?.stack || null,
      });
    }
  }
});
