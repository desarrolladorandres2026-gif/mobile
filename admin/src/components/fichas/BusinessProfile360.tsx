import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
 X, AlertTriangle, Ban, PlayCircle, Archive, ArchiveRestore, Percent, FileSearch, ChevronDown, ChevronRight,
} from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import { dateTime, day, money } from '../../lib/drivers';
import type {
 BusinessAnalyticsData,
 BusinessDocumentRow,
 BusinessProfile360Data,
 BusinessStatementData,
} from '../../lib/fichaTypes';
import { Permission } from '../../lib/permissions';
import ConfirmDialog from '../ConfirmDialog';
import EntityLink from '../EntityLink';
import InternalNotes from '../InternalNotes';
import { PermissionGate } from '../PermissionGate';
import SecurityGlance from '../businessSecurity/SecurityGlance';
import {
 ErrorLine,
 Facts,
 Grid,
 Section,
 Sub,
 actionButtonClass,
 fieldLabelClass,
 inputClass,
 primaryButtonClass,
 secondaryButtonClass,
} from './ui';

/**
 * Ficha del comercio.
 *
 * Todo lo que la administración necesita para decidir sobre un comercio:
 * quién es, si sus papeles están al día, cómo le va y qué se le debe. Ventas y
 * dinero no vienen con la ficha: son agregaciones pesadas y se piden al abrir
 * su sección. Lo que el servidor manda `null` u omite —por falta de permiso—
 * no se pinta.
 */

const documentLabels: Record<string, string> = {
 rut: 'RUT',
 chamber_of_commerce: 'Cámara de Comercio',
 legal_rep_id: 'Cédula del representante',
 bank_certificate: 'Certificación bancaria',
 health_permit: 'Concepto sanitario',
};

const documentStatusStyles: Record<string, { label: string; text: string }> = {
 pending: { label: 'Por revisar', text: 'text-[var(--color-text-main)]' },
 approved: { label: 'Aprobado', text: 'text-[#047857]' },
 rejected: { label: 'Rechazado', text: 'text-[var(--color-danger)]' },
 expired: { label: 'Vencido', text: 'text-[var(--color-danger)]' },
};

const taxRegimeLabels: Record<string, string> = {
 simple: 'Régimen simple',
 common: 'Régimen común',
 not_responsible: 'No responsable de IVA',
};

interface DocumentFile {
 _id: string;
 hasFile?: boolean;
 fileUrl?: string;
}

