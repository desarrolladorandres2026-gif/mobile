import { Pqrs, IPqrs, User, Order } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { emitToUser } from '../sockets/emitter';
import { pushService } from './push.service';
import { businessDaysUntil } from '../utils';
import { notifyAlertsChanged } from './alerts.service';
import { storePrivateFile, signedPrivateUrl } from './privateStorage.service';
import { LEGAL_DUE_SOON_BUSINESS_DAYS, SLA_HOURS, defaultPriority, PqrsPriority } from './pqrs.service';

/**
 * Centro de soporte.
 *
 * No parte de cero: `Pqrs` ya guardaba tipo, estado, evidencias y
 * respuestas. Lo que le faltaba para ser una bandeja de trabajo eran las
 * tres cosas que convierten una lista en una cola: quién lo tiene, cuándo
 * vence y cuánto se tardó en contestar.
 *
 * Sin asignación, una bandeja compartida acaba con todo el mundo mirando
 * los mismos tres casos fáciles y nadie tocando el difícil.
 */

export type Priority = PqrsPriority;

/** Mensajes máximos por caso (personal y solicitante juntos). */
export const MAX_THREAD_MESSAGES = 100;

export interface QueueOptions {
  assignedTo?: string;
  onlyOverdue?: boolean;
  onlyLegalOverdue?: boolean;
  /** `open` (por defecto): sin responder. `answered`: respondidos. `done`: respondidos y cerrados. */
  view?: 'open' | 'answered' | 'closed' | 'done';
  type?: IPqrs['type'];
  requesterRole?: IPqrs['requesterRole'];
  q?: string;
  /** Solo los que nadie lleva (gana `assignedTo` si vienen los dos). */
  unassigned?: boolean;
  /** Solo los que tienen una solicitud de reembolso pendiente con Finanzas. */
  refundRequested?: boolean;
  /** Tope de filas; por defecto 100. */
  limit?: number;
}

const MAX_QUEUE_LIMIT = 300;

/** Cuántos días después de cerrado puede el solicitante reabrir su caso. */
export const REOPEN_WINDOW_DAYS = 7;
/** Reaperturas por caso. Pasado el tope, el problema se abre como caso nuevo y se mira desde cero. */
export const MAX_REOPENS = 2;
/** Adjuntos por caso. */
export const MAX_PQRS_EVIDENCE = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ¿Puede el solicitante reabrir este caso ahora? Misma regla que aplica `reopenByRequester` en el filtro. */
export function canRequesterReopen(ticket: { status: string; closedAt?: Date | string | null; updatedAt?: Date | string; reopenCount?: number }, now = Date.now()): boolean {
  if (ticket.status !== 'closed' || (ticket.reopenCount ?? 0) >= MAX_REOPENS) return false;
  const closed = ticket.closedAt ?? ticket.updatedAt;
  return !!closed && new Date(closed).getTime() >= now - REOPEN_WINDOW_DAYS * DAY_MS;
}

export class SupportService {
  /** Fija prioridad y plazo al abrir el caso. */
  async classify(pqrsId: string, priority?: Priority): Promise<IPqrs> {
    const ticket = await Pqrs.findById(pqrsId);
    if (!ticket) throw new AppError('Caso no encontrado', 404);

    const level = priority ?? defaultPriority(ticket.type);

    ticket.priority = level;
    // El plazo cuenta desde que se abrió el caso, no desde ahora: si no,
    // reclasificar un caso vencido a "baja" le regalaba 72 h y lo sacaba de
    // los vencidos. Subir la prioridad sí adelanta el plazo.
    ticket.dueAt = new Date(ticket.createdAt.getTime() + SLA_HOURS[level] * 60 * 60 * 1000);

    await ticket.save();
    return ticket;
  }

  /** Igual que `classify`, devolviendo cómo estaba antes para auditar el cambio. */
  async classifyWithPrevious(pqrsId: string, priority?: Priority) {
    const before = await Pqrs.findById(pqrsId).select('priority dueAt').lean();
    if (!before) throw new AppError('Caso no encontrado', 404);
    const ticket = await this.classify(pqrsId, priority);
    return { ticket, previous: { priority: before.priority, dueAt: before.dueAt ?? null } };
  }

