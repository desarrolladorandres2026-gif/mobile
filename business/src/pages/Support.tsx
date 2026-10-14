import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useBusinessEvent } from '../hooks/realtimeContext';
import { apiMessage } from '../lib/apiError';
import { dateTime } from '../lib/orderFlow';
import { awaitingYou } from '../lib/supportState';
import { supportKey } from '../hooks/useSupportAttention';
import { usePermissions } from '../hooks/usePermissions';
import { DISPLAY_STATUS, REASONS, reasonLabel, type DisplayStatus, type Reason, type Ticket } from '../lib/support';
import HelpCenter from '../components/HelpCenter';
import NewCase, { type CasePreset } from './support/NewCase';
import Thread from './support/Thread';
import { primaryBtn } from './support/ui';

/**
 * Soporte para el comercio.
 *
 * Dos cosas con el mismo fin —no depender de WhatsApp—: el Centro de ayuda,
 * para resolver solo lo que ya está respondido, y las solicitudes, para lo
 * que no. Un comercio con un problema —un cobro que no cuadra, una
 * liquidación, un domiciliario que no llegó— abre un caso que entra a la
 * bandeja de Soporte con su plazo. Es una conversación: ZIPP responde aquí y el
 * comercio puede replicar mientras el caso siga abierto, sin abrir otro.
 */

type Tab = 'help' | 'requests';
type StatusFilter = DisplayStatus | 'all';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'Todos los estados' },
  ...(Object.keys(DISPLAY_STATUS) as DisplayStatus[]).map((key) => ({ key, label: DISPLAY_STATUS[key].label })),
];

const isReason = (value: string | null): value is Reason => !!value && REASONS.some((r) => r.key === value);

