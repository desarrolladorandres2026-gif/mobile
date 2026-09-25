import {
  Business,
  IBusiness,
  IBusinessLegal,
  IBusinessPayoutAccount,
  BusinessDocument,
  BusinessDocumentType,
  IBusinessDocumentHistoryEntry,
  MAX_DOCUMENT_HISTORY,
  LegalDocumentType,
  TaxRegime,
  PayoutMethod,
  PayoutAccountType,
  REQUIRED_BUSINESS_DOCUMENTS,
  FOOD_CATEGORIES,
  BusinessStaff,
  ISettlementPayoutAccount,
} from '../models';
import { NotificationType } from '../types';
import { AppError } from '../middlewares';
import { escapeRegex } from '../utils';
import mongoose from 'mongoose';
import { logAudit, AuditAction, AuditSeverity, encrypt, decrypt, hashForSearch } from '../security';
import type { Request } from 'express';
import { PUBLIC_BUSINESS_FIELDS, PUBLIC_LIST_FIELDS, PUBLIC_LIST_PROJECTION } from '../utils/catalogQuery';
import { computeNitDv, isValidNitDv, lastDigits, maskAccount } from '../utils/nit';
import { storePrivateFile, signedPrivateUrl, PrivateResourceType } from './privateStorage.service';
import { notificationService } from './notification.service';

/**
 * Contexto de cifrado (AAD) de los datos sensibles de un comercio: el texto
 * cifrado de un negocio no se puede pegar en otro.
 */
export const businessAad = (businessId: unknown) => `zipp:business:${String(businessId)}`;

const isSealed = (value: string) => /^v[23]:/.test(value);

/** Cifra con el contexto del negocio; lo ya cifrado se deja igual. */
export const sealForBusiness = (value: string, businessId: unknown) =>
  isSealed(value) ? value : encrypt(value, businessAad(businessId));

/** Lee un valor que puede estar cifrado (v3) o, si es anterior a la migración 018, en claro. */
export const openForBusiness = (value: string | null | undefined, businessId: unknown) =>
  value ? decrypt(value, businessAad(businessId)) : '';

const OWNER_CHANGE_TITLE = 'Cambio en la cuenta de pago de tu negocio';

/** Los datos legales con el número de documento en claro, listos para calcular. */
function plainLegal<T extends Partial<IBusinessLegal> | null | undefined>(legal: T, businessId: unknown): T {
  if (!legal || !legal.documentNumber) return legal;
  return { ...legal, documentNumber: openForBusiness(legal.documentNumber, businessId) };
}

/** Tope del archivo de un documento del comercio (cédula, RUT, certificado). */
export const MAX_BUSINESS_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Lo que se sabe de la cuenta de pago sin abrirla. */
export type PayoutAccountState = 'none' | 'pendingVerification' | 'verified';

export interface LegalInput {
  documentType: LegalDocumentType;
  documentNumber: string;
  dv?: string | number | null;
  legalName: string;
  legalRepName?: string | null;
  taxRegime?: TaxRegime | null;
  billingEmail?: string | null;
}

export interface PayoutAccountInput {
  method: PayoutMethod;
  bankName?: string | null;
  accountType?: PayoutAccountType | null;
  accountNumber: string;
  holderName: string;
  holderDocument: string;
}

/**
 * ¿Están completos los datos tributarios? Es lo que exige `approve()`.
 * Para un NIT también cuenta que el DV guardado corresponda al número.
 */
export function isLegalComplete(legal?: Partial<IBusinessLegal> | null): boolean {
  if (!legal?.documentType || !legal.documentNumber || !legal.legalName) return false;
  if (legal.documentType === 'NIT') {
    return !!legal.dv && isValidNitDv(legal.documentNumber, legal.dv);
  }
  return true;
}

/**
 * Un negocio en cola de revisión.
 *
 * El tipo se escribe a mano porque el inferido —un documento poblado, más
 * sus documentos, más la lista de faltantes— es tan grande que TypeScript
 * se niega a serializarlo.
 */
export interface PendingApproval {
  _id: unknown;
  name: string;
  category: string;
  address: string;
  city: string;
  createdAt: Date;
  ownerId?: { _id: unknown; name?: string; phone?: string; email?: string } | unknown;
  missingDocuments: BusinessDocumentType[];
  documents: unknown[];
  /** Lo que falta de los datos tributarios y la cuenta de pago para poder aprobar. */
  fiscal: { legalComplete: boolean; payoutAccountStatus: PayoutAccountState };
  [key: string]: unknown;
}

type DaySchedule = { open?: string; close?: string; isOpen?: boolean };

interface CreateBusinessInput {
  freeDeliveryThreshold?: number;
  schedule?: Record<string, DaySchedule>;
  ownerId: string;
  name: string;
  description?: string;
  category: string;
  address: string;
  longitude: number;
  latitude: number;
  phone: string;
  deliveryTime?: number;
  minOrder?: number;
  city?: string;
}

/** Commercial terms only an admin may set. */
export interface BusinessTermsInput {
  commissionRateBps?: number;
  isFeatured?: boolean;
  isApproved?: boolean;
  isActive?: boolean;
  minOrder?: number;
}

export class BusinessService {
  /**
   * Registers a business.
   *
   * Commercial terms are never taken from the payload: a new business
   * inherits the platform commission (`commissionRateBps: -1` means "no
   * override") and starts unapproved, so it does not appear to customers
   * until an admin reviews it. Self-registration at 0% commission and
   * self-featuring were both possible before and both leaked revenue.
   */
  async create(input: CreateBusinessInput): Promise<IBusiness> {
    const business = await Business.create({
      ...input,
      commissionRateBps: -1,
      isApproved: false,
      isFeatured: false,
      location: {
        type: 'Point',
        coordinates: [input.longitude, input.latitude],
      },
    });
    return business;
  }

  // ── Documentación del comercio ──

  /**
   * Papeles que le faltan a un negocio para poder operar.
   *
   * Se devuelve la lista en vez de un booleano porque quien pregunta casi
   * siempre necesita decirle a alguien qué le falta, y un "no" a secas
   * obliga a adivinarlo.
   *
   * El concepto sanitario entra solo si el negocio manipula alimentos:
   * exigírselo a una papelería sería inventar un requisito.
   */
  async missingDocuments(businessId: string): Promise<BusinessDocumentType[]> {
    const business = await Business.findById(businessId).select('category');
    if (!business) throw new AppError('Negocio no encontrado', 404);

    const now = new Date();
    await BusinessDocument.updateMany(
      { businessId, expiresAt: { $lt: now }, status: { $ne: 'expired' } },
      { $set: { status: 'expired' } }
    );

    const documents = await BusinessDocument.find({ businessId });
    return this.missingFrom(business.category, documents, now);
  }

  /** Lo que le falta a un negocio, con sus documentos ya leídos (sin tocar la base). */
  private missingFrom(
    category: string,
    documents: Array<{ type: string; status: string; expiresAt?: Date | null }>,
    now: Date
  ): BusinessDocumentType[] {
    const required = [...REQUIRED_BUSINESS_DOCUMENTS];
    if (FOOD_CATEGORIES.includes(category as never)) required.push('health_permit');

    return required.filter(
      (type) =>
        !documents.some(
          (d) =>
            d.type === type &&
            d.status === 'approved' &&
            (!d.expiresAt || d.expiresAt >= now)
        )
    );
  }

  /**
   * ¿Puede aprobarse por el lado fiscal? Datos tributarios completos y cuenta
   * de pago verificada por finanzas. Devuelve qué falta, no un booleano: quien
   * pregunta casi siempre tiene que decirle a alguien qué corregir.
   */
  async fiscalReadiness(businessId: string): Promise<{
    ready: boolean;
    legalComplete: boolean;
    payoutAccountStatus: PayoutAccountState;
  }> {
    const business = await Business.findById(businessId).select('+legal +payoutAccount').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);

    const legalComplete = isLegalComplete(plainLegal(business.legal, businessId));
    const payoutAccountStatus: PayoutAccountState = business.payoutAccount
      ? business.payoutAccount.verificationStatus
      : 'none';

