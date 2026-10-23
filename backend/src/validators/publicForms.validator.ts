import { z } from 'zod';
import { objectId } from './common';
import { CONTACT_TYPES, CONTACT_STATUSES } from '../models/ContactRequest';
import { PARTNER_TYPES, PARTNER_STATUSES, PARTNER_VEHICLES } from '../models/PartnerApplication';
import { honeypot, mobilePhone, optionalText, text } from '../services/publicForms';

const paging = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const otpCode = z.string().trim().regex(/^\d{6}$/, 'El código debe tener 6 dígitos');

// ── Contacto ──
export const createContactSchema = z.object({
  body: z
    .object({
      name: text(2, 80, 'Escribe tu nombre'),
      contact: z.string().trim().min(7, 'Escribe un celular o un correo').max(120),
      type: z.enum(CONTACT_TYPES),
      subject: optionalText(120),
      detail: text(10, 2000, 'Cuéntanos un poco más (mínimo 10 caracteres)'),
      website: honeypot,
    })
});

export const listContactSchema = z.object({
  query: z.object({ status: z.enum(CONTACT_STATUSES).optional(), ...paging }),
});

export const updateContactSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      status: z.enum(CONTACT_STATUSES),
      response: optionalText(2000),
    })
});

// ── Eliminación de cuenta ──
export const deletionSendOtpSchema = z.object({ body: z.object({ phone: mobilePhone }) });

export const deletionConfirmSchema = z.object({
  body: z
    .object({
      phone: mobilePhone,
      otp: otpCode,
      reason: optionalText(500),
    })
});

// ── Aliados ──
export const partnerSendOtpSchema = z.object({ body: z.object({ phone: mobilePhone }) });

export const partnerApplySchema = z.object({
  body: z
    .object({
      type: z.enum(PARTNER_TYPES),
      name: text(2, 80, 'Escribe tu nombre'),
      phone: mobilePhone,
      otp: otpCode,
      email: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.string().trim().toLowerCase().email('Correo inválido').max(120).optional()
      ),
      city: text(2, 80, 'Escribe tu ciudad'),
      businessName: optionalText(100),
      category: optionalText(60),
      address: optionalText(200),
      vehicleType: z.enum(PARTNER_VEHICLES).optional(),
      experience: optionalText(1000),
      notes: optionalText(1000),
      website: honeypot,
    })
    .superRefine((b, ctx) => {
      if (b.type === 'business') {
        if (!b.businessName || b.businessName.length < 2) ctx.addIssue({ code: 'custom', path: ['businessName'], message: 'Escribe el nombre del negocio' });
        if (!b.category) ctx.addIssue({ code: 'custom', path: ['category'], message: 'Indica la categoría del negocio' });
        if (!b.address || b.address.length < 5) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Escribe la dirección del negocio' });
      } else if (!b.vehicleType) {
        ctx.addIssue({ code: 'custom', path: ['vehicleType'], message: 'Indica tu tipo de vehículo' });
      }
    }),
});

export const listPartnerSchema = z.object({
  query: z.object({
    status: z.enum(PARTNER_STATUSES).optional(),
    type: z.enum(PARTNER_TYPES).optional(),
    ...paging,
  }),
});

export const partnerIdSchema = z.object({ params: z.object({ id: objectId }) });

export const updatePartnerSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      status: z.enum(PARTNER_STATUSES),
      adminNote: optionalText(1000),
    })
});

export const approvePartnerSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      adminNote: optionalText(1000),
      /** Solo comercios: la categoría de la solicitud es texto libre; si no coincide con una del catálogo, el admin la elige. */
      businessCategory: z.enum(['restaurant', 'fast_food', 'pharmacy', 'cafe', 'supermarket']).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    })
    .default({}),
});
