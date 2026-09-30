import { Types } from 'mongoose';
import {
  Address,
  Driver,
  DriverContract,
  DriverDocument,
  User,
  MAX_CONTRACT_HISTORY,
  MAX_CONTRACT_EXTRA_FILES,
  MAX_DRIVER_DOCUMENT_HISTORY,
} from '../models';
import type { DriverContractStatus, DriverDocumentEvent } from '../models';
import { AuditLog, AuditAction } from '../security';
import { AppError } from '../middlewares/errorHandler';
import { pushService } from './push.service';
import { storePrivateFile } from './privateStorage.service';
import { readContractFile, readDriverDocumentFile, type DossierFileBytes } from './driverDossierFiles';
import { buildDossierPdf, type DossierPdfInput } from './driverDossierPdf.service';
import {
  DOSSIER_DOCUMENTS,
  accountStatus,
  documentIndicator,
  documentMessage,
  effectiveExpiry,
  summarizeCompliance,
  type DocumentIndicator,
  type DossierAccountStatus,
  type DossierGroup,
} from './driverDossier.logic';

/**
 * Expediente digital del domiciliario.
 *
 * No duplica nada: lee los mismos `Driver`, `User`, `DriverDocument` y
 * `Address` de siempre y añade lo que faltaba (historial por documento,
 * solicitud de actualización, datos del vehículo y el contrato). Los archivos
 * salen siempre por `readDriverDocumentFile` / `readContractFile`, es decir,
 * con el permiso ya comprobado y sin exponer nunca una URL del almacén.
 */

export interface DossierDocumentView {
  type: string;
  label: string;
  group: DossierGroup;
  indicator: DocumentIndicator;
  message: string;
  /** Ausente si el documento no se ha cargado. */
  documentId?: string;
  /** `submittedAt` en ms: el panel lo devuelve al aprobar/rechazar para detectar un reenvío. */
  revision?: number;
  status?: string;
  reference?: string;
  uploadedAt?: Date;
  issuedAt?: Date;
  expiresAt?: Date;
  /** Vence según el papel, o según la política de antecedentes cuando no trae fecha. */
  effectiveExpiresAt?: Date;
  reviewedAt?: Date;
  reviewedByName?: string;
  rejectionReason?: string;
  updateRequest?: { reason: string; requestedAt: Date };
  hasFile: boolean;
  history: Array<{ action: DriverDocumentEvent; at: Date; byName?: string; note?: string }>;
}

export interface ContractFileView {
  id: string;
  name: string;
  format: string;
  bytes: number;
  uploadedAt: Date;
}

export interface DossierView {
  driverId: string;
  person: {
    name: string;
    avatar?: string;
    documentType?: string;
    documentNumber?: string;
    phone?: string;
    email?: string;
    city?: string;
    address?: string;
    registeredAt?: Date;
    linkedAt?: Date;
    lastActivityAt?: Date;
    status: DossierAccountStatus;
    emergencyContact?: { name: string; phone: string; relationship?: string };
  };
  vehicle: { type: string; plate?: string; brand?: string; model?: string; color?: string; year?: number; engineCc?: number; ownerName?: string };
  licenseCategory?: string;
  documents: DossierDocumentView[];
  compliance: ReturnType<typeof summarizeCompliance>;
  contract: {
    status?: DriverContractStatus;
    startDate?: Date;
    endDate?: Date;
    file?: ContractFileView;
    extraFiles: ContractFileView[];
    history: Array<{ action: string; at: Date; byName?: string; note?: string }>;
  };
}

let exportBusy = false;
const MAX_EXPORT_ANNEX_BYTES = 40 * 1024 * 1024;

const VEHICLE_LABEL: Record<string, string> = { motorcycle: 'Moto', bicycle: 'Bicicleta' };

async function actorName(userId: string): Promise<string | undefined> {
  const user = await User.findById(userId).select('name').lean();
  return user?.name;
}

function assertObjectId(id: string, what = 'Identificador') {
  if (!Types.ObjectId.isValid(id)) throw new AppError(`${what} inválido`, 400);
}

