import { api } from './api.js';

/**
 * Razón social y NIT de la empresa para los archivos exportados. Salen del emisor de facturación, que es el único
 * lugar donde la empresa los registra. Si no hay emisor o el rol no puede leerlo (cajero), queda el nombre de la
 * empresa sin identificación: exportar nunca falla por esto.
 */

const TTL = 5 * 60 * 1000;
const cache = new Map(); // ruta base → { at, value }

/** «NIT 900.123.456-7». Sin identificación, null. */
export function taxIdLabel(issuer) {
  if (!issuer?.taxId) return null;
  const id = /^\d+$/.test(issuer.taxId) ? issuer.taxId.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : issuer.taxId;
  const dv = issuer.checkDigit !== undefined && issuer.checkDigit !== null ? `-${issuer.checkDigit}` : '';
  return `${issuer.taxIdType ?? 'NIT'} ${id}${dv}`;
}

/** `{ name, taxIdLabel }` de la empresa de `base` (`/v1/tenants/:id`). Se guarda unos minutos. */
export async function loadCompanyIdentity(base, fallbackName) {
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let issuer = null;
  if (base) {
    try {
      issuer = (await api.get(`${base}/invoicing/settings`))?.settings?.issuer ?? null;
    } catch {
      issuer = null;
    }
  }
  const value = { name: issuer?.name || fallbackName || '', taxIdLabel: taxIdLabel(issuer) };
  if (issuer) cache.set(base, { at: Date.now(), value });
  return value;
}
