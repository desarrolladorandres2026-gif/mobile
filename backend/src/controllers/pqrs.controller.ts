import { Request, Response, NextFunction } from 'express';
import { Pqrs, Order, Settlement } from '../models'; import { AppError } from '../middlewares'; import { uploadPqrsEvidence } from '../middlewares/upload'; import { sendResponse, param, query } from '../utils'; import { AuditAction, logAudit } from '../security'; import { createPqrs, caseCode, recordStatus, REASON_CATEGORY } from '../services/pqrs.service'; import { supportService, canRequesterReopen } from '../services/support.service';
/**
 * Lo que ve quien abrió el caso: sin ids del personal ni prioridad. El motivo
 * de la solicitud de reembolso, quién la pidió y la nota de Finanzas son
 * internos: de `refundRequest` solo sale el estado (ver `ownView`).
 */
const OWN_FIELDS = '-assignedTo -assignedAt -priority -responses.userId -refundRequest.reason -refundRequest.requestedBy -refundRequest.requestedAt -refundRequest.resolvedBy -refundRequest.resolvedAt -refundRequest.resolutionNote -evidence.storageKey -evidence.resourceType -evidence.url';
const OPEN_STATUSES = ['received', 'in_review'];

/**
 * Traduce lo interno a lo que se le promete a quien abrió el caso.
 *
 * `dueAt` (SLA interno) sale como `respondBy` solo mientras el caso espera
 * respuesta: en uno respondido o cerrado ya no es una promesa. `refundRequest`
 * se reduce a `refundStatus`.
 */
function ownView<T extends Record<string, any> | null>(doc: T): T {
  if (!doc) return doc;
  const { dueAt, refundRequest, ...rest } = doc as Record<string, any>;
  return {
    ...rest,
    code: caseCode(rest as never),
    displayStatus: displayStatus(rest as never),
    respondBy: dueAt && OPEN_STATUSES.includes(rest.status) ? dueAt : null,
    refundStatus: refundRequest?.status ?? null,
    canReopen: canRequesterReopen(rest as never),
  } as unknown as T;
}

/**
 * Los cinco estados que ve el comercio sobre los cuatro que guarda el sistema.
 * No hay estados nuevos que migrar: `answered` ya significa "ZIPP respondió y la
 * pelota está del lado del solicitante" (una réplica suya lo devuelve a
 * `in_review`), y un cierre confirmado por el solicitante es "resuelto".
 */
export type DisplayStatus = 'open' | 'in_review' | 'waiting_business' | 'resolved' | 'closed';
export function displayStatus(ticket: { status: string; resolvedByRequester?: boolean }): DisplayStatus {
  if (ticket.status === 'received') return 'open';
  if (ticket.status === 'in_review') return 'in_review';
  if (ticket.status === 'answered') return 'waiting_business';
  return ticket.resolvedByRequester ? 'resolved' : 'closed';
}

/**
 * Del pedido y de la liquidación citados solo sale lo que sirve para ubicarlos:
 * número, estado y medio de pago; periodo. Nada de montos ni datos del cliente.
 */
async function withOrderSummary<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
  const unique = (key: string) => [...new Set(rows.map((row) => (row[key] ? String(row[key]) : '')).filter(Boolean))];
  const orderIds = unique('orderId');
  const settlementIds = unique('settlementId');
  if (!orderIds.length && !settlementIds.length) return rows;
  const [orders, settlements] = await Promise.all([
    orderIds.length ? Order.find({ _id: { $in: orderIds } }).select('orderNumber status paymentMethod').lean() : [],
    settlementIds.length ? Settlement.find({ _id: { $in: settlementIds } }).select('periodStart periodEnd').lean() : [],
  ]);
  const orderById = new Map(orders.map((o) => [String(o._id), { orderNumber: o.orderNumber, status: o.status, paymentMethod: o.paymentMethod }]));
  const settlementById = new Map(settlements.map((st) => [String(st._id), { periodStart: st.periodStart, periodEnd: st.periodEnd }]));
  return rows.map((row) => ({
    ...row,
    ...(row.orderId ? { order: orderById.get(String(row.orderId)) ?? null } : {}),
    ...(row.settlementId ? { settlement: settlementById.get(String(row.settlementId)) ?? null } : {}),
  }));
}

