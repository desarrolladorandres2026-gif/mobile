/**
 * Generación de CSV para los informes del panel.
 *
 * No se usa una librería porque el problema real aquí no es el formato,
 * son dos detalles que casi todas resuelven mal para el destino que tiene
 * este archivo: Excel en español.
 */

export interface CsvColumn<T> {
  /** Cabecera tal cual la verá quien abra el archivo. */
  header: string;
  /** Cómo se saca el valor de cada fila. */
  value: (row: T) => unknown;
}

/**
 * Escapa un valor para una celda.
 *
 * Las comillas se duplican y todo va entrecomillado. Es más verboso que
 * entrecomillar solo lo necesario, pero un nombre de negocio con una coma
 * —"Donde Pepe, el de la esquina"— parte la fila en dos si se descuida, y
 * quien abre el archivo no ve un error: ve datos desplazados una columna.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '""';

  if (value instanceof Date) return `"${value.toISOString()}"`;

  const text = String(value);

  // ── Inyección de fórmulas ──
  //
  // Excel ejecuta lo que empieza por =, +, - o @. Un nombre de usuario
  // guardado como `=HYPERLINK(...)` se convierte en código en la máquina de
  // quien abre el informe, y el dato lo escribió un desconocido al
  // registrarse. El apóstrofo lo neutraliza sin perder el contenido.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Convierte filas en un CSV listo para descargar.
 *
 * Separa por punto y coma y no por coma: en configuración regional
 * española y colombiana, Excel espera el punto y coma y el separador
 * decimal es la coma. Con comas, el archivo se abre con todo apelotonado
 * en la primera columna y parece que la exportación está rota.
 */
export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const header = columns.map((c) => cell(c.header)).join(';');
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(';'));

  // El BOM va delante para que Excel reconozca UTF-8. Sin él, cada tilde y
  // cada eñe del informe salen como símbolos rotos.
  return '﻿' + [header, ...body].join('\r\n');
}

/** Nombre de archivo con fecha, para que las descargas no se pisen. */
export function csvFilename(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${prefix}-${stamp}.csv`;
}
