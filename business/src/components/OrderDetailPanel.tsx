import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X, Lock, Camera, ImageOff, LifeBuoy } from 'lucide-react';
import api from '../services/api';
import OrderTimeline from './OrderTimeline';
import {
  statusStyle, money, signedMoney, orderTag, dateTime, clock,
  type BusinessOrder, type FlowState, type OrderFinance, type OrderItem, describeExtras,
} from '../lib/orderFlow';
import { SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../lib/contact';
import { usePermissions } from '../hooks/usePermissions';
import { useAuthStore } from '../stores/authStore';

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

  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const orderId = order?._id;

  // Comisión, neto y liquidación son la capa financiera: solo quien tiene
  // `financial:view` (el propietario). Estricto —sin el "mientras carga, sí"
  // de `can`— porque un instante de $0 de comisión en la pantalla de un
  // empleado sería una cifra falsa, no una cortesía. El backend ya no manda
  // esos campos al personal (`merchantStaffOrderView`).
  const { access } = usePermissions(businessId);
  const seesMoney = !!access?.permissions.includes('financial:view');
  const fetchStatement = seesMoney;

  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    setLoading(true);

    // Las dos lecturas van juntas porque la ficha no está completa sin
    // ninguna de ellas; `allSettled` para que un fallo de una no deje la
    // otra sin pintar. La liquidación solo se pide a quien puede verla: a
    // los demás el servidor les respondería 403 en cada pedido que abran.
    Promise.allSettled([
      api.get(`/orders/${orderId}/flow`),
      fetchStatement
        ? api.get(`/businesses/${businessId}/statement/lines`, { params: { orderId } })
        : Promise.reject(new Error('sin permiso')),
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
  }, [orderId, businessId, refreshKey, fetchStatement]);

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
  const customerTotal = finance.customerTotal ?? order.total ?? 0;

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
    // Área de contenido: bajo la cabecera (h-12) y junto a la barra lateral (w-52, fija desde lg).
    <div
      role="dialog"
      aria-label={`Pedido ${orderTag(order)}`}
      className="fixed bottom-0 left-0 right-0 top-12 z-30 overflow-y-auto bg-[var(--color-bg)] px-5 py-5 lg:left-52 lg:px-8 lg:py-6"
    >
      <div className="flex items-start justify-end gap-4">
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* El caso nace atado a este pedido: Soporte no tiene que preguntar de cuál hablas. */}
          <Link
            to={`/support?order=${encodeURIComponent(order._id)}&n=${encodeURIComponent(order.orderNumber ?? '')}`}
            className="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-[var(--color-primary)] hover:underline"
          >
            <LifeBuoy className="h-4 w-4" /> Reportar un problema
          </Link>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
          >
            <X className="h-4 w-4" /> Volver a pedidos
          </button>
        </div>
      </div>

      <div className="mt-2 space-y-6 pb-8">
        {/* El código, cuando toca enseñarlo. Solo llega si el servidor lo entrega. */}
        {flow?.pickup.code ? <PickupCode code={flow.pickup.code} /> : null}

        {/* Orden de pedido: misma composición que el documento que el mostrador ya conoce. */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b-[3px] border-[var(--color-primary-dark)] pb-4">
          <p className="pt-2 text-xl font-bold text-[var(--color-primary-dark)]">
            {selectedBusiness?.name ?? 'Comercio'}
          </p>
          <div className="text-right">
            <p className="text-3xl font-extrabold uppercase tracking-tight text-[var(--color-text-main)]">Orden de pedido</p>
            <p className="text-lg font-bold text-[var(--color-primary-dark)] tabular">{orderTag(order)}</p>
            <p className="text-xs text-[var(--color-text-secondary)]">{dateTime(order.createdAt)}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Details
            title="Cliente"
            rows={[
              ['Nombre', client?.name ?? 'Cliente'],
              ...(client?.phone
                ? [['Teléfono', <a key="tel" href={`tel:${client.phone}`} className="text-[var(--color-primary-dark)] hover:underline">{client.phone}</a>] as [string, ReactNode]]
                : []),
              ['Dirección', `${order.deliveryAddress ?? ''}${order.deliveryDetails ? ` · ${order.deliveryDetails}` : ''}`],
              ...(order.notes ? [['Observaciones', <span key="obs" className="text-[var(--color-warning)]">{order.notes}</span>] as [string, ReactNode]] : []),
            ]}
          />
          <Details
            title="Detalles del pedido"
            dot={style.dot}
            rows={[
              ['N° pedido', orderTag(order)],
              ['Fecha', dateTime(order.createdAt)],
              ['Estado', style.label],
              ['Forma de pago', order.paymentMethod === 'online' ? 'Digital' : 'Efectivo al recibir'],
              ...(seesMoney && line
                ? [['Liquidación', PAYOUT_LABELS[line.payoutStatus] ?? line.payoutStatus] as [string, ReactNode]]
                : []),
            ]}
          />
        </div>

        <section className="min-w-0 space-y-4">
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-[var(--color-primary-dark)] text-[var(--color-surface)]">
                  <th className="w-12 px-4 py-3 text-xs font-bold">#</th>
                  <th className="px-4 py-3 text-xs font-bold">Producto</th>
                  <th className="px-4 py-3 text-center text-xs font-bold">Cant.</th>
                  <th className="px-4 py-3 text-right text-xs font-bold">Precio unit.</th>
                  <th className="px-4 py-3 text-right text-xs font-bold">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {(order.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-3 text-[var(--color-text-secondary)]">Sin productos.</td>
                  </tr>
                ) : (
                  (order.items ?? []).map((item: OrderItem, i) => (
                    <tr key={item._id ?? i} className={i % 2 ? 'bg-[var(--color-bg-alt)]' : 'bg-[var(--color-surface)]'}>
                      <td className="px-4 py-3 align-middle tabular text-[var(--color-text-secondary)]">{i + 1}</td>
                      <td className="px-4 py-3 align-middle">
                        {item.productName}
                        {item.selectedExtras?.length ? (
                          <span className="block text-xs text-[var(--color-text-secondary)]">
                            {describeExtras(item.selectedExtras)}
                          </span>
                        ) : null}
                        {item.notes ? (
                          <span className="block text-xs text-[var(--color-warning)]">Nota: {item.notes}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-center align-middle tabular">{item.quantity}</td>
                      <td className="px-4 py-3 text-right align-middle tabular">{money(item.unitPrice)}</td>
                      {/* `totalPrice` y no `unitPrice * quantity`: ya trae los adicionales. */}
                      <td className="px-4 py-3 text-right align-middle tabular font-bold">
                        {money(item.totalPrice ?? item.unitPrice * item.quantity)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <dl className="ml-auto w-full max-w-sm space-y-1.5 text-sm tabular">
            <Line label="Subtotal" value={money(productSubtotal)} />
            {!seesMoney && customerTotal > productSubtotal ? (
              <Line label="Domicilio" value={money(customerTotal - productSubtotal)} />
            ) : null}
            {seesMoney ? (
              <>
                {funded > 0 ? <Line label="Descuento que asumes" value={signedMoney(-funded)} /> : null}
                <Line label="Comisión ZIPP" value={signedMoney(-commission)} />
                {line && line.reversedAmount > 0 ? (
                  <Line label="Revertido por reembolso" value={signedMoney(-line.reversedAmount)} />
                ) : null}
                {line?.settledAt ? <Line label="Consignado el" value={dateTime(line.settledAt)} /> : null}
              </>
            ) : null}
            <div className="flex items-center justify-between gap-6 rounded-lg bg-[var(--color-primary-dark)] px-5 py-3 text-lg font-bold text-[var(--color-surface)]">
              <dt>{seesMoney ? 'NETO' : 'TOTAL'}</dt>
              <dd>{money(seesMoney ? netShown : customerTotal)}</dd>
            </div>
          </dl>
        </section>


        <Grid
          title="Domiciliario"
          head={['Dato', 'Valor']}
          empty="Todavía no hay domiciliario asignado. Te avisamos en cuanto ZIPP asigne uno."
          rows={driverRows}
        />

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
          <section className="min-w-0 space-y-2">
            <h3 className="text-[13px] font-semibold text-[var(--color-text-main)]">Evidencia de recogida</h3>
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
            <h3 className="text-[13px] font-semibold text-[var(--color-text-main)]">Historial del pedido</h3>
            <OrderTimeline orderId={orderId} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Piezas ─────────────────────────────────────────────────────────────

/** Ficha de datos de la orden: franja de título y filas de etiqueta/valor. */
function Details({ title, rows, dot }: { title: string; rows: Array<[string, ReactNode]>; dot?: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
      <h3 className="flex items-center justify-between bg-[var(--color-primary-dark)] px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-[var(--color-surface)]">
        {title}
        {dot ? <span className={`h-2.5 w-2.5 rounded-full ${dot}`} /> : null}
      </h3>
      <dl className="space-y-1.5 px-4 py-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_1fr] gap-3">
            <dt className="font-semibold text-[var(--color-text-secondary)]">{label}</dt>
            <dd className="min-w-0 break-words text-[var(--color-text-main)]">{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="text-[var(--color-text-main)]">{value}</dd>
    </div>
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
      <h3 className="text-[13px] font-semibold text-[var(--color-text-main)]">{title}</h3>
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
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
        <Lock className="h-3.5 w-3.5" />
        Código de recogida
      </p>
      <p className="mt-1.5 font-mono text-2xl font-semibold tracking-[0.2em] text-[var(--color-primary-dark)]">
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
    return <div className="h-36 animate-pulse rounded-md bg-[var(--color-bg-alt)]" />;
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
        className="h-56 w-full max-w-xl rounded-md object-cover"
        loading="lazy"
      />
      <figcaption className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-success)]">
        <Camera className="h-3.5 w-3.5" />
        Registrada el {dateTime(evidence.uploadedAt)}
      </figcaption>
    </figure>
  );
}
