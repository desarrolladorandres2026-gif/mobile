import { useCallback, useEffect, useState } from 'react';
import {
  Inbox, RotateCw, UserCheck, Send, CheckCircle2, AlertTriangle, Timer,
} from 'lucide-react';
import api from '../services/api';

/**
 * Bandeja de soporte.
 *
 * `Pqrs` ya guardaba tipo, estado, evidencias y respuestas: era una lista.
 * Lo que la convierte en una cola de trabajo son las tres cosas que aquí se
 * pintan y se pueden cambiar — quién lo tiene, cuándo vence y cuánto se
 * tardó en contestar.
 *
 * La cola llega ordenada por vencimiento y no por antigüedad, que es la
 * diferencia entre atender lo urgente y atender lo que llegó primero: en
 * comida a domicilio, un reclamo de ayer ya no tiene arreglo.
 */

interface Ticket {
  _id: string;
  type: 'petition' | 'complaint' | 'claim' | 'suggestion';
  subject: string;
  detail: string;
  status: 'received' | 'in_review' | 'answered' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueAt?: string | null;
  firstResponseAt?: string | null;
  assignedTo?: { _id: string; name?: string } | string | null;
  userId?: { name?: string; phone?: string } | string;
  responses?: Array<{ message: string; createdAt: string }>;
  createdAt: string;
}

interface Metrics {
  open: number;
  overdue: number;
  unassigned: number;
  averageFirstResponseMinutes: number;
}

const TYPE_LABEL: Record<Ticket['type'], string> = {
  petition: 'Petición',
  complaint: 'Queja',
  claim: 'Reclamo',
  suggestion: 'Sugerencia',
};

const PRIORITY: Record<Ticket['priority'], { label: string; chip: string }> = {
  urgent: { label: 'Urgente', chip: 'bg-[var(--color-danger)] text-white' },
  high: { label: 'Alta', chip: 'bg-[var(--color-warning)] text-white' },
  normal: { label: 'Normal', chip: 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)]' },
  low: { label: 'Baja', chip: 'bg-[var(--color-bg-alt)] text-[var(--color-text-muted)]' },
};

/** Cuánto queda o cuánto lleva vencido. El signo es el dato. */
function dueLabel(dueAt?: string | null): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const diff = new Date(dueAt).getTime() - Date.now();
  const minutes = Math.round(Math.abs(diff) / 60000);
  const human = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return diff < 0 ? { text: `vencido hace ${human}`, overdue: true } : { text: `vence en ${human}`, overdue: false };
}

const nameOf = (value: Ticket['userId'] | Ticket['assignedTo']): string | null => {
  if (!value || typeof value === 'string') return null;
  return value.name ?? null;
};

