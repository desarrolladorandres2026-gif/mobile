import mongoose from 'mongoose';
import { config } from '../config';
import { PlatformPricingConfig, LedgerEntry } from '../models';
import { LedgerAccount, LedgerDirection, LedgerEventType } from '../types';
import { ledgerService } from '../services/ledger.service';

/**
 * Migración 007 — retiro del programa de puntos de lealtad.
 *
 * La guarda de `referral.service.ts` que debía frenar el reparto mientras
 * `loyaltyEarnBps` estuviera en cero nunca se cumplía (`REFERRER_POINTS` era
 * una constante truthy), así que cada referido completado sí pudo emitir
 * pasivo real contra `LedgerAccount.LOYALTY_PAYABLE`. Esta migración no
 * asume que el saldo es cero: lo mide y, si no lo es, lo cierra en el propio
 * libro mayor (nunca escribiendo `LedgerEntry` a mano) para no dejar un
 * pasivo invisible que descuadre `ledgerSummary` por cuenta.
 *
 * - Cierra, por `orderId`, cualquier `LOYALTY_PAYABLE` con saldo distinto de
 *   cero: postea el asiento inverso (débito `LOYALTY_PAYABLE` / crédito
 *   `PROMOTION_EXPENSE`) con evento `LOYALTY_REVERSED` y
 *   `reference: 'migration:007'`, vía `ledgerService.post` para que respete
 *   partida doble e idempotencia.
 * - Dropea `loyaltybalances` y `loyaltymovements` si existen. En dev/prod
 *   reales pueden no existir nunca (o estar vacías); `dropCollection` sobre
 *   una colección inexistente lanza `ns not found`, que aquí se ignora.
 * - `$unset` de los campos `loyalty*` en `PlatformPricingConfig`: dejaron de
 *   estar en el schema (Mongoose ya no los valida ni los lee), pero los
 *   documentos ya guardados en Atlas los conservan hasta que alguien los
 *   quita explícitamente.
 * - NO toca los cupones nominales de canje (`PTS…`): siguen vivos hasta sus
 *   30 días, llevan `campaignApproved: true` (no pasan por el suelo de
 *   margen) y se honran a propósito, porque su provisión ya se revirtió al
 *   canjear. Expiran solos.
 *
 * Manual a propósito, como el resto de `src/migrations/`: no se ejecuta
 * desde `deploy.sh`.
 */
export async function migrateRemoveLoyalty(): Promise<{
  closedLedgerGroups: number;
  droppedCollections: string[];
  unsetDocuments: number;
}> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('No hay conexión activa a MongoDB');

  // Cierra cualquier pasivo de puntos que quedó vivo en el libro mayor,
  // agrupado por orderId (el mismo campo que usaron los asientos originales,
  // aunque en varios casos guardara un userId o un couponId en su lugar —
  // por eso se agrupa por él: es la clave que ya los emparejaba).
  const outstanding = await LedgerEntry.aggregate<{ _id: string; net: number }>([
    { $match: { account: LedgerAccount.LOYALTY_PAYABLE } },
    {
      $group: {
        _id: '$orderId',
        net: {
          $sum: {
            $cond: [{ $eq: ['$direction', LedgerDirection.CREDIT] }, '$amount', { $multiply: ['$amount', -1] }],
          },
        },
      },
    },
    { $match: { net: { $ne: 0 } } },
  ]);

  let closedLedgerGroups = 0;
  for (const group of outstanding) {
    const amount = Math.abs(group.net);
    const direction = group.net > 0 ? LedgerDirection.DEBIT : LedgerDirection.CREDIT;
    const { duplicated } = await ledgerService.post(
      {
        orderId: group._id,
        event: LedgerEventType.LOYALTY_REVERSED,
        pricingConfigVersion: 0,
        reference: 'migration:007',
      },
      [
        { account: LedgerAccount.LOYALTY_PAYABLE, direction, amount },
        {
          account: LedgerAccount.PROMOTION_EXPENSE,
          direction: direction === LedgerDirection.DEBIT ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
          amount,
        },
      ]
    );
    if (!duplicated) closedLedgerGroups += 1;
  }

  const droppedCollections: string[] = [];
  for (const name of ['loyaltybalances', 'loyaltymovements']) {
    try {
      await db.dropCollection(name);
      droppedCollections.push(name);
    } catch (error: unknown) {
      const err = error as { codeName?: string; code?: number };
      if (err.codeName !== 'NamespaceNotFound' && err.code !== 26) throw error;
    }
  }

  const result = await PlatformPricingConfig.collection.updateMany(
    {},
    { $unset: { loyaltyEarnBps: '', loyaltyExpiryDays: '', loyaltyMinRedeem: '' } }
  );

  return { closedLedgerGroups, droppedCollections, unsetDocuments: result.modifiedCount };
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    await mongoose.connect(config.mongodb.uri);
    console.log('\n▸ Migración 007 — retiro del programa de puntos de lealtad\n');

    try {
      const { closedLedgerGroups, droppedCollections, unsetDocuments } = await migrateRemoveLoyalty();
      console.log(
        closedLedgerGroups
          ? `  Pasivo de puntos cerrado en ${closedLedgerGroups} pedido(s) (evento loyalty_reversed).`
          : '  No había pasivo de puntos pendiente en el libro mayor.'
      );
      console.log(
        droppedCollections.length
          ? `  Colecciones eliminadas: ${droppedCollections.join(', ')}`
          : '  No había colecciones de lealtad que eliminar.'
      );
      console.log(`  Documentos de configuración limpiados: ${unsetDocuments}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
