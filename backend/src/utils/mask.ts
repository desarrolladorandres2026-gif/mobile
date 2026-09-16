/**
 * Datos personales para logs y auditoría, recortados.
 *
 * La bitácora de auditoría guardaba teléfonos y correos completos en la
 * descripción de cada evento de acceso ("Login fallido para 3101234567").
 * Es un almacén de trazabilidad operativa, no de datos personales: quien la
 * lea (soporte, un backup, una integración futura) no necesita el número
 * entero para seguir un incidente, porque el evento ya lleva el `entityId`.
 */

/** `3101234567` → `***4567` */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length <= 4 ? '***' : `***${digits.slice(-4)}`;
}

/** `camila.andrade@teste.zipp.co` → `c***@t***.co` */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return '—';
  const [local, domain] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}
