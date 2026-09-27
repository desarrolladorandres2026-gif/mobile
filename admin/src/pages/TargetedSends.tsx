import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw, Send } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { fetchBusinessOptions } from '../lib/businessOptions';
import { apiMessage } from '../lib/apiError';

/**
 * Envíos dirigidos: un push a un segmento, con vista previa del alcance.
 *
 * Solo llega a quien aceptó comunicaciones comerciales. El envío corre en
 * segundo plano y queda registrado; mientras hay uno en curso no se acepta
 * otro.
 */

interface Segment {
 role?: 'client' | 'driver';
 city?: string;
 boughtFromBusinessId?: string;
 inactiveForDays?: number;
 minDeliveredOrders?: number;
}

interface SendRecord {
 _id: string;
 title: string;
 body: string;
 status: 'sending' | 'done' | 'failed';
 targeted: number;
 sent: number;
 failed: number;
 segment: Segment;
 createdAt: string;
 sentBy?: { name?: string } | null;
}

interface BusinessOption { _id: string; name: string }

const STATUS_LABEL: Record<SendRecord['status'], string> = {
 sending: 'En curso',
 done: 'Enviado',
 failed: 'Falló',
};

const fieldClass = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';
const labelClass = 'mb-1 block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]';

function describe(segment: Segment, businesses: BusinessOption[]): string {
 const parts: string[] = [segment.role === 'driver' ? 'Domiciliarios' : 'Clientes'];
 if (segment.city) parts.push(`en ${segment.city}`);
 if (segment.boughtFromBusinessId) {
 parts.push(`que compraron en ${businesses.find((b) => b._id === segment.boughtFromBusinessId)?.name ?? 'un negocio'}`);
 }
 if (segment.minDeliveredOrders) parts.push(`con ${segment.minDeliveredOrders}+ pedidos`);
 if (segment.inactiveForDays) parts.push(`sin pedir hace ${segment.inactiveForDays}+ días`);
 return parts.join(' · ');
}

