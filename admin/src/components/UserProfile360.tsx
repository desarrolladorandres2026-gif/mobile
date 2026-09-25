import { useEffect, useState } from 'react';
import {
  X, ShoppingBag, CreditCard, Star, MessageSquareWarning, ShieldAlert,
  Smartphone, ScrollText, AlertTriangle, MapPin, Wallet, Crown, FileCheck,
  FileText, RotateCcw, Ticket, UserCog, StickyNote, Eye, EyeOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { Permission } from '../lib/permissions';
import type { UserProfileExtras } from '../lib/fichaTypes';
import { useAuthStore } from '../stores/authStore';
import EntityLink from './EntityLink';
import InternalNotes from './InternalNotes';

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

interface Profile360 extends UserProfileExtras {
  user: {
    name?: string;
    email?: string;
    phone?: string;
    /** En la vista enmascarada el servidor manda estas en lugar de las completas. */
    emailMasked?: string;
    phoneMasked?: string;
    role?: string;
    createdAt?: string;
  };
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
  const canSeeSensitive = useAuthStore((s) => s.hasPermission(Permission.USERS_VIEW_SENSITIVE));
  const [data, setData] = useState<Profile360 | null>(null);
  const [error, setError] = useState('');
  // Ver los datos completos es un acto deliberado: por defecto la ficha sale
  // enmascarada para todos, y pedir la completa queda auditado en el servidor.
  const [wantFull, setWantFull] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [viewError, setViewError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSwitching(true);
    api
      .get(`/admin/users/${userId}/profile-360`, { params: wantFull ? { view: 'full' } : undefined })
      .then((res) => {
        if (cancelled) return;
        setData(res.data.data);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        const message = apiMessage(err, 'No se pudo cargar el historial.');
        if (wantFull) {
          // Sin permiso o limitado: se queda en la vista enmascarada y se explica.
          setViewError(message);
          setWantFull(false);
        } else {
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled) setSwitching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, wantFull]);

  const currentView = data?.view ?? 'masked';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="h-full w-full max-w-xl overflow-y-auto bg-[var(--color-surface)] p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-[var(--color-text-main)]">
              {data?.user.name ?? 'Historial del usuario'}
            </h2>
            <p className="truncate text-xs text-[var(--color-text-secondary)]">
              {data?.user.email ?? data?.user.emailMasked} · {data?.user.phone ?? data?.user.phoneMasked} · desde{' '}
              {day(data?.user.createdAt)}
            </p>
            {data && (
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]">
                <span className="font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {currentView === 'full' ? 'Vista: datos completos' : 'Vista: enmascarada'}
                </span>
                {canSeeSensitive && (
                  <button
                    type="button"
                    onClick={() => {
                      setViewError('');
                      setWantFull(currentView !== 'full');
                    }}
                    className="flex cursor-pointer items-center gap-1 font-semibold text-[var(--color-primary)]"
                  >
                    {currentView === 'full' ? (
                      <><EyeOff className="h-3 w-3" /> Volver a la vista enmascarada</>
                    ) : (
                      <><Eye className="h-3 w-3" /> Ver datos completos</>
                    )}
                  </button>
                )}
                {switching && <span className="text-[var(--color-text-muted)]">Cargando…</span>}
              </p>
            )}
            {viewError && (
              <p className="mt-1 flex items-start gap-1.5 text-[11px] font-semibold text-[var(--color-danger)]">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {viewError}
              </p>
            )}
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
              <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-[var(--color-danger)]">
                <ShieldAlert className="h-4 w-4" /> Esta cuenta está bloqueada
              </p>
            ) : null}

            <div className="grid grid-cols-3 gap-x-6 gap-y-4 pb-4">
              {[
                { label: 'Pedidos', value: String(data.totals.orders) },
                { label: 'Gastado', value: money(data.totals.spent) },
                { label: '% cancelación', value: `${data.totals.cancellationRate}%` },
                { label: 'Entregados', value: String(data.totals.delivered) },
                { label: 'Cancelados', value: String(data.totals.cancelled) },
              ].map((kpi) => (
                <div key={kpi.label}>
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
                      <EntityLink type="order" id={o._id}>
                        {o.orderNumber ?? 'Pedido'}
                      </EntityLink>{' '}
                      · {o.businessId?.name ?? 'Mandado'} · {o.status}
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

            {/* Secciones nuevas: el servidor las omite o manda null si falta
                el permiso o la versión aún no las trae. */}
            {data.addresses && (
              <Section icon={MapPin} title="Direcciones" empty={!data.addresses.length}>
                <ul className="space-y-1">
                  {data.addresses.map((a) => (
                    <li key={a._id} className="text-[var(--color-text-secondary)]">
                      <span className="font-semibold text-[var(--color-text-main)]">{a.label ?? 'Dirección'}</span>
                      {' · '}
                      {a.address
                        ? `${a.address}${a.apartment ? `, ${a.apartment}` : ''} · ${[a.neighborhood, a.city].filter(Boolean).join(', ')}`
                        : [a.neighborhood, a.city].filter(Boolean).join(', ')}
                      {a.isDefault ? ' · principal' : ''}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.savedCards && (
              <Section icon={Wallet} title="Tarjetas guardadas" empty={!data.savedCards.length}>
                <ul className="space-y-1">
                  {data.savedCards.map((c) => (
                    <li key={c._id} className="text-[var(--color-text-secondary)]">
                      {c.brand ?? 'Tarjeta'} terminada en {c.last4 ?? '····'}
                      {c.expMonth && c.expYear ? ` · vence ${c.expMonth}/${c.expYear}` : ''}
                      {c.lastUsedAt ? ` · último uso ${day(c.lastUsedAt)}` : ''}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.pro !== undefined && (
              <Section icon={Crown} title="Zipp Pro" empty={!data.pro}>
                {data.pro && (
                  <p className="text-[var(--color-text-secondary)]">
                    <span className="font-semibold text-[var(--color-text-main)]">{data.pro.status ?? '—'}</span>
                    {data.pro.plan ? ` · ${data.pro.plan}` : ''}
                    {data.pro.startedAt ? ` · desde ${day(data.pro.startedAt)}` : ''}
                    {data.pro.currentPeriodEnd ? ` · vigente hasta ${day(data.pro.currentPeriodEnd)}` : ''}
                    {data.pro.cancelledAt ? ` · cancelada ${day(data.pro.cancelledAt)}` : ''}
                    {data.pro.autoRenew != null ? ` · ${data.pro.autoRenew ? 'renovación automática' : 'sin renovación'}` : ''}
                  </p>
                )}
              </Section>
            )}

            {data.consents && (
              <Section
                icon={FileCheck}
                title="Consentimientos"
                empty={data.consents.marketingConsent == null && !data.consents.legal?.length}
              >
                <ul className="space-y-1">
                  {data.consents.marketingConsent != null && (
                    <li className="text-[var(--color-text-secondary)]">
                      Mercadeo: {data.consents.marketingConsent ? 'acepta' : 'no acepta'}
                      {data.consents.marketingConsentAt ? ` · ${day(data.consents.marketingConsentAt)}` : ''}
                    </li>
                  )}
                  {data.consents.legal?.map((l, i) => (
                    <li key={`${l.type}-${l.version}-${i}`} className="text-[var(--color-text-secondary)]">
                      {l.type}
                      {l.version ? ` v${l.version}` : ''} · aceptado {day(l.acceptedAt)}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.dataRequests && (
              <Section icon={FileText} title="Solicitudes de datos" empty={!data.dataRequests.length}>
                <ul className="space-y-1">
                  {data.dataRequests.map((r) => (
                    <li key={r._id} className="flex justify-between gap-3 text-[var(--color-text-secondary)]">
                      <span>
                        {r.type ?? 'Solicitud'} · {day(r.createdAt)}
                        {r.dueAt ? ` · vence ${day(r.dueAt)}` : ''}
                      </span>
                      <span className="shrink-0 font-semibold text-[var(--color-text-main)]">{r.status}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.refunds && (
              <Section icon={RotateCcw} title="Reembolsos" empty={!data.refunds.length}>
                <ul className="space-y-1">
                  {data.refunds.map((r) => (
                    <li key={r._id} className="flex justify-between gap-3">
                      <span className="text-[var(--color-text-secondary)]">
                        {day(r.createdAt)} · {r.status}
                        {r.orderId ? (
                          <>
                            {' · '}
                            <EntityLink type="order" id={r.orderId}>
                              ver pedido
                            </EntityLink>
                          </>
                        ) : null}
                        {r.reason ? ` — ${r.reason}` : ''}
                      </span>
                      <span className="shrink-0 font-semibold text-[var(--color-text-main)]">{money(r.amount)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.couponRedemptions && (
              <Section icon={Ticket} title="Cupones usados" empty={!data.couponRedemptions.length}>
                <ul className="space-y-1">
                  {data.couponRedemptions.map((c) => (
                    <li key={c._id} className="flex justify-between gap-3 text-[var(--color-text-secondary)]">
                      <span>
                        {c.code ?? 'Cupón'} · {day(c.createdAt)}
                        {c.orderId ? (
                          <>
                            {' · '}
                            <EntityLink type="order" id={c.orderId}>
                              ver pedido
                            </EntityLink>
                          </>
                        ) : null}
                      </span>
                      {c.discount != null && (
                        <span className="shrink-0 font-semibold text-[var(--color-text-main)]">
                          -{money(c.discount)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.actionsOnUser && (
              <Section icon={UserCog} title="Acciones sobre la cuenta" empty={!data.actionsOnUser.length}>
                <ul className="space-y-1">
                  {data.actionsOnUser.map((a) => (
                    <li key={a._id} className="text-[var(--color-text-secondary)]">
                      {day(a.createdAt)} · {a.description ?? a.action}
                      {a.actorName ? ` · ${a.actorName}` : ''}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.notes !== null && (
              <Section icon={StickyNote} title="Notas internas" empty={false}>
                <InternalNotes entityType="user" entityId={userId} />
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
