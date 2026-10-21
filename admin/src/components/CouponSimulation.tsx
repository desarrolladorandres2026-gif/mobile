import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

/**
 * Simulación de una campaña antes de guardarla.
 *
 * No calcula nada: manda el borrador al servidor (`POST /coupons/preview`),
 * que lo evalúa con las mismas funciones con las que se cobra un pedido —
 * incluido el piso de margen con la comisión estimada de la pasarela — y se
 * limita a pintar lo que contesta. Solo lee: no crea cupones, pedidos ni
 * asientos, y no consume ningún cupo.
 */

export interface SimulationDraft {
  type: 'percentage' | 'fixed' | 'free_delivery';
  scope: 'product' | 'delivery' | 'service_fee';
  value: number;
  maxDiscount: number;
  maxDiscountAmount: number;
  minOrderAmount: number;
  fundedBy: 'platform' | 'business';
  minimumContributionMargin: number;
  firstOrderOnly: boolean;
  budgetLimit: number;
  usageLimit: number;
  perUserLimit: number;
  validFrom: string;
  validUntil: string;
}

interface Warning { code: string; message: string }

interface Scenario {
  productSubtotal: number;
  promotionApplied: boolean;
  freeDeliveryApplied: boolean;
  customerTotal: number;
  customerSaving: number;
  merchantFunded: number;
  platformFunded: number;
  merchantPayout: number;
  platformNet: number;
  estimatedGatewayFee: number;
  platformNetAfterGateway: number;
  warnings: Warning[];
}

interface Preview {
  valid: boolean;
  errors: string[];
  assumptions: string[];
  scenarios: Scenario[];
}

const cop = (n: number) => `$${(n || 0).toLocaleString('es-CO')}`;

const th = 'px-3 py-2 text-left text-xs font-bold text-white bg-[var(--color-primary-dark)] whitespace-nowrap';
const td = 'px-3 py-2 text-xs tabular-nums text-[var(--color-text-main)] whitespace-nowrap align-top border-b border-[var(--color-border)]';

export default function CouponSimulation({
  draft,
  businessId,
  businesses,
  onBusinessChange,
  selectClass,
  labelClass,
}: {
  draft: SimulationDraft;
  /** Comercio sobre el que se simula; la tarifa de domicilio depende de su zona. */
  businessId: string;
  businesses: Array<{ _id: string; name: string }>;
  onBusinessChange: (id: string) => void;
  selectClass: string;
  labelClass: string;
}) {
  const [result, setResult] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const ready = !!businessId && draft.value >= 0 && !!draft.validUntil;
  const key = JSON.stringify({ draft, businessId });

  useEffect(() => {
    if (!ready) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await api.post('/coupons/preview', {
          businessId,
          draft: {
            type: draft.type,
            scope: draft.type === 'free_delivery' ? 'delivery' : draft.scope,
            value: draft.value,
            ...(draft.maxDiscount > 0 ? { maxDiscount: draft.maxDiscount } : {}),
            ...(draft.maxDiscountAmount > 0 ? { maxDiscountAmount: draft.maxDiscountAmount } : {}),
            ...(draft.minOrderAmount > 0 ? { minOrderAmount: draft.minOrderAmount } : {}),
            fundedBy: draft.fundedBy,
            minimumContributionMargin: draft.minimumContributionMargin,
            firstOrderOnly: draft.firstOrderOnly,
            ...(draft.budgetLimit > 0 ? { budgetLimit: draft.budgetLimit } : {}),
            ...(draft.usageLimit > 0 ? { usageLimit: draft.usageLimit } : {}),
            perUserLimit: draft.perUserLimit,
            validFrom: new Date(draft.validFrom).toISOString(),
            validUntil: new Date(draft.validUntil).toISOString(),
          },
        });
        if (mine !== seq.current) return;
        setResult(data.data as Preview);
        setError('');
      } catch (err) {
        if (mine !== seq.current) return;
        setResult(null);
        setError(apiMessage(err, 'No se pudo simular.'));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 500);
    return () => clearTimeout(timer);
    // `key` resume el borrador y el comercio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const shown = ready ? result : null;

  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex items-end justify-between gap-3">
        <div className="flex-1">
          <label className={labelClass}>Simular sobre el comercio</label>
          <select
            value={businessId}
            onChange={(e) => onBusinessChange(e.target.value)}
            className={selectClass}
          >
            <option value="">Elige un comercio…</option>
            {businesses.map((b) => (
              <option key={b._id} value={b._id}>{b.name}</option>
            ))}
          </select>
        </div>
        {loading && <span className="text-xs font-semibold text-[var(--color-text-main)]">Calculando…</span>}
      </div>

      {!ready && (
        <p className="text-xs font-medium text-[var(--color-text-main)]">
          Elige un comercio y la fecha de fin para ver, con las reglas reales, cuánto paga el cliente,
          cuánto subsidia ZIPP y qué margen queda después de la pasarela.
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
          
          {error}
        </p>
      )}

      {shown && !shown.valid && (
        <ul className="space-y-1">
          {shown.errors.map((message) => (
            <li key={message} className="text-xs font-semibold text-[var(--color-danger)]">{message}</li>
          ))}
        </ul>
      )}

      {shown?.valid && (
        <>
          <div className="overflow-x-auto rounded border border-[var(--color-border)]">
            <table className="min-w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>Pedido</th>
                  <th className={th}>Cliente paga</th>
                  <th className={th}>Subsidia ZIPP</th>
                  <th className={th}>Financia comercio</th>
                  <th className={th}>Pago al comercio</th>
                  <th className={th}>Neto ZIPP</th>
                  <th className={th}>Pasarela (est.)</th>
                  <th className={th}>Neto tras pasarela</th>
                </tr>
              </thead>
              <tbody>
                {shown.scenarios.map((s) => (
                  <tr key={s.productSubtotal} className="border-b border-[var(--color-border)]">
                    <td className={td}>{cop(s.productSubtotal)}</td>
                    <td className={td}>{cop(s.customerTotal)}</td>
                    <td className={td}>{cop(s.platformFunded)}</td>
                    <td className={td}>{cop(s.merchantFunded)}</td>
                    <td className={td}>{cop(s.merchantPayout)}</td>
                    <td className={td}>{cop(s.platformNet)}</td>
                    <td className={td}>{cop(s.estimatedGatewayFee)}</td>
                    <td className={`${td} font-bold ${s.platformNetAfterGateway < 0 ? 'text-[var(--color-danger)]' : ''}`}>
                      {cop(s.platformNetAfterGateway)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {shown.scenarios.flatMap((s) =>
            s.warnings.map((w) => (
              <p key={`${s.productSubtotal}-${w.code}`} className="flex items-start gap-2 text-xs font-semibold text-[var(--color-warning)]">
                
                <span>{cop(s.productSubtotal)}: {w.message}</span>
              </p>
            ))
          )}

          <ul className="space-y-0.5">
            {shown.assumptions.map((a) => (
              <li key={a} className="text-xs font-medium text-[var(--color-text-main)]">{a}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
