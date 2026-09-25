import { Request } from 'express';
import { Types } from 'mongoose';
import { InternalNote, IInternalNote, NoteEntityType, NOTE_ENTITY_TYPES, NOTE_MAX_LENGTH } from '../models/InternalNote';
import { Order, Business, Driver, User, Pqrs } from '../models';
import { Permission } from '../security/rbac';
import { logAudit, logSystemAudit, AuditAction, AuditSeverity } from '../security/audit';
import { AppError } from '../middlewares/errorHandler';
import { actorIsSuperAdmin } from './authorization.service';
import { adminThrottleService } from './adminThrottle.service';

/**
 * Notas internas del equipo sobre pedidos, comercios, domiciliarios, clientes
 * y PQRS.
 *
 * Reglas (docs de la Fase 2 del panel admin):
 *  - Solo se añaden; no se editan. Una corrección es otra nota.
 *  - Leer y escribir exigen el permiso de VISTA del tipo de entidad
 *    (`NOTE_PERMISSION`). Quien llama ya pasó `admin:panel`; el permiso del
 *    tipo se comprueba aquí dentro.
 *  - La entidad debe existir: no hay notas huérfanas.
 *  - Se rechaza todo lo que parezca un número de tarjeta (13-19 dígitos que
 *    pasen Luhn): las notas no son un almacén de datos de pago.
 *  - Borrado lógico. El autor, durante 15 min; después, solo un Super
 *    Administrador y con motivo. La condición va dentro del filtro de
 *    `findOneAndUpdate`, no en un `findById → validar → save()`.
 *  - La auditoría lleva entidad, id y longitud, NUNCA el texto: el log rota y
 *    no debe copiar datos personales.
 *  - Tope de 30 notas por minuto por persona, contado en Mongo (nada en
 *    memoria de proceso: PM2 corre una sola instancia y un reload lo borraría).
 */

export const NOTE_PERMISSION: Record<NoteEntityType, Permission> = {
  order: Permission.ORDERS_VIEW_ALL,
  business: Permission.BUSINESSES_VIEW,
  driver: Permission.DRIVERS_VIEW,
  user: Permission.USERS_VIEW,
  pqrs: Permission.SUPPORT_VIEW,
};

/** Ventana en la que el autor puede borrar su propia nota. */
export const NOTE_AUTHOR_DELETE_WINDOW_MS = 15 * 60 * 1000;
/** Notas por minuto y por persona. */
export const NOTE_RATE_LIMIT_PER_MINUTE = 30;
export const NOTE_DEFAULT_LIMIT = 20;
export const NOTE_MAX_LIMIT = 50;
export const NOTE_DELETE_REASON_MIN = 5;
export const NOTE_DELETE_REASON_MAX = 300;

/** Quien actúa. Lo arma el controlador (ver `noteActorFromRequest`). */
export interface NoteActor {
  userId: string;
  name: string;
  /** Permisos efectivos de la request (`req.permissions`). */
  permissions: Permission[];
  isSuperAdmin: boolean;
}

export interface NoteView {
  _id: string;
  entityType: NoteEntityType;
  entityId: string;
  body: string;
  author: { _id: string; name: string };
  createdAt: string;
  deletedAt: string | null;
  /** Calculado para quien pide: autor dentro de 15 min, o Super Administrador. */
  canDelete: boolean;
}

export interface NoteListResult {
  items: NoteView[];
  /** ISO del último ítem si hay más; pásalo como `before` para la página siguiente. */
  nextBefore: string | null;
}

/**
 * Arma el actor desde la request. `req.permissions` es lo que ya usa
 * `requirePermission`: en modo observación conserva el conjunto legacy (nadie
 * pierde acceso) y en bloqueo es `strict`.
 */
export async function noteActorFromRequest(req: Request): Promise<NoteActor> {
  const user = req.user;
  if (!user) throw new AppError('No autorizado', 401);
  return {
    userId: user._id.toString(),
    name: user.name,
    permissions: req.permissions ?? [],
    isSuperAdmin: await actorIsSuperAdmin(user),
  };
}

function assertEntityType(value: unknown): asserts value is NoteEntityType {
  if (typeof value !== 'string' || !(NOTE_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw new AppError('Tipo de entidad inválido', 400);
  }
}

function assertObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || String(new Types.ObjectId(value)) !== value) {
    throw new AppError(`${label} inválido`, 400);
  }
}

function assertCanUse(actor: NoteActor, entityType: NoteEntityType): void {
  if (!actor.permissions.includes(NOTE_PERMISSION[entityType])) {
    throw new AppError('No tienes permisos para las notas de este tipo', 403);
  }
}

