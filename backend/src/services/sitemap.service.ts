import { config } from '../config';
import { Business, LegalDocument } from '../models';

/**
 * `sitemap.xml` del sitio público.
 *
 * Qué entra: las páginas fijas, cada documento legal vigente y cada comercio
 * que la ficha pública (`businessService.getPublicBySlug`) serviría: aprobado,
 * no archivado y no suspendido. `isActive` NO se exige a propósito: es el
 * interruptor "abierto/cerrado" del dueño, y un local cerrado a esta hora
 * sigue teniendo ficha pública; sacarlo y meterlo del mapa cada día solo
 * confunde a los buscadores.
 *
 * Caché: un `Map` por proceso con TTL de 10 minutos. Es una optimización pura
 * (el XML se recalcula igual si el proceso reinicia o hay otra instancia), no
 * estado de negocio, así que no bloquea la escala.
 */

export const SITEMAP_MAX_BUSINESSES = 5000;
export const SITEMAP_TTL_MS = 10 * 60 * 1000;

const STATIC_PATHS = ['/', '/comercios', '/soporte', '/unete-comercio', '/repartidores', '/eliminar-cuenta'];

const cacheStore = new Map<string, { xml: string; expiresAt: number }>();

export function clearSitemapCache(): void {
  cacheStore.clear();
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Caracteres de control: no son válidos en XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

interface Entry {
  path: string;
  lastmod?: Date;
}

function render(base: string, entries: Entry[]): string {
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod && !Number.isNaN(e.lastmod.getTime()) ? `<lastmod>${e.lastmod.toISOString()}</lastmod>` : '';
      return `  <url><loc>${escapeXml(base + e.path)}</loc>${lastmod}</url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

async function build(): Promise<string> {
  const base = config.webUrl.replace(/\/+$/, '');

  const [docs, businesses] = await Promise.all([
    LegalDocument.find({ isActive: true, effectiveAt: { $lte: new Date() } })
      .select('kind updatedAt')
      .lean(),
    Business.find({ isApproved: true, isArchived: { $ne: true }, isSuspended: { $ne: true }, slug: { $exists: true, $ne: '' } })
      .select('slug updatedAt')
      .sort({ _id: 1 })
      .limit(SITEMAP_MAX_BUSINESSES)
      .lean(),
  ]);

  // Un documento por tipo: si hubiera dos vigentes, gana el modificado más reciente.
  const legalByKind = new Map<string, Date>();
  for (const d of docs) {
    const prev = legalByKind.get(d.kind);
    if (!prev || (d.updatedAt && d.updatedAt > prev)) legalByKind.set(d.kind, d.updatedAt);
  }

  const entries: Entry[] = [
    ...STATIC_PATHS.map((path) => ({ path })),
    ...[...legalByKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, lastmod]) => ({ path: `/legal/${encodeURIComponent(kind)}`, lastmod })),
    ...businesses.map((b) => ({ path: `/negocio/${encodeURIComponent(b.slug)}`, lastmod: b.updatedAt })),
  ];
  return render(base, entries);
}

export async function getSitemapXml(now = Date.now()): Promise<string> {
  const hit = cacheStore.get('sitemap');
  if (hit && hit.expiresAt > now) return hit.xml;
  const xml = await build();
  cacheStore.set('sitemap', { xml, expiresAt: now + SITEMAP_TTL_MS });
  return xml;
}
