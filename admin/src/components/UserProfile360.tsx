import { useEffect, useState } from 'react';
import {
  X, ShoppingBag, CreditCard, Star, MessageSquareWarning, ShieldAlert,
  Smartphone, ScrollText, AlertTriangle, Gift,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

/**
 * Historial completo de una persona.
 *
 * No calcula nada nuevo: pedidos, pagos, reseñas, reclamos, alertas,
 * sesiones y auditoría ya existían, cada uno en su colección y en su
 * pantalla. Lo que faltaba era poder verlos juntos, que es la única forma
 * de contestar la pregunta que de verdad se hace en soporte — "¿este cliente
 * pide reembolsos todas las semanas o es la primera vez que le pasa algo?".
 *
 * Se abre desde la ficha del usuario y no como página propia por lo mismo
 * que los reembolsos: quien la necesita ya está mirando a esa persona.
 */

interface Profile360 {
  user: { name?: string; email?: string; phone?: string; role?: string; createdAt?: string };
  totals: {
    orders: number;
    delivered: number;
    cancelled: number;
    spent: number;
    cancellationRate: number;
    loyaltyPoints: number;
  };
  recentOrders: Array<{
    _id: string;
    orderNumber?: string;
    status: string;
    total: number;
    createdAt: string;
    businessId?: { name?: string };
  }>;
  payments: Array<{ _id: string; amount: number; status: string; createdAt: string }>;
  reviews: Array<{ _id: string; rating: number; comment?: string; businessId?: { name?: string } }>;
  complaints: Array<{ _id: string; subject: string; status: string; createdAt: string }>;
  risk: {
    profile?: { riskScore?: number; isBlocked?: boolean } | null;
    openAlerts: Array<{ _id: string; description: string; riskLevel: string }>;
  };
  sessions: Array<{ _id: string; deviceName?: string; ip?: string; lastUsedAt?: string }>;
  recentActions: Array<{ _id: string; action: string; description?: string; createdAt: string }>;
}

const money = (value: number) => `$${(value || 0).toLocaleString('es-CO')}`;
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('es-CO') : '—');

function Section({
  icon: Icon,
  title,
  empty,
  children,
}: {
  icon: LucideIcon;
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 border-t border-[var(--color-border-light)] py-4">
      <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        <Icon className="h-3 w-3 text-[var(--color-primary)]" /> {title}
      </span>
      {empty ? <p className="text-[var(--color-text-muted)]">Nada por aquí.</p> : children}
    </div>
  );
}

/**
 * Corregir el saldo de puntos de un cliente a mano.
 *
 * Existe para resolver un reclamo ("el pedido llegó tarde", "no me dieron
 * los puntos") sin tocar la base de datos. Los puntos son un pasivo de ZIPP,
 * así que el servidor exige permiso de finanzas y un motivo, y deja el
 * ajuste firmado con quien lo hizo.
 */
