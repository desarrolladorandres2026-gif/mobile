import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import { Permission } from '../../lib/permissions';
import { useAuthStore } from '../../stores/authStore';
import { MfaMark, PlatformIcon } from './shared';
import { EVENT_LABELS, PLATFORM_LABELS, REASON_LABELS, STATUS_STYLES, dangerLink, dateTime, deviceLabel } from './labels';
import type { DeviceRow, SecurityEventRow, SessionRow } from './types';

interface Props {
  businessId: string;
  recordId: string;
  onClose: () => void;
  onRevoke: (session: SessionRow) => void;
}

/**
 * Detalle de un dispositivo: qué es, desde dónde entró, sus sesiones y lo que
 * pasó con él. Panel lateral (superficie flotante): se abre sobre la tabla
 * sin perder los filtros.
 */
export default function DeviceDetail({ businessId, recordId, onClose, onRevoke }: Props) {
  const canManage = useAuthStore((s) => s.hasPermission(Permission.SECURITY_MANAGE));
  const { data, isLoading, error } = useQuery({
    queryKey: ['business-security', businessId, 'device', recordId],
    queryFn: async () =>
      (await api.get(`/admin/businesses/${businessId}/security/devices/${recordId}`)).data.data as {
        device: DeviceRow & { userAgent: string | null };
        sessions: SessionRow[];
        events: SecurityEventRow[];
      },
  });

  const d = data?.device;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <button type="button" aria-label="Cerrar" onClick={onClose} className="absolute inset-0 cursor-default bg-black/40" />
      <aside role="dialog" aria-label="Detalle del dispositivo" className="zipp-modal relative h-full w-full max-w-xl overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <PlatformIcon platform={d?.platform} className="mt-1 h-5 w-5" />
            <div className="min-w-0">
              <h2 className="text-base font-bold text-[var(--color-text-main)]">{d ? deviceLabel(d) : 'Dispositivo'}</h2>
              {d && (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {PLATFORM_LABELS[d.platform] ?? PLATFORM_LABELS.unknown} · {d.user.name}
                  {d.shortId && <span className="tabular"> · {d.shortId}</span>}
                </p>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && <p className="py-6 text-xs text-[var(--color-text-secondary)]">Cargando…</p>}
        {error && <p className="py-6 text-xs font-semibold text-[var(--color-danger)]">{apiMessage(error, 'No se pudo cargar el dispositivo.')}</p>}

        {d && data && (
          <div className="mt-6 space-y-7 text-xs text-[var(--color-text-main)]">
            {!d.identified && (
              <p className="font-semibold text-[var(--color-warning)]">
                Sin identificador propio: se reconoce solo por el navegador, así que dos equipos con el mismo navegador aparecen como uno.
                Pasa con sesiones abiertas antes de la actualización o con accesos que no vienen del panel.
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Fact label="Visto por primera vez" value={dateTime(d.firstSeen)} />
              <Fact label="Última vez" value={dateTime(d.lastSeen)} />
              <Fact label="Primera IP" value={d.firstIp ?? '—'} />
              <Fact label="Última IP" value={d.lastIp ?? '—'} />
              <Fact label="Inicios de sesión" value={String(d.loginCount)} />
              <Fact label="Sesiones abiertas" value={String(d.activeSessions)} />
            </dl>
            {data.device.userAgent && (
              <div className="space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">User-Agent</p>
                <p className="tabular break-all text-[11px] text-[var(--color-text-secondary)]">{data.device.userAgent}</p>
              </div>
            )}

            <section className="space-y-2 border-t border-[var(--color-border-light)] pt-5">
              <h3 className="text-sm font-bold">Sesiones</h3>
              <ul className="divide-y divide-[var(--color-border-light)]">
                {data.sessions.map((s) => (
                  <li key={s.id} className="flex items-start justify-between gap-3 py-2">
                    <div>
                      <p>
                        <span className={`font-bold ${STATUS_STYLES[s.status].text}`}>{STATUS_STYLES[s.status].label}</span>
                        {' · '}desde {dateTime(s.createdAt)} · IP {s.lastIp}
                      </p>
                      <p className="text-[11px] text-[var(--color-text-secondary)]">
                        Última actividad {dateTime(s.lastActivity)} {s.mfa && <MfaMark />}
                        {s.status === 'revoked' && s.revokedReason && ` · ${s.revokedBy ? `cerrada por ${s.revokedBy.name}` : REASON_LABELS[s.revokedReason] ?? s.revokedReason}`}
                      </p>
                    </div>
                    {canManage && s.status === 'active' && (
                      <button type="button" onClick={() => onRevoke(s)} className={dangerLink}>Cerrar</button>
                    )}
                  </li>
                ))}
                {data.sessions.length === 0 && <li className="py-2 text-[var(--color-text-secondary)]">Sus sesiones ya caducaron y se borraron; queda el historial.</li>}
              </ul>
            </section>

            <section className="space-y-2 border-t border-[var(--color-border-light)] pt-5">
              <h3 className="text-sm font-bold">Historial de este dispositivo</h3>
              <ul className="divide-y divide-[var(--color-border-light)]">
                {data.events.map((e) => (
                  <li key={e.id} className="flex justify-between gap-3 py-2">
                    <span className={e.result === 'failure' ? 'font-semibold text-[var(--color-danger)]' : ''}>{EVENT_LABELS[e.type] ?? e.type}</span>
                    <span className="tabular shrink-0 text-[11px] text-[var(--color-text-secondary)]">{dateTime(e.createdAt)} · {e.ip}</span>
                  </li>
                ))}
                {data.events.length === 0 && <li className="py-2 text-[var(--color-text-secondary)]">Sin eventos registrados.</li>}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="tabular truncate text-sm font-semibold">{value}</dd>
    </div>
  );
}
