import { z } from 'zod';
import { BUSINESS_BRAND_COLORS } from '../utils/businessBrand';
import { objectId } from './common';
import {
  LEGAL_DOCUMENT_TYPES,
  TAX_REGIMES,
  PAYOUT_METHODS,
  PAYOUT_ACCOUNT_TYPES,
} from '../models/Business';

/**
 * Merchant-facing schemas.
 *
 * Commercial terms are deliberately absent: `commissionRate`,
 * `commissionRateBps`, `isFeatured` and `isApproved` are not here, and the
 * validate middleware replaces the body with the parsed result, so those
 * keys are stripped rather than merely ignored. A merchant used to be able
 * to register itself at 0% commission and mark itself featured; both were
 * straight revenue holes.
 *
 * Admins set those fields through the dedicated admin endpoints, which are
 * audited.
 */
const merchantEditableFields = {
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  category: z.enum(['restaurant', 'fast_food', 'pharmacy', 'cafe', 'supermarket']),
  address: z.string().min(5),
  longitude: z.number(),
  latitude: z.number(),
  phone: z.string().min(7),
  deliveryTime: z.number().min(5).max(120).optional(),
  minOrder: z.number().min(0).optional(),
};

export const createBusinessSchema = z.object({
  body: z
    .object({
      ...merchantEditableFields,
      /** Admins may create a business on behalf of an owner. Ignored otherwise. */
      ownerId: z.string().optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateBusinessSchema = z.object({
  body: z
    .object({
      name: merchantEditableFields.name.optional(),
      description: merchantEditableFields.description,
      category: merchantEditableFields.category.optional(),
      address: merchantEditableFields.address.optional(),
      longitude: merchantEditableFields.longitude.optional(),
      latitude: merchantEditableFields.latitude.optional(),
      phone: merchantEditableFields.phone.optional(),
      deliveryTime: merchantEditableFields.deliveryTime,
      minOrder: merchantEditableFields.minOrder,
      /** Merchants may pause themselves; they may not switch themselves live. */
      isActive: z.boolean().optional(),

      /**
       * Color del encabezado cuando no hay portada.
       *
       * Lista cerrada: un hex libre deja pasar un amarillo sobre el que el
       * nombre del negocio no se lee, y el comercio no tiene por qué saber
       * de contraste. `null` devuelve el color que Zipp le asigna.
       */
      brandColor: z.enum(BUSINESS_BRAND_COLORS).nullable().optional(),

      /** Si la ficha muestra la franja de promoción. El texto no es suyo. */
      showPromoBanner: z.boolean().optional(),

      /**
       * Compra mínima a partir de la cual el negocio regala el domicilio.
       *
       * Es editable por el comercio y no por un administrador porque el
       * dinero sale de su liquidación: quien paga la promoción decide
       * cuándo se aplica. Cero la desactiva.
       */
      freeDeliveryThreshold: z.number().int().min(0).max(1_000_000).optional(),

      /**
       * Vigencia del envío gratis — mismas reglas que la franja de un
       * cupón (`Coupon.validDays/validFromTime/validUntilTime`), resuelta
       * con la misma función (`couponAvailability`). Vacío/ausente
       * significa "siempre", no "nunca".
       */
      freeDeliveryValidFrom: z.coerce.date().optional(),
      freeDeliveryValidUntil: z.coerce.date().optional(),
      freeDeliveryValidDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      freeDeliveryValidFromTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).optional(),
      freeDeliveryValidUntilTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).optional(),

      /**
       * Horario semanal. El servidor decide si está abierto, así que un
       * horario mal puesto cierra la tienda de verdad.
       */
      schedule: z
        .record(
          z.string(),
          z.object({
            open: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            close: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            isOpen: z.boolean().optional(),
          })
        )
        .optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});

/** Commercial terms. Admin-only, never reachable from the merchant panel. */
export const adminBusinessTermsSchema = z.object({
  body: z
    .object({
      commissionRateBps: z.number().int().min(-1).max(10_000).optional(),
      isFeatured: z.boolean().optional(),
      // `isApproved` ya no se acepta aquí (S11): aprobar es una puerta
      // aparte (`businessService.approve`) que exige documentos en regla y
      // deja `approvedBy`. Aceptarlo aquí dejaba aprobar sin ninguno de los
      // dos. `.strict()` en el body rechaza cualquier envío que lo incluya.
      isActive: z.boolean().optional(),
      minOrder: z.number().int().min(0).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});

// ── Documentos del comercio (O4) ─────────────────────────────────────

export const BUSINESS_DOCUMENT_TYPES = [
  'rut',
  'chamber_of_commerce',
  'legal_rep_id',
  'bank_certificate',
  'health_permit',
] as const;

/**
 * Los campos de texto que acompañan al archivo. La petición es multipart, así
 * que este esquema se aplica **dentro del controlador**, después de que multer
 * haya leído el cuerpo: pasarlo por `validate()` antes vaciaría `req.body`.
 */
export const businessDocumentBody = z.object({
  type: z.enum(BUSINESS_DOCUMENT_TYPES),
  reference: z.string().trim().min(3, 'El número del documento es obligatorio').max(500),
  // Un formulario multipart manda la cadena vacía cuando el campo no se llena.
  expiresAt: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce
      .date()
      .refine((date) => date.getTime() > Date.now(), 'La fecha de vencimiento debe ser futura')
      .optional()
  ),
});

export const reviewBusinessDocumentSchema = z.object({
  body: z
    .object({
      status: z.enum(['approved', 'rejected']),
      /** Obligatorio al rechazar: el comercio lo ve y corrige a ciegas si no. */
      rejectionReason: z.string().trim().min(5).max(300).optional(),
      /**
       * `updatedAt` (ms) del documento tal como lo vio quien revisa. Si el
       * comercio lo reemplazó mientras tanto, la revisión se rechaza en vez
       * de aprobar un archivo que nadie miró.
       */
      revision: z.number().int().positive(),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (body.status === 'rejected' && !body.rejectionReason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rejectionReason'],
          message: 'El motivo del rechazo es obligatorio (5 a 300 caracteres)',
        });
      }
    }),
  params: z.object({ documentId: objectId }),
});

// ── Datos fiscales y cuenta de pago ──────────────────────────────────

const optionalText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).optional().nullable();

/**
 * Identidad tributaria. Las reglas que dependen de otros campos (largo del
 * documento según el tipo, DV del NIT) viven en `business.service.ts`, que
 * también recibe llamadas que no pasan por HTTP.
 */
export const businessLegalSchema = z.object({
  body: z
    .object({
      documentType: z.enum(LEGAL_DOCUMENT_TYPES),
      documentNumber: z.string().trim().min(4).max(20),
      /** Opcional: el servidor lo calcula; si viene, se comprueba. */
      dv: z
        .union([z.string().trim().regex(/^\d$/, 'El DV es un solo dígito'), z.number().int().min(0).max(9)])
        .optional()
        .nullable(),
      legalName: z.string().trim().min(2).max(150),
      legalRepName: optionalText(2, 120),
      taxRegime: z.enum(TAX_REGIMES).optional().nullable(),
      billingEmail: z.string().trim().toLowerCase().email('Correo de facturación inválido').max(254).optional().nullable(),
    })
    .strict(),
  params: z.object({ id: objectId }),
});

export const businessPayoutAccountSchema = z.object({
  body: z
    .object({
      method: z.enum(PAYOUT_METHODS),
      bankName: optionalText(2, 80),
      accountType: z.enum(PAYOUT_ACCOUNT_TYPES).optional().nullable(),
      accountNumber: z.string().trim().min(6).max(24),
      holderName: z.string().trim().min(2).max(120),
      holderDocument: z.string().trim().min(5).max(20),
      /**
       * Reautenticación: la contraseña actual de quien hace el cambio, o el OTP
       * del celular si la cuenta no tiene contraseña (`POST .../payout-account/reauth-otp`).
       * Un token de acceso robado no basta para desviar el dinero.
       */
      currentPassword: z.string().min(1).max(200).optional(),
      otpCode: z.string().trim().regex(/^\d{4,8}$/, 'Código inválido').optional(),
    })
    .strict(),
  params: z.object({ id: objectId }),
});

export const verifyPayoutAccountSchema = z.object({
  body: z
    .object({
      /** La versión de la cuenta que finanzas revisó (`version` de la lectura). */
      version: z.number().int().min(1),
      note: z.string().trim().max(300).optional(),
    })
    .strict(),
  params: z.object({ id: objectId }),
});
