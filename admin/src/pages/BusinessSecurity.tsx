import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { Permission } from '../lib/permissions';
import { useAuthStore } from '../stores/authStore';
import ConfirmDialog from '../components/ConfirmDialog';
import StepUpDialog from '../components/businessSecurity/StepUpDialog';
import SessionsPanel from '../components/businessSecurity/SessionsPanel';
import DevicesPanel from '../components/businessSecurity/DevicesPanel';
import EventsPanel from '../components/businessSecurity/EventsPanel';
import DeviceDetail from '../components/businessSecurity/DeviceDetail';
import {
  EMPTY_EVENT_FILTERS,
  EMPTY_SESSION_FILTERS,
  EVENT_LABELS,
  ROLE_LABELS,
  dateTime,
  deviceLabel,
} from '../components/businessSecurity/labels';
import type { EventFilters, SecuritySummary, SessionFilters, SessionRow } from '../components/businessSecurity/types';

/**
 * Centro de seguridad de un comercio: quién tiene la cuenta abierta, desde
 * qué dispositivos, el historial de accesos y el botón para cerrar lo que no
 * cuadre.
 *
 * Lo primero que tiene que saltar a la vista es si hay sesiones abiertas
 * desde dispositivos nuevos o sin identificar; por eso va arriba, antes que
 * cualquier tabla.
 *
 * Las sesiones son de la cuenta y no del local: cerrar las del negocio saca
 * al dueño también de sus otros negocios. Los diálogos lo dicen.
 */

type Tab = 'sessions' | 'devices' | 'events';
type Pending =
  | { kind: 'session'; session: SessionRow }
  | { kind: 'user'; userId: string; name: string }
  | { kind: 'business' }
  | { kind: 'export' };

/** Una respuesta de error de una descarga llega como Blob: hay que leerla para mostrar el motivo. */
async function blobError(err: unknown, fallback: string): Promise<string> {
  const blob = (err as { response?: { data?: unknown } })?.response?.data;
  if (blob instanceof Blob) {
    try {
      const body = JSON.parse(await blob.text());
      if (typeof body?.message === 'string') return body.message;
    } catch {
      /* cae al mensaje genérico */
    }
  }
  return apiMessage(err, fallback);
}

