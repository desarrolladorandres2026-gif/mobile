import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Phone, MapPin, User, Clock, X, CheckCircle2 } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { PermissionGate } from './PermissionGate';
import { Permission } from '../lib/permissions';

/**
 * Detalle de una emergencia y lo que un administrador puede hacer con ella.
 *
 * Vive como panel aparte (no como fila expandible dentro de Incidentes)
 * porque atender una emergencia es una acción que se hace una vez, con
 * cuidado, no algo que se hojea junto a un faltante de efectivo. El detalle
 * sale de `GET /sos/active` en vez de un endpoint propio: ya trae todo lo
 * que hace falta (contacto de emergencia, ubicación, pedido, placa) porque
 * es lo mismo que arma el listado del panel de administración.
 */

interface SosDriver {
 _id: string;
 licensePlate?: string | null;
 vehicleType?: string;
 userId?: { name?: string; phone?: string };
}

interface SosAlertDetail {
 _id: string;
 status: 'active' | 'acknowledged' | 'resolved' | 'false_alarm';
 driverId: SosDriver;
 orderId?: string | null;
 location: { coordinates: [number, number] };
 note?: string;
 emergencyContact?: { name: string; phone: string; relationship?: string };
 createdAt: string;
 acknowledgedAt?: string | null;
}

function InfoRow({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string }) {
 return (
 <div className="flex items-start gap-3">
 <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-main)]" />
 <div className="min-w-0">
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{label}</p>
 <p className="break-words text-sm font-semibold text-[var(--color-text-main)]">{value}</p>
 </div>
 </div>
 );
}