export default function TargetedSends() {
 const queryClient = useQueryClient();
 const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
 const [history, setHistory] = useState<SendRecord[]>([]);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');

 const [role, setRole] = useState<'client' | 'driver'>('client');
 const [city, setCity] = useState('');
 const [businessId, setBusinessId] = useState('');
 const [inactive, setInactive] = useState('');
 const [minOrders, setMinOrders] = useState('');
 const [title, setTitle] = useState('');
 const [body, setBody] = useState('');

 const [reach, setReach] = useState<number | null>(null);
 const [working, setWorking] = useState(false);
 const [confirming, setConfirming] = useState(false);

 const segment = (): Segment => ({
 role,
 ...(city.trim() ? { city: city.trim() } : {}),
 ...(businessId ? { boughtFromBusinessId: businessId } : {}),
 ...(inactive ? { inactiveForDays: Number(inactive) } : {}),
 ...(minOrders ? { minDeliveredOrders: Number(minOrders) } : {}),
 });

 const loadHistory = useCallback(async () => {
 try {
 const { data } = await api.get('/admin/growth/campaigns/history');
 setHistory(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cargar el historial.'));
 }
 }, []);

 useEffect(() => {
 loadHistory();
 fetchBusinessOptions(queryClient)
 .then(({ data }) => setBusinesses(data.data ?? []))
 .catch(() => setBusinesses([]));
 }, [loadHistory, queryClient]);

 // Mientras haya un envío en curso, se refresca solo el historial.
 const sending = history.some((h) => h.status === 'sending');
 useEffect(() => {
 if (!sending) return;
 const t = setInterval(loadHistory, 5000);
 return () => clearInterval(t);
 }, [sending, loadHistory]);

 // Cambiar el segmento invalida la vista previa: confirmar exige verla de nuevo.
 useEffect(() => { setReach(null); }, [role, city, businessId, inactive, minOrders]);

 const preview = async () => {
 setWorking(true); setError(''); setNotice('');
 try {
 const { data } = await api.post('/admin/growth/campaigns/preview', { segment: segment() });
 setReach(data.data.reach);
 } catch (err) {
 setError(apiMessage(err, 'No se pudo calcular el alcance.'));
 } finally {
 setWorking(false);
 }
 };

 const send = async () => {
 setConfirming(false); setWorking(true); setError(''); setNotice('');
 try {
 await api.post('/admin/growth/campaigns/send', {
 segment: segment(),
 message: { title: title.trim(), body: body.trim() },
 confirmedReach: reach,
 });
 setNotice('Envío en curso. Verás el resultado en el historial.');
 setTitle(''); setBody(''); setReach(null);
 await loadHistory();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo lanzar el envío.'));
 } finally {
 setWorking(false);
 }
 };

 const messageOk = title.trim().length >= 3 && body.trim().length >= 3;

 return (
 <div className="space-y-6 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Envíos dirigidos</h1>
 <p className="page-subtitle">
 Un aviso a un grupo concreto. Solo llega a quien aceptó comunicaciones comerciales; usa esto poco: quien se cansa apaga todas las notificaciones, también la de su pedido.
 </p>
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}
 {notice && <p className="text-xs font-semibold text-[var(--color-success)]">{notice}</p>}

 <PermissionGate permission={Permission.NOTIFICATIONS_SEND}>
 <div className="grid gap-x-6 gap-y-4 border-y border-[var(--color-border-light)] py-5 md:grid-cols-2">
 <div>
 <label className={labelClass}>A quién</label>
 <select value={role} onChange={(e) => setRole(e.target.value as 'client' | 'driver')} className={fieldClass}>
 <option value="client">Clientes</option>
 <option value="driver">Domiciliarios</option>
 </select>
 </div>
 <div>
 <label className={labelClass}>Ciudad (de sus direcciones)</label>
 <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} placeholder="Todas" className={fieldClass} />
 </div>
 {role === 'client' && (
 <>
 <div>
 <label className={labelClass}>Compraron en</label>
 <select value={businessId} onChange={(e) => setBusinessId(e.target.value)} className={fieldClass}>
 <option value="">Cualquier negocio</option>
 {businesses.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
 </select>
 </div>
 <div className="grid grid-cols-2 gap-4">
 <div>
 <label className={labelClass}>Sin pedir hace (días)</label>
 <input type="number" min={1} max={365} value={inactive} onChange={(e) => setInactive(e.target.value)} className={fieldClass} />
 </div>
 <div>
 <label className={labelClass}>Mín. pedidos entregados</label>
 <input type="number" min={1} max={1000} value={minOrders} onChange={(e) => setMinOrders(e.target.value)} className={fieldClass} />
 </div>
 </div>
 </>
 )}
 <div className="md:col-span-2">
 <label className={labelClass}>Título · {title.length}/60</label>
 <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} className={fieldClass} />
 </div>
 <div className="md:col-span-2">
 <label className={labelClass}>Mensaje · {body.length}/240</label>
 <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={240} rows={3} className={fieldClass} />
 </div>
 <div className="flex flex-wrap items-center gap-4 md:col-span-2">
 <button
 onClick={preview}
 disabled={working}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Calcular alcance
 </button>
 {reach !== null && (
 <p className="text-sm font-semibold text-[var(--color-text-main)]">
 Llega a {reach} {reach === 1 ? 'persona' : 'personas'}
 </p>
 )}
 <button
 onClick={() => (reach === null ? preview() : setConfirming(true))}
 disabled={working || sending || !messageOk || reach === 0}
 className="ml-auto flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-[var(--color-on-primary,#000)] disabled:opacity-50"
 >
 <Send className="h-4 w-4" />
 {sending ? 'Hay un envío en curso' : reach === null ? 'Calcular y continuar' : 'Enviar'}
 </button>
 </div>
 </div>
 </PermissionGate>

 <div>
 <div className="mb-2 flex items-center justify-between">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Historial</h2>
 <button onClick={loadHistory} className="cursor-pointer text-xs font-semibold text-[var(--color-primary)]">
 <RotateCw className="mr-1 inline h-3 w-3" /> Actualizar
 </button>
 </div>
 {history.length === 0 ? (
 <p className="py-8 text-center text-xs font-semibold text-[var(--color-text-main)]">Aún no se ha enviado nada.</p>
 ) : (
 <ul>
 {history.map((h) => (
 <li key={h._id} className="border-b border-[var(--color-border-light)] py-3">
 <div className="flex flex-wrap items-baseline gap-x-4">
 <p className="font-semibold text-[var(--color-text-main)]">{h.title}</p>
 <p className={`text-xs font-bold ${h.status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {STATUS_LABEL[h.status]}
 </p>
 <p className="ml-auto text-xs text-[var(--color-text-main)]">{new Date(h.createdAt).toLocaleString('es-CO')}</p>
 </div>
 <p className="text-xs text-[var(--color-text-main)]">{h.body}</p>
 <p className="text-xs text-[var(--color-text-main)]">
 {describe(h.segment, businesses)}
 {h.status === 'done' && ` · ${h.sent} de ${h.targeted} entregados a Expo`}
 {h.sentBy?.name && ` · ${h.sentBy.name}`}
 </p>
 </li>
 ))}
 </ul>
 )}
 </div>

 {confirming && reach !== null && (
 <ConfirmDialog
 title={`Enviar a ${reach} ${reach === 1 ? 'persona' : 'personas'}`}
 message={`"${title.trim()}" — ${describe(segment(), businesses)}. No se puede deshacer.`}
 confirmLabel="Enviar ahora"
 variant="warning"
 onConfirm={send}
 onCancel={() => setConfirming(false)}
 />
 )}
 </div>
 );
}
