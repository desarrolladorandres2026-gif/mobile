import { BrowserWindow } from 'electron';
import { validateTicket, type Ticket } from '../shared/ticket';
import log from 'electron-log';
import { getSetting } from './store';

/**
 * Imprime la comanda en silencio, sin diálogo, en la impresora elegida en
 * "Este equipo". El HTML es una plantilla local fija — nunca el HTML del
 * panel — así que no hay manera de que algo que llegó del renderer acabe
 * siendo interpretado como marcado: los datos entran como texto escapado.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(value: number): string {
  return `$${value.toLocaleString('es-CO')}`;
}

function renderTicketHtml(ticket: Ticket): string {
  const rows = ticket.items
    .map(
      (item) => `<tr>
        <td>${item.quantity}×</td>
        <td>${escapeHtml(item.name)}</td>
        <td class="right">${money(item.price * item.quantity)}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 2mm; size: ${ticket.paperWidthMm}mm auto; }
  body { font-family: 'Courier New', monospace; font-size: 11px; width: ${ticket.paperWidthMm}mm; margin: 0; }
  h1 { font-size: 13px; text-align: center; margin: 0 0 4px; }
  .order { text-align: center; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .right { text-align: right; }
  .total { border-top: 1px dashed #000; margin-top: 4px; padding-top: 4px; font-weight: bold; }
  .notes { margin-top: 6px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>${escapeHtml(ticket.businessName)}</h1>
  <div class="order">Pedido #${escapeHtml(ticket.orderNumber)}</div>
  <table>${rows}</table>
  <table class="total"><tr><td>Total</td><td class="right">${money(ticket.total)}</td></tr></table>
  ${ticket.notes ? `<div class="notes">${escapeHtml(ticket.notes)}</div>` : ''}
</body>
</html>`;
}

export interface PrintResult {
  ok: boolean;
  error?: string;
}

export async function printTicket(rawTicket: unknown): Promise<PrintResult> {
  const errors = validateTicket(rawTicket);
  if (errors.length > 0) {
    log.warn('[printing] comanda rechazada', errors);
    return { ok: false, error: errors.join('; ') };
  }
  const ticket = rawTicket as Ticket;

  const printerName = getSetting<string>('printerName', '');
  if (!printerName) {
    return { ok: false, error: 'No hay una impresora configurada en "Este equipo".' };
  }

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderTicketHtml(ticket))}`);
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ silent: true, deviceName: printerName, printBackground: false }, (success, failureReason) => {
        if (success) resolve();
        else reject(new Error(failureReason || 'La impresora no respondió'));
      });
    });
    return { ok: true };
  } catch (err) {
    log.error('[printing] fallo al imprimir', err);
    return { ok: false, error: err instanceof Error ? err.message : 'Fallo al imprimir' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
