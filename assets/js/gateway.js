/**
 * Puerta de enlace al motor de horarios.
 *
 * Un único punto donde se decide QUIÉN resuelve:
 *   · `local`  → Web Worker con el motor JS. Es el modo de GitHub Pages: sin
 *                servidor, sin costos y sin que los datos de la escuela salgan
 *                del navegador.
 *   · `remote` → API FastAPI (`backend/`). Mismo contrato JSON, misma respuesta.
 *                Es el camino del plan de pago: escuelas grandes, licencias,
 *                persistencia e integraciones.
 *
 * El resto de la aplicación no sabe cuál está activo: pide `generate()` y recibe
 * un `ScheduleResponse`. Cambiar de motor no toca el UI.
 *
 * @module gateway
 */

export class GatewayError extends Error {
  constructor(message, { issues = [], cause = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.issues = issues;
    this.cause = cause;
  }
}

export class SolverGateway {
  /** @param {{mode?:'local'|'remote', apiUrl?:string, plan?:string}} [config] */
  constructor(config = {}) {
    this.mode = config.mode || 'local';
    this.apiUrl = (config.apiUrl || '').replace(/\/+$/, '');
    this.plan = config.plan || 'free';
    this.worker = null;
    this.controller = null;
    this.seq = 0;
  }

  configure(config = {}) {
    if (config.mode && config.mode !== this.mode) {
      this.dispose();
      this.mode = config.mode;
    }
    if (config.apiUrl !== undefined) this.apiUrl = String(config.apiUrl).replace(/\/+$/, '');
    if (config.plan) this.plan = config.plan;
  }

  /** Aborta el cálculo en curso (mata el worker o cancela el fetch). */
  cancel() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  dispose() {
    this.cancel();
  }

  /**
   * @param {object} payload petición completa
   * @param {{onProgress?:(p:object)=>void}} [opts]
   * @returns {Promise<object>} ScheduleResponse
   */
  generate(payload, opts = {}) {
    return this.mode === 'remote'
      ? this.#remote('generate', payload)
      : this.#local('generate', payload, opts.onProgress);
  }

  /** @returns {Promise<object>} ScheduleResponse sin asignaciones (sólo diagnóstico) */
  validate(payload) {
    return this.mode === 'remote' ? this.#remote('validate', payload) : this.#local('validate', payload);
  }

  // ------------------------------------------------------------------ //
  // Motor local (Web Worker)
  // ------------------------------------------------------------------ //
  #ensureWorker() {
    if (this.worker) return this.worker;
    // `type: 'module'` permite que el worker use los mismos ES modules del motor
    // sin duplicar código ni empaquetar nada.
    this.worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
    return this.worker;
  }

  #local(type, payload, onProgress) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = this.#ensureWorker();
      } catch (error) {
        reject(new GatewayError(
          'Este navegador no pudo iniciar el motor local. Ábrelo desde una dirección http:// ' +
          '(no como archivo local) o usa el motor por servidor.',
          { cause: error },
        ));
        return;
      }

      const id = ++this.seq;
      const onMessage = (event) => {
        const data = event.data || {};
        if (data.id !== id) return;

        if (data.type === 'progress') {
          if (onProgress) onProgress(data);
          return;
        }
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);

        if (data.type === 'result') resolve(data.response);
        else reject(new GatewayError(data.message || 'Error en el motor', { issues: data.issues || [] }));
      };

      const onError = (event) => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        // Un error a nivel worker suele dejarlo inservible: se descarta.
        this.worker = null;
        reject(new GatewayError(event.message || 'El motor local falló inesperadamente'));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type, id, payload, plan: this.plan });
    });
  }

  // ------------------------------------------------------------------ //
  // Motor remoto (FastAPI)
  // ------------------------------------------------------------------ //
  async #remote(type, payload) {
    if (!this.apiUrl) throw new GatewayError('Falta la URL de la API para usar el motor por servidor.');

    this.controller = new AbortController();
    const endpoint = `${this.apiUrl}/api/v1/schedule/${type}`;

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CronoWeb-Plan': this.plan },
        body: JSON.stringify(payload),
        signal: this.controller.signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new GatewayError('Cálculo cancelado.');
      throw new GatewayError(
        `No se pudo contactar la API en ${this.apiUrl}. Revisa que el servidor esté encendido ` +
        'y que permita el origen de esta página (CORS).',
        { cause: error },
      );
    } finally {
      this.controller = null;
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new GatewayError(`La API respondió ${response.status} sin contenido JSON válido.`, { cause: error });
    }

    if (!response.ok) {
      // 422 del backend trae la lista de campos inválidos; se muestra tal cual.
      const issues = Array.isArray(body.errors)
        ? body.errors.map((e) => `${e.campo}: ${e.error}`)
        : [];
      throw new GatewayError(body.message || body.detail || `La API respondió ${response.status}.`, { issues });
    }
    return body;
  }
}
