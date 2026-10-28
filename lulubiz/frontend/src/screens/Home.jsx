import { useMemo, useState } from 'react';
import { ViewLink, DataTable, TextButton, errorMessage, useLoad } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { attentionItems, fillMonths, homeRanges, monthLabel, share, wholeAmount } from '../lib/home.js';
import { useSession, useTenantApi } from '../lib/session.jsx';

const skip = () => Promise.resolve(null);

/**
 * Accesos directos de «¿Qué deseas hacer?», en el orden en que más se usan. Cada uno lleva a la pantalla donde se
 * elabora el documento; el permiso solo decide si se muestra (el servidor comprueba cada petición).
 */
const TASKS = [
  { label: 'Crea una factura electrónica', path: 'facturas', permission: 'invoices:read' },
  { label: 'Crea una cotización', path: 'cotizaciones', permission: 'invoices:read' },
  { label: 'Registra una venta de mostrador', path: 'vender', permission: 'pos:sell' },
  { label: 'Registra una compra o gasto', path: 'compras', permission: 'purchases:read' },
  { label: 'Crea un comprobante contable', path: 'asientos', permission: 'journals:read' },
  { label: 'Crea un recibo de caja', path: 'recibos', permission: 'invoices:read' },
  { label: 'Crea un recibo de pago', path: 'pagos', permission: 'purchases:read' },
  { label: 'Crea un tercero', path: 'terceros', permission: 'parties:read' },
  { label: 'Crea un producto o servicio', path: 'articulos', permission: 'inventory:read' },
];

const TABS = [
  { key: 'accesos', label: 'Accesos directos' },
  { key: 'indicadores', label: 'Indicadores' },
  { key: 'habilitacion', label: 'Habilitación' },
];

