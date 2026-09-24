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
import {
  ErrorLine,
  Fact,
  Row,
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
  pending: { label: 'Por revisar', text: 'text-[var(--color-warning)]' },
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
          <p className="text-[var(--color-text-muted)]">Cargando…</p>
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
      // Se manda el estado deseado, no un "cambiar": dos clics seguidos no se anulan.
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
      ? { text: 'Archivado', tone: 'text-[var(--color-text-muted)]' }
      : b.isSuspended
        ? { text: 'Suspendido', tone: 'text-[var(--color-danger)]' }
        : !b.isApproved
          ? { text: 'Pendiente de aprobación', tone: 'text-[var(--color-warning)]' }
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
      <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
        <div
          className="h-full w-full max-w-2xl overflow-y-auto bg-[var(--color-surface)] p-7"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
                {b?.name ?? 'Ficha del comercio'}
              </h2>
              {stateLabel && (
                <p className="text-[11px] font-bold uppercase tracking-wide">
                  <span className={stateLabel.tone}>{stateLabel.text}</span>
                  {b?.isSuspended && b.suspensionReason ? (
                    <span className="font-medium normal-case tracking-normal text-[var(--color-text-muted)]">
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
              className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-text-muted)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {error ? (
            <p className="mt-6 flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
              <AlertTriangle className="h-4 w-4" /> {error}
            </p>
          ) : !data || !b ? (
            <p className="mt-6 text-sm text-[var(--color-text-muted)]">Cargando…</p>
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
                    <p className="text-[11px] text-[var(--color-text-muted)]">
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

              <Section title="Identidad">
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                  <Fact
                    label="Dueño"
                    value={
                      data.owner ? (
                        <EntityLink type="user" id={data.owner._id}>
                          {data.owner.name}
                        </EntityLink>
                      ) : undefined
                    }
                  />
                  <Fact label="Categoría" value={b.category} />
                  <Fact label="Ciudad" value={b.city} />
                  <Fact label="Dirección" value={b.address} />
                  <Fact label="Teléfono" value={b.phone} />
                  <Fact label="Alta" value={day(b.createdAt)} />
                  <Fact label="Aprobado" value={b.isApproved ? 'Sí' : 'No'} />
                  {commissionText && <Fact label="Comisión" value={commissionText} />}
                </div>

                {data.legal && (
                  <Sub title="Datos fiscales">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                      <Fact label="Razón social" value={data.legal.legalName} />
                      <Fact label="NIT" value={data.legal.nitMasked} />
                      <Fact
                        label="Régimen"
                        value={data.legal.taxRegime ? taxRegimeLabels[data.legal.taxRegime] ?? data.legal.taxRegime : ''}
                      />
                      <Fact label="Datos completos" value={data.legal.complete ? 'Sí' : 'Incompletos'} />
                    </div>
                  </Sub>
                )}
              </Section>

              {data.payoutAccount !== undefined && data.payoutAccount !== null && (
                <Section title="Cuenta de pago">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                    <Fact
                      label="Estado"
                      value={
                        data.payoutAccount.status === 'verified'
                          ? 'Verificada'
                          : data.payoutAccount.status === 'pendingVerification'
                            ? 'Por verificar'
                            : data.payoutAccount.status
                      }
                    />
                    <Fact label="Banco" value={data.payoutAccount.bankName} />
                    <Fact label="Terminada en" value={data.payoutAccount.last4} />
                  </div>
                </Section>
              )}

              {data.documents && (
                <Section title="Documentos">
                  {data.documents.length ? (
                    <ul className="space-y-2">
                      {data.documents.map((doc) => {
                        const st = documentStatusStyles[doc.status] ?? { label: doc.status, text: '' };
                        const reviewer =
                          typeof doc.reviewedBy === 'string' ? doc.reviewedBy : doc.reviewedBy?.name;
                        return (
                          <li key={doc._id} className="flex items-start justify-between gap-3">
                            <div className="min-w-0 text-[var(--color-text-secondary)]">
                              <p className="font-semibold text-[var(--color-text-main)]">
                                {documentLabels[doc.type] ?? doc.type}
                              </p>
                              <p>
                                {doc.expiresAt ? `vence ${day(doc.expiresAt)}` : 'sin vencimiento'}
                                {doc.reviewedAt ? ` · revisado ${day(doc.reviewedAt)}` : ''}
                                {reviewer ? ` por ${reviewer}` : ''}
                              </p>
                              {doc.status === 'rejected' && doc.rejectionReason && (
                                <p className="font-semibold text-[var(--color-danger)]">Motivo: {doc.rejectionReason}</p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              <span className={`font-semibold ${st.text}`}>{st.label}</span>
                              <button
                                type="button"
                                onClick={() => openDocument(doc)}
                                disabled={openingDoc === doc._id}
                                className="cursor-pointer text-[11px] font-bold text-[var(--color-primary)] disabled:opacity-60"
                              >
                                {openingDoc === doc._id ? 'Abriendo…' : 'Abrir'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-[var(--color-text-muted)]">El comercio todavía no envió documentos.</p>
                  )}
                </Section>
              )}

              {data.team && (
                <Section title="Equipo">
                  {data.team.length ? (
                    <ul className="space-y-1.5">
                      {data.team.map((m) => (
                        <Row
                          key={m._id}
                          left={
                            <>
                              {m.name}
                              {m.phone ? ` · ${m.phone}` : ''}
                              {m.createdAt ? ` · desde ${day(m.createdAt)}` : ''}
                            </>
                          }
                          right={m.role}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[var(--color-text-muted)]">Sin empleados registrados.</p>
                  )}
                </Section>
              )}

              {data.menu && (
                <Section title="Menú">
                  <div className="grid grid-cols-3 gap-x-6 gap-y-4">
                    <Fact label="Productos" value={String(data.menu.products)} />
                    <Fact label="Disponibles" value={String(data.menu.available)} />
                    <Fact label="Agotados" value={String(Math.max(0, data.menu.products - data.menu.available))} />
                  </div>
                </Section>
              )}

              <Deferred<BusinessAnalyticsData>
                title="Ventas"
                load={async () => (await api.get(`/businesses/${businessId}/analytics`, { params: { days: 30 } })).data.data}
              >
                {(a) => (
                  <>
                    <p className="text-[var(--color-text-muted)]">Últimos {a.range.days} días, sobre pedidos entregados.</p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
                      <Fact label="Pedidos" value={String(a.totals.orders)} />
                      <Fact label="Entregados" value={String(a.totals.delivered)} />
                      <Fact label="Cancelados" value={`${a.totals.cancelled} (${a.totals.cancellationRate}%)`} />
                      <Fact label="Ventas" value={money(a.totals.revenue)} />
                      <Fact label="Ticket promedio" value={money(a.totals.averageTicket)} />
                      <Fact
                        label="Periodo anterior"
                        value={`${a.previous.orders} pedidos · ${money(a.previous.revenue)}`}
                      />
                    </div>
                  </>
                )}
              </Deferred>

              <PermissionGate permission={Permission.FINANCE_VIEW}>
                <Deferred<BusinessStatementData>
                  title="Dinero"
                  load={async () => (await api.get(`/businesses/${businessId}/statement`)).data.data}
                >
                  {(s) => (
                    <>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
                        <Fact label="Deuda viva" value={money(s.outstanding)} />
                        <Fact label="Acumulado" value={money(s.accrued)} />
                        <Fact label="Por pagar" value={money(s.payable)} />
                        <Fact label="Liquidado" value={money(s.settled)} />
                      </div>
                      <Sub title="Próxima liquidación">
                        <p className="text-[var(--color-text-secondary)]">
                          {s.nextSettlement.orderCount} pedidos · neto{' '}
                          <span className="font-semibold text-[var(--color-text-main)]">
                            {money(s.nextSettlement.netAmount)}
                          </span>{' '}
                          · comisión {money(s.nextSettlement.merchantCommission)}
                        </p>
                      </Sub>
                      <Sub title="Semanas recientes" empty="Sin movimientos en el periodo.">
                        {s.weeks.length ? (
                          <ul className="space-y-1.5">
                            {s.weeks.slice(0, 6).map((w) => (
                              <Row
                                key={w.periodStart}
                                left={`${day(w.periodStart)} – ${day(w.periodEnd)} · ${w.orderCount} pedidos`}
                                right={money(w.netAmount)}
                              />
                            ))}
                          </ul>
                        ) : undefined}
                      </Sub>
                    </>
                  )}
                </Deferred>
              </PermissionGate>

              {data.ads && (
                <Section title="Publicidad">
                  {data.ads.outstanding != null && data.ads.outstanding > 0 && (
                    <p className="font-semibold text-[var(--color-warning)]">
                      Debe {money(data.ads.outstanding)} en publicidad.
                    </p>
                  )}
                  <Sub title="Anuncios" empty="Sin anuncios.">
                    {data.ads.advertisements.length ? (
                      <ul className="space-y-1.5">
                        {data.ads.advertisements.map((ad) => (
                          <Row
                            key={ad._id}
                            left={`${ad.title ?? 'Anuncio'}${ad.endDate ? ` · hasta ${day(ad.endDate)}` : ''}`}
                            right={ad.status}
                          />
                        ))}
                      </ul>
                    ) : undefined}
                  </Sub>
                  <Sub title="Facturas" empty="Sin facturas.">
                    {data.ads.invoices.length ? (
                      <ul className="space-y-1.5">
                        {data.ads.invoices.map((inv) => (
                          <Row
                            key={inv._id}
                            left={`${day(inv.createdAt)} · ${inv.status ?? ''}`}
                            right={inv.amount != null ? money(inv.amount) : undefined}
                          />
                        ))}
                      </ul>
                    ) : undefined}
                  </Sub>
                </Section>
              )}

              {data.promotions && (
                <Section title="Promociones">
                  {data.promotions.cost30d != null && (
                    <Fact label="Costo para el comercio, 30 días" value={money(data.promotions.cost30d)} />
                  )}
                  <Sub title="Cupones" empty="Sin cupones.">
                    {data.promotions.coupons.length ? (
                      <ul className="space-y-1.5">
                        {data.promotions.coupons.map((c) => (
                          <Row
                            key={c._id}
                            left={`${c.code}${c.validUntil ? ` · hasta ${day(c.validUntil)}` : ''}`}
                            right={c.isActive ? 'Activo' : 'Inactivo'}
                          />
                        ))}
                      </ul>
                    ) : undefined}
                  </Sub>
                </Section>
              )}

              {data.reputation && (
                <Section title="Reputación">
                  <Fact
                    label="Calificación"
                    value={
                      data.reputation.rating
                        ? `${data.reputation.rating.toFixed(1)} (${data.reputation.totalReviews ?? 0})`
                        : 'Sin calificaciones'
                    }
                  />
                  {data.reputation.reviews.length > 0 && (
                    <ul className="space-y-1.5">
                      {data.reputation.reviews.map((r) => (
                        <Row
                          key={r._id}
                          left={`${day(r.createdAt)}${r.comment ? ` — ${r.comment}` : ''}`}
                          right={`${r.rating}★`}
                        />
                      ))}
                    </ul>
                  )}
                </Section>
              )}

              {data.support && (
                <Section title="Soporte">
                  {data.support.length ? (
                    <ul className="space-y-1.5">
                      {data.support.map((p) => (
                        <Row key={p._id} left={`${p.subject ?? 'PQRS'} · ${day(p.createdAt)}`} right={p.status} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[var(--color-text-muted)]">Sin PQRS relacionadas.</p>
                  )}
                </Section>
              )}

              {data.history && (
                <Section title="Historial">
                  {data.history.length ? (
                    <ul className="space-y-1.5">
                      {data.history.map((h) => (
                        <Row
                          key={h._id}
                          left={`${dateTime(h.createdAt)} · ${h.description ?? h.action}`}
                          right={h.actorName}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[var(--color-text-muted)]">Sin movimientos registrados.</p>
                  )}
                </Section>
              )}

              <Section title="Notas internas">
                <InternalNotes entityType="business" entityId={businessId} />
              </Section>
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
