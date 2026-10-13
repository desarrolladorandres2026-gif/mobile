import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bike, PackageX, Volume2, WifiOff, X } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useBusinessEvent, useRealtime } from '../hooks/realtimeContext';
import { useActiveOrders, useActiveOrdersLiveSync } from '../hooks/useActiveOrders';
import { useAudioState, useAudioUnlock, useRingLeadership } from '../hooks/useRingLeadership';
import { playNotificationSound, primeNotificationSound, startRingLoop, stopRingLoop } from '../lib/notificationSound';
import {
  cancelledByLabel, isForeignCancellation, ringPatternFor, waitingOrders, waitingSince,
} from '../lib/orderAlarm';
import { getFirstSeen } from '../lib/firstSeen';
import { isQuietMoment } from '../lib/quietMoment';
import { setQuiet } from '../lib/quietState';
import { desktopAttention, desktopReportStatus, onDesktopNotificationClick } from '../lib/desktop';
import type { BusinessOrder } from '../lib/orderFlow';
import NewOrderCard from './NewOrderCard';
import { qk } from '../lib/queryKeys';
import { apiStatus } from '../lib/apiError';

/** Segundos sin conexión antes de avisar: un parpadeo de red no debe asustar. */
const OFFLINE_GRACE_MS = 10_000;
/** El aviso de "domiciliario en el local" se retira solo: es informativo. */
const DRIVER_NOTICE_MS = 45_000;
/** Lo que el aviso se aparta tras "Ver pedido": lo justo para leer la ficha. */
const SNOOZE_MS = 60_000;

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
  const storeOpen = useAuthStore((s) => s.selectedBusiness?.isActive !== false);
  const { status: connection, downSince } = useRealtime();

  // Reloj de la alarma: mueve el tiempo de espera y el aviso de conexión caída.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // ── La lista que manda ──
  const queue = useActiveOrders(businessId, { pollMs: connection === 'online' ? 30_000 : 10_000 });
  useActiveOrdersLiveSync(businessId);
  // Si la lista responde 403 (un empleado dado de baja con la sesión aún
  // abierta) no hay estado fiable y no se hace sonar nada. El personal
  // activo ya recibe la lista: el backend la abre a `orders:view`.
  const listForbidden = queue.isError && apiStatus(queue.error) === 403;

  const waiting = useMemo(
    () => (listForbidden ? [] : waitingOrders(queue.data ?? [], getFirstSeen())),
    [queue.data, listForbidden]
  );
  const pattern = ringPatternFor(waiting, now, getFirstSeen());

  // ── Zipp Negocios (app de escritorio) ──
  //
  // Independiente del sonido a propósito: con el volumen apagado, la
  // ventana igual debe pasar al frente y la notificación de Windows debe
  // salir. `window.zippDesktop` no existe en el navegador, así que esto no
  // hace nada fuera de la app de escritorio.
  useEffect(() => {
    desktopAttention({ pattern, count: waiting.length, orderNumber: waiting[0]?.orderNumber });
  }, [pattern, waiting]);

  useEffect(() => {
    const quiet = isQuietMoment({ ringingCount: waiting.length });
    setQuiet(quiet);
    desktopReportStatus({
      connection: connection === 'online' ? 'online' : 'offline',
      session: 'active',
      storeOpen,
      quiet,
    });
  }, [connection, storeOpen, waiting.length]);

  useEffect(() => onDesktopNotificationClick((orderNumber) => {
    const order = (queue.data ?? []).find((o) => o.orderNumber === orderNumber);
    if (order) navigate(`/orders/${order._id}`);
  }), [queue.data, navigate]);

  // ── El sonido ──
  const audio = useAudioState();
  useAudioUnlock(audio);
  const eligible = audio === 'running';
  const isLeader = useRingLeadership(businessId, eligible);
  const ringKind = isLeader && pattern ? pattern : null;

  useEffect(() => {
    if (ringKind) void startRingLoop(ringKind);
    else stopRingLoop();
  }, [ringKind]);
  useEffect(() => stopRingLoop, []);

  // ── La pausa de "Ver pedido" ──
  //
  // El aviso se planta sobre la esquina donde está el tablero: al pulsar "Ver
  // pedido" tapaba justo la ficha que el comercio acaba de abrir. Se aparta un
  // minuto para ese pedido y vuelve si nadie lo aceptó. No se guarda en la URL
  // ni sobrevive a una recarga a propósito: una pausa que no se cura sola deja
  // un pedido sin aviso. El timbre no se toca: lo calla aceptar o rechazar,
  // nunca mirar.
  const [snoozed, setSnoozed] = useState<{ id: string; until: number } | null>(null);

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

  const unseen = snoozed && now < snoozed.until
    ? waiting.filter((order) => order._id !== snoozed.id)
    : waiting;
  const oldest = unseen[0];
  const oldestMinutes = oldest
    ? Math.max(0, Math.floor((now - waitingSince(oldest, getFirstSeen()[oldest._id])) / 60_000))
    : 0;
  const offline = downSince !== null && now - downSince >= OFFLINE_GRACE_MS;
  const showUnlock = audio === 'suspended';

  const goToOrder = (orderId: string) => navigate(`/orders?pedido=${orderId}`);

  if (!offline && !showUnlock && !oldest && notices.length === 0) return null;

  return (
    <section aria-live="assertive" aria-label="Avisos de pedidos" className="fixed right-4 top-14 z-[60] flex w-[calc(100vw-6rem)] sm:w-[calc(100vw-7rem)] max-w-md flex-col gap-3">
      {offline && (
        <Toast tone="danger" icon={<WifiOff className="h-5 w-5" />} title="Sin conexión">
          Los pedidos no están llegando. Reintentando…
        </Toast>
      )}

      {showUnlock && (
        <button
          type="button"
          onClick={primeNotificationSound}
          className="flex cursor-pointer items-center gap-3 rounded-md border border-[var(--color-warning)]/50 bg-[var(--color-surface)] p-4 text-left shadow-md hover:bg-[var(--color-surface-hover)]"
        >
          <Volume2 className="h-5 w-5 shrink-0 text-[var(--color-warning)]" />
          <span className="text-sm font-semibold text-[var(--color-text-main)]">Toca para activar el sonido de pedidos</span>
        </button>
      )}

      {oldest && (
        <NewOrderCard
          // Una tarjeta nueva por pedido: la entrada con rebote se repite cuando cambia el más antiguo.
          key={oldest._id}
          order={oldest}
          count={unseen.length}
          minutes={oldestMinutes}
          urgent={pattern === 'urgent'}
          onView={() => {
            setSnoozed({ id: oldest._id, until: Date.now() + SNOOZE_MS });
            goToOrder(oldest._id);
          }}
        />
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
            className="mt-2 cursor-pointer text-[11px] font-semibold text-[var(--color-primary)] hover:underline"
          >
            Ver pedido
          </button>
        </Toast>
      ))}
    </section>
  );
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
    <div className={`flex items-start gap-3 rounded-md border bg-[var(--color-surface)] p-4 shadow-md ${TONE[tone]}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[var(--color-text-main)]">{title}</span>
        <span className="mt-1 block text-xs text-[var(--color-text-secondary)]">{children}</span>
      </span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Cerrar aviso" className="cursor-pointer rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)]">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
