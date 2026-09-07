import { useEffect, useState } from 'react';
import {
  X, User, Bike, Camera, Lock, ShieldCheck, MapPin, Clock, Receipt,
  Landmark, ImageOff, Phone,
} from 'lucide-react';
import api from '../services/api';
import OrderTimeline from './OrderTimeline';
import {
  statusStyle, money, signedMoney, shortId, dateTime, clock,
  type BusinessOrder, type FlowState, type OrderFinance, type OrderItem, type OrderItemExtra,
  type PopulatedDriver, type PopulatedUser,
} from '../lib/orderFlow';

/**
 * Todo lo que el comercio sabe de un pedido, en un panel lateral.
 *
 * Es un cajón y no un modal centrado a propósito: el comercio consulta un
 * pedido *mientras* trabaja con la lista, y un modal que tapa la pantalla
 * obliga a cerrar para volver a mirar la cola de cocina.
 *
 * Se apoya en tres lecturas del servidor y ninguna cuenta la hace el
 * navegador:
 *
 *   /orders/:id/flow            código de recogida, llegada y evidencias
 *   /orders/:id/timeline        la historia con su actor
 *   /businesses/:id/statement/lines?orderId=…   en qué liquidación se cobró
 */

interface Props {
  order: BusinessOrder;
  businessId: string;
  onClose: () => void;
  /** Sube cuando llega un evento en vivo de este pedido. */
  refreshKey?: number;
}

interface StatementLine {
  netAmount: number;
  productSubtotal: number;
  merchantCommission: number;
  merchantFundedDiscount: number;
  reversedAmount: number;
  payoutStatus: string;
  settlementId: string | null;
  settledAt: string | null;
}

const PAYOUT_LABELS: Record<string, string> = {
  accrued: 'Pendiente de cobro',
  payable: 'Listo para la próxima liquidación',
  settled: 'Ya liquidado',
  reversed: 'Revertido',
};

