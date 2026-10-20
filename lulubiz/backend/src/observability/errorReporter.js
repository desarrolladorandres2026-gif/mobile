/**
 * Seguimiento de errores no controlados. La interfaz es mínima (`report(err, contexto)`) para que
 * cualquier destino (un webhook propio, un recolector tipo Sentry) sea un adaptador de pocas líneas.
 * Un reportero nunca debe lanzar ni bloquear: fallar al reportar no puede tumbar la petición.
 */
const SAFE_CONTEXT_KEYS = ['requestId', 'method', 'route', 'status', 'tenantId', 'userId', 'source'];

/** Deja pasar solo campos conocidos. Nunca viajan cookies, cabeceras ni cuerpos de petición. */
function scrub(context = {}) {
  return Object.fromEntries(
    SAFE_CONTEXT_KEYS.filter((key) => context[key] !== undefined).map((key) => [key, String(context[key])]),
  );
}

export function createLogReporter(log) {
  return {
    async report(err, context = {}) {
      log.error({ err, ...scrub(context) }, 'error reportado');
      return true;
    },
  };
}

/**
 * Envía cada error por POST JSON a `url`. Limita a `maxPerMinute` envíos para que un fallo en
 * cadena no inunde el destino ni agote recursos, y descarta el resto contándolos en `dropped`.
 */
export function createWebhookReporter({
  url,
  service = 'lulubiz',
  environment = 'production',
  fetchImpl = fetch,
  maxPerMinute = 30,
  timeoutMs = 3000,
  now = Date.now,
}) {
  if (!url) throw new Error('falta la URL del reportero de errores');
  let windowStart = now();
  let sent = 0;
  let dropped = 0;

  return {
    async report(err, context = {}) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        sent = 0;
      }
      if (sent >= maxPerMinute) {
        dropped += 1;
        return false;
      }
      sent += 1;
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            service,
            environment,
            at: new Date(t).toISOString(),
            name: err?.name ?? 'Error',
            message: err?.message ?? String(err),
            stack: String(err?.stack ?? '').split('\n').slice(0, 20).join('\n'),
            context: scrub(context),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    get dropped() {
      return dropped;
    },
  };
}

/** Combina varios destinos: el error va a todos y ninguno puede romper a los demás. */
export function combineReporters(...reporters) {
  return {
    async report(err, context) {
      const results = await Promise.allSettled(reporters.map((r) => r.report(err, context)));
      return results.some((r) => r.status === 'fulfilled' && r.value === true);
    },
  };
}

/**
 * Captura lo que escapa de todo manejo: promesas rechazadas y excepciones sin atrapar. Reporta y,
 * en una excepción sin atrapar, termina el proceso (su estado ya no es de fiar; el supervisor lo reinicia).
 */
export function installProcessHandlers({ reporter, log, exit = (code) => process.exit(code), target = process, flushMs = 1000 }) {
  target.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error({ err }, 'promesa rechazada sin manejar');
    reporter.report(err, { source: 'unhandledRejection' });
  });
  target.on('uncaughtException', async (err) => {
    log.fatal({ err }, 'excepción sin atrapar: el proceso termina');
    await Promise.race([reporter.report(err, { source: 'uncaughtException' }), new Promise((r) => setTimeout(r, flushMs))]);
    exit(1);
  });
}
