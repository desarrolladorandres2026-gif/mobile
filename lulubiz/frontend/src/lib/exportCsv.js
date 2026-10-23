import { saveBlob } from './download.js';

/** Exportación de una tabla a un archivo que abre Excel: CSV con punto y coma, comillas y BOM UTF-8. */

const cell = (text) => {
  // Una celda que empieza por = + - @ se leería como fórmula: se antepone un apóstrofo, salvo que sea una cifra.
  const t = text.replace(/\s+/g, ' ').trim();
  const safe = /^[=+@]/.test(t) || (/^-/.test(t) && !/^-[\d.,\s]+$/.test(t)) ? `'${t}` : t;
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Convierte una tabla del documento en texto CSV. Lo que ve el usuario es lo que se exporta. */
export function tableToCsv(table) {
  return [...table.querySelectorAll('tr')]
    .filter((tr) => !tr.querySelector('[colspan]') || tr.cells.length > 1)
    .map((tr) => [...tr.cells].map((c) => cell(c.innerText ?? c.textContent ?? '')).join(';'))
    .join('\r\n');
}

/** Descarga el texto como archivo. Devuelve el nombre usado. */
export function downloadCsv(name, csv) {
  const file = `${name.replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
  saveBlob(file, new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  return file;
}
