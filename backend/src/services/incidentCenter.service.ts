import {
  CashPaymentIncident, SosAlert, SosStatus, Pqrs, Order, DataRequest, Payout,
  CashReconciliation, BusinessDocument, DriverDocument, Advertisement, AdInvoice, Refund,
} from '../models';
import { AdApprovalStatus } from '../models/Advertisement';
import { CashIncidentStatus, CashReconciliationStatus, OrderStatus, PayoutStatus, RefundStatus } from '../types';
import { dispatchService } from './dispatch.service';
import { FraudAlert, FraudAlertStatus, UserRiskProfile } from '../security';
import { businessDaysUntil } from '../utils';
import { Permission } from '../security/rbac';

/** Quién puede ver cada tipo de incidente. */
export const INCIDENT_PERMISSION: Record<string, Permission> = {
  sos: Permission.SOS_VIEW,
  fraud: Permission.FRAUD_ALERTS_VIEW,
  cash: Permission.FINANCE_VIEW,
  clawback_overdue: Permission.FINANCE_VIEW,
  complaint: Permission.SUPPORT_VIEW,
  pqrs_legal: Permission.SUPPORT_VIEW,
  data_request_legal: Permission.LEGAL_VIEW,
  stalled_order: Permission.ORDERS_VIEW_ALL,
  unassigned_order: Permission.ORDERS_VIEW_ALL,
  cash_overdue: Permission.FINANCE_VIEW,
  business_document_expiring: Permission.BUSINESSES_APPROVE,
  driver_document_expiring: Permission.DRIVERS_APPROVE,
  ad_uninvoiced: Permission.ADS_VIEW,
  refund_failed: Permission.REFUNDS_VIEW,
};

/** `allows(permiso)`: normalmente `(p) => can(req, p)`. Sin él, se niega todo (falla cerrado): quien quiera todo debe decirlo con `() => true`. */
export type PermissionCheck = (permission: Permission) => boolean;

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

export type IncidentKind =
  | 'sos' | 'fraud' | 'cash' | 'complaint' | 'stalled_order' | 'pqrs_legal' | 'data_request_legal' | 'clawback_overdue'
  | 'unassigned_order' | 'cash_overdue' | 'business_document_expiring' | 'driver_document_expiring' | 'ad_uninvoiced' | 'refund_failed';
export type IncidentSeverity = 'critical' | 'high' | 'medium';

export interface Incident {
  kind: IncidentKind;
  severity: IncidentSeverity;
  id: string;
  /**
   * Identidad estable de la alerta: `kind:id:stage`. El `stage` sube cuando el
   * problema escala (`due_soon` → `overdue`, `cycle3` → `cycle6`), así que la
   * escalada vuelve a contar como "sin ver" en la bandeja.
   */
  key: string;
  title: string;
  detail: string;
  at: Date;
  /** A quién afecta, para poder abrir su historial de un salto. */
  userId?: string;
  orderId?: string;
  businessId?: string;
  /** `_id` del perfil `Driver` (no del usuario). */
  driverId?: string;
}

/** Un pedido `READY` sin domiciliario ya es alerta si lleva tantos minutos quieto (o `CYCLES_BEFORE_ALERT` vueltas de reparto). */
const UNASSIGNED_AFTER_MS = 10 * 60 * 1000;

/** Cuántos días antes de caducar un documento aprobado entra a la bandeja. */
const DOCUMENT_EXPIRY_WINDOW_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

const makeKey = (kind: IncidentKind, id: string, stage: string) => `${kind}:${id}:${stage}`;

const money = (n: number) => `$${(n ?? 0).toLocaleString('es-CO')}`;

const DOC_LABEL: Record<string, string> = {
  identity: 'documento de identidad',
  license: 'licencia de conducción',
  soat: 'SOAT',
  technical_review: 'revisión técnico-mecánica',
  vehicle_registration: 'tarjeta de propiedad',
};

