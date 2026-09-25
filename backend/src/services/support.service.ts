import { Pqrs, IPqrs } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { emitToUser } from '../sockets/emitter';
import { pushService } from './push.service';
import { businessDaysUntil } from '../utils';
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

export interface QueueOptions {
  assignedTo?: string;
  onlyOverdue?: boolean;
  onlyLegalOverdue?: boolean;
  /** `open` (por defecto): sin responder. `answered`: respondidos. `done`: respondidos y cerrados. */
  view?: 'open' | 'answered' | 'done';
  type?: IPqrs['type'];
  requesterRole?: IPqrs['requesterRole'];
  q?: string;
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

  async close(pqrsId: string, agentId: string, message?: string): Promise<IPqrs> {
    if (message) await this.reply(pqrsId, agentId, message);

    const ticket = await Pqrs.findByIdAndUpdate(
      pqrsId,
      { status: 'closed' },
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
      status: view === 'open' ? { $in: ['received', 'in_review'] } : view === 'answered' ? 'answered' : { $in: ['answered', 'closed'] },
    };

    if (options.assignedTo) filter.assignedTo = options.assignedTo;
    if (options.onlyOverdue) filter.dueAt = { $lt: new Date() };
    if (options.onlyLegalOverdue) filter.legalDueAt = { $lt: new Date() };
    if (options.type) filter.type = options.type;
    if (options.requesterRole) filter.requesterRole = options.requesterRole;
    if (options.q) {
      // El término del usuario nunca entra crudo en una expresión regular.
      const rx = new RegExp(options.q.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ subject: rx }, { detail: rx }];
    }

    const rows = await Pqrs.find(filter)
      .sort({ dueAt: 1, createdAt: 1 })
      .limit(100)
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

    const [open, overdue, unassigned, legalOverdue, legalDueSoonRows, responseRows] = await Promise.all([
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
    ]);

    const legalDueSoon = legalDueSoonRows.filter(
      (r: any) => businessDaysUntil(r.legalDueAt, now) <= LEGAL_DUE_SOON_BUSINESS_DAYS
    ).length;

    return {
      open,
      overdue,
      unassigned,
      legalOverdue,
      legalDueSoon,
      averageFirstResponseMinutes: Math.round(responseRows[0]?.avgMinutes ?? 0),
    };
  }
}

export const supportService = new SupportService();