/** Luhn sobre una cadena de dígitos. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ¿Esta racha de dígitos es (o esconde) un número de tarjeta? Una racha de 13 a
 * 19 dígitos se comprueba entera. Una más larga se recorre por ventanas: nadie
 * legítimo pega 20+ dígitos seguidos en una nota, y rechazar de más ahí es
 * preferible a dejar pasar una tarjeta con un dígito delante.
 */
function digitRunLooksLikeCard(run: string): boolean {
  if (run.length <= 19) return passesLuhn(run);
  for (let len = 13; len <= 19; len++) {
    for (let start = 0; start + len <= run.length; start++) {
      if (passesLuhn(run.slice(start, start + len))) return true;
    }
  }
  return false;
}

/**
 * Detecta un número de tarjeta en el texto: una racha de 13+ dígitos seguidos
 * o los agrupados típicos (4-4-4-x y 4-6-5 con espacio o guion) que pasen
 * Luhn. No junta números separados por un espacio cualquiera: dos teléfonos
 * seguidos no son una tarjeta.
 */
export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\d{13,}/g)) {
    if (digitRunLooksLikeCard(m[0])) return true;
  }
  const grouped = /(?<!\d)(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5})(?!\d)/g;
  for (const m of text.matchAll(grouped)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return true;
  }
  return false;
}

async function entityExists(entityType: NoteEntityType, entityId: string): Promise<boolean> {
  switch (entityType) {
    case 'order':
      return Boolean(await Order.exists({ _id: entityId }));
    case 'business':
      return Boolean(await Business.exists({ _id: entityId }));
    case 'driver':
      return Boolean(await Driver.exists({ _id: entityId }));
    case 'user':
      return Boolean(await User.exists({ _id: entityId }));
    case 'pqrs':
      return Boolean(await Pqrs.exists({ _id: entityId }));
  }
}

function toView(note: IInternalNote | Record<string, any>, actor: NoteActor, now = Date.now()): NoteView {
  const n = note as Record<string, any>;
  const deleted = Boolean(n.deletedAt);
  const isAuthor = String(n.authorId) === actor.userId;
  const withinWindow = now - new Date(n.createdAt).getTime() <= NOTE_AUTHOR_DELETE_WINDOW_MS;
  return {
    _id: String(n._id),
    entityType: n.entityType,
    entityId: String(n.entityId),
    body: n.body,
    author: { _id: String(n.authorId), name: n.authorName ?? '' },
    createdAt: new Date(n.createdAt).toISOString(),
    deletedAt: deleted ? new Date(n.deletedAt).toISOString() : null,
    canDelete: !deleted && (actor.isSuperAdmin || (isAuthor && withinWindow)),
  };
}

async function audit(
  req: Request | undefined,
  actor: NoteActor,
  action: AuditAction,
  entityType: NoteEntityType,
  entityId: string,
  description: string,
  metadata: Record<string, unknown>
): Promise<void> {
  // La entidad auditada es la ficha a la que pertenece la nota, no la nota:
  // así el historial de esa ficha (AuditLog por entidad) la incluye.
  const entry = { action, entity: entityType, entityId, severity: AuditSeverity.LOW, description, metadata };
  if (req) await logAudit(req, entry);
  else await logSystemAudit({ ...entry, userId: actor.userId, role: 'admin' });
}

export interface ListForInput {
  entityType: string;
  entityId: string;
  before?: string | Date;
  limit?: number;
  actor: NoteActor;
}

export async function listFor(input: ListForInput): Promise<NoteListResult> {
  const { entityType, entityId, actor } = input;
  assertEntityType(entityType);
  assertObjectId(entityId, 'Identificador');
  assertCanUse(actor, entityType);

  const limit = Math.min(Math.max(Math.trunc(input.limit ?? NOTE_DEFAULT_LIMIT) || NOTE_DEFAULT_LIMIT, 1), NOTE_MAX_LIMIT);

  const filter: Record<string, unknown> = { entityType, entityId: new Types.ObjectId(entityId) };
  // Las borradas solo las ve el Super Administrador (como "eliminadas").
  if (!actor.isSuperAdmin) filter.deletedAt = null;
  if (input.before !== undefined && input.before !== '') {
    const before = input.before instanceof Date ? input.before : new Date(input.before);
    if (Number.isNaN(before.getTime())) throw new AppError('Fecha "before" inválida', 400);
    filter.createdAt = { $lt: before };
  }

  const rows = await InternalNote.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const now = Date.now();
  return {
    items: page.map((n) => toView(n, actor, now)),
    nextBefore: hasMore ? new Date(page[page.length - 1].createdAt).toISOString() : null,
  };
}

export interface CreateInput {
  entityType: string;
  entityId: string;
  body: string;
  actor: NoteActor;
  /** Si viene, la auditoría conserva IP y user-agent. */
  req?: Request;
}

