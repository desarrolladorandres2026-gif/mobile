import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Bike, PackageX, Volume2, WifiOff, X } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { usePreferencesStore } from '../stores/preferencesStore';
import { useAlarmStore } from '../stores/alarmStore';
import { useBusinessEvent, useRealtime } from '../hooks/realtimeContext';
import { useActiveOrders, useActiveOrdersLiveSync } from '../hooks/useActiveOrders';
import { useAudioState, useAudioUnlock, useRingLeadership } from '../hooks/useRingLeadership';
import { playNotificationSound, primeNotificationSound, startRingLoop, stopRingLoop } from '../lib/notificationSound';
import {
  cancelledByLabel, isForeignCancellation, ringingOrders, ringPatternFor, waitingOrders, waitingSince,
} from '../lib/orderAlarm';
import { getFirstSeen } from '../lib/firstSeen';
import { money, shortId, type BusinessOrder } from '../lib/orderFlow';
import { qk } from '../lib/queryKeys';
import { apiStatus } from '../lib/apiError';

/** Segundos sin conexión antes de avisar: un parpadeo de red no debe asustar. */
const OFFLINE_GRACE_MS = 10_000;
/** El aviso de "domiciliario en el local" se retira solo: es informativo. */
const DRIVER_NOTICE_MS = 45_000;

type Notice = { id: string; kind: 'cancelled' | 'driver'; title: string; detail: string; orderId: string };

/**
 * Avisos globales de pedidos: no dependen de en qué pantalla esté el comercio.
 *
 * El timbre lo decide el **estado** de la lista de pedidos pendientes, no cada
 * evento del socket: mientras haya uno aceptable sin atender, suena en bucle;
 * en cuanto se acepta o se rechaza —en este equipo o en otro— se calla. Los
 * eventos solo mantienen la lista al día. Solo suena lo que pide una acción
 * del comercio (pedido nuevo y cancelación ajena); los cambios que provoca el
 * propio local ya no hacen ruido.
 */
