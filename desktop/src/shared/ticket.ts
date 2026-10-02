/**
 * El comprobante que el panel manda a imprimir en silencio.
 *
 * Se valida aquí, no en `printing.ts`, porque el remitente es el renderer
 * (sandboxeado, pero blanco de un XSS) y lo que llega a `webContents.print`
 * nunca debe ser "lo que el panel mandó" sin comprobar — una plantilla de
 * impresión mal formada no debe poder colgar el proceso principal ni
 * imprimir basura sin fin.
 */

export const PAPER_WIDTHS_MM = [58, 80] as const;
export type PaperWidthMm = (typeof PAPER_WIDTHS_MM)[number];

export interface TicketItem {
  name: string;
  quantity: number;
  /** En COP, entero — igual que todo el dinero en ZIPP. */
  price: number;
}

export interface Ticket {
  orderNumber: string;
  businessName: string;
  items: TicketItem[];
  total: number;
  paperWidthMm: PaperWidthMm;
  notes?: string;
}

export type TicketError = string;

const MAX_ITEMS = 100;
const MAX_TEXT = 200;

function isMoney(value: unknown): value is number {
  // Entero no negativo: nada de centavos ni de floats, igual que
  // `backend/src/utils/money.ts`.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Lista de problemas, vacía si el comprobante es válido para imprimir. */
export function validateTicket(ticket: unknown): TicketError[] {
  const errors: TicketError[] = [];
  if (typeof ticket !== 'object' || ticket === null || Array.isArray(ticket)) {
    return ['El comprobante no es un objeto'];
  }
  const t = ticket as Record<string, unknown>;

  if (typeof t.orderNumber !== 'string' || !t.orderNumber || t.orderNumber.length > 20) {
    errors.push('orderNumber inválido');
  }
  if (typeof t.businessName !== 'string' || !t.businessName || t.businessName.length > MAX_TEXT) {
    errors.push('businessName inválido');
  }
  if (!PAPER_WIDTHS_MM.includes(t.paperWidthMm as PaperWidthMm)) {
    errors.push('paperWidthMm debe ser 58 o 80');
  }
  if (!isMoney(t.total)) {
    errors.push('total inválido');
  }
  if (t.notes !== undefined && (typeof t.notes !== 'string' || t.notes.length > 500)) {
    errors.push('notes inválido');
  }

  if (!Array.isArray(t.items) || t.items.length === 0) {
    errors.push('items vacío');
  } else if (t.items.length > MAX_ITEMS) {
    errors.push(`items tiene más de ${MAX_ITEMS} líneas`);
  } else {
    t.items.forEach((item, index) => {
      if (typeof item !== 'object' || item === null) {
        errors.push(`items[${index}] no es un objeto`);
        return;
      }
      const i = item as Record<string, unknown>;
      if (typeof i.name !== 'string' || !i.name || i.name.length > MAX_TEXT) {
        errors.push(`items[${index}].name inválido`);
      }
      if (typeof i.quantity !== 'number' || !Number.isInteger(i.quantity) || i.quantity <= 0 || i.quantity > 999) {
        errors.push(`items[${index}].quantity inválido`);
      }
      if (!isMoney(i.price)) {
        errors.push(`items[${index}].price inválido`);
      }
    });
  }

  return errors;
}

export function isValidTicket(ticket: unknown): ticket is Ticket {
  return validateTicket(ticket).length === 0;
}