    return { ready: legalComplete && payoutAccountStatus === 'verified', legalComplete, payoutAccountStatus };
  }

  /**
   * Aprueba un negocio, pero solo si sus papeles están en regla.
   *
   * Antes el panel creaba negocios con `isApproved: true` fijo en el código
   * del formulario, así que ningún comercio pasaba por revisión: se
   * aprobaban en el mismo gesto de darlos de alta. Aprobar es fijar los
   * términos comerciales de alguien a quien se le va a pagar dinero, y eso
   * merece una comprobación.
   *
   * Desde la Fase 0 exige además datos legales completos y una cuenta de pago
   * **verificada**: nadie liquida a una cuenta que finanzas no revisó. Solo
   * aplica a aprobaciones nuevas — los comercios ya aprobados no se tocan.
   */
  async approve(id: string, approvedBy: string): Promise<IBusiness> {
    // Separación de funciones: quien es dueño del negocio no lo aprueba (un
    // admin puede figurar como dueño si registró el negocio sin indicar otro).
    const owned = await Business.findById(id).select('ownerId').lean();
    if (!owned) throw new AppError('Negocio no encontrado', 404);
    if (String(owned.ownerId) === approvedBy) {
      throw new AppError('No puedes aprobar un negocio del que eres dueño', 403, 'BUSINESS_SELF_APPROVAL');
    }

    const missing = await this.missingDocuments(id);
    if (missing.length) {
      throw new AppError(
        `No se puede aprobar: faltan o vencieron documentos (${missing.join(', ')})`,
        422,
        'BUSINESS_DOCUMENTS_MISSING'
      );
    }

    const fiscal = await this.fiscalReadiness(id);
    if (!fiscal.ready) throw this.fiscalGateError(fiscal);

    // La condición fiscal viaja dentro del filtro: entre la lectura de arriba
    // y esta escritura el dueño puede haber cambiado su cuenta (que vuelve a
    // `pendingVerification`), y aprobar contra una comprobación vieja sería
    // aprobar a ciegas el destino del dinero.
    const business = await Business.findOneAndUpdate(
      {
        _id: id,
        ownerId: { $ne: approvedBy },
        'payoutAccount.verificationStatus': 'verified',
        'legal.documentNumber': { $exists: true, $ne: null },
      },
      { isApproved: true, approvedAt: new Date(), approvedBy },
      { new: true }
    );

    if (!business) {
      const again = await this.fiscalReadiness(id);
      throw this.fiscalGateError(again);
    }
    return business;
  }

  private fiscalGateError(fiscal: { legalComplete: boolean; payoutAccountStatus: PayoutAccountState }) {
    const problems: string[] = [];
    if (!fiscal.legalComplete) problems.push('datos legales/tributarios incompletos');
    if (fiscal.payoutAccountStatus === 'none') problems.push('sin cuenta de pago');
    if (fiscal.payoutAccountStatus === 'pendingVerification') problems.push('cuenta de pago sin verificar por finanzas');
    return new AppError(
      `No se puede aprobar: ${problems.join('; ')}`,
      422,
      'BUSINESS_FISCAL_DATA_MISSING'
    );
  }

  // ── Documentos: subida, lectura y revisión (O4) ──

  /**
   * Un documento tal como sale a un cliente HTTP: sin la llave del archivo y
   * con la URL firmada calculada **ahora**. Nunca se persiste esa URL.
   */
  documentView(doc: unknown, options: { includeHistory?: boolean } = {}): Record<string, unknown> {
    const raw = (typeof (doc as { toObject?: unknown }).toObject === 'function'
      ? (doc as { toObject: () => Record<string, unknown> }).toObject()
      : doc) as Record<string, unknown>;

    const { fileKey, fileResourceType, history, ...rest } = raw as {
      fileKey?: string | null;
      fileResourceType?: PrivateResourceType | null;
      history?: IBusinessDocumentHistoryEntry[];
      [key: string]: unknown;
    };

    return {
      ...rest,
      hasFile: !!fileKey,
      fileUrl: signedPrivateUrl({ key: fileKey, resourceType: fileResourceType }),
      history: (history ?? []).map((entry) => {
        const { fileKey: oldKey, fileResourceType: oldType, ...entryRest } = entry as unknown as {
          fileKey?: string | null;
          fileResourceType?: PrivateResourceType | null;
          [key: string]: unknown;
        };
        return {
          ...entryRest,
          hasFile: !!oldKey,
          // Firmar 20 versiones viejas en cada listado es dar 20 enlaces que
          // nadie pidió: el historial se firma solo bajo demanda.
          ...(options.includeHistory ? { fileUrl: signedPrivateUrl({ key: oldKey, resourceType: oldType }) } : {}),
        };
      }),
    };
  }

  /**
   * Guarda (o reemplaza) un documento del comercio.
   *
   * El archivo va a entrega privada de Cloudinary y solo se guarda su llave.
   * Reenviar un documento ya revisado no borra el rastro: la versión anterior
   * pasa a `history` (con su estado, motivo de rechazo y revisor) y el
   * documento vuelve a `pending`. Se hace con comparación de `updatedAt` para
   * que dos reenvíos simultáneos no pierdan una entrada del historial.
   *
   * `file` es opcional solo para quien llama desde un script o una prueba; la
   * ruta HTTP lo exige.
   */
  async submitDocument(
    businessId: string,
    input: { type: BusinessDocumentType; reference: string; expiresAt?: Date; file?: Buffer; submittedBy?: string },
    req?: Request
  ) {
    // Sin esta comprobación, un admin (que no pasa por la de propiedad) podría
    // dejar un documento huérfano —con un archivo privado detrás— para un
    // negocio que no existe.
    if (!(await Business.exists({ _id: businessId }))) throw new AppError('Negocio no encontrado', 404);

    const stored = input.file
      ? await storePrivateFile(input.file, {
          folder: `zipp/business-documents/${businessId}`,
          maxBytes: MAX_BUSINESS_DOCUMENT_BYTES,
        })
      : null;

    const now = new Date();
    const existing = await BusinessDocument.findOne({ businessId, type: input.type });

    const filePatch = stored
      ? {
          fileKey: stored.key,
          fileResourceType: stored.resourceType,
          fileFormat: stored.format,
          isPrivate: true,
        }
      : existing
        ? {
            fileKey: existing.fileKey ?? null,
            fileResourceType: existing.fileResourceType ?? null,
            fileFormat: existing.fileFormat ?? null,
            isPrivate: existing.isPrivate,
          }
        : { fileKey: null, fileResourceType: null, fileFormat: null, isPrivate: false };

    let document;
    if (!existing) {
      try {
        document = await BusinessDocument.create({
          businessId,
          type: input.type,
          reference: input.reference,
          expiresAt: input.expiresAt,
          status: 'pending',
          submittedAt: now,
          submittedBy: input.submittedBy ?? null,
          history: [],
          ...filePatch,
        });
      } catch (error: any) {
        if (error?.code === 11000) {
          throw new AppError('Ese documento se acaba de enviar desde otra sesión. Intenta de nuevo.', 409);
        }
        throw error;
      }
    } else {
      // Solo se archiva una versión que llegó a revisarse: sobrescribir una
      // subida que nadie miró no pierde ninguna decisión.
      const reviewed = existing.status !== 'pending';
      const archived: IBusinessDocumentHistoryEntry | null = reviewed
        ? {
            status: existing.status,
            rejectionReason: existing.rejectionReason ?? null,
            reviewedBy: existing.reviewedBy ?? null,
            reviewedAt: existing.reviewedAt ?? null,
            fileKey: existing.fileKey ?? null,
            fileResourceType: existing.fileResourceType ?? null,
            reference: existing.reference,
            submittedAt: existing.submittedAt ?? existing.createdAt,
            archivedAt: now,
          }
        : null;

      document = await BusinessDocument.findOneAndUpdate(
        { _id: existing._id, updatedAt: existing.updatedAt },
        {
          $set: {
            reference: input.reference,
            status: 'pending',
            reviewedBy: null,
            reviewedAt: null,
            rejectionReason: null,
            submittedAt: now,
            submittedBy: input.submittedBy ?? null,
            ...filePatch,
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          },
          // El vencimiento es de la versión nueva: si no trae fecha, la que
          // tenía el archivo anterior no le corresponde.
          ...(input.expiresAt ? {} : { $unset: { expiresAt: 1 } }),
          ...(archived ? { $push: { history: { $each: [archived], $slice: -MAX_DOCUMENT_HISTORY } } } : {}),
        },
        { new: true, runValidators: true }
      );

      if (!document) {
        throw new AppError('El documento cambió mientras lo enviabas. Intenta de nuevo.', 409, 'DOCUMENT_CHANGED');
      }
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_DOCUMENT_SUBMITTED,
        entity: 'business_document',
        entityId: document._id.toString(),
        severity: AuditSeverity.MEDIUM,
        description: `Documento ${input.type} enviado para verificación`,
        metadata: {
          businessId,
          documentType: input.type,
          replacedStatus: existing?.status ?? null,
          hasFile: !!document.fileKey,
        },
      });
    }

    return document;
  }

  /**
   * Los documentos de un negocio, con URL firmada. Quien llama ya comprobó el
   * acceso. `includeHistory` firma también las versiones anteriores.
   */
  async listDocuments(businessId: string, options: { includeHistory?: boolean } = {}) {
    const documents = await BusinessDocument.find({ businessId }).sort({ type: 1 });
    return documents.map((doc) => this.documentView(doc, options));
  }

  /**
   * Revisión de un documento. El rechazo exige motivo (5-300): el comercio lo
   * ve, y sin él reintenta a ciegas.
   *
   * `revision` (el `updatedAt` en ms que vio quien revisa) evita aprobar un
   * archivo distinto del que se miró: si el comercio lo reemplazó mientras el
   * panel estaba abierto, la revisión falla con 409 en vez de aprobar a ciegas.
   */
  async reviewDocument(
    documentId: string,
    adminId: string,
    status: 'approved' | 'rejected',
    rejectionReason: string | undefined,
    revision: number
  ) {
    const reason = rejectionReason?.trim();
    if (status === 'rejected' && (!reason || reason.length < 5 || reason.length > 300)) {
      throw new AppError('El motivo del rechazo es obligatorio (5 a 300 caracteres)', 400);
    }
    // Sin `revision` se podía aprobar "lo que hubiera" en ese momento: un
    // reemplazo del archivo entre que el revisor miró y pulsó quedaba aprobado.
    if (!Number.isFinite(revision) || revision <= 0) {
      throw new AppError('Falta la revisión del documento (revision): recarga y vuelve a abrirlo', 400, 'REVISION_REQUIRED');
    }

    const filter: Record<string, unknown> = { _id: documentId, updatedAt: new Date(revision) };
    if (status === 'approved') {
      // No se aprueba un papel sin archivo, ni uno subido por quien lo aprueba.
      filter.fileKey = { $nin: [null, ''] };
      filter.submittedBy = { $ne: new mongoose.Types.ObjectId(adminId) };
    }

    const document = await BusinessDocument.findOneAndUpdate(
      filter,
      {
        $set: {
          status,
          reviewedBy: adminId,
          reviewedAt: new Date(),
          rejectionReason: status === 'rejected' ? reason : null,
        },
      },
      { new: true, runValidators: true }
    );

    if (!document) {
      const current = await BusinessDocument.findById(documentId).select('updatedAt fileKey submittedBy').lean();
      if (!current) throw new AppError('Documento no encontrado', 404);
      if (status === 'approved' && current.updatedAt.getTime() === revision) {
        if (!current.fileKey) {
          throw new AppError('Este documento no tiene archivo adjunto: pide que lo suban antes de aprobarlo', 422, 'DOCUMENT_FILE_REQUIRED');
        }
        if (current.submittedBy && String(current.submittedBy) === adminId) {
          throw new AppError('No puedes aprobar un documento que subiste tú', 403, 'DOCUMENT_SELF_REVIEW');
        }
      }
      throw new AppError('El documento cambió desde que lo abriste. Recarga y revísalo de nuevo.', 409, 'DOCUMENT_CHANGED');
    }
    return document;
  }

  /** Los negocios que esperan revisión, con lo que les falta ya calculado. */
  async pendingApprovals(): Promise<PendingApproval[]> {
    const businesses = await Business.find({ isApproved: false })
      .sort({ createdAt: 1 })
      .select('+legal +payoutAccount')
      .populate('ownerId', 'name phone email')
      .lean();

    // Dos consultas para toda la cola, no tres por negocio: con 40 negocios
    // esperando eran 120 viajes a Atlas en cada apertura de la pantalla.
    const ids = businesses.map((b) => b._id);
    const now = new Date();
    await BusinessDocument.updateMany(
      { businessId: { $in: ids }, expiresAt: { $lt: now }, status: { $ne: 'expired' } },
      { $set: { status: 'expired' } }
    );
    const allDocuments = await BusinessDocument.find({ businessId: { $in: ids } }).lean();
    const byBusiness = new Map<string, typeof allDocuments>();
    for (const doc of allDocuments) {
      const key = String(doc.businessId);
      const list = byBusiness.get(key);
      if (list) list.push(doc);
      else byBusiness.set(key, [doc]);
    }

    return businesses.map((business) => {
      // Se sacan de la respuesta: la cola muestra un resumen, no el número
      // de cuenta cifrado ni los datos tributarios enteros.
      const { legal, payoutAccount, ...rest } = business as typeof business & {
        legal?: IBusinessLegal;
        payoutAccount?: IBusinessPayoutAccount;
      };
      const documents = byBusiness.get(String(business._id)) ?? [];

      return {
        ...rest,
        missingDocuments: this.missingFrom(business.category, documents, now),
        documents: documents.map((doc) => this.documentView(doc)),
        fiscal: {
          legalComplete: isLegalComplete(plainLegal(legal, business._id)),
          payoutAccountStatus: (payoutAccount ? payoutAccount.verificationStatus : 'none') as PayoutAccountState,
        },
      };
    }) as unknown as PendingApproval[];
  }

  // ── Datos legales y cuenta de pago ──

  /** Los datos tributarios tal como salen: solo lo que el formulario edita. */
  legalView(legal?: Partial<IBusinessLegal> | null) {
    if (!legal || !legal.documentType) return null;
    return {
      documentType: legal.documentType,
      documentNumber: legal.documentNumber,
      dv: legal.dv ?? null,
      legalName: legal.legalName,
      legalRepName: legal.legalRepName ?? null,
      taxRegime: legal.taxRegime ?? null,
      billingEmail: legal.billingEmail ?? null,
      complete: isLegalComplete(legal),
      updatedAt: legal.updatedAt ?? null,
    };
  }

  /**
   * La cuenta de pago **enmascarada**: 4 últimos dígitos y sin el documento
   * del titular completo. Es lo que ve el dueño y el staff; el completo es
   * `revealPayoutAccount`, solo para finanzas.
   */
  payoutAccountView(
    account?: Partial<IBusinessPayoutAccount> | null,
    legal?: Partial<IBusinessLegal> | null,
    businessId?: unknown
  ) {
    if (!account || !account.method) return null;
    const holderDocument = businessId ? openForBusiness(account.holderDocument, businessId) : account.holderDocument;
    const plainLegalData = businessId ? plainLegal(legal, businessId) : legal;
    return {
      method: account.method,
      bankName: account.bankName ?? null,
      accountType: account.accountType ?? null,
      accountMasked: maskAccount(account.accountLast4),
      accountLast4: account.accountLast4,
      holderName: account.holderName,
      holderDocumentMasked: holderDocument ? `***${lastDigits(holderDocument)}` : null,
      holderMatchesLegal: this.holderMatchesLegal({ ...account, holderDocument }, plainLegalData),
      verificationStatus: account.verificationStatus,
      verifiedAt: account.verifiedAt ?? null,
      verifiedBy: account.verifiedBy ?? null,
      version: account.version,
      previousLast4: account.previousLast4 ?? null,
      updatedAt: account.updatedAt ?? null,
    };
  }

  /**
   * ¿El titular de la cuenta es quien figura como contribuyente? Una señal
   * para finanzas al verificar, no una regla: un titular distinto puede ser
   * legítimo (el contador, un familiar), pero es justo lo que hay que mirar.
   * `null` cuando aún no hay datos legales con qué comparar.
   */
  private holderMatchesLegal(
    account: Partial<IBusinessPayoutAccount>,
    legal?: Partial<IBusinessLegal> | null
  ): boolean | null {
    if (!legal?.documentNumber || !account.holderDocument) return null;
    const holder = account.holderDocument.replace(/\D/g, '');
    return holder === legal.documentNumber || holder === `${legal.documentNumber}${legal.dv ?? ''}`;
  }

  async getLegal(businessId: string) {
    const business = await Business.findById(businessId).select('+legal').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return this.legalView(plainLegal(business.legal, businessId));
  }

  async getPayoutAccount(businessId: string) {
    const business = await Business.findById(businessId).select('+legal +payoutAccount').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return this.payoutAccountView(business.payoutAccount, business.legal, businessId);
  }

  /**
   * Valida y normaliza los datos tributarios.
   *
   * El DV de un NIT se **calcula** aquí (módulo 11 de la DIAN) y, si el
   * cliente mandó uno, se comprueba: un DV mal digitado es el error más común
   * y termina como una factura electrónica rechazada meses después.
   */
  private normalizeLegal(input: LegalInput): Omit<IBusinessLegal, 'updatedAt' | 'updatedBy'> {
    let raw = String(input.documentNumber ?? '').trim();
    let dvFromNumber: string | null = null;

    // "900.123.456-8": el DV viene pegado al número.
    if (input.documentType === 'NIT') {
      const withDv = raw.match(/^([\d.\s]+)-\s*(\d)$/);
      if (withDv) {
        raw = withDv[1];
        dvFromNumber = withDv[2];
      }
    }

    const number = raw.replace(/[\s.\-]/g, '');
    if (!/^\d+$/.test(number)) {
      throw new AppError('El número de documento solo puede tener dígitos', 400, 'LEGAL_DOCUMENT_INVALID');
    }

    const [min, max] = input.documentType === 'CE' ? [4, 12] : [5, 10];
    if (number.length < min || number.length > max) {
      throw new AppError(
        `El número de ${input.documentType} debe tener entre ${min} y ${max} dígitos`,
        400,
        'LEGAL_DOCUMENT_INVALID'
      );
    }

    const suppliedDv =
      input.dv !== undefined && input.dv !== null && String(input.dv).trim() !== ''
        ? String(input.dv).trim()
        : dvFromNumber;

    let dv: string | null = null;
    if (input.documentType === 'NIT') {
      dv = computeNitDv(number);
      if (!dv) throw new AppError('No se pudo calcular el DV del NIT', 400, 'LEGAL_DOCUMENT_INVALID');
      if (suppliedDv !== null && suppliedDv !== dv) {
        throw new AppError(
          `El dígito de verificación no corresponde a ese NIT (el correcto es ${dv})`,
          422,
          'NIT_DV_MISMATCH'
        );
      }
    } else if (suppliedDv !== null) {
      throw new AppError('El dígito de verificación solo aplica a un NIT', 400, 'LEGAL_DOCUMENT_INVALID');
    }

    return {
      documentType: input.documentType,
      documentNumber: number,
      dv,
      legalName: input.legalName.trim(),
      legalRepName: input.legalRepName?.trim() || null,
      taxRegime: input.taxRegime ?? null,
      billingEmail: input.billingEmail?.trim().toLowerCase() || null,
    };
  }

  /**
   * Guarda los datos tributarios del comercio. Los edita su dueño (o un admin
   * con permiso); el permiso lo comprueba quien llama.
   *
   * El número de documento se guarda **cifrado** (AAD = businessId).
   *
   * Cambiar la **identidad fiscal** (tipo, número o razón social) devuelve la
   * cuenta de pago a `pendingVerification` y sube su `version`: antes, cambiar
   * el NIT fabricaba un "el titular coincide" con la cuenta que ya estaba
   * verificada, y finanzas pagaba a un titular que ya no era el contribuyente.
   * La cuenta se devuelve **antes** de escribir la identidad nueva: la ventana
   * que queda entre las dos escrituras deja la cuenta pendiente, no la
   * identidad cambiada con la cuenta aún verificada.
   */
  async setLegal(businessId: string, input: LegalInput, actorId: string, req?: Request) {
    const legal = this.normalizeLegal(input);
    const now = new Date();

    const before = await Business.findById(businessId)
      .select('name isApproved isArchived ownerId +legal +payoutAccount')
      .lean();
    if (!before) throw new AppError('Negocio no encontrado', 404);
    if (before.isArchived) throw new AppError('Negocio archivado: contacta a soporte', 403);

    const previous = plainLegal(before.legal, businessId);
    const identityChanged =
      !!previous &&
      (previous.documentNumber !== legal.documentNumber ||
        previous.documentType !== legal.documentType ||
        previous.legalName !== legal.legalName);

    let accountReset = false;
    if (identityChanged && before.payoutAccount) {
      const reset = await Business.updateOne(
        { _id: businessId, 'payoutAccount.version': before.payoutAccount.version },
        {
          $set: {
            'payoutAccount.verificationStatus': 'pendingVerification',
            'payoutAccount.verifiedAt': null,
            'payoutAccount.verifiedBy': null,
            'payoutAccount.updatedAt': now,
            // Quien cambió la identidad no puede verificar la cuenta después.
            'payoutAccount.updatedBy': actorId,
          },
          $inc: { 'payoutAccount.version': 1 },
        }
      );
      accountReset = reset.modifiedCount > 0;
    }

    const written = await Business.findOneAndUpdate(
      { _id: businessId, isArchived: { $ne: true } },
      {
        $set: {
          legal: {
            ...legal,
            documentNumber: sealForBusiness(legal.documentNumber, businessId),
            updatedAt: now,
            updatedBy: actorId,
          },
        },
      },
      { new: false }
    ).select('_id');

    if (!written) {
      const exists = await Business.exists({ _id: businessId });
      throw new AppError(exists ? 'Negocio archivado: contacta a soporte' : 'Negocio no encontrado', exists ? 403 : 404);
    }

    if (accountReset && before.ownerId) {
      await this.notifyOwner(before.ownerId, {
        title: 'Cambiaron los datos legales de tu negocio',
        body: `Se modificaron los datos legales de ${before.name}. Por seguridad, la cuenta de pago volvió a "pendiente de verificación" y no recibirá liquidaciones hasta que finanzas la revise. Si no fuiste tú, contacta a soporte de inmediato.`,
        businessId,
        kind: 'legal_identity_changed',
      });
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_LEGAL_UPDATED,
        entity: 'business',
        entityId: businessId,
        severity: before.isApproved && identityChanged ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
        description: `Datos legales de ${before.name} ${previous ? 'actualizados' : 'registrados'}${accountReset ? ': la cuenta de pago vuelve a pendiente' : ''}`,
        metadata: {
          documentType: legal.documentType,
          documentNumberMasked: `***${lastDigits(legal.documentNumber)}`,
          previousDocumentNumberMasked: previous ? `***${lastDigits(previous.documentNumber ?? '')}` : null,
          identityChanged,
          payoutAccountReset: accountReset,
          businessApproved: before.isApproved,
        },
      });
    }

    return this.legalView({ ...legal, updatedAt: now });
  }

  /** Aviso al dueño por el canal que ya existe: notificación persistida + socket + push. Nunca rompe la operación. */
  private async notifyOwner(
    ownerId: unknown,
    input: { title: string; body: string; businessId: string; kind: string }
  ) {
    try {
      await notificationService.create({
        userId: String(ownerId),
        type: NotificationType.SYSTEM,
        title: input.title,
        body: input.body,
        data: { businessId: input.businessId, kind: input.kind },
      });
    } catch (error) {
      console.error('[Business] No se pudo avisar al dueño:', error);
    }
  }

  /** Reglas de la cuenta según el método, y el número en solo dígitos. */
  private normalizePayoutAccount(input: PayoutAccountInput) {
    const number = String(input.accountNumber ?? '').replace(/[\s.\-]/g, '');
    if (!/^\d+$/.test(number)) {
      throw new AppError('El número de cuenta solo puede tener dígitos', 400, 'PAYOUT_ACCOUNT_INVALID');
    }

    let bankName: string | null = null;
    let accountType: PayoutAccountType | null = null;

    if (input.method === 'bank') {
      if (number.length < 6 || number.length > 20) {
        throw new AppError('El número de cuenta debe tener entre 6 y 20 dígitos', 400, 'PAYOUT_ACCOUNT_INVALID');
      }
      bankName = input.bankName?.trim() || null;
      accountType = input.accountType ?? null;
      if (!bankName || !accountType) {
        throw new AppError('Indica el banco y el tipo de cuenta (ahorros o corriente)', 400, 'PAYOUT_ACCOUNT_INVALID');
      }
    } else if (!/^3\d{9}$/.test(number)) {
      // Nequi y Daviplata se pagan al celular del titular.
      throw new AppError('Para Nequi o Daviplata escribe el celular del titular (10 dígitos, empieza por 3)', 400, 'PAYOUT_ACCOUNT_INVALID');
    }

    const holderDocument = String(input.holderDocument ?? '').replace(/[\s.\-]/g, '');
    if (!/^\d{5,15}$/.test(holderDocument)) {
      throw new AppError('El documento del titular solo puede tener dígitos (5 a 15)', 400, 'PAYOUT_ACCOUNT_INVALID');
    }

    return {
      method: input.method,
      bankName,
      accountType,
      number,
      holderName: input.holderName.trim(),
      holderDocument,
    };
  }

  /**
   * Cambia la cuenta de pago del comercio. Es el cambio de mayor riesgo del
   * módulo: redirige el dinero de sus ventas. Por eso:
   *   - la reautenticación (contraseña u OTP) la exige el controlador antes de
   *     llegar aquí: un token de acceso robado no basta;
   *   - el número y el documento del titular se guardan **cifrados** (AAD =
   *     businessId) y solo los 4 últimos del número en claro;
   *   - la cuenta queda en `pendingVerification` hasta que finanzas la
   *     verifique — nadie liquida a una cuenta sin verificar;
   *   - `version` sube en cada cambio, para que la verificación apunte a la
   *     cuenta que finanzas realmente revisó;
   *   - se audita como HIGH (sin el número completo) y se **avisa al dueño**
   *     con los 4 últimos dígitos anterior y nuevo.
   *
   * Un comercio suspendido no puede cambiar el destino de su dinero por su
   * cuenta (`asOwner`): lo tendría que pedir a soporte.
   */
  async setPayoutAccount(
    businessId: string,
    input: PayoutAccountInput,
    actorId: string,
    options: { asOwner?: boolean; req?: Request } = {}
  ) {
    const data = this.normalizePayoutAccount(input);
    const now = new Date();

    const before = await Business.findById(businessId)
      .select('name ownerId isApproved isSuspended isArchived +payoutAccount +legal')
      .lean();
    if (!before) throw new AppError('Negocio no encontrado', 404);
    if (before.isArchived) throw new AppError('Negocio archivado: contacta a soporte', 403);
    if (options.asOwner && before.isSuspended) {
      throw new AppError(
        'Tu negocio está suspendido: contacta a soporte para cambiar la cuenta de pago',
        403,
        'BUSINESS_SUSPENDED'
      );
    }

    // Las mismas condiciones, dentro del filtro: el negocio pudo archivarse o
    // suspenderse entre la lectura de arriba y esta escritura.
    const guard: Record<string, unknown> = { _id: businessId, isArchived: { $ne: true } };
    if (options.asOwner) guard.isSuspended = { $ne: true };

    const business = await Business.findOneAndUpdate(
      guard,
      {
        $set: {
          'payoutAccount.method': data.method,
          'payoutAccount.bankName': data.bankName,
          'payoutAccount.accountType': data.accountType,
          'payoutAccount.accountNumberEnc': encrypt(data.number, businessAad(businessId)),
          'payoutAccount.accountNumberHash': hashForSearch(`${data.method}:${data.number}`),
          'payoutAccount.accountLast4': lastDigits(data.number),
          'payoutAccount.previousLast4': before.payoutAccount?.accountLast4 ?? null,
          'payoutAccount.holderName': data.holderName,
          'payoutAccount.holderDocument': encrypt(data.holderDocument, businessAad(businessId)),
          // Todo cambio, aun del mismo número, vuelve a pedir verificación.
          'payoutAccount.verificationStatus': 'pendingVerification',
          'payoutAccount.verifiedAt': null,
          'payoutAccount.verifiedBy': null,
          'payoutAccount.updatedAt': now,
          'payoutAccount.updatedBy': actorId,
        },
        $inc: { 'payoutAccount.version': 1 },
      },
      { new: true }
    ).select('+payoutAccount +legal');

    if (!business) throw new AppError('No se pudo actualizar la cuenta: el negocio cambió de estado', 409);

    await this.notifyOwner(before.ownerId, {
      title: OWNER_CHANGE_TITLE,
      body: before.payoutAccount
        ? `Se cambió la cuenta de pago de ${before.name}: terminaba en ${before.payoutAccount.accountLast4} y ahora termina en ${lastDigits(data.number)}. Queda pendiente de verificación y no recibirá liquidaciones hasta entonces. Si no fuiste tú, contacta a soporte de inmediato.`
        : `Se registró la cuenta de pago de ${before.name} (termina en ${lastDigits(data.number)}). Queda pendiente de verificación por finanzas. Si no fuiste tú, contacta a soporte de inmediato.`,
      businessId,
      kind: 'payout_account_changed',
    });

    if (options.req) {
      await logAudit(options.req, {
        action: AuditAction.BUSINESS_PAYOUT_ACCOUNT_UPDATED,
        entity: 'business',
        entityId: businessId,
        severity: AuditSeverity.HIGH,
        description: `Cuenta de pago de ${before.name} ${before.payoutAccount ? 'cambiada' : 'registrada'}: queda pendiente de verificación`,
        metadata: {
          method: data.method,
          bankName: data.bankName,
          accountLast4: lastDigits(data.number),
          previousAccountLast4: before.payoutAccount?.accountLast4 ?? null,
          previousStatus: before.payoutAccount?.verificationStatus ?? null,
          holderDocumentMasked: `***${lastDigits(data.holderDocument)}`,
          businessApproved: before.isApproved,
          version: business.payoutAccount?.version,
        },
      });
    }

    return this.payoutAccountView(business.payoutAccount, business.legal, businessId);
  }

  /**
   * ¿Hay un certificado bancario aprobado y subido **después** del último
   * cambio de la cuenta? Sin esto, el certificado que se aprobó hace meses
   * para otra cuenta servía para verificar una cuenta nueva.
   */
  private async hasFreshBankCertificate(businessId: string, accountUpdatedAt?: Date | null): Promise<boolean> {
    if (!accountUpdatedAt) return false;
    return !!(await BusinessDocument.exists({
      businessId,
      type: 'bank_certificate',
      status: 'approved',
      fileKey: { $nin: [null, ''] },
      submittedAt: { $gte: accountUpdatedAt },
    }));
  }

  /**
   * Finanzas verifica la cuenta de pago. Reglas:
   *   - `version` es la que el verificador vio: si el comercio la cambió
   *     entretanto, 409 (no se aprueba a ciegas una cuenta distinta);
   *   - quien registró la cuenta no puede verificarla (cuatro ojos), ni el
   *     dueño del negocio ni un empleado activo suyo;
   *   - tiene que existir un `bank_certificate` aprobado y posterior al último
   *     cambio de la cuenta;
   *   - la transición `pendingVerification → verified` es un solo update
   *     condicionado.
   */
  async verifyPayoutAccount(
    businessId: string,
    verifierId: string,
    version: number,
    req?: Request,
    note?: string
  ) {
    const now = new Date();

    const current = await Business.findById(businessId).select('ownerId +payoutAccount').lean();
    if (!current) throw new AppError('Negocio no encontrado', 404);
    if (!current.payoutAccount) {
      throw new AppError('El negocio no tiene cuenta de pago registrada', 404, 'PAYOUT_ACCOUNT_MISSING');
    }
    if (current.payoutAccount.updatedBy && String(current.payoutAccount.updatedBy) === verifierId) {
      throw new AppError('Quien registró la cuenta no puede verificarla', 403, 'PAYOUT_ACCOUNT_SELF_VERIFY');
    }
    if (String(current.ownerId) === verifierId) {
      throw new AppError('El dueño del negocio no puede verificar su propia cuenta de pago', 403, 'PAYOUT_ACCOUNT_CONFLICT_OF_INTEREST');
    }
    if (await BusinessStaff.exists({ businessId, userId: verifierId, isActive: true })) {
      throw new AppError('Un empleado del negocio no puede verificar su cuenta de pago', 403, 'PAYOUT_ACCOUNT_CONFLICT_OF_INTEREST');
    }
    if (
      current.payoutAccount.version === version &&
      current.payoutAccount.verificationStatus === 'pendingVerification' &&
      !(await this.hasFreshBankCertificate(businessId, current.payoutAccount.updatedAt))
    ) {
      throw new AppError(
        'Falta un certificado bancario aprobado y posterior al último cambio de la cuenta',
        422,
        'PAYOUT_ACCOUNT_CERTIFICATE_REQUIRED'
      );
    }

    const business = await Business.findOneAndUpdate(
      {
        _id: businessId,
        ownerId: { $ne: verifierId },
        'payoutAccount.verificationStatus': 'pendingVerification',
        'payoutAccount.version': version,
        'payoutAccount.updatedBy': { $ne: verifierId },
      },
      {
        $set: {
          'payoutAccount.verificationStatus': 'verified',
          'payoutAccount.verifiedAt': now,
          'payoutAccount.verifiedBy': verifierId,
        },
      },
      { new: true }
    ).select('name +payoutAccount +legal');

    if (!business) {
      const latest = await Business.findById(businessId).select('+payoutAccount').lean();
      if (!latest) throw new AppError('Negocio no encontrado', 404);
      const account = latest.payoutAccount;
      if (!account) throw new AppError('El negocio no tiene cuenta de pago registrada', 404, 'PAYOUT_ACCOUNT_MISSING');
      if (account.version !== version) {
        throw new AppError('La cuenta cambió desde que la revisaste. Vuelve a abrirla y verifícala.', 409, 'PAYOUT_ACCOUNT_CHANGED');
      }
      if (account.verificationStatus === 'verified') {
        throw new AppError('La cuenta ya está verificada', 409, 'PAYOUT_ACCOUNT_ALREADY_VERIFIED');
      }
      if (account.updatedBy && String(account.updatedBy) === verifierId) {
        throw new AppError('Quien registró la cuenta no puede verificarla', 403, 'PAYOUT_ACCOUNT_SELF_VERIFY');
      }
      throw new AppError('No se pudo verificar la cuenta', 409);
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_PAYOUT_ACCOUNT_VERIFIED,
        entity: 'business',
        entityId: businessId,
        severity: AuditSeverity.HIGH,
        description: `Cuenta de pago de ${business.name} verificada por finanzas`,
        metadata: {
          accountLast4: business.payoutAccount?.accountLast4,
          method: business.payoutAccount?.method,
          version,
          note: note || undefined,
        },
      });
    }

    return this.payoutAccountView(business.payoutAccount, business.legal, businessId);
  }

  /**
   * El número completo de la cuenta **actual**, para que finanzas la revise
   * al verificarla (la ruta exige `requireFinanceAdmin`). Para **pagar** no se
   * usa esta: la pantalla de pago lee la foto del `Settlement`
   * (`revealSettlementPayoutAccount`), porque la actual puede haber cambiado
   * desde que se liquidó. Cada lectura queda en la auditoría con severidad
   * HIGH; el número no se registra, solo sus 4 últimos.
   */
  async revealPayoutAccount(businessId: string, req?: Request) {
    const business = await Business.findById(businessId).select('name +payoutAccount +legal').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);
    const account = business.payoutAccount;
    if (!account) throw new AppError('El negocio no tiene cuenta de pago registrada', 404, 'PAYOUT_ACCOUNT_MISSING');

    const accountNumber = decrypt(account.accountNumberEnc, businessAad(businessId));
    // `decrypt` devuelve la entrada intacta si no puede descifrar: para un
    // número de cuenta eso sería mostrar basura como si fuera el dato.
    if (accountNumber === account.accountNumberEnc) {
      throw new AppError('No se pudo descifrar el número de cuenta', 500, 'PAYOUT_ACCOUNT_UNREADABLE');
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_PAYOUT_ACCOUNT_REVEALED,
        entity: 'business',
        entityId: businessId,
        severity: AuditSeverity.HIGH,
        description: `Número de cuenta de ${business.name} consultado completo`,
        metadata: { accountLast4: account.accountLast4, method: account.method },
      });
    }

    return {
      ...this.payoutAccountView(account, business.legal, businessId),
      accountNumber,
      holderDocument: openForBusiness(account.holderDocument, businessId),
      sharedWithBusinesses: await this.sharedAccountCount(businessId, account.accountNumberHash),
    };
  }

  /** En cuántos OTROS comercios aparece la misma cuenta (mismo método y número). */
  private async sharedAccountCount(businessId: string, hash?: string | null): Promise<number> {
    if (!hash) return 0;
    return Business.countDocuments({
      _id: { $ne: businessId },
      'payoutAccount.accountNumberHash': hash,
    });
  }

  /**
   * Cola de finanzas: cuentas de pago **pendientes de verificación en
   * comercios ya aprobados** (cambios posteriores a la aprobación). La cola
   * de aprobación (`pendingApprovals`) solo lista negocios sin aprobar, así
   * que sin esto una cuenta cambiada en un comercio activo no la veía nadie.
   * Solo enmascarado: el número completo es `revealPayoutAccount`.
   */
  async pendingPayoutAccounts() {
    const businesses = await Business.find({
      isApproved: true,
      isArchived: { $ne: true },
      'payoutAccount.verificationStatus': 'pendingVerification',
    })
      .select('name ownerId +legal +payoutAccount')
      .populate('ownerId', 'name')
      .sort({ 'payoutAccount.updatedAt': 1 })
      .limit(200)
      .lean();

    const hashes = businesses.map((b) => b.payoutAccount?.accountNumberHash).filter((h): h is string => !!h);
    const counts = hashes.length
      ? await Business.aggregate<{ _id: string; n: number }>([
          { $match: { 'payoutAccount.accountNumberHash': { $in: hashes } } },
          { $group: { _id: '$payoutAccount.accountNumberHash', n: { $sum: 1 } } },
        ])
      : [];
    const byHash = new Map(counts.map((c) => [c._id, c.n]));

    return Promise.all(
      businesses.map(async (business) => {
        const account = business.payoutAccount!;
        const view = this.payoutAccountView(account, business.legal, business._id)!;
        const owner = business.ownerId as unknown as { name?: string } | null;
        return {
          businessId: String(business._id),
          businessName: business.name,
          ownerName: owner?.name ?? null,
          method: account.method,
          accountMasked: view.accountMasked,
          holderName: account.holderName,
          updatedAt: account.updatedAt ?? null,
          previousLast4: account.previousLast4 ?? null,
          // Cuántos OTROS comercios usan esta misma cuenta: una señal de alerta.
          sharedWithBusinesses: account.accountNumberHash ? Math.max(0, (byHash.get(account.accountNumberHash) ?? 1) - 1) : 0,
          // Lo que finanzas necesita para verificar sin abrir otra pantalla.
          version: account.version,
          holderMatchesLegal: view.holderMatchesLegal,
          hasFreshBankCertificate: await this.hasFreshBankCertificate(String(business._id), account.updatedAt),
        };
      })
    );
  }

  /**
   * La foto de la cuenta verificada, para guardarla en el `Settlement`.
   * Lanza 422 `PAYOUT_ACCOUNT_NOT_VERIFIED` si el comercio no tiene una
   * cuenta verificada: nadie liquida a una cuenta sin verificar.
   */
  async snapshotVerifiedPayoutAccount(businessId: string): Promise<ISettlementPayoutAccount> {
    const business = await Business.findById(businessId).select('+payoutAccount').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);
    const account = business.payoutAccount;
    if (!account || account.verificationStatus !== 'verified') {
      throw new AppError(
        !account
          ? 'El comercio no tiene cuenta de pago registrada'
          : 'La cuenta de pago del comercio está pendiente de verificación',
        422,
        'PAYOUT_ACCOUNT_NOT_VERIFIED'
      );
    }
    const plainNumber = decrypt(account.accountNumberEnc, businessAad(businessId));
    if (plainNumber === account.accountNumberEnc) {
      throw new AppError('No se pudo descifrar el número de cuenta', 500, 'PAYOUT_ACCOUNT_UNREADABLE');
    }
    return {
      version: account.version,
      method: account.method,
      bankName: account.bankName ?? null,
      accountType: account.accountType ?? null,
      accountNumberEnc: sealForBusiness(plainNumber, businessId),
      accountLast4: account.accountLast4,
      holderName: account.holderName,
      holderDocumentEnc: account.holderDocument ? sealForBusiness(openForBusiness(account.holderDocument, businessId), businessId) : null,
      verifiedBy: account.verifiedBy ?? null,
      verifiedAt: account.verifiedAt ?? null,
      snapshotAt: new Date(),
    };
  }

  /**
   * ¿Sigue la cuenta del comercio verificada y en la misma `version` que se
   * liquidó? Si no, 409 `PAYOUT_ACCOUNT_CHANGED`: alguien la cambió entre
   * liquidar y pagar (o mientras se liquidaba) y el pago no puede seguir.
   */
  async assertPayoutAccountUnchanged(businessId: string, version: number): Promise<void> {
    const same = await Business.exists({
      _id: businessId,
      'payoutAccount.verificationStatus': 'verified',
      'payoutAccount.version': version,
    });
    if (!same) {
      throw new AppError(
        'La cuenta de pago del comercio cambió o dejó de estar verificada desde que se liquidó. Revísala antes de pagar.',
        409,
        'PAYOUT_ACCOUNT_CHANGED'
      );
    }
  }

  /** Estado de la cuenta de pago, sin abrirla. Lo usan las liquidaciones. */
  async payoutAccountStatus(businessId: string): Promise<PayoutAccountState> {
    const business = await Business.findById(businessId).select('+payoutAccount').lean();
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business.payoutAccount ? business.payoutAccount.verificationStatus : 'none';
  }

  /**
   * La puerta de las liquidaciones: nadie liquida a una cuenta sin verificar.
   * Lanza 422 `PAYOUT_ACCOUNT_NOT_VERIFIED`. (La llamada desde
   * `payout.service.ts#settle` la cablea quien trabaja en liquidaciones.)
   */
  async assertPayoutAccountVerified(businessId: string): Promise<void> {
    const status = await this.payoutAccountStatus(businessId);
    if (status !== 'verified') {
      throw new AppError(
        status === 'none'
          ? 'El comercio no tiene cuenta de pago registrada'
          : 'La cuenta de pago del comercio está pendiente de verificación',
        422,
        'PAYOUT_ACCOUNT_NOT_VERIFIED'
      );
    }
  }

  /**
   * Admin-only: sets commission and merchandising.
   *
   * Ya no acepta `isApproved`. Antes se podía aprobar un negocio por aquí,
   * saltando `approve()` —la única puerta que comprueba `missingDocuments`—
   * y sin dejar `approvedBy`. Un negocio se desactiva por aquí (`isActive`),
   * pero se aprueba solo por `POST /businesses/documents/:documentId/review`
   * → `PATCH /businesses/:id/approve`.
   */
  async updateTerms(id: string, terms: BusinessTermsInput, actor?: { _id: unknown }, req?: Request): Promise<IBusiness> {
    const business = await Business.findById(id);
    if (!business) throw new AppError('Negocio no encontrado', 404);

    const previousCommissionRateBps = business.commissionRateBps;

    if (terms.commissionRateBps !== undefined) {
      business.commissionRateBps = terms.commissionRateBps;
    }
    if (terms.isFeatured !== undefined) business.isFeatured = terms.isFeatured;
    if (terms.isActive !== undefined) business.isActive = terms.isActive;
    if (terms.minOrder !== undefined) business.minOrder = terms.minOrder;

    await business.save();

    if (req && terms.commissionRateBps !== undefined && terms.commissionRateBps !== previousCommissionRateBps) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_TERMS_UPDATED,
        entity: 'business',
        entityId: id,
        severity: AuditSeverity.HIGH,
        description: `Comisión de ${business.name} cambiada de ${previousCommissionRateBps} a ${terms.commissionRateBps} bps`,
        metadata: { previousCommissionRateBps, commissionRateBps: terms.commissionRateBps },
      });
    }

    return business;
  }

  /**
   * Archiva un comercio (S11): nunca se borra de verdad. Sale de la app y
   * del catálogo —mismo filtro que `isApproved`/`isActive`— pero conserva
   * pedidos, liquidaciones y reseñas, y es reversible con `restore()`.
   */
  async archive(id: string, adminId: string, reason: string, req?: Request): Promise<IBusiness> {
    if (!reason || !reason.trim()) throw new AppError('El motivo de archivado es obligatorio', 400);

    const business = await Business.findOneAndUpdate(
      { _id: id, isArchived: { $ne: true } },
      {
        $set: {
          isArchived: true,
          archivedAt: new Date(),
          archivedBy: adminId,
          archiveReason: reason.trim(),
          isActive: false,
        },
      },
      { new: true }
    );
    if (!business) {
      const exists = await Business.exists({ _id: id });
      throw new AppError(exists ? 'El negocio ya está archivado' : 'Negocio no encontrado', exists ? 409 : 404);
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_ARCHIVED,
        entity: 'business',
        entityId: id,
        severity: AuditSeverity.HIGH,
        description: `Negocio ${business.name} archivado: ${reason.trim()}`,
        metadata: { reason: reason.trim() },
      });
    }

    return business;
  }

  async restore(id: string, req?: Request): Promise<IBusiness> {
    const business = await Business.findOneAndUpdate(
      { _id: id, isArchived: true },
      { $set: { isArchived: false, archivedAt: null, archivedBy: null, archiveReason: null } },
      { new: true }
    );
    if (!business) {
      const exists = await Business.exists({ _id: id });
      throw new AppError(exists ? 'El negocio no está archivado' : 'Negocio no encontrado', exists ? 409 : 404);
    }

    if (req) {
      await logAudit(req, {
        action: AuditAction.BUSINESS_RESTORED,
        entity: 'business',
        entityId: id,
        severity: AuditSeverity.MEDIUM,
        description: `Negocio ${business.name} restaurado del archivo`,
      });
    }

    return business;
  }

  async getAll(query: {
    city?: string;
    category?: string;
    featured?: boolean;
    search?: string;
    lat?: number;
    lng?: number;
    maxDistance?: number;
    page?: number;
    limit?: number;
    includeInactive?: boolean;
    includeArchived?: boolean;
  }) {
    const {
      city = 'Garzón',
      category,
      featured,
      search,
      lat,
      lng,
      maxDistance = 10000,
      page = 1,
      limit = 20,
      includeInactive,
      includeArchived,
    } = query;

    const skip = (page - 1) * limit;

    // Geospatial queries with $near don't support countDocuments — use $geoWithin + aggregation
    if (lat && lng) {
      // Los filtros van dentro de `$geoNear`, no en un `$match` aparte:
      // esa etapa tiene que ser la primera del pipeline, así que lo que se
      // le pase por `query` es lo único que puede recortar antes de medir.
      const geoMatch: Record<string, unknown> = {};

      // Unapproved businesses are invisible to customers. Approval is what
      // fixes the commercial terms, so selling through one before an admin
      // has agreed them would mean taking orders with no agreed commission.
      if (!includeInactive) {
        geoMatch.isActive = true;
        geoMatch.isApproved = true;
        geoMatch.isSuspended = { $ne: true };
      }
      if (!includeArchived) geoMatch.isArchived = { $ne: true };
      if (category) geoMatch.category = category;
      if (featured) geoMatch.isFeatured = true;
      if (search) geoMatch.name = { $regex: escapeRegex(search), $options: 'i' };
      if (city) geoMatch.city = city;

      const pipeline: mongoose.PipelineStage[] = [
        {
          // `$geoNear` en vez de `$geoWithin` por una sola razón: devuelve
          // la distancia además de filtrar. Con `$geoWithin` había que
          // recalcularla en el cliente a partir de dos coordenadas, y el
          // cliente no siempre tiene la suya.
          $geoNear: {
            near: { type: 'Point' as const, coordinates: [lng, lat] },
            distanceField: 'distanceMeters',
            maxDistance,
            query: geoMatch,
            spherical: true,
          },
        },
        // `$geoNear` devuelve el documento crudo (ni respeta `select: false`):
        // lista blanca para que no salgan comisión, dueño ni reputación.
        { $project: { ...PUBLIC_LIST_PROJECTION, distanceMeters: 1 } },
        {
          $facet: {
            businesses: [
              { $sort: { isFeatured: -1, rating: -1 } },
              { $skip: skip },
              { $limit: limit },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ];

      const [result] = await Business.aggregate(pipeline);
      const businesses = result.businesses as IBusiness[];
      const total = result.total[0]?.count || 0;

      return {
        businesses,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    // Non-geospatial path (no lat/lng provided)
    const filter: Record<string, unknown> = { city };
    if (!includeInactive) {
      filter.isActive = true;
      filter.isApproved = true;
      filter.isSuspended = { $ne: true };
    }
    if (!includeArchived) filter.isArchived = { $ne: true };
    if (category) filter.category = category;
    if (featured) filter.isFeatured = true;
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };

    const [businesses, total] = await Promise.all([
      Business.find(filter).select(PUBLIC_LIST_FIELDS).skip(skip).limit(limit).sort({ isFeatured: -1, rating: -1 }),
      Business.countDocuments(filter),
    ]);

    return {
      businesses,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * La ficha, sin la carta.
   *
   * Antes poblaba `products`: la carta entera (con sus variantes de imagen
   * calculadas) viajaba en cada apertura de la ficha y en cada comprobación
   * de propiedad del panel, y ningún cliente la leía de aquí — la app y el
   * panel la piden a `/products/business/:id`, que además filtra lo no
   * disponible.
   */
  async getById(id: string): Promise<IBusiness> {
    const business = await Business.findById(id);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business;
  }

  async getBySlug(slug: string): Promise<IBusiness> {
    const business = await Business.findOne({ slug });
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business;
  }

  /**
   * La ficha pública sin sesión, por id (S1).
   *
   * `getById` devuelve el documento entero —lo necesita `assertOwnsBusiness`,
   * que compara `ownerId`— así que no se puede usar para servir la ruta
   * pública `/businesses/:id`. Esta es la que sí: mismo proyecto de campos
   * que `getPublicBySlug` y la misma exigencia de `isApproved` y no
   * archivado, para no filtrar `commissionRate(Bps)`/`ownerId` ni exponer un
   * negocio que un admin nunca aprobó o que ya se archivó.
   */
  async getPublicById(id: string) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError('Negocio no encontrado', 404);
    const business = await Business.findOne({
      _id: id,
      isApproved: true,
      isArchived: { $ne: true },
      isSuspended: { $ne: true },
    }).select(PUBLIC_BUSINESS_FIELDS);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business;
  }

  /**
   * La ficha de un negocio, para la página pública que se comparte fuera de
   * la app (el enlace del botón "Compartir").
   *
   * A diferencia de `getBySlug` —que alimenta la app y necesita el
   * documento completo—, esta lee con un `.select()` explícito: quien la
   * llama no está autenticado, puede ser cualquiera en internet, y hasta un
   * bot indexando enlaces compartidos. `commissionRate`/`commissionRateBps`
   * no llevan `select: false` en el esquema porque la app misma los
   * necesitaba con sesión de por medio; aquí no hay sesión, así que se
   * excluyen a mano en vez de heredar por accidente el mismo descuido que
   * ya tiene `getBySlug` desde antes de esta función (no se toca ese
   * método: es una decisión aparte que no se tomó en este cambio).
   *
   * Exige `isApproved`: un negocio que nunca llegó a aprobarse no debería
   * tener una ficha pública circulando, aunque alguien conozca su slug.
   */
  async getPublicBySlug(slug: string) {
    const business = await Business.findOne({
      slug,
      isApproved: true,
      isArchived: { $ne: true },
      isSuspended: { $ne: true },
    }).select(PUBLIC_BUSINESS_FIELDS);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business;
  }

  /**
   * Updates the operational profile of a business.
   *
   * Commercial terms cannot arrive here: the validator strips them and this
   * method deletes them defensively, so neither a crafted request nor a
   * future schema slip can let a merchant reprice itself.
   */
  async update(id: string, ownerId: string, data: Partial<CreateBusinessInput>, isAdmin = false): Promise<IBusiness> {
    const business = await Business.findById(id);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    if (!isAdmin && business.ownerId.toString() !== ownerId) throw new AppError('No autorizado', 403);
    if (!isAdmin && business.isArchived) {
      throw new AppError('Negocio archivado: contacta a soporte para reactivarlo', 403);
    }

    // Cambiar a una categoría de alimentos después de aprobado saltaba el
    // concepto sanitario: `approve()` lo exige según la categoría de ESE día.
    if (
      business.isApproved &&
      data.category !== undefined &&
      data.category !== business.category &&
      FOOD_CATEGORIES.includes(data.category) &&
      !FOOD_CATEGORIES.includes(business.category)
    ) {
      const permit = await BusinessDocument.findOne({
        businessId: id,
        type: 'health_permit',
        status: 'approved',
      }).lean();
      if (!permit || (permit.expiresAt && permit.expiresAt < new Date())) {
        throw new AppError(
          'Para pasar a una categoría de alimentos necesitas un concepto sanitario aprobado y vigente',
          409,
          'HEALTH_PERMIT_REQUIRED'
        );
      }
    }

    const payload = { ...data } as Record<string, unknown>;
    for (const forbidden of [
      'commissionRate',
      'commissionRateBps',
      'isFeatured',
      'isApproved',
      'approvedAt',
      'approvedBy',
      'ownerId',
      'rating',
      'totalReviews',
      // A1: la suspensión es de ZIPP; el dueño no puede quitársela con un
      // PUT. `isActive` sí queda para él (su "abierto/cerrado").
      'isSuspended',
      'suspendedAt',
      'suspendedBy',
      'suspensionReason',
      'isArchived',
      'archivedAt',
      'archivedBy',
      'archiveReason',
      // Datos fiscales y cuenta de pago solo por sus endpoints propios, que
      // auditan y (la cuenta) piden verificación: por un PUT genérico
      // cambiarían el destino del dinero sin rastro.
      'legal',
      'payoutAccount',
    ]) {
      delete payload[forbidden];
    }

    if (payload.longitude !== undefined && payload.latitude !== undefined) {
      payload.location = {
        type: 'Point',
        coordinates: [payload.longitude, payload.latitude],
      };
      delete payload.longitude;
      delete payload.latitude;
    }

    Object.assign(business, payload);
    await business.save();
    return business;
  }

  /**
   * C1: un negocio no se elimina. Con pedidos, liquidaciones y reseñas
   * colgando de su `_id`, un borrado duro es corrupción de datos con forma
   * de función. El camino real es `archive` (S11), que soporte ejecuta.
   */
  async delete(_id: string, _ownerId: string, _isAdmin = false): Promise<never> {
    throw new AppError(
      'Un negocio no se elimina, se archiva. Contacta a soporte para archivarlo.',
      405
    );
  }

  async getByOwner(ownerId: string): Promise<IBusiness[]> {
    return Business.find({ ownerId }).sort({ createdAt: -1 });
  }

  // Check if business is currently open based on schedule
  isCurrentlyOpen(business: IBusiness): boolean {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    const now = new Date();
    const dayName = days[now.getDay()];
    const schedule = business.schedule?.[dayName];
    if (!schedule || !schedule.isOpen) return false;

    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return currentTime >= schedule.open && currentTime <= schedule.close;
  }
}

export const businessService = new BusinessService();
