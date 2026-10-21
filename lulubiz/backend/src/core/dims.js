import { COLLECTIONS } from '../data/db.js';

const CENTER = /^[A-Z0-9][A-Z0-9_-]{0,9}$/;

/** Código de un centro de costo, normalizado, o `undefined` si no se indicó. */
export function normalizeCenter(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return code || undefined;
}

/**
 * Suma importes por cuenta y centro de costo, conservando el centro en cada grupo. Un documento reparte lo mismo en
 * varias líneas de asiento si sus líneas son de centros distintos: así el resultado por centro cuadra con el documento.
 */
export function sumByAccountAndCenter(items, amountOf) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.accountId}|${item.costCenter ?? ''}`;
    const cur = groups.get(key) ?? { accountId: item.accountId, ...(item.costCenter ? { costCenter: item.costCenter } : {}), amount: 0 };
    cur.amount += amountOf(item);
    groups.set(key, cur);
  }
  return [...groups.values()];
}

/** Los centros de costo de un documento existen y están activos. `fail(mensaje)` lanza el error propio del módulo. */
export async function requireCostCenters(db, tenantId, codes, fail) {
  const wanted = [...new Set(codes.filter(Boolean))];
  for (const code of wanted) if (!CENTER.test(code)) fail(`el centro de costo ${code} no es un código válido`);
  if (!wanted.length) return;
  const found = await db.collection(COLLECTIONS.costCenters).find({ tenantId, code: { $in: wanted }, active: true }, { projection: { code: 1 } }).toArray();
  const ok = new Set(found.map((c) => c.code));
  const missing = wanted.filter((c) => !ok.has(c));
  if (missing.length) fail(`el centro de costo ${missing.join(', ')} no existe o está inactivo`);
}
