import type { Request } from 'express';
import { FilterQuery, Types } from 'mongoose';
import { PartnerApplication, IPartnerApplication, PartnerStatus, PartnerType } from '../models/PartnerApplication';
import { User } from '../models';
import { AppError } from '../middlewares/errorHandler';
import { can } from '../middlewares/auth';
import { BusinessCategory, BUSINESS_CATEGORY_LABELS, UserRole } from '../types';
import { AuditAction, AuditSeverity, Permission, logAudit } from '../security';
import { clientIp } from '../utils/helpers';
import { normalize } from '../utils/text';
import { businessService } from './business.service';
import { adminService } from './admin.service';
import { whatsappService } from './whatsapp.service';
import { publicOtpService } from './publicOtp.service';
import { notifyAlertsChanged } from './alerts.service';
import { hashIp } from './publicForms';

/** Centro de Garzón: ubicación provisional de un comercio en borrador hasta que su dueño ubique el local. */
export const DEFAULT_DRAFT_LOCATION = { latitude: 2.1958, longitude: -75.6258 };

export const PARTNER_RECEIVED_MESSAGE = 'Recibimos tu solicitud. Nuestro equipo te contactará pronto.';
export const PARTNER_DUPLICATE_MESSAGE = 'Ya recibimos tu solicitud. Nuestro equipo te contactará pronto.';
export const PARTNER_OTP_MESSAGE = 'Te enviamos un código por WhatsApp.';

const OPEN_STATUSES: PartnerStatus[] = ['new', 'contacted'];
const ADMIN_FIELDS = '-ipHash';

export interface PartnerApplyInput {
  type: PartnerType;
  name: string;
  phone: string;
  otp: string;
  email?: string;
  city: string;
  businessName?: string;
  category?: string;
  address?: string;
  vehicleType?: IPartnerApplication['vehicleType'];
  experience?: string;
  notes?: string;
}

/** La categoría libre de la solicitud contra el catálogo (por clave o por nombre visible). */
function matchCategory(raw: string | undefined): BusinessCategory | null {
  if (!raw) return null;
  const wanted = normalize(raw);
  for (const value of Object.values(BusinessCategory)) {
    if (normalize(value) === wanted || normalize(value.replace(/_/g, ' ')) === wanted) return value;
    const label = BUSINESS_CATEGORY_LABELS[value];
    if (label && normalize(label) === wanted) return value;
  }
  return null;
}

