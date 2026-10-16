import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, MessageCircle, Paperclip, X } from 'lucide-react';
import api from '../../services/api';
import { qk } from '../../lib/queryKeys';
import { apiMessage } from '../../lib/apiError';
import { dateTime, isActive, isInTransit, money, orderTag, statusStyle, type BusinessOrder } from '../../lib/orderFlow';
import { useFlowProfile } from '../../hooks/useFlowProfile';
import { supportWhatsAppUrl } from '../../lib/contact';
import {
  ATTACHMENT_TYPES, CATEGORY_LABEL, MAX_ATTACHMENTS, PAYMENT_METHOD_LABEL, REASONS, TYPE_LABEL,
  attachmentError, periodLabel, uploadEvidence,
  type CaseType, type Category, type PaymentMethod, type Reason, type Ticket,
} from '../../lib/support';
import { BackButton, fieldClass, labelClass, primaryBtn } from './ui';

const DEFAULT_HINT = 'Explica qué ocurrió. Si es sobre un pedido, incluye su número.';

/** Con lo que llega de "Reportar un problema" en un pedido o en una liquidación. */
export interface CasePreset {
  order?: { id: string; number: string };
  reason?: Reason;
  settlementId?: string;
}

interface SettlementOption { _id: string; periodStart: string; periodEnd: string }

