import type { Request } from 'express';
import { FilterQuery, Types } from 'mongoose';
import { ContactRequest, IContactRequest, ContactType, ContactStatus } from '../models/ContactRequest';
import { AppError } from '../middlewares/errorHandler';
import { AuditAction, AuditSeverity, logAudit } from '../security';
import { notifyAlertsChanged } from './alerts.service';
import { clientIp } from '../utils/helpers';
import { hashIp, normalizeContact } from './publicForms';

/** Abiertas (no resueltas) por mismo contacto en la ventana de 24 h. */
export const CONTACT_MAX_OPEN_PER_CONTACT = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const CONTACT_RECEIVED_MESSAGE = 'Recibimos tu mensaje. Te responderemos pronto por el medio que nos dejaste.';

export interface CreateContactInput {
  name: string;
  contact: string;
  type: ContactType;
  subject?: string;
  detail: string;
}

/** Vista que sale al panel: sin el HMAC de la IP. */
const ADMIN_FIELDS = '-ipHash';

export const contactService = {
  async create(input: CreateContactInput, req: Request): Promise<void> {
    const contact = normalizeContact(input.contact);
    if (!contact) throw new AppError('Escribe un celular colombiano o un correo válido', 422, 'CONTACT_INVALID');

    const open = await ContactRequest.countDocuments({
      contact,
      status: { $ne: 'resolved' },
      createdAt: { $gte: new Date(Date.now() - WINDOW_MS) },
    });
    if (open >= CONTACT_MAX_OPEN_PER_CONTACT) {
      throw new AppError(
        'Ya tienes varios mensajes pendientes con este contacto. Te responderemos pronto; espera nuestra respuesta antes de escribir de nuevo.',
        429,
        'CONTACT_TOO_MANY_OPEN'
      );
    }

    await ContactRequest.create({
      name: input.name,
      contact,
      type: input.type,
      subject: input.subject,
      detail: input.detail,
      ipHash: hashIp(clientIp(req)),
    });
    void notifyAlertsChanged('contact_request_new');
  },

  async list(params: { status?: ContactStatus; page: number; limit: number }) {
    const filter: FilterQuery<IContactRequest> = params.status ? { status: params.status } : {};
    const [items, total] = await Promise.all([
      ContactRequest.find(filter)
        .select(ADMIN_FIELDS)
        .sort({ createdAt: -1 })
        .skip((params.page - 1) * params.limit)
        .limit(params.limit)
        .lean(),
      ContactRequest.countDocuments(filter),
    ]);
    return {
      items,
      meta: { page: params.page, limit: params.limit, total, totalPages: Math.max(1, Math.ceil(total / params.limit)) },
    };
  },

  async update(id: string, input: { status: ContactStatus; response?: string }, actorId: string, req: Request) {
    const $set: Record<string, unknown> = { status: input.status, handledBy: new Types.ObjectId(actorId), handledAt: new Date() };
    if (input.response !== undefined) $set.response = input.response;
    const updated = await ContactRequest.findByIdAndUpdate(id, { $set }, { new: true }).select(ADMIN_FIELDS).lean();
    if (!updated) throw new AppError('Mensaje no encontrado', 404);
    void logAudit(req, {
      action: AuditAction.CONTACT_REQUEST_HANDLED,
      entity: 'contact_request',
      entityId: id,
      severity: AuditSeverity.LOW,
      description: `Mensaje de contacto marcado como "${input.status}"`,
      metadata: { status: input.status, hasResponse: input.response !== undefined },
    });
    void notifyAlertsChanged('contact_request_new');
    return updated;
  },
};
