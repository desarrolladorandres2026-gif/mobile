import { Types } from 'mongoose';
import { LegalAcceptance, LegalDocument, ILegalDocument, LegalDocumentKind } from '../models';
import { AppError } from '../middlewares/errorHandler';

/**
 * Documentos legales versionados.
 *
 * Un documento publicado es la evidencia de lo que aceptó cada persona, así
 * que NO se edita: cambiarlo en sitio dejaría "aceptó la versión 1.0" apuntando
 * a un texto que ya no es el que vio. Para cambiar algo se publica una versión
 * nueva; la anterior queda archivada con sus aceptaciones intactas.
 */

/** Publicada la nueva, de cada tipo solo la más reciente queda vigente. */
export async function publishLegalDocument(input: {
  kind: LegalDocumentKind; version: string; title: string; content: string; changeNote?: string; adminId: string;
}): Promise<ILegalDocument> {
  const previous = await LegalDocument.countDocuments({ kind: input.kind });
  if (previous > 0 && !input.changeNote?.trim()) {
    throw new AppError('Explica qué cambió respecto a la versión anterior', 422);
  }

  let created: ILegalDocument;
  try {
    created = await LegalDocument.create({
      kind: input.kind,
      version: input.version,
      title: input.title,
      content: input.content,
      changeNote: input.changeNote?.trim() || undefined,
      publishedBy: input.adminId,
      isActive: true,
      effectiveAt: new Date(),
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new AppError(`La versión ${input.version} de este documento ya existe`, 409);
    throw error;
  }

  // Primero se crea la nueva y luego se archiva la anterior: así nunca hay un
  // instante sin documento vigente. Si el proceso muere en medio, quedan dos
  // vigentes y `activeByKind` sirve solo la más reciente.
  // Solo se archivan las MÁS ANTIGUAS: con dos publicaciones simultáneas, cada una archivaba a la
  // otra y el tipo quedaba sin versión vigente.
  await LegalDocument.updateMany({ kind: input.kind, isActive: true, effectiveAt: { $lt: created.effectiveAt } }, { $set: { isActive: false } });
  return created;
}

/** Lo que ve la gente: un documento vigente por tipo, el más reciente. */
export function activeByKind<T extends { kind: string; effectiveAt: Date }>(docs: T[]): T[] {
  const latest = new Map<string, T>();
  for (const doc of docs) {
    const seen = latest.get(doc.kind);
    if (!seen || doc.effectiveAt.getTime() > seen.effectiveAt.getTime()) latest.set(doc.kind, doc);
  }
  return [...latest.values()];
}

/**
 * Los tipos que la app exige aceptar para usarse (decidido con el dueño el
 * 2026-09-25: términos y privacidad, igual para clientes y domiciliarios).
 * Los términos propios del domiciliario esperan al asesor legal.
 */
export const REQUIRED_ACCEPTANCE_KINDS: LegalDocumentKind[] = ['terms', 'privacy'];

/**
 * Lo que a esta persona le falta aceptar: la versión vigente de cada tipo
 * exigido que no tenga aceptada. Aceptar una versión anterior no cuenta: la
 * aceptación va atada al documento (`documentId`), y cada versión es un
 * documento nuevo. Sin documentos publicados devuelve vacío y la app no pide
 * nada.
 */
export async function pendingAcceptances(userId: string) {
  const active = activeByKind(
    await LegalDocument.find({ isActive: true, kind: { $in: REQUIRED_ACCEPTANCE_KINDS } })
      .select('kind version title content effectiveAt')
      .lean()
  );
  if (active.length === 0) return [];
  const accepted = await LegalAcceptance.find({ userId, documentId: { $in: active.map((d) => d._id) } })
    .select('documentId')
    .lean();
  const done = new Set(accepted.map((a) => String(a.documentId)));
  // Se acepta primero el que tenga una versión anterior aceptada: así la
  // pantalla puede decir "actualizamos" en vez de "bienvenido".
  const previouslyAccepted = new Set(
    (await LegalAcceptance.find({ userId }).populate<{ documentId: { kind: string } | null }>('documentId', 'kind').select('documentId').lean())
      .map((a) => a.documentId?.kind)
      .filter(Boolean)
  );
  return active
    .filter((d) => !done.has(String(d._id)))
    .map((d) => ({
      _id: String(d._id),
      kind: d.kind,
      version: d.version,
      title: d.title,
      content: d.content,
      isUpdate: previouslyAccepted.has(d.kind),
    }));
}

/** Todas las versiones (sin el texto) con cuántas personas aceptaron cada una. */
export interface LegalDocumentSummary {
  _id: Types.ObjectId; kind: LegalDocumentKind; version: string; title: string; isActive: boolean;
  effectiveAt: Date; changeNote?: string; acceptances: number;
}

export async function listLegalDocuments(): Promise<LegalDocumentSummary[]> {
  const [docs, counts] = await Promise.all([
    LegalDocument.find().select('-content').sort({ kind: 1, effectiveAt: -1 }).lean(),
    LegalAcceptance.aggregate<{ _id: Types.ObjectId; total: number }>([{ $group: { _id: '$documentId', total: { $sum: 1 } } }]),
  ]);
  const byDoc = new Map(counts.map((c) => [String(c._id), c.total]));
  return docs.map((d) => ({ ...d, acceptances: byDoc.get(String(d._id)) ?? 0 })) as unknown as LegalDocumentSummary[];
}

export async function getLegalDocument(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError('Documento no encontrado', 404);
  const doc = await LegalDocument.findById(id).lean();
  if (!doc) throw new AppError('Documento no encontrado', 404);
  return doc;
}

const maskEmail = (email?: string) => (email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : email);

export async function listAcceptances(id: string, page = 1, limit = 25, unmasked = false) {
  if (!Types.ObjectId.isValid(id)) throw new AppError('Documento no encontrado', 404);
  const documentId = new Types.ObjectId(id);
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const skip = (Math.max(page, 1) - 1) * safeLimit;
  const [rows, total] = await Promise.all([
    LegalAcceptance.find({ documentId }).sort({ acceptedAt: -1 }).skip(skip).limit(safeLimit)
      .populate('userId', 'name email').select('userId version acceptedAt').lean(),
    LegalAcceptance.countDocuments({ documentId }),
  ]);
  const shown = unmasked ? rows : rows.map((r: any) => (r.userId ? { ...r, userId: { ...r.userId, email: maskEmail(r.userId.email) } } : r));
  return { rows: shown, total, page: Math.max(page, 1), limit: safeLimit };
}
