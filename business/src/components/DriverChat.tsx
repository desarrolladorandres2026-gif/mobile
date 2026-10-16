import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Bike } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { clock } from '../lib/orderFlow';
import { useBusinessEvent, type ChatMessage } from '../hooks/realtimeContext';

/**
 * El hilo del comercio con el domiciliario de este pedido.
 *
 * Es solo para operar: «ya está listo», «espera dos minutos», «no encuentro tu
 * bolsa». No es la conversación del cliente con el repartidor, que el comercio
 * nunca ve (auditoría 2026-10-01, MEDIO 5): el servidor entrega aquí solo el
 * hilo `business_driver`, pida lo que pida este componente.
 *
 * Se abre cuando hay domiciliario asignado y el pedido está listo o en camino;
 * antes y después el servidor responde 409 y la ficha no lo pinta.
 */

const MAX = 500;

export default function DriverChat({ orderId, canWrite }: { orderId: string; canWrite: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const markRead = useCallback(() => {
    void api.post(`/orders/${orderId}/chat/read`, {}).catch(() => undefined);
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/orders/${orderId}/chat`)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.data.data as ChatMessage[]);
        markRead();
      })
      .catch((err) => {
        if (!cancelled) setError(apiMessage(err, 'No pudimos cargar la conversación.'));
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, markRead]);

  // Tanto lo que escribe el domiciliario como lo que escribe otra pantalla del
  // local llega por la sala del negocio; `merge` evita duplicar el propio.
  const merge = useCallback((incoming: ChatMessage) => {
    setMessages((current) =>
      current.some((message) => message.id === incoming.id) ? current : [...current, incoming]
    );
  }, []);

  useBusinessEvent('order:chat:message', (event) => {
    if (event.orderId !== orderId || event.message.channel !== 'business_driver') return;
    merge(event.message);
    if (event.message.senderRole === 'driver') markRead();
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const send = async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await api.post(`/orders/${orderId}/chat/messages`, { message });
      merge(res.data.data as ChatMessage);
      setDraft('');
    } catch (err) {
      setError(apiMessage(err, 'No se pudo enviar el mensaje.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-label="Conversación con el domiciliario" className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
        <Bike className="h-4 w-4" strokeWidth={1.8} />
        Domiciliario
      </h2>

      {messages.length === 0 ? (
        <p className="py-1 text-xs text-[var(--color-text-secondary)]">
          Escríbele si necesitas coordinar la recogida. El cliente no ve esta conversación.
        </p>
      ) : (
        <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
          {messages.map((message) => {
            const mine = message.senderRole === 'business';
            return (
              <li key={message.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <span
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-sm ${
                    mine
                      ? 'bg-[var(--color-primary)] text-[var(--zipp-obsidian)]'
                      : 'bg-[var(--color-surface-hover)] text-[var(--color-text-main)]'
                  }`}
                >
                  {message.message}
                </span>
                <span className="px-1 text-[10px] tabular text-[var(--color-text-secondary)]">
                  {mine ? 'Local' : 'Domiciliario'} · {clock(message.createdAt)}
                </span>
              </li>
            );
          })}
          <div ref={bottom} />
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      {canWrite ? (
        <div className="flex items-center rounded-full bg-[var(--color-surface-hover)] pl-4 pr-1">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void send();
            }}
            maxLength={MAX}
            placeholder="Mensaje para el domiciliario…"
            aria-label="Mensaje para el domiciliario"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-main)] outline-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
            aria-label="Enviar mensaje"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--zipp-obsidian)] disabled:cursor-default disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
