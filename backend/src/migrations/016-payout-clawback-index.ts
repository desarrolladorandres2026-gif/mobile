import mongoose from 'mongoose';
import { config } from '../config';
import { Payout } from '../models';

/**
 * Migración 016 — índice de arrastre en `Payout`.
 *
 * `Payout.ts` declara ahora `{ orderId: 1, beneficiary: 1 }` único con
 * `partialFilterExpression: { isClawback: false }` y nombre explícito
 * `one_payout_per_order_beneficiary`, para poder abrir una segunda fila de
 * arrastre (`isClawback: true`) del mismo pedido y beneficiario cuando un
 * reembolso llega tarde sobre un payout ya liquidado.
 *
 * La base real ya tiene un índice con las mismas claves pero **sin**
 * `partialFilterExpression` (creado antes de que existiera `isClawback`,
 * probablemente sin nombre explícito — Mongo lo llama `orderId_1_beneficiary_1`
 * por defecto). Mongo no permite dos índices con las mismas claves aunque
 * cambie el filtro parcial: `Payout.createIndexes()` falla con
 * `IndexKeySpecsConflict` y la aplicación arranca creyendo que tiene la
 * garantía nueva cuando en realidad conserva la vieja — el primer intento de
 * crear un arrastre revienta con `E11000` contra el índice viejo, deja el
 * `Refund` en PENDING para siempre y el cerrojo `one_refund_in_flight_per_order`
 * bloquea cualquier reintento.
 *
 * Qué hace, en orden y de forma idempotente:
 *
 *   1. `isClawback: false` donde el campo no existe (documentos creados
 *      antes de este cambio) — sin esto no calzarían con el filtro parcial
 *      del índice nuevo y quedarían fuera de la garantía de unicidad.
 *   2. Si existe un índice sobre `{orderId, beneficiary}` sin
 *      `partialFilterExpression`, se borra.
 *   3. `Payout.createIndexes()` construye el índice nuevo declarado en el
 *      esquema.
 *
 * **Debe correr antes de desplegar el código nuevo**, no después: si el
 * modelo nuevo llega a producción con el índice viejo todavía puesto, todo
 * arrastre falla desde el primer minuto.
 *
 * No toca dinero ni reordena nada: solo backfillea un campo y reconstruye un
 * índice. Segura de ejecutar más de una vez.
 */

export interface PayoutClawbackIndexReport {
  backfilledIsClawback: number;
  droppedOldIndex: string | null;
  indexesAfter: string[];
  warnings: string[];
}

const KEY_SIGNATURE = JSON.stringify({ orderId: 1, beneficiary: 1 });

export async function migratePayoutClawbackIndex(
  options: { dryRun?: boolean } = {}
): Promise<PayoutClawbackIndexReport> {
  const dryRun = options.dryRun ?? false;
  const report: PayoutClawbackIndexReport = {
    backfilledIsClawback: 0,
    droppedOldIndex: null,
    indexesAfter: [],
    warnings: [],
  };

  // ── 1. Backfill de `isClawback` ──
  const toBackfill = await Payout.countDocuments({ isClawback: { $exists: false } });
  report.backfilledIsClawback = toBackfill;
  if (toBackfill > 0 && !dryRun) {
    await Payout.updateMany({ isClawback: { $exists: false } }, { $set: { isClawback: false } });
  }

  // ── 2. Borrar el índice viejo, si existe y no tiene filtro parcial ──
  const existingIndexes = await Payout.collection.indexes();
  const oldIndex = existingIndexes.find((idx: any) => {
    const keySignature = JSON.stringify(idx.key);
    return keySignature === KEY_SIGNATURE && !idx.partialFilterExpression;
  });

  if (oldIndex) {
    report.warnings.push(
      `Índice viejo encontrado: "${oldIndex.name}" sobre {orderId, beneficiary} sin filtro parcial.`
    );
    if (!dryRun) {
      await Payout.collection.dropIndex(oldIndex.name as string);
      report.droppedOldIndex = oldIndex.name as string;
    }
  } else {
    report.warnings.push('No se encontró un índice viejo sin filtro parcial: nada que borrar.');
  }

  // ── 3. Construir el índice nuevo ──
  if (!dryRun) {
    try {
      await Payout.createIndexes();
    } catch (error) {
      report.warnings.push(
        `No se pudo construir el índice nuevo de Payout: ${(error as Error).message}`
      );
    }
  }

  const after = await Payout.collection.indexes();
  report.indexesAfter = after.map(
    (idx: any) => idx.name + (idx.partialFilterExpression ? ' (parcial)' : '')
  );

  return report;
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(
      `\n▸ Migración 016 — Índice de arrastre en Payout${dryRun ? ' (ejecución en seco)' : ''}\n`
    );

    try {
      const report = await migratePayoutClawbackIndex({ dryRun });

      console.log(`  Payouts sin isClawback (backfill)  ${report.backfilledIsClawback}`);
      console.log(`  Índice viejo borrado                ${report.droppedOldIndex ?? '(ninguno)'}`);
      console.log(`  Índices tras la migración           ${report.indexesAfter.join(', ')}`);

      if (report.warnings.length > 0) {
        console.log(`\n  Detalle (${report.warnings.length}):`);
        for (const warning of report.warnings) console.log(`   • ${warning}`);
      }

      console.log(dryRun ? '\n✔ Ejecución en seco completada (nada se escribió)\n' : '\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
