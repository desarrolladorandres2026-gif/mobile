import { api } from './http';
import { clearSession, getRefreshToken, setTokens } from './session';

export interface User {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  receiptEmail?: string;
  role: string;
  avatar?: string;
  isVerified: boolean;
  phoneVerified?: boolean;
  emailVerified?: boolean;
  pendingPhone?: string;
  twoFactorEnabled?: boolean;
  firstName?: string;
  lastName?: string;
}

/** Sesión emitida: login, registro, Google o el reto de 2FA. */
export interface SessionResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  /** Google no da celular: la cuenta queda a medias hasta que lo escriba. */
  needsPhone?: boolean;
}

/** El primer factor fue correcto, pero todavía no hay sesión. */
export interface TwoFactorRequired {
  requiresTOTP: true;
  challengeToken?: string;
  user: { _id: string; name: string };
}

export type AuthResponse = SessionResult | TwoFactorRequired;

export const needsSecondFactor = (r: AuthResponse): r is TwoFactorRequired =>
  (r as TwoFactorRequired).requiresTOTP === true;

export interface ActiveSession {
  _id: string;
  deviceName?: string;
  ip?: string;
  lastActivity?: string;
  createdAt?: string;
  isCurrent?: boolean;
}

/** Cuentas de otros roles entran por su propia puerta; el sitio es del cliente. */
export class WrongRoleError extends Error {
  role: string;
  constructor(role: string) {
    super(
      role === 'business'
        ? 'Las cuentas de comercio entran por el portal de comercios.'
        : role === 'admin'
          ? 'Las cuentas de administrador entran por la consola web.'
          : 'Las cuentas de domiciliario entran por la app de domiciliarios.',
    );
    this.name = 'WrongRoleError';
    this.role = role;
  }
}

/**
 * Guarda la sesión solo si la cuenta es de cliente. A diferencia de la app,
 * aquí el servidor ya abrió una sesión para la otra cuenta; se cierra de
 * inmediato para no dejar una sesión viva que nadie va a usar.
 */
export async function acceptSession(result: SessionResult): Promise<User> {
  if (result.user.role !== 'client') {
    try {
      // El logout exige Bearer: sin él el servidor responde 401 y la sesión de la otra cuenta quedaría viva.
      await api('/auth/logout', {
        method: 'POST',
        body: { refreshToken: result.refreshToken },
        bearer: result.accessToken,
      });
    } catch {
      // Si falla, la sesión caduca sola a los 7 días; lo importante es no guardarla.
    }
    throw new WrongRoleError(result.user.role);
  }
  setTokens(result.accessToken, result.refreshToken);
  return result.user;
}

export const authApi = {
  checkPhone: (phone: string) => api<{ exists: boolean }>('/auth/phone-status', { method: 'POST', body: { phone } }),

  login: (phone: string, password: string) =>
    api<AuthResponse>('/auth/login', { method: 'POST', body: { phone, password } }),

  mfaChallenge: (challengeToken: string, code: string) =>
    api<AuthResponse>('/auth/2fa/challenge', { method: 'POST', body: { challengeToken, code } }),

  google: (idToken: string, nonce?: string) =>
    api<AuthResponse>('/auth/google', { method: 'POST', body: { idToken, nonce } }),

  registerSendOtp: (phone: string) => api('/auth/register/send-otp', { method: 'POST', body: { phone } }),
  registerVerifyOtp: (phone: string, otpCode: string) =>
    api('/auth/register/verify-otp', { method: 'POST', body: { phone, otpCode } }),
  registerComplete: (data: { phone: string; name: string; password: string }) =>
    api<SessionResult>('/auth/register/complete', { method: 'POST', body: data }),

  sendOtp: (phone: string) => api('/auth/send-otp', { method: 'POST', body: { phone } }),
  resetPassword: (data: { phone: string; otpCode: string; password: string }) =>
    api<AuthResponse>('/auth/reset-password', { method: 'POST', body: data }),

  me: () => api<{ user: User; hasPassword: boolean }>('/auth/me', { auth: true }),
  updateProfile: (data: { name?: string; email?: string; phone?: string; birthDate?: string }) =>
    api<{ user: User; phoneVerificationSent: boolean }>('/auth/profile', { method: 'PATCH', body: data, auth: true }),
  verifyPhone: (otpCode: string) => api<{ user: User }>('/auth/phone/verify', { method: 'POST', body: { otpCode }, auth: true }),
  resendPhoneOtp: () => api('/auth/phone/send-otp', { method: 'POST', auth: true }),

  changePassword: (currentPassword: string, newPassword: string) =>
    api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword }, auth: true, retryOn401: false }),

  sessions: () => api<{ sessions: ActiveSession[] }>('/auth/sessions', { auth: true }),
  revokeSession: (id: string) => api(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true }),
  revokeOthers: () =>
    api<{ revokedCount: number }>('/auth/sessions/revoke-all', {
      method: 'POST',
      body: { currentRefreshToken: getRefreshToken() ?? undefined },
      auth: true,
    }),

  requestDeletionOtp: () => api('/auth/account/delete/request-otp', { method: 'POST', auth: true }),
  deleteAccount: (proof: { password?: string; otpCode?: string }) =>
    api('/auth/account', { method: 'DELETE', body: proof, auth: true, retryOn401: false }),
};

/** Cierra la sesión en el servidor (si se puede) y en el navegador, siempre. */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  try {
    await api('/auth/logout', { method: 'POST', body: { refreshToken: refreshToken ?? undefined }, auth: true });
  } catch {
    // Sin red o token vencido: igual se cierra aquí.
  } finally {
    clearSession();
  }
}