export const partnerService = {
  async sendOtp(phone: string): Promise<void> {
    const code = await publicOtpService.issue('partner_application', phone);
    if (!code) {
      throw new AppError('Espera unos segundos antes de pedir otro código.', 429, 'OTP_COOLDOWN');
    }
    await whatsappService.sendOTP(phone, code);
  },

  /** `created: false` si ya había una solicitud abierta del mismo celular y tipo. */
  async apply(input: PartnerApplyInput, req: Request): Promise<{ created: boolean }> {
    // El código va primero: así nadie sin el celular puede averiguar si ya hay una solicitud.
    await publicOtpService.verify('partner_application', input.phone, input.otp, req);

    const existing = await PartnerApplication.exists({ phone: input.phone, type: input.type, status: { $in: OPEN_STATUSES } });
    if (existing) return { created: false };

    const account = await User.findOne({ phone: input.phone }).select('_id').lean();
    await PartnerApplication.create({
      type: input.type,
      name: input.name,
      phone: input.phone,
      email: input.email,
      city: input.city,
      businessName: input.type === 'business' ? input.businessName : undefined,
      category: input.type === 'business' ? input.category : undefined,
      address: input.type === 'business' ? input.address : undefined,
      vehicleType: input.type === 'driver' ? input.vehicleType : undefined,
      experience: input.experience,
      notes: input.notes,
      userId: account?._id,
      ipHash: hashIp(clientIp(req)),
    });
    void notifyAlertsChanged('partner_application_new');
    return { created: true };
  },

  async list(params: { status?: PartnerStatus; type?: PartnerType; page: number; limit: number }) {
    const filter: FilterQuery<IPartnerApplication> = {};
    if (params.status) filter.status = params.status;
    if (params.type) filter.type = params.type;
    const [items, total] = await Promise.all([
      PartnerApplication.find(filter)
        .select(ADMIN_FIELDS)
        .sort({ createdAt: -1 })
        .skip((params.page - 1) * params.limit)
        .limit(params.limit)
        .lean(),
      PartnerApplication.countDocuments(filter),
    ]);
    return {
      items,
      meta: { page: params.page, limit: params.limit, total, totalPages: Math.max(1, Math.ceil(total / params.limit)) },
    };
  },

  async get(id: string) {
    const item = await PartnerApplication.findById(id).select(ADMIN_FIELDS).lean();
    if (!item) throw new AppError('Solicitud no encontrada', 404);
    return item;
  },

  async update(id: string, input: { status: PartnerStatus; adminNote?: string }, actorId: string, req: Request) {
    if (input.status === 'approved') {
      throw new AppError('Para aprobar usa la acción "aprobar": crea la cuenta o el comercio y deja rastro.', 422, 'USE_APPROVE');
    }
    const $set: Record<string, unknown> = { status: input.status };
    if (input.adminNote !== undefined) $set.adminNote = input.adminNote;
    if (input.status === 'contacted') $set.assignedTo = new Types.ObjectId(actorId);
    const updated = await PartnerApplication.findOneAndUpdate(
      // Una solicitud ya aprobada no se devuelve a "nueva": el comercio o el rol ya existen.
      { _id: id, status: { $ne: 'approved' } },
      { $set },
      { new: true }
    )
      .select(ADMIN_FIELDS)
      .lean();
    if (!updated) {
      if (await PartnerApplication.exists({ _id: id })) throw new AppError('La solicitud ya fue aprobada y no se puede modificar', 409);
      throw new AppError('Solicitud no encontrada', 404);
    }
    void logAudit(req, {
      action: AuditAction.PARTNER_APPLICATION_UPDATED,
      entity: 'partner_application',
      entityId: id,
      description: `Solicitud de aliado marcada como "${input.status}"`,
      metadata: { status: input.status, type: updated.type },
    });
    void notifyAlertsChanged('partner_application_new');
    return updated;
  },

  /**
   * Aprueba una solicitud.
   *
   * - Sin cuenta con ese celular: queda `approved` y `needsAccount: true`; la
   *   persona debe registrarse primero como cliente.
   * - Con cuenta CLIENT: cambia el rol por `adminService.updateUserRole` (el
   *   mismo camino de `PATCH /admin/users/:id/role`: guards, revocación de
   *   sesiones y auditoría incluidos), lo que exige `users:role_change`.
   * - Comercio: crea el `Business` en borrador con `businessService.create`
   *   (`isApproved: false`). La aprobación real del local sigue siendo
   *   `businessService.approve`, que prohíbe la autoaprobación.
   * - Repartidor: solo el rol; el perfil lo crea la app (`POST /drivers/register`).
   *
   * Todo se valida antes de tocar nada; si algo falla a medias, repetir la
   * aprobación continúa donde quedó (rol ya cambiado, negocio ya creado).
   */
  async approve(
    id: string,
    opts: { adminNote?: string; businessCategory?: BusinessCategory; latitude?: number; longitude?: number },
    actor: NonNullable<Request['user']>,
    req: Request
  ) {
    const app = await PartnerApplication.findById(id);
    if (!app) throw new AppError('Solicitud no encontrada', 404);
    if (app.status === 'rejected') throw new AppError('La solicitud fue rechazada; márcala como nueva antes de aprobarla', 422);

    const user = await User.findOne({ phone: app.phone });
    const finish = async (extra: Record<string, unknown>) => {
      const $set: Record<string, unknown> = { status: 'approved', ...extra };
      if (opts.adminNote !== undefined) $set.adminNote = opts.adminNote;
      if (!app.assignedTo) $set.assignedTo = actor._id;
      const updated = await PartnerApplication.findByIdAndUpdate(id, { $set }, { new: true }).select(ADMIN_FIELDS).lean();
      void notifyAlertsChanged('partner_application_new');
      return updated!;
    };

    if (!user) {
      const application = await finish({});
      void logAudit(req, {
        action: AuditAction.PARTNER_APPLICATION_APPROVED,
        entity: 'partner_application',
        entityId: id,
        severity: AuditSeverity.MEDIUM,
        description: 'Solicitud de aliado aprobada sin cuenta: la persona debe registrarse primero',
        metadata: { type: app.type, needsAccount: true },
      });
      return { application, needsAccount: true as const };
    }

    const targetRole = app.type === 'business' ? UserRole.BUSINESS : UserRole.DRIVER;
    const needsRoleChange = user.role !== targetRole;

    // ── Comprobaciones previas: nada se modifica hasta que todas pasan ──
    if (needsRoleChange) {
      if (user.role !== UserRole.CLIENT) {
        throw new AppError(`La cuenta con ese celular ya tiene el rol "${user.role}"; resuélvelo manualmente en Usuarios.`, 422, 'ROLE_CONFLICT');
      }
      if (!can(req, Permission.USERS_ROLE_CHANGE)) {
        throw new AppError('Aprobar esta solicitud cambia el rol de una cuenta y requiere el permiso de cambio de rol.', 403);
      }
      if (targetRole === UserRole.BUSINESS && !user.email) {
        throw new AppError('La cuenta no tiene correo: el comercio entra al panel por correo. Pídele que lo registre en la app y vuelve a aprobar.', 422, 'EMAIL_REQUIRED');
      }
    }

    let category: BusinessCategory | null = null;
    if (app.type === 'business' && !app.businessId) {
      category = opts.businessCategory ?? matchCategory(app.category);
      if (!category) {
        throw new AppError(
          `La categoría "${app.category ?? ''}" no coincide con el catálogo; elige una en businessCategory (${Object.values(BusinessCategory).join(', ')}).`,
          422,
          'CATEGORY_REQUIRED'
        );
      }
    }

    // ── Efectos ──
    if (needsRoleChange) {
      await adminService.updateUserRole(user._id.toString(), targetRole, actor as never, req);
    }

    let businessId = app.businessId;
    if (app.type === 'business' && !businessId) {
      try {
        const business = await businessService.create({
          ownerId: user._id.toString(),
          name: app.businessName!,
          category: category!,
          address: app.address!,
          phone: app.phone,
          city: app.city,
          latitude: opts.latitude ?? DEFAULT_DRAFT_LOCATION.latitude,
          longitude: opts.longitude ?? DEFAULT_DRAFT_LOCATION.longitude,
        });
        businessId = business._id;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          throw new AppError('Ya existe un comercio con ese nombre. Cambia el nombre en la solicitud o resuélvelo con el solicitante.', 409, 'BUSINESS_NAME_TAKEN');
        }
        throw error;
      }
    }

    const application = await finish({
      userId: user._id,
      createdUserRole: targetRole,
      ...(businessId ? { businessId } : {}),
    });
    void logAudit(req, {
      action: AuditAction.PARTNER_APPLICATION_APPROVED,
      entity: 'partner_application',
      entityId: id,
      severity: AuditSeverity.HIGH,
      description: needsRoleChange ? `Solicitud de aliado aprobada: cuenta pasa a "${targetRole}"` : 'Solicitud de aliado aprobada',
      metadata: { type: app.type, userId: user._id.toString(), roleChanged: needsRoleChange, businessId: businessId?.toString() },
    });
    return { application, needsAccount: false as const };
  },
};