const historyEntry = (action: DriverDocumentEvent, byUserId: string, byName: string | undefined, note?: string) => ({
  action,
  at: new Date(),
  byUserId: new Types.ObjectId(byUserId),
  ...(byName ? { byName } : {}),
  ...(note ? { note } : {}),
});

const pushHistory = (entry: object) => ({ $each: [entry], $slice: -MAX_DRIVER_DOCUMENT_HISTORY });

export const driverDossierService = {
  async build(driverId: string, now = new Date()): Promise<DossierView> {
    assertObjectId(driverId, 'Identificador de domiciliario');

    const driver = await Driver.findById(driverId).populate(
      'userId',
      'name avatar phone email documentType documentNumber lastLoginAt createdAt'
    );
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    const user = driver.userId as unknown as {
      _id: Types.ObjectId;
      name: string;
      avatar?: string;
      phone?: string;
      email?: string;
      documentType?: string;
      documentNumber?: string;
      lastLoginAt?: Date;
      createdAt?: Date;
    } | null;
    if (!user) throw new AppError('El domiciliario no tiene usuario asociado', 404);

    const [docs, contract, address, approval] = await Promise.all([
      DriverDocument.find({ driverId: driver._id })
        .select('+history')
        .populate('reviewedBy', 'name')
        .lean(),
      DriverContract.findOne({ driverId: driver._id }).lean(),
      Address.findOne({ userId: user._id }).sort({ isDefault: -1, createdAt: -1 }).select('address apartment neighborhood city').lean(),
      driver.approvedAt
        ? null
        : AuditLog.findOne({ entity: 'driver', entityId: driverId, action: AuditAction.DRIVER_APPROVED })
            .sort({ timestamp: 1 })
            .select('timestamp')
            .lean(),
    ]);

    const byType = new Map(docs.map((d) => [d.type as string, d]));

    const documents: DossierDocumentView[] = DOSSIER_DOCUMENTS.map((spec) => {
      const doc = byType.get(spec.type) ?? null;
      const indicator = documentIndicator(spec.type, doc, now);
      const expiry = doc ? effectiveExpiry(spec.type, doc) : null;
      const reviewer = doc?.reviewedBy as unknown as { name?: string } | undefined;
      return {
        type: spec.type,
        label: spec.label,
        group: spec.group,
        indicator,
        message: documentMessage(spec, indicator, expiry, now),
        documentId: doc ? String(doc._id) : undefined,
        revision: doc?.submittedAt ? doc.submittedAt.getTime() : undefined,
        status: doc?.status,
        reference: doc?.reference,
        uploadedAt: doc?.submittedAt ?? doc?.createdAt,
        issuedAt: doc?.issuedAt ?? undefined,
        expiresAt: doc?.expiresAt ?? undefined,
        effectiveExpiresAt: expiry ?? undefined,
        reviewedAt: doc?.reviewedAt ?? undefined,
        reviewedByName: reviewer?.name,
        rejectionReason: doc?.rejectionReason ?? undefined,
        updateRequest: doc?.updateRequest
          ? { reason: doc.updateRequest.reason, requestedAt: doc.updateRequest.requestedAt }
          : undefined,
        hasFile: !!(doc && (doc.imageKey || doc.imageUrl)),
        history: [...(doc?.history ?? [])].sort((a, b) => b.at.getTime() - a.at.getTime()),
      };
    });

    const compliance = summarizeCompliance(
      documents.map((d, i) => ({ spec: DOSSIER_DOCUMENTS[i], indicator: d.indicator, message: d.message }))
    );

    const toFileView = (f: { key: string; format: string; bytes: number; uploadedAt: Date }, id: string, name: string): ContractFileView => ({
      id,
      name,
      format: f.format,
      bytes: f.bytes,
      uploadedAt: f.uploadedAt,
    });

    return {
      driverId,
      person: {
        name: user.name,
        avatar: user.avatar,
        documentType: user.documentType,
        documentNumber: user.documentNumber,
        phone: user.phone,
        email: user.email,
        city: address?.city || undefined,
        address: address
          ? [address.address, address.apartment, address.neighborhood].filter(Boolean).join(', ')
          : undefined,
        registeredAt: user.createdAt,
        linkedAt: contract?.startDate ?? driver.approvedAt ?? approval?.timestamp,
        lastActivityAt: driver.lastLocationAt ?? user.lastLoginAt,
        status: accountStatus(driver, docs),
        emergencyContact: driver.emergencyContact
          ? { name: driver.emergencyContact.name, phone: driver.emergencyContact.phone, relationship: driver.emergencyContact.relationship }
          : undefined,
      },
      vehicle: {
        type: VEHICLE_LABEL[driver.vehicleType] ?? driver.vehicleType,
        plate: driver.licensePlate,
        brand: driver.vehicle?.brand,
        model: driver.vehicle?.model,
        color: driver.vehicle?.color,
        year: driver.vehicle?.year,
        engineCc: driver.vehicle?.engineCc,
        ownerName: driver.vehicle?.ownerName,
      },
      licenseCategory: driver.license?.category,
      documents,
      compliance,
      contract: {
        status: contract?.status,
        startDate: contract?.startDate,
        endDate: contract?.endDate,
        file: contract?.file ? toFileView(contract.file, 'contract', 'Contrato de prestación de servicios') : undefined,
        extraFiles: (contract?.extraFiles ?? []).map((f) => toFileView(f, String(f._id), f.name)),
        history: [...(contract?.history ?? [])].sort((a, b) => b.at.getTime() - a.at.getTime()),
      },
    };
  },

  // ── Archivos ───────────────────────────────────────────────────────

  async readDocumentFile(driverId: string, documentId: string): Promise<{ file: DossierFileBytes; label: string; type: string }> {
    assertObjectId(driverId);
    assertObjectId(documentId);
    // El documento se busca por AMBOS ids: un administrador con permiso sobre
    // un domiciliario no debe poder leer el documento de otro cambiando la ruta.
    const doc = await DriverDocument.findOne({ _id: documentId, driverId });
    if (!doc) throw new AppError('Documento no encontrado', 404);
    const spec = DOSSIER_DOCUMENTS.find((s) => s.type === doc.type);
    return { file: await readDriverDocumentFile(doc), label: spec?.label ?? doc.type, type: doc.type };
  },

  async readContractAsset(driverId: string, which: string): Promise<{ file: DossierFileBytes; label: string }> {
    assertObjectId(driverId);
    const contract = await DriverContract.findOne({ driverId });
    if (!contract) throw new AppError('El domiciliario no tiene contrato registrado', 404);
    if (which === 'contract') {
      if (!contract.file) throw new AppError('El contrato no tiene archivo', 404);
      return { file: await readContractFile(contract.file), label: 'Contrato de prestación de servicios' };
    }
    assertObjectId(which, 'Identificador de anexo');
    const extra = contract.extraFiles.find((f) => String(f._id) === which);
    if (!extra) throw new AppError('Anexo no encontrado', 404);
    return { file: await readContractFile(extra), label: extra.name };
  },

  // ── Acciones sobre documentos ──────────────────────────────────────

  /** Deja constancia de quién aprobó o rechazó. Lo llama `driverService.reviewDocument`. */
  async recordReview(documentId: string, adminId: string, status: 'approved' | 'rejected', reason?: string) {
    const name = await actorName(adminId);
    await DriverDocument.updateOne(
      { _id: documentId },
      { $push: { history: pushHistory(historyEntry(status, adminId, name, reason)) }, $unset: { updateRequest: 1 } }
    );
  },

  /**
   * Pide una versión nueva. No toca `status`: un papel vigente sigue
   * habilitando al domiciliario hasta que venza o él lo reemplace.
   */
  async requestUpdate(driverId: string, documentId: string, adminId: string, reason: string) {
    assertObjectId(driverId);
    assertObjectId(documentId);
    const name = await actorName(adminId);
    const doc = await DriverDocument.findOneAndUpdate(
      { _id: documentId, driverId },
      {
        $set: { updateRequest: { reason, requestedAt: new Date(), requestedBy: new Types.ObjectId(adminId) } },
        $push: { history: pushHistory(historyEntry('update_requested', adminId, name, reason)) },
      },
      { new: true }
    );
    if (!doc) throw new AppError('Documento no encontrado', 404);

    const driver = await Driver.findById(driverId).select('userId').lean();
    const label = DOSSIER_DOCUMENTS.find((s) => s.type === doc.type)?.short ?? 'documento';
    if (driver?.userId) {
      // El aviso no debe tumbar la acción: el motivo ya quedó guardado y la app lo muestra en Documentos.
      await pushService
        .sendToUser(String(driver.userId), {
          title: `Actualiza tu ${label}`,
          body: reason,
          data: { type: 'document_update_requested', scope: 'driver', documentType: doc.type },
        })
        .catch((error) => console.error('[driver-dossier] push', error));
    }
    return { type: doc.type };
  },

  /** Nota interna: nunca llega al domiciliario. */
  async addObservation(driverId: string, documentId: string, adminId: string, note: string) {
    assertObjectId(driverId);
    assertObjectId(documentId);
    const name = await actorName(adminId);
    const doc = await DriverDocument.findOneAndUpdate(
      { _id: documentId, driverId },
      { $push: { history: pushHistory(historyEntry('observation', adminId, name, note)) } },
      { new: true }
    );
    if (!doc) throw new AppError('Documento no encontrado', 404);
    return { type: doc.type };
  },

  // ── Vehículo ───────────────────────────────────────────────────────

  async updateVehicle(
    driverId: string,
    input: { brand?: string; model?: string; color?: string; year?: number; engineCc?: number; ownerName?: string; licenseCategory?: string; licensePlate?: string }
  ) {
    assertObjectId(driverId);
    const set: Record<string, unknown> = {};
    for (const key of ['brand', 'model', 'color', 'year', 'engineCc', 'ownerName'] as const) {
      if (input[key] !== undefined) set[`vehicle.${key}`] = input[key];
    }
    if (input.licenseCategory !== undefined) set['license.category'] = input.licenseCategory;
    if (input.licensePlate !== undefined) set.licensePlate = input.licensePlate.toUpperCase();
    if (Object.keys(set).length === 0) throw new AppError('No hay cambios para guardar', 400);
    const driver = await Driver.findByIdAndUpdate(driverId, { $set: set }, { new: true });
    if (!driver) throw new AppError('Domiciliario no encontrado', 404);
    return driver;
  },

  // ── Contrato ───────────────────────────────────────────────────────

  async upsertContract(
    driverId: string,
    adminId: string,
    input: { status: DriverContractStatus; startDate?: Date | null; endDate?: Date | null; note?: string }
  ) {
    assertObjectId(driverId);
    if (!(await Driver.exists({ _id: driverId }))) throw new AppError('Domiciliario no encontrado', 404);
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new AppError('La fecha de finalización no puede ser anterior a la de inicio', 400);
    }
    if (input.status === 'active' && !input.startDate) {
      throw new AppError('Un contrato vigente necesita fecha de inicio', 400);
    }

    const name = await actorName(adminId);
    const existing = await DriverContract.exists({ driverId });
    const entry = {
      at: new Date(),
      byUserId: new Types.ObjectId(adminId),
      ...(name ? { byName: name } : {}),
      action: existing ? 'updated' : 'created',
      note: input.note ?? `Estado: ${input.status}`,
    };

    // Una fecha ausente se borra: `$set` con `undefined` no es una instrucción clara para Mongo.
    const $set: Record<string, unknown> = { status: input.status };
    const $unset: Record<string, 1> = {};
    if (input.startDate) $set.startDate = input.startDate;
    else $unset.startDate = 1;
    if (input.endDate) $set.endDate = input.endDate;
    else $unset.endDate = 1;

    return DriverContract.findOneAndUpdate(
      { driverId },
      {
        $set,
        ...(Object.keys($unset).length ? { $unset } : {}),
        $push: { history: { $each: [entry], $slice: -MAX_CONTRACT_HISTORY } },
      },
      { upsert: true, new: true, runValidators: true }
    );
  },

  /** Sube el contrato firmado (`extraName` ausente) o un anexo. Devuelve el contrato actualizado. */
  async attachContractFile(driverId: string, adminId: string, buffer: Buffer, extraName?: string) {
    assertObjectId(driverId);
    const contract = await DriverContract.findOne({ driverId });
    if (!contract) throw new AppError('Registra primero el contrato para poder adjuntarle archivos', 409);
    if (extraName && contract.extraFiles.length >= MAX_CONTRACT_EXTRA_FILES) {
      throw new AppError(`Un contrato admite hasta ${MAX_CONTRACT_EXTRA_FILES} documentos adicionales`, 409);
    }

    const stored = await storePrivateFile(buffer, {
      folder: `zipp/driver-contracts/${driverId}`,
      maxBytes: 8 * 1024 * 1024,
    });
    const name = await actorName(adminId);
    const fileFields = {
      key: stored.key,
      resourceType: stored.resourceType,
      format: stored.format,
      bytes: stored.bytes,
      uploadedAt: new Date(),
      uploadedBy: new Types.ObjectId(adminId),
    };
    const entry = {
      at: new Date(),
      byUserId: new Types.ObjectId(adminId),
      ...(name ? { byName: name } : {}),
      action: extraName ? 'extra_uploaded' : 'file_uploaded',
      note: extraName ?? 'Contrato firmado',
    };

    const updated = await DriverContract.findOneAndUpdate(
      // El tope va también en el filtro: dos subidas a la vez no pasan de MAX.
      { _id: contract._id, ...(extraName ? { [`extraFiles.${MAX_CONTRACT_EXTRA_FILES - 1}`]: { $exists: false } } : {}) },
      {
        ...(extraName
          ? { $push: { extraFiles: { ...fileFields, name: extraName }, history: { $each: [entry], $slice: -MAX_CONTRACT_HISTORY } } }
          : { $set: { file: fileFields }, $push: { history: { $each: [entry], $slice: -MAX_CONTRACT_HISTORY } } }),
      },
      { new: true }
    );
    if (!updated) throw new AppError(`Un contrato admite hasta ${MAX_CONTRACT_EXTRA_FILES} documentos adicionales`, 409);
    return updated;
  },

  async removeContractExtra(driverId: string, adminId: string, fileId: string) {
    assertObjectId(driverId);
    assertObjectId(fileId, 'Identificador de anexo');
    const name = await actorName(adminId);
    const before = await DriverContract.findOne({ driverId, 'extraFiles._id': fileId }).select('extraFiles').lean();
    const removedName = before?.extraFiles.find((f) => String(f._id) === fileId)?.name;
    const contract = await DriverContract.findOneAndUpdate(
      { driverId, 'extraFiles._id': fileId },
      {
        $pull: { extraFiles: { _id: fileId } },
        $push: {
          history: {
            $each: [
              {
                at: new Date(),
                byUserId: new Types.ObjectId(adminId),
                ...(name ? { byName: name } : {}),
                action: 'extra_removed',
                note: removedName ? `Retirado: ${removedName}` : 'Anexo retirado del expediente',
              },
            ],
            $slice: -MAX_CONTRACT_HISTORY,
          },
        },
      },
      { new: true }
    );
    if (!contract) throw new AppError('Anexo no encontrado', 404);
    return contract;
  },

  // ── PDF ────────────────────────────────────────────────────────────

  /**
   * Expediente completo en PDF. Un anexo que no se pueda leer no aborta el
   * documento: queda una hoja que lo dice (y el fallo vuelve en `skipped`
   * para la auditoría) — perder el expediente entero por una foto rota
   * dejaría al administrador sin nada.
   */
  async exportPdf(driverId: string, generatedBy: string): Promise<{ pdf: Buffer; fileName: string; annexes: number; skipped: string[] }> {
    // Un export a la vez: baja hasta ~18 archivos a memoria y `pdf-lib` los procesa de forma
    // síncrona; con una sola instancia, varios a la vez pararían también los sockets de pedidos.
    if (exportBusy) throw new AppError('Ya hay un expediente generándose. Espera unos segundos.', 429);
    exportBusy = true;
    try {
      return await this.buildExport(driverId, generatedBy);
    } finally {
      exportBusy = false;
    }
  },

  async buildExport(driverId: string, generatedBy: string): Promise<{ pdf: Buffer; fileName: string; annexes: number; skipped: string[] }> {
    const dossier = await this.build(driverId);
    const skipped: string[] = [];
    let annexBytes = 0;

    const load = async (title: string, caption: string, reader: () => Promise<DossierFileBytes>) => {
      try {
        const file = await reader();
        // Tope del total: lo que sobre queda como hoja de "omitido" en vez de agotar la memoria.
        if (annexBytes + file.buffer.length > MAX_EXPORT_ANNEX_BYTES) {
          skipped.push(title);
          return { title, caption, error: 'Omitido: el expediente superó el tamaño máximo. Descárgalo por separado.' };
        }
        annexBytes += file.buffer.length;
        return { title, caption, file: { buffer: file.buffer, format: file.format } };
      } catch (error) {
        skipped.push(title);
        return { title, caption, error: error instanceof Error ? error.message : 'No se pudo leer el archivo.' };
      }
    };

    const annexes: DossierPdfInput['annexes'] = [];
    for (const d of dossier.documents) {
      if (!d.documentId || !d.hasFile) continue;
      const documentId = d.documentId;
      annexes.push(
        await load(d.label, `${d.message}${d.reference ? ` · Ref. ${d.reference}` : ''}`, async () =>
          (await this.readDocumentFile(driverId, documentId)).file
        )
      );
    }
    if (dossier.contract.file) {
      annexes.push(await load('Contrato de prestación de servicios', 'Contrato firmado', async () =>
        (await this.readContractAsset(driverId, 'contract')).file));
    }
    for (const extra of dossier.contract.extraFiles) {
      annexes.push(await load(extra.name, 'Documento adicional del contrato', async () =>
        (await this.readContractAsset(driverId, extra.id)).file));
    }

    const pdf = await buildDossierPdf({
      driverId,
      generatedAt: new Date(),
      generatedBy,
      person: {
        name: dossier.person.name,
        documentNumber: [dossier.person.documentType, dossier.person.documentNumber].filter(Boolean).join(' ') || undefined,
        phone: dossier.person.phone,
        email: dossier.person.email,
        city: dossier.person.city,
        address: dossier.person.address,
        registeredAt: dossier.person.registeredAt,
        linkedAt: dossier.person.linkedAt,
        lastActivityAt: dossier.person.lastActivityAt,
        status: dossier.person.status,
        emergencyContact: dossier.person.emergencyContact
          ? `${dossier.person.emergencyContact.name}${dossier.person.emergencyContact.relationship ? ` (${dossier.person.emergencyContact.relationship})` : ''} · ${dossier.person.emergencyContact.phone}`
          : undefined,
      },
      vehicle: dossier.vehicle,
      compliance: { upToDate: dossier.compliance.upToDate, issues: dossier.compliance.issues },
      documents: dossier.documents.map((d) => ({
        label: d.label,
        indicator: d.indicator,
        uploadedAt: d.uploadedAt,
        issuedAt: d.issuedAt,
        expiresAt: d.effectiveExpiresAt,
        reviewedAt: d.reviewedAt,
        reviewedByName: d.reviewedByName,
        rejectionReason: d.rejectionReason,
        history: d.history,
      })),
      contract: {
        status: dossier.contract.status,
        startDate: dossier.contract.startDate,
        endDate: dossier.contract.endDate,
        extraNames: dossier.contract.extraFiles.map((f) => f.name),
        history: dossier.contract.history,
      },
      annexes,
    });

    const safeName = dossier.person.name.normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'domiciliario';
    return { pdf, fileName: `expediente-${safeName}.pdf`, annexes: annexes.length, skipped };
  },
};
