import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, LifeBuoy, MessageCircle, Paperclip, Send } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useBusinessEvent } from '../hooks/realtimeContext';
import { apiMessage } from '../lib/apiError';
import { dateTime, type BusinessOrder } from '../lib/orderFlow';
import { supportWhatsAppUrl } from '../lib/contact';
import { awaitingYou } from '../lib/supportState';
import { supportKey } from '../hooks/useSupportAttention';
import { usePermissions } from '../hooks/usePermissions';

/**
 * Soporte para el comercio.
 *
 * Un comercio con un problema —un cobro que no cuadra, una liquidación, un
 * domiciliario que no llegó— abre un caso que entra a la bandeja de Soporte
 * con su plazo. Es una conversación: ZIPP responde aquí y el comercio puede
 * replicar mientras el caso siga abierto, sin tener que abrir otro.
 */

type CaseType = 'petition' | 'complaint' | 'claim' | 'suggestion';
type Status = 'received' | 'in_review' | 'answered' | 'closed';

interface Message {
  message: string;
  from?: 'staff' | 'requester';
  createdAt: string;
}

type Reason = 'driver_no_show' | 'order_issue' | 'customer_unreachable' | 'payment' | 'account';
type RefundStatus = 'pending' | 'done' | 'rejected';

interface Ticket {
  _id: string;
  type: CaseType;
  subject: string;
  detail: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  responses?: Message[];
  /** Hasta cuándo se promete responder. Solo viene mientras el caso espera respuesta. */
  respondBy?: string | null;
  legalDueAt?: string | null;
  /** Del reembolso que pidió Soporte a Finanzas solo se conoce el estado. */
  refundStatus?: RefundStatus | null;
  /** El servidor ya aplicó la ventana de 7 días y el tope de reaperturas. */
  canReopen?: boolean;
  resolvedByRequester?: boolean;
  evidence?: Array<{ _id: string; name: string; uploadedAt: string }>;
  /** Solo en la vista del local: quién lo abrió y si es de quien mira. */
  openedBy?: string;
  mine?: boolean;
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Lo que el comercio elige al pedir ayuda. El servidor decide el tipo legal
 * (petición, queja, reclamo) y la prioridad a partir del motivo y del pedido:
 * quien abre el caso describe qué pasó, no cómo se clasifica.
 */
const REASONS: Array<{ key: Reason; label: string; needsOrder: boolean }> = [
  { key: 'driver_no_show', label: 'El domiciliario no llegó', needsOrder: true },
  { key: 'order_issue', label: 'Problema con el pedido: faltante, mal armado o dañado', needsOrder: true },
  { key: 'customer_unreachable', label: 'El cliente no responde', needsOrder: true },
  { key: 'payment', label: 'Un cobro o una liquidación', needsOrder: false },
  { key: 'account', label: 'Mi cuenta o mi local', needsOrder: false },
];

const REFUND_LABEL: Record<RefundStatus, string> = {
  pending: 'en revisión con Finanzas',
  done: 'atendido por Finanzas',
  rejected: 'no aprobado por Finanzas',
};

const TYPE_LABEL: Record<CaseType, string> = {
  petition: 'Petición',
  complaint: 'Queja',
  claim: 'Reclamo',
  suggestion: 'Sugerencia',
};

const STATUS_LABEL: Record<Status, string> = {
  received: 'Recibido',
  in_review: 'En revisión',
  answered: 'Respondido',
  closed: 'Cerrado',
};

/** Fuera del render: leer el reloj ahí hace que la misma pantalla cambie sola entre dos pintados. */
const isFuture = (iso: string) => new Date(iso).getTime() > Date.now();

const fieldClass =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-main)]';

const primaryBtn =
  'inline-flex items-center justify-center gap-2 cursor-pointer rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-light)] px-4 py-2 text-xs font-semibold text-[var(--zipp-obsidian)] disabled:opacity-50';