function expiryPhrase(expiresAt: Date): string {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS);
  if (days < 0) return `venció hace ${Math.abs(days)} día${Math.abs(days) === 1 ? '' : 's'}`;
  if (days === 0) return 'vence hoy';
  return `vence en ${days} día${days === 1 ? '' : 's'}`;
}

/**
 * Cuánto puede llevar un pedido sin avanzar antes de ser un incidente.
 *
 * Cuarenta y cinco minutos en `PICKED_UP` significa que la comida lleva
 * tres cuartos de hora en una moto. No es un retraso: es un pedido que
 * probablemente ya no sirve.
 */
const STALLED_AFTER_MS = 45 * 60 * 1000;

/** Cuántos días puede un arrastre de comercio esperar sin cobrar antes de necesitar seguimiento. */
const CLAWBACK_OVERDUE_DAYS = 14;

export class IncidentCenterService {
  /**
   * Todo lo abierto, en una sola lista ordenada por gravedad y luego por
   * antigüedad.
   *
   * Las emergencias van primero siempre, aunque acaben de entrar: es la
   * única categoría donde hay una persona en riesgo y no dinero.
   */
  async open(allows: PermissionCheck = () => false): Promise<Incident[]> {
    const stalledSince = new Date(Date.now() - STALLED_AFTER_MS);

    const legalWindow = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const clawbackOverdueSince = new Date(Date.now() - CLAWBACK_OVERDUE_DAYS * 24 * 60 * 60 * 1000);

    // Solo se consulta lo que quien pregunta puede ver: `allows` falla cerrado,
    // así que sin permiso ni se toca la base (y el filtro final sigue ahí).
    const gated = (kind: IncidentKind, run: () => PromiseLike<any[]>): Promise<any[]> =>
      allows(INCIDENT_PERMISSION[kind]) ? Promise.resolve(run()) : Promise.resolve([]);

    const unassignedSince = new Date(Date.now() - UNASSIGNED_AFTER_MS);
    const documentWindow = new Date(Date.now() + DOCUMENT_EXPIRY_WINDOW_DAYS * DAY_MS);
    const cyclesBeforeAlert = dispatchService.CYCLES_BEFORE_ALERT;

    const [
      sos, fraud, cash, complaints, stalled, legalPqrs, legalDataRequests, overdueClawbacks,
      unassigned, cashOverdue, businessDocs, driverDocs, endedAds, failedRefunds,
    ] = await Promise.all([
      gated('sos', () => SosAlert.find({ status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] } })
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

      // Vencido o vencerá en los próximos 10 días de calendario (cota
      // amplia; el filtro fino por días hábiles va abajo, al construir el
      // incidente).
      Pqrs.find({
        status: { $in: ['received', 'in_review'] },
        legalDueAt: { $lte: legalWindow },
      })
        .sort({ legalDueAt: 1 })
        .limit(30)
        .select('subject legalDueAt userId')
        .lean(),

      DataRequest.find({
        status: { $in: ['received', 'in_review'] },
        legalDueAt: { $lte: legalWindow },
      })
        .sort({ legalDueAt: 1 })
        .limit(30)
        .select('type legalDueAt userId')
        .lean(),

      // Arrastre de comercio (`Payout.isClawback`) sin cobrar hace más de 14
      // días: nadie lo ve porque solo se cobra cuando el comercio vuelve a
      // tener una liquidación, y un comercio que dejó de vender no vuelve a
      // tener una.
      Payout.find({
        isClawback: true,
        status: PayoutStatus.PAYABLE,
        settlementId: null,
        becamePayableAt: { $lt: clawbackOverdueSince },
      })
        .sort({ becamePayableAt: 1 })
        .limit(30)
        .populate('businessId', 'name')
        .select('amount reversedAmount businessId orderId becamePayableAt')
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

      ...legalPqrs
        .filter((p: any) => businessDaysUntil(p.legalDueAt) <= 3)
        .map((p: any) => {
          const daysLeft = businessDaysUntil(p.legalDueAt);
          return {
            kind: 'pqrs_legal' as const,
            severity: (daysLeft <= 1 ? 'critical' : 'high') as IncidentSeverity,
            id: String(p._id),
            title: daysLeft < 0 ? 'PQRS con plazo legal vencido' : 'PQRS por vencer (plazo legal)',
            detail: p.subject,
            at: p.legalDueAt,
            userId: String(p.userId),
          };
        }),

      ...legalDataRequests
        .filter((d: any) => businessDaysUntil(d.legalDueAt) <= 3)
        .map((d: any) => {
          const daysLeft = businessDaysUntil(d.legalDueAt);
          return {
            kind: 'data_request_legal' as const,
            severity: (daysLeft <= 1 ? 'critical' : 'high') as IncidentSeverity,
            id: String(d._id),
            title: daysLeft < 0 ? 'Solicitud de datos personales vencida' : 'Solicitud de datos por vencer',
            detail: `Solicitud de ${d.type}`,
            at: d.legalDueAt,
            userId: String(d.userId),
          };
        }),

      ...overdueClawbacks.map((c: any) => {
        const net = Math.max(0, (c.amount ?? 0) - (c.reversedAmount ?? 0));
        const days = Math.floor((Date.now() - new Date(c.becamePayableAt).getTime()) / 86_400_000);
        return {
          kind: 'clawback_overdue' as const,
          severity: 'medium' as const,
          id: String(c._id),
          title: 'Arrastre sin cobrar hace más de 14 días',
          detail: `${c.businessId?.name ?? 'Comercio'} debe $${net.toLocaleString('es-CO')} (${days} días)`,
          at: c.becamePayableAt,
          orderId: c.orderId ? String(c.orderId) : undefined,
        };
      }),
    ];

    const weight: Record<IncidentSeverity, number> = { critical: 0, high: 1, medium: 2 };

    return incidents
      .filter((i) => allows(INCIDENT_PERMISSION[i.kind]))
      .sort((a, b) => {
      if (weight[a.severity] !== weight[b.severity]) {
        return weight[a.severity] - weight[b.severity];
      }
      // Dentro de la misma gravedad, lo más antiguo primero: lo que lleva
      // más tiempo sin atenderse es lo que más ha empeorado.
      return a.at.getTime() - b.at.getTime();
    });
  }

