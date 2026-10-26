import { zipStore } from './zip.js';

/**
 * Libro de Excel (.xlsx) de un informe, armado a mano y sin dependencias. Funciones puras: reciben el modelo
 * `{ columns, rows }` (lo arma `readTable` desde la tabla en pantalla) y devuelven las partes del archivo.
 *
 * Hoja 1: razón social, título, NIT y filtros; debajo una Tabla nativa de Excel con estilo «Lulubiz», cifras como
 * números, fechas como fechas, jerarquía plegable y fila de total con SUBTOTAL cuando cuadra con lo mostrado.
 * Hoja 2: información del archivo (quién, cuándo, con qué filtros, qué totales son fórmula).
 */

const AZUL = '1B4F9C';
const TINTA = '1A2230';
const HEAD_ROW = 5; // filas 1-3: encabezado de empresa; 4: aire; 5: cabecera de la tabla
const INFO_SHEET = 'Información';

// ── Lectura de valores ──────────────────────────────────────────────────────────────────────────────────────────
const NUMERO = /^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;

/** «1.190.000,50» → { value: 1190000.5, decimals: 2 }. Si no es una cifra, null. */
export function parseCifra(text) {
  const t = text.replace(/[\s$]/g, '');
  if (!NUMERO.test(t)) return null;
  const [entera, decimales = ''] = t.replace(/\./g, '').split(',');
  return { value: Number(`${entera}${decimales ? `.${decimales}` : ''}`), decimals: decimales.length };
}

/** «31/03/2026» → número de serie de Excel. Si no es una fecha válida, null. */
export function parseFecha(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;
  return ms / 86400000 + 25569;
}

/** «19 %» → 0.19. Si no es un porcentaje, null. */
export function parsePorcentaje(text) {
  const m = /^(-?\d+(?:,\d+)?)\s?%$/.exec(text.replace(/\u00a0/g, ' ').trim());
  return m ? Number(m[1].replace(',', '.')) / 100 : null;
}

/** Instante local como número de serie de Excel (Excel no guarda zona horaria). */
const serialOf = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()) / 86400000 + 25569;

