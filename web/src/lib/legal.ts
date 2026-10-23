/**
 * Los ocho documentos del Centro legal (`LegalDocument.kind` en el backend).
 * El contenido lo publica administración; aquí solo viven el orden y el
 * título con el que se enlaza cada uno.
 */
export const LEGAL_LINKS = [
  { kind: 'terms', label: 'Términos y condiciones' },
  { kind: 'privacy', label: 'Política de privacidad' },
  { kind: 'habeas_data', label: 'Tratamiento de datos personales' },
  { kind: 'payments', label: 'Pagos y reembolsos' },
  { kind: 'cancellations', label: 'Cancelaciones' },
  { kind: 'delivery', label: 'Entregas' },
  { kind: 'promotions', label: 'Promociones' },
  { kind: 'provider', label: 'Condiciones para comercios' },
] as const;

export const legalTitle = (kind: string): string =>
  LEGAL_LINKS.find((l) => l.kind === kind)?.label ?? 'Documento legal';