export default function OrderDetailPanel({ order, businessId, onClose, refreshKey = 0 }: Props) {
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [line, setLine] = useState<StatementLine | null>(null);
  const [loading, setLoading] = useState(true);

  const orderId = order?._id;

  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    setLoading(true);

    // Las dos lecturas van juntas porque la ficha no está completa sin
    // ninguna de ellas; `allSettled` para que un fallo de una no deje la
    // otra sin pintar.
    Promise.allSettled([
      api.get(`/orders/${orderId}/flow`),
      api.get(`/businesses/${businessId}/statement/lines`, { params: { orderId } }),
    ])
      .then(([flowRes, lineRes]) => {
        if (!alive) return;
        setFlow(flowRes.status === 'fulfilled' ? flowRes.value.data.data : null);
        setLine(
          lineRes.status === 'fulfilled' ? (lineRes.value.data.data?.[0] ?? null) : null
        );
      })
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; };
  }, [orderId, businessId, refreshKey]);

  // `Escape` cierra: es un cajón y se comporta como tal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!order) return null;

  const style = statusStyle(order.status);
  const client = order.clientId;
  const driver = order.driverId;
  const driverUser = driver?.userId;
  const finance: Partial<OrderFinance> = order.finance ?? {};

  const productSubtotal = finance.productSubtotal ?? order.subtotal ?? 0;
  const commission = finance.merchantCommission ?? order.platformCommission ?? 0;
  const funded = finance.merchantFundedDiscount ?? 0;
  const net = finance.businessPayout ?? order.businessPayout ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Cerrar el detalle"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] cursor-default"
      />

      <aside
        role="dialog"
        aria-label={`Pedido ${order.orderNumber ?? shortId(order._id)}`}
        className="relative h-full w-full sm:max-w-md lg:max-w-lg bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl overflow-y-auto animate-fade-in"
      >
        {/* Encabezado fijo: el número y el estado siguen visibles al bajar. */}
        <header className="sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)] px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Pedido
            </p>
            <h2 className="text-base font-bold text-[var(--color-text-main)] tabular truncate">
              {order.orderNumber ?? shortId(order._id)}
            </h2>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${style.chip}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                {style.label}
              </span>
              <span className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {dateTime(order.createdAt)}
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </header>

        <div className="px-5 py-5 space-y-7">
          {/* ── El código, cuando toca enseñarlo ── */}
          {flow?.pickup.code ? <PickupCode code={flow.pickup.code} /> : null}

          {/* ── Cliente ── */}
          <Section icon={User} title="Cliente">
            <p className="text-sm font-semibold text-[var(--color-text-main)]">
              {client?.name ?? 'Cliente'}
            </p>
            {client?.phone ? (
              <a
                href={`tel:${client.phone}`}
                className="text-xs text-[var(--color-primary)] hover:underline inline-flex items-center gap-1 mt-0.5"
              >
                <Phone className="w-3 h-3" /> {client.phone}
              </a>
            ) : null}
            <p className="text-xs text-[var(--color-text-secondary)] mt-1.5 flex items-start gap-1.5">
              <MapPin className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--color-text-muted)]" />
              <span>
                {order.deliveryAddress}
                {order.deliveryDetails ? ` · ${order.deliveryDetails}` : ''}
              </span>
            </p>
          </Section>

          {/* ── Productos ── */}
          <Section icon={Receipt} title="Productos">
            <ul className="divide-y divide-[var(--color-border-light)] -mt-1">
              {(order.items ?? []).map((item: OrderItem, index: number) => (
                <li key={index} className="py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold text-[var(--color-text-main)]">
                      <span className="text-[var(--color-primary)] tabular">{item.quantity}×</span>{' '}
                      {item.productName}
                    </span>
                    {/*
                      `totalPrice` y no `price * quantity`: el pedido guarda
                      el total de la línea ya con adicionales incluidos, y
                      `price` sencillamente no existe en el esquema — la
                      versión anterior de esta ficha mostraba $0 en todas
                      las líneas por leer ese campo inexistente.
                    */}
                    <span className="text-xs font-bold tabular text-[var(--color-text-main)] shrink-0">
                      {money(item.totalPrice ?? item.unitPrice * item.quantity)}
                    </span>
                  </div>

                  {item.selectedExtras?.length ? (
                    <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {item.selectedExtras
                        .map((extra: OrderItemExtra) => `${extra.quantity ?? 1}× ${extra.name}`)
                        .join(' · ')}
                    </p>
                  ) : null}

                  {item.notes ? (
                    <p className="text-[11px] text-[var(--color-warning)] mt-0.5 font-medium">
                      Nota: {item.notes}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>

            {order.notes ? (
              <p className="text-[11px] text-[var(--color-warning)] font-medium mt-2 px-2.5 py-2 rounded-lg bg-[var(--color-warning-bg)] border border-[var(--color-warning)]/30">
                Observaciones del cliente: {order.notes}
              </p>
            ) : null}
          </Section>

          {/* ── Domiciliario ── */}
          <Section icon={Bike} title="Domiciliario">
            {driver ? (
              <DriverBlock driver={driver} user={driverUser ?? null} flow={flow} />
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">
                Todavía no hay domiciliario asignado. Te avisamos en cuanto ZIPP
                asigne uno.
              </p>
            )}
          </Section>

          {/* ── Evidencia ── */}
          <Section icon={Camera} title="Evidencia de recogida">
            <Evidence
              evidence={flow?.pickup.evidence ?? null}
              loading={loading}
              emptyHint={
                order.status === 'pending' || order.status === 'accepted'
                  ? 'Se registra cuando el domiciliario recoge el pedido.'
                  : 'El domiciliario todavía no ha tomado la foto.'
              }
            />
            {/*
              La foto de la entrega es la puerta de casa del cliente: el
              backend no se la entrega al comercio, y decirlo aquí evita
              que parezca que falta por un fallo.
            */}
            <p className="text-[11px] text-[var(--color-text-muted)] mt-2">
              La foto de la entrega queda registrada para el cliente y para
              soporte; no se comparte con el comercio.
            </p>
          </Section>

          {/* ── Dinero ── */}
          <Section icon={Landmark} title="Detalle financiero">
            <dl className="divide-y divide-[var(--color-border-light)] -mt-1">
              <Row label="Venta de productos" value={money(productSubtotal)} />
              {funded > 0 && (
                <Row label="Descuento que asumes" value={signedMoney(-funded)} tone="warning" />
              )}
              <Row label="Comisión ZIPP" value={signedMoney(-commission)} tone="warning" />
              {line && line.reversedAmount > 0 ? (
                <Row
                  label="Revertido por reembolso"
                  value={signedMoney(-line.reversedAmount)}
                  tone="danger"
                />
              ) : null}
              <Row
                label="Neto para el comercio"
                value={money(line ? line.netAmount : net)}
                tone="primary"
                strong
              />
            </dl>

            <p className="text-[11px] text-[var(--color-text-muted)] mt-2.5">
              Método de pago:{' '}
              <span className="font-semibold text-[var(--color-text-secondary)]">
                {order.paymentMethod === 'online' ? 'Digital' : 'Efectivo al recibir'}
              </span>
            </p>

            {line ? (
              <p className="text-[11px] mt-1.5 text-[var(--color-text-secondary)]">
                Estado de liquidación:{' '}
                <span className="font-semibold text-[var(--color-text-main)]">
                  {PAYOUT_LABELS[line.payoutStatus] ?? line.payoutStatus}
                </span>
                {line.settledAt ? ` · consignado el ${dateTime(line.settledAt)}` : ''}
              </p>
            ) : null}
          </Section>

          {/* ── Historia ── */}
          <Section icon={Clock} title="Historial del pedido">
            <OrderTimeline orderId={orderId} />
          </Section>
        </div>
      </aside>
    </div>
  );
}

// ── Piezas ─────────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] pb-2 mb-2.5 border-b border-[var(--color-border-light)]">
        <Icon className="w-3.5 h-3.5 text-[var(--color-primary)]" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label, value, tone = 'normal', strong = false,
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'warning' | 'danger' | 'primary';
  strong?: boolean;
}) {
  const tones = {
    normal: 'text-[var(--color-text-main)]',
    warning: 'text-[var(--color-warning)]',
    danger: 'text-[var(--color-danger)]',
    primary: 'text-[var(--color-primary)]',
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt
        className={`text-xs ${
          strong
            ? 'font-bold text-[var(--color-primary)]'
            : 'font-medium text-[var(--color-text-secondary)]'
        }`}
      >
        {label}
      </dt>
      <dd className={`text-xs font-bold tabular ${tones[tone]}`}>{value}</dd>
    </div>
  );
}

/**
 * El código de recogida.
 *
 * Solo llega desde el servidor mientras el pedido está listo y el código
 * sin usar; el panel no decide cuándo ocultarlo, lo recibe o no lo recibe.
 * Se dibuja grande y con separación entre dígitos porque se dicta en voz
 * alta en un mostrador ruidoso.
 */
function PickupCode({ code }: { code: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-primary)]/40 bg-[var(--color-primary-bg)] px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary-dark)]">
        <Lock className="w-3.5 h-3.5" />
        Código de recogida
      </p>
      <p className="font-mono font-bold text-2xl tracking-[0.28em] text-[var(--color-primary-dark)] mt-1.5">
        {code}
      </p>
      <p className="text-[11px] text-[var(--color-text-secondary)] mt-1.5">
        Díctaselo al domiciliario. Solo entrégale el pedido cuando su app
        confirme que el código es correcto.
      </p>
    </div>
  );
}

