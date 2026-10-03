import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { qk } from '../lib/queryKeys';
import ConfirmDialog from './ConfirmDialog';

/**
 * Dónde está abierta esta cuenta ahora mismo, y el botón para cerrar lo que
 * no reconozca. Es a donde apunta el aviso de "nuevo dispositivo": sin esta
 * lista, el aviso decía "revisa tus sesiones" y no había dónde.
 *
 * Usa `/auth/sessions`, que ya existía para la app: nada de esto es nuevo en
 * el servidor. Las sesiones son de la persona, no del local, así que la
 * lista no cambia al cambiar de negocio.
 */

interface AccountSession {
  _id: string;
  current: boolean;
  identified?: boolean;
  mfa?: boolean;
  ip: string;
  lastIp?: string | null;
  lastActivity: string;
  createdAt: string;
  deviceInfo?: { platform?: string; os?: string; osVersion?: string; browser?: string; browserVersion?: string };
}

const since = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
};

function deviceLabel(s: AccountSession) {
  const d = s.deviceInfo ?? {};
  const browser = d.browser && d.browser !== 'unknown' ? [d.browser, d.browserVersion].filter(Boolean).join(' ') : 'Navegador desconocido';
  const os = d.os && d.os !== 'unknown' ? [d.os, d.osVersion].filter(Boolean).join(' ') : null;
  return os ? `${browser} · ${os}` : browser;
}

function DeviceIcon({ platform }: { platform?: string }) {
  const Icon = platform === 'mobile' ? Smartphone : platform === 'tablet' ? Tablet : Monitor;
  return <Icon className="w-5 h-5 shrink-0 text-[var(--color-text-muted)]" strokeWidth={1.75} />;
}

export default function ActiveSessions() {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<{ kind: 'one'; session: AccountSession } | { kind: 'others' } | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { data: sessions, isLoading, error } = useQuery({
    queryKey: qk.accountSessions(),
    queryFn: async () => (await api.get('/auth/sessions')).data.data.sessions as AccountSession[],
    staleTime: 30_000,
  });

  const revoke = useMutation({
    mutationFn: async (target: { kind: 'one'; session: AccountSession } | { kind: 'others' }) => {
      if (target.kind === 'one') {
        await api.delete(`/auth/sessions/${target.session._id}`);
        return 1;
      }
      const { data } = await api.post('/auth/sessions/revoke-all', {});
      return Number(data.data?.revokedCount ?? 0);
    },
    onSuccess: (count, target) => {
      setFeedback({
        tone: 'ok',
        text: target.kind === 'one' ? 'Sesión cerrada.' : count === 1 ? 'Se cerró 1 sesión.' : `Se cerraron ${count} sesiones.`,
      });
      void queryClient.invalidateQueries({ queryKey: qk.accountSessions() });
    },
    onError: (err) => setFeedback({ tone: 'error', text: apiMessage(err, 'No se pudo cerrar la sesión. Intenta de nuevo.') }),
  });

  const others = (sessions ?? []).filter((s) => !s.current);

  // El aviso de nuevo dispositivo enlaza a `/security#sesiones`. En una SPA
  // el navegador no baja solo hasta el ancla: se hace aquí, una vez que la
  // lista ya tiene su alto real.
  const { hash } = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (hash === '#sesiones' && sessions) sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash, sessions]);

  return (
    <section ref={sectionRef} id="sesiones" className="border-t border-[var(--color-border)] pt-6 space-y-4 scroll-mt-24">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Sesiones activas</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            Dónde está abierta tu cuenta. Si no reconoces una, ciérrala y cambia tu contraseña.
          </p>
        </div>
        {others.length > 0 && (
          <button
            type="button"
            onClick={() => { setFeedback(null); setConfirm({ kind: 'others' }); }}
            disabled={revoke.isPending}
            className="self-start sm:self-auto px-4 py-2 rounded-md border border-[var(--color-border-strong)] text-[var(--color-text-main)] font-semibold text-xs hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] transition-colors"
          >
            Cerrar las demás
          </button>
        )}
      </div>

      {feedback && (
        <p role="status" className={`text-xs font-semibold ${feedback.tone === 'ok' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
          {feedback.text}
        </p>
      )}

      {isLoading ? (
        <p className="text-xs text-[var(--color-text-muted)]">Cargando sesiones…</p>
      ) : error ? (
        <p className="text-xs text-[var(--color-danger)]">{apiMessage(error, 'No se pudieron cargar tus sesiones.')}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {(sessions ?? []).map((s) => (
            <li key={s._id} className="py-3 flex items-center gap-3">
              <DeviceIcon platform={s.deviceInfo?.platform} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
                  {deviceLabel(s)}
                  {s.current && <span className="ml-2 text-[11px] font-semibold text-[var(--color-primary)]">Este dispositivo</span>}
                </p>
                <p className="text-xs text-[var(--color-text-secondary)] flex flex-wrap items-center gap-x-2">
                  <span>IP {s.lastIp || s.ip}</span>
                  <span>· Activa {since(s.lastActivity)}</span>
                  {s.mfa && (
                    <span className="inline-flex items-center gap-1">
                      · <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-success)]" /> Con verificación en dos pasos
                    </span>
                  )}
                  {s.identified === false && <span className="text-[var(--color-warning)]">· Dispositivo sin identificar</span>}
                </p>
              </div>
              {!s.current && (
                <button
                  type="button"
                  onClick={() => { setFeedback(null); setConfirm({ kind: 'one', session: s }); }}
                  disabled={revoke.isPending}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors"
                >
                  Cerrar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'one' ? 'Cerrar esta sesión' : 'Cerrar las demás sesiones'}
          message={
            confirm.kind === 'one'
              ? `${deviceLabel(confirm.session)} tendrá que volver a iniciar sesión.`
              : `Se cerrarán ${others.length === 1 ? 'la otra sesión' : `las otras ${others.length} sesiones`}. Esta se queda abierta.`
          }
          confirmLabel="Cerrar sesión"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { revoke.mutate(confirm); setConfirm(null); }}
        />
      )}
    </section>
  );
}
