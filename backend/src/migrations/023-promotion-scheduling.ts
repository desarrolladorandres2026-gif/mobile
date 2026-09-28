import mongoose from 'mongoose';
import { config } from '../config';
import { Coupon, Business, CouponRedemption } from '../models';

/**
 * Migración 023 — promociones automáticas por producto y envío gratis con
 * vigencia.
 *
 * `Coupon` gana `autoApply`/`productIds` (una promoción sin código, limitada
 * a productos concretos) y `Business` gana cinco campos de vigencia para
 * `freeDeliveryThreshold` (fecha de inicio/fin, días, franja horaria). El
 * código nuevo tolera documentos sin estos campos gracias a los defaults del
 * schema — esta migración es limpieza para que consultas ad-hoc
 * (`find({autoApply:true})`, reportes) no tengan que tratar `undefined` como
 * `false`, no un requisito de arranque.
 *
 * Lo que sí **es** requisito de arranque es el punto 3: `CouponRedemption`
 * pasa de un índice único por `{orderId}` a uno único por
 * `{orderId, couponId}`, porque un pedido ahora puede canjear el cupón de
 * código **más** una o varias promociones automáticas. Debe correr **antes**
 * de desplegar el código que puede canjear más de una vez por pedido: si el
 * código nuevo llega con el índice viejo todavía puesto, el segundo canje de
 * cualquier pedido revienta con `E11000`.
 *
 * Idempotente: correrla dos veces no cambia el resultado.
 */

export interface PromotionSchedulingReport {
  backfilledCoupons: number;
  backfilledBusinesses: number;
  droppedOldRedemptionIndex: string | null;
  redemptionIndexesAfter: string[];
  warnings: string[];
}

const REDEMPTION_KEY_SIGNATURE = JSON.stringify({ orderId: 1 });

export async function migratePromotionScheduling(
  options: { dryRun?: boolean } = {}
): Promise<PromotionSchedulingReport> {
  const dryRun = options.dryRun ?? false;
  const report: PromotionSchedulingReport = {
    backfilledCoupons: 0,
    backfilledBusinesses: 0,
    droppedOldRedemptionIndex: null,
    redemptionIndexesAfter: [],
    warnings: [],
  };

  // ── 1. Backfill de Coupon.autoApply / Coupon.productIds ──
  const couponsToBackfill = await Coupon.countDocuments({ autoApply: { $exists: false } });
  report.backfilledCoupons = couponsToBackfill;
  if (couponsToBackfill > 0 && !dryRun) {
    await Coupon.updateMany(
      { autoApply: { $exists: false } },
      { $set: { autoApply: false, productIds: [] } }
    );
  }

  // ── 2. Backfill de la vigencia de envío gratis en Business ──
  const businessesToBackfill = await Business.countDocuments({
    freeDeliveryValidFrom: { $exists: false },
  });
  report.backfilledBusinesses = businessesToBackfill;
  if (businessesToBackfill > 0 && !dryRun) {
    await Business.updateMany(
      { freeDeliveryValidFrom: { $exists: false } },
      {
        $set: {
          freeDeliveryValidFrom: new Date(0),
          freeDeliveryValidUntil: new Date('2999-12-31'),
          freeDeliveryValidDays: [],
          freeDeliveryValidFromTime: '',
          freeDeliveryValidUntilTime: '',
        },
      }
    );
  }

  // ── 3. Reconstruir el índice único de CouponRedemption ──
  const existingIndexes = await CouponRedemption.collection.indexes();
  const oldIndex = existingIndexes.find((idx: any) => {
    return JSON.stringify(idx.key) === REDEMPTION_KEY_SIGNATURE && idx.unique;
  });

  if (oldIndex) {
    report.warnings.push(
      `Índice viejo encontrado: "${oldIndex.name}" único sobre {orderId}.`
    );
    if (!dryRun) {
      await CouponRedemption.collection.dropIndex(oldIndex.name as string);
      report.droppedOldRedemptionIndex = oldIndex.name as string;
    }
  } else {
    report.warnings.push('No se encontró el índice único viejo sobre {orderId}: nada que borrar.');
  }

  if (!dryRun) {
    try {
      await CouponRedemption.createIndexes();
      await Coupon.createIndexes();
      await Business.createIndexes();
    } catch (error) {
      report.warnings.push(
        `No se pudieron construir los índices nuevos: ${(error as Error).message}`
      );
    }
  }

  const after = await CouponRedemption.collection.indexes();
  report.redemptionIndexesAfter = after.map(
    (idx: any) => idx.name + (idx.unique ? ' (único)' : '')
  );

  return report;
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(
      `\n▸ Migración 023 — Promociones automáticas y envío gratis con vigencia${dryRun ? ' (ejecución en seco)' : ''}\n`
    );

    try {
      const report = await migratePromotionScheduling({ dryRun });

      console.log(`  Cupones sin autoApply (backfill)     ${report.backfilledCoupons}`);
      console.log(`  Negocios sin vigencia (backfill)     ${report.backfilledBusinesses}`);
      console.log(`  Índice viejo de canjes borrado        ${report.droppedOldRedemptionIndex ?? '(ninguno)'}`);
      console.log(`  Índices de canjes tras la migración   ${report.redemptionIndexesAfter.join(', ')}`);

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