function DriverBlock({ driver, user, flow }: { driver: PopulatedDriver; user: PopulatedUser | null; flow: FlowState | null }) {
  const statuses: Record<string, string> = {
    available: 'Disponible',
    busy: 'En reparto',
    offline: 'Desconectado',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {user?.avatar ? (
          <img
            src={user.avatar}
            alt=""
            className="w-10 h-10 rounded-full object-cover border border-[var(--color-border)]"
          />
        ) : (
          <span className="w-10 h-10 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center shrink-0">
            <Bike className="w-4.5 h-4.5 text-[var(--color-primary)]" />
          </span>
        )}

        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
            {user?.name ?? 'Domiciliario'}
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {(driver.status ? statuses[driver.status] : null) ?? driver.status}
            {driver.licensePlate ? ` · ${driver.licensePlate}` : ''}
            {driver.vehicleType === 'bicycle' ? ' · Bicicleta' : ' · Moto'}
          </p>
        </div>
      </div>

      {/*
        Tres hechos y sus horas. El comercio pregunta exactamente esto
        cuando algo va mal: ¿llegó?, ¿se llevó el pedido?, ¿cuándo salió?
      */}
      <ul className="space-y-1.5">
        <Fact
          done={!!flow?.pickup.arrivedAt}
          label="Llegó al local"
          at={flow?.pickup.arrivedAt}
          pending="Todavía en camino al local"
        />
        <Fact
          done={!!flow?.pickup.evidence}
          label="Registró la foto de lo que recibe"
          at={flow?.pickup.evidence?.uploadedAt}
          pending="Falta la foto de recogida"
        />
        <Fact
          done={!!flow?.pickup.verifiedAt}
          label="Recogida confirmada con código"
          at={flow?.pickup.verifiedAt}
          pending="El pedido aún no ha salido del local"
        />
      </ul>

      {flow?.pickup.lockedUntil ? (
        <p className="text-[11px] font-semibold text-[var(--color-danger)] px-2.5 py-2 rounded-lg bg-[var(--color-danger-bg)] border border-[var(--color-danger)]/30">
          El domiciliario falló el código demasiadas veces y está bloqueado
          temporalmente. No le entregues el pedido: avisa a soporte ZIPP.
        </p>
      ) : flow?.pickup.attempts ? (
        <p className="text-[11px] text-[var(--color-warning)] font-medium">
          Lleva {flow.pickup.attempts} intento(s) fallido(s) del código.
        </p>
      ) : null}
    </div>
  );
}

