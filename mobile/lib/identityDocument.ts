import type { DocumentType } from '../stores/authStore';

/** En el orden en que se ofrecen: la cédula primero, es la de casi todos. */
export const DOCUMENT_TYPES: { value: DocumentType; label: string; short: string }[] = [
  { value: 'CC', label: 'Cédula de ciudadanía', short: 'CC' },
  { value: 'CE', label: 'Cédula de extranjería', short: 'CE' },
  // Permiso por Protección Temporal: el documento de la mayoría de los
  // migrantes venezolanos en Colombia.
  { value: 'PPT', label: 'Permiso por Protección Temporal', short: 'PPT' },
  { value: 'PASAPORTE', label: 'Pasaporte', short: 'Pasaporte' },
];

/** Lo que se muestra en la fila: `CC 1.020.304.050`, `Pasaporte AB123456`. */
export function formatDocument(type: DocumentType | undefined, number: string | undefined): string {
  if (!type || !number) return '';
  const short = DOCUMENT_TYPES.find((t) => t.value === type)?.short ?? type;
  const pretty = /^\d+$/.test(number) ? Number(number).toLocaleString('es-CO') : number;
  return `${short} ${pretty}`;
}

/**
 * Quita lo que la gente escribe de más (puntos, espacios, guiones) antes de
 * validar y enviar. El pasaporte conserva letras, en mayúscula.
 */
export function normalizeDocumentNumber(type: DocumentType, raw: string): string {
  const compact = raw.replace(/[\s.\-]/g, '');
  return type === 'PASAPORTE' ? compact.toUpperCase() : compact.replace(/\D/g, '');
}

/**
 * Mensaje de error para un número de documento ya normalizado, o `null` si
 * es válido.
 *
 * TODO(usuario): implementar una regla por tipo. El servidor aplica estas
 * mismas (ver `documentNumberRules` en backend/src/validators/auth.validator.ts),
 * así que aquí se trata de avisar antes de enviar, con un mensaje claro:
 * - CC: 5 a 10 dígitos.
 * - CE: 6 a 10 dígitos.
 * - PPT: 6 a 10 dígitos.
 * - PASAPORTE: 5 a 15 letras o números.
 *
 * Una idea: un `Record<DocumentType, { pattern: RegExp; message: string }>`
 * y una sola línea que lo consulte. Mientras devuelva `null` siempre, el
 * servidor sigue rechazando lo inválido con su propio mensaje.
 */
export function validateDocumentNumber(type: DocumentType, number: string): string | null {
  void type;
  void number;
  return null;
}
