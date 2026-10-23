/** Celular colombiano de 10 dígitos que empieza por 3. */
export function isValidPhone(value: string): boolean {
  return /^3\d{9}$/.test(value);
}
