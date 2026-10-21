export const MAX_CSV_BYTES = 2_000_000;
export const MAX_CSV_ROWS = 2000;

export class CsvError extends Error {}

/** Elige el separador (coma, punto y coma o tabulador) mirando la primera línea, fuera de comillas. */
function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let quoted = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Lee un CSV (comillas con "" para una comilla, saltos de línea dentro de comillas, BOM, separador detectado) y
 * devuelve `{ header, rows }` con los textos tal cual, sin interpretar. Las líneas vacías se omiten.
 */
export function parseCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  if (text.length > MAX_CSV_BYTES) throw new CsvError('El archivo es demasiado grande: máximo 2 MB.');
  if (!text.trim()) throw new CsvError('El archivo está vacío.');
  const delimiter = detectDelimiter(text);
  const records = [];
  let field = '';
  let row = [];
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] !== '\n') endRow();
    } else field += ch;
  }
  if (quoted) throw new CsvError('Hay una comilla sin cerrar: revisa el archivo.');
  if (field !== '' || row.length) endRow();
  const [header, ...rows] = records;
  if (!header) throw new CsvError('El archivo no tiene encabezado.');
  if (rows.length === 0) throw new CsvError('El archivo solo tiene el encabezado: faltan filas.');
  if (rows.length > MAX_CSV_ROWS) throw new CsvError(`El archivo tiene ${rows.length} filas: importa máximo ${MAX_CSV_ROWS} por vez.`);
  return { header: header.map((h) => h.trim()), rows: rows.map((r) => r.map((c) => c.trim())) };
}

/** Nombre de columna sin tildes, en minúsculas y con guiones bajos: «Cuenta de inventario» → cuenta_de_inventario. */
export const normalizeHeader = (name) =>
  String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Convierte las filas en objetos por nombre canónico. `columns` es `{ canónico: [alias, ...] }`.
 * Devuelve también las columnas que no se reconocen y las obligatorias que faltan, para avisar antes de leer nada.
 */
export function mapColumns(header, rows, columns, required = []) {
  const byAlias = new Map();
  for (const [canonical, aliases] of Object.entries(columns)) for (const alias of [canonical, ...aliases]) byAlias.set(normalizeHeader(alias), canonical);
  const indexOf = {};
  const unknown = [];
  header.forEach((h, i) => {
    const canonical = byAlias.get(normalizeHeader(h));
    if (!canonical) unknown.push(h);
    else if (!(canonical in indexOf)) indexOf[canonical] = i;
  });
  const missing = required.filter((c) => !(c in indexOf));
  const objects = rows.map((cells, n) => ({
    line: n + 2,
    values: Object.fromEntries(Object.entries(indexOf).map(([canonical, i]) => [canonical, cells[i] ?? ''])),
  }));
  return { objects, unknown, missing };
}
