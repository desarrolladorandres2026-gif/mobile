import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { DocumentIndicator, DossierAccountStatus } from './driverDossier.logic';

/**
 * Expediente del domiciliario en PDF.
 *
 * Solo maqueta: recibe el expediente ya armado y los bytes de cada anexo
 * (descargados por quien llama), así que no toca base de datos ni red y se
 * prueba con datos fijos. Hoja blanca, tipografía y una línea dorada; sin
 * cajas ni fondos de color — es un documento administrativo, no un póster.
 */

// Obsidiana y Champagne Gold (colores.css), en el espacio 0-1 de pdf-lib.
const OBSIDIAN = rgb(0.031, 0.043, 0.067);
const GOLD = rgb(0.839, 0.62, 0.149);
const MUTED = rgb(0.32, 0.35, 0.4);
const RULE = rgb(0.85, 0.86, 0.88);
const DANGER = rgb(0.7, 0.13, 0.13);
const OK = rgb(0.02, 0.47, 0.34);

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y = 30;

export const INDICATOR_LABEL: Record<DocumentIndicator, string> = {
  valid: 'Vigente',
  expiring: 'Próximo a vencer',
  expired: 'Vencido',
  not_uploaded: 'No cargado',
  in_review: 'En revisión',
  rejected: 'Rechazado',
};

export const ACCOUNT_LABEL: Record<DossierAccountStatus, string> = {
  active: 'Activo',
  pending: 'Pendiente',
  in_review: 'En revisión',
  suspended: 'Suspendido',
  rejected: 'Rechazado',
};

export const EVENT_LABEL: Record<string, string> = {
  submitted: 'Enviado',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  update_requested: 'Actualización solicitada',
  observation: 'Observación',
  created: 'Contrato creado',
  updated: 'Contrato modificado',
  file_uploaded: 'Contrato cargado',
  extra_uploaded: 'Anexo cargado',
  extra_removed: 'Anexo retirado',
};

export const CONTRACT_LABEL: Record<string, string> = {
  draft: 'Borrador',
  active: 'Vigente',
  suspended: 'Suspendido',
  terminated: 'Terminado',
};

export interface PdfHistoryEvent {
  action: string;
  at: Date;
  byName?: string;
  note?: string;
}

export interface PdfDocumentRow {
  label: string;
  indicator: DocumentIndicator;
  uploadedAt?: Date | null;
  issuedAt?: Date | null;
  expiresAt?: Date | null;
  reviewedAt?: Date | null;
  reviewedByName?: string;
  rejectionReason?: string;
  history: PdfHistoryEvent[];
}

export interface DossierPdfInput {
  driverId: string;
  generatedAt: Date;
  generatedBy: string;
  person: {
    name: string;
    documentNumber?: string;
    phone?: string;
    email?: string;
    city?: string;
    address?: string;
    registeredAt?: Date | null;
    linkedAt?: Date | null;
    lastActivityAt?: Date | null;
    status: DossierAccountStatus;
    emergencyContact?: string;
  };
  vehicle: { type: string; plate?: string; brand?: string; model?: string; color?: string; year?: number };
  compliance: { upToDate: boolean; issues: string[] };
  documents: PdfDocumentRow[];
  contract: {
    status?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    extraNames: string[];
    history: PdfHistoryEvent[];
  };
  /** Un anexo por archivo. `error` deja constancia en la hoja cuando no se pudo incorporar. */
  annexes: Array<{
    title: string;
    caption: string;
    file?: { buffer: Buffer; format: 'jpg' | 'pdf' };
    error?: string;
  }>;
}

const bogota = (d: Date | null | undefined, withTime = false): string => {
  if (!d) return '—';
  return d.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
};

type Color = ReturnType<typeof rgb>;

class Sheet {
  pdf!: PDFDocument;
  regular!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  /** Solo las hojas propias llevan pie: las copiadas de PDFs anexos se dejan intactas. */
  own: PDFPage[] = [];
  private charset!: Set<number>;

