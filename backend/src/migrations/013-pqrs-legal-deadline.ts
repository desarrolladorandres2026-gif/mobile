import mongoose from 'mongoose';
import { config } from '../config';
import { Pqrs, DataRequest, Order } from '../models';
import { computePqrsLegalDueAt } from '../services/pqrs.service';
import { computeDataRequestLegalDueAt } from '../services/legal.service';

/**
 * Migración 013 — plazo legal (O7).
 *
 * `legalDueAt` (Ley 1480/1755 para PQRS, Ley 1581 para solicitudes de
 * datos) se calcula al CREAR desde ahora en adelante, pero los casos
 * abiertos antes de este cambio no lo tienen. Esta migración los rellena
 * calculando el plazo desde su `createdAt` real, y de paso copia
 * `businessId`/`driverId` a las PQRS que traen `orderId` y no los tenían.
 *
 * Idempotente: solo toca documentos donde el campo falta (`$exists: false`
 * o `null`), así que correrla dos veces no cambia nada la segunda vez.
 */

export interface PqrsLegalDeadlineReport {
  pqrsLegalDueAtSet: number;
  pqrsPartiesBackfilled: number;
  dataRequestsLegalDueAtSet: number;
  dryRun: boolean;
}

export async function migratePqrsLegalDeadline(
  options: { dryRun?: boolean } = {}
): Promise<PqrsLegalDeadlineReport> {
  const dryRun = options.dryRun ?? false;

  const openPqrs = await Pqrs.find({
    status: { $ne: 'closed' },
    legalDueAt: { $exists: false },
  })
    .select('_id type createdAt orderId businessId driverId')
    .lean();

  let pqrsLegalDueAtSet = 0;
  let pqrsPartiesBackfilled = 0;

  for (const p of openPqrs) {
    const legalDueAt = computePqrsLegalDueAt(p.type, p.createdAt);
    const update: Record<string, unknown> = { legalDueAt };

    let businessId = p.businessId ?? null;
    let driverId = p.driverId ?? null;
    if (p.orderId && (!businessId || !driverId)) {
      const order = await Order.findById(p.orderId).select('businessId driverId').lean();
      if (order) {
        if (!businessId && order.businessId) { businessId = order.businessId; update.businessId = order.businessId; }
        if (!driverId && order.driverId) { driverId = order.driverId; update.driverId = order.driverId; }
      }
    }

    if (Object.keys(update).length > 1) pqrsPartiesBackfilled++;
    pqrsLegalDueAtSet++;

    if (!dryRun) {
      await Pqrs.updateOne({ _id: p._id }, { $set: update });
    }
  }

  const openDataRequests = await DataRequest.find({
    status: { $in: ['received', 'in_review'] },
    legalDueAt: { $exists: false },
  })
    .select('_id type createdAt')
    .lean();

  let dataRequestsLegalDueAtSet = 0;
  for (const d of openDataRequests) {
    dataRequestsLegalDueAtSet++;
    if (!dryRun) {
      await DataRequest.updateOne(
        { _id: d._id },
        { $set: { legalDueAt: computeDataRequestLegalDueAt(d.type, d.createdAt) } }
      );
    }
  }

  return { pqrsLegalDueAtSet, pqrsPartiesBackfilled, dataRequestsLegalDueAtSet, dryRun };
}

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    await mongoose.connect(config.mongodb.uri);
    console.log(`\n▸ Migración 013 — Plazo legal de PQRS y solicitudes de datos${dryRun ? ' (ejecución en seco)' : ''}\n`);

    try {
      const report = await migratePqrsLegalDeadline({ dryRun });
      console.log(`  PQRS con legalDueAt calculado        ${report.pqrsLegalDueAtSet}`);
      console.log(`  PQRS con comercio/domiciliario completados ${report.pqrsPartiesBackfilled}`);
      console.log(`  Solicitudes de datos con legalDueAt  ${report.dataRequestsLegalDueAtSet}`);
      console.log('\n✔ Migración completada\n');
      process.exit(0);
    } catch (error) {
      console.error('\n✖ La migración falló:', error);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
