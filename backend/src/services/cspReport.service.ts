import { CspViolation } from '../models/CspViolation';
import { config } from '../config';

/**
 * Receptor de reportes de la Content-Security-Policy (M-025).
 *
 * Acepta los dos formatos que mandan los navegadores:
 *  · `report-uri` (el de siempre): `{ "csp-report": { "violated-directive", "blocked-uri", … } }`;
 *  · Reporting API (`report-to`): `[{ "type": "csp-violation", "body": { "effectiveDirective", "blockedURL", … } }]`.
 *
 * Es un endpoint público —el navegador no manda sesión— y por eso:
 *  · solo se aceptan reportes de documentos servidos por los paneles de ZIPP
 *    (`cors.origins`): cualquiera puede mandar basura, pero no llenar la tabla de
 *    orígenes inventados;
 *  · se guardan únicamente orígenes y palabras clave, nunca una URL completa;
 *  · todo se recorta y se agrupa (ver `CspViolation`).
 * Nunca devuelve error al navegador: no tiene nada que hacer con él.
 */

export interface NormalizedViolation {
  documentOrigin: string;
  directive: string;
  blocked: string;
  disposition: 'report' | 'enforce';
  sourceOrigin: string | null;
  sample: string | null;
}

const KEYWORDS = new Set(['inline', 'eval', 'data', 'blob', 'self', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink']);

/** `https://x.com/a/b?c=1` → `https://x.com`; `inline`/`eval`/`data:`… → la palabra; basura → null. */
export function toOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const raw = value.trim().toLowerCase();
  const keyword = raw.replace(/:.*$/, '');
  if (KEYWORDS.has(raw)) return raw;
  if (/^(data|blob|about|filesystem):/.test(raw)) return keyword;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') {
      return url.origin.slice(0, 200);
    }
    return url.protocol.replace(':', '').slice(0, 20);
  } catch {
    return null;
  }
}

/** Las directivas de CSP que existen: lo que no sea una de ellas no es un reporte, es ruido. */
const DIRECTIVES = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr',
  'img-src', 'font-src', 'connect-src', 'media-src', 'object-src', 'frame-src', 'child-src', 'worker-src',
  'manifest-src', 'prefetch-src', 'base-uri', 'form-action', 'frame-ancestors', 'navigate-to', 'sandbox',
  'require-trusted-types-for', 'trusted-types',
]);

function pick(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Los dos formatos a una sola forma. Lo que no encaja se descarta. */
export function normalize(body: unknown): NormalizedViolation[] {
  const items: unknown[] = Array.isArray(body) ? body : [body];
  const out: NormalizedViolation[] = [];

  for (const item of items.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, any>;

    // Reporting API: { type, body: {...} }. report-uri: { 'csp-report': {...} }.
    const fields: Record<string, unknown> | null =
      record.type === 'csp-violation' && record.body && typeof record.body === 'object'
        ? {
            documentUri: record.body.documentURL ?? record.url,
            directive: record.body.effectiveDirective ?? record.body.violatedDirective,
            blocked: record.body.blockedURL,
            disposition: record.body.disposition,
            source: record.body.sourceFile,
            sample: record.body.sample,
          }
        : record['csp-report'] && typeof record['csp-report'] === 'object'
          ? {
              documentUri: record['csp-report']['document-uri'],
              directive: record['csp-report']['effective-directive'] ?? record['csp-report']['violated-directive'],
              blocked: record['csp-report']['blocked-uri'],
              disposition: record['csp-report'].disposition,
              source: record['csp-report']['source-file'],
              sample: record['csp-report']['script-sample'],
            }
          : null;
    if (!fields) continue;

    const documentOrigin = toOrigin(fields.documentUri);
    const directive = (pick(fields.directive) ?? '').split(' ')[0].toLowerCase();
    const blocked = toOrigin(fields.blocked) ?? (fields.blocked === '' ? 'inline' : null);
    if (!documentOrigin || !DIRECTIVES.has(directive) || !blocked) continue;

    const sample = pick(fields.sample);
    out.push({
      documentOrigin,
      directive,
      blocked,
      disposition: fields.disposition === 'enforce' ? 'enforce' : 'report',
      sourceOrigin: toOrigin(fields.source),
      sample: sample ? sample.replace(/\s+/g, ' ').slice(0, 40) : null,
    });
  }
  return out;
}

/** Orígenes de documento aceptados: los paneles y la PWA de ZIPP. */
function allowedDocumentOrigins(): Set<string> {
  return new Set(
    config.cors.origins
      .filter((o) => /^https?:\/\//.test(o))
      .map((o) => o.replace(/\/+$/, '').toLowerCase())
  );
}

/**
 * Tope de grupos distintos guardados a la vez. Pasado el tope, lo ya conocido sigue
 * contando pero no entran grupos nuevos: un reporte lo puede mandar cualquiera, y el
 * origen bloqueado lo elige quien lo manda; sin tope, rotarlo llenaría la colección
 * (el TTL de 30 días solo la vacía con el tiempo).
 */
export const CSP_MAX_GROUPS = 5_000;

export const cspReportService = {
  /** Guarda (agrupando) lo que llegue. Devuelve cuántas infracciones se contaron. */
  async record(body: unknown, now = new Date(), maxGroups = CSP_MAX_GROUPS): Promise<number> {
    const allowed = allowedDocumentOrigins();
    const full = (await CspViolation.estimatedDocumentCount()) >= maxGroups;
    let counted = 0;
    for (const v of normalize(body)) {
      if (!allowed.has(v.documentOrigin)) continue;
      const key = `${v.documentOrigin}|${v.directive}|${v.blocked}`.slice(0, 400);
      await CspViolation.updateOne(
        { key },
        {
          $inc: { count: 1 },
          $set: { lastSeen: now, disposition: v.disposition },
          $setOnInsert: {
            key,
            documentOrigin: v.documentOrigin,
            directive: v.directive,
            blocked: v.blocked,
            firstSeen: now,
            sourceOrigin: v.sourceOrigin,
            sample: v.sample,
          },
        },
        { upsert: !full }
      );
      counted += 1;
    }
    return counted;
  },

  /** Lo que el panel enseña: las infracciones, las más repetidas primero. */
  async list(filter: { documentOrigin?: string; limit?: number } = {}) {
    const q: Record<string, unknown> = {};
    if (filter.documentOrigin) q.documentOrigin = filter.documentOrigin;
    return CspViolation.find(q)
      .sort({ count: -1, lastSeen: -1 })
      .limit(Math.min(filter.limit ?? 100, 500))
      .lean();
  },
};