  static async create(): Promise<Sheet> {
    const s = new Sheet();
    s.pdf = await PDFDocument.create();
    s.regular = await s.pdf.embedFont(StandardFonts.Helvetica);
    s.bold = await s.pdf.embedFont(StandardFonts.HelveticaBold);
    s.charset = new Set(s.regular.getCharacterSet());
    return s;
  }

  /** Helvetica solo codifica WinAnsi: lo demás (emoji, CJK…) se sustituye en vez de romper el PDF. */
  safe(text: string): string {
    return Array.from(text.replace(/[\r\n\t]+/g, ' '))
      .map((ch) => (this.charset.has(ch.codePointAt(0)!) ? ch : '?'))
      .join('');
  }

  newPage(): PDFPage {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.own.push(this.page);
    this.y = PAGE_H - MARGIN;
    return this.page;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 20) this.newPage();
  }

  text(text: string, x: number, y: number, size: number, font: PDFFont, color: Color = OBSIDIAN, page: PDFPage = this.page) {
    page.drawText(this.safe(text), { x, y, size, font, color });
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const words = this.safe(text).split(' ').filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // Una palabra más ancha que la columna (un número largo) se corta por caracteres.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n -= 1;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  heading(title: string) {
    this.ensure(60);
    this.y -= 14;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 12 },
      end: { x: MARGIN + CONTENT_W, y: this.y + 12 },
      thickness: 0.6,
      color: RULE,
    });
    this.text(title, MARGIN, this.y - 6, 12, this.bold);
    this.y -= 26;
  }

  /** Pares etiqueta/valor en dos columnas. */
  facts(items: Array<[string, string | undefined]>) {
    const colW = CONTENT_W / 2;
    for (let i = 0; i < items.length; i += 2) {
      this.ensure(34);
      for (let c = 0; c < 2; c++) {
        const item = items[i + c];
        if (!item) continue;
        const x = MARGIN + c * colW;
        this.text(item[0].toUpperCase(), x, this.y, 7, this.bold, MUTED);
        const lines = this.wrap(item[1] || '—', this.regular, 10, colW - 12);
        this.text(lines[0], x, this.y - 13, 10, this.regular);
      }
      this.y -= 32;
    }
  }

  paragraph(text: string, size = 10, color: Color = OBSIDIAN, font: PDFFont = this.regular) {
    for (const line of this.wrap(text, font, size, CONTENT_W)) {
      this.ensure(size + 6);
      this.text(line, MARGIN, this.y, size, font, color);
      this.y -= size + 4;
    }
  }

  table(head: string[], widths: number[], rows: string[][], colorFor?: (row: number, col: number) => Color | undefined) {
    const size = 8;
    const draw = (cells: string[], isHead: boolean, rowIdx: number) => {
      const font = isHead ? this.bold : this.regular;
      const wrapped = cells.map((c, i) => this.wrap(c || '—', font, size, widths[i] - 8));
      const lines = Math.max(...wrapped.map((w) => w.length));
      const h = lines * (size + 3) + 8;
      this.ensure(h);
      let x = MARGIN;
      wrapped.forEach((w, i) => {
        const color = isHead ? MUTED : colorFor?.(rowIdx, i) ?? OBSIDIAN;
        w.forEach((line, l) => this.text(line, x, this.y - 10 - l * (size + 3), size, font, color));
        x += widths[i];
      });
      this.y -= h;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + 2 },
        end: { x: MARGIN + CONTENT_W, y: this.y + 2 },
        thickness: 0.4,
        color: RULE,
      });
    };
    draw(head, true, -1);
    rows.forEach((r, i) => draw(r, false, i));
    this.y -= 6;
  }
}

function indicatorColor(indicator: DocumentIndicator): Color | undefined {
  if (indicator === 'valid') return OK;
  if (indicator === 'expired' || indicator === 'rejected') return DANGER;
  return undefined;
}

