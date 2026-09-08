import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, AlertTriangle, Check } from 'lucide-react';
import api from '../services/api';

/**
 * Reembolsos de un pedido.
 *
 * Vive dentro del cajón del pedido y no en una página propia a conciencia:
 * un reembolso se decide mirando quién pidió, qué pagó y qué salió mal. Una
 * pantalla aparte obligaría a copiar un identificador de una vista a otra, y
 * ese copiar y pegar es exactamente donde se acaba reembolsando el pedido
 * equivocado.
 *
 * El reparto del coste —cuánto sale del comercio, cuánto de la comisión,
 * cuánto de ZIPP— lo calcula el servidor y no se toca desde aquí. Lo único
 * que decide el operador es cuánto y por qué.
 */

interface Refund {
  _id: string;
  amount: number;
  reason: string;
  kind: string;
  status: string;
  createdAt: string;
}

const money = (value: number) => `$${(value || 0).toLocaleString('es-CO')}`;

const KIND_LABEL: Record<string, string> = {
  full: 'Total',
  partial: 'Parcial',
  chargeback: 'Contracargo',
};

export default function RefundPanel({
  orderId,
  orderTotal,
  onDone,
}: {
  orderId: string;
  orderTotal: number;
  onDone?: () => void;
}) {
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get(`/payments/orders/${orderId}/refunds`);
      setRefunds(data.data ?? []);
    } catch {
      // Un pedido sin reembolsos y un fallo de red se ven igual en una
      // lista vacía, así que el error se enseña solo al intentar cobrar.
      setRefunds([]);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  const alreadyRefunded = refunds
    .filter((r) => r.status !== 'failed')
    .reduce((sum, r) => sum + r.amount, 0);
  const remaining = Math.max(0, orderTotal - alreadyRefunded);

  const submit = async () => {
    const value = Number(String(amount).replace(/[^\d]/g, ''));

    if (reason.trim().length < 3) {
      return setError('Escribe el motivo. Es lo que va a leer quien revise esto dentro de un mes.');
    }
    if (value > remaining) {
      return setError(`Como mucho quedan ${money(remaining)} por devolver de este pedido.`);
    }

    setError('');
    setSubmitting(true);
    try {
      await api.post(`/payments/orders/${orderId}/refund`, {
        // Sin monto, el servidor lo entiende como reembolso total. Es la
        // diferencia entre "devuélvele todo" y "devuélvele exactamente
        // esto", y conviene que se note en la petición.
        ...(value > 0 && value < remaining ? { amount: value } : {}),
        reason: reason.trim(),
        // Reintentar tras un timeout no puede devolver el dinero dos veces.
        idempotencyKey: `admin:${orderId}:${value || 'full'}:${reason.trim().slice(0, 40)}`,
      });
      setOpen(false);
      setAmount('');
      setReason('');
      await load();
      onDone?.();
    } catch (err: any) {
      // El 422 del reparto parcial es el mensaje más útil de esta pantalla:
      // explica que un parcial grande se comería el pago garantizado del
      // domiciliario y que hay que hacerlo total. Se enseña tal cual viene.
      setError(err?.response?.data?.message ?? 'No se pudo procesar el reembolso.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 py-4">
      <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
        <RotateCcw className="w-3 h-3 text-[var(--color-warning)]" /> Reembolsos
      </span>

      {loading ? (
        <p className="text-[var(--color-text-muted)]">Cargando…</p>
      ) : refunds.length === 0 ? (
        <p className="text-[var(--color-text-secondary)]">Este pedido no tiene reembolsos.</p>
      ) : (
        <ul className="space-y-2">
          {refunds.map((r) => (
            <li
              key={r._id}
              className="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg)] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-bold text-[var(--color-text-main)]">{money(r.amount)}</p>
                <p className="text-[var(--color-text-secondary)] break-words">{r.reason}</p>
                <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                  {KIND_LABEL[r.kind] ?? r.kind} ·{' '}
                  {new Date(r.createdAt).toLocaleDateString('es-CO')}
                </p>
              </div>
              {r.status === 'completed' ? (
                <Check className="w-4 h-4 shrink-0 text-[var(--color-success)]" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-warning)]" />
              )}
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 ? (
        open ? (
          <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Monto — vacío devuelve los {money(remaining)} que quedan
              </span>
              <input
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError('');
                }}
                inputMode="numeric"
                placeholder={String(remaining)}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-main)]"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Motivo
              </span>
              <input
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError('');
                }}
                maxLength={300}
                placeholder="Faltaba un producto y el cliente lo reportó con foto"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-main)]"
              />
            </label>

            {error ? (
              <p className="flex items-start gap-1.5 text-[var(--color-danger)]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  setOpen(false);
                  setError('');
                }}
                className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
              >
                Cancelar
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                className="cursor-pointer rounded-lg bg-[var(--color-warning)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
              >
                {submitting ? 'Procesando…' : 'Reembolsar'}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
          >
            <RotateCcw className="w-3.5 h-3.5 text-[var(--color-warning)]" />
            Reembolsar {alreadyRefunded > 0 ? `(quedan ${money(remaining)})` : ''}
          </button>
        )
      ) : (
        <p className="text-[var(--color-text-muted)]">
          Ya se devolvió todo lo que se había cobrado.
        </p>
      )}
    </div>
  );
}
