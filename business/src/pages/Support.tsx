import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { dateTime } from '../lib/orderFlow';

/**
 * Soporte para el comercio.
 *
 * Hasta ahora solo el cliente podía abrir un caso, así que un comercio con un
 * problema —un cobro que no cuadra, una liquidación, un domiciliario que no
 * llegó— no tenía por dónde decirlo dentro de ZIPP. El caso entra a la misma
 * bandeja de Soporte, con su plazo, y la respuesta vuelve aquí.
 */

type CaseType = 'petition' | 'complaint' | 'claim' | 'suggestion';

interface Ticket {
  _id: string;
  type: CaseType;
  subject: string;
  detail: string;
  status: 'received' | 'in_review' | 'answered' | 'closed';
  createdAt: string;
  responses?: Array<{ message: string; createdAt: string }>;
}

const TYPE_LABEL: Record<CaseType, string> = {
  petition: 'Petición',
  complaint: 'Queja',
  claim: 'Reclamo',
  suggestion: 'Sugerencia',
};

const STATUS_LABEL: Record<Ticket['status'], string> = {
  received: 'Recibido',
  in_review: 'En revisión',
  answered: 'Respondido',
  closed: 'Cerrado',
};

export default function Support() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const queryClient = useQueryClient();
  const [type, setType] = useState<CaseType>('petition');
  const [subject, setSubject] = useState('');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');

  const tickets = useQuery({
    queryKey: ['business', businessId, 'support'],
    queryFn: async () => (await api.get('/pqrs/my')).data.data as Ticket[],
  });

  const send = useMutation({
    mutationFn: () => api.post('/pqrs', { type, subject: subject.trim(), detail: detail.trim(), businessId }),
    onSuccess: () => {
      setSubject('');
      setDetail('');
      setError('');
      queryClient.invalidateQueries({ queryKey: ['business', businessId, 'support'] });
    },
    onError: (err) => setError(apiMessage(err, 'No se pudo enviar el caso.')),
  });

  const ready = !!businessId && subject.trim().length >= 3 && detail.trim().length >= 10;
  const fieldClass =
    'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Soporte</h1>
        <p className="page-subtitle">Cuéntanos qué pasa y te respondemos por aquí</p>
      </div>

      <div className="cols3">
      <section className="space-y-4">
        <h2 className="col-title">Nuevo caso</h2>
        <select value={type} onChange={(e) => setType(e.target.value as CaseType)} className={fieldClass}>
          {Object.entries(TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={160}
          placeholder="Asunto"
          className={fieldClass}
        />
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          rows={6}
          maxLength={4000}
          placeholder="Explica qué ocurrió. Si es sobre un pedido, incluye su número."
          className={fieldClass}
        />
        {error && (
          <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
            <AlertCircle className="w-4 h-4" /> {error}
          </p>
        )}
        <div className="flex flex-col items-end gap-2">
          {!ready && (
            <span className="text-xs text-[var(--color-text-muted)]">
              Escribe un asunto y al menos 10 caracteres de detalle.
            </span>
          )}
          <button
            onClick={() => send.mutate()}
            disabled={!ready || send.isPending}
            className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            {send.isPending ? 'Enviando…' : 'Enviar caso'}
          </button>
        </div>
      </section>

      {([
        ['Abiertos', (st: Ticket['status']) => st === 'received' || st === 'in_review'],
        ['Respondidos y cerrados', (st: Ticket['status']) => st === 'answered' || st === 'closed'],
      ] as const).map(([title, match]) => {
        const list = tickets.data?.filter((t) => match(t.status)) ?? [];
        return (
          <section key={title}>
            <h2 className="col-title">{title}{tickets.data ? ` · ${list.length}` : ''}</h2>
            {tickets.isError ? (
              <p className="text-xs font-semibold text-[var(--color-danger)]">
                {apiMessage(tickets.error, 'No se pudieron cargar tus casos.')}
              </p>
            ) : tickets.isPending ? (
              <p className="text-xs text-[var(--color-text-muted)]">Cargando…</p>
            ) : list.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">Sin casos aquí.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border-light)]">
                {list.map((t) => (
              <li key={t._id} className="py-4">
              <p className="font-bold text-[var(--color-text-main)]">{t.subject}</p>
              <p className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                {TYPE_LABEL[t.type]} · {STATUS_LABEL[t.status]} · {dateTime(t.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">{t.detail}</p>
              {t.responses?.map((r, i) => (
                <p key={i} className="mt-2 border-l-2 border-[var(--color-primary)] pl-3 text-sm text-[var(--color-text-main)]">
                  {r.message}
                  <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{dateTime(r.createdAt)}</span>
                </p>
              ))}
            </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      </div>
    </div>
  );
}
