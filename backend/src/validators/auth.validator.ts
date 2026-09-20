import { z } from 'zod';
import { phoneSchema } from '../utils/phone';
import { DOCUMENT_TYPES, type DocumentType } from '../models/User';
import { parseBirthDate } from '../utils/age';

/**
 * Todos los celulares entran por `phoneSchema`: se normalizan a los 10
 * dígitos nacionales antes de llegar al servicio, así que `+57 310…`,
 * `57310…` y `310…` son el mismo número en toda la API.
 */

const otpCodeSchema = z.string().regex(/^\d{6}$/, 'OTP debe ser de 6 dígitos');
const passwordSchema = z.string().min(6, 'Mínimo 6 caracteres').max(128, 'Máximo 128 caracteres');
/** TOTP de 6 dígitos o código de recuperación `XXXXX-XXXXX`. */
const secondFactorSchema = z.string().trim().min(6).max(20);

// ── Entrada única (celular → login o registro), al estilo Rappi. ──
export const phoneStatusSchema = z.object({
  body: z.object({
    phone: phoneSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// ── Registro en 3 pasos (celular → nombre → contraseña), verificando el
// celular por OTP antes de pedir el resto, al estilo Rappi. ──
//
// `POST /auth/register` (registro sin OTP, que además dejaba elegir el rol
// `driver` o `business`) se eliminó: ningún cliente lo usaba y era la única
// puerta para crear cuentas con un celular sin verificar.
export const registerSendOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const registerVerifyOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    otpCode: otpCodeSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const registerCompleteSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(100),
    password: passwordSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const loginSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    password: z.string().min(1, 'La contraseña es requerida').max(128),
    // Antes el esquema no los declaraba y Zod los descartaba: el login con
    // 2FA nunca recibía el código, y el antifraude nunca veía el dispositivo.
    totpToken: secondFactorSchema.optional(),
    deviceId: z.string().trim().min(1).max(128).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const mfaChallengeSchema = z.object({
  body: z.object({
    challengeToken: z.string().min(20).max(200),
    code: secondFactorSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const sendOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    otpCode: otpCodeSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const sendEmailOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Email inválido').max(254),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const verifyEmailOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Email inválido').max(254),
    otpCode: otpCodeSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token requerido').max(2048),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const logoutSchema = z.object({
  body: z.object({
    refreshToken: z.string().max(2048).optional(),
  }).optional().default({}),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    otpCode: otpCodeSchema,
    password: passwordSchema,
    totpToken: secondFactorSchema.optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const googleLoginSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'idToken requerido').max(4096),
    nonce: z.string().min(16).max(128).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

/**
 * Apple ya no recibe el `id_token`: recibe el código de un solo uso que dejó
 * `/auth/apple/callback` y el nonce en claro que generó la app. Ver
 * `models/OAuthReplay.ts`.
 */
export const appleLoginSchema = z.object({
  body: z.object({
    code: z.string().min(20, 'Código de Apple requerido').max(200),
    nonce: z.string().min(16, 'nonce requerido').max(128),
    // Apple solo manda el nombre la primera vez que el usuario autoriza la
    // app — en los logins siguientes el identityToken no lo trae.
    fullName: z.string().trim().min(1).max(100).optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

/**
 * Facebook: el `code` que Meta dejó en el deep link y el `code_verifier` de
 * PKCE que generó la app (43-128 caracteres, RFC 7636).
 */
export const facebookLoginSchema = z.object({
  body: z.object({
    code: z.string().min(10, 'Código de Facebook requerido').max(2048),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, 'Verificador inválido'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

/**
 * Formato de cada documento de identidad. La app aplica las mismas reglas
 * antes de enviar (mobile/lib/identityDocument.ts); aquí son las que valen.
 * El número llega ya sin puntos ni espacios.
 */
export const documentNumberRules: Record<DocumentType, { pattern: RegExp; message: string }> = {
  CC: { pattern: /^\d{5,10}$/, message: 'La cédula tiene entre 5 y 10 dígitos' },
  CE: { pattern: /^\d{6,10}$/, message: 'La cédula de extranjería tiene entre 6 y 10 dígitos' },
  PPT: { pattern: /^\d{6,10}$/, message: 'El PPT tiene entre 6 y 10 dígitos' },
  PASAPORTE: { pattern: /^[A-Z0-9]{5,15}$/, message: 'El pasaporte tiene entre 5 y 15 letras o números' },
};

const personNameSchema = z.string().trim().min(2, 'Mínimo 2 caracteres').max(60);

export const updateProfileSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(100).optional(),
      firstName: personNameSchema.optional(),
      lastName: personNameSchema.optional(),
      phone: phoneSchema.optional(),
      email: z.string().email('Email inválido').max(254).optional().or(z.literal('')),
      // `null` en los dos borra el documento guardado.
      documentType: z.enum(DOCUMENT_TYPES as [DocumentType, ...DocumentType[]]).nullable().optional(),
      documentNumber: z
        .string()
        .transform((v) => v.replace(/[\s.\-]/g, '').toUpperCase())
        .nullable()
        .optional(),
      // La edad (mínimo 14) se valida en el servicio: depende de "hoy" en Bogotá.
      birthDate: z
        .string()
        .refine((v) => parseBirthDate(v) !== null, 'Fecha de nacimiento inválida (AAAA-MM-DD)')
        .optional(),
    })
    .superRefine((body, ctx) => {
      const hasType = body.documentType !== undefined;
      const hasNumber = body.documentNumber !== undefined;
      if (hasType !== hasNumber || (body.documentType === null) !== (body.documentNumber === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentNumber'],
          message: 'El tipo y el número de documento van juntos',
        });
        return;
      }
      if (body.documentType && body.documentNumber) {
        const rule = documentNumberRules[body.documentType];
        if (!rule.pattern.test(body.documentNumber)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['documentNumber'], message: rule.message });
        }
      }
    }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const verifyPhoneSchema = z.object({
  body: z.object({
    otpCode: otpCodeSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida').max(128),
    newPassword: z.string().min(1, 'La contraseña nueva es requerida').max(128),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const twoFactorTokenSchema = z.object({
  body: z.object({
    token: secondFactorSchema,
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const revokeAllSessionsSchema = z.object({
  body: z.object({
    currentRefreshToken: z.string().max(2048).optional(),
  }).optional().default({}),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const deleteAccountSchema = z.object({
  body: z.object({
    password: z.string().min(1).max(128).optional(),
    otpCode: otpCodeSchema.optional(),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});
