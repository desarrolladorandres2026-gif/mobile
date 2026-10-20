/**
 * Métricas en formato Prometheus, sin dependencias. Las etiquetas usan el patrón de la ruta
 * (`/v1/tenants/:tenantId/journals`), nunca la URL real: así el número de series no crece con
 * cada empresa o documento.
 */
const BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function createMetrics() {
  const requests = new Map();
  const durations = new Map();

  return {
    observe(method, route, status, seconds) {
      const requestKey = `${method}\u0000${route}\u0000${status}`;
      requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);

      const durationKey = `${method}\u0000${route}`;
      const entry = durations.get(durationKey) ?? { buckets: new Array(BUCKETS_SECONDS.length).fill(0), sum: 0, count: 0 };
      BUCKETS_SECONDS.forEach((limit, i) => {
        if (seconds <= limit) entry.buckets[i] += 1;
      });
      entry.sum += seconds;
      entry.count += 1;
      durations.set(durationKey, entry);
    },

    render() {
      const lines = [
        '# HELP lulubiz_http_requests_total Peticiones HTTP atendidas.',
        '# TYPE lulubiz_http_requests_total counter',
      ];
      for (const [key, value] of requests) {
        const [method, route, status] = key.split('\u0000');
        lines.push(
          `lulubiz_http_requests_total{method="${method}",route="${escapeLabel(route)}",status="${status}"} ${value}`,
        );
      }
      lines.push(
        '# HELP lulubiz_http_request_duration_seconds Duración de las peticiones HTTP.',
        '# TYPE lulubiz_http_request_duration_seconds histogram',
      );
      for (const [key, entry] of durations) {
        const [method, route] = key.split('\u0000');
        const labels = `method="${method}",route="${escapeLabel(route)}"`;
        BUCKETS_SECONDS.forEach((limit, i) => {
          lines.push(`lulubiz_http_request_duration_seconds_bucket{${labels},le="${limit}"} ${entry.buckets[i]}`);
        });
        lines.push(`lulubiz_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${entry.count}`);
        lines.push(`lulubiz_http_request_duration_seconds_sum{${labels}} ${entry.sum}`);
        lines.push(`lulubiz_http_request_duration_seconds_count{${labels}} ${entry.count}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}
