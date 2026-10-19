import { AppError } from '../middlewares';

/**
 * Facturación electrónica: el límite entre lo que ZIPP emite hoy y lo que la DIAN
 * tiene que validar (Auditoría 2026-10-19).
 *
 * Hay TRES clases de documento y no se mezclan:
 *
 *  · `internal_voucher`: soporte de gestión con consecutivo propio (`INT-…`). Es una
 *    foto de lo que se pagó. NO es factura ni documento soporte: no tiene validez
 *    ante la DIAN y quien lo recibe no puede usarlo para descontar impuestos.
 *  · `commercial_document`: el registro interno de un cobro (p. ej. el cobro de
 *    publicidad, `AdInvoice`). Aunque el modelo se llame «invoice», tampoco es una
 *    factura electrónica; la interfaz lo presenta como «cobro».
 *  · `electronic_invoice`: la factura electrónica de venta (y sus notas), con su
 *    número autorizado, firma, CUFE y la validación de la DIAN. Solo existe cuando
 *    un proveedor habilitado la emite y la DIAN la acepta.
 *
 * Hoy NO hay integración: ZIPP no emite facturas electrónicas. Este módulo existe
 * para que (1) ninguna parte del sistema pueda presentar como factura algo que no
 * lo es, (2) el día que haya proveedor se enchufe en UN sitio y (3) un documento
 * solo pueda marcarse «validado» con la confirmación auténtica del proveedor: el
 * CUFE y la fecha de validación vienen de él, ZIPP nunca los fabrica.
 */

export type DocumentLegalKind = 'internal_voucher' | 'commercial_document' | 'electronic_invoice';

/** Qué es cada documento que ZIPP genera hoy. Un documento nuevo se declara aquí o no se emite. */
export const ZIPP_DOCUMENT_KINDS = {
  settlement_statement: 'internal_voucher',
  driver_payment_voucher: 'internal_voucher',
  ad_charge: 'commercial_document',
} as const satisfies Record<string, DocumentLegalKind>;

/** El aviso que debe acompañar a todo documento que no sea factura electrónica. */
export const NOT_AN_INVOICE_NOTICE =
  'Documento interno de gestión. No es factura electrónica ni documento soporte validado por la DIAN.';

/** Lo que un proveedor tecnológico debe devolver para que un documento cuente como validado. */
export interface ElectronicInvoiceReceipt {
  /** Número autorizado por la DIAN (prefijo + consecutivo de la resolución). */
  number: string;
  /** Código único de la factura electrónica, calculado y devuelto por el proveedor. */
  cufe: string;
  /** Cuándo la DIAN la aceptó, según el proveedor. */
  dianValidatedAt: Date;
  providerReference: string;
}

export interface ElectronicInvoiceRequest {
  /** Qué documento interno se está facturando (tipo + id). */
  source: { kind: keyof typeof ZIPP_DOCUMENT_KINDS; id: string };
  amount: number;
}

export interface ElectronicInvoiceProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Emite y espera la validación de la DIAN. Debe lanzar si la DIAN la rechaza: nunca devolver un recibo que no fue aceptado. */
  issue(request: ElectronicInvoiceRequest): Promise<ElectronicInvoiceReceipt>;
}

/** Lo que falta antes de poder emitir la primera factura. Es la lista de trabajo, no una opinión legal. */
export const ELECTRONIC_INVOICING_MISSING = [
  'NIT y RUT de ZIPP con las responsabilidades tributarias registradas ante la DIAN.',
  'Habilitación de ZIPP como facturador electrónico ante la DIAN.',
  'Resolución de numeración (prefijo y rango) autorizada por la DIAN.',
  'Proveedor tecnológico autorizado —o software propio habilitado—, con contrato y credenciales (hoy no hay ninguno).',
  'Certificado de firma digital.',
  'Decisión del contador sobre qué documento se emite en cada flujo: factura de venta (comisión, publicidad, Zipp Pro, servicio de plataforma), documento soporte en adquisiciones a quien no está obligado a facturar (pagos a domiciliarios), notas crédito para reembolsos.',
  'Datos del adquirente en cada flujo: los comercios tienen ficha legal; el cliente final no se pide hoy.',
  'Reglas tributarias validadas por concepto (ver Impuestos): la factura lleva el impuesto que esas reglas definan.',
];

let provider: ElectronicInvoiceProvider | null = null;

/** Para el día de la integración y para las pruebas. En producción no se llama a esto sin un contrato real detrás. */
export function setElectronicInvoiceProvider(next: ElectronicInvoiceProvider | null): void {
  provider = next;
}

export const electronicInvoicingService = {
  async status() {
    const configured = !!provider && provider.isConfigured();
    return {
      integrated: configured,
      provider: configured ? provider!.name : null,
      /** Qué clase de documento es cada uno de los que ZIPP genera hoy. */
      documents: ZIPP_DOCUMENT_KINDS,
      missing: configured ? [] : ELECTRONIC_INVOICING_MISSING,
    };
  },

  /**
   * Emite una factura electrónica. Sin proveedor configurado NO simula nada:
   * responde 501 y no deja ningún documento marcado como emitido.
   */
  async issue(request: ElectronicInvoiceRequest): Promise<ElectronicInvoiceReceipt> {
    if (!provider || !provider.isConfigured()) {
      throw new AppError(
        'ZIPP todavía no tiene facturación electrónica integrada: no hay proveedor habilitado ante la DIAN.',
        501,
        'ELECTRONIC_INVOICING_NOT_CONFIGURED'
      );
    }
    const receipt = await provider.issue(request);
    // La confirmación es del proveedor: sin CUFE ni fecha de validación no hay factura, haya o no respuesta.
    if (!receipt?.cufe?.trim() || !receipt.number?.trim() || !(receipt.dianValidatedAt instanceof Date) || Number.isNaN(receipt.dianValidatedAt.getTime())) {
      throw new AppError(
        'El proveedor no devolvió la validación de la DIAN (número, CUFE y fecha): el documento no se da por emitido.',
        502,
        'ELECTRONIC_INVOICE_NOT_VALIDATED'
      );
    }
    return receipt;
  },
};