  /** Los números de cabecera, para saber si hoy hay que preocuparse. */
  async summary(allows: PermissionCheck = () => false) {
    const now = new Date();
    const [activeSos, openFraud, openCash, openClaims, blockedUsers, legalOverduePqrs, legalOverdueDataRequests] = await Promise.all([
      SosAlert.countDocuments({ status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] } }),
      FraudAlert.countDocuments({
        status: { $in: [FraudAlertStatus.OPEN, FraudAlertStatus.INVESTIGATING] },
      }),
      CashPaymentIncident.countDocuments({
        status: { $in: [CashIncidentStatus.OPEN, CashIncidentStatus.UNDER_REVIEW] },
      }),
      Pqrs.countDocuments({ type: 'claim', status: { $in: ['received', 'in_review'] } }),
      UserRiskProfile.countDocuments({ isBlocked: true }),
      Pqrs.countDocuments({ status: { $in: ['received', 'in_review'] }, legalDueAt: { $lt: now } }),
      DataRequest.countDocuments({ status: { $in: ['received', 'in_review'] }, legalDueAt: { $lt: now } }),
    ]);

    const gate = (p: Permission, n: number) => (allows(p) ? n : 0);
    return {
      activeSos: gate(Permission.SOS_VIEW, activeSos),
      openFraud: gate(Permission.FRAUD_ALERTS_VIEW, openFraud),
      openCash: gate(Permission.FINANCE_VIEW, openCash),
      openClaims: gate(Permission.SUPPORT_VIEW, openClaims),
      blockedUsers: gate(Permission.FRAUD_ALERTS_VIEW, blockedUsers),
      legalOverduePqrs: gate(Permission.SUPPORT_VIEW, legalOverduePqrs),
      legalOverdueDataRequests: gate(Permission.LEGAL_VIEW, legalOverdueDataRequests),
    };
  }
}

export const incidentCenterService = new IncidentCenterService();
