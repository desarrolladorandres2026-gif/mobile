import { Types } from 'mongoose';
import { ShiftClosing, User } from '../models';
import { PaymentMethod } from '../types';
import { bogotaDateString } from '../utils/period';
import { closedToday } from './businessRoleSummary.service';
import type { BusinessAccess } from './businessStaff.service';

/**
 * Cierre de caja del turno.
 *
 * Las cifras las calcula el servidor con la misma consulta que enseña
 * "Ventas del turno" (`closedToday`): el cliente solo aporta lo que no
 * puede saber el servidor —el efectivo que contó y una nota—, así que nadie
 * puede firmar un cierre con ventas inventadas. El importe va entero en COP.
 */

export interface ShiftClosingView {
  id: string;
  date: string;
  closedByName: string;
  closedByRole: string;
  sales: number;
  ordersDelivered: number;
  ordersCancelled: number;
  cashSales: number;
  onlineSales: number;
  declaredCash: number | null;
  difference: number | null;
  note: string;
  createdAt: string;
}

const view = (row: InstanceType<typeof ShiftClosing>): ShiftClosingView => ({
  id: row._id.toString(),
  date: row.date,
  closedByName: row.closedByName,
  closedByRole: row.closedByRole,
  sales: row.sales,
  ordersDelivered: row.ordersDelivered,
  ordersCancelled: row.ordersCancelled,
  cashSales: row.cashSales,
  onlineSales: row.onlineSales,
  declaredCash: row.declaredCash,
  difference: row.difference,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

async function close(
  businessIdRaw: string,
  userId: string,
  access: BusinessAccess,
  input: { declaredCash?: number | null; note?: string }
): Promise<ShiftClosingView> {
  const businessId = new Types.ObjectId(businessIdRaw);
  const date = bogotaDateString();
  const [today, user] = await Promise.all([
    closedToday(businessId, date),
    User.findById(userId).select('name').lean(),
  ]);

  const amountOf = (method: PaymentMethod) => today.byPaymentMethod.find((row) => row.method === method)?.sales ?? 0;
  const cashSales = amountOf(PaymentMethod.CASH_ON_DELIVERY);
  const declaredCash = input.declaredCash ?? null;

  const row = await ShiftClosing.create({
    businessId,
    closedBy: new Types.ObjectId(userId),
    closedByName: user?.name?.trim() || 'Sin nombre',
    closedByRole: access.role,
    date,
    sales: today.sales,
    ordersDelivered: today.ordersDelivered,
    ordersCancelled: today.ordersCancelled,
    cashSales,
    onlineSales: amountOf(PaymentMethod.ONLINE),
    declaredCash,
    difference: declaredCash === null ? null : declaredCash - cashSales,
    note: input.note?.trim() ?? '',
  });
  return view(row);
}

/** Los cierres de un día, el más reciente primero. */
async function listForDay(businessIdRaw: string, date: string): Promise<ShiftClosingView[]> {
  const rows = await ShiftClosing.find({ businessId: new Types.ObjectId(businessIdRaw), date })
    .sort({ createdAt: -1 })
    .limit(50);
  return rows.map(view);
}

export const shiftClosingService = { close, listForDay };
