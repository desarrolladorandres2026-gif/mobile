import mongoose from 'mongoose';
import { config } from '../config';
import { Payment, Order, Refund } from '../models';
import { PaymentStatus, PaymentMethod, PaymentType, RefundStatus } from '../types';

/**
 * Migración 003 — un solo cobro abierto por pedido.
 *
 * El endurecimiento de pagos añade dos índices únicos parciales:
 *
 *   · `Payment {orderId}` sobre los cobros en línea PENDIENTES, para que un
 *     pedido no pueda tener dos enlaces de Wompi vivos a la vez.
 *   · `Refund {orderId}` sobre los reembolsos PENDIENTES, para que dos
 *     peticiones simultáneas no reviertan el mismo pedido dos veces.
 *
 * Mongo **no construye un índice único si los datos existentes ya lo
 * violan**: falla en silencio al arrancar y la aplicación se queda sin la
 * garantía, creyendo que la tiene. Esta migración deja la base en un estado
 * donde los dos índices pueden construirse.
 *
 * Qué hace con los duplicados: conserva el intento MÁS RECIENTE —es el que
 * corresponde al enlace que el cliente tiene delante— y retira los
 * anteriores marcándolos como fallidos. No borra nada: una fila retirada
 * sigue siendo localizable por su referencia, que es justo lo que permite
 * reconocer un pago tardío sobre un enlace viejo en vez de perderlo.
 *
 * Nunca toca un cobro aprobado, reembolsado ni en efectivo.
 *
 * Segura de ejecutar más de una vez.
 */

export interface PaymentUniquenessReport {
  ordersWithDuplicatePayments: number;
  paymentsRetired: number;
  ordersWithDuplicateRefunds: number;
  refundsFailed: number;
  indexesBuilt: string[];
  warnings: string[];
}

const RETIRE_REASON =
  'Intento retirado por la migración 003: el pedido tenía más de un cobro en línea abierto';

export async function migratePaymentUniqueness(
  options: { dryRun?: boolean } = {}
): Promise<PaymentUniquenessReport> {
  const dryRun = options.dryRun ?? false;
  const report: PaymentUniquenessReport = {
    ordersWithDuplicatePayments: 0,
    paymentsRetired: 0,
    ordersWithDuplicateRefunds: 0,
    refundsFailed: 0,
    indexesBuilt: [],
    warnings: [],
  };

  // ── 1. Cobros en línea pendientes duplicados ──
  const duplicatePayments = await Payment.aggregate<{ _id: mongoose.Types.ObjectId; ids: mongoose.Types.ObjectId[] }>([
    {
      $match: {
        status: PaymentStatus.PENDING,
        method: PaymentMethod.ONLINE,
        type: PaymentType.ORDER_PAYMENT,
      },
    },
    { $sort: { createdAt: 1 } },
    { $group: { _id: '$orderId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  report.ordersWithDuplicatePayments = duplicatePayments.length;

  for (const group of duplicatePayments) {
    // El último es el vigente; todos los anteriores se retiran.
    const toRetire = group.ids.slice(0, -1);
    report.paymentsRetired += toRetire.length;

    const order = await Order.findById(group._id).select('orderNumber');
    report.warnings.push(
      `Pedido ${order?.orderNumber ?? group._id.toString()}: ${group.ids.length} cobros ` +
        `abiertos; se retiran ${toRetire.length} y se conserva el más reciente.`
    );

    if (dryRun) continue;

    await Payment.updateMany(
      { _id: { $in: toRetire } },
      {
        $set: {
          status: PaymentStatus.FAILED,
          statusMessage: RETIRE_REASON,
          'metadata.voidedReason': RETIRE_REASON,
          'metadata.voidedAt': new Date().toISOString(),
        },
        $push: {
          statusHistory: {
            status: PaymentStatus.FAILED,
            source: 'admin',
            message: RETIRE_REASON,
            at: new Date(),
          },
        },
      }
    );
  }

  // ── 2. Reembolsos pendientes duplicados ──
  //
  // Un reembolso que se quedó en PENDING es un proceso que nunca terminó —
  // se cayó entre la llamada a la pasarela y el asiento contable. No se
  // "completa" aquí a ciegas: se marca como fallido, que es lo que ya hace
  // el propio servicio cuando la pasarela rechaza, y deja el pedido libre
  // para que alguien reintente el reembolso mirando la evidencia.
  const duplicateRefunds = await Refund.aggregate<{ _id: mongoose.Types.ObjectId; ids: mongoose.Types.ObjectId[] }>([
    { $match: { status: RefundStatus.PENDING } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: '$orderId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  report.ordersWithDuplicateRefunds = duplicateRefunds.length;

  for (const group of duplicateRefunds) {
    const toFail = group.ids.slice(0, -1);
    report.refundsFailed += toFail.length;
    report.warnings.push(
      `Pedido ${group._id.toString()}: ${group.ids.length} reembolsos pendientes; ` +
        `se marcan ${toFail.length} como fallidos para poder reintentarlos.`
    );

    if (dryRun) continue;

    await Refund.updateMany(
      { _id: { $in: toFail } },
      {
        $set: {
          status: RefundStatus.FAILED,
          reason: 'Reembolso interrumpido, cerrado por la migración 003. Revísalo y reintenta.',
        },
      }
    );
  }

  // ── 3. Construir los índices ──
  //
  // `syncIndexes` no: eliminaría cualquier índice que no esté declarado en
  // el esquema, y eso es demasiado destructivo para una migración. Se pide
  // explícitamente la construcción de los que este cambio introduce.
  if (!dryRun) {
    for (const model of [Payment, Refund]) {
      try {
        await model.createIndexes();
        report.indexesBuilt.push(model.modelName);
      } catch (error) {
        report.warnings.push(
          `No se pudieron construir los índices de ${model.modelName}: ${(error as Error).message}`
        );
      }
    }
  }

  return report;
}

// ── Ejecutable desde la línea de comandos ──
if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 003 — Unicidad de cobros${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migratePaymentUniqueness({ dryRun });

      console.log(`  Pedidos con cobros duplicados     ${report.ordersWithDuplicatePayments}`);
      console.log(`  Cobros retirados                  ${report.paymentsRetired}`);
      console.log(`  Pedidos con reembolsos duplicados ${report.ordersWithDuplicateRefunds}`);
      console.log(`  Reembolsos cerrados               ${report.refundsFailed}`);
      console.log(`  Índices construidos               ${report.indexesBuilt.join(', ') || '(ninguno)'}`);

      if (report.warnings.length > 0) {
        console.log(`\n  Detalle (${report.warnings.length}):`);
        for (const warning of report.warnings) console.log(`   • ${warning}`);
      }

      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    }
  })();
}