  async assign(pqrsId: string, agentId: string): Promise<IPqrs> {
    const ticket = await Pqrs.findByIdAndUpdate(
      pqrsId,
      { assignedTo: agentId, assignedAt: new Date(), status: 'in_review' },
      { new: true }
    );

    if (!ticket) throw new AppError('Caso no encontrado', 404);
    return ticket;
  }

  /**
   * Responde al cliente.
   *
   * La primera respuesta se sella aparte: es la métrica que mide de verdad
   * a soporte, y no se puede reconstruir después mirando el array de
   * respuestas si alguna se borra.
   */
  async reply(pqrsId: string, agentId: string, message: string): Promise<IPqrs> {
    const ticket = await Pqrs.findById(pqrsId);
    if (!ticket) throw new AppError('Caso no encontrado', 404);

    ticket.responses.push({
      message,
      userId: agentId as never,
      createdAt: new Date(),
    });

    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    if (ticket.status === 'received') ticket.status = 'in_review';

    await ticket.save();

    // El cliente se entera en el momento. Un caso respondido que nadie ve
    // es un caso sin responder.
    emitToUser(ticket.userId.toString(), 'support:replied', {
      pqrsId: ticket._id.toString(),
      subject: ticket.subject,
    });

    /**
     * El socket solo llega si la app está abierta. La push es la que lo
     * saca de un caso cerrado en la cabeza del cliente: sin esta, la
     * bandeja de notificaciones in-app que se retiró (2026-09-07, ver
     * memoria del proyecto) era el único canal que avisaba de esto, y al
     * quitarla el aviso desapareció con ella.
     */
    void pushService.sendToUser(ticket.userId.toString(), {
      title: 'Respondimos tu solicitud',
      body: ticket.subject,
      data: { pqrsId: ticket._id.toString() },
    });

    return ticket;
  }

  /**
   * Réplica de quien abrió el caso. La condición va dentro del filtro (dueño y
   * no cerrado) para que dos réplicas concurrentes o una sobre un caso recién
   * cerrado no pasen por un findById → validar → save. Un caso `answered` vuelve
   * a `in_review`: si no, la réplica quedaría fuera de la cola de pendientes.
   */
  async requesterReply(pqrsId: string, userId: string, message: string): Promise<IPqrs> {
    const ticket = await Pqrs.findOneAndUpdate(
      {
        _id: pqrsId,
        userId,
        status: { $ne: 'closed' },
        // Tope del hilo: sin él una cuenta puede inflar el documento sin límite.
        [`responses.${MAX_THREAD_MESSAGES - 1}`]: { $exists: false },
      },
      { $push: { responses: { message, from: 'requester', userId, createdAt: new Date() } } },
      { new: true, runValidators: true }
    );
    if (!ticket) throw new AppError('Caso no encontrado, cerrado o con demasiados mensajes', 404);

    if (ticket.status === 'answered') {
      await Pqrs.updateOne({ _id: pqrsId, status: 'answered' }, { $set: { status: 'in_review' } });
      ticket.status = 'in_review';
    }
    void notifyAlertsChanged('pqrs');
    return ticket;
  }

  /**
   * El solicitante confirma que quedó resuelto. Solo vale sobre un caso
   * respondido: cerrar uno que nadie ha contestado sería esconderlo de la cola.
   * La condición va en el filtro, no en un findById previo.
   */
  async confirmResolved(pqrsId: string, userId: string): Promise<IPqrs> {
    const ticket = await Pqrs.findOneAndUpdate(
      { _id: pqrsId, userId, status: 'answered' },
      { $set: { status: 'closed', closedAt: new Date(), resolvedByRequester: true } },
      { new: true }
    );
    if (!ticket) throw new AppError('Solo puedes confirmar un caso que ya respondimos', 409);
    void notifyAlertsChanged('pqrs');
    return ticket;
  }

