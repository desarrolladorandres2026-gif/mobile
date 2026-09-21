import { useEffect, useState } from 'react';
import {
  X, ShoppingBag, CreditCard, Star, MessageSquareWarning, ShieldAlert,
  Smartphone, ScrollText, AlertTriangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';

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