/** Un bloque de la pantalla: una tarjeta sobre el fondo gris, con su título y su nota. */
function Block({ title, note, children }) {
  return (
    <section className="pt-2">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-base font-semibold text-tinta">{title}</h2>
        {note ? <p className="text-sm text-tinta-segundo">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Estado de una consulta que no está lista: cargando o fallida (con reintento). `null` si ya hay datos. */
function Pending({ load }) {
  if (load.error) {
    return (
      <p className="text-sm text-rojo-oscuro">
        {errorMessage(load.error)} <TextButton onClick={load.reload}>Reintentar</TextButton>
      </p>
    );
  }
  if (load.loading && !load.data) return <p className="text-sm text-tinta-segundo">Cargando…</p>;
  return null;
}

/** Una cifra de la posición: qué es, cuánto, una línea que la explica y a dónde ir para ver el detalle. */
function Figure({ label, load, value, note, to, toLabel }) {
  return (
    <div className="min-w-0 lg:px-5 lg:first:pl-0 lg:last:pr-0">
      <p className="text-sm font-semibold text-tinta">{label}</p>
      {load.data ? (
        <>
          <p className="mt-1 text-[clamp(1.25rem,3.4vh,2.25rem)] font-semibold leading-tight tabular-nums text-tinta">{value}</p>
          <p className="text-sm text-tinta-segundo">{note}</p>
          <ViewLink href={`/app/${to}`}>{toLabel}</ViewLink>
        </>
      ) : (
        <div className="mt-1">
          <Pending load={load} />
        </div>
      )}
    </div>
  );
}

function Attention({ items, loads }) {
  const waiting = loads.some((l) => l.loading && !l.data && !l.error);
  if (items.length === 0) {
    return (
      <p className="text-sm text-tinta">
        {waiting ? 'Revisando cartera, pagos y existencias…' : 'Nada pendiente: no hay cartera ni pagos vencidos, existencias bajo su mínimo ni pasos de configuración sin hacer.'}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-borde">
      {items.map((i) => (
        <li key={i.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0 py-2">
          <div className="min-w-0">
            <p className="font-semibold text-tinta">{i.text}</p>
            <p className="text-sm text-tinta-segundo">{i.detail}</p>
          </div>
          <ViewLink href={`/app/${i.path}`}>{i.action}</ViewLink>
        </li>
      ))}
    </ul>
  );
}

export function HomeScreen() {
  const base = useTenantApi();
  const { tenant, can } = useSession();
  const currency = tenant.currency;
  const range = useMemo(() => homeRanges(), []);
  const q = (path, params) => `${base}${path}?${new URLSearchParams({ ...params, currency })}`;

  const canReports = can('reports:read');
  const canSales = can('invoices:read');
  const canPurchases = can('purchases:read');
  const canStock = can('inventory:read');

  const cash = useLoad(() => (canReports ? api.get(q('/reports/cash-flow', { from: range.yearStart, to: range.today })) : skip()), [base]);
  const receivables = useLoad(() => (canSales ? api.get(q('/receivables/aging', {})) : skip()), [base]);
  const payables = useLoad(() => (canPurchases ? api.get(q('/payables/aging', {})) : skip()), [base]);
  const months = useLoad(() => (canReports ? api.get(q('/reports/sales-summary', { by: 'month', from: range.monthsFrom, to: range.today })) : skip()), [base]);
  const clients = useLoad(() => (canReports ? api.get(q('/reports/sales-summary', { by: 'customer', from: range.yearStart, to: range.today })) : skip()), [base]);
  const setup = useLoad(() => (canReports ? api.get(`${base}/onboarding`) : skip()), [base]);
  const stock = useLoad(() => (canStock ? api.get(`${base}/inventory/low-stock`) : skip()), [base]);

  const attention = attentionItems({ onboarding: setup.data, receivables: receivables.data, payables: payables.data, lowStock: stock.data?.items ?? null }, currency);
  const attentionLoads = [setup, receivables, payables, stock].filter((l) => l.loading || l.data || l.error);
  const showAttention = canReports || canSales || canPurchases || canStock;

  const series = months.data ? fillMonths(range.monthKeys, months.data.rows) : [];
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  const best = clients.data ? clients.data.rows.slice(0, 5) : [];
  const bestSum = best.reduce((s, r) => s + r.subtotal, 0);
  const longDate = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  const tasks = TASKS.filter((t) => can(t.permission));
  const overdue = (aging) => aging.totals.total - aging.totals.current;

  const [tab, setTab] = useState('accesos');
  const pendingSetup = setup.data?.requiredPending ?? 0;

  return (
    <div className="max-w-7xl">
      <h1 className="mb-4 text-2xl font-semibold text-tinta">Inicio</h1>

      <div role="tablist" aria-label="Inicio" className="flex flex-wrap items-end border-b border-azul">
        {TABS.map((t, k) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`panel-${t.key}`}
              onClick={() => setTab(t.key)}
              className={`relative -mb-px flex items-center gap-2 px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-azul ${
                selected ? 'rounded-t-sm border border-azul border-b-papel bg-papel text-azul' : `border border-transparent text-tinta hover:text-azul ${k > 0 && TABS[k - 1].key !== tab ? 'before:absolute before:left-0 before:top-1/2 before:h-5 before:-translate-y-1/2 before:border-l before:border-borde' : ''}`
              }`}
            >
              {t.label}
              {t.key === 'habilitacion' && pendingSetup > 0 ? (
                <span className="rounded-sm bg-rojo px-1.5 py-0.5 text-xs font-semibold text-white">
                  ¡{pendingSetup === 1 ? 'Falta 1 paso' : `Faltan ${pendingSetup} pasos`}!
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-5">
        {tab === 'accesos' ? (
          <section aria-labelledby="bienvenida">
            <h2 id="bienvenida" className="mb-3 text-lg font-semibold text-tinta">
              Te damos la bienvenida, ¿qué deseas hacer?
            </h2>
            {tasks.length === 0 ? (
              <p className="text-sm text-tinta">Tu rol no tiene accesos directos. Usa el menú de la izquierda.</p>
            ) : (
              <DataTable
                caption="Accesos directos"
                exportName={false}
                rows={tasks}
                rowKey={(t) => t.path}
                columns={[
                  { key: 'label', title: 'Tarea', render: (t) => t.label },
                  { key: 'go', title: 'Ir a', nowrap: true, render: (t) => <ViewLink href={`/app/${t.path}`}>Abrir</ViewLink> },
                ]}
              />
            )}
          </section>
        ) : null}

        {tab === 'indicadores' ? (
          <>
            <p className="mb-4 text-sm text-tinta-segundo">
              {tenant.name} · {longDate} · cifras en {currency}
            </p>
          {canReports || canSales || canPurchases ? (
            <section className="mb-[clamp(0.5rem,2vh,1.5rem)]" aria-label="Posición a hoy">
              <div className="grid gap-x-0 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-borde">
                {canReports ? (
                  <Figure
                    label="Caja y bancos"
                    load={cash}
                    value={cash.data ? wholeAmount(cash.data.closing, currency) : ''}
                    note={cash.data ? `${cash.data.accounts.length === 1 ? '1 cuenta' : `${cash.data.accounts.length} cuentas`}; ${cash.data.change >= 0 ? 'entró' : 'salió'} ${wholeAmount(Math.abs(cash.data.change), currency)} en lo que va del año` : ''}
                    to="flujo-efectivo"
                    toLabel="Ver flujo de efectivo"
                  />
                ) : null}
                {canSales ? (
                  <Figure
                    label="Por cobrar"
                    load={receivables}
                    value={receivables.data ? wholeAmount(receivables.data.totals.total, currency) : ''}
                    note={receivables.data ? (overdue(receivables.data) > 0 ? `${wholeAmount(overdue(receivables.data), currency)} vencidos` : 'Nada vencido') : ''}
                    to="cartera"
                    toLabel="Ver cartera"
                  />
                ) : null}
                {canPurchases ? (
                  <Figure
                    label="Por pagar"
                    load={payables}
                    value={payables.data ? wholeAmount(payables.data.totals.total, currency) : ''}
                    note={payables.data ? (overdue(payables.data) > 0 ? `${wholeAmount(overdue(payables.data), currency)} vencidos` : 'Nada vencido') : ''}
                    to="por-pagar"
                    toLabel="Ver cuentas por pagar"
                  />
                ) : null}
                {canReports ? (
                  <Figure
                    label="Ventas del mes"
                    load={months}
                    value={current ? wholeAmount(current.subtotal, currency) : ''}
                    note={previous ? `Sin IVA. Mes anterior completo: ${wholeAmount(previous.subtotal, currency)}` : ''}
                    to="informes"
                    toLabel="Ver informes"
                  />
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Todo cabe en una pantalla: tres columnas en escritorio, filas compactas, sin desplazamiento. */}
          <div className="grid gap-x-10 gap-y-5 lg:grid-cols-3 [&_td]:py-[clamp(2px,0.8vh,10px)] [&_th]:py-[clamp(2px,0.8vh,10px)]">
            {showAttention ? (
              <Block title="Requiere atención">
                <Attention items={attention} loads={attentionLoads} />
              </Block>
            ) : null}

            {canReports ? (
              <>
              <Block title="Ventas, seis meses" note="Sin IVA">
                {months.data ? (
                  <DataTable
                    caption="Ventas por mes"
                    exportName={false}
                    rows={[...series].reverse()}
                    rowKey={(r) => r.key}
                    columns={[
                      { key: 'month', title: 'Mes', nowrap: true, render: (r) => monthLabel(r.key) },
                      { key: 'invoices', title: 'Facturas', align: 'right', render: (r) => r.invoices },
                      { key: 'subtotal', title: 'Ventas', align: 'right', nowrap: true, render: (r) => wholeAmount(r.subtotal, currency) },
                    ]}
                  />
                ) : (
                  <Pending load={months} />
                )}
              </Block>

              <Block title="Mejores clientes del año" note={best.length > 0 ? `Top ${best.length}: ${share(bestSum, clients.data.totals.subtotal)} % de las ventas` : null}>
                {clients.data ? (
                  <DataTable
                    caption="Mejores clientes"
                    exportName={false}
                    rows={best}
                    rowKey={(r) => r.key}
                    empty="Todavía no hay ventas este año."
                    columns={[
                      { key: 'name', title: 'Cliente', render: (r) => r.name },
                      { key: 'subtotal', title: 'Ventas', align: 'right', nowrap: true, render: (r) => wholeAmount(r.subtotal, currency) },
                      { key: 'share', title: 'Del total', align: 'right', nowrap: true, render: (r) => `${share(r.subtotal, clients.data.totals.subtotal)} %` },
                    ]}
                  />
                ) : (
                  <Pending load={clients} />
                )}
              </Block>
              </>
            ) : null}
          </div>
          </>
        ) : null}

        {tab === 'habilitacion' ? (
          <section aria-label="Habilitación">
            <p className="mb-3 text-sm text-tinta">Lo que hay que dejar listo para operar con esta empresa. Se calcula con lo que ya está configurado.</p>
            {setup.data ? (
              <DataTable
                caption="Habilitación"
                exportName={false}
                rows={setup.data.steps}
                rowKey={(st) => st.key}
                columns={[
                  { key: 'title', title: 'Paso', render: (st) => st.title },
                  { key: 'state', title: 'Estado', nowrap: true, render: (st) => (st.done ? 'Hecho' : st.required ? 'Pendiente · obligatorio' : 'Pendiente · recomendado') },
                  { key: 'detail', title: 'Qué hay', render: (st) => st.detail },
                  { key: 'go', title: 'Ir a', nowrap: true, render: (st) => <ViewLink href={`/app/${st.path}`}>{st.done ? 'Revisar' : 'Hacerlo ahora'}</ViewLink> },
                ]}
              />
            ) : canReports ? (
              <Pending load={setup} />
            ) : (
              <p className="text-sm text-tinta">Tu rol no puede ver la configuración de la empresa.</p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