export default function NewCase({ businessId, preset, onBack, onCreated }: {
  businessId?: string;
  preset: CasePreset | null;
  onBack: () => void;
  onCreated: (id: string, failedFiles: number) => void;
}) {
  const profile = useFlowProfile();
  const fromOrder = preset?.order ?? null;
  // '' = aún no elige; 'other' = ninguno de los motivos, elige el tipo a mano.
  const [reason, setReason] = useState<Reason | 'other' | ''>(preset?.reason ?? (fromOrder ? 'order_issue' : ''));
  const [type, setType] = useState<CaseType>('petition');
  // null = el asunto sigue al motivo y al pedido; al escribir en él deja de seguirlos.
  const [subjectDraft, setSubjectDraft] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  const [orderId, setOrderId] = useState(fromOrder?.id ?? '');
  const [settlementId, setSettlementId] = useState(preset?.settlementId ?? '');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // Los pedidos recientes del local: el caso nace atado a lo que pasó en la
  // calle y Soporte no tiene que preguntar de qué pedido hablas.
  const recent = useQuery({
    queryKey: ['business', businessId, 'support', 'recent-orders'],
    enabled: !!businessId,
    queryFn: async () =>
      (await api.get(`/orders/business/${businessId}`, { params: { page: 1, limit: 30 } })).data.data as BusinessOrder[],
  });

  const current = REASONS.find((r) => r.key === reason);
  const needsOrder = current?.needsOrder ?? false;
  const financial = current?.category === 'financial';

  // Misma consulta que Liquidaciones: si ya se abrió esa pantalla, no se vuelve a pedir.
  const statement = useQuery({
    queryKey: qk.statement(businessId),
    enabled: !!businessId && !!current?.settlement,
    queryFn: async () => (await api.get(`/businesses/${businessId}/statement`)).data.data as { settlements: SettlementOption[] },
  });

  // El pedido que viene del detalle puede no estar entre los 30 recientes.
  const preselectedMissing = !!fromOrder && !recent.data?.some((o) => o._id === fromOrder.id);
  const order = recent.data?.find((o) => o._id === orderId);
  const orderLabel = order
    ? orderTag(order)
    : fromOrder?.id === orderId && fromOrder.number ? `#${fromOrder.number}` : '';
  const suggestedSubject = current ? `${current.short}${orderLabel ? ` · ${orderLabel}` : ''}` : '';
  const subject = subjectDraft ?? suggestedSubject;
  // Un pedido terminado no corre prisa; uno que no conocemos, por si acaso, sí.
  const orderLive = !order || isActive(order.status) || isInTransit(order.status);

  const send = useMutation({
    mutationFn: async () => {
      const ticket = (await api.post('/pqrs', {
        // El motivo decide el tipo en el servidor; solo "Otro" manda el tipo.
        ...(reason && reason !== 'other' ? { reason } : { type }),
        subject: subject.trim(), detail: detail.trim(), businessId,
        ...(orderId ? { orderId } : {}),
        ...(current?.settlement && settlementId ? { settlementId } : {}),
        // Con pedido, el medio de pago lo pone el servidor desde el pedido.
        ...(financial && !orderId && paymentMethod ? { paymentMethod } : {}),
      })).data.data as Ticket;
      // El caso ya existe: un adjunto que falle no lo tumba, y reintentar el envío lo duplicaría.
      let failed = 0;
      for (const file of files) {
        try { await uploadEvidence(ticket._id, file); } catch { failed += 1; }
      }
      return { ticket, failed };
    },
    onSuccess: ({ ticket, failed }) => onCreated(ticket._id, failed),
    onError: (err) => setError(apiMessage(err, 'No se pudo enviar el caso.')),
  });

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

  const addFiles = (picked: FileList | null) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!picked) return;
    const next = [...files];
    for (const file of Array.from(picked)) {
      const problem = attachmentError(file);
      if (problem) return setError(`${file.name}: ${problem}`);
      if (next.length >= MAX_ATTACHMENTS) return setError(`Máximo ${MAX_ATTACHMENTS} archivos.`);
      next.push(file);
    }
    setError('');
    setFiles(next);
  };

  const groups = (Object.keys(CATEGORY_LABEL) as Category[]).map((key) => ({
    key,
    label: CATEGORY_LABEL[key],
    options: REASONS.filter((r) => r.category === key),
  }));

  return (
    <div className="space-y-5 max-w-xl">
      <BackButton onBack={onBack} />
      <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Nuevo caso</h2>

      <fieldset className="space-y-3">
        <legend className={`${labelClass} mb-1`}>¿Qué pasó?</legend>
        {groups.map((g) => (
          <div key={g.key}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">{g.label}</p>
            <div className="divide-y divide-[var(--color-border-light)]">
              {g.options.map((r) => (
                <label key={r.key} className="flex cursor-pointer items-center gap-3 py-2 text-sm text-[var(--color-text-main)]">
                  <input
                    type="radio"
                    name="reason"
                    value={r.key}
                    checked={reason === r.key}
                    onChange={() => { setReason(r.key); setError(''); }}
                    className="accent-[var(--color-primary)]"
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>
        ))}
        <label className="flex cursor-pointer items-center gap-3 border-t border-[var(--color-border-light)] pt-2 text-sm text-[var(--color-text-main)]">
          <input
            type="radio"
            name="reason"
            value="other"
            checked={reason === 'other'}
            onChange={() => { setReason('other'); setError(''); }}
            className="accent-[var(--color-primary)]"
          />
          Otra cosa
        </label>
      </fieldset>

      {reason && (
        <>
          {reason === 'other' && (
            <select value={type} onChange={(e) => setType(e.target.value as CaseType)} className={fieldClass} aria-label="Tipo de caso">
              {Object.entries(TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          )}

          <div className="space-y-1.5">
            <label htmlFor="support-order" className={labelClass}>
              {needsOrder ? 'Pedido' : 'Pedido relacionado (opcional)'}
            </label>
            <select id="support-order" value={orderId} onChange={(e) => setOrderId(e.target.value)} className={fieldClass}>
              <option value="">{needsOrder ? 'Elige el pedido' : 'Sin pedido relacionado'}</option>
              {preselectedMissing && fromOrder && (
                <option value={fromOrder.id}>Pedido {fromOrder.number ? `#${fromOrder.number}` : ''}</option>
              )}
              {recent.data?.map((o) => (
                <option key={o._id} value={o._id}>
                  {orderTag(o)} · {statusStyle(o.status, profile).label} · {money(o.total)} · {dateTime(o.createdAt)}
                </option>
              ))}
            </select>
            {orderId && order?.paymentMethod && (
              <p className="text-xs text-[var(--color-text-secondary)]">{PAYMENT_METHOD_LABEL[order.paymentMethod]}</p>
            )}
            {needsOrder && orderId && orderLive && current?.category === 'operational' && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                Si el pedido sigue en curso lo atendemos primero. ¿No puede esperar?{' '}
                <a
                  href={supportWhatsAppUrl(
                    `Hola, soy un comercio de Zipp. Tengo un problema con el pedido ${orderLabel}: ${current?.label ?? ''}.`,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-[var(--color-primary)] underline underline-offset-2"
                >
                  <MessageCircle className="w-3.5 h-3.5" /> Escríbenos por WhatsApp
                </a>
              </p>
            )}
          </div>

          {current?.settlement && (
            <div className="space-y-1.5">
              <label htmlFor="support-settlement" className={labelClass}>Liquidación (opcional)</label>
              <select id="support-settlement" value={settlementId} onChange={(e) => setSettlementId(e.target.value)} className={fieldClass}>
                <option value="">Sin liquidación específica</option>
                {preset?.settlementId && !statement.data?.settlements.some((s) => s._id === preset.settlementId) && (
                  <option value={preset.settlementId}>Liquidación elegida</option>
                )}
                {statement.data?.settlements.map((s) => (
                  <option key={s._id} value={s._id}>Liquidación del {periodLabel(s.periodStart, s.periodEnd)}</option>
                ))}
              </select>
            </div>
          )}

          {financial && !orderId && (
            <div className="space-y-1.5">
              <label htmlFor="support-payment" className={labelClass}>Medio de pago (opcional)</label>
              <select id="support-payment" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod | '')} className={fieldClass}>
                <option value="">No aplica o no sé</option>
                {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((key) => (
                  <option key={key} value={key}>{PAYMENT_METHOD_LABEL[key]}</option>
                ))}
              </select>
            </div>
          )}

          {financial && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Abrir este caso no genera ningún reembolso ni ajuste: el equipo lo revisa y, si corresponde, Finanzas lo atiende por su propio procedimiento.
            </p>
          )}

          <div className="space-y-1.5">
            <label htmlFor="support-subject" className={labelClass}>Asunto</label>
            <input
              id="support-subject"
              value={subject}
              onChange={(e) => setSubjectDraft(e.target.value)}
              maxLength={160}
              placeholder="En pocas palabras"
              className={fieldClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="support-detail" className={labelClass}>Cuéntanos qué ocurrió</label>
            <textarea
              id="support-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={6}
              maxLength={4000}
              placeholder={current?.hint ?? DEFAULT_HINT}
              className={fieldClass}
            />
          </div>

          <div className="space-y-1">
            {files.length > 0 && (
              <ul className="space-y-0.5 text-xs">
                {files.map((file, i) => (
                  <li key={`${file.name}-${i}`} className="flex items-center gap-1.5 text-[var(--color-text-main)]">
                    <Paperclip className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-secondary)]" />
                    <span className="truncate">{file.name}</span>
                    <button
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      aria-label={`Quitar ${file.name}`}
                      className="cursor-pointer text-[var(--color-text-secondary)]"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {files.length < MAX_ATTACHMENTS && (
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ATTACHMENT_TYPES.join(',')}
                  className="hidden"
                  onChange={(e) => addFiles(e.target.files)}
                />
                <button
                  onClick={() => fileInput.current?.click()}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)]"
                >
                  <Paperclip className="w-3.5 h-3.5" /> Adjuntar foto o PDF
                </button>
                <span className="ml-2 text-[11px] text-[var(--color-text-secondary)]">
                  Una captura del cobro o la foto del pedido ayudan a resolver más rápido. JPG, PNG, WEBP o PDF, hasta 5 MB.
                </span>
              </div>
            )}
          </div>
        </>
      )}

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
