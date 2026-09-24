import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, AlertTriangle, Check } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

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
 * cuánto de ZIPP— lo calcula el servidor y no se toca desde aquí.
 *
 * Tres caminos, porque la pasarela no los cubre todos: Wompi no acepta
 * devoluciones parciales por API, así que esas se hacen en su dashboard y
 * aquí solo se registran; y un contracargo lo inicia el banco, no ZIPP.
 */

interface Refund {
  _id: string;
  amount: number;
  reason: string;
  kind: string;
  status: string;
  transactionId?: string;
  createdAt: string;
}

type Mode = 'gateway' | 'external' | 'chargeback';

const money = (value: number) => `$${(value || 0).toLocaleString('es-CO')}`;

const KIND_LABEL: Record<string, string> = {
  full: 'Total',
  partial: 'Parcial',
  chargeback: 'Contracargo',
  external: 'Hecho por fuera',
};

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  {
    id: 'gateway',
    label: 'Reembolsar',
    hint: 'Pide la devolución a la pasarela. Wompi solo acepta devoluciones totales: para un parcial usa "Hecho por fuera".',
  },
  {
    id: 'external',
    label: 'Hecho por fuera',
    hint: 'Ya devolviste el dinero en el dashboard de Wompi o por transferencia. Aquí solo se registra y se reparte el coste.',
  },
  {
    id: 'chargeback',
    label: 'Contracargo',
    hint: 'El banco del cliente reversó el cobro. Registra la referencia que da la pasarela.',
  },
];

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
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('gateway');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError('');
      const { data } = await api.get(`/payments/orders/${orderId}/refunds`);
      setRefunds(data.data ?? []);
    } catch (err) {
      setLoadError(apiMessage(err, 'No se pudieron cargar los reembolsos de este pedido.'));
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

  const reset = () => {
    setOpen(false);
    setAmount('');
    setReason('');
    setReference('');
    setError('');
  };

  const submit = async () => {
    const value = Number(String(amount).replace(/[^\d]/g, ''));

    if (mode !== 'chargeback' && reason.trim().length < 3) {
      return setError('Escribe el motivo. Es lo que va a leer quien revise esto dentro de un mes.');
    }
    if (value > remaining) {
      return setError(`Como mucho quedan ${money(remaining)} por devolver de este pedido.`);
    }
    if (mode === 'external' && value <= 0) {
      return setError('Escribe el monto que devolviste por fuera.');
    }
    if (mode !== 'gateway' && reference.trim().length < (mode === 'chargeback' ? 4 : 3)) {
      return setError(mode === 'chargeback' ? 'Escribe la referencia del contracargo.' : 'Escribe la referencia de la devolución en Wompi o del banco.');
    }

    setError('');
    setSubmitting(true);
    try {
      if (mode === 'gateway') {
        await api.post(`/payments/orders/${orderId}/refund`, {
          // Sin monto, el servidor lo entiende como reembolso total.
          ...(value > 0 && value < remaining ? { amount: value } : {}),
          reason: reason.trim(),
          // Reintentar tras un timeout no puede devolver el dinero dos veces.
          idempotencyKey: `admin:${orderId}:${value || 'full'}:${reason.trim().slice(0, 40)}`,
        });
      } else if (mode === 'external') {
        await api.post(`/payments/orders/${orderId}/refund/external`, {
          amount: value,
          reason: reason.trim(),
          externalReference: reference.trim(),
        });
      } else {
        await api.post(`/payments/orders/${orderId}/chargeback`, {
          ...(value > 0 && value < remaining ? { amount: value } : {}),
          reference: reference.trim(),
        });
      }
      reset();
      await load();
      onDone?.();
    } catch (err) {
      // El 422 del reparto parcial explica que un parcial grande se comería el
      // pago garantizado del domiciliario: se enseña tal cual viene.
      setError(apiMessage(err, 'No se pudo registrar.'));
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-main)]';

  return (
    <div className="space-y-3 py-4">
      <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
        <RotateCcw className="w-3 h-3 text-[var(--color-warning)]" /> Reembolsos
      </span>

      {loading ? (
        <p className="text-[var(--color-text-muted)]">Cargando…</p>
      ) : loadError ? (
        <p className="flex items-start gap-1.5 text-[var(--color-danger)]">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {loadError}
        </p>
      ) : refunds.length === 0 ? (
        <p className="text-[var(--color-text-secondary)]">Este pedido no tiene reembolsos.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border-light)]">
          {refunds.map((r) => (
            <li key={r._id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-bold text-[var(--color-text-main)]">{money(r.amount)}</p>
                <p className="text-[var(--color-text-secondary)] break-words">{r.reason}</p>
                <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                  {KIND_LABEL[r.kind] ?? r.kind} · {new Date(r.createdAt).toLocaleDateString('es-CO')}
                  {r.status !== 'completed' ? ` · ${r.status}` : ''}
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
          <div className="space-y-2 border-t border-[var(--color-border-light)] pt-3">
            <div className="flex flex-wrap gap-1.5">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setMode(m.id); setError(''); }}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                    mode === m.id
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-secondary)]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[var(--color-text-secondary)]">{MODES.find((m) => m.id === mode)?.hint}</p>

            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                {mode === 'external' ? 'Monto devuelto' : `Monto — vacío es el total que queda (${money(remaining)})`}
              </span>
              <input
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError(''); }}
                inputMode="numeric"
                placeholder={String(remaining)}
                className={inputClass}
              />
            </label>

            {mode !== 'chargeback' && (
              <label className="block space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Motivo</span>
                <input
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); setError(''); }}
                  maxLength={300}
                  placeholder="Faltaba un producto y el cliente lo reportó con foto"
                  className={inputClass}
                />
              </label>
            )}

            {mode !== 'gateway' && (
              <label className="block space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {mode === 'chargeback' ? 'Referencia del contracargo' : 'Referencia en Wompi o del banco'}
                </span>
                <input
                  value={reference}
                  onChange={(e) => { setReference(e.target.value); setError(''); }}
                  maxLength={120}
                  className={inputClass}
                />
              </label>
            )}

            {error ? (
              <p className="flex items-start gap-1.5 text-[var(--color-danger)]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={reset}
                className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
              >
                Cancelar
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                className="cursor-pointer rounded-lg bg-[var(--color-warning)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
              >
                {submitting ? 'Procesando…' : mode === 'gateway' ? 'Reembolsar' : 'Registrar'}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
          >
            <RotateCcw className="w-3.5 h-3.5 text-[var(--color-warning)]" />
            Reembolso o contracargo {alreadyRefunded > 0 ? `(quedan ${money(remaining)})` : ''}
          </button>
        )
      ) : (
        <p className="text-[var(--color-text-muted)]">Ya se devolvió todo lo que se había cobrado.</p>
      )}
    </div>
  );
}
