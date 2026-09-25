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
      gated('sos', () =>
        SosAlert.find({ status: { $in: [SosStatus.ACTIVE, SosStatus.ACKNOWLEDGED] } })
          .sort({ createdAt: -1 })
          .limit(20)
          .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
          .lean()
      ),

      gated('fraud', () =>
        FraudAlert.find({
          status: { $in: [FraudAlertStatus.OPEN, FraudAlertStatus.INVESTIGATING] },
          riskLevel: { $in: ['high', 'critical'] },
        })
          .sort({ createdAt: -1 })
          .limit(30)
          .lean()
      ),

      gated('cash', () =>
        CashPaymentIncident.find({
          status: { $in: [CashIncidentStatus.OPEN, CashIncidentStatus.UNDER_REVIEW] },
        })
          .sort({ createdAt: -1 })
          .limit(30)
          .lean()
      ),

      gated('complaint', () =>
        Pqrs.find({ type: 'claim', status: { $in: ['received', 'in_review'] } })
          .sort({ createdAt: 1 })
          .limit(30)
          .lean()
      ),

      gated('stalled_order', () =>
        Order.find({
          status: { $in: [OrderStatus.PICKED_UP, OrderStatus.ON_WAY] },
          updatedAt: { $lt: stalledSince },
        })
          .sort({ updatedAt: 1 })
          .limit(20)
          .select('orderNumber status clientId updatedAt')
          .lean()
      ),

      // Vencido o vencera en los proximos 10 dias de calendario (cota
      // amplia; el filtro fino por dias habiles va abajo).
      gated('pqrs_legal', () =>
        Pqrs.find({
          status: { $in: ['received', 'in_review'] },
          legalDueAt: { $lte: legalWindow },
        })
          .sort({ legalDueAt: 1 })
          .limit(30)
          .select('subject legalDueAt userId')
          .lean()
      ),

      gated('data_request_legal', () =>
        DataRequest.find({
          status: { $in: ['received', 'in_review'] },
          legalDueAt: { $lte: legalWindow },
        })
          .sort({ legalDueAt: 1 })
          .limit(30)
          .select('type legalDueAt userId')
          .lean()
      ),

      // Arrastre de comercio sin cobrar hace mas de 14 dias: solo se cobra
      // cuando el comercio vuelve a tener liquidacion, y uno que dejo de
      // vender no vuelve a tener una.
      gated('clawback_overdue', () =>
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
          .lean()
      ),

      // Listo, sin domiciliario y con reparto agotado (vueltas) o quieto 10 min.
      // Indice {status, driverId, dispatch.expiresAt}.
      gated('unassigned_order', () =>
        Order.find({
          status: OrderStatus.READY,
          driverId: null,
          $or: [{ 'dispatch.cycle': { $gte: cyclesBeforeAlert } }, { updatedAt: { $lt: unassignedSince } }],
        })
          .sort({ updatedAt: 1 })
          .limit(30)
          .select('orderNumber clientId businessId dispatch updatedAt')
          .lean()
      ),

      // Efectivo vencido que el domiciliario debe a ZIPP. Indice {status, dueAt}.
      gated('cash_overdue', () =>
        CashReconciliation.find({ status: CashReconciliationStatus.OVERDUE })
          .sort({ dueAt: 1 })
          .limit(30)
          .select('driverId orderId amount dueAt')
          .lean()
      ),

      // Documentos aprobados que caducan pronto o ya caducaron. `expired` cuenta: quien abre la cola
      // los pasa a ese estado, y la alerta de "vencido" no debe esfumarse sola.
      gated('business_document_expiring', () =>
        BusinessDocument.find({ status: { $in: ['approved', 'expired'] }, expiresAt: { $lte: documentWindow } })
          .sort({ expiresAt: 1 })
          .limit(30)
          .populate('businessId', 'name')
          .select('businessId type expiresAt')
          .lean()
      ),

      gated('driver_document_expiring', () =>
        DriverDocument.find({ status: { $in: ['approved', 'expired'] }, expiresAt: { $lte: documentWindow } })
          .sort({ expiresAt: 1 })
          .limit(30)
          .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
          .select('driverId type expiresAt')
          .lean()
      ),

      // Campanas aprobadas, no canceladas y terminadas sin AdInvoice
      // (closeAndInvoice es manual). Se miran las 200 mas recientes; se muestran 100.
      gated('ad_uninvoiced', async () => {
        const ended = await Advertisement.find({
          endDate: { $lt: new Date() },
          approvalStatus: AdApprovalStatus.APPROVED,
          cancelledAt: null,
        })
          .sort({ endDate: -1 })
          .limit(200)
          .select('campaignName advertiserName endDate billedToBusinessId')
          .lean();
        if (!ended.length) return [];
        const invoiced = await AdInvoice.find({ campaignId: { $in: ended.map((a) => a._id) } })
          .select('campaignId')
          .lean();
        const done = new Set(invoiced.map((i) => String(i.campaignId)));
        return ended.filter((a) => !done.has(String(a._id))).slice(0, 100);
      }),

      // Reembolsos que la pasarela rechazo. Indice {status}.
      gated('refund_failed', () =>
        Refund.find({ status: RefundStatus.FAILED })
          .sort({ createdAt: -1 })
          .limit(30)
          .select('orderId amount reason createdAt')
          .lean()
      ),
    ]);

    const incidents: Incident[] = [
      ...sos.map((a: any) => ({
        kind: 'sos' as const,
        severity: 'critical' as const,
        id: String(a._id),
        key: makeKey('sos', String(a._id), 'open'),
        title: 'Botón de pánico activado',
        detail: `${a.driverId?.userId?.name ?? 'Domiciliario'} pidió ayuda`,
        at: a.createdAt,
        userId: String(a.userId),
        orderId: a.orderId ? String(a.orderId) : undefined,
        driverId: a.driverId?._id ? String(a.driverId._id) : undefined,
      })),

      ...fraud.map((a: any) => ({
        kind: 'fraud' as const,
        severity: (a.riskLevel === 'critical' ? 'critical' : 'high') as IncidentSeverity,
        id: String(a._id),
        // El nivel de riesgo es el stage: si sube de high a critical vuelve a sonar.
        key: makeKey('fraud', String(a._id), a.riskLevel === 'critical' ? 'critical' : 'high'),
        title: 'Alerta de fraude',
        detail: a.description,
        at: a.createdAt,
        userId: a.userId,
      })),

      ...cash.map((i: any) => ({
        kind: 'cash' as const,
        severity: 'high' as const,
        id: String(i._id),
        key: makeKey('cash', String(i._id), 'open'),
        title: 'Faltante de efectivo',
        detail: `${i.type} por $${(i.amount ?? 0).toLocaleString('es-CO')}`,
        at: i.createdAt,
        orderId: i.orderId ? String(i.orderId) : undefined,
      })),

      ...complaints.map((c: any) => ({
        kind: 'complaint' as const,
        severity: 'medium' as const,
        id: String(c._id),
        key: makeKey('complaint', String(c._id), 'open'),
        title: 'Reclamo sin resolver',
        detail: c.subject,
        at: c.createdAt,
        userId: String(c.userId),
        orderId: c.orderId ? String(c.orderId) : undefined,
        businessId: c.businessId ? String(c.businessId) : undefined,
        driverId: c.driverId ? String(c.driverId) : undefined,
      })),

      ...stalled.map((o: any) => ({
        kind: 'stalled_order' as const,
        severity: 'high' as const,
        id: String(o._id),
        key: makeKey('stalled_order', String(o._id), 'stalled'),
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
            key: makeKey('pqrs_legal', String(p._id), daysLeft < 0 ? 'overdue' : 'due_soon'),
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
            key: makeKey('data_request_legal', String(d._id), daysLeft < 0 ? 'overdue' : 'due_soon'),
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
          key: makeKey('clawback_overdue', String(c._id), 'overdue'),
          title: 'Arrastre sin cobrar hace más de 14 días',
          detail: `${c.businessId?.name ?? 'Comercio'} debe $${net.toLocaleString('es-CO')} (${days} días)`,
          at: c.becamePayableAt,
          orderId: c.orderId ? String(c.orderId) : undefined,
          businessId: c.businessId?._id ? String(c.businessId._id) : undefined,
        };
      }),

      ...unassigned.map((o: any) => {
        const cycle: number = o.dispatch?.cycle ?? 0;
        // El stage escala de cyclesBeforeAlert en cyclesBeforeAlert
        // (cycle3, cycle6...): una vuelta mas no es escalada, tres si.
        const bucket = Math.floor(cycle / cyclesBeforeAlert) * cyclesBeforeAlert;
        const waitedMin = Math.floor((Date.now() - new Date(o.updatedAt).getTime()) / 60_000);
        return {
          kind: 'unassigned_order' as const,
          severity: 'high' as IncidentSeverity,
          id: String(o._id),
          key: makeKey('unassigned_order', String(o._id), bucket > 0 ? `cycle${bucket}` : 'waiting'),
          title: 'Pedido listo sin domiciliario',
          detail: `${o.orderNumber} lleva ${cycle} vueltas de reparto y ${waitedMin} min sin quién lo recoja`,
          at: o.updatedAt,
          userId: String(o.clientId),
          orderId: String(o._id),
          businessId: o.businessId ? String(o.businessId) : undefined,
        };
      }),

      ...cashOverdue.map((r: any) => ({
        kind: 'cash_overdue' as const,
        severity: 'high' as IncidentSeverity,
        id: String(r._id),
        key: makeKey('cash_overdue', String(r._id), 'overdue'),
        title: 'Efectivo vencido sin entregar',
        detail: `Un domiciliario debe ${money(r.amount)} a ZIPP desde ${new Date(r.dueAt).toLocaleDateString('es-CO')}`,
        at: r.dueAt,
        orderId: r.orderId ? String(r.orderId) : undefined,
        driverId: r.driverId ? String(r.driverId) : undefined,
      })),

      ...businessDocs.map((d: any) => {
        const expired = new Date(d.expiresAt).getTime() < Date.now();
        return {
          kind: 'business_document_expiring' as const,
          severity: (expired ? 'high' : 'medium') as IncidentSeverity,
          id: String(d._id),
          key: makeKey('business_document_expiring', String(d._id), expired ? 'overdue' : 'due_soon'),
          title: expired ? 'Documento de comercio vencido' : 'Documento de comercio por vencer',
          detail: `${d.businessId?.name ?? 'Comercio'}: ${d.type} ${expiryPhrase(d.expiresAt)}`,
          at: d.expiresAt,
          businessId: d.businessId?._id ? String(d.businessId._id) : undefined,
        };
      }),

      ...driverDocs.map((d: any) => {
        const expired = new Date(d.expiresAt).getTime() < Date.now();
        return {
          kind: 'driver_document_expiring' as const,
          severity: (expired ? 'high' : 'medium') as IncidentSeverity,
          id: String(d._id),
          key: makeKey('driver_document_expiring', String(d._id), expired ? 'overdue' : 'due_soon'),
          title: expired ? 'Documento de domiciliario vencido' : 'Documento de domiciliario por vencer',
          detail: `${d.driverId?.userId?.name ?? 'Domiciliario'}: ${DOC_LABEL[d.type] ?? d.type} ${expiryPhrase(d.expiresAt)}`,
          at: d.expiresAt,
          driverId: d.driverId?._id ? String(d.driverId._id) : undefined,
        };
      }),

      ...endedAds.map((a: any) => ({
        kind: 'ad_uninvoiced' as const,
        severity: 'medium' as IncidentSeverity,
        id: String(a._id),
        key: makeKey('ad_uninvoiced', String(a._id), 'pending'),
        title: 'Campaña terminada sin facturar',
        detail: `${a.campaignName} (${a.advertiserName}) terminó el ${new Date(a.endDate).toLocaleDateString('es-CO')}`,
        at: a.endDate,
        businessId: a.billedToBusinessId ? String(a.billedToBusinessId) : undefined,
      })),

      ...failedRefunds.map((r: any) => ({
        kind: 'refund_failed' as const,
        severity: 'high' as IncidentSeverity,
        id: String(r._id),
        key: makeKey('refund_failed', String(r._id), 'failed'),
        title: 'Reembolso rechazado por la pasarela',
        detail: `${money(r.amount)}: ${r.reason || 'sin motivo'}`,
        at: r.createdAt,
        orderId: r.orderId ? String(r.orderId) : undefined,
      })),
    ];

    const weight: Record<IncidentSeverity, number> = { critical: 0, high: 1, medium: 2 };

    return incidents
      .filter((i) => allows(INCIDENT_PERMISSION[i.kind]))
      .sort((a, b) => {
        if (weight[a.severity] !== weight[b.severity]) {
          return weight[a.severity] - weight[b.severity];
        }
        // Dentro de la misma gravedad, lo mas antiguo primero.
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