function Fact({
  done, label, at, pending,
}: {
  done: boolean;
  label: string;
  at?: string | null;
  pending: string;
}) {
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <ShieldCheck
        className={`w-3.5 h-3.5 shrink-0 ${
          done ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]/50'
        }`}
      />
      <span className={done ? 'text-[var(--color-text-main)] font-medium' : 'text-[var(--color-text-muted)]'}>
        {done ? label : pending}
      </span>
      {done && at ? (
        <span className="tabular text-[var(--color-text-muted)] ml-auto">{clock(at)}</span>
      ) : null}
    </li>
  );
}

function Evidence({
  evidence, loading, emptyHint,
}: {
  evidence: { url: string; uploadedAt: string } | null;
  loading: boolean;
  emptyHint: string;
}) {
  if (loading) {
    return <div className="h-36 rounded-xl bg-[var(--color-bg-alt)] animate-pulse" />;
  }

  if (!evidence) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] py-3">
        <ImageOff className="w-4 h-4 shrink-0" />
        {emptyHint}
      </div>
    );
  }

  return (
    <figure className="rounded-xl overflow-hidden border border-[var(--color-border)]">
      <img
        src={evidence.url}
        alt="Foto que tomó el domiciliario al recibir el pedido"
        className="w-full h-44 object-cover bg-[var(--color-bg-alt)]"
        loading="lazy"
      />
      <figcaption className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-[var(--color-success)] bg-[var(--color-success-bg)]">
        <Camera className="w-3.5 h-3.5" />
        Registrada el {dateTime(evidence.uploadedAt)}
      </figcaption>
    </figure>
  );
}