  /**
   * Reapertura por quien abrió el caso: dentro de la ventana, con tope de
   * veces y con un mensaje que dice qué sigue mal. No toca `legalDueAt` ni
   * `firstResponseAt` (reabrir no regala días) ni `dueAt`: un caso reabierto
   * vuelve a la cola ya vencido, que es justo lo que debe pasar con algo que
   * se dio por resuelto sin estarlo. Todo va en el filtro de un solo update.
   */
  async reopenByRequester(pqrsId: string, userId: string, message: string): Promise<IPqrs> {
    const since = new Date(Date.now() - REOPEN_WINDOW_DAYS * DAY_MS);
    const ticket = await Pqrs.findOneAndUpdate(
      {
        _id: pqrsId,
        userId,
        status: 'closed',
        reopenCount: { $not: { $gte: MAX_REOPENS } },
        $and: [
          { $or: [{ closedAt: { $gte: since } }, { closedAt: null, updatedAt: { $gte: since } }] },
          { [`responses.${MAX_THREAD_MESSAGES - 1}`]: { $exists: false } },
        ],
      },
      {
        $set: { status: 'in_review', closedAt: null, resolvedByRequester: false },
        $inc: { reopenCount: 1 },
        $push: { responses: { message, from: 'requester', userId, createdAt: new Date() } },
      },
      { new: true, runValidators: true }
    );
    if (!ticket) {
      throw new AppError(`No se puede reabrir: pasaron más de ${REOPEN_WINDOW_DAYS} días, ya se reabrió ${MAX_REOPENS} veces o el caso no es tuyo`, 409);
    }
    void notifyAlertsChanged('pqrs');
    return ticket;
  }