export default function Support() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [queue, totals] = await Promise.all([
        api.get(`/pqrs/support/queue${onlyOverdue ? '?overdue=true' : ''}`),
        api.get('/pqrs/support/metrics'),
      ]);
      setTickets(queue.data.data ?? []);
      setMetrics(totals.data.data ?? null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [onlyOverdue]);

  useEffect(() => {
    load();
  }, [load]);

  /** Envuelve una acción para que el error se vea en la pantalla, no en la consola. */
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'No se pudo completar la acción.');
    } finally {
      setBusy(false);
    }
  };

  const assignToMe = (id: string) => run(() => api.patch(`/pqrs/${id}/assign`, {}));

  const respond = (id: string) =>
    run(async () => {
      if (reply.trim().length < 2) throw { response: { data: { message: 'Escribe la respuesta.' } } };
      await api.patch(`/pqrs/${id}/respond`, { message: reply.trim() });
      setReply('');
    });

  const close = (id: string) =>
    run(async () => {
      await api.patch(`/pqrs/${id}/close`, reply.trim() ? { message: reply.trim() } : {});
      setReply('');
      setOpenId(null);
    });

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Soporte</h1>
          <p className="page-subtitle">
            Ordenado por vencimiento, no por antigüedad: primero lo que se va a romper
          </p>
        </div>
        <button
          onClick={load}
          className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)] shadow-xs transition-all hover:bg-[var(--color-bg)]"
        >
          <RotateCw className="h-4 w-4 text-[var(--color-primary)]" />
          <span>Actualizar</span>
        </button>
      </div>

      {metrics ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: 'Abiertos', value: metrics.open, tone: '' },
            { label: 'Vencidos', value: metrics.overdue, tone: 'text-[var(--color-danger)]' },
            { label: 'Sin asignar', value: metrics.unassigned, tone: 'text-[var(--color-warning)]' },
            {
              label: 'Primera respuesta (min)',
              value: Math.round(metrics.averageFirstResponseMinutes || 0),
              tone: '',
            },
          ].map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-4"
            >
              <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                {kpi.label}
              </p>
              <p className={`text-2xl font-bold ${kpi.tone || 'text-[var(--color-text-main)]'}`}>
                {kpi.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--color-text-secondary)]">
        <input
          type="checkbox"
          checked={onlyOverdue}
          onChange={(e) => setOnlyOverdue(e.target.checked)}
          className="cursor-pointer accent-[var(--color-primary)]"
        />
        Solo lo vencido
      </label>

      {error ? (
        <p className="flex items-center gap-1.5 text-sm text-[var(--color-danger)]">
          <AlertTriangle className="h-4 w-4" /> {error}
        </p>
      ) : null}

      {loading && tickets.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Cargando…</p>
      ) : tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] py-16">
          <Inbox className="h-8 w-8 text-[var(--color-success)]" />
          <p className="font-semibold text-[var(--color-text-main)]">La bandeja está vacía</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {tickets.map((ticket) => {
            const due = dueLabel(ticket.dueAt);
            const agent = nameOf(ticket.assignedTo);
            const isOpen = openId === ticket._id;

            return (
              <li
                key={ticket._id}
                className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-[var(--color-text-main)]">{ticket.subject}</p>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          PRIORITY[ticket.priority].chip
                        }`}
                      >
                        {PRIORITY[ticket.priority].label}
                      </span>
                      {due ? (
                        <span
                          className={`flex items-center gap-1 text-[11px] font-semibold ${
                            due.overdue
                              ? 'text-[var(--color-danger)]'
                              : 'text-[var(--color-text-muted)]'
                          }`}
                        >
                          <Timer className="h-3 w-3" /> {due.text}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      {TYPE_LABEL[ticket.type]} · {nameOf(ticket.userId) ?? 'Usuario'} ·{' '}
                      {agent ? `lo lleva ${agent}` : 'sin asignar'}
                    </p>
                  </div>

                  {!agent ? (
                    <button
                      onClick={() => assignToMe(ticket._id)}
                      disabled={busy}
                      className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
                    >
                      <UserCheck className="h-3.5 w-3.5" /> Asignármelo
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      setOpenId(isOpen ? null : ticket._id);
                      setReply('');
                      setError('');
                    }}
                    className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white"
                  >
                    {isOpen ? 'Cerrar detalle' : 'Abrir'}
                  </button>
                </div>

                {isOpen ? (
                  <div className="mt-3 space-y-3 border-t border-[var(--color-border-light)] pt-3">
                    <p className="whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">
                      {ticket.detail}
                    </p>

                    {ticket.responses?.length ? (
                      <ul className="space-y-1.5">
                        {ticket.responses.map((r, index) => (
                          <li
                            key={index}
                            className="rounded-lg bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]"
                          >
                            {r.message}
                            <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">
                              {new Date(r.createdAt).toLocaleString('es-CO')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={3}
                      placeholder="Lamentamos lo ocurrido. Ya le reembolsamos el pedido completo."
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]"
                    />

                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => respond(ticket._id)}
                        disabled={busy}
                        className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)] disabled:opacity-60"
                      >
                        <Send className="h-3.5 w-3.5" /> Responder
                      </button>
                      <button
                        onClick={() => close(ticket._id)}
                        disabled={busy}
                        className="flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--color-success)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Responder y cerrar
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