export default function Support() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const queryClient = useQueryClient();
  const queryKey = supportKey(businessId);
  const { access } = usePermissions(businessId);
  // Estricto, sin el "mientras carga, sí": el selector no debe parpadear para un empleado.
  const canSeeTeam = !!access?.permissions.includes('support:view_team');
  const [scope, setScope] = useState<'mine' | 'team'>('mine');

  // "Reportar un problema" en el detalle de un pedido llega aquí con el pedido
  // en la URL: el formulario abre ya atado a lo que pasó en la calle.
  const [params, setParams] = useSearchParams();
  const [fromOrder] = useState(() => {
    const id = params.get('order');
    return id ? { id, number: params.get('n') ?? '' } : null;
  });
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(fromOrder ? 'new' : null);

  // La URL ya cumplió su función; sin limpiarla, recargar reabriría el formulario.
  useEffect(() => {
    if (params.has('order')) setParams({}, { replace: true });
  }, [params, setParams]);

  const tickets = useQuery({
    queryKey,
    queryFn: async () => (await api.get('/pqrs/my')).data.data as Ticket[],
  });

  // Lo que abrió cualquiera del equipo. Solo se pide a quien tiene el permiso y mira esa pestaña.
  const team = useQuery({
    queryKey: [...queryKey, 'team'],
    enabled: !!businessId && canSeeTeam && scope === 'team',
    queryFn: async () => (await api.get(`/pqrs/business/${businessId}`)).data.data as Ticket[],
  });
  const source = scope === 'team' ? team : tickets;

  // ZIPP respondió: la lista y el hilo abierto se ponen al día sin recargar.
  useBusinessEvent('support:replied', () => {
    queryClient.invalidateQueries({ queryKey });
  });

  // Una sola lista, sin categorías: lo cerrado al final, lo demás por actividad.
  const list = [...(source.data ?? [])].sort((a, b) => {
    const closed = Number(a.status === 'closed') - Number(b.status === 'closed');
    return closed || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
  });
  const selected = selectedId && selectedId !== 'new' ? source.data?.find((t) => t._id === selectedId) : undefined;
  // En pantallas angostas se ve la lista o el hilo, no los dos.
  const showDetail = selectedId === 'new' || !!selected;

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Soporte</h1>
        <p className="page-subtitle">Cuéntanos qué pasa y te respondemos por aquí</p>
      </div>

      <div className="grid md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] md:gap-8">
        <section className={showDetail ? 'hidden md:block' : ''}>
          <button onClick={() => setSelectedId('new')} className={`${primaryBtn} w-full py-3 text-sm`}>
            <LifeBuoy className="w-5 h-5" /> Pedir ayuda
          </button>

          {canSeeTeam && (
            <div className="mt-3 flex gap-4" role="tablist" aria-label="De quién son los casos">
              {([['mine', 'Mis casos'], ['team', 'Del local']] as const).map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={scope === key}
                  onClick={() => { setScope(key); setSelectedId(null); }}
                  className={`cursor-pointer pb-1 text-xs font-semibold ${scope === key ? 'border-b-2 border-[var(--color-primary)] text-[var(--color-text-main)]' : 'text-[var(--color-text-secondary)]'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {source.isError ? (
            <p className="py-4 text-xs font-semibold text-[var(--color-danger)]">
              {apiMessage(source.error, 'No se pudieron cargar los casos.')}
            </p>
          ) : source.isPending ? (
            <p className="py-4 text-xs text-[var(--color-text-secondary)]">Cargando…</p>
          ) : list.length === 0 ? (
            <p className="py-4 text-xs text-[var(--color-text-secondary)]">
              {scope === 'team' ? 'Tu equipo no ha pedido ayuda.' : 'Aún no has pedido ayuda.'}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border-light)]">
              {list.map((t) => {
                const last = t.responses?.[t.responses.length - 1];
                // Solo en los propios: lo que respondieron a otro no espera nada de ti.
                const waitingOnYou = t.mine !== false && awaitingYou(t);
                return (
                  <li key={t._id}>
                    <button
                      onClick={() => setSelectedId(t._id)}
                      className={`w-full cursor-pointer py-3 text-left ${selectedId === t._id ? 'text-[var(--color-primary)]' : ''}`}
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
                        {waitingOnYou && <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] shrink-0" aria-label="Respuesta nueva" />}
                        <span className="truncate">{t.subject}</span>
                      </span>
                      <span className="block text-[11px] text-[var(--color-text-secondary)]">
                        {t.openedBy && !t.mine ? `${t.openedBy} · ` : ''}{TYPE_LABEL[t.type]} · {STATUS_LABEL[t.status]} · {dateTime(t.updatedAt || t.createdAt)}
                      </span>
                      <span className="block truncate text-xs text-[var(--color-text-secondary)]">
                        {last?.message ?? t.detail}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="md:border-l md:border-[var(--color-border-light)] md:pl-8">
          {selectedId === 'new' ? (
            <NewCase
              businessId={businessId}
              fromOrder={fromOrder}
              onBack={() => setSelectedId(null)}
              onCreated={(id) => {
                queryClient.invalidateQueries({ queryKey });
                setSelectedId(id);
              }}
            />
          ) : selected ? (
            <Thread ticket={selected} queryKey={queryKey} onBack={() => setSelectedId(null)} />
          ) : (
            <Faq onAsk={() => setSelectedId('new')} />
          )}
        </section>
      </div>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="md:hidden mb-3 inline-flex items-center gap-1 cursor-pointer text-xs font-semibold text-[var(--color-text-secondary)]">
      <ArrowLeft className="w-4 h-4" /> Casos
    </button>
  );
}

function NewCase({ businessId, fromOrder, onBack, onCreated }: {
  businessId?: string;
  fromOrder: { id: string; number: string } | null;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  // '' = aún no elige; 'other' = ninguno de los motivos, elige el tipo a mano.
  const [reason, setReason] = useState<Reason | 'other' | ''>(fromOrder ? 'order_issue' : '');
  const [type, setType] = useState<CaseType>('petition');
  const [subject, setSubject] = useState('');
  const [detail, setDetail] = useState('');
  const [orderId, setOrderId] = useState(fromOrder?.id ?? '');
  const [error, setError] = useState('');

  // Los pedidos recientes del local: el caso nace atado a lo que pasó en la
  // calle y Soporte no tiene que preguntar de qué pedido hablas.
  const recent = useQuery({
    queryKey: ['business', businessId, 'support', 'recent-orders'],
    enabled: !!businessId,
    queryFn: async () =>
      (await api.get(`/orders/business/${businessId}`, { params: { page: 1, limit: 30 } })).data.data as BusinessOrder[],
  });

  const send = useMutation({
    mutationFn: async () =>
      (await api.post('/pqrs', {
        // El motivo decide el tipo en el servidor; solo "Otro" manda el tipo.
        ...(reason && reason !== 'other' ? { reason } : { type }),
        subject: subject.trim(), detail: detail.trim(), businessId, ...(orderId ? { orderId } : {}),
      })).data.data as Ticket,
    onSuccess: (ticket) => onCreated(ticket._id),
    onError: (err) => setError(apiMessage(err, 'No se pudo enviar el caso.')),
  });

  const needsOrder = REASONS.find((r) => r.key === reason)?.needsOrder ?? false;

  // El botón no se apaga: dice qué falta. Un botón gris no explica nada.
  const submit = () => {
    if (!businessId) return setError('Elige primero el local.');
    if (!reason) return setError('Elige qué pasó.');
    if (needsOrder && !orderId) return setError('Elige el pedido del que hablas.');
    if (subject.trim().length < 3) return setError('Escribe un asunto.');
    if (detail.trim().length < 10) return setError('Cuéntanos con al menos 10 caracteres qué ocurrió.');
    setError('');
    send.mutate();
  };

  // El pedido que viene del detalle puede no estar entre los 30 recientes.
  const preselectedMissing = !!fromOrder && !recent.data?.some((o) => o._id === fromOrder.id);
  const orderNumber = recent.data?.find((o) => o._id === orderId)?.orderNumber
    ?? (fromOrder?.id === orderId ? fromOrder.number : '');

  return (
    <div className="space-y-4 max-w-xl">
      <BackButton onBack={onBack} />
      <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Nuevo caso</h2>
      <select
        value={reason}
        onChange={(e) => { setReason(e.target.value as Reason | 'other' | ''); setError(''); }}
        className={fieldClass}
        aria-label="Qué pasó"
      >
        <option value="" disabled>¿Qué pasó?</option>
        {REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        <option value="other">Otra cosa</option>
      </select>
      {reason === 'other' && (
        <select value={type} onChange={(e) => setType(e.target.value as CaseType)} className={fieldClass} aria-label="Tipo de caso">
          {Object.entries(TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      )}
      <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className={fieldClass} aria-label="Pedido relacionado">
        <option value="">{needsOrder ? 'Elige el pedido' : 'Sin pedido relacionado'}</option>
        {preselectedMissing && fromOrder && (
          <option value={fromOrder.id}>Pedido {fromOrder.number ? `#${fromOrder.number}` : ''}</option>
        )}
        {recent.data?.map((o) => (
          <option key={o._id} value={o._id}>
            Pedido #{o.orderNumber} · {dateTime(o.createdAt)}
          </option>
        ))}
      </select>
      {needsOrder && orderId && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          Si el pedido sigue en curso lo atendemos primero. ¿No puede esperar?{' '}
          <a
            href={supportWhatsAppUrl(
              `Hola, soy un comercio de Zipp. Tengo un problema con el pedido ${orderNumber ? `#${orderNumber}` : ''}: ${
                REASONS.find((r) => r.key === reason)?.label ?? ''
              }.`,
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-semibold text-[var(--color-primary)] underline underline-offset-2"
          >
            <MessageCircle className="w-3.5 h-3.5" /> Escríbenos por WhatsApp
          </a>
        </p>
      )}
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
      <div className="flex justify-end">
        <button onClick={submit} disabled={send.isPending} className={primaryBtn}>
          {send.isPending ? 'Enviando…' : 'Enviar caso'}
        </button>
      </div>
    </div>
  );
}

function Thread({ ticket, queryKey, onBack }: {
  ticket: Ticket;
  queryKey: unknown[];
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const closed = ticket.status === 'closed';
  // Los casos que abrió otra persona del equipo se leen, no se contestan: la réplica es de quien lo abrió.
  const readOnly = ticket.mine === false;
  const author = readOnly ? (ticket.openedBy ?? 'Equipo') : 'Tú';

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

  return (
    <div className="space-y-4 max-w-2xl">
      <BackButton onBack={onBack} />
      <header>
        <h2 className="text-base font-semibold text-[var(--color-text-main)]">{ticket.subject}</h2>
        <p className="text-[11px] text-[var(--color-text-secondary)]">
          {TYPE_LABEL[ticket.type]} · {STATUS_LABEL[ticket.status]} · {dateTime(ticket.createdAt)}
          {readOnly ? ` · lo abrió ${author}` : ''}
        </p>
        {!closed && ticket.status !== 'answered' && (
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            {ticket.respondBy && isFuture(ticket.respondBy)
              ? `Te respondemos antes de ${dateTime(ticket.respondBy)}.`
              : 'Seguimos revisando tu caso; te escribimos en cuanto haya novedad.'}
            {ticket.legalDueAt ? ` Plazo legal de respuesta: ${dateTime(ticket.legalDueAt)}.` : ''}
          </p>
        )}
        {ticket.refundStatus && (
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
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
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      // Sin Content-Type explícito axios mandaría el FormData como JSON (ver BusinessImageField).
      return api.post(`/pqrs/${ticket._id}/evidence`, form, { headers: { 'Content-Type': undefined } });
    },
    onSuccess: () => { setError(''); queryClient.invalidateQueries({ queryKey }); },
    onError: (err) => setError(apiMessage(err, 'No se pudo subir el archivo.')),
  });

  const pick = (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) {
      return setError('Sube una imagen JPG, PNG o WEBP, o un PDF.');
    }
    if (file.size > MAX_ATTACHMENT_BYTES) return setError('El archivo pesa más de 5 MB.');
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
            accept="image/jpeg,image/png,image/webp,application/pdf"
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

/**
 * Respuestas a lo que más se pregunta, antes de abrir un caso. Solo lo que el
 * panel y el servidor ya hacen hoy: una respuesta inventada cuesta más que
 * no tenerla.
 */
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: '¿Cómo se calcula lo que ZIPP me paga?',
    a: 'Venta, menos la comisión de ZIPP, menos los descuentos que asumes tú, menos las reversiones por reembolsos o contracargos: eso es tu neto. El propietario lo ve por semana en Liquidaciones, con los pedidos que lo componen.',
  },
  {
    q: '¿En qué liquidación se pagó un pedido?',
    a: 'Abre la ficha del pedido (el ojo en la lista de pedidos): quien ve las finanzas del local encuentra ahí el estado de su liquidación y su neto.',
  },
  {
    q: 'No me llegan pedidos',
    a: 'Revisa el interruptor Abierto / Cerrado del menú lateral: con el local cerrado ZIPP no te manda pedidos nuevos. Si un documento venció, tampoco recibes pedidos hasta subirlo de nuevo en Documentos.',
  },
  {
    q: 'El domiciliario falló el código de recogida',
    a: 'Tras varios intentos fallidos queda bloqueado un tiempo. No le entregues el pedido: en la ficha del pedido hay un enlace de WhatsApp a Soporte con el mensaje ya escrito.',
  },
  {
    q: '¿Quién puede cambiar la cuenta donde me pagan?',
    a: 'Solo el propietario del local.',
  },
];

function Faq({ onAsk }: { onAsk: () => void }) {
  return (
    <div className="max-w-xl space-y-3 py-1">
      <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Antes de escribirnos</h2>
      <ul className="divide-y divide-[var(--color-border-light)]">
        {FAQ.map(({ q, a }) => (
          <li key={q}>
            <details className="py-2.5">
              <summary className="cursor-pointer text-sm font-semibold text-[var(--color-text-main)]">
                {q}
              </summary>
              <p className="pt-1.5 text-sm text-[var(--color-text-secondary)]">{a}</p>
            </details>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--color-text-secondary)]">
        ¿Tu duda no está aquí?{' '}
        <button onClick={onAsk} className="cursor-pointer font-semibold text-[var(--color-primary)] underline underline-offset-2">
          Pedir ayuda
        </button>
      </p>
    </div>
  );
}
