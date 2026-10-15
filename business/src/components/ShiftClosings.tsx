import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, X } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { money } from '../lib/orderFlow';
import { apiMessage } from '../lib/apiError';
import NumericInput from './NumericInput';

/**
 * Cierre de caja del turno.
 *
 * El empleado solo aporta el efectivo que contó y una nota; las ventas las
 * calcula el servidor y es lo que queda firmado con su nombre. Espejo de
 * backend/src/services/shiftClosing.service.ts.
 */
export interface ShiftClosing {
  id: string;
  date: string;
  closedByName: string;
  closedByRole: string;
  sales: number;
  ordersDelivered: number;
  ordersCancelled: number;
  /** Vendido contra entrega (valor de producto). No es lo que debe haber en caja. */
  cashSales: number;
  onlineSales: number;
  /**
   * Lo que debe haber en caja. `null` en cierres anteriores a esta cifra (su
   * diferencia se calculó contra `cashSales`) y, para quien no tiene permiso
   * financiero, mientras no haya declarado el efectivo contado.
   */
  expectedCash: number | null;
  inTransit: { count: number; amount: number } | null;
  cancelledAfterPickup: { count: number; amount: number } | null;
  declaredCash: number | null;
  difference: number | null;
  note: string;
  createdAt: string;
}

const hour = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });

/** Faltante en rojo, sobrante en ámbar, cuadrado en verde. */
function differenceTone(difference: number): string {
  if (difference === 0) return 'text-[var(--color-success)]';
  return difference < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]';
}

function differenceLabel(difference: number): string {
  if (difference === 0) return 'Caja cuadrada';
  return difference < 0 ? `Faltante de ${money(-difference)}` : `Sobrante de ${money(difference)}`;
}

export function CloseRegisterButton({ businessId, date }: { businessId: string; date: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState('');
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: async () =>
      (await api.post(`/businesses/${businessId}/shift-closings`, {
        declaredCash: cash === '' ? null : Number(cash),
        note: note.trim() || undefined,
      })).data.data as ShiftClosing,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.shiftClosings(businessId, date) }),
  });

  const closing = mutation.data;
  const dismiss = () => {
    setOpen(false);
    setCash('');
    setNote('');
    mutation.reset();
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
      >
        <Lock className="h-4 w-4" aria-hidden />
        Cerrar caja
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="close-register-title" className="zipp-modal w-full max-w-sm space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h3 id="close-register-title" className="text-sm font-semibold text-[var(--color-text-main)]">
                {closing ? 'Caja cerrada' : 'Cerrar caja'}
              </h3>
              <button
                onClick={dismiss}
                aria-label="Cerrar"
                className="rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-main)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {closing ? (
              <div className="space-y-3">
                <dl className="space-y-1.5 text-sm">
                  <Row label="Vendido hoy" value={money(closing.sales)} strong />
                  <Row label="Vendido en efectivo" value={money(closing.cashSales)} />
                  <Row label="Pago en línea" value={money(closing.onlineSales)} />
                  <Row label="Pedidos entregados" value={String(closing.ordersDelivered)} />
                  {closing.expectedCash !== null && <Row label="Efectivo esperado" value={money(closing.expectedCash)} strong />}
                  {closing.declaredCash !== null && <Row label="Efectivo contado" value={money(closing.declaredCash)} />}
                </dl>
                {closing.difference !== null && (
                  <p className={`text-sm font-semibold ${differenceTone(closing.difference)}`}>
                    {differenceLabel(closing.difference)}
                  </p>
                )}
                {closing.expectedCash !== null && closing.cancelledAfterPickup && closing.cancelledAfterPickup.count > 0 && (
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {closing.cancelledAfterPickup.count === 1
                      ? 'Un pedido se canceló después de que lo recogieron'
                      : `${closing.cancelledAfterPickup.count} pedidos se cancelaron después de que los recogieron`}
                    ; no suma al efectivo esperado.
                  </p>
                )}
                {closing.declaredCash === null && (
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    No contaste el efectivo, así que no hay diferencia que mostrar.
                  </p>
                )}
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Quedó registrado a nombre de {closing.closedByName} a las {hour(closing.createdAt)}.
                </p>
                <button
                  onClick={dismiss}
                  className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
                >
                  Listo
                </button>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!mutation.isPending) mutation.mutate();
                }}
                className="space-y-4"
              >
                <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                  Cuenta el efectivo que tienes y escríbelo. Al cerrar verás cuánto debía haber y si la caja cuadra.
                </p>
                <div>
                  <label htmlFor="close-cash" className="mb-1.5 block text-xs font-semibold text-[var(--color-text-main)]">
                    Efectivo contado (opcional)
                  </label>
                  <NumericInput
                    id="close-cash"
                    autoFocus
                    value={cash}
                    onValueChange={setCash}
                    maxDigits={10}
                    placeholder="150.000"
                    className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-semibold tabular text-[var(--color-text-main)] outline-none focus:border-[var(--color-text-main)]"
                  />
                </div>
                <div>
                  <label htmlFor="close-note" className="mb-1.5 block text-xs font-semibold text-[var(--color-text-main)]">
                    Nota (opcional)
                  </label>
                  <input
                    id="close-note"
                    type="text"
                    maxLength={300}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-text-main)]"
                  />
                </div>
                {mutation.isError && (
                  <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">
                    {apiMessage(mutation.error, 'No pudimos cerrar la caja.')}
                  </p>
                )}
                <button
                  type="submit"
                  aria-busy={mutation.isPending}
                  className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer aria-busy:cursor-wait aria-busy:opacity-60"
                >
                  {mutation.isPending ? 'Cerrando…' : 'Cerrar caja'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--color-text-secondary)]">{label}</dt>
      <dd className={`tabular ${strong ? 'font-bold' : ''} text-[var(--color-text-main)]`}>{value}</dd>
    </div>
  );
}

/** Los cierres del día, quién los hizo y cómo cuadró cada uno. */
export function ShiftClosingsList({ businessId, date }: { businessId: string; date: string }) {
  const { data = [] } = useQuery({
    queryKey: qk.shiftClosings(businessId, date),
    queryFn: async () =>
      (await api.get(`/businesses/${businessId}/shift-closings`, { params: { date } })).data.data as ShiftClosing[],
    // Un 403 aquí (rol sin `shift:view`) no es un error que mostrar: no hay nada que listar.
    retry: false,
  });
  if (data.length === 0) return null;

  return (
    <section>
      <h2 className="col-title">Cierres de caja</h2>
      <ul className="divide-y divide-[var(--color-border-light)]">
        {data.map((closing) => (
          <li key={closing.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
            <span className="text-[var(--color-text-main)]">
              {closing.closedByName} · {hour(closing.createdAt)}
              {closing.note ? <span className="text-[var(--color-text-secondary)]"> — {closing.note}</span> : null}
            </span>
            <span className="tabular text-xs font-semibold text-[var(--color-text-main)]">
              {money(closing.sales)}
              {closing.expectedCash !== null && (
                <span className="ml-3 font-normal text-[var(--color-text-secondary)]">Esperado {money(closing.expectedCash)}</span>
              )}
              {closing.difference !== null && (
                <span className={`ml-3 ${differenceTone(closing.difference)}`}>{differenceLabel(closing.difference)}</span>
              )}
              {closing.expectedCash === null && closing.difference !== null && (
                <span className="ml-2 font-normal text-[var(--color-text-secondary)]">(contra la cifra anterior)</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