export default function Support() {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const queryClient = useQueryClient();
  const queryKey = supportKey(businessId);
  const { access } = usePermissions(businessId);
  // Estricto, sin el "mientras carga, sí": el selector no debe parpadear para un empleado.
  const canSeeTeam = !!access?.permissions.includes('support:view_team');
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // "Reportar un problema" en el detalle de un pedido (o en una liquidación)
  // llega aquí con lo que pasó en la URL: el formulario abre ya atado a eso.
  const [params, setParams] = useSearchParams();
  const [preset, setPreset] = useState<CasePreset | null>(() => {
    const order = params.get('order');
    const reason = params.get('reason');
    const settlementId = params.get('settlement');
    if (!order && !reason) return null;
    return {
      ...(order ? { order: { id: order, number: params.get('n') ?? '' } } : {}),
      ...(isReason(reason) ? { reason } : {}),
      ...(settlementId ? { settlementId } : {}),
    };
  });
  const [tab, setTab] = useState<Tab>(preset ? 'requests' : 'help');
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(preset ? 'new' : null);
  // Adjuntos que no subieron al abrir el caso: el caso existe, se reintentan desde el hilo.
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

  // La URL ya cumplió su función; sin limpiarla, recargar reabriría el formulario.
  useEffect(() => {
    if (params.has('order') || params.has('reason')) setParams({}, { replace: true });
  }, [params, setParams]);

  const tickets = useQuery({
    queryKey,
    queryFn: async () => (await api.get('/pqrs/my', { params: { businessId } })).data.data as Ticket[],
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

  // Una sola lista: lo cerrado al final, lo demás por actividad.
  const list = [...(source.data ?? [])]
    .filter((t) => statusFilter === 'all' || t.displayStatus === statusFilter)
    .sort((a, b) => {
      const closed = Number(a.status === 'closed') - Number(b.status === 'closed');
      return closed || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
    });
  const selected = selectedId && selectedId !== 'new' ? source.data?.find((t) => t._id === selectedId) : undefined;
  // En pantallas angostas se ve la lista o el hilo, no los dos.
  const showDetail = selectedId === 'new' || !!selected;
  const waiting = (tickets.data ?? []).filter(awaitingYou).length;

  // Con motivo, el formulario abre ya encaminado; `key` lo rehace si se pide otro.
  const ask = (reason?: Reason) => {
    setPreset(reason ? { reason } : null);
    setTab('requests');
    setSelectedId('new');
  };

  return (
    <div className="support-blue space-y-6">
      <div className="page-header">
        <h1 className="page-title">Soporte</h1>
        <p className="page-subtitle">Resuelve tus dudas o cuéntanos qué pasa y te respondemos por aquí</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-[var(--color-border-light)]" role="tablist" aria-label="Soporte">
        {([['help', 'Centro de ayuda'], ['requests', 'Mis solicitudes']] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px inline-flex cursor-pointer items-center gap-2 pb-2 text-sm font-semibold ${tab === key ? 'border-b-2 border-[var(--color-primary)] text-[var(--color-text-main)]' : 'text-[var(--color-text-secondary)]'}`}
          >
            {label}
            {key === 'requests' && waiting > 0 && (
              <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" aria-label={waiting === 1 ? 'Una respuesta nueva' : `${waiting} respuestas nuevas`} />
            )}
          </button>
        ))}
        <button onClick={() => ask()} className={`${primaryBtn} mb-2 ml-auto`}>
          <LifeBuoy className="w-4 h-4" /> Pedir ayuda
        </button>
      </div>

      {tab === 'help' ? (
        <HelpCenter
          onAsk={ask}
          tickets={tickets.data ?? []}
          access={access}
          onOpenTicket={(id) => { setScope('mine'); setSelectedId(id); setTab('requests'); }}
        />
      ) : (
        <div className="grid md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] md:gap-8">
          <section className={showDetail ? 'hidden md:block' : ''}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {canSeeTeam && (
                <div className="flex gap-4" role="tablist" aria-label="De quién son los casos">
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
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label="Filtrar por estado"
                className="ml-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-main)]"
              >
                {STATUS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>

            {source.isError ? (
              <p className="py-4 text-xs font-semibold text-[var(--color-danger)]">
                {apiMessage(source.error, 'No se pudieron cargar los casos.')}
              </p>
            ) : source.isPending ? (
              <p className="py-4 text-xs text-[var(--color-text-secondary)]">Cargando…</p>
            ) : list.length === 0 ? (
              <p className="py-4 text-xs text-[var(--color-text-secondary)]">
                {(source.data?.length ?? 0) > 0
                  ? 'Ningún caso tiene ese estado.'
                  : scope === 'team' ? 'Tu equipo no ha pedido ayuda.' : 'Aún no has pedido ayuda.'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border-light)]">
                {list.map((t) => {
                  const last = t.responses?.[t.responses.length - 1];
                  // Solo en los propios: lo que respondieron a otro no espera nada de ti.
                  const waitingOnYou = t.mine !== false && awaitingYou(t);
                  const status = DISPLAY_STATUS[t.displayStatus];
                  return (
                    <li key={t._id}>
                      <button
                        onClick={() => { setSelectedId(t._id); setTab('requests'); }}
                        className={`w-full cursor-pointer py-3 text-left ${selectedId === t._id ? 'text-[var(--color-primary)]' : ''}`}
                      >
                        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
                          {waitingOnYou && <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] shrink-0" aria-label="Respuesta nueva" />}
                          <span className="truncate">{t.subject}</span>
                        </span>
                        <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} aria-hidden />
                          <span className="truncate">{t.code} · {reasonLabel(t)} · {status.label} · {dateTime(t.updatedAt || t.createdAt)}</span>
                        </span>
                        {t.openedBy && !t.mine && (
                          <span className="block text-[11px] text-[var(--color-text-secondary)]">Lo abrió {t.openedBy}</span>
                        )}
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
                key={preset?.reason ?? 'blank'}
                businessId={businessId}
                preset={preset}
                onBack={() => setSelectedId(null)}
                onCreated={(id, failedFiles) => {
                  queryClient.invalidateQueries({ queryKey });
                  setNotice(failedFiles ? { id, text: `Tu caso se envió, pero ${failedFiles === 1 ? 'un archivo no se pudo subir' : `${failedFiles} archivos no se pudieron subir`}. Adjúntalo de nuevo aquí abajo.` } : null);
                  setSelectedId(id);
                }}
              />
            ) : selected ? (
              <>
                {notice?.id === selected._id && <p className="mb-3 text-xs font-semibold text-[var(--color-danger)]">{notice.text}</p>}
                <Thread ticket={selected} queryKey={queryKey} onBack={() => setSelectedId(null)} />
              </>
            ) : (
              <p className="py-1 text-sm text-[var(--color-text-secondary)]">
                Elige un caso para ver la conversación, o{' '}
                <button onClick={() => ask()} className="cursor-pointer font-semibold text-[var(--color-primary)] underline underline-offset-2">
                  pide ayuda
                </button>
                . ¿Es una duda frecuente? Mira antes el{' '}
                <button onClick={() => setTab('help')} className="cursor-pointer font-semibold text-[var(--color-primary)] underline underline-offset-2">
                  Centro de ayuda
                </button>
                .
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
