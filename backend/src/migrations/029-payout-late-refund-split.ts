import mongoose, { Types } from 'mongoose';
import { config } from '../config';
import { Payout, Settlement, LedgerEntry } from '../models';
import { PayoutBeneficiary, PayoutStatus, LedgerAccount, LedgerDirection } from '../types';

/**
 * Migración 029 — separa el reembolso tardío de la reversión previa en `Payout`.
 *
 * Corrección 1.2 (2026-10): un reembolso que llegaba con el payout ya
 * comprometido (SETTLED o reclamado por una liquidación) se sumaba a
 * `reversedAmount` Y abría una fila de arrastre por el mismo importe. El
 * extracto restaba las dos cosas: el comercio veía menos de lo que ganó. Y si
 * la liquidación en curso fallaba, la siguiente pagaba de menos.
 *
 * Desde el modelo nuevo:
 *   · `reversedAmount` es solo lo revertido ANTES de comprometerse.
 *   · `reversedAfterCommit` es lo revertido después (ya lo recupera el arrastre,
 *     o el asiento de absorción si es del domiciliario).
 *   · Un arrastre conserva su `amount` original y suma lo cobrado en
 *     `consumedAmount` (antes cada cobro parcial restaba de `amount`).
 *
 * Qué reconstruye, de forma idempotente:
 *
 *   1. Arrastres (`isClawback`) sin `consumedAmount`. E = Σ
 *      `Settlement.clawbacks.amount` de ese arrastre.
 *        · SETTLED con `settlementId` → `amount = E`, `consumedAmount = E`
 *          (se cobró entero contra liquidaciones; E ya incluye el último cobro).
 *        · cualquier otro estado → `amount += E`, `consumedAmount = E`
 *          (el importe cobrado se había restado de `amount`).
 *      Un arrastre con `settlementId` y todavía PAYABLE es una liquidación en
 *      curso: su `amount` puede estar a medias. No se toca y se lista.
 *   2. Payouts normales del comercio sin `reversedAfterCommit` que tienen
 *      arrastres: `reversedAfterCommit = Σ importe original de sus arrastres`
 *      (tope: su `reversedAmount`) y `reversedAmount -= esa cantidad`.
 *   3. Payouts del repartidor sin `reversedAfterCommit`:
 *      `reversedAfterCommit` = Σ asientos `DRIVER_FEE_ABSORBED_EXPENSE` cuya
 *      `reference` termina en `:<payoutId>` (tope: su `reversedAmount`).
 *   4. Control: en los payouts reclamados por una liquidación, el
 *      `reversedAmount` nuevo debe igualar `reversedAtClaim`. Los que no
 *      cuadren se listan en `claimMismatches` para revisión manual.
 *
 * **Orden de despliegue.** Hay que correrla antes de que el código nuevo
 * procese el primer reembolso o la primera liquidación: la marca de "ya
 * migrado" es que el campo exista, y el código nuevo lo crea al tocar la fila.
 * Si un payout viejo se toca antes, queda fuera de la migración y habría que
 * corregirlo a mano.
 *
 * Manual y fuera de `deploy.sh` a propósito. **Por defecto es una ejecución en
 * seco**: no escribe nada hasta que se pasa `--apply`.
 *
 *   npm run migrate:payout-late-refund            # en seco
 *   npm run migrate:payout-late-refund -- --apply # escribe
 *
 * Idempotente: una segunda pasada no encuentra filas sin marcar.
 */

export interface PayoutLateRefundReport {
  dryRun: boolean;
  clawbacksMigrated: number;
  /** Arrastres en una liquidación en curso (settlementId y PAYABLE): no se tocan. */
  clawbacksInFlight: string[];
  businessPayoutsMigrated: number;
  driverPayoutsMigrated: number;
  /** Importe total que pasa de `reversedAmount` a `reversedAfterCommit`. */
  movedToLate: number;
  /** Payouts reclamados por una liquidación cuyo `reversedAmount` nuevo no iguala `reversedAtClaim`. */
  claimMismatches: Array<{ payoutId: string; reversedAmount: number; reversedAtClaim: number }>;
}