export default function SosPanel({
 alertId,
 onClose,
 onChanged,
}: {
 alertId: string;
 onClose: () => void;
 onChanged: () => void;
}) {
 const [alert, setAlert] = useState<SosAlertDetail | null>(null);
 const [loading, setLoading] = useState(true);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');

 const [resolving, setResolving] = useState(false);
 const [resolution, setResolution] = useState('');
 const [falseAlarm, setFalseAlarm] = useState(false);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 const { data } = await api.get('/sos/active');
 const found = (data.data ?? []).find((a: SosAlertDetail) => a._id === alertId) ?? null;
 setAlert(found);
 } catch (err) {
 setError(apiMessage(err, 'No pudimos cargar la emergencia.'));
 } finally {
 setLoading(false);
 }
 }, [alertId]);

 useEffect(() => {
 load();
 }, [load]);

 const acknowledge = async () => {
 setBusy(true);
 setError('');
 try {
 await api.patch(`/sos/${alertId}/acknowledge`);
 await load();
 onChanged();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo marcar como atendida.'));
 } finally {
 setBusy(false);
 }
 };

 const resolve = async () => {
 if (resolution.trim().length < 3) {
 setError('Escribe qué pasó. Es lo que va a leer quien revise esto después.');
 return;
 }
 setBusy(true);
 setError('');
 try {
 await api.patch(`/sos/${alertId}/resolve`, { resolution: resolution.trim(), falseAlarm });
 onChanged();
 onClose();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo cerrar la emergencia.'));
 } finally {
 setBusy(false);
 }
 };

 const driverName = alert?.driverId?.userId?.name ?? 'Domiciliario';
 const driverPhone = alert?.driverId?.userId?.phone;
 const [lng, lat] = alert?.location?.coordinates ?? [null, null];

 return (
 <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
 <button
 type="button"
 aria-label="Cerrar"
 onClick={onClose}
 className="absolute inset-0 bg-black/50 backdrop-blur-[2px] cursor-default"
 />

 <div
 role="dialog"
 aria-label="Emergencia"
 className="relative w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl animate-fade-in"
 >
 <div className="flex items-start gap-3 border-b border-[var(--color-border-light)] p-5">
 <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger)]" />
 <div className="min-w-0 flex-1">
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Botón de pánico</h3>
 <p className="text-xs text-[var(--color-text-main)]">
 {alert?.status === 'acknowledged' ? 'La estás atendiendo' : 'Sin atender todavía'}
 </p>
 </div>
 <button
 onClick={onClose}
 aria-label="Cerrar"
 className="cursor-pointer rounded-lg p-1 text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-main)]"
 >
 <X className="h-4 w-4" />
 </button>
 </div>

 <div className="max-h-[70vh] overflow-y-auto p-5">
 {loading ? (
 <p className="text-sm text-[var(--color-text-main)]">Cargando…</p>
 ) : !alert ? (
 <p className="text-sm text-[var(--color-text-main)]">
 Ya no está activa. Puede que otro administrador ya la haya cerrado.
 </p>
 ) : (
 <div className="space-y-4">
 <InfoRow
 icon={User}
 label="Domiciliario"
 value={`${driverName}${alert.driverId?.licensePlate ? ` · ${alert.driverId.licensePlate}` : ''}`}
 />
 {driverPhone ? (
 <div className="flex items-center justify-between gap-3">
 <InfoRow icon={Phone} label="Teléfono" value={driverPhone} />
 <a
 href={`tel:${driverPhone}`}
 className="shrink-0 rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white"
 >
 Llamar
 </a>
 </div>
 ) : null}

 {alert.emergencyContact?.phone ? (
 <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border-light)] pt-4">
 <InfoRow
 icon={Phone}
 label={`Contacto de emergencia${alert.emergencyContact.relationship ? ` · ${alert.emergencyContact.relationship}` : ''}`}
 value={`${alert.emergencyContact.name} · ${alert.emergencyContact.phone}`}
 />
 <a
 href={`tel:${alert.emergencyContact.phone}`}
 className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Llamar
 </a>
 </div>
 ) : null}

 {lat != null && lng != null ? (
 <div className="flex items-center justify-between gap-3">
 <InfoRow icon={MapPin} label="Última ubicación" value={`${lat.toFixed(5)}, ${lng.toFixed(5)}`} />
 <a
 href={`https://www.google.com/maps?q=${lat},${lng}`}
 target="_blank"
 rel="noreferrer"
 className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Ver mapa
 </a>
 </div>
 ) : null}

 <InfoRow
 icon={Clock}
 label="Declarada"
 value={new Date(alert.createdAt).toLocaleString('es-CO')}
 />

 {alert.note ? (
 <div className="border-t border-[var(--color-border-light)] pt-4">
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">Nota</p>
 <p className="text-sm text-[var(--color-text-main)]">{alert.note}</p>
 </div>
 ) : null}

 {error ? <p className="text-sm text-[var(--color-danger)]">{error}</p> : null}

 {resolving ? (
 <div className="space-y-2 border-t border-[var(--color-border-light)] pt-4">
 <label className="block space-y-1">
 <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">
 Qué pasó
 </span>
 <textarea
 value={resolution}
 onChange={(e) => setResolution(e.target.value)}
 maxLength={500}
 rows={3}
 placeholder="Se comunicó con el domiciliario, estaba bien, se le pinchó una llanta"
 className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-main)]"
 />
 </label>
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 <input
 type="checkbox"
 checked={falseAlarm}
 onChange={(e) => setFalseAlarm(e.target.checked)}
 />
 Fue una falsa alarma
 </label>
 <div className="flex justify-end gap-2 pt-1">
 <button
 onClick={() => setResolving(false)}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Cancelar
 </button>
 <button
 onClick={resolve}
 disabled={busy}
 className="cursor-pointer rounded-lg bg-[var(--color-success)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
 >
 {busy ? 'Cerrando…' : 'Cerrar emergencia'}
 </button>
 </div>
 </div>
 ) : (
 <PermissionGate
 permission={Permission.SOS_MANAGE}
 fallback={<p className="pt-1 text-xs text-[var(--color-text-main)]">Tu rol puede ver la emergencia, pero no atenderla.</p>}
 >
 <div className="flex gap-2 pt-1">
 {alert.status === 'active' ? (
 <button
 onClick={acknowledge}
 disabled={busy}
 className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-bold text-white disabled:opacity-60"
 >
 {busy ? 'Marcando…' : 'La estoy atendiendo'}
 </button>
 ) : (
 <span className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-[var(--color-text-main)]">
 <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" /> Ya la estás atendiendo
 </span>
 )}
 <button
 onClick={() => setResolving(true)}
 className="flex-1 cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Cerrar emergencia
 </button>
 </div>
 </PermissionGate>
 )}
 </div>
 )}
 </div>
 </div>
 </div>
 );
}