export default function OrderNotifications() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled);
  const snoozes = useAlarmStore((s) => s.snoozes);
  const snooze = useAlarmStore((s) => s.snooze);
  const { status: connection, downSince } = useRealtime();

  // Reloj de la alarma: mueve el tiempo de espera, el fin de los silencios y
  // el aviso de conexión caída.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // ── La lista que manda ──
  const queue = useActiveOrders(businessId, { pollMs: connection === 'online' ? 30_000 : 10_000 });
  useActiveOrdersLiveSync(businessId);
  // Un empleado recibe el pedido por socket pero la lista le responde 403:
  // sin la lista no hay estado fiable y no se hace sonar nada.
  const listForbidden = queue.isError && apiStatus(queue.error) === 403;

  const waiting = useMemo(
    () => (listForbidden ? [] : waitingOrders(queue.data ?? [], getFirstSeen())),
    [queue.data, listForbidden]
  );
  const ringing = useMemo(() => ringingOrders(waiting, snoozes, now), [waiting, snoozes, now]);
  const pattern = ringPatternFor(ringing, now, getFirstSeen());

  // ── El sonido ──
  const audio = useAudioState();
  useAudioUnlock(audio);
  const eligible = soundEnabled && audio === 'running';
  const isLeader = useRingLeadership(businessId, eligible);
  const ringKind = isLeader && pattern ? pattern : null;

  useEffect(() => {
    if (ringKind) void startRingLoop(ringKind);
    else stopRingLoop();
  }, [ringKind]);
  useEffect(() => stopRingLoop, []);

  // ── Avisos puntuales ──
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const show = useCallback((notice: Notice, autoDismissMs?: number) => {
    setNotices((current) => [notice, ...current.filter((item) => item.id !== notice.id)].slice(0, 3));
    const old = timers.current.get(notice.id);
    if (old) clearTimeout(old);
    if (autoDismissMs) timers.current.set(notice.id, setTimeout(() => dismiss(notice.id), autoDismissMs));
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  /**
   * ¿Es de este local? Los eventos nuevos traen `businessId`; si falta
   * (servidor antiguo), se comprueba que el pedido esté en la lista de este
   * local.
   */
  const isMine = (eventBusinessId: string | undefined, orderId: string) => {
    if (eventBusinessId) return eventBusinessId === businessId;
    return !!queryClient.getQueryData<BusinessOrder[]>(qk.activeOrders(businessId))?.some((order) => order._id === orderId);
  };

  useBusinessEvent('order:status:changed', (changed) => {
    if (!isForeignCancellation(changed) || !isMine(changed.businessId, changed.orderId)) return;
    if (isLeader) playNotificationSound('attention');
    const why = changed.cancellationReason ? `: ${changed.cancellationReason}` : '.';
    show({
      id: `cancelled:${changed.orderId}`,
      kind: 'cancelled',
      orderId: changed.orderId,
      title: `Pedido #${changed.orderNumber} cancelado`,
      detail: `Lo canceló ${cancelledByLabel(changed.cancelledBy)}${why} No lo sigas preparando.`,
    });
  });

  useBusinessEvent('order:driver:arrived', (arrived) => {
    if (arrived.stage !== 'pickup' || !isMine(arrived.businessId, arrived.orderId)) return;
    show({
      id: `arrived:${arrived.orderId}`,
      kind: 'driver',
      orderId: arrived.orderId,
      title: 'Domiciliario en el local',
      detail: `Pedido #${arrived.orderNumber}: pídele el código de recogida.`,
    }, DRIVER_NOTICE_MS);
  });

  const oldest = ringing[0] ?? waiting[0];
  const oldestMinutes = oldest
    ? Math.max(0, Math.floor((now - waitingSince(oldest, getFirstSeen()[oldest._id])) / 60_000))
    : 0;
  const offline = downSince !== null && now - downSince >= OFFLINE_GRACE_MS;
  const showUnlock = soundEnabled && audio === 'suspended';

  const goToOrder = (orderId: string) => navigate(`/orders?pedido=${orderId}`);

  if (!offline && !showUnlock && waiting.length === 0 && notices.length === 0) return null;

  return (
    <section aria-live="assertive" aria-label="Avisos de pedidos" className="fixed right-4 top-20 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3">
      {offline && (
        <Toast tone="danger" icon={<WifiOff className="h-5 w-5" />} title="Sin conexión">
          Los pedidos no están llegando. Reintentando…
        </Toast>
      )}

      {showUnlock && (
        <button
          type="button"
          onClick={primeNotificationSound}
          className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[var(--color-warning)]/50 bg-[var(--color-surface)] p-4 text-left shadow-2xl backdrop-blur transition hover:-translate-y-0.5"
        >
          <Volume2 className="h-5 w-5 shrink-0 text-[var(--color-warning)]" />
          <span className="text-sm font-bold text-[var(--color-text-main)]">Toca para activar el sonido de pedidos</span>
        </button>
      )}

      {oldest && (
        <Toast
          tone={pattern === 'urgent' ? 'danger' : 'success'}
          icon={<BellRing className="h-5 w-5" />}
          title={
            pattern === 'urgent'
              ? `Sin aceptar hace ${oldestMinutes} min`
              : waiting.length > 1 ? `${waiting.length} pedidos nuevos` : '¡Nuevo pedido!'
          }
        >
          <span className="block">{summary(oldest, oldestMinutes)}</span>
          <span className="mt-3 flex items-center gap-4">
            <button
              type="button"
              onClick={() => goToOrder(oldest._id)}
              className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[var(--color-primary-dark)]"
            >
              Ver pedido
            </button>
            {ringing.length > 0 ? (
              <button
                type="button"
                onClick={() => snooze(ringing.map((order) => order._id))}
                className="cursor-pointer text-xs font-bold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:underline"
              >
                Silenciar 1 min
              </button>
            ) : (
              <span className="text-xs font-semibold text-[var(--color-text-secondary)]">Silenciado</span>
            )}
          </span>
        </Toast>
      )}

      {notices.map((notice) => (
        <Toast
          key={notice.id}
          tone={notice.kind === 'cancelled' ? 'danger' : 'success'}
          icon={notice.kind === 'cancelled' ? <PackageX className="h-5 w-5" /> : <Bike className="h-5 w-5" />}
          title={notice.title}
          onClose={() => dismiss(notice.id)}
        >
          <span className="block">{notice.detail}</span>
          <button
            type="button"
            onClick={() => { dismiss(notice.id); goToOrder(notice.orderId); }}
            className="mt-2 cursor-pointer text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary)] hover:underline"
          >
            Ver pedido
          </button>
        </Toast>
      ))}
    </section>
  );
}

function summary(order: BusinessOrder, minutes: number) {
  const items = (order.items ?? []).map((item) => `${item.quantity}× ${item.productName}`).join(' · ');
  const head = `#${order.orderNumber ?? shortId(order._id)} · ${money(order.total)} · hace ${minutes} min`;
  return items ? `${head} · ${items}` : head;
}

const TONE = {
  success: 'border-[var(--color-success)]/40 text-[var(--color-success)]',
  danger: 'border-[var(--color-danger)]/40 text-[var(--color-danger)]',
} as const;

/** Superficie flotante de un aviso: es un toast, no una tarjeta de contenido. */
function Toast({ tone, icon, title, onClose, children }: {
  tone: keyof typeof TONE;
  icon: ReactNode;
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`flex items-start gap-3 rounded-2xl border bg-[var(--color-surface)] p-4 shadow-2xl backdrop-blur ${TONE[tone]}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-[var(--color-text-main)]">{title}</span>
        <span className="mt-1 block text-xs text-[var(--color-text-secondary)]">{children}</span>
      </span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Cerrar aviso" className="cursor-pointer rounded-lg p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)]">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
