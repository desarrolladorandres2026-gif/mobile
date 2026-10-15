import { Types } from 'mongoose';
import { BusinessPermission, ShiftClosing, User } from '../models';
import { PaymentMethod } from '../types';
import { bogotaDateString } from '../utils/period';
import { cashHandover, closedToday, currentShiftWindow } from './businessRoleSummary.service';
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
  /** Vendido contra entrega (valor de producto). Informativo: no es lo que debe haber en caja. */
  cashSales: number;
  onlineSales: number;
  /**
   * Lo que debe haber en efectivo. `null` en cierres anteriores a este campo
   * (la diferencia de esos se calculó contra `cashSales`) y mientras la
   * persona sin `financial:view` no haya declarado lo que contó.
   */
  expectedCash: number | null;
  inTransit: { count: number; amount: number } | null;
  cancelledAfterPickup: { count: number; amount: number } | null;
  declaredCash: number | null;
  difference: number | null;
  note: string;
  createdAt: string;
}

type ClosingRow = InstanceType<typeof ShiftClosing>;

/** Lo que quien consulta puede saber de un cierre: ver `view`. */
interface Viewer {
  /** Tiene `financial:view`. */
  financial: boolean;
}

const viewerOf = (access?: BusinessAccess): Viewer => ({
  financial: access?.permissions.includes(BusinessPermission.FINANCIAL_VIEW) ?? false,
});

/** El subdocumento de Mongoose como objeto plano; `null` en los cierres que no lo tienen. */
const counted = (sub?: { count: number; amount: number } | null) =>
  sub ? { count: sub.count, amount: sub.amount } : null;

/**
 * Quien no tiene `financial:view` (el empleado de mostrador) conoce el efectivo
 * esperado y la diferencia solo después de declarar lo que contó: si lo viera
 * antes, el conteo se podría "cuadrar" contra la cifra. Se decide aquí, en el
 * servidor, para la respuesta del cierre y para el listado.
 */
const view = (row: ClosingRow, viewer: Viewer): ShiftClosingView => {
  const reveal = viewer.financial || row.declaredCash !== null;
  return {
    id: row._id.toString(),
    date: row.date,
    closedByName: row.closedByName,
    closedByRole: row.closedByRole,
    sales: row.sales,
    ordersDelivered: row.ordersDelivered,
    ordersCancelled: row.ordersCancelled,
    cashSales: row.cashSales,
    onlineSales: row.onlineSales,
    expectedCash: reveal ? row.expectedCash ?? null : null,
    inTransit: reveal ? counted(row.inTransit) : null,
    cancelledAfterPickup: reveal ? counted(row.cancelledAfterPickup) : null,
    declaredCash: row.declaredCash,
    difference: reveal ? row.difference : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
};

async function close(
  businessIdRaw: string,
  userId: string,
  access: BusinessAccess,
  input: { declaredCash?: number | null; note?: string }
): Promise<ShiftClosingView> {
  const businessId = new Types.ObjectId(businessIdRaw);
  // El instante del cierre es el final del corte y el `createdAt` del acta:
  // el siguiente cierre del día arranca justo después, sin hueco ni traslape.
  const closedAt = new Date();
  const date = bogotaDateString(closedAt);
  const { from, to } = await currentShiftWindow(businessId, closedAt);
  const [today, handover, user] = await Promise.all([
    closedToday(businessId, date),
    cashHandover(businessId, from, to),
    User.findById(userId).select('name').lean(),
  ]);

  const amountOf = (method: PaymentMethod) => today.byPaymentMethod.find((row) => row.method === method)?.sales ?? 0;
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
    cashSales: amountOf(PaymentMethod.CASH_ON_DELIVERY),
    onlineSales: amountOf(PaymentMethod.ONLINE),
    expectedCash: handover.expectedCash,
    inTransit: handover.inTransit,
    cancelledAfterPickup: handover.cancelledAfterPickup,
    coversFrom: from,
    declaredCash,
    difference: declaredCash === null ? null : declaredCash - handover.expectedCash,
    note: input.note?.trim() ?? '',
    createdAt: closedAt,
  });
  return view(row, viewerOf(access));
}

/**
 * Los cierres de un día, el más reciente primero. Sin `access` se aplica la
 * regla más estricta (como el empleado): hasta no declarar no hay cifra esperada.
 */
async function listForDay(businessIdRaw: string, date: string, access?: BusinessAccess): Promise<ShiftClosingView[]> {
  const rows = await ShiftClosing.find({ businessId: new Types.ObjectId(businessIdRaw), date })
    .sort({ createdAt: -1 })
    .limit(50);
  const viewer = viewerOf(access);
  return rows.map((row) => view(row, viewer));
}

export const shiftClosingService = { close, listForDay };
