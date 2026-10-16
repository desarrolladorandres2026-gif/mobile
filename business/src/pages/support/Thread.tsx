import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Paperclip, Send } from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import { dateTime, statusStyle } from '../../lib/orderFlow';
import { useFlowProfile } from '../../hooks/useFlowProfile';
import { awaitingYou } from '../../lib/supportState';
import {
  ATTACHMENT_TYPES, CATEGORY_LABEL, DISPLAY_STATUS, MAX_ATTACHMENTS, PAYMENT_METHOD_LABEL, REFUND_LABEL,
  attachmentError, historyLabel, periodLabel, reasonLabel, uploadEvidence, type Ticket,
} from '../../lib/support';
import { BackButton, fieldClass, primaryBtn } from './ui';

/** Fuera del render: leer el reloj ahí hace que la misma pantalla cambie sola entre dos pintados. */
const isFuture = (iso: string) => new Date(iso).getTime() > Date.now();

export default function Thread({ ticket, queryKey, onBack }: {
  ticket: Ticket;
  queryKey: unknown[];
  onBack: () => void;
}) {
  const profile = useFlowProfile();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const closed = ticket.status === 'closed';
  // Los casos que abrió otra persona del equipo se leen, no se contestan: la réplica es de quien lo abrió.
  const readOnly = ticket.mine === false;
  const author = readOnly ? (ticket.openedBy ?? 'Equipo') : 'Tú';
  const status = DISPLAY_STATUS[ticket.displayStatus];

  const reply = useMutation({
    mutationFn: () => api.post(`/pqrs/${ticket._id}/reply`, { message: text.trim() }),
    onSuccess: () => {
      setText('');
      setError('');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setError(apiMessage(err, 'No se pudo enviar la respuesta.')),
  });

  const resolve = useMutation({
    mutationFn: () => api.post(`/pqrs/${ticket._id}/resolve`),
    onSuccess: () => { setError(''); queryClient.invalidateQueries({ queryKey }); },
    onError: (err) => setError(apiMessage(err, 'No se pudo cerrar el caso.')),
  });

  const reopen = useMutation({
    mutationFn: () => api.post(`/pqrs/${ticket._id}/reopen`, { message: text.trim() }),
    onSuccess: () => { setText(''); setError(''); queryClient.invalidateQueries({ queryKey }); },
    onError: (err) => setError(apiMessage(err, 'No se pudo reabrir el caso.')),
  });

  const ready = text.trim().length >= 2;
  const method = ticket.order?.paymentMethod ?? ticket.paymentMethod;

  return (
    <div className="space-y-4 max-w-2xl">
      <BackButton onBack={onBack} />
      <header className="space-y-1">
        <p className="text-[11px] font-semibold tracking-wider text-[var(--color-text-secondary)]">{ticket.code}</p>
        <h2 className="text-base font-semibold text-[var(--color-text-main)]">{ticket.subject}</h2>
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-text-secondary)]">
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--color-text-main)]">
            <span className={`h-2 w-2 rounded-full ${status.dot}`} aria-hidden /> {status.label}
          </span>
          <span>·</span>
          <span>{ticket.category ? `${CATEGORY_LABEL[ticket.category]}: ` : ''}{reasonLabel(ticket)}</span>
          <span>·</span>
          <span>{dateTime(ticket.createdAt)}</span>
          {readOnly && <span>· lo abrió {author}</span>}
        </p>
        {(ticket.order || ticket.settlement || method) && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {[
              ticket.order ? `Pedido #${ticket.order.orderNumber} · ${statusStyle(ticket.order.status, profile).label}` : null,
              ticket.settlement ? `Liquidación del ${periodLabel(ticket.settlement.periodStart, ticket.settlement.periodEnd)}` : null,
              method ? PAYMENT_METHOD_LABEL[method] : null,
            ].filter(Boolean).join(' · ')}
          </p>
        )}
        {!closed && ticket.status !== 'answered' && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {ticket.respondBy && isFuture(ticket.respondBy)
              ? `Te respondemos antes de ${dateTime(ticket.respondBy)}.`
              : 'Seguimos revisando tu caso; te escribimos en cuanto haya novedad.'}
            {ticket.legalDueAt ? ` Plazo legal de respuesta: ${dateTime(ticket.legalDueAt)}.` : ''}
          </p>
        )}
        {ticket.refundStatus && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            Reembolso: {REFUND_LABEL[ticket.refundStatus]}.
          </p>
        )}
      </header>

      <ol className="space-y-3">
        <li>
          <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{author}</p>
          <p className="whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{ticket.detail}</p>
        </li>
        {ticket.responses?.map((r, i) => {
          const mine = r.from === 'requester';
          return (
            <li key={i} className={mine ? '' : 'border-l-2 border-[var(--color-primary)] pl-3'}>
              <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                {mine ? author : 'ZIPP'} · {dateTime(r.createdAt)}
              </p>
              <p className="whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{r.message}</p>
            </li>
          );
        })}
      </ol>

      <Attachments ticket={ticket} queryKey={queryKey} canAdd={!readOnly && !closed} canOpen={!readOnly} />

      {error && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
          <AlertCircle className="w-4 h-4" /> {error}
        </p>
      )}

      {readOnly ? (
        <p className="text-xs text-[var(--color-text-secondary)]">
          Solo {author} puede responder este caso.
        </p>
      ) : closed ? (
        <div className="space-y-2">
          <p className="text-xs text-[var(--color-text-secondary)]">
            {ticket.resolvedByRequester ? 'Confirmaste que quedó resuelto. ' : 'Este caso está cerrado. '}
            {ticket.canReopen
              ? 'Si el problema sigue, reábrelo y cuéntanos qué falta.'
              : 'Si el problema sigue, abre uno nuevo y cita este asunto.'}
          </p>
          {ticket.canReopen && (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="Qué sigue mal"
                aria-label="Por qué reabres el caso"
                className={fieldClass}
              />
              <div className="flex justify-end">
                <button
                  onClick={() => (text.trim().length < 5 ? setError('Cuéntanos con al menos 5 caracteres qué sigue mal.') : reopen.mutate())}
                  disabled={reopen.isPending}
                  className={primaryBtn}
                >
                  {reopen.isPending ? 'Reabriendo…' : 'Reabrir caso'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {awaitingYou(ticket) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--color-border-light)] pt-3">
              <span className="text-sm font-semibold text-[var(--color-text-main)]">¿Quedó resuelto?</span>
              <button onClick={() => resolve.mutate()} disabled={resolve.isPending} className={primaryBtn}>
                {resolve.isPending ? 'Cerrando…' : 'Sí, cerrar el caso'}
              </button>
              <button
                onClick={() => replyBox.current?.focus()}
                className="cursor-pointer text-xs font-semibold text-[var(--color-primary)] underline underline-offset-2"
              >
                Aún falta algo
              </button>
            </div>
          )}
          <textarea
            ref={replyBox}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Escribe tu respuesta"
            aria-label="Tu respuesta"
            className={fieldClass}
          />
          <div className="flex justify-end">
            <button onClick={() => reply.mutate()} disabled={!ready || reply.isPending} className={primaryBtn}>
              <Send className="w-4 h-4" /> {reply.isPending ? 'Enviando…' : 'Responder'}
            </button>
          </div>
        </div>
      )}

      {ticket.statusHistory && ticket.statusHistory.length > 0 && (
        <details className="border-t border-[var(--color-border-light)] pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-[var(--color-text-secondary)]">Historial de estados</summary>
          <ol className="space-y-1 pt-2 text-xs text-[var(--color-text-secondary)]">
            {ticket.statusHistory.map((entry, i) => (
              <li key={i}>
                <span className="font-semibold text-[var(--color-text-main)]">{historyLabel(entry)}</span>
                {' · '}{dateTime(entry.at)}
                {' · '}{entry.actor === 'requester' ? author : entry.actor === 'staff' ? 'ZIPP' : 'Sistema'}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * Adjuntos del caso. Los bytes se comprueban en el servidor; aquí solo se
 * avisa de formato y tamaño antes de subir. Abrir uno pide al servidor una
 * URL firmada: nada de lo que se guarda es un enlace.
 */
function Attachments({ ticket, queryKey, canAdd, canOpen }: {
  ticket: Ticket;
  queryKey: unknown[];
  canAdd: boolean;
  canOpen: boolean;
}) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const items = ticket.evidence ?? [];

  const upload = useMutation({
    mutationFn: (file: File) => uploadEvidence(ticket._id, file),
    onSuccess: () => { setError(''); queryClient.invalidateQueries({ queryKey }); },
    onError: (err) => setError(apiMessage(err, 'No se pudo subir el archivo.')),
  });

  const pick = (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    const problem = attachmentError(file);
    if (problem) return setError(problem);
    setError('');
    upload.mutate(file);
  };

  const view = async (id: string) => {
    // La pestaña se abre antes de la espera: después de un `await`, el navegador la tomaría por una ventana emergente.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const { data } = await api.get(`/pqrs/${ticket._id}/evidence/${id}/url`);
      if (tab) tab.location.href = data.data.url;
    } catch (err) {
      tab?.close();
      setError(apiMessage(err, 'No se pudo abrir el archivo.'));
    }
  };

  if (!canAdd && items.length === 0) return null;

  return (
    <div className="space-y-1">
      {items.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {items.map((item) => (
            <li key={item._id} className="flex items-center gap-1.5 text-[var(--color-text-main)]">
              <Paperclip className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-secondary)]" />
              {canOpen ? (
                <button onClick={() => view(item._id)} className="cursor-pointer truncate underline underline-offset-2">{item.name}</button>
              ) : (
                <span className="truncate">{item.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdd && items.length < MAX_ATTACHMENTS && (
        <div>
          <input
            ref={input}
            type="file"
            accept={ATTACHMENT_TYPES.join(',')}
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <button
            onClick={() => input.current?.click()}
            disabled={upload.isPending}
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] disabled:opacity-50"
          >
            <Paperclip className="w-3.5 h-3.5" /> {upload.isPending ? 'Subiendo…' : 'Adjuntar foto o PDF'}
          </button>
          <span className="ml-2 text-[11px] text-[var(--color-text-secondary)]">
            Una captura del cobro o la foto del pedido ayudan a resolver más rápido. JPG, PNG, WEBP o PDF, hasta 5 MB.
          </span>
        </div>
      )}
      {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