  /**
   * Adjunta un archivo al caso. Los bytes los comprueba `storePrivateFile`
   * (el `Content-Type` de multer lo escribe el cliente); la llave queda en el
   * caso y la URL se firma al leer. La condición de dueño, abierto y tope va
   * dentro del filtro del push. Si dos subidas compiten por el último cupo,
   * la perdedora deja un archivo huérfano en Cloudinary: se prefiere eso a
   * leer-contar-escribir.
   */
  async addEvidence(pqrsId: string, userId: string, file: { buffer: Buffer; originalname: string }): Promise<IPqrs> {
    const own = await Pqrs.findOne({ _id: pqrsId, userId, status: { $ne: 'closed' } }).select('evidence').lean();
    if (!own) throw new AppError('Caso no encontrado o cerrado', 404);
    if ((own.evidence?.length ?? 0) >= MAX_PQRS_EVIDENCE) throw new AppError(`Un caso admite hasta ${MAX_PQRS_EVIDENCE} adjuntos`, 409);

    const stored = await storePrivateFile(file.buffer, { folder: `zipp/pqrs-evidence/${pqrsId}` });
    // Solo el nombre, sin ruta ni caracteres de control: se pinta en el panel de soporte.
    const name = (file.originalname.split(/[/\x5c]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || `adjunto.${stored.format}`;

    const ticket = await Pqrs.findOneAndUpdate(
      { _id: pqrsId, userId, status: { $ne: 'closed' }, [`evidence.${MAX_PQRS_EVIDENCE - 1}`]: { $exists: false } },
      { $push: { evidence: { name, storageKey: stored.key, resourceType: stored.resourceType, format: stored.format, bytes: stored.bytes, uploadedAt: new Date() } } },
      { new: true, runValidators: true }
    );
    if (!ticket) throw new AppError('El caso se cerró o ya tiene el máximo de adjuntos', 409);
    return ticket;
  }

  /**
   * URL firmada de un adjunto. `viewerId` es el solicitante; con `asStaff` la
   * ruta ya comprobó el permiso de soporte y no se exige ser el dueño.
   */
  async evidenceUrl(pqrsId: string, evidenceId: string, viewerId: string, asStaff: boolean): Promise<{ url: string; name: string }> {
    const ticket = await Pqrs.findOne({ _id: pqrsId, ...(asStaff ? {} : { userId: viewerId }) }).select('evidence').lean();
    const item = ticket?.evidence?.find((e) => String(e._id) === evidenceId);
    const url = item?.storageKey ? signedPrivateUrl({ key: item.storageKey, resourceType: item.resourceType ?? 'image' }) : undefined;
    // Mismo 404 para "no existe", "no es tuyo" y "archivo antiguo sin llave": no se revela cuál.
    if (!item || !url) throw new AppError('Adjunto no encontrado', 404);
    return { url, name: item.name };
  }

  /**
   * Reabre un caso cerrado. No toca `legalDueAt` ni `firstResponseAt`: el
   * plazo legal corre desde que se abrió el caso, y reabrir no puede regalar
   * días. La condición de estado va en el filtro, no en un findById previo.
   */
  async reopen(pqrsId: string, agentId: string): Promise<IPqrs> {
    const ticket = await Pqrs.findOneAndUpdate(
      { _id: pqrsId, status: 'closed' },
      { $set: { status: 'in_review', assignedTo: agentId, assignedAt: new Date(), closedAt: null, resolvedByRequester: false } },
      { new: true }
    );
    if (!ticket) throw new AppError('Solo se reabren casos cerrados', 409);
    void notifyAlertsChanged('pqrs');
    return ticket;
  }

  /**
   * Soporte pide a Finanzas que reembolse el pedido del caso. No mueve dinero:
   * deja la petición, y Finanzas decide en la ficha del pedido. Una sola
   * petición pendiente por caso (la condición va en el filtro).
   */
  async requestRefund(pqrsId: string, agentId: string, reason: string): Promise<IPqrs> {
    const ticket = await Pqrs.findOneAndUpdate(
      {
        _id: pqrsId,
        orderId: { $ne: null },
        status: { $ne: 'closed' },
        'refundRequest.status': { $ne: 'pending' },
      },
      { $set: { refundRequest: { status: 'pending', reason, requestedBy: agentId, requestedAt: new Date() } } },
      { new: true }
    );
    if (!ticket) throw new AppError('El caso necesita un pedido, estar abierto y no tener otra solicitud pendiente', 409);
    void notifyAlertsChanged('pqrs');
    return ticket;
  }

  /** Finanzas cierra la petición: hecha (reembolsó) o rechazada. */
  async resolveRefundRequest(pqrsId: string, agentId: string, outcome: 'done' | 'rejected', note?: string): Promise<IPqrs> {
    const ticket = await Pqrs.findOneAndUpdate(
      { _id: pqrsId, 'refundRequest.status': 'pending' },
      {
        $set: {
          'refundRequest.status': outcome,
          'refundRequest.resolvedBy': agentId,
          'refundRequest.resolvedAt': new Date(),
          ...(note ? { 'refundRequest.resolutionNote': note } : {}),
        },
      },
      { new: true }
    );
    if (!ticket) throw new AppError('No hay una solicitud de reembolso pendiente en este caso', 409);
    void notifyAlertsChanged('pqrs');
    return ticket;
  }

  async close(pqrsId: string, agentId: string, message?: string): Promise<IPqrs> {
    if (message) await this.reply(pqrsId, agentId, message);

    const ticket = await Pqrs.findByIdAndUpdate(
      pqrsId,
      { status: 'closed', closedAt: new Date() },
      { new: true }
    );

    if (!ticket) throw new AppError('Caso no encontrado', 404);
    return ticket;
  }

  /**
   * La cola de trabajo.
   *
   * Ordenada por vencimiento y no por antigüedad: lo que llegó primero no
   * es necesariamente lo que hay que atender primero, y ordenar por fecha
   * de llegada deja los urgentes debajo de una pila de sugerencias.
   */
  async queue(options: QueueOptions = {}) {
    const view = options.view ?? 'open';
    const filter: Record<string, unknown> = {
      status: view === 'open' ? { $in: ['received', 'in_review'] } : view === 'answered' ? 'answered' : view === 'closed' ? 'closed' : { $in: ['answered', 'closed'] },
    };

    if (options.assignedTo) filter.assignedTo = options.assignedTo;
    else if (options.unassigned) filter.assignedTo = null;
    if (options.refundRequested) filter['refundRequest.status'] = 'pending';
    if (options.onlyOverdue) filter.dueAt = { $lt: new Date() };
    if (options.onlyLegalOverdue) filter.legalDueAt = { $lt: new Date() };
    if (options.type) filter.type = options.type;
    if (options.requesterRole) filter.requesterRole = options.requesterRole;
    if (options.q) {
      // El término del usuario nunca entra crudo en una expresión regular.
      const rx = new RegExp(options.q.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      // Además del texto del caso: quién lo abrió (nombre o teléfono) y el número de pedido.
      const [users, orders] = await Promise.all([
        User.find({ $or: [{ name: rx }, { phone: rx }] }).select('_id').limit(50).lean(),
        Order.find({ orderNumber: rx }).select('_id').limit(50).lean(),
      ]);
      filter.$or = [
        { subject: rx },
        { detail: rx },
        ...(users.length ? [{ userId: { $in: users.map((u) => u._id) } }] : []),
        ...(orders.length ? [{ orderId: { $in: orders.map((o) => o._id) } }] : []),
      ];
    }

    const rows = await Pqrs.find(filter)
      .sort({ dueAt: 1, createdAt: 1 })
      .limit(Math.min(Math.max(options.limit ?? 100, 1), MAX_QUEUE_LIMIT))
      .populate('userId', 'name phone email')
      .populate('assignedTo', 'name')
      .populate('orderId', 'orderNumber status')
      .populate('businessId', 'name')
      .populate({ path: 'driverId', select: 'userId', populate: { path: 'userId', select: 'name' } })
      .lean();

    const now = new Date();
    const withLegal = rows.map((row: any) => {
      const daysLeft = row.legalDueAt ? businessDaysUntil(row.legalDueAt, now) : null;
      return {
        ...row,
        legalOverdue: daysLeft != null && daysLeft < 0,
        legalDueSoon: daysLeft != null && daysLeft >= 0 && daysLeft <= LEGAL_DUE_SOON_BUSINESS_DAYS,
      };
    });

    // El orden por defecto sigue siendo por `dueAt` (el SLA operativo), pero
    // un caso con plazo LEGAL vencido o por vencer pasa al frente: perder un
    // derecho de petición por Ley 1755 es un problema distinto —y peor— que
    // llegar tarde al SLA interno.
    withLegal.sort((a: any, b: any) => {
      const rank = (r: any) => (r.legalOverdue ? 0 : r.legalDueSoon ? 1 : 2);
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      if (da !== db) return da - db;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return withLegal;
  }

  /** Cuántos casos hay, cuántos vencidos y cuánto se tarda en contestar. */
  async metrics() {
    const now = new Date();

    const [open, overdue, unassigned, legalOverdue, legalDueSoonRows, responseRows, refundRequests, resolutionRows] = await Promise.all([
      Pqrs.countDocuments({ status: { $in: ['received', 'in_review'] } }),
      Pqrs.countDocuments({
        status: { $in: ['received', 'in_review'] },
        dueAt: { $lt: now },
      }),
      Pqrs.countDocuments({
        status: { $in: ['received', 'in_review'] },
        assignedTo: null,
      }),
      Pqrs.countDocuments({
        status: { $in: ['received', 'in_review'] },
        legalDueAt: { $lt: now },
      }),
      // "Por vencer" no es un rango de fechas fijo: un festivo puede meter
      // 3 días hábiles en 5 o 6 días de calendario. Se trae lo que vence en
      // los próximos 10 días de calendario (cota amplia de sobra para 3
      // días hábiles) y se filtra con `businessDaysUntil`.
      Pqrs.find({
        status: { $in: ['received', 'in_review'] },
        legalDueAt: { $gte: now, $lte: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000) },
      }).select('legalDueAt').lean(),
      Pqrs.aggregate([
        { $match: { firstResponseAt: { $ne: null } } },
        {
          $group: {
            _id: null,
            avgMinutes: {
              $avg: {
                $divide: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 60000],
              },
            },
          },
        },
      ]),
      Pqrs.countDocuments({ 'refundRequest.status': 'pending' }),
      // Aproximado: no hay `closedAt`, así que se usa la última modificación del caso cerrado.
      Pqrs.aggregate([
        { $match: { status: 'closed' } },
        { $group: { _id: null, avgHours: { $avg: { $divide: [{ $subtract: ['$updatedAt', '$createdAt'] }, 3600000] } } } },
      ]),
    ]);

    const averageResolutionHours = Math.round((resolutionRows[0]?.avgHours ?? 0) * 10) / 10;
    const legalDueSoon = legalDueSoonRows.filter(
      (r: any) => businessDaysUntil(r.legalDueAt, now) <= LEGAL_DUE_SOON_BUSINESS_DAYS
    ).length;

    return {
      open,
      overdue,
      unassigned,
      refundRequests,
      averageResolutionHours,
      legalOverdue,
      legalDueSoon,
      averageFirstResponseMinutes: Math.round(responseRows[0]?.avgMinutes ?? 0),
    };
  }
}

export const supportService = new SupportService();
