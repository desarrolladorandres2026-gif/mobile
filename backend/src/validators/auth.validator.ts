import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Mínimo 2 caracteres').max(100),
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
    email: z.string().email('Email inválido').optional(),
    password: z.string().min(6, 'Mínimo 6 caracteres'),
    role: z.enum(['client', 'driver', 'business']).default('client'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// ── Entrada única (celular → login o registro), al estilo Rappi. ──
export const phoneStatusSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// ── Registro en 3 pasos (celular → nombre → contraseña), verificando el
// celular por OTP antes de pedir el resto, al estilo Rappi. ──
export const registerSendOtpSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const registerVerifyOtpSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
    otpCode: z.string().length(6, 'OTP debe ser de 6 dígitos'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const registerCompleteSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
    name: z.string().min(2, 'Mínimo 2 caracteres').max(100),
    password: z.string().min(6, 'Mínimo 6 caracteres'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const loginSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
    password: z.string().min(1, 'La contraseña es requerida'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
    otpCode: z.string().length(6, 'OTP debe ser de 6 dígitos'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const sendEmailOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Email inválido'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const verifyEmailOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Email inválido'),
    otpCode: z.string().length(6, 'OTP debe ser de 6 dígitos'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token requerido'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido'),
    otpCode: z.string().length(6, 'OTP debe ser de 6 dígitos'),
    password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const googleLoginSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'idToken requerido'),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Mínimo 2 caracteres').max(100).optional(),
    phone: z.string().regex(/^(\+57)?[0-9]{10}$/, 'Número de celular inválido').optional(),
    email: z.string().email('Email inválido').optional().or(z.literal('')),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});