export class PqrsController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await createPqrs({ userId: req.user!._id.toString(), type: req.body.type, reason: req.body.reason, subject: req.body.subject, detail: req.body.detail, orderId: req.body.orderId, businessId: req.body.businessId, settlementId: req.body.settlementId, paymentMethod: req.body.paymentMethod, role: req.user!.role });
      void logAudit(req, { action: AuditAction.PQRS_CREATED, entity: 'pqrs', entityId: item._id.toString(), description: 'Caso de soporte abierto', metadata: { reason: item.reason ?? null, category: item.reason ? REASON_CATEGORY[item.reason] : null, orderId: item.orderId ? String(item.orderId) : null, businessId: item.businessId ? String(item.businessId) : null } });
      const [row] = await withOrderSummary([await Pqrs.findById(item._id).select(OWN_FIELDS).lean() as Record<string, any>]);
      sendResponse(res, 201, 'PQRS recibida', ownView(row));
    } catch (e) { next(e); }
  }
  async mine(req: Request, res: Response, next: NextFunction) {
    try {
      // Quien tiene varios locales ve los casos del que tiene abierto; sin el parámetro, todos los suyos (la app móvil).
      const businessId = query(req, 'businessId');
      if (businessId && !/^[a-f\d]{24}$/i.test(businessId)) throw new AppError('Negocio no válido', 400);
      const rows = await Pqrs.find({ userId: req.user!._id, ...(businessId ? { businessId } : {}) }).select(OWN_FIELDS).sort({ createdAt: -1 }).lean();
      sendResponse(res, 200, 'PQRS', (await withOrderSummary(rows)).map((row) => ownView(row)));
    } catch (e) { next(e); }
  }
  /**
   * Adjunto del solicitante. multer corre aquí dentro (como en la evidencia de
   * pedidos) para que el dueño y el estado del caso se comprueben antes de
   * tocar Cloudinary; `addEvidence` lo hace dentro del filtro.
   */
  addEvidence(req: Request, res: Response, next: NextFunction) {
    uploadPqrsEvidence(req, res, async (err: unknown) => {
      try {
        if (err) throw new AppError(err instanceof Error ? err.message : 'No se pudo procesar el archivo', 400);
        if (!req.file) throw new AppError('Adjunta un archivo', 400);
        const id = param(req, 'id');
        await supportService.addEvidence(id, req.user!._id.toString(), req.file);
        void logAudit(req, { action: AuditAction.PQRS_EVIDENCE_UPLOADED, entity: 'pqrs', entityId: id, description: 'Adjunto agregado a un caso', metadata: { bytes: req.file.size } });
        sendResponse(res, 201, 'Adjunto registrado', ownView(await Pqrs.findById(id).select(OWN_FIELDS).lean()));
      } catch (e) { next(e); }
    });
  }
  /** URL firmada de un adjunto propio. */
  async evidenceUrl(req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'Adjunto', await supportService.evidenceUrl(param(req, 'id'), param(req, 'evidenceId'), req.user!._id.toString(), false)); } catch (e) { next(e); } }
  /** URL firmada de un adjunto para el personal de soporte. Queda en auditoría: es un archivo que subió un tercero. */
  async staffEvidenceUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      const evidenceId = param(req, 'evidenceId');
      const result = await supportService.evidenceUrl(id, evidenceId, req.user!._id.toString(), true);
      void logAudit(req, { action: AuditAction.PQRS_EVIDENCE_VIEWED, entity: 'pqrs', entityId: id, description: 'Adjunto de un caso consultado', metadata: { evidenceId } });
      sendResponse(res, 200, 'Adjunto', result);
    } catch (e) { next(e); }
  }
  async confirmResolved(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      await supportService.confirmResolved(id, req.user!._id.toString());
      sendResponse(res, 200, 'Caso cerrado', ownView(await Pqrs.findById(id).select(OWN_FIELDS).lean()));
    } catch (e) { next(e); }
  }
  async reopen(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      await supportService.reopenByRequester(id, req.user!._id.toString(), req.body.message);
      void logAudit(req, { action: AuditAction.PQRS_REOPENED, entity: 'pqrs', entityId: id, description: 'Caso reabierto por quien lo abrió' });
      sendResponse(res, 200, 'Caso reabierto', ownView(await Pqrs.findById(id).select(OWN_FIELDS).lean()));
    } catch (e) { next(e); }
  }
  /**
   * Los casos que abrió cualquier persona del local. El permiso se comprueba en
   * la ruta. Solo `requesterRole: 'business'`: los reclamos de clientes sobre
   * pedidos de este local también guardan `businessId`, y no son del comercio.
   * Sale el nombre de quien lo abrió, nunca su correo ni su teléfono.
   */
  async businessCases(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await Pqrs.find({ businessId: param(req, 'businessId'), requesterRole: 'business' })
        .select(OWN_FIELDS).populate('userId', 'name').sort({ createdAt: -1 }).limit(100).lean();
      const me = req.user!._id.toString();
      sendResponse(res, 200, 'Casos del local', (await withOrderSummary(rows as Array<Record<string, any>>)).map((row) => {
        const author = row.userId as unknown as { _id: unknown; name?: string };
        return { ...ownView(row), userId: undefined, openedBy: author?.name ?? 'Equipo', mine: String(author?._id) === me };
      }));
    } catch (e) { next(e); }
  }
  /** Réplica de quien abrió el caso. Devuelve el caso con los campos de `OWN_FIELDS`. */
  async requesterReply(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      await supportService.requesterReply(id, req.user!._id.toString(), req.body.message);
      sendResponse(res, 201, 'Respuesta enviada', ownView(await Pqrs.findById(id).select(OWN_FIELDS).lean()));
    } catch (e) { next(e); }
  }
  async list(_req: Request, res: Response, next: NextFunction) { try { sendResponse(res, 200, 'PQRS', await Pqrs.find().populate('userId', 'name email phone').sort({ createdAt: -1 })); } catch (e) { next(e); } }
  /**
   * Responde una PQRS. Es la misma ruta que usaba la pantalla Legal, y ahora
   * deja la misma traza que la bandeja de soporte (`supportService.reply`):
   * sella `firstResponseAt`, asigna el caso a quien responde si no tenía
   * asignado, y notifica al cliente por socket y push. Antes esta ruta
   * escribía directo sobre `Pqrs` y las dos vías dejaban estados distintos
   * (una asignaba y sellaba `firstResponseAt`, la otra no).
   */
  async respond(req: Request, res: Response, next: NextFunction) {
    try {
      const id = param(req, 'id');
      const existing = await Pqrs.findById(id).select('assignedTo status');
      if (!existing) throw new AppError('PQRS no encontrada', 404);

      if (!existing.assignedTo) await supportService.assign(id, req.user!._id.toString());

      let item = await supportService.reply(id, req.user!._id.toString(), req.body.message);

      const targetStatus = req.body.status || 'answered';
      if (targetStatus === 'closed') {
        item = await supportService.close(id, req.user!._id.toString());
      } else if (targetStatus !== item.status) {
        item = await Pqrs.findByIdAndUpdate(id, { $set: { status: targetStatus } }, { new: true, runValidators: true }) as typeof item;
        await recordStatus(id, targetStatus, 'staff');
      }

      void logAudit(req, { action: AuditAction.PQRS_ANSWERED, entity: 'pqrs', entityId: id, description: 'PQRS respondida', metadata: { status: item.status } });
      sendResponse(res, 200, 'Respuesta registrada', item);
    } catch (e) { next(e); }
  }
}
export const pqrsController = new PqrsController();