export default function BusinessSecurity() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const canManage = useAuthStore((s) => s.hasPermission(Permission.SECURITY_MANAGE));

  const [tab, setTab] = useState<Tab>('sessions');
  const [sessionFilters, setSessionFilters] = useState<SessionFilters>(EMPTY_SESSION_FILTERS);
  const [sessionFiltersKey, setSessionFiltersKey] = useState(0);
  const [eventFilters, setEventFilters] = useState<EventFilters>(EMPTY_EVENT_FILTERS);
  const [device, setDevice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { data: summary, isLoading, error } = useQuery({
    queryKey: ['business-security', id, 'summary'],
    queryFn: async () => (await api.get(`/admin/businesses/${id}/security/summary`)).data.data as SecuritySummary,
    staleTime: 10_000,
    enabled: !!id,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['business-security', id] });
  const close = () => { setPending(null); setDialogError(''); };

  const showUnknown = () => {
    setTab('sessions');
    setSessionFilters({ ...EMPTY_SESSION_FILTERS, unidentified: false });
    setSessionFiltersKey((k) => k + 1);
  };

  const revokeSession = async (session: SessionRow, reason?: string) => {
    setBusy(true);
    try {
      await api.post(`/admin/businesses/${id}/security/sessions/${session.id}/revoke`, { reason });
      setNotice({ tone: 'ok', text: `Sesión de ${session.user.name} cerrada.` });
      close();
      void refresh();
    } catch (err) {
      setNotice({ tone: 'error', text: apiMessage(err, 'No se pudo cerrar la sesión.') });
      close();
    } finally {
      setBusy(false);
    }
  };

  const stepUp = async (reason: string, totpToken: string) => {
    if (!pending) return;
    setBusy(true);
    setDialogError('');
    try {
      if (pending.kind === 'export') {
        const res = await api.post(`/admin/businesses/${id}/security/export`, { reason, totpToken }, { responseType: 'blob' });
        const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] ?? '')?.[1] ?? 'seguridad.csv';
        const url = URL.createObjectURL(res.data as Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setNotice({ tone: 'ok', text: `Descargado: ${name}` });
      } else {
        const url = pending.kind === 'user'
          ? `/admin/businesses/${id}/security/users/${pending.userId}/revoke-all`
          : `/admin/businesses/${id}/security/revoke-all`;
        const { data } = await api.post(url, { reason, totpToken });
        const revoked = Number(data.data?.revoked ?? 0);
        const skipped = Number(data.data?.skipped ?? 0);
        setNotice({
          tone: 'ok',
          text: `${revoked === 1 ? 'Se cerró 1 sesión' : `Se cerraron ${revoked} sesiones`}${skipped ? ` (${skipped} cuenta administrativa no se tocó)` : ''}.`,
        });
        void refresh();
      }
      close();
    } catch (err) {
      setDialogError(await blobError(err, 'No se pudo completar la acción.'));
    } finally {
      setBusy(false);
    }
  };

  const members = summary?.members ?? [];

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="page-header">
        <div className="min-w-0">
          <Link to="/businesses" className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Negocios
          </Link>
          <h1 className="page-title">Seguridad{summary ? ` · ${summary.business.name}` : ''}</h1>
          <p className="page-subtitle">Sesiones, dispositivos e historial de acceso del dueño y su personal</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPending({ kind: 'export' })}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 text-xs font-bold uppercase tracking-wider text-[var(--color-text-main)]"
          >
            <Download className="h-4 w-4" /> Exportar
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => setPending({ kind: 'business' })}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-danger)] px-4 text-xs font-bold uppercase tracking-wider text-white"
            >
              <ShieldOff className="h-4 w-4" /> Cerrar todas las sesiones
            </button>
          )}
        </div>
      </div>

      {notice && (
        <p role="status" className={`text-xs font-semibold ${notice.tone === 'ok' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
          {notice.text}
        </p>
      )}

      {isLoading && <p className="text-xs text-[var(--color-text-secondary)]">Cargando…</p>}
      {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{apiMessage(error, 'No se pudo cargar el centro de seguridad.')}</p>}

      {summary && (
        <>
          {summary.unknownActiveSessions > 0 && (
            <p className="flex items-start gap-2 text-sm font-semibold text-[var(--color-warning)]">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {summary.unknownActiveSessions === 1
                  ? 'Hay 1 sesión abierta desde un dispositivo nuevo o sin identificar.'
                  : `Hay ${summary.unknownActiveSessions} sesiones abiertas desde dispositivos nuevos o sin identificar.`}{' '}
                <button type="button" onClick={showUnknown} className="cursor-pointer underline underline-offset-2">Revisarlas</button>
              </span>
            </p>
          )}

          <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Sesiones activas" value={summary.activeSessions} />
            <Stat label="Desconocidas" value={summary.unknownActiveSessions} warn={summary.unknownActiveSessions > 0} />
            <Stat label="Dispositivos conocidos" value={summary.knownDevices} />
            <Stat label="Nuevos · 30 días" value={summary.newDevices30d} />
            <Stat label="Accesos fallidos · 7 días" value={summary.failedAttempts7d} warn={summary.failedAttempts7d >= 5} />
            <div className="min-w-0">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">Último acceso</dt>
              <dd className="truncate text-sm font-semibold text-[var(--color-text-main)]">
                {summary.lastSuccessfulLogin ? dateTime(summary.lastSuccessfulLogin.createdAt) : 'Sin registro'}
              </dd>
              {summary.lastSuccessfulLogin && (
                <p className="truncate text-[11px] text-[var(--color-text-secondary)]">
                  {summary.lastSuccessfulLogin.user.name} · {deviceLabel(summary.lastSuccessfulLogin.device)}
                </p>
              )}
            </div>
          </dl>

          {summary.lastSecurityEvent && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Último evento:{' '}
              <span className="font-semibold text-[var(--color-text-main)]">{EVENT_LABELS[summary.lastSecurityEvent.type] ?? summary.lastSecurityEvent.type}</span>
              {' · '}{summary.lastSecurityEvent.user.name} · {dateTime(summary.lastSecurityEvent.createdAt)}
            </p>
          )}

          <section className="space-y-3 border-t border-[var(--color-border-light)] pt-6">
            <h2 className="text-sm font-bold text-[var(--color-text-main)]">Protección de las cuentas</h2>
            <ul className="divide-y divide-[var(--color-border-light)]">
              {members.map((m) => (
                <li key={m.userId} className="flex flex-col gap-1 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 text-[var(--color-text-main)]">
                    <span className="font-semibold">{m.name}</span>
                    <span className="text-[var(--color-text-secondary)]"> · {ROLE_LABELS[m.businessRole]}{m.email ? ` · ${m.email}` : ''}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[var(--color-text-secondary)]">
                    {m.twoFactorEnabled ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-success)]"><ShieldCheck className="h-3.5 w-3.5" /> 2FA activo</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-warning)]"><ShieldOff className="h-3.5 w-3.5" /> Sin 2FA</span>
                    )}
                    <span>Contraseña: {m.passwordChangedAt ? `cambiada ${dateTime(m.passwordChangedAt)}` : 'nunca cambiada'}</span>
                    <span>Último acceso: {dateTime(m.lastLoginAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-5 border-t border-[var(--color-border-light)] pt-6">
            <nav className="flex gap-6 border-b border-[var(--color-border-light)]" aria-label="Secciones">
              {([
                ['sessions', 'Sesiones'],
                ['devices', 'Dispositivos'],
                ['events', 'Historial'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`-mb-px cursor-pointer border-b-2 pb-2 text-sm font-bold transition-colors ${
                    tab === key
                      ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
                      : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>

            {tab === 'sessions' && (
              <SessionsPanel
                key={sessionFiltersKey}
                businessId={id}
                members={members}
                filters={sessionFilters}
                onFiltersChange={setSessionFilters}
                onRevoke={(session) => setPending({ kind: 'session', session })}
                onRevokeUser={(userId, name) => setPending({ kind: 'user', userId, name })}
                onOpenDevice={setDevice}
              />
            )}
            {tab === 'devices' && <DevicesPanel businessId={id} members={members} onOpenDevice={setDevice} />}
            {tab === 'events' && <EventsPanel businessId={id} members={members} filters={eventFilters} onFiltersChange={setEventFilters} />}
          </section>
        </>
      )}

      {device && (
        <DeviceDetail
          businessId={id}
          recordId={device}
          onClose={() => setDevice(null)}
          onRevoke={(session) => setPending({ kind: 'session', session })}
        />
      )}

      {pending?.kind === 'session' && (
        <ConfirmDialog
          title="Cerrar esta sesión"
          message={`${pending.session.user.name} tendrá que volver a iniciar sesión en ${deviceLabel(pending.session.device)}. Queda registrado quién la cerró y por qué.`}
          confirmLabel={busy ? 'Cerrando…' : 'Cerrar sesión'}
          reason={{ label: 'Motivo', placeholder: 'Dispositivo que el comercio no reconoce', minLength: 5 }}
          onCancel={close}
          onConfirm={(reason) => void revokeSession(pending.session, reason)}
        />
      )}
      {pending?.kind === 'user' && (
        <StepUpDialog
          title={`Cerrar todas las sesiones de ${pending.name}`}
          message="Se cierran en todos sus dispositivos, también en los otros negocios donde tenga acceso. Tendrá que volver a iniciar sesión."
          confirmLabel="Cerrar sesiones"
          reasonPlaceholder="Ya no trabaja en el local"
          busy={busy}
          error={dialogError}
          onConfirm={(reason, totp) => void stepUp(reason, totp)}
          onCancel={close}
        />
      )}
      {pending?.kind === 'business' && (
        <StepUpDialog
          title="Cerrar todas las sesiones del negocio"
          message={`Se cierran las del dueño y de todo el personal activo${summary ? ` de ${summary.business.name}` : ''}. Las sesiones son de la cuenta: el dueño también sale de sus otros negocios hasta que vuelva a entrar.`}
          confirmLabel="Cerrar todo"
          reasonPlaceholder="El comercio reporta un acceso que no reconoce"
          busy={busy}
          error={dialogError}
          onConfirm={(reason, totp) => void stepUp(reason, totp)}
          onCancel={close}
        />
      )}
      {pending?.kind === 'export' && (
        <StepUpDialog
          title="Exportar historial de seguridad"
          message="CSV con correos e IP de las personas del negocio (hasta 5.000 eventos). Solo Super Administrador; queda en la auditoría con el motivo."
          confirmLabel="Descargar"
          reasonPlaceholder="Reclamo del comercio por un acceso"
          busy={busy}
          error={dialogError}
          onConfirm={(reason, totp) => void stepUp(reason, totp)}
          onCancel={close}
        />
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{label}</dt>
      <dd className={`kpi-value text-2xl ${warn ? '!text-[var(--color-warning)]' : ''}`}>{value}</dd>
    </div>
  );
}