function LoyaltyAdjust({
  userId,
  onAdjusted,
}: {
  userId: string;
  onAdjusted: (balance: number) => void;
}) {
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const submit = async () => {
    const amount = Math.trunc(Number(points));
    if (!amount) {
      setMessage({ tone: 'error', text: 'Escribe cuántos puntos sumar (o restar, con signo menos).' });
      return;
    }
    if (reason.trim().length < 5) {
      setMessage({ tone: 'error', text: 'Escribe el motivo (mínimo 5 caracteres). Queda en el historial del cliente.' });
      return;
    }

    try {
      setSaving(true);
      setMessage(null);
      const res = await api.post(`/admin/users/${userId}/loyalty-adjustment`, {
        points: amount,
        reason: reason.trim(),
      });
      onAdjusted(res.data.data.balance);
      setPoints('');
      setReason('');
      setMessage({
        tone: 'ok',
        text: `${amount > 0 ? 'Sumados' : 'Restados'} ${Math.abs(amount)} puntos. Saldo: ${res.data.data.balance}.`,
      });
    } catch (err) {
      setMessage({ tone: 'error', text: apiMessage(err, 'No se pudo ajustar el saldo.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg)] p-3">
      <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        <Gift className="h-3 w-3 text-[var(--color-primary)]" /> Ajustar puntos
      </span>
      <div className="flex gap-2">
        <input
          type="number"
          step={1}
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          placeholder="+500 o -200"
          aria-label="Puntos a sumar o restar"
          className="h-9 w-28 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 font-mono text-xs font-bold text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motivo: pedido llegó 40 min tarde"
          aria-label="Motivo del ajuste"
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
        />
        <button
          onClick={submit}
          disabled={saving}
          className="h-9 shrink-0 cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 text-xs font-bold text-white disabled:opacity-50"
        >
          {saving ? 'Guardando…' : 'Aplicar'}
        </button>
      </div>
      {message ? (
        <p className={message.tone === 'ok' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

export default function UserProfile360({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Profile360 | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/admin/users/${userId}/profile-360`)
      .then((res) => {
        if (!cancelled) setData(res.data.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.message ?? 'No se pudo cargar el historial.');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="h-full w-full max-w-xl overflow-y-auto bg-[var(--color-surface)] p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
              {data?.user.name ?? 'Historial del usuario'}
            </h2>
            <p className="truncate text-xs text-[var(--color-text-secondary)]">
              {data?.user.email} · {data?.user.phone} · desde {day(data?.user.createdAt)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-text-muted)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error ? (
          <p className="flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
            <AlertTriangle className="h-4 w-4" /> {error}
          </p>
        ) : !data ? (
          <p className="text-sm text-[var(--color-text-muted)]">Cargando…</p>
        ) : (
          <div className="text-xs">
            {/* Lo bloqueado va arriba del todo: cambia la respuesta a
                cualquier cosa que se vaya a hacer después. */}
            {data.risk.profile?.isBlocked ? (
              <p className="mb-3 flex items-center gap-1.5 rounded-lg bg-[var(--color-danger)] px-3 py-2 text-sm font-bold text-white">
                <ShieldAlert className="h-4 w-4" /> Esta cuenta está bloqueada
              </p>
            ) : null}

            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Pedidos', value: String(data.totals.orders) },
                { label: 'Gastado', value: money(data.totals.spent) },
                { label: '% cancelación', value: `${data.totals.cancellationRate}%` },
                { label: 'Entregados', value: String(data.totals.delivered) },
                { label: 'Cancelados', value: String(data.totals.cancelled) },
                { label: 'Puntos', value: String(data.totals.loyaltyPoints) },
              ].map((kpi) => (
                <div
                  key={kpi.label}
                  className="rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg)] p-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                    {kpi.label}
                  </p>
                  <p className="text-sm font-bold text-[var(--color-text-main)]">{kpi.value}</p>
                </div>
              ))}
            </div>

            {data.user.role === 'client' ? (
              <LoyaltyAdjust
                userId={userId}
                onAdjusted={(balance) =>
                  setData((prev) =>
                    prev ? { ...prev, totals: { ...prev.totals, loyaltyPoints: balance } } : prev
                  )
                }
              />
            ) : null}

            <Section icon={ShieldAlert} title="Alertas abiertas" empty={!data.risk.openAlerts.length}>
              <ul className="space-y-1">
                {data.risk.openAlerts.map((a) => (
                  <li key={a._id} className="text-[var(--color-text-secondary)]">
                    <span className="font-bold uppercase text-[var(--color-danger)]">
                      {a.riskLevel}
                    </span>{' '}
                    · {a.description}
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={ShoppingBag} title="Últimos pedidos" empty={!data.recentOrders.length}>
              <ul className="space-y-1">
                {data.recentOrders.map((o) => (
                  <li key={o._id} className="flex justify-between gap-3">
                    <span className="truncate text-[var(--color-text-secondary)]">
                      {o.businessId?.name ?? 'Mandado'} · {o.status}
                    </span>
                    <span className="shrink-0 font-semibold text-[var(--color-text-main)]">
                      {money(o.total)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={CreditCard} title="Pagos" empty={!data.payments.length}>
              <ul className="space-y-1">
                {data.payments.map((p) => (
                  <li key={p._id} className="flex justify-between gap-3">
                    <span className="text-[var(--color-text-secondary)]">
                      {day(p.createdAt)} · {p.status}
                    </span>
                    <span className="font-semibold text-[var(--color-text-main)]">
                      {money(p.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={MessageSquareWarning} title="Reclamos" empty={!data.complaints.length}>
              <ul className="space-y-1">
                {data.complaints.map((c) => (
                  <li key={c._id} className="text-[var(--color-text-secondary)]">
                    {c.subject} — <span className="font-semibold">{c.status}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={Star} title="Reseñas que escribió" empty={!data.reviews.length}>
              <ul className="space-y-1">
                {data.reviews.map((r) => (
                  <li key={r._id} className="text-[var(--color-text-secondary)]">
                    {r.rating}★ {r.businessId?.name ? `· ${r.businessId.name}` : ''}{' '}
                    {r.comment ? `— ${r.comment}` : ''}
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={Smartphone} title="Sesiones" empty={!data.sessions.length}>
              <ul className="space-y-1">
                {data.sessions.map((s) => (
                  <li key={s._id} className="text-[var(--color-text-secondary)]">
                    {s.deviceName ?? 'Dispositivo'} · {s.ip ?? 'sin IP'} · {day(s.lastUsedAt)}
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={ScrollText} title="Últimas acciones" empty={!data.recentActions.length}>
              <ul className="space-y-1">
                {data.recentActions.map((a) => (
                  <li key={a._id} className="text-[var(--color-text-secondary)]">
                    {day(a.createdAt)} · {a.description ?? a.action}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