export async function buildDossierPdf(input: DossierPdfInput): Promise<Buffer> {
  const sheet = await Sheet.create();
  const { person, vehicle } = input;

  // ── Portada ──
  const cover = sheet.newPage();
  sheet.text('ZIPP', MARGIN, PAGE_H - 90, 30, sheet.bold);
  cover.drawLine({ start: { x: MARGIN, y: PAGE_H - 106 }, end: { x: MARGIN + 60, y: PAGE_H - 106 }, thickness: 3, color: GOLD });
  sheet.text('EXPEDIENTE DEL DOMICILIARIO', MARGIN, PAGE_H - 300, 10, sheet.bold, GOLD);
  const nameLines = sheet.wrap(person.name, sheet.bold, 28, CONTENT_W).slice(0, 3);
  nameLines.forEach((line, i) => sheet.text(line, MARGIN, PAGE_H - 336 - i * 34, 28, sheet.bold));
  const coverY = PAGE_H - 336 - nameLines.length * 34 - 6;
  sheet.text(`Documento ${person.documentNumber || '—'}`, MARGIN, coverY, 12, sheet.regular, MUTED);
  const meta: Array<[string, string]> = [
    ['Estado', ACCOUNT_LABEL[person.status]],
    ['Documentación', input.compliance.upToDate ? 'Al día' : 'Requiere atención'],
    ['Generado', bogota(input.generatedAt, true)],
    ['Generado por', input.generatedBy],
    ['Referencia', input.driverId],
  ];
  meta.forEach(([k, v], i) => {
    const y = 210 - i * 26;
    sheet.text(k.toUpperCase(), MARGIN, y, 7, sheet.bold, MUTED, cover);
    sheet.text(v, MARGIN + 110, y, 10, sheet.regular, OBSIDIAN, cover);
  });

  // ── Datos ──
  sheet.newPage();
  sheet.text('Expediente', MARGIN, sheet.y, 18, sheet.bold);
  sheet.y -= 8;

  sheet.heading('1. Datos personales');
  sheet.facts([
    ['Nombre completo', person.name],
    ['Documento', person.documentNumber],
    ['Teléfono', person.phone],
    ['Correo', person.email],
    ['Ciudad', person.city],
    ['Dirección', person.address],
    ['Fecha de registro', bogota(person.registeredAt)],
    ['Contacto de emergencia', person.emergencyContact ?? 'No registrado'],
  ]);

  sheet.heading('2. Vinculación con ZIPP');
  sheet.facts([
    ['Estado actual', ACCOUNT_LABEL[person.status]],
    ['Fecha de vinculación', bogota(person.linkedAt)],
    ['Última actividad', bogota(person.lastActivityAt, true)],
    ['Contrato', input.contract.status ? CONTRACT_LABEL[input.contract.status] ?? input.contract.status : 'Sin registrar'],
    ['Inicio del contrato', bogota(input.contract.startDate)],
    ['Fin del contrato', input.contract.endDate ? bogota(input.contract.endDate) : 'Sin fecha de finalización'],
  ]);

  sheet.heading('3. Vehículo');
  sheet.facts([
    ['Tipo', vehicle.type],
    ['Placa', vehicle.plate],
    ['Marca', vehicle.brand],
    ['Modelo', vehicle.model],
    ['Color', vehicle.color],
    ['Año', vehicle.year ? String(vehicle.year) : undefined],
  ]);

  sheet.heading('4. Estado de la documentación');
  sheet.paragraph(
    input.compliance.upToDate ? 'Toda la documentación está al día.' : 'La documentación requiere atención:',
    11,
    input.compliance.upToDate ? OK : DANGER,
    sheet.bold
  );
  for (const issue of input.compliance.issues) sheet.paragraph(`•  ${issue}`, 10, MUTED);
  sheet.y -= 4;

  sheet.heading('5. Resumen de documentos');
  sheet.table(
    ['Documento', 'Estado', 'Cargado', 'Expedición', 'Vence', 'Verificado'],
    [155, 85, 65, 65, 65, 60],
    input.documents.map((d) => [
      d.label,
      INDICATOR_LABEL[d.indicator],
      bogota(d.uploadedAt),
      bogota(d.issuedAt),
      bogota(d.expiresAt),
      bogota(d.reviewedAt),
    ]),
    (row, col) => (col === 1 ? indicatorColor(input.documents[row].indicator) : undefined)
  );

  sheet.heading('6. Verificación');
  sheet.table(
    ['Documento', 'Verificado por', 'Fecha', 'Motivo del rechazo'],
    [150, 120, 75, 150],
    input.documents.map((d) => [d.label, d.reviewedByName ?? '—', bogota(d.reviewedAt, true), d.rejectionReason ?? ''])
  );

  sheet.heading('7. Contrato y documentos adicionales');
  sheet.paragraph(
    input.contract.extraNames.length
      ? `Documentos adicionales: ${input.contract.extraNames.join(', ')}.`
      : 'Sin documentos adicionales asociados.',
    10,
    MUTED
  );

  const events = [
    ...input.documents.flatMap((d) => d.history.map((h) => ({ ...h, doc: d.label }))),
    ...input.contract.history.map((h) => ({ ...h, doc: 'Contrato' })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 80);
  sheet.heading('8. Historial de verificaciones y cambios');
  if (events.length === 0) {
    sheet.paragraph('Sin movimientos registrados.', 10, MUTED);
  } else {
    sheet.table(
      ['Fecha', 'Documento', 'Evento', 'Por', 'Nota'],
      [85, 105, 85, 80, 140],
      events.map((e) => [bogota(e.at, true), e.doc, EVENT_LABEL[e.action] ?? e.action, e.byName ?? 'Domiciliario', e.note ?? ''])
    );
  }

  // ── Anexos ──
  let n = 0;
  for (const annex of input.annexes) {
    n += 1;
    const page = sheet.newPage();
    sheet.text(`ANEXO ${n}`, MARGIN, PAGE_H - MARGIN, 8, sheet.bold, GOLD, page);
    sheet.text(annex.title, MARGIN, PAGE_H - MARGIN - 18, 14, sheet.bold, OBSIDIAN, page);
    sheet.text(annex.caption, MARGIN, PAGE_H - MARGIN - 34, 9, sheet.regular, MUTED, page);
    const failLine = (message: string) =>
      sheet.text(message, MARGIN, PAGE_H - MARGIN - 80, 10, sheet.regular, DANGER, page);

    if (!annex.file) {
      failLine(annex.error ?? 'Archivo no disponible.');
      continue;
    }

    if (annex.file.format === 'jpg') {
      try {
        const image = await sheet.pdf.embedJpg(annex.file.buffer);
        const maxH = PAGE_H - MARGIN * 2 - 70;
        const scale = Math.min(CONTENT_W / image.width, maxH / image.height, 1.5);
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, { x: MARGIN, y: PAGE_H - MARGIN - 56 - h, width: w, height: h });
      } catch {
        failLine('La imagen está dañada y no se pudo incorporar.');
      }
      continue;
    }

    try {
      const source = await PDFDocument.load(annex.file.buffer, { ignoreEncryption: true });
      const pages = await sheet.pdf.copyPages(source, source.getPageIndices());
      sheet.text(
        `El documento original (${pages.length} pág.) continúa a partir de la siguiente hoja.`,
        MARGIN,
        PAGE_H - MARGIN - 80,
        10,
        sheet.regular,
        MUTED,
        page
      );
      pages.forEach((p) => sheet.pdf.addPage(p));
    } catch {
      failLine('El PDF está dañado o protegido y no se pudo incorporar.');
    }
  }

  // ── Pie en las hojas propias ──
  const all = sheet.pdf.getPages();
  const total = all.length;
  sheet.own.forEach((page) => {
    const index = all.indexOf(page) + 1;
    if (index === 1) return; // la portada va limpia
    const right = `Página ${index} de ${total}`;
    sheet.text(`ZIPP · Expediente de ${person.name} · Confidencial`, MARGIN, FOOTER_Y, 7, sheet.regular, MUTED, page);
    sheet.text(right, PAGE_W - MARGIN - sheet.regular.widthOfTextAtSize(right, 7), FOOTER_Y, 7, sheet.regular, MUTED, page);
  });

  sheet.pdf.setTitle(`Expediente - ${person.name}`);
  sheet.pdf.setProducer('ZIPP');
  sheet.pdf.setCreator('ZIPP');
  return Buffer.from(await sheet.pdf.save());
}
