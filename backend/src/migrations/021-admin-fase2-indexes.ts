import mongoose from 'mongoose';
import { config } from '../config';
import {
  InternalNote,
  AlertReceipt,
  DriverOffer,
  Pqrs,
  Advertisement,
  CouponRedemption,
} from '../models';

/**
 * Migración 021 — índices y colecciones de la Fase 2 del panel admin.
 *
 * - `InternalNote` y `AlertReceipt` (colecciones nuevas): sus índices, incluido
 *   el único `(userId, key)` y el TTL de 30 días de `AlertReceipt`.
 * - `DriverOffer {orderId, round}`: la ficha del pedido lista sus ofertas.
 * - `Pqrs {orderId}`, `{businessId, createdAt}`, `{driverId, createdAt}`: lo
 *   reciente de cada ficha.
 * - `Advertisement {billedToBusinessId, createdAt}`: publicidad de un comercio.
 * - `CouponRedemption {userId, createdAt}`: canjes recientes de un cliente.
 *
 * No hay datos que migrar ni backfill. Mongoose ya crea estos índices al
 * arrancar (`autoIndex`), pero, siguiendo el precedente de la 006, conviene
 * crearlos ANTES de desplegar para que el primer arranque no construya índices
 * sobre colecciones grandes mientras atiende tráfico.
 *
 * Usa `createIndexes()` —solo añade lo que falta— y nunca `syncIndexes()`, que
 * además borraría cualquier índice no declarado en el esquema (ver la nota de
 * la migración 003).
 *
 *   npm run migrate:admin-fase2-indexes -- --dry-run   # solo informa
 *   npm run migrate:admin-fase2-indexes                # crea lo que falte
 *
 * Manual a propósito: no forma parte de `deploy.sh`.
 */
const MODELS = [
  { label: 'internalnotes', model: InternalNote },
  { label: 'alertreceipts', model: AlertReceipt },
  { label: 'driveroffers', model: DriverOffer },
  { label: 'pqrs', model: Pqrs },
  { label: 'advertisements', model: Advertisement },
  { label: 'couponredemptions', model: CouponRedemption },
] as const;

const keyOf = (spec: Record<string, unknown>) => JSON.stringify(spec);

async function existingKeys(model: (typeof MODELS)[number]['model']): Promise<Set<string>> {
  try {
    return new Set((await model.collection.indexes()).map((i) => keyOf(i.key as Record<string, unknown>)));
  } catch {
    // La colección aún no existe (NamespaceNotFound): no hay ningún índice.
    return new Set();
  }
}

export interface Fase2IndexesReport {
  /** `coleccion.{"campo":1}` de cada índice que falta (dry-run) o que se creó. */
  missing: string[];
  created: string[];
  dryRun: boolean;
}

export async function migrateAdminFase2Indexes(options: { dryRun?: boolean } = {}): Promise<Fase2IndexesReport> {
  const dryRun = options.dryRun === true;
  const missing: string[] = [];
  const created: string[] = [];

  for (const { label, model } of MODELS) {
    const before = await existingKeys(model);
    const declared = model.schema.indexes().map(([fields]) => keyOf(fields as Record<string, unknown>));
    // `_id` siempre existe; los índices de campo con `index: true` también están en `schema.indexes()`.
    const absent = declared.filter((k) => !before.has(k));
    missing.push(...absent.map((k) => `${label}.${k}`));

    if (!dryRun) {
      await model.createIndexes();
      const after = await existingKeys(model);
      created.push(...[...after].filter((k) => !before.has(k)).map((k) => `${label}.${k}`));
    }
  }
  return { missing, created, dryRun };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 021 — índices de la Fase 2 del panel admin${dryRun ? ' (dry-run)' : ''}\n`);

    try {
      const report = await migrateAdminFase2Indexes({ dryRun });
      if (dryRun) {
        console.log(report.missing.length ? `  Faltan: ${report.missing.join(', ')}` : '  No falta ninguno.');
      } else {
        console.log(report.created.length ? `  Creados: ${report.created.join(', ')}` : '  Ya existían todos.');
      }
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
