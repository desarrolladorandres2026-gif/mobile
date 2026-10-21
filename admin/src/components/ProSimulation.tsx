import { useState } from 'react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import NumericInput from './NumericInput';

/**
 * Rentabilidad de Zipp Pro ANTES de abrir la venta.
 *
 * Es el mapa de lo que hay que medir, no una decisión: los parámetros son
 * supuestos de quien consulta y el servidor responde con las cifras que
 * salen del motor de precios real, qué supone la corrida y qué datos reales
 * faltan. No calcula nada aquí; no se guarda nada.
 */

interface Simulation {
  plan: { price: number; minSubtotal: number; freeDelivery: boolean; serviceFeeWaived: boolean };
  perOrder: {
    deliveryFee: number;
    serviceFee: number;
    deliveryDiscount: number;
    serviceFeeDiscount: number;
    benefitCost: number;
    reachesMinimum: boolean;
  };
  fee: { gross: number; gatewayFee: number; net: number; gatewayConfigured: boolean };
  breakEvenOrdersPerMonth: number | null;
  rows: Array<{
    ordersPerMonth: number;
    benefitOrders: number;
    benefitCost: number;
    netFee: number;
    contributionBeforeUnknowns: number;
  }>;
  confirmed: string[];
  assumptions: string[];
  missingData: string[];
}

const cop = (n: number) => `$${(n || 0).toLocaleString('es-CO')}`;
const signed = (n: number) => (n < 0 ? `− ${cop(-n)}` : cop(n));

const inputClass =
  'w-full h-9 rounded bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:outline-none';
const labelClass = 'block text-xs font-bold text-[var(--color-text-main)] mb-1';

export default function ProSimulation() {
  const [subtotal, setSubtotal] = useState(40_000);
  const [km, setKm] = useState('2');
  const [share, setShare] = useState('100');
  const [orders, setOrders] = useState('2,4,8,12,20');
  const [data, setData] = useState<Simulation | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    try {
      setLoading(true);
      setError('');
      const { data: res } = await api.get('/admin/growth/pro/simulation', {
        params: {
          averageSubtotal: subtotal,
          averageDistanceKm: Number(km) || 0,
          eligibleShare: Math.min(Math.max((Number(share) || 0) / 100, 0), 1),
          orders,
        },
      });
      setData(res.data as Simulation);
    } catch (err) {
      setData(null);
      setError(apiMessage(err, 'No se pudo simular.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-bold text-[var(--color-text-main)]">Simulación de rentabilidad</h2>
        <p className="mt-1 text-xs text-[var(--color-text-main)]">
          Cuánto le cuesta a ZIPP un socio según cuántos pedidos haga al mes, con el motor de precios real y la
          configuración vigente. Los valores de abajo son supuestos tuyos, no mediciones: el resultado es un
          techo, no una decisión.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={labelClass}>Ticket medio (productos)</label>
          <NumericInput value={subtotal} onValueChange={(d) => setSubtotal(Number(d))} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Distancia media (km)</label>
          <input value={km} onChange={(e) => setKm(e.target.value)} inputMode="decimal" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Pedidos que alcanzan el mínimo (%)</label>
          <input value={share} onChange={(e) => setShare(e.target.value)} inputMode="numeric" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Pedidos al mes a comparar</label>
          <input value={orders} onChange={(e) => setOrders(e.target.value)} className={inputClass} placeholder="2,4,8,12,20" />
        </div>
      </div>

      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="h-9 px-4 rounded bg-[var(--color-primary)] text-white font-bold text-xs cursor-pointer"
      >
        {loading ? 'Calculando…' : 'Simular'}
      </button>

      {error && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
           {error}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <p className="text-xs text-[var(--color-text-main)]">
            Cuota {cop(data.fee.gross)} − comisión de pasarela {cop(data.fee.gatewayFee)} = <strong>{cop(data.fee.net)}</strong> netos.
            Cada pedido con beneficio le cuesta a ZIPP <strong>{cop(data.perOrder.benefitCost)}</strong> (domicilio{' '}
            {cop(data.perOrder.deliveryDiscount)} + tarifa de servicio {cop(data.perOrder.serviceFeeDiscount)})
            {data.perOrder.reachesMinimum ? '' : ' — con este ticket no alcanza el mínimo, así que el beneficio es 0'}.
            {data.breakEvenOrdersPerMonth !== null &&
              ` El socio deja de ser rentable a partir de ${data.breakEvenOrdersPerMonth} pedidos con beneficio al mes.`}
          </p>

          <div className="table-container">
            <div className="overflow-x-auto">
              <table className="data-grid">
                <thead>
                  <tr className="text-left">
                    <th className="table-header-cell">Pedidos al mes</th>
                    <th className="table-header-cell">Con beneficio</th>
                    <th className="table-header-cell">Lo que regala ZIPP</th>
                    <th className="table-header-cell">Cuota neta</th>
                    <th className="table-header-cell">Resultado (techo)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.ordersPerMonth}>
                      <td className="table-body-cell text-[var(--color-text-main)]">{r.ordersPerMonth}</td>
                      <td className="table-body-cell text-[var(--color-text-main)]">{r.benefitOrders}</td>
                      <td className="table-body-cell text-[var(--color-text-main)]">− {cop(r.benefitCost)}</td>
                      <td className="table-body-cell text-[var(--color-text-main)]">{cop(r.netFee)}</td>
                      <td className={`table-body-cell font-bold ${r.contributionBeforeUnknowns < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
                        {signed(r.contributionBeforeUnknowns)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(
            [
              ['Confirmado (sale del código o de la configuración)', data.confirmed],
              ['Supuestos de esta corrida', data.assumptions],
              ['Datos reales que faltan para decidir', data.missingData],
            ] as const
          ).map(([title, items]) => (
            <div key={title} className="space-y-1">
              <h3 className="text-xs font-bold text-[var(--color-text-main)]">{title}</h3>
              <ul className="list-disc pl-5 space-y-0.5">
                {items.map((item) => (
                  <li key={item} className="text-xs text-[var(--color-text-main)]">{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
