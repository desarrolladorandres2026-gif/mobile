import { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { money } from '../lib/orderFlow';

/**
 * Simulación de una promoción (o del envío gratis) con las reglas reales.
 *
 * No calcula nada: manda el borrador al servidor, que lo evalúa con el mismo
 * motor que cobra los pedidos (`POST /coupons/business/:id/preview`), y pinta
 * lo que contesta. Si mañana cambia una regla de precios, esta pantalla cambia
 * con ella porque no tiene una fórmula propia que se pueda quedar atrás.
 *
 * Nunca crea nada: ni promoción, ni pedido, ni consume cupos.
 */

export interface PreviewDraft {
  type: 'percentage' | 'fixed';
  value: number;
  maxDiscountAmount?: number;
  minOrderAmount?: number;
  autoApply?: boolean;
  firstOrderOnly?: boolean;
  budgetLimit?: number;
  usageLimit?: number;
  perUserLimit?: number;
  validFrom?: string;
  validUntil?: string;
}

interface Warning { code: string; message: string }

interface Scenario {
  productSubtotal: number;
  promotionApplied: boolean;
  freeDeliveryApplied: boolean;
  productDiscount: number;
  payableSubtotal: number;
  deliveryFee: number;
  deliveryPayable: number;
  customerTotal: number;
  customerSaving: number;
  merchantFunded: number;
  merchantCommission: number;
  merchantPayout: number;
  merchantPayoutWithoutPromotion: number;
  estimatedGatewayFee: number;
  warnings: Warning[];
}

interface Preview {
  valid: boolean;
  errors: string[];
  assumptions: string[];
  scenarios: Scenario[];
}

interface Props {
  businessId: string;
  /** La promoción en construcción; `null` para simular solo el envío gratis. */
  draft: PreviewDraft | null;
  /** Umbral de envío gratis a evaluar en lugar del guardado. */
  freeDeliveryThreshold?: number;
  /** Carritos de ejemplo; sin ellos el servidor elige unos alrededor del mínimo y de los umbrales. */
  subtotals?: number[];
  /** No consulta mientras el formulario no tiene lo mínimo para simularse. */
  ready?: boolean;
}

const th = 'py-1.5 pr-4 text-left text-[11px] font-semibold text-[var(--color-text-secondary)] whitespace-nowrap';
const td = 'py-2 pr-4 text-xs tabular text-[var(--color-text-main)] whitespace-nowrap';

export default function PromotionSimulation({ businessId, draft, freeDeliveryThreshold, subtotals, ready = true }: Props) {
  const [result, setResult] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // El borrador cambia con cada tecla: se espera a que se quede quieto y se
  // descarta la respuesta de una consulta que ya no es la última.
  const key = JSON.stringify({ draft, freeDeliveryThreshold, subtotals });
  useEffect(() => {
    if (!ready || (!draft && freeDeliveryThreshold === undefined)) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await api.post(`/coupons/business/${businessId}/preview`, {
          draft,
          ...(freeDeliveryThreshold !== undefined ? { freeDeliveryThreshold } : {}),
          ...(subtotals ? { subtotals } : {}),
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
    // `key` resume draft, umbral y carritos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, key, ready]);

  // Si el formulario deja de estar listo, lo último que se simuló ya no vale.
  const shown = ready && (draft || freeDeliveryThreshold !== undefined) ? result : null;

  if (!ready) {
    return (
      <p className="text-xs text-[var(--color-text-secondary)]">
        Completa los datos de la promoción para ver cuánto te costaría y cuánto recibirías.
      </p>
    );
  }

  return (
    <div className="space-y-3" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold text-[var(--color-text-secondary)]">
          Simulación con las reglas reales
        </h3>
        {loading && <span className="text-[11px] text-[var(--color-text-secondary)]">Calculando…</span>}
      </div>

      {error && (
        <p className="flex items-start gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4 shrink-0" />
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
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th className={th}>Pedido</th>
                  <th className={th}>Cliente paga</th>
                  <th className={th}>Tú financias</th>
                  <th className={th}>Tu pago</th>
                </tr>
              </thead>
              <tbody>
                {shown.scenarios.map((s) => (
                  <tr key={s.productSubtotal} className="border-b border-[var(--color-border)] align-top">
                    <td className={td}>
                      {money(s.productSubtotal)}
                      {s.freeDeliveryApplied && (
                        <span className="block text-[11px] text-[var(--color-text-secondary)]">con envío gratis</span>
                      )}
                    </td>
                    <td className={td}>
                      {money(s.customerTotal)}
                      {s.customerSaving > 0 && (
                        <span className="block text-[11px] text-[var(--color-success)]">ahorra {money(s.customerSaving)}</span>
                      )}
                    </td>
                    <td className={td}>{money(s.merchantFunded)}</td>
                    <td className={td}>
                      {money(s.merchantPayout)}
                      <span className="block text-[11px] text-[var(--color-text-secondary)]">
                        sin promoción {money(s.merchantPayoutWithoutPromotion)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {shown.scenarios.flatMap((s) =>
            s.warnings.map((w) => (
              <p key={`${s.productSubtotal}-${w.code}`} className="flex items-start gap-2 text-xs font-semibold text-[var(--color-warning)]">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>
                  {money(s.productSubtotal)}: {w.message}
                </span>
              </p>
            ))
          )}

          <ul className="space-y-0.5">
            {shown.assumptions.map((a) => (
              <li key={a} className="text-[11px] text-[var(--color-text-secondary)]">{a}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
