import { CashPaymentIncident, SosAlert, SosStatus, Pqrs, Order } from '../models';
import { CashIncidentStatus, OrderStatus } from '../types';
import { FraudAlert, FraudAlertStatus, UserRiskProfile } from '../security';

/**
 * Centro de incidentes.
 *
 * Todo lo que aparece aquí ya existía —alertas de fraude, faltantes de
 * efectivo, botones de pánico, reclamos, pedidos estancados— pero repartido
 * en cinco pantallas distintas. Nadie mira cinco pantallas a la vez, así que
 * en la práctica se miraba una y las otras cuatro acumulaban.
 *
 * Este servicio no calcula nada nuevo: pone en la misma mesa lo que ya se
 * sabía, ordenado por lo único que importa cuando algo va mal — quién puede
 * estar en problemas ahora mismo.
 */

export type IncidentKind = 'sos' | 'fraud' | 'cash' | 'complaint' | 'stalled_order';
export type IncidentSeverity = 'critical' | 'high' | 'medium';

export interface Incident {
  kind: IncidentKind;
  severity: IncidentSeverity;
  id: string;
  title: string;
  detail: string;
  at: Date;
  /** A quién afecta, para poder abrir su historial de un salto. */
  userId?: string;
  orderId?: string;
}

/**
 * Cuánto puede llevar un pedido sin avanzar antes de ser un incidente.
 *
 * Cuarenta y cinco minutos en `PICKED_UP` significa que la comida lleva
 * tres cuartos de hora en una moto. No es un retraso: es un pedido que
 * probablemente ya no sirve.
 */
const STALLED_AFTER_MS = 45 * 60 * 1000;

export class IncidentCenterService {
  /**
   * Todo lo abierto, en una sola lista ordenada por gravedad y luego por
   * antigüedad.
   *
   * Las emergencias van primero siempre, aunque acaben de entrar: es la
   * única categoría donde hay una persona en riesgo y no dinero.
   */
  async open(): Promise<Incident[]> {
    const stalledSince = new Date(Date.now() - STALLED_AFTER_MS);

    const [sos, fraud, cash, complaints, stalled] = await Promise.all([
      SosAlert.find({ status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] } })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
        .lean(),

      FraudAlert.find({
        status: { $in: [FraudAlertStatus.OPEN, FraudAlertStatus.INVESTIGATING] },
        riskLevel: { $in: ['high', 'critical'] },
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),

      CashPaymentIncident.find({
        status: { $in: [CashIncidentStatus.OPEN, CashIncidentStatus.UNDER_REVIEW] },
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),

      Pqrs.find({ type: 'claim', status: { $in: ['received', 'in_review'] } })
        .sort({ createdAt: 1 })
        .limit(30)
        .lean(),

      Order.find({
        status: { $in: [OrderStatus.PICKED_UP, OrderStatus.ON_WAY] },
        updatedAt: { $lt: stalledSince },
      })
        .sort({ updatedAt: 1 })
        .limit(20)
        .select('orderNumber status clientId updatedAt')
        .lean(),
    ]);

    const incidents: Incident[] = [
      ...sos.map((a: any) => ({
        kind: 'sos' as const,
        severity: 'critical' as const,
        id: String(a._id),
        title: 'Botón de pánico activado',
        detail: `${a.driverId?.userId?.name ?? 'Domiciliario'} pidió ayuda`,
        at: a.createdAt,
        userId: String(a.userId),
        orderId: a.orderId ? String(a.orderId) : undefined,
      })),

      ...fraud.map((a: any) => ({
        kind: 'fraud' as const,
        severity: (a.riskLevel === 'critical' ? 'critical' : 'high') as IncidentSeverity,
        id: String(a._id),
        title: 'Alerta de fraude',
        detail: a.description,
        at: a.createdAt,
        userId: a.userId,
      })),

      ...cash.map((i: any) => ({
        kind: 'cash' as const,
        severity: 'high' as const,
        id: String(i._id),
        title: 'Faltante de efectivo',
        detail: `${i.type} por $${(i.amount ?? 0).toLocaleString('es-CO')}`,
        at: i.createdAt,
        orderId: i.orderId ? String(i.orderId) : undefined,
      })),

      ...complaints.map((c: any) => ({
        kind: 'complaint' as const,
        severity: 'medium' as const,
        id: String(c._id),
        title: 'Reclamo sin resolver',
        detail: c.subject,
        at: c.createdAt,
        userId: String(c.userId),
      })),

      ...stalled.map((o: any) => ({
        kind: 'stalled_order' as const,
        severity: 'high' as const,
        id: String(o._id),
        title: 'Pedido detenido',
        detail: `${o.orderNumber} lleva más de 45 minutos en ${o.status}`,
        at: o.updatedAt,
        userId: String(o.clientId),
        orderId: String(o._id),
      })),
    ];

    const weight: Record<IncidentSeverity, number> = { critical: 0, high: 1, medium: 2 };

    return incidents.sort((a, b) => {
      if (weight[a.severity] !== weight[b.severity]) {
        return weight[a.severity] - weight[b.severity];
      }
      // Dentro de la misma gravedad, lo más antiguo primero: lo que lleva
      // más tiempo sin atenderse es lo que más ha empeorado.
      return a.at.getTime() - b.at.getTime();
    });
  }

  /** Los números de cabecera, para saber si hoy hay que preocuparse. */
  async summary() {
    const [activeSos, openFraud, openCash, openClaims, blockedUsers] = await Promise.all([
      SosAlert.countDocuments({ status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] } }),
      FraudAlert.countDocuments({
        status: { $in: [FraudAlertStatus.OPEN, FraudAlertStatus.INVESTIGATING] },
      }),
      CashPaymentIncident.countDocuments({
        status: { $in: [CashIncidentStatus.OPEN, CashIncidentStatus.UNDER_REVIEW] },
      }),
      Pqrs.countDocuments({ type: 'claim', status: { $in: ['received', 'in_review'] } }),
      UserRiskProfile.countDocuments({ isBlocked: true }),
    ]);

    return { activeSos, openFraud, openCash, openClaims, blockedUsers };
  }
}

export const incidentCenterService = new IncidentCenterService();
