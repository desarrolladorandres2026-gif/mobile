import { saveBlob } from './download.js';
import { buildWorkbook } from './xlsx/workbook.js';

/**
 * «Exportar a Excel»: lo que el usuario ve es lo que se exporta. Se lee la tabla del documento y se arma un libro
 * con formato profesional (ver `xlsx/workbook.js`). `DataTable` marca la tabla para que aquí no haya que adivinar:
 * - `th[data-xl-type]`: amount | integer | date | percent | text. Sin marca, una columna a la derecha es de importes.
 * - `th[data-xl-skip]`: columna que no se exporta (acciones, botones).
 * - `tr[data-xl-kind]`: group | total; `tr[data-xl-depth]`: nivel en la jerarquía.
 */

const cellText = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Tabla del documento → `{ columns, rows }` para el libro. */
export function readTable(table) {
  const head = table.querySelector('thead tr');
  const ths = head ? [...head.cells] : [];
  const keep = ths.map((th) => !th.hasAttribute('data-xl-skip'));
  const columns = ths
    .filter((_, i) => keep[i])
    .map((th) => ({ title: cellText(th), type: th.dataset.xlType || (th.classList.contains('text-right') ? 'amount' : 'text') }));
  const rows = [...table.querySelectorAll('tbody tr, tfoot tr')]
    // Fuera: «No hay registros» y los detalles desplegados (una sola celda que ocupa toda la fila).
    .filter((tr) => !tr.querySelector('[colspan]') || tr.cells.length > 1)
    .map((tr) => {
      const cells = [...tr.cells].filter((_, i) => keep[i] ?? true).map(cellText);
      const kind = tr.dataset.xlKind || (tr.closest('tfoot') || /^total(es)?\b/i.test(cells[0] ?? '') ? 'total' : 'body');
      return { kind, depth: Number(tr.dataset.xlDepth) || 0, cells };
    });
  return { columns: columns.length ? columns : (rows[0]?.cells ?? []).map(() => ({ title: '', type: 'text' })), rows };
}

const pad = (n) => String(n).padStart(2, '0');
const slug = (s) => String(s).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');

/**
 * Descarga la tabla como libro de Excel. Devuelve el nombre usado.
 * `meta`: { title, company: { name, taxIdLabel }, info: { period, filters }, user, currency }
 */
export function downloadXlsx(table, meta) {
  const now = new Date();
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const file = `${[meta.company?.name, meta.title].filter(Boolean).map(slug).join('-') || 'Lulubiz'}-${day}.xlsx`;
  saveBlob(file, buildWorkbook({ ...meta, ...readTable(table), now }));
  return file;
}
