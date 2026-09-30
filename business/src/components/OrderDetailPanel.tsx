import { useEffect, useState, type ReactNode } from 'react';
import { X, Lock, Camera, ImageOff } from 'lucide-react';
import api from '../services/api';
import OrderTimeline from './OrderTimeline';
import {
  statusStyle, money, signedMoney, shortId, dateTime, clock,
  type BusinessOrder, type FlowState, type OrderFinance, type OrderItem, describeExtras,
} from '../lib/orderFlow';
import { SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../lib/contact';

/**
 * Todo lo que el comercio sabe de un pedido, a pantalla completa.
 *
 * Ocupa el área de contenido y deja a la vista la barra lateral y la
 * cabecera, para que el comercio no pierda la navegación. Se ordena en
 * cuadrículas, igual que el resto del panel.
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

const DRIVER_STATUSES: Record<string, string> = {
  available: 'Disponible',
  busy: 'En reparto',
  offline: 'Desconectado',
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

  // `Escape` cierra.
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
  const netShown = line ? line.netAmount : net;

  const pickup = flow?.pickup;
  const pickupEvidence = pickup?.evidence ?? null;

  const driverRows: ReactNode[][] = driver
    ? [
        ['Nombre', driverUser?.name ?? 'Domiciliario'],
        ['Estado', (driver.status ? DRIVER_STATUSES[driver.status] : null) ?? driver.status ?? ''],
        ['Vehículo', `${driver.vehicleType === 'bicycle' ? 'Bicicleta' : 'Moto'}${driver.licensePlate ? ` · ${driver.licensePlate}` : ''}`],
        ['Llegó al local', pickup?.arrivedAt ? clock(pickup.arrivedAt) : 'Todavía en camino al local'],
        ['Foto de lo que recibe', pickupEvidence ? clock(pickupEvidence.uploadedAt) : 'Falta la foto de recogida'],
        ['Recogida con código', pickup?.verifiedAt ? clock(pickup.verifiedAt) : 'El pedido aún no ha salido del local'],
        ...(pickup?.attempts ? [['Intentos fallidos del código', String(pickup.attempts)]] : []),
      ]
    : [];

  return (
    // Área de contenido: bajo la cabecera (h-20) y junto a la barra lateral (w-30, fija desde lg).
    <div
      role="dialog"
      aria-label={`Pedido ${order.orderNumber ?? shortId(order._id)}`}
      className="fixed bottom-0 left-0 right-0 top-20 z-30 overflow-y-auto bg-[var(--color-bg)] p-6 lg:left-30 lg:p-8"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold tabular text-[var(--color-text-main)]">
            Pedido {order.orderNumber ?? shortId(order._id)}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.chip}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
              {style.label}
            </span>
            <span className="text-[11px] text-[var(--color-text-secondary)]">
              {dateTime(order.createdAt)}
            </span>
          </div>
        </div>

        <button
          onClick={onClose}
          aria-label="Cerrar"
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[var(--color-text-main)]"
        >
          <X className="h-4 w-4" /> Volver a pedidos
        </button>
      </div>

      <div className="mt-6 space-y-6 pb-8">
        {/* El código, cuando toca enseñarlo. Solo llega si el servidor lo entrega. */}
        {flow?.pickup.code ? <PickupCode code={flow.pickup.code} /> : null}

        <Facts
          title="Resumen"
          items={[
            ['Estado', style.label],
            ['Creado', dateTime(order.createdAt)],
            ['Pago', order.paymentMethod === 'online' ? 'Digital' : 'Efectivo al recibir'],
            ['Liquidación', line ? (PAYOUT_LABELS[line.payoutStatus] ?? line.payoutStatus) : ''],
            ['Neto para el comercio', money(netShown)],
          ]}
        />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Grid
            title="Cliente y entrega"
            head={['Dato', 'Valor']}
            empty="Sin datos del cliente."
            rows={[
              ['Nombre', client?.name ?? 'Cliente'],
              ...(client?.phone
                ? [['Teléfono', <a key="tel" href={`tel:${client.phone}`} className="text-[var(--color-primary)] hover:underline">{client.phone}</a>]]
                : []),
              ['Dirección', `${order.deliveryAddress ?? ''}${order.deliveryDetails ? ` · ${order.deliveryDetails}` : ''}`],
              ...(order.notes ? [['Observaciones del cliente', <span key="obs" className="text-[var(--color-warning)]">{order.notes}</span>]] : []),
            ]}
          />

          <Grid
            title="Domiciliario"
            head={['Dato', 'Valor']}
            empty="Todavía no hay domiciliario asignado. Te avisamos en cuanto ZIPP asigne uno."
            rows={driverRows}
          />
        </div>

        {pickup?.lockedUntil ? (
          <p className="text-xs font-semibold text-[var(--color-danger)]">
            El domiciliario falló el código demasiadas veces y está bloqueado temporalmente.
            No le entregues el pedido: avisa a soporte ZIPP al{' '}
            {/* Enlace de WhatsApp y no `tel:`: esto se ve desde el computador del
                mostrador, donde un `tel:` no tiene quién lo abra. */}
            <a
              href={supportWhatsAppUrl(
                `Hola, soy un comercio de Zipp. El domiciliario${
                  driver?.licensePlate ? ` de placa ${driver.licensePlate}` : ''
                } quedó bloqueado por fallar el código de recogida.`,
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {SUPPORT_PHONE_DISPLAY}
            </a>.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Grid
            title="Productos"
            head={['Cant.', 'Producto', 'Total']}
            empty="Sin productos."
            right={[2]}
            rows={(order.items ?? []).map((item: OrderItem) => [
              item.quantity,
              <>
                {item.productName}
                {item.selectedExtras?.length ? (
                  <span className="block text-[11px] text-[var(--color-text-secondary)]">
                    {describeExtras(item.selectedExtras)}
                  </span>
                ) : null}
                {item.notes ? (
                  <span className="block text-[11px] text-[var(--color-warning)]">Nota: {item.notes}</span>
                ) : null}
              </>,
              // `totalPrice` y no `price * quantity`: el pedido guarda el total
              // de la línea ya con adicionales incluidos.
              money(item.totalPrice ?? item.unitPrice * item.quantity),
            ])}
          />

          <Grid
            title="Detalle financiero"
            head={['Concepto', 'Importe']}
            empty="Sin desglose."
            right={[1]}
            rows={[
              ['Venta de productos', money(productSubtotal)],
              ...(funded > 0 ? [['Descuento que asumes', signedMoney(-funded)]] : []),
              ['Comisión ZIPP', signedMoney(-commission)],
              ...(line && line.reversedAmount > 0 ? [['Revertido por reembolso', signedMoney(-line.reversedAmount)]] : []),
              ['Neto para el comercio', money(netShown)],
              ...(line?.settledAt ? [['Consignado el', dateTime(line.settledAt)]] : []),
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-bold text-[var(--color-text-main)]">Evidencia de recogida</h3>
            <Evidence
              evidence={pickupEvidence}
              loading={loading}
              emptyHint={
                order.status === 'pending' || order.status === 'accepted'
                  ? 'Se registra cuando el domiciliario recoge el pedido.'
                  : 'El domiciliario todavía no ha tomado la foto.'
              }
            />
            {/* La foto de la entrega es la puerta de casa del cliente: el backend
                no se la entrega al comercio, y decirlo evita que parezca un fallo. */}
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              La foto de la entrega queda registrada para el cliente y para soporte; no se comparte con el comercio.
            </p>
          </section>

          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-bold text-[var(--color-text-main)]">Historial del pedido</h3>
            <OrderTimeline orderId={orderId} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Piezas ─────────────────────────────────────────────────────────────

/** Fila de encabezados sobre una fila de valores. */
function Facts({ title, items }: { title: string; items: Array<[string, ReactNode]> }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-sm font-bold text-[var(--color-text-main)]">{title}</h3>
      <div className="table-container">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                {items.map(([label]) => (
                  <th key={label} className="table-header-cell">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {items.map(([label, value]) => (
                  <td key={label} className="table-body-cell align-top text-sm font-semibold tabular">
                    {value || '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Grid({
  title, head, rows, empty, right = [],
}: {
  title: string;
  head: string[];
  rows: ReactNode[][];
  empty: string;
  /** Índices de columnas alineadas a la derecha (importes). */
  right?: number[];
}) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-sm font-bold text-[var(--color-text-main)]">{title}</h3>
      <div className="table-container">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                {head.map((h, i) => (
                  <th key={h} className={`table-header-cell ${right.includes(i) ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={head.length} className="table-body-cell text-[var(--color-text-secondary)]">{empty}</td>
                </tr>
              ) : (
                rows.map((cells, r) => (
                  <tr key={r}>
                    {cells.map((c, i) => (
                      <td key={i} className={`table-body-cell align-top ${right.includes(i) ? 'text-right tabular' : ''}`}>{c}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
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
    <section>
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
        <Lock className="h-3.5 w-3.5" />
        Código de recogida
      </p>
      <p className="mt-1.5 font-mono text-3xl font-bold tracking-[0.28em] text-[var(--color-primary-dark)]">
        {code}
      </p>
      <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
        Díctaselo al domiciliario. Solo entrégale el pedido cuando su app
        confirme que el código es correcto.
      </p>
    </section>
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
    return <div className="h-36 animate-pulse rounded-xl bg-[var(--color-bg-alt)]" />;
  }

  if (!evidence) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-[var(--color-text-secondary)]">
        <ImageOff className="h-4 w-4 shrink-0" />
        {emptyHint}
      </div>
    );
  }

  return (
    <figure>
      <img
        src={evidence.url}
        alt="Foto que tomó el domiciliario al recibir el pedido"
        className="h-56 w-full max-w-xl rounded-xl object-cover"
        loading="lazy"
      />
      <figcaption className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-success)]">
        <Camera className="h-3.5 w-3.5" />
        Registrada el {dateTime(evidence.uploadedAt)}
      </figcaption>
    </figure>
  );
}