export async function create(input: CreateInput): Promise<NoteView> {
  const { entityType, entityId, actor } = input;
  assertEntityType(entityType);
  assertObjectId(entityId, 'Identificador');
  assertCanUse(actor, entityType);

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new AppError('La nota no puede estar vacía', 400);
  if (body.length > NOTE_MAX_LENGTH) {
    throw new AppError(`La nota no puede superar ${NOTE_MAX_LENGTH} caracteres`, 400);
  }
  if (containsCardNumber(body)) {
    throw new AppError('La nota parece contener un número de tarjeta. Quítalo: las notas no guardan datos de pago.', 400, 'NOTE_CARD_NUMBER');
  }

  if (!(await entityExists(entityType, entityId))) {
    throw new AppError('El elemento al que quieres anotar no existe', 404);
  }

  // Tope por persona y minuto con contador atómico (AdminThrottle): el
  // `countDocuments` + `create` anterior dejaba pasar ráfagas simultáneas.
  // Cuenta también los intentos que fallan después, y borrar y reescribir no burla el tope.
  const used = await adminThrottleService.hit(`note:${actor.userId}`, 60 * 1000);
  if (used > NOTE_RATE_LIMIT_PER_MINUTE) {
    throw new AppError('Demasiadas notas seguidas. Espera un momento.', 429);
  }

  const note = await InternalNote.create({
    entityType,
    entityId: new Types.ObjectId(entityId),
    authorId: new Types.ObjectId(actor.userId),
    authorName: actor.name,
    body,
  });

  await audit(input.req, actor, AuditAction.INTERNAL_NOTE_CREATED, entityType, entityId, `Nota interna creada sobre ${entityType}`, {
    noteId: note._id.toString(),
    entityType,
    entityId,
    length: body.length,
  });

  return toView(note, actor);
}

export interface SoftDeleteInput {
  id: string;
  reason?: string;
  actor: NoteActor;
  req?: Request;
}

export async function softDelete(input: SoftDeleteInput): Promise<NoteView> {
  const { id, actor } = input;
  assertObjectId(id, 'Identificador de nota');

  const existing = await InternalNote.findById(id).lean();
  if (!existing) throw new AppError('Nota no encontrada', 404);
  assertCanUse(actor, existing.entityType);
  if (existing.deletedAt) throw new AppError('La nota ya fue eliminada', 409);

  const now = Date.now();
  const cutoff = new Date(now - NOTE_AUTHOR_DELETE_WINDOW_MS);
  const isAuthor = String(existing.authorId) === actor.userId;
  const authorInWindow = isAuthor && new Date(existing.createdAt).getTime() >= cutoff.getTime();

  if (!actor.isSuperAdmin && !authorInWindow) {
    throw new AppError('Solo el autor puede borrar su nota durante los primeros 15 minutos', 403);
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > NOTE_DELETE_REASON_MAX) {
    throw new AppError(`El motivo no puede superar ${NOTE_DELETE_REASON_MAX} caracteres`, 400);
  }
  // El autor dentro de su ventana no tiene que justificarse; cualquier otro
  // borrado (Super Administrador sobre nota ajena o vieja) sí.
  if (!authorInWindow && reason.length < NOTE_DELETE_REASON_MIN) {
    throw new AppError(`Indica el motivo del borrado (mínimo ${NOTE_DELETE_REASON_MIN} caracteres)`, 400);
  }

  // La condición va dentro del filtro: dos borrados simultáneos → uno gana; y
  // el plazo del autor se vuelve a comprobar en la escritura, no solo arriba.
  const filter: Record<string, unknown> = { _id: existing._id, deletedAt: null };
  if (!actor.isSuperAdmin) {
    filter.authorId = new Types.ObjectId(actor.userId);
    filter.createdAt = { $gte: cutoff };
  }
  const updated = await InternalNote.findOneAndUpdate(
    filter,
    {
      $set: {
        deletedAt: new Date(now),
        deletedBy: new Types.ObjectId(actor.userId),
        ...(reason ? { deleteReason: reason } : {}),
      },
    },
    { new: true }
  ).lean();
  if (!updated) throw new AppError('La nota ya fue eliminada o el plazo para borrarla venció', 409);

  await audit(
    input.req,
    actor,
    AuditAction.INTERNAL_NOTE_DELETED,
    updated.entityType,
    String(updated.entityId),
    `Nota interna eliminada (${updated.entityType})`,
    {
      noteId: String(updated._id),
      entityType: updated.entityType,
      entityId: String(updated.entityId),
      byAuthor: isAuthor,
      ...(reason ? { reason } : {}),
    }
  );

  return toView(updated, actor, now);
}

export const internalNoteService = { listFor, create, softDelete, noteActorFromRequest, NOTE_PERMISSION };
