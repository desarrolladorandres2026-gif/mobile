import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellRing, PackageCheck, X } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { usePreferencesStore } from '../stores/preferencesStore';
import { useBusinessEvent } from '../hooks/realtimeContext';
import { playNotificationSound, primeNotificationSound } from '../lib/notificationSound';

type Notice = { id: string; title: string; detail: string; tone: 'new' | 'cancelled' };

/** Avisos globales: no dependen de que la persona esté en el Dashboard. */
export default function OrderNotifications() {
  const navigate = useNavigate();
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled);
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const show = useCallback((notice: Notice) => {
    setNotices((current) => [notice, ...current.filter((item) => item.id !== notice.id)].slice(0, 3));
    const oldTimer = timers.current.get(notice.id);
    if (oldTimer) clearTimeout(oldTimer);
    timers.current.set(notice.id, setTimeout(() => dismiss(notice.id), 10_000));
  }, [dismiss]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Los navegadores exigen una interacción antes de permitir audio. Queda
  // habilitado tras el primer clic o tecla de la sesión, sin pedir permisos.
  useEffect(() => {
    const unlock = () => primeNotificationSound();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useBusinessEvent('order:incoming', (order) => {
    const ref = order.businessId;
    const orderBusinessId = typeof ref === 'object' && ref !== null ? ref._id : ref;
    if (!businessId || String(orderBusinessId) !== String(businessId)) return;
    if (soundEnabled) playNotificationSound('new');
    show({ id: `incoming:${order._id}`, title: '¡Nuevo pedido!', detail: `Pedido #${order.orderNumber ?? order._id.slice(-6)} listo para revisar.`, tone: 'new' });
  });

  useBusinessEvent('order:status:changed', (order) => {
    if (soundEnabled) playNotificationSound(order.status === 'cancelled' ? 'attention' : 'update');
    if (order.status === 'cancelled') {
      show({ id: `cancelled:${order.orderId}`, title: 'Pedido cancelado', detail: `El pedido #${order.orderNumber} fue cancelado${order.cancellationReason ? `: ${order.cancellationReason}` : '.'}`, tone: 'cancelled' });
      return;
    }
    show({ id: `status:${order.orderId}:${order.status}`, title: 'Pedido actualizado', detail: `El pedido #${order.orderNumber} cambió a ${order.status}.`, tone: 'new' });
  });

  useBusinessEvent('order:driver:assigned', (order) => {
    if (soundEnabled) playNotificationSound('update');
    show({ id: `driver:${order.orderId}`, title: 'Domiciliario asignado', detail: `Un domiciliario fue asignado al pedido #${order.orderNumber}.`, tone: 'new' });
  });

  useBusinessEvent('order:driver:arrived', (order) => {
    if (soundEnabled) playNotificationSound('attention');
    show({ id: `arrived:${order.orderId}:${order.stage}`, title: order.stage === 'pickup' ? 'Domiciliario en el local' : 'Pedido en destino', detail: `Actualización del pedido #${order.orderNumber}.`, tone: 'new' });
  });

  if (!notices.length) return null;
  return (
    <section aria-live="assertive" aria-label="Notificaciones de pedidos" className="fixed right-4 top-20 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3">
      {notices.map((notice) => (
        <button key={notice.id} type="button" onClick={() => { dismiss(notice.id); navigate('/orders'); }}
          className={`group flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-left shadow-2xl backdrop-blur transition hover:-translate-y-0.5 ${notice.tone === 'new' ? 'border-[var(--color-success)]/40 bg-[var(--color-surface)]' : 'border-[var(--color-danger)]/40 bg-[var(--color-surface)]'}`}>
          <span className={`mt-0.5 rounded-xl p-2 ${notice.tone === 'new' ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'}`}>
            {notice.tone === 'new' ? <PackageCheck className="h-5 w-5" /> : <BellRing className="h-5 w-5" />}
          </span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-[var(--color-text-main)]">{notice.title}</span><span className="mt-1 block text-xs text-[var(--color-text-secondary)]">{notice.detail}</span><span className="mt-2 block text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary)]">Ver pedidos</span></span>
          <span onClick={(event) => { event.stopPropagation(); dismiss(notice.id); }} className="rounded-lg p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-alt)]" aria-label="Cerrar aviso"><X className="h-4 w-4" /></span>
        </button>
      ))}
    </section>
  );
}
