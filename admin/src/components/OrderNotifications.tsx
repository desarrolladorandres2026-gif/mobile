import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleX, PackagePlus, X } from 'lucide-react';
import { useAdminSocketEvents } from '../hooks/useAdminSocket';

type Notice = { id: string; title: string; detail: string; cancelled?: boolean };

function chime() {
 try {
 const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
 if (!AudioCtx) return;
 const context = new AudioCtx();
 const oscillator = context.createOscillator();
 const gain = context.createGain();
 oscillator.frequency.setValueAtTime(1040, context.currentTime);
 gain.gain.setValueAtTime(0.0001, context.currentTime);
 gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
 gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
 oscillator.connect(gain).connect(context.destination);
 oscillator.start(); oscillator.stop(context.currentTime + 0.3);
 oscillator.addEventListener('ended', () => void context.close());
 } catch { /* El aviso visual funciona aunque el navegador bloquee audio. */ }
}

/** Pedidos en vivo para administración, visible en cualquier módulo. */
export default function OrderNotifications() {
 const navigate = useNavigate();
 const [notices, setNotices] = useState<Notice[]>([]);
 const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

 const dismiss = (id: string) => {
 const timer = timers.current.get(id);
 if (timer) clearTimeout(timer);
 timers.current.delete(id);
 setNotices((current) => current.filter((notice) => notice.id !== id));
 };
 const show = (notice: Notice) => {
 chime();
 setNotices((current) => [notice, ...current.filter((item) => item.id !== notice.id)].slice(0, 3));
 const old = timers.current.get(notice.id);
 if (old) clearTimeout(old);
 timers.current.set(notice.id, setTimeout(() => dismiss(notice.id), 10_000));
 };
 useEffect(() => () => timers.current.forEach(clearTimeout), []);

 useAdminSocketEvents({
 'order:new': (payload) => {
 const order = payload as unknown as { orderId?: string; orderNumber?: string };
 if (!order.orderId) return;
 show({ id: `new:${order.orderId}`, title: 'Nuevo pedido', detail: `Pedido #${order.orderNumber ?? order.orderId.slice(-6)} acaba de entrar.` });
 },
 'order:status:changed': (payload) => {
 const order = payload as unknown as { orderId?: string; orderNumber?: string; status?: string; cancellationReason?: string };
 if (!order.orderId || order.status !== 'cancelled') return;
 show({ id: `cancelled:${order.orderId}`, title: 'Pedido cancelado', detail: `Pedido #${order.orderNumber ?? order.orderId.slice(-6)}${order.cancellationReason ? `: ${order.cancellationReason}` : '.'}`, cancelled: true });
 },
 });

 if (!notices.length) return null;
 return <section aria-live="assertive" aria-label="Avisos de pedidos" className="fixed right-4 top-20 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3">
 {notices.map((notice) => <div key={notice.id} className={`flex items-start gap-3 rounded-2xl border bg-[var(--color-surface)] p-4 shadow-2xl animate-fade-in ${notice.cancelled ? 'border-[var(--color-danger)]/40' : 'border-[var(--color-primary)]/40'}`}>
 <span className={`rounded-xl p-2 ${notice.cancelled ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]' : 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'}`}>{notice.cancelled ? <CircleX className="h-5 w-5" /> : <PackagePlus className="h-5 w-5" />}</span>
 <button type="button" onClick={() => { dismiss(notice.id); navigate('/orders'); }} className="min-w-0 flex-1 cursor-pointer text-left"><span className="block text-sm font-bold text-[var(--color-text-main)]">{notice.title}</span><span className="mt-1 block text-xs text-[var(--color-text-main)]">{notice.detail}</span><span className="mt-2 block text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary)]">Ver pedidos</span></button>
 <button type="button" onClick={() => dismiss(notice.id)} aria-label="Cerrar aviso" className="cursor-pointer rounded-lg p-1 text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)]"><X className="h-4 w-4" /></button>
 </div>)}
 </section>;
}