/** Sección que pide sus datos la primera vez que se abre. */
function Deferred<T>({
 title,
 load,
 children,
}: {
 title: string;
 load: () => Promise<T>;
 children: (data: T) => ReactNode;
}) {
 const [open, setOpen] = useState(false);
 const [data, setData] = useState<T | null>(null);
 const [error, setError] = useState('');
 const [loading, setLoading] = useState(false);

 const toggle = async () => {
 const next = !open;
 setOpen(next);
 if (!next || data || loading) return;
 try {
 setLoading(true);
 setError('');
 setData(await load());
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar esta sección.'));
 } finally {
 setLoading(false);
 }
 };

 return (
 <section className="space-y-5 border-t border-[var(--color-border-light)] py-7">
 <button
 type="button"
 onClick={toggle}
 className="flex cursor-pointer items-center gap-1.5 text-sm font-bold text-[var(--color-text-main)]"
 >
 {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
 {title}
 </button>
 {open &&
 (loading ? (
 <p className="text-[var(--color-text-main)]">Cargando…</p>
 ) : error ? (
 <ErrorLine>{error}</ErrorLine>
 ) : data ? (
 children(data)
 ) : null)}
 </section>
 );
}

type Dialog = 'suspend' | 'lift' | 'archive' | 'restore' | 'commission' | null;

export default function BusinessProfile360({
 businessId,
 onClose,
}: {
 businessId: string;
 onClose: () => void;
}) {
 const [data, setData] = useState<BusinessProfile360Data | null>(null);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [actionError, setActionError] = useState('');
 const [working, setWorking] = useState(false);
 const [dialog, setDialog] = useState<Dialog>(null);

 // Cambiar comisión
 const [commissionOpen, setCommissionOpen] = useState(false);
 const [commissionPct, setCommissionPct] = useState('');
 const [commissionError, setCommissionError] = useState('');

 // Pedir documentos
 const [requestOpen, setRequestOpen] = useState(false);
 const [requestTypes, setRequestTypes] = useState<string[]>([]);
 const [requestMessage, setRequestMessage] = useState('');
 const [requestError, setRequestError] = useState('');

 const [openingDoc, setOpeningDoc] = useState<string | null>(null);

 const load = useCallback(async () => {
 try {
 const res = await api.get(`/admin/businesses/${businessId}/profile-360`);
 setData(res.data.data);
 setError('');
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar la ficha del comercio.'));
 }
 }, [businessId]);

 useEffect(() => {
 setData(null);
 setNotice('');
 setActionError('');
 void load();
 }, [load]);

 const run = async (fn: () => Promise<unknown>, done: string, fallback: string) => {
 try {
 setWorking(true);
 setActionError('');
 setNotice('');
 await fn();
 setNotice(done);
 await load();
 return true;
 } catch (err) {
 setActionError(apiMessage(err, fallback));
 return false;
 } finally {
 setWorking(false);
 }
 };

 const setSuspension = (suspended: boolean, reason?: string) =>
 run(
 // Se manda el estado deseado, no un"cambiar": dos clics seguidos no se anulan.
 () => api.patch(`/admin/businesses/${businessId}/suspension`, { suspended, ...(reason ? { reason } : {}) }),
 suspended ? 'Comercio suspendido.' : 'Suspensión levantada.',
 suspended ? 'No se pudo suspender el comercio.' : 'No se pudo levantar la suspensión.',
 );

 const archive = (reason?: string) =>
 run(
 () => api.patch(`/admin/businesses/${businessId}/archive`, { reason }),
 'Comercio archivado.',
 'No se pudo archivar el comercio.',
 );

 const restore = () =>
 run(
 () => api.patch(`/admin/businesses/${businessId}/restore`),
 'Comercio restaurado.',
 'No se pudo restaurar el comercio.',
 );

 const parsedBps = () => {
 const pct = Number(commissionPct.trim().replace(',', '.'));
 if (!commissionPct.trim() || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
 return Math.round(pct * 100);
 };

 const askCommission = () => {
 if (parsedBps() == null) {
 setCommissionError('Escribe un porcentaje entre 0 y 100.');
 return;
 }
 setCommissionError('');
 setDialog('commission');
 };

 const saveCommission = async () => {
 const bps = parsedBps();
 if (bps == null) return;
 const ok = await run(
 () => api.patch(`/finance/businesses/${businessId}/terms`, { commissionRateBps: bps }),
 'Comisión actualizada.',
 'No se pudo cambiar la comisión.',
 );
 if (ok) {
 setCommissionOpen(false);
 setCommissionPct('');
 }
 };

 const sendDocumentRequest = async () => {
 if (requestTypes.length === 0) {
 setRequestError('Elige al menos un documento.');
 return;
 }
 setRequestError('');
 const ok = await run(
 () =>
 api.post(`/admin/businesses/${businessId}/request-documents`, {
 types: requestTypes,
 ...(requestMessage.trim() ? { message: requestMessage.trim() } : {}),
 }),
 'Se le pidieron los documentos al dueño.',
 'No se pudieron pedir los documentos.',
 );
 if (ok) {
 setRequestOpen(false);
 setRequestTypes([]);
 setRequestMessage('');
 }
 };

 // El archivo se firma al listar (queda auditado): se pide en el momento y
 // se abre en otra pestaña. La pestaña se abre antes para que el navegador
 // no la bloquee como ventana emergente.
 const openDocument = async (doc: BusinessDocumentRow) => {
 const tab = window.open('about:blank', '_blank');
 try {
 setOpeningDoc(doc._id);
 setActionError('');
 const res = await api.get(`/businesses/${businessId}/documents`);
 const file = ((res.data.data ?? []) as DocumentFile[]).find((d) => d._id === doc._id);
 if (!file?.hasFile || !file.fileUrl) {
 tab?.close();
 setActionError('Este documento no tiene un archivo cargado.');
 return;
 }
 if (tab) {
 tab.opener = null;
 tab.location.href = file.fileUrl;
 }
 } catch (err) {
 tab?.close();
 setActionError(apiMessage(err, 'No se pudo abrir el documento.'));
 } finally {
 setOpeningDoc(null);
 }
 };

 const b = data?.business;
 const stateLabel = b
 ? b.isArchived
 ? { text: 'Archivado', tone: 'text-[var(--color-text-main)]' }
 : b.isSuspended
 ? { text: 'Suspendido', tone: 'text-[var(--color-danger)]' }
 : !b.isApproved
 ? { text: 'Pendiente de aprobación', tone: 'text-[var(--color-text-main)]' }
 : { text: 'Activo', tone: 'text-[#047857]' }
 : null;
 const commissionText =
 b?.commissionRateBps == null
 ? ''
 : b.commissionRateBps < 0
 ? 'Por defecto'
 : `${(b.commissionRateBps / 100).toFixed(2)} %`;

 return (
 <>
 {/* Pantalla completa dentro del área de contenido: deja a la vista la
 cabecera (h-20) y la barra lateral (w-30, fija desde lg). */}
 <div className="fixed bottom-0 left-0 right-0 top-20 z-30 lg:left-30">
 <div className="h-full w-full overflow-y-auto bg-[var(--color-bg)] p-6 lg:p-8">
 <div className="flex items-start justify-between gap-4">
 <div className="min-w-0">
 <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
 {b?.name ?? 'Ficha del comercio'}
 </h2>
 {stateLabel && (
 <p className="text-[11px] font-bold uppercase tracking-wide">
 <span className={stateLabel.tone}>{stateLabel.text}</span>
 {b?.isSuspended && b.suspensionReason ? (
 <span className="font-medium normal-case tracking-normal text-[var(--color-text-main)]">
 {' '}
 · {b.suspensionReason}
 </span>
 ) : null}
 </p>
 )}
 </div>
 <button
 onClick={onClose}
 aria-label="Cerrar"
 className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-text-main)]"
 >
 <X className="h-4 w-4" />
 </button>
 </div>

 {error ? (
 <p className="mt-6 flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
 <AlertTriangle className="h-4 w-4" /> {error}
 </p>
 ) : !data || !b ? (
 <p className="mt-6 text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : (
 <div className="mt-5 text-xs">
 <div className="space-y-3 pb-6">
 <div className="flex flex-wrap items-center gap-2.5">
 <PermissionGate permission={Permission.BUSINESSES_UPDATE_ALL}>
 {b.isSuspended ? (
 <button onClick={() => setDialog('lift')} className={actionButtonClass}>
 <PlayCircle className="h-4 w-4" /> Levantar suspensión
 </button>
 ) : (
 <button
 onClick={() => setDialog('suspend')}
 className={`${actionButtonClass} !border-[var(--color-danger)] !text-[var(--color-danger)]`}
 >
 <Ban className="h-4 w-4" /> Suspender
 </button>
 )}
 {b.isArchived ? (
 <button onClick={() => setDialog('restore')} className={actionButtonClass}>
 <ArchiveRestore className="h-4 w-4" /> Restaurar
 </button>
 ) : (
 <button onClick={() => setDialog('archive')} className={actionButtonClass}>
 <Archive className="h-4 w-4" /> Archivar
 </button>
 )}
 </PermissionGate>
 <PermissionGate permission={Permission.COMMISSIONS_MANAGE}>
 <button
 onClick={() => setCommissionOpen((v) => !v)}
 className={actionButtonClass}
 >
 <Percent className="h-4 w-4" /> Comisión
 </button>
 </PermissionGate>
 <PermissionGate permission={Permission.BUSINESSES_APPROVE}>
 <button onClick={() => setRequestOpen((v) => !v)} className={actionButtonClass}>
 <FileSearch className="h-4 w-4" /> Pedir documentos
 </button>
 </PermissionGate>
 </div>

 {b.suspendedBy && b.isSuspended && (
 <p className="text-[var(--color-text-main)]">
 Suspendido por {b.suspendedBy.name}
 {b.suspendedAt ? ` el ${day(b.suspendedAt)}` : ''}.
 </p>
 )}
 {notice && <p className="font-semibold text-[#047857]">{notice}</p>}
 {actionError && <ErrorLine>{actionError}</ErrorLine>}

 {commissionOpen && (
 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
 <label className="block space-y-1">
 <span className={fieldLabelClass}>
 Comisión de ZIPP, en % del subtotal{commissionText ? ` (hoy ${commissionText})` : ''}
 </span>
 <input
 value={commissionPct}
 onChange={(e) => {
 setCommissionPct(e.target.value);
 setCommissionError('');
 }}
 inputMode="decimal"
 placeholder="10"
 className={inputClass}
 />
 </label>
 {commissionError && <ErrorLine>{commissionError}</ErrorLine>}
 <div className="flex justify-end gap-2">
 <button onClick={() => setCommissionOpen(false)} className={secondaryButtonClass}>
 Cancelar
 </button>
 <button onClick={askCommission} disabled={working} className={primaryButtonClass}>
 Cambiar comisión
 </button>
 </div>
 </div>
 )}

 {requestOpen && (
 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
 <p className={fieldLabelClass}>Documentos que se le piden al dueño</p>
 <div className="flex flex-wrap gap-x-4 gap-y-1.5">
 {Object.entries(documentLabels).map(([type, label]) => (
 <label key={type} className="flex cursor-pointer items-center gap-1.5 text-[var(--color-text-main)]">
 <input
 type="checkbox"
 checked={requestTypes.includes(type)}
 onChange={(e) => {
 setRequestError('');
 setRequestTypes((prev) =>
 e.target.checked ? [...prev, type] : prev.filter((t) => t !== type),
 );
 }}
 />
 {label}
 </label>
 ))}
 </div>
 <label className="block space-y-1">
 <span className={fieldLabelClass}>Mensaje (opcional)</span>
 <textarea
 value={requestMessage}
 onChange={(e) => setRequestMessage(e.target.value)}
 rows={2}
 maxLength={300}
 className={inputClass}
 />
 </label>
 <p className="text-[11px] text-[var(--color-text-main)]">
 Le llega un aviso al dueño. No cambia el estado de los documentos que ya envió.
 </p>
 {requestError && <ErrorLine>{requestError}</ErrorLine>}
 <div className="flex justify-end gap-2">
 <button onClick={() => setRequestOpen(false)} className={secondaryButtonClass}>
 Cancelar
 </button>
 <button onClick={sendDocumentRequest} disabled={working} className={primaryButtonClass}>
 {working ? 'Enviando…' : 'Pedir documentos'}
 </button>
 </div>
 </div>
 )}
 </div>

 <div className="columns-1 gap-6 xl:columns-2">
 <div className="mb-6 break-inside-avoid">
 <Facts
 title="Identidad"
 items={[
 [
 'Dueño',
 data.owner ? (
 <EntityLink type="user" id={data.owner._id}>
 {data.owner.name}
 </EntityLink>
 ) : undefined,
 ],
 ['Categoría', b.category],
 ['Ciudad', b.city],
 ['Dirección', b.address],
 ['Teléfono', b.phone],
 ['Alta', day(b.createdAt)],
 ['Aprobado', b.isApproved ? 'Sí' : 'No'],
 ...(commissionText ? ([['Comisión', commissionText]] as Array<[string, ReactNode]>) : []),
 ]}
 />
 </div>

 {data.legal && (
 <div className="mb-6 break-inside-avoid">
 <Facts
 title="Datos fiscales"
 items={[
 ['Razón social', data.legal.legalName],
 ['NIT', data.legal.nitMasked],
 ['Régimen', data.legal.taxRegime ? taxRegimeLabels[data.legal.taxRegime] ?? data.legal.taxRegime : ''],
 ['Datos completos', data.legal.complete ? 'Sí' : 'Incompletos'],
 ]}
 />
 </div>
 )}

 {data.payoutAccount !== undefined && data.payoutAccount !== null && (
 <div className="mb-6 break-inside-avoid">
 <Facts
 title="Cuenta de pago"
 items={[
 [
 'Estado',
 data.payoutAccount.status === 'verified'
 ? 'Verificada'
 : data.payoutAccount.status === 'pendingVerification'
 ? 'Por verificar'
 : data.payoutAccount.status === 'none'
 ? 'Sin cuenta registrada'
 : data.payoutAccount.status,
 ],
 ['Banco', data.payoutAccount.bankName],
 ['Tipo', data.payoutAccount.accountType],
 ['Verificada', data.payoutAccount.verifiedAt ? day(data.payoutAccount.verifiedAt) : undefined],
 ['Terminada en', data.payoutAccount.last4],
 ]}
 />
 </div>
 )}

 {data.documents && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Documentos"
 head={['Documento', 'Estado', 'Detalle']}
 empty="El comercio todavía no envió documentos."
 rows={data.documents.map((doc) => {
 const st = documentStatusStyles[doc.status] ?? { label: doc.status, text: '' };
 const reviewer = typeof doc.reviewedBy === 'string' ? doc.reviewedBy : doc.reviewedBy?.name;
 return [
 documentLabels[doc.type] ?? doc.type,
 <span key="estado" className={`font-semibold ${st.text}`}>{st.label}</span>,
 <div key="detalle" className="space-y-0.5">
 <p>
 {doc.expiresAt ? `vence ${day(doc.expiresAt)}` : 'sin vencimiento'}
 {doc.reviewedAt ? ` · revisado ${day(doc.reviewedAt)}` : ''}
 {reviewer ? ` por ${reviewer}` : ''}
 </p>
 {doc.status === 'rejected' && doc.rejectionReason && (
 <p className="font-semibold text-[var(--color-danger)]">Motivo: {doc.rejectionReason}</p>
 )}
 <button
 type="button"
 onClick={() => openDocument(doc)}
 disabled={openingDoc === doc._id}
 className="cursor-pointer text-[11px] font-bold text-[var(--color-text-main)] disabled:opacity-60"
 >
 {openingDoc === doc._id ? 'Abriendo…' : 'Abrir'}
 </button>
 </div>,
 ];
 })}
 />
 </div>
 )}

 {data.team && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Equipo"
 head={['Nombre', 'Rol', 'Detalle']}
 empty="Sin empleados registrados."
 rows={data.team.map((m) => [
 `${m.name}${m.isActive === false ? ' (inactivo)' : ''}`,
 m.role,
 `${m.phone ? m.phone : ''}${m.createdAt ? `${m.phone ? ' · ' : ''}desde ${day(m.createdAt)}` : ''}`,
 ])}
 />
 </div>
 )}

 <PermissionGate permission={Permission.SECURITY_VIEW}>
 <div className="mb-6 break-inside-avoid">
 <Section title="Seguridad">
 <SecurityGlance businessId={businessId} />
 </Section>
 </div>
 </PermissionGate>

 {data.menu && (
 <div className="mb-6 break-inside-avoid">
 <Facts
 title="Menú"
 items={[
 ['Productos', String(data.menu.products)],
 ['Disponibles', String(data.menu.available)],
 ['Agotados', String(Math.max(0, data.menu.products - data.menu.available))],
 ]}
 />
 </div>
 )}

 <div className="mb-6 break-inside-avoid">
 <Deferred<BusinessAnalyticsData>
 title="Ventas"
 load={async () => (await api.get(`/businesses/${businessId}/analytics`, { params: { days: 30 } })).data.data}
 >
 {(a) => (
 <>
 <p className="text-[var(--color-text-main)]">Últimos {a.range.days} días, sobre pedidos entregados.</p>
 <Facts
 title="Totales"
 items={[
 ['Pedidos', String(a.totals.orders)],
 ['Entregados', String(a.totals.delivered)],
 ['Cancelados', `${a.totals.cancelled} (${a.totals.cancellationRate}%)`],
 ['Ventas', money(a.totals.revenue)],
 ['Ticket promedio', money(a.totals.averageTicket)],
 ['Periodo anterior', `${a.previous.orders} pedidos · ${money(a.previous.revenue)}`],
 ]}
 />
 </>
 )}
 </Deferred>
 </div>

 <PermissionGate permission={Permission.FINANCE_VIEW}>
 <div className="mb-6 break-inside-avoid">
 <Deferred<BusinessStatementData>
 title="Dinero"
 load={async () => (await api.get(`/businesses/${businessId}/statement`)).data.data}
 >
 {(s) => (
 <>
 <Facts
 title="Saldos"
 items={[
 ['Deuda viva', money(s.outstanding)],
 ['Acumulado', money(s.accrued)],
 ['Por pagar', money(s.payable)],
 ['Liquidado', money(s.settled)],
 ]}
 />
 <Sub title="Próxima liquidación">
 <p className="text-[var(--color-text-main)]">
 {s.nextSettlement.orderCount} pedidos · neto{' '}
 <span className="font-semibold text-[var(--color-text-main)]">
 {money(s.nextSettlement.netAmount)}
 </span>{' '}
 · comisión {money(s.nextSettlement.merchantCommission)}
 </p>
 </Sub>
 <Grid
 title="Semanas recientes"
 head={['Periodo', 'Pedidos', 'Neto']}
 empty="Sin movimientos en el periodo."
 right={[2]}
 rows={s.weeks.slice(0, 6).map((w) => [
 `${day(w.periodStart)} – ${day(w.periodEnd)}`,
 String(w.orderCount),
 money(w.netAmount),
 ])}
 />
 </>
 )}
 </Deferred>
 </div>
 </PermissionGate>

 {data.ads && (
 <div className="mb-6 break-inside-avoid">
 {data.ads.outstanding != null && data.ads.outstanding > 0 && (
 <p className="mb-2 font-semibold text-[var(--color-text-main)]">
 Debe {money(data.ads.outstanding)} en publicidad.
 </p>
 )}
 <div className="mb-6">
 <Grid
 title="Anuncios"
 head={['Anuncio', 'Estado']}
 empty="Sin anuncios."
 rows={data.ads.advertisements.map((ad) => [
 `${ad.title ?? 'Anuncio'}${ad.endDate ? ` · hasta ${day(ad.endDate)}` : ''}`,
 ad.status === 'cancelled' ? 'Cancelado' : ad.status,
 ])}
 />
 </div>
 <Grid
 title="Facturas"
 head={['Fecha', 'Estado', 'Importe']}
 empty="Sin facturas."
 right={[2]}
 rows={data.ads.invoices.map((inv) => [
 day(inv.createdAt),
 inv.status === 'settled' ? 'Pagada' : inv.status === 'pending' ? 'Pendiente' : (inv.status ?? ''),
 inv.amount != null ? money(inv.amount) : '',
 ])}
 />
 </div>
 )}

 {data.promotions && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Cupones"
 head={['Código', 'Vence', 'Estado']}
 empty="Sin cupones."
 rows={data.promotions.coupons.map((c) => [
 c.code,
 c.validUntil ? day(c.validUntil) : '',
 c.isActive ? 'Activo' : 'Inactivo',
 ])}
 />
 {data.promotions.cost30d != null && (
 <p className="mt-2 text-[var(--color-text-main)]">
 Costo para el comercio, 30 días: <span className="font-semibold">{money(data.promotions.cost30d)}</span>
 </p>
 )}
 </div>
 )}

 {data.reputation && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Reputación"
 head={['Fecha', 'Comentario', 'Calificación']}
 empty={
 data.reputation.rating
 ? `Sin reseñas con comentario. Calificación: ${data.reputation.rating.toFixed(1)} (${data.reputation.totalReviews ?? 0})`
 : 'Sin calificaciones.'
 }
 right={[2]}
 rows={data.reputation.reviews.map((r) => [day(r.createdAt), r.comment ?? '', `${r.rating}★`])}
 />
 </div>
 )}

 {data.support && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Soporte"
 head={['Asunto', 'Fecha', 'Estado']}
 empty="Sin PQRS relacionadas."
 rows={data.support.map((p) => [p.subject ?? 'PQRS', day(p.createdAt), p.status])}
 />
 </div>
 )}

 {data.history && (
 <div className="mb-6 break-inside-avoid">
 <Grid
 title="Historial"
 head={['Cuándo', 'Qué', 'Quién']}
 empty="Sin movimientos registrados."
 rows={data.history.map((h) => [dateTime(h.createdAt), h.description ?? h.action, h.actorName ?? ''])}
 />
 </div>
 )}

 <div className="mb-6 break-inside-avoid">
 <section className="space-y-2">
 <h3 className="text-sm font-bold text-[var(--color-text-main)]">Notas internas</h3>
 <InternalNotes entityType="business" entityId={businessId} />
 </section>
 </div>
 </div>
 </div>
 )}
 </div>
 </div>

 {dialog === 'suspend' && b && (
 <ConfirmDialog
 title="Suspender comercio"
 message={`${b.name} deja de recibir pedidos y desaparece de la app hasta que se levante la suspensión.`}
 confirmLabel="Suspender"
 reason={{ label: 'Motivo', placeholder: 'Por qué se suspende', minLength: 5 }}
 onConfirm={(reason) => {
 setDialog(null);
 void setSuspension(true, reason);
 }}
 onCancel={() => setDialog(null)}
 />
 )}
 {dialog === 'lift' && b && (
 <ConfirmDialog
 title="Levantar suspensión"
 message={`${b.name} vuelve a poder recibir pedidos.`}
 confirmLabel="Levantar"
 variant="default"
 onConfirm={() => {
 setDialog(null);
 void setSuspension(false);
 }}
 onCancel={() => setDialog(null)}
 />
 )}
 {dialog === 'archive' && b && (
 <ConfirmDialog
 title="Archivar comercio"
 message={`${b.name} sale del listado y de la app. El historial se conserva y se puede restaurar.`}
 confirmLabel="Archivar"
 reason={{ label: 'Motivo', placeholder: 'Por qué se archiva', minLength: 5 }}
 onConfirm={(reason) => {
 setDialog(null);
 void archive(reason);
 }}
 onCancel={() => setDialog(null)}
 />
 )}
 {dialog === 'restore' && b && (
 <ConfirmDialog
 title="Restaurar comercio"
 message={`${b.name} vuelve al listado.`}
 confirmLabel="Restaurar"
 variant="default"
 onConfirm={() => {
 setDialog(null);
 void restore();
 }}
 onCancel={() => setDialog(null)}
 />
 )}
 {dialog === 'commission' && b && (
 <ConfirmDialog
 title="Cambiar comisión"
 message={`La comisión de ${b.name} pasa a ${((parsedBps() ?? 0) / 100).toFixed(2)} %. Cambia lo que ZIPP le cobra por sus pedidos.`}
 confirmLabel="Cambiar"
 variant="warning"
 onConfirm={() => {
 setDialog(null);
 void saveCommission();
 }}
 onCancel={() => setDialog(null)}
 />
 )}
 </>
 );
}