interface RawPayout {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  beneficiary: PayoutBeneficiary;
  amount: number;
  reversedAmount?: number;
  reversedAfterCommit?: number;
  reversedAtClaim?: number;
  consumedAmount?: number;
  status: PayoutStatus;
  settlementId?: Types.ObjectId | null;
  isClawback?: boolean;
}

type BulkOp = Parameters<typeof Payout.collection.bulkWrite>[0][number];

const hasValue = (v: unknown) => v !== undefined && v !== null;

export async function migratePayoutLateRefundSplit(
  options: { dryRun?: boolean } = {}
): Promise<PayoutLateRefundReport> {
  const dryRun = options.dryRun ?? true;
  const report: PayoutLateRefundReport = {
    dryRun,
    clawbacksMigrated: 0,
    clawbacksInFlight: [],
    businessPayoutsMigrated: 0,
    driverPayoutsMigrated: 0,
    movedToLate: 0,
    claimMismatches: [],
  };

  // Se lee por el driver nativo: con Mongoose los defaults (`consumedAmount: 0`)
  // taparían justo la marca que dice si una fila ya se migró.
  const raw = Payout.collection;

  // ── 1. Arrastres ──
  const collectedRows = await Settlement.aggregate([
    { $unwind: '$clawbacks' },
    { $group: { _id: '$clawbacks.payoutId', total: { $sum: '$clawbacks.amount' } } },
  ]);
  const collected = new Map<string, number>(collectedRows.map((r) => [String(r._id), r.total as number]));

  const clawbacks = (await raw.find({ isClawback: true }).toArray()) as unknown as RawPayout[];
  /** Importe original de cada arrastre tras migrar (o ya migrado), por pedido del comercio. */
  const originalByOrder = new Map<string, number>();
  const clawbackOps: BulkOp[] = [];

  for (const cb of clawbacks) {
    let original = cb.amount;
    if (!hasValue(cb.consumedAmount)) {
      const inFlight = hasValue(cb.settlementId) && cb.status !== PayoutStatus.SETTLED;
      if (inFlight) {
        report.clawbacksInFlight.push(String(cb._id));
      } else {
        const e = collected.get(String(cb._id)) ?? 0;
        const settledBySettlement = cb.status === PayoutStatus.SETTLED && hasValue(cb.settlementId);
        const newAmount = settledBySettlement && e > 0 ? e : cb.amount + e;
        const consumed = settledBySettlement && e === 0 ? cb.amount : e;
        original = newAmount;
        report.clawbacksMigrated += 1;
        clawbackOps.push({
          updateOne: {
            filter: { _id: cb._id, consumedAmount: { $exists: false }, amount: cb.amount },
            update: { $set: { amount: newAmount, consumedAmount: consumed } },
          },
        });
      }
    }
    const key = String(cb.orderId);
    originalByOrder.set(key, (originalByOrder.get(key) ?? 0) + original);
  }
  if (!dryRun && clawbackOps.length) await raw.bulkWrite(clawbackOps, { ordered: false });

  // ── 2. Payouts normales del comercio ──
  const newReversed = new Map<string, number>();
  const normalOps: BulkOp[] = [];

  const businessPayouts = (await raw
    .find({
      beneficiary: PayoutBeneficiary.BUSINESS,
      isClawback: { $ne: true },
      orderId: { $in: [...originalByOrder.keys()].map((k) => new Types.ObjectId(k)) },
      reversedAfterCommit: { $exists: false },
    })
    .toArray()) as unknown as RawPayout[];

  for (const p of businessPayouts) {
    const reversed = p.reversedAmount ?? 0;
    const late = Math.min(originalByOrder.get(String(p.orderId)) ?? 0, reversed);
    if (late <= 0) continue;
    newReversed.set(String(p._id), reversed - late);
    report.businessPayoutsMigrated += 1;
    report.movedToLate += late;
    normalOps.push({
      updateOne: {
        filter: { _id: p._id, reversedAfterCommit: { $exists: false }, reversedAmount: reversed },
        update: { $set: { reversedAfterCommit: late, reversedAmount: reversed - late } },
      },
    });
  }

  // ── 3. Payouts del repartidor ──
  const absorbed = await LedgerEntry.find({
    account: LedgerAccount.DRIVER_FEE_ABSORBED_EXPENSE,
    direction: LedgerDirection.DEBIT,
  })
    .select('reference amount')
    .lean();
  const absorbedByPayout = new Map<string, number>();
  for (const entry of absorbed) {
    const payoutId = String(entry.reference ?? '').split(':').pop() ?? '';
    if (!Types.ObjectId.isValid(payoutId)) continue;
    absorbedByPayout.set(payoutId, (absorbedByPayout.get(payoutId) ?? 0) + entry.amount);
  }

  if (absorbedByPayout.size) {
    const driverPayouts = (await raw
      .find({
        beneficiary: PayoutBeneficiary.DRIVER,
        isClawback: { $ne: true },
        _id: { $in: [...absorbedByPayout.keys()].map((k) => new Types.ObjectId(k)) },
        reversedAfterCommit: { $exists: false },
      })
      .toArray()) as unknown as RawPayout[];

    for (const p of driverPayouts) {
      const reversed = p.reversedAmount ?? 0;
      const late = Math.min(absorbedByPayout.get(String(p._id)) ?? 0, reversed);
      if (late <= 0) continue;
      newReversed.set(String(p._id), reversed - late);
      report.driverPayoutsMigrated += 1;
      report.movedToLate += late;
      normalOps.push({
        updateOne: {
          filter: { _id: p._id, reversedAfterCommit: { $exists: false }, reversedAmount: reversed },
          update: { $set: { reversedAfterCommit: late, reversedAmount: reversed - late } },
        },
      });
    }
  }
  if (!dryRun && normalOps.length) await raw.bulkWrite(normalOps, { ordered: false });

  // ── 4. Control contra la foto de la liquidación ──
  const claimed = (await raw
    .find({ settlementId: { $ne: null }, isClawback: { $ne: true } })
    .toArray()) as unknown as RawPayout[];
  for (const p of claimed) {
    const reversed = newReversed.get(String(p._id)) ?? p.reversedAmount ?? 0;
    const atClaim = p.reversedAtClaim ?? 0;
    if (reversed !== atClaim) {
      report.claimMismatches.push({ payoutId: String(p._id), reversedAmount: reversed, reversedAtClaim: atClaim });
    }
  }

  return report;
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 029 — Reembolso tardío separado en Payout${apply ? '' : ' (ejecución en seco)'}\n`);

    try {
      const report = await migratePayoutLateRefundSplit({ dryRun: !apply });
      console.log(`  Arrastres reconstruidos                ${report.clawbacksMigrated}`);
      console.log(`  Arrastres en liquidación en curso      ${report.clawbacksInFlight.length}`);
      console.log(`  Payouts de comercio con reembolso tardío ${report.businessPayoutsMigrated}`);
      console.log(`  Payouts de domiciliario con tarifa absorbida ${report.driverPayoutsMigrated}`);
      console.log(`  Importe que pasa a reversedAfterCommit ${report.movedToLate}`);
      if (report.clawbacksInFlight.length) {
        console.log(`\n  Revisar a mano (arrastres con liquidación en curso):`);
        for (const id of report.clawbacksInFlight) console.log(`   • ${id}`);
      }
      if (report.claimMismatches.length) {
        console.log(`\n  Payouts reclamados cuyo reversedAmount no iguala reversedAtClaim (${report.claimMismatches.length}):`);
        for (const m of report.claimMismatches) {
          console.log(`   • ${m.payoutId}: reversedAmount ${m.reversedAmount}, reversedAtClaim ${m.reversedAtClaim}`);
        }
      }
      console.log(apply ? '\n✔ Migración completada\n' : '\n✔ Ejecución en seco completada (nada se escribió; usa --apply para escribir)\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
