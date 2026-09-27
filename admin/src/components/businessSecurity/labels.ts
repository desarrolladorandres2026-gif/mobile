import type { BusinessRole, EventFilters, SessionFilters, SessionStatus } from './types';

/** Mismos nombres que el CSV del backend (`adminBusinessSecurity.controller.ts`). */
export const EVENT_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: 'Acceso exitoso',
  LOGIN_FAILED: 'Acceso fallido',
  LOGOUT: 'Cierre de sesión',
  NEW_DEVICE: 'Nuevo dispositivo',
  NEW_IP: 'Nueva IP',
  TWO_FACTOR_SUCCESS: 'Verificación en dos pasos correcta',
  TWO_FACTOR_FAILED: 'Verificación en dos pasos fallida',
  SESSION_REVOKED: 'Sesión cerrada por el sistema',
  REMOTE_LOGOUT: 'Cierre remoto por la cuenta',
  PASSWORD_CHANGED: 'Cambio de contraseña',
  SECURITY_SETTINGS_CHANGED: 'Cambio de ajustes de seguridad',
  ADMIN_SESSION_REVOCATION: 'Revocación por administrador',
};

export const EVENT_TYPES = Object.keys(EVENT_LABELS);

/** Códigos de `reason` en sesiones y eventos. */
export const REASON_LABELS: Record<string, string> = {
  logout: 'Cerró sesión',
  user_revoked: 'La cerró la propia cuenta',
  revoke_all: 'La cuenta cerró sus otras sesiones',
  password_changed: 'Cambio de contraseña',
  contact_changed: 'Cambio de contacto por un admin',
  admin: 'Un administrador',
  role_changed: 'Cambio de rol',
  reuse_detected: 'Reuso de token: posible robo de sesión',
  session_limit: 'Tope de sesiones abiertas',
  device_removed: 'Dispositivo eliminado',
  account_deleted: 'Cuenta eliminada',
  migration: 'Migración',
  bad_password: 'Contraseña incorrecta',
  locked: 'Bloqueo por intentos',
  two_factor_enabled: 'Activó la verificación en dos pasos',
  two_factor_disabled: 'Desactivó la verificación en dos pasos',
  two_factor_reset_by_admin: 'Un admin restableció su 2FA',
  admin_reset: 'Contraseña temporal puesta por un admin',
  account_blocked: 'Cuenta bloqueada',
  account_deactivated: 'Cuenta desactivada',
};

export const ROLE_LABELS: Record<BusinessRole, string> = {
  owner: 'Dueño',
  manager: 'Encargado',
  staff: 'Mostrador',
};

export const STATUS_STYLES: Record<SessionStatus, { label: string; text: string }> = {
  active: { label: 'Activa', text: 'text-[var(--color-success)]' },
  revoked: { label: 'Revocada', text: 'text-[var(--color-text-secondary)]' },
  expired: { label: 'Expirada', text: 'text-[var(--color-warning)]' },
};

export const METHOD_LABELS: Record<string, string> = {
  password: 'Contraseña',
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
  otp: 'Código por WhatsApp',
  email_otp: 'Código por correo',
  password_reset: 'Restablecimiento',
};

const known = (value?: string | null) => (value && value !== 'unknown' ? value : null);

/** "Chrome 128 · Windows 10/11" — o lo que se sepa. */
export function deviceLabel(d: { browser?: string; browserVersion?: string | null; os?: string; osVersion?: string | null } | null | undefined) {
  if (!d) return 'Dispositivo desconocido';
  const browser = known(d.browser) ? [d.browser, d.browserVersion].filter(Boolean).join(' ') : 'Navegador desconocido';
  const os = known(d.os) ? [d.os, d.osVersion].filter(Boolean).join(' ') : null;
  return os ? `${browser} · ${os}` : browser;
}

export const PLATFORM_LABELS: Record<string, string> = {
  desktop: 'Computador',
  mobile: 'Celular',
  tablet: 'Tableta',
  unknown: 'Tipo desconocido',
};

export const filterInput =
  'h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';
export const filterLabel = 'text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]';
export const linkButton = 'cursor-pointer text-xs font-bold text-[var(--color-primary)] hover:underline disabled:opacity-60';
export const dangerLink = 'cursor-pointer text-xs font-bold text-[var(--color-danger)] hover:underline disabled:opacity-60';

export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export const EMPTY_SESSION_FILTERS: SessionFilters = { status: 'active', userId: '', search: '', ip: '', from: '', to: '', unidentified: false };
export const EMPTY_EVENT_FILTERS: EventFilters = { type: '', userId: '', ip: '', from: '', to: '' };

/** Atajo "solo fallos" del historial. */
export const FAILURE_TYPES = 'LOGIN_FAILED,TWO_FACTOR_FAILED,SESSION_REVOKED';