const pad = (n) => String(n).padStart(2, '0');
const dayText = (date) => `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
const timeText = (date) => `${dayText(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

// ── XML ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const colName = (i) => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const strCell = (ref, text, s) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
const numCell = (ref, value, s) => `<c r="${ref}" s="${s}"><v>${value}</v></c>`;

// ── Estilos ─────────────────────────────────────────────────────────────────────────────────────────────────────
const FONT = { normal: 0, header: 1, company: 2, title: 3, muted: 4, bold: 5, note: 6 };
const FILL = { none: 0, azul: 2, total: 3, label: 4 };
const BORDER = { none: 0, row: 1, total: 2 };
const NUMFMT = { amount2: 164, amount0: 165, date: 166, percent: 167, datetime: 168 };

const STYLES_HEAD = `${XML}<styleSheet xmlns="${NS_MAIN}">
<numFmts count="5">
<numFmt numFmtId="164" formatCode="#,##0.00_);[Red](#,##0.00);&quot;–&quot;_)"/>
<numFmt numFmtId="165" formatCode="#,##0_);[Red](#,##0);&quot;–&quot;_)"/>
<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="167" formatCode="0.00%"/>
<numFmt numFmtId="168" formatCode="dd/mm/yyyy hh:mm"/>
</numFmts>
<fonts count="7">
<font><sz val="11"/><color rgb="FF${TINTA}"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF${AZUL}"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="12"/><color rgb="FF${TINTA}"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="9"/><color rgb="FF4B5563"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF${TINTA}"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="9"/><color rgb="FF4B5563"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${AZUL}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEAF0F9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F6FB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D5DD"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF${AZUL}"/></top><bottom style="double"><color rgb="FF${AZUL}"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
`;

// Estilo de Tabla propio: cabecera azul, bandas suaves y fila de total con doble raya, como un estado financiero.
const STYLES_TAIL = `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="4">
<dxf><font><b/><color rgb="FFFFFFFF"/></font><fill><patternFill patternType="solid"><fgColor rgb="FF${AZUL}"/><bgColor rgb="FF${AZUL}"/></patternFill></fill></dxf>
<dxf><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6FB"/><bgColor rgb="FFF3F6FB"/></patternFill></fill></dxf>
<dxf><font><b/></font><fill><patternFill patternType="solid"><fgColor rgb="FFEAF0F9"/><bgColor rgb="FFEAF0F9"/></patternFill></fill><border><top style="thin"><color rgb="FF${AZUL}"/></top><bottom style="double"><color rgb="FF${AZUL}"/></bottom></border></dxf>
<dxf><border><bottom style="thin"><color rgb="FF${AZUL}"/></bottom><horizontal style="thin"><color rgb="FFD0D5DD"/></horizontal></border></dxf>
</dxfs>
<tableStyles count="1" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16">
<tableStyle name="Lulubiz" pivot="0" count="4">
<tableStyleElement type="wholeTable" dxfId="3"/>
<tableStyleElement type="headerRow" dxfId="0"/>
<tableStyleElement type="totalRow" dxfId="2"/>
<tableStyleElement type="firstRowStripe" dxfId="1"/>
</tableStyle>
</tableStyles>
</styleSheet>`;

/** Registro de formatos de celda: cada combinación distinta es un `xf` y se reutiliza por índice. */
function createStyles() {
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const index = new Map();
  const get = ({ font = 0, fill = 0, border = 0, numFmt = 0, h = null, v = null, wrap = false, indent = 0 }) => {
    const key = [font, fill, border, numFmt, h, v, wrap, indent].join('|');
    if (!index.has(key)) {
      const horizontal = indent ? h ?? 'left' : h;
      const align =
        horizontal || v || wrap || indent
          ? `<alignment${horizontal ? ` horizontal="${horizontal}"` : ''}${v ? ` vertical="${v}"` : ''}${wrap ? ' wrapText="1"' : ''}${indent ? ` indent="${indent}"` : ''}/>`
          : '';
      const flags = `${numFmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}`;
      xfs.push(`<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${flags}${align ? ` applyAlignment="1">${align}</xf>` : '/>'}`);
      index.set(key, xfs.length - 1);
    }
    return index.get(key);
  };
  return { get, xml: () => `${STYLES_HEAD}<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>\n${STYLES_TAIL}` };
}

// ── Nombres ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Excel exige cabeceras de Tabla únicas (sin distinguir mayúsculas) y no vacías. */
export function uniqueHeaders(titles) {
  const seen = new Set();
  return titles.map((raw, i) => {
    const base = String(raw ?? '').replace(/\s+/g, ' ').trim() || `Columna ${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/** Nombre de Tabla válido: letras, cifras y guion bajo; empieza por «T_» para no parecer una celda. */
export const tableName = (title) =>
  `T_${String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Datos'}`;

/** Nombre de hoja: máximo 31 caracteres, sin \ / ? * [ ] : ni apóstrofo en los extremos. */
export const sheetName = (title) => {
  const name = String(title).replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31).trim();
  return !name || name.toLowerCase() === INFO_SHEET.toLowerCase() ? 'Datos' : name;
};

const quoteSheet = (name) => `'${name.replace(/'/g, "''")}'`;

/** Texto para encabezado o pie de página: «&» es código de Excel ahí, se duplica; y hay límite de largo. */
const hfText = (s, max = 60) => esc(String(s).slice(0, max).replace(/&/g, '&&'));

// ── Modelo → celdas ─────────────────────────────────────────────────────────────────────────────────────────────
const NUMERIC = new Set(['amount', 'integer', 'percent']);

/** Valor tipado de una celda según el tipo de su columna. `null` si va vacía. */
function typedValue(text, type, decimals) {
  if (!text) return null;
  if (type === 'amount' || type === 'integer') {
    const n = parseCifra(text);
    if (n) return { number: n.value, numFmt: type === 'integer' || !decimals ? NUMFMT.amount0 : NUMFMT.amount2 };
    return { text, h: 'right' };
  }
  if (type === 'percent') {
    const p = parsePorcentaje(text);
    return p === null ? { text, h: 'right' } : { number: p, numFmt: NUMFMT.percent };
  }
  // Fechas: por tipo declarado o, de respaldo, cualquier texto que sea exactamente dd/mm/aaaa.
  const d = parseFecha(text);
  if (d !== null) return { number: d, numFmt: NUMFMT.date, h: 'left' };
  return { text };
}

/**
 * Decide qué totales llevan fórmula: solo si la suma de las filas de su bloque es igual a lo que mostró la
 * pantalla. Con jerarquía o saldos acumulados no cuadra y queda el valor copiado, para no contradecir el informe.
 */
function planTotals(columns, rows) {
  const plans = new Map(); // índice de fila de total → Map(columna → { start, end })
  let blockStart = 0;
  rows.forEach((row, i) => {
    if (row.kind !== 'total') return;
    const formulas = new Map();
    if (i > blockStart) {
      columns.forEach((col, k) => {
        if (col.type !== 'amount' && col.type !== 'integer') return;
        const shown = parseCifra(row.cells[k] ?? '');
        if (!shown) return;
        let sum = 0;
        for (let j = blockStart; j < i; j += 1) sum += parseCifra(rows[j].cells[k] ?? '')?.value ?? 0;
        if (Math.round(sum * 100) === Math.round(shown.value * 100)) formulas.set(k, { start: blockStart, end: i - 1 });
      });
    }
    plans.set(i, formulas);
    blockStart = i + 1;
  });
  return plans;
}

// ── Partes del libro ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Partes del .xlsx como `[ruta, xml]`.
 * `columns`: [{ title, type: 'text'|'amount'|'integer'|'date'|'percent' }]
 * `rows`: [{ kind: 'body'|'group'|'total', depth, cells: [texto] }]
 * `company`: { name, taxIdLabel }; `info`: { period, filters: [[etiqueta, valor]] }
 */
export function workbookEntries({ title, company = {}, info = {}, columns, rows, user = null, currency = null, now = new Date() }) {
  const styles = createStyles();
  const width = Math.max(1, columns.length);
  const lastCol = colName(width - 1);
  const headers = uniqueHeaders(columns.map((c) => c.title));
  const companyName = company.name || 'Empresa';
  const reportName = String(title || 'Informe');
  const filters = (info.filters ?? []).filter(([label, value]) => label && value !== undefined && value !== null && String(value) !== '');

  // Una columna de importes va con decimales si alguna de sus cifras los trae.
  const decimals = columns.map((c, k) => rows.some((r) => (parseCifra(r.cells[k] ?? '')?.decimals ?? 0) > 0));

  const totals = rows.map((r, i) => (r.kind === 'total' ? i : -1)).filter((i) => i >= 0);
  const dataRows = rows.filter((r) => r.kind !== 'total').length;
  // Tabla nativa solo si hay datos y, como mucho, un total al final (Excel admite una sola fila de totales).
  const asTable = dataRows > 0 && (totals.length === 0 || (totals.length === 1 && totals[0] === rows.length - 1));
  const hasTotalRow = asTable && totals.length === 1;
  const totalPlans = planTotals(columns, rows);
  const firstData = HEAD_ROW + 1;
  const lastRow = HEAD_ROW + rows.length;
  const rowNumber = (i) => firstData + i;

  // ── Hoja 1 ──
  const sheetRows = [];
  sheetRows.push(`<row r="1" ht="26" customHeight="1">${strCell('A1', companyName, styles.get({ font: FONT.company, v: 'center' }))}</row>`);
  sheetRows.push(`<row r="2" ht="18" customHeight="1">${strCell('A2', reportName, styles.get({ font: FONT.title }))}</row>`);
  const subtitle = [
    company.taxIdLabel,
    info.period ? `Período ${info.period}` : null,
    ...filters.map(([label, value]) => `${label}: ${value}`),
    currency ? `Moneda ${currency}` : null,
  ].filter(Boolean);
  sheetRows.push(`<row r="3">${strCell('A3', subtitle.length ? subtitle.join('  ·  ') : `Generado el ${dayText(now)}`, styles.get({ font: FONT.muted }))}</row>`);

  const headerCells = headers.map((name, k) =>
    strCell(`${colName(k)}${HEAD_ROW}`, name, styles.get({ font: FONT.header, fill: FILL.azul, h: NUMERIC.has(columns[k]?.type) ? 'right' : 'left', v: 'center', wrap: true })),
  );
  sheetRows.push(`<row r="${HEAD_ROW}" ht="30" customHeight="1">${headerCells.join('')}</row>`);

  const longest = headers.map((h) => Math.min(40, h.length));
  let maxLevel = 0;
  const formulaCols = new Set();
  const fixedCols = new Set();
  rows.forEach((row, i) => {
    const r = rowNumber(i);
    const total = row.kind === 'total';
    const group = row.kind === 'group';
    const depth = Math.max(0, Math.min(15, Number(row.depth) || 0));
    const level = Math.min(7, depth);
    maxLevel = Math.max(maxLevel, level);
    const plan = totalPlans.get(i);
    const cells = [];
    columns.forEach((col, k) => {
      const ref = `${colName(k)}${r}`;
      const text = String(row.cells[k] ?? '').trim();
      longest[k] = Math.max(longest[k], Math.min(60, text.length + (k === 0 ? depth * 2 : 0)));
      const base = total
        ? { font: FONT.bold, fill: FILL.total, border: BORDER.total, v: 'top' }
        : { font: group ? FONT.bold : FONT.normal, border: BORDER.row, v: 'top' };
      const formula = plan?.get(k);
      const value = typedValue(text, col.type, decimals[k]);
      if (formula) {
        const range = `${colName(k)}${rowNumber(formula.start)}:${colName(k)}${rowNumber(formula.end)}`;
        cells.push(`<c r="${ref}" s="${styles.get({ ...base, numFmt: value.numFmt, h: 'right' })}"><f>SUBTOTAL(109,${range})</f><v>${value.number}</v></c>`);
        formulaCols.add(headers[k]);
        return;
      }
      if (!value) return;
      if (total && value.number !== undefined && NUMERIC.has(col.type)) fixedCols.add(headers[k]);
      if (value.number !== undefined) {
        cells.push(numCell(ref, value.number, styles.get({ ...base, numFmt: value.numFmt, h: value.h ?? 'right' })));
      } else {
        const indent = k === 0 && depth ? depth : 0;
        cells.push(strCell(ref, value.text, styles.get({ ...base, h: value.h ?? null, wrap: text.length > 60, indent })));
      }
    });
    sheetRows.push(`<row r="${r}"${level ? ` outlineLevel="${level}"` : ''}>${cells.join('')}</row>`);
  });

  const cols = longest
    .map((len, k) => `<col min="${k + 1}" max="${k + 1}" width="${Math.min(60, Math.max(11, Math.ceil(len * 1.1) + 3))}" customWidth="1"/>`)
    .join('');
  const generatedLabel = `Generado el ${timeText(now)}`;
  const sheet1 = `${XML}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">\
<sheetPr><tabColor rgb="FF${AZUL}"/><outlinePr summaryBelow="0"/><pageSetUpPr fitToPage="1"/></sheetPr>\
<dimension ref="A1:${lastCol}${Math.max(lastRow, HEAD_ROW)}"/>\
<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"><pane ySplit="${HEAD_ROW}" topLeftCell="A${firstData}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${firstData}" sqref="A${firstData}"/></sheetView></sheetViews>\
<sheetFormatPr defaultRowHeight="15"${maxLevel ? ` outlineLevelRow="${maxLevel}"` : ''}/>\
<cols>${cols}</cols>\
<sheetData>${sheetRows.join('')}</sheetData>\
${!asTable && rows.length ? `<autoFilter ref="A${HEAD_ROW}:${lastCol}${lastRow}"/>` : ''}\
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>\
<pageSetup paperSize="1" orientation="landscape" fitToWidth="1" fitToHeight="0"/>\
<headerFooter><oddHeader>&amp;R&amp;8 ${hfText(generatedLabel)}</oddHeader><oddFooter>&amp;L&amp;8 ${hfText(companyName)}&amp;C&amp;8 ${hfText(reportName)}&amp;R&amp;8 Página &amp;P de &amp;N</oddFooter></headerFooter>\
${asTable ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : ''}\
</worksheet>`;

  // ── Tabla nativa ──
  let table = null;
  if (asTable) {
    const totalIndex = hasTotalRow ? totals[0] : -1;
    const totalPlan = hasTotalRow ? totalPlans.get(totalIndex) : null;
    const tableColumns = headers.map((name, k) => {
      if (!hasTotalRow) return `<tableColumn id="${k + 1}" name="${esc(name)}"/>`;
      const formula = totalPlan.get(k);
      if (formula) {
        const range = `${colName(k)}${rowNumber(formula.start)}:${colName(k)}${rowNumber(formula.end)}`;
        return `<tableColumn id="${k + 1}" name="${esc(name)}" totalsRowFunction="custom"><totalsRowFormula>SUBTOTAL(109,${range})</totalsRowFormula></tableColumn>`;
      }
      const text = String(rows[totalIndex].cells[k] ?? '').trim();
      const value = typedValue(text, columns[k].type, decimals[k]);
      return value?.text !== undefined ? `<tableColumn id="${k + 1}" name="${esc(name)}" totalsRowLabel="${esc(value.text)}"/>` : `<tableColumn id="${k + 1}" name="${esc(name)}"/>`;
    });
    const name = tableName(reportName);
    table = `${XML}<table xmlns="${NS_MAIN}" id="1" name="${name}" displayName="${name}" ref="A${HEAD_ROW}:${lastCol}${lastRow}"${hasTotalRow ? ' totalsRowCount="1"' : ' totalsRowShown="0"'}>\
<autoFilter ref="A${HEAD_ROW}:${lastCol}${hasTotalRow ? lastRow - 1 : lastRow}"/>\
<tableColumns count="${headers.length}">${tableColumns.join('')}</tableColumns>\
<tableStyleInfo name="Lulubiz" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>\
</table>`;
  }

  // ── Hoja 2: información ──
  const label = styles.get({ font: FONT.bold, fill: FILL.label, border: BORDER.row, v: 'top' });
  const valueStyle = styles.get({ border: BORDER.row, v: 'top', h: 'left', wrap: true });
  const totalsNote = !totals.length
    ? 'El informe no trae fila de total.'
    : [
        formulaCols.size ? `Con fórmula SUBTOTAL, se recalculan al filtrar o editar: ${[...formulaCols].join(', ')}.` : null,
        fixedCols.size ? `Copiados del informe tal como se mostraron (no son una suma simple de las filas): ${[...fixedCols].join(', ')}.` : null,
      ]
        .filter(Boolean)
        .join(' ') || 'La fila de total no trae cifras.';
  const facts = [
    ['Empresa', companyName],
    company.taxIdLabel ? ['Identificación', company.taxIdLabel] : null,
    ['Informe', reportName],
    info.period ? ['Período', info.period] : null,
    ...filters.map(([l, v]) => [l, String(v)]),
    currency ? ['Moneda', currency] : null,
    user ? ['Generado por', user] : null,
    ['Fecha de generación', { number: serialOf(now), numFmt: NUMFMT.datetime }],
    ['Filas exportadas', { number: dataRows, numFmt: NUMFMT.amount0 }],
    ['Totales', totalsNote],
    ['Origen', 'Lulubiz. Lo exportado es lo que mostraba la tabla en pantalla.'],
  ].filter(Boolean);
  const infoRows = [`<row r="1" ht="26" customHeight="1">${strCell('A1', 'Información del archivo', styles.get({ font: FONT.company, v: 'center' }))}</row>`];
  facts.forEach(([l, v], i) => {
    const r = i + 3;
    const cell =
      typeof v === 'object'
        ? numCell(`B${r}`, v.number, styles.get({ border: BORDER.row, v: 'top', h: 'left', numFmt: v.numFmt }))
        : strCell(`B${r}`, v, valueStyle);
    infoRows.push(`<row r="${r}">${strCell(`A${r}`, l, label)}${cell}</row>`);
  });
  const noticeRow = facts.length + 4;
  infoRows.push(
    `<row r="${noticeRow}" ht="30" customHeight="1">${strCell(`A${noticeRow}`, 'Información confidencial de la empresa. Las cifras son las que se mostraban en pantalla al exportar; el libro contable en Lulubiz es la fuente oficial.', styles.get({ font: FONT.note, v: 'top', wrap: true }))}</row>`,
  );
  const sheet2 = `${XML}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">\
<sheetPr><tabColor rgb="FF9CA3AF"/></sheetPr>\
<dimension ref="A1:B${noticeRow}"/>\
<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>\
<sheetFormatPr defaultRowHeight="15"/>\
<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="90" customWidth="1"/></cols>\
<sheetData>${infoRows.join('')}</sheetData>\
<mergeCells count="1"><mergeCell ref="A${noticeRow}:B${noticeRow}"/></mergeCells>\
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>\
<pageSetup paperSize="1" orientation="portrait"/>\
</worksheet>`;

  // ── Libro ──
  const dataSheet = sheetName(reportName);
  const definedNames = [`<definedName name="_xlnm.Print_Titles" localSheetId="0">${esc(quoteSheet(dataSheet))}!$${HEAD_ROW}:$${HEAD_ROW}</definedName>`];
  if (!asTable && rows.length) {
    definedNames.unshift(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${esc(quoteSheet(dataSheet))}!$A$${HEAD_ROW}:$${lastCol}$${lastRow}</definedName>`);
  }
  const workbook = `${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">\
<bookViews><workbookView activeTab="0"/></bookViews>\
<sheets><sheet name="${esc(dataSheet)}" sheetId="1" r:id="rId1"/><sheet name="${INFO_SHEET}" sheetId="2" r:id="rId2"/></sheets>\
<definedNames>${definedNames.join('')}</definedNames>\
</workbook>`;

  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\
<dc:title>${esc(reportName)}</dc:title><dc:subject>${esc(companyName)}</dc:subject><dc:creator>Lulubiz</dc:creator>\
${user ? `<cp:lastModifiedBy>${esc(user)}</cp:lastModifiedBy>` : ''}\
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>\
</cp:coreProperties>`;
  const app = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Lulubiz</Application><Company>${esc(companyName)}</Company></Properties>`;

  const contentTypes = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
<Default Extension="xml" ContentType="application/xml"/>\
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\
${table ? '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' : ''}\
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\
</Types>`;
  const rels = (items) =>
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  return [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels([
      ['rId1', `${R}/officeDocument`, 'xl/workbook.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', `${R}/extended-properties`, 'docProps/app.xml'],
    ])],
    ['docProps/core.xml', core],
    ['docProps/app.xml', app],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels([
      ['rId1', `${R}/worksheet`, 'worksheets/sheet1.xml'],
      ['rId2', `${R}/worksheet`, 'worksheets/sheet2.xml'],
      ['rId3', `${R}/styles`, 'styles.xml'],
    ])],
    ['xl/styles.xml', styles.xml()],
    ['xl/worksheets/sheet1.xml', sheet1],
    ...(table ? [['xl/worksheets/_rels/sheet1.xml.rels', rels([['rId1', `${R}/table`, '../tables/table1.xml']])], ['xl/tables/table1.xml', table]] : []),
    ['xl/worksheets/sheet2.xml', sheet2],
  ];
}

/** El libro listo para descargar. */
export function buildWorkbook(spec) {
  return zipStore(workbookEntries(spec), spec.now ?? new Date());
}
