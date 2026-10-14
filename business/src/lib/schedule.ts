/**
 * Validación de la franja horaria de una promoción o del envío gratis, con las
 * mismas reglas que el servidor: las dos horas o ninguna, y el inicio antes
 * que el fin (una franja que cruza la medianoche no se puede evaluar).
 */
export function scheduleError(value: { validFromTime: string; validUntilTime: string }): string {
  const { validFromTime: from, validUntilTime: until } = value;
  if (!!from !== !!until) return 'Indica la hora de inicio y la de fin, o deja las dos vacías.';
  if (from && until && from >= until) {
    return 'La franja no puede cruzar la medianoche: el inicio debe ser anterior al fin.';
  }
  return '';
}
