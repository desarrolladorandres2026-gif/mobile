/**
 * No usamos el tokenizer real de Claude (no es público para uso local).
 * chars/4 es la aproximación estándar para código/texto en inglés y español
 * mixto con identificadores; sobreestima ligeramente JSON/minificado y
 * subestima prosa muy repetitiva, pero el error relativo entre archivos
 * (que es lo que importa para priorizar) se mantiene estable.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateTokensForSize(byteSize: number): number {
  return Math.ceil(byteSize / 4);
}
