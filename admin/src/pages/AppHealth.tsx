import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { PermissionGate } from '../components/PermissionGate';
import { Permission } from '../lib/permissions';

/**
 * Salud de la app: qué se rompe en los teléfonos y cuánto cuesta el recorte
 * de fondo de las fotos de producto.
 *
 * Los crashes son contadores agrupados por mensaje y versión; nunca salen
 * las personas ni los dispositivos, solo cuántos fueron.
 */

interface CrashGroup {
 message: string;
 appVersion: string;
 count: number;
 fatal: number;
 usersAffected: number;
 platforms: string[];
 scope: string | null;
 firstAt: string;
 lastAt: string;
 sampleOrderId: string | null;
 stack: string | null;
 status: 'open' | 'resolved' | 'regression';
 resolvedAt: string | null;
}

interface Crashes {
 days: number;
 totals: { total: number; fatal: number; usersAffected: number };
 byVersion: { appVersion: string; total: number; fatal: number }[];
 groups: CrashGroup[];
}

interface ImageStats {
 range: { from: string; to: string };
 totals: { completed: number; failed: number; retriesScheduled: number; superseded: number; limited: number; billable: number };
 durationMs: { average: number | null; p95: number | null };
 byProvider: { provider: string; completed: number; failed: number; billable: number }[];
 topBusinesses: { businessId: string; name: string | null; completed: number; failed: number; billable: number }[];
}

const when = (iso: string) =>
 new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const DAY_OPTIONS = [1, 7, 30];

export default function AppHealth() {
 const [days, setDays] = useState(7);
 const [crashes, setCrashes] = useState<Crashes | null>(null);
 const [images, setImages] = useState<ImageStats | null>(null);
 const [openStack, setOpenStack] = useState<string | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [imageError, setImageError] = useState('');
 const [showResolved, setShowResolved] = useState(false);
 const [acting, setActing] = useState<string | null>(null);
 const [actionError, setActionError] = useState('');

 const load = useCallback(async () => {
 setLoading(true);
 setError('');
 setImageError('');
 const to = new Date();
 const from = new Date(to.getTime() - 30 * 86_400_000);
 const [c, i] = await Promise.allSettled([
 api.get('/admin/health/crashes', { params: { days } }),
 api.get('/admin/image-processing/stats', { params: { from: from.toISOString(), to: to.toISOString() } }),
 ]);
 if (c.status === 'fulfilled') setCrashes(c.value.data.data);
 else setError(apiMessage(c.reason, 'No se pudieron cargar los crashes.'));
 if (i.status === 'fulfilled') setImages(i.value.data.data);
 else setImageError(apiMessage(i.reason, 'No se pudo cargar el consumo del recorte de imágenes.'));
 setLoading(false);
 }, [days]);

 useEffect(() => { load(); }, [load]);

 // Resolver marca el MENSAJE en todas las versiones vistas hasta hoy.
 const toggleResolved = async (g: CrashGroup) => {
 const reopen = g.status === 'resolved';
 setActing(g.message);
 setActionError('');
 try {
 await api.post(`/admin/health/crashes/${reopen ? 'reopen' : 'resolve'}`, { message: g.message });
 await load();
 } catch (err) {
 setActionError(apiMessage(err, reopen ? 'No se pudo reabrir.' : 'No se pudo marcar como resuelto.'));
 } finally {
 setActing(null);
 }
 };

 const resolvedCount = crashes?.groups.filter((g) => g.status === 'resolved').length ?? 0;
 const visibleGroups = crashes?.groups.filter((g) => showResolved || g.status !== 'resolved') ?? [];

 return (
 <div className="space-y-6 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Salud de la app</h1>
 <p className="page-subtitle">Lo que reventó en los teléfonos y lo que cuesta el recorte de fondo.</p>
 </div>
 <button
 onClick={load}
 className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 py-2 text-xs font-semibold text-[var(--color-text-main)]"
 >
 <RotateCw className="h-4 w-4 text-[var(--color-primary)]" /> Actualizar
 </button>
 </div>

 {/* ── Crashes ── */}
 <section className="space-y-3">
 <div className="flex flex-wrap items-center gap-4 border-b border-[var(--color-border-light)] pb-2">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Crashes</h2>
 <div className="ml-auto flex gap-4">
 {DAY_OPTIONS.map((d) => (
 <button
 key={d}
 onClick={() => setDays(d)}
 className={`cursor-pointer text-xs font-bold ${days === d ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-main)]'}`}
 >
 {d === 1 ? '24 h' : `${d} días`}
 </button>
 ))}
 </div>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}

 {loading && !crashes ? (
 <p className="py-6 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : crashes && (
 <>
 <div className="flex flex-wrap gap-x-8 gap-y-3">
 {[
 ['Reportes', crashes.totals.total],
 ['Fatales (pantalla en blanco)', crashes.totals.fatal],
 ['Personas afectadas', crashes.totals.usersAffected],
 ].map(([label, value]) => (
 <div key={label as string}>
 <p className="text-2xl font-bold text-[var(--color-text-main)]">{value}</p>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{label}</p>
 </div>
 ))}
 </div>

 {crashes.byVersion.length > 0 && (
 <p className="text-xs text-[var(--color-text-main)]">
 Por versión: {crashes.byVersion.map((v) => `${v.appVersion} (${v.total}${v.fatal ? `, ${v.fatal} fatales` : ''})`).join(' · ')}
 </p>
 )}

 {resolvedCount > 0 && (
 <button
 onClick={() => setShowResolved((v) => !v)}
 className="cursor-pointer text-xs font-bold text-[var(--color-primary)]"
 >
 {showResolved ? 'Ocultar resueltos' : `Mostrar ${resolvedCount} ${resolvedCount === 1 ? 'resuelto' : 'resueltos'}`}
 </button>
 )}

 {actionError && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {actionError}
 </p>
 )}

 {visibleGroups.length === 0 ? (
 <p className="py-6 text-center text-xs font-semibold text-[var(--color-text-main)]">
 {crashes.groups.length === 0 ? 'Ningún crash reportado en este periodo.' : 'Todo lo reportado en este periodo está marcado como resuelto.'}
 </p>
 ) : (
 <ul>
 {visibleGroups.map((g) => {
 const key = `${g.appVersion}|${g.message}`;
 return (
 <li key={key} className={`border-b border-[var(--color-border-light)] py-3 ${g.status === 'resolved' ? 'opacity-60' : ''}`}>
 <div className="flex flex-wrap items-baseline gap-x-4">
 <p className="min-w-0 flex-1 break-words font-semibold text-[var(--color-text-main)]">{g.message}</p>
 {g.status === 'regression' && (
 <p className="text-xs font-bold text-[var(--color-danger)]">Regresión: volvió en una versión nueva</p>
 )}
 {g.status === 'resolved' && (
 <p className="text-xs font-bold text-[var(--color-text-main)]">Resuelto</p>
 )}
 <p className="text-xs font-bold text-[var(--color-text-main)]">{g.count}×</p>
 {g.fatal > 0 && <p className="text-xs font-bold text-[var(--color-danger)]">{g.fatal} fatales</p>}
 <PermissionGate permission={Permission.SETTINGS_UPDATE}>
 <button
 onClick={() => toggleResolved(g)}
 disabled={acting === g.message}
 className="cursor-pointer text-[11px] font-bold text-[var(--color-primary)] disabled:opacity-50"
 >
 {g.status === 'resolved' ? 'Reabrir' : 'Marcar resuelto'}
 </button>
 </PermissionGate>
 </div>
 <p className="text-xs text-[var(--color-text-main)]">
 v{g.appVersion} · {g.platforms.join(', ')} · {g.usersAffected} {g.usersAffected === 1 ? 'persona' : 'personas'}
 {g.scope && ` · ${g.scope}`} · del {when(g.firstAt)} al {when(g.lastAt)}
 {g.sampleOrderId && (
 <> · pedido …{g.sampleOrderId.slice(-6)}</>
 )}
 </p>
 {g.stack && (
 <>
 <button
 onClick={() => setOpenStack(openStack === key ? null : key)}
 className="mt-1 cursor-pointer text-[11px] font-bold text-[var(--color-primary)]"
 >
 {openStack === key ? 'Ocultar traza' : 'Ver traza'}
 </button>
 {openStack === key && (
 <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-l border-[var(--color-border)] pl-3 text-[11px] text-[var(--color-text-main)]">
 {g.stack}
 </pre>
 )}
 </>
 )}
 </li>
 );
 })}
 </ul>
 )}
 <p className="text-[11px] text-[var(--color-text-main)]">
 Los reportes se borran solos a los 30 días. Nunca aparecen nombres ni dispositivos, solo cuántas personas.
 Marcar resuelto cubre las versiones donde ya se vio ese error; si aparece en una versión nueva, vuelve como regresión.
 </p>
 </>
 )}
 </section>

 {/* ── Recorte de fondo ── */}
 <section className="space-y-3">
 <div className="border-b border-[var(--color-border-light)] pb-2">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Recorte de fondo de imágenes · últimos 30 días</h2>
 </div>
 {imageError && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {imageError}
 </p>
 )}
 {images && (
 <>
 <div className="flex flex-wrap gap-x-8 gap-y-3">
 {[
 ['A cuadrar con la factura', images.totals.billable],
 ['Terminados', images.totals.completed],
 ['Fallidos', images.totals.failed],
 ['Por límite', images.totals.limited],
 ['Tiempo medio', images.durationMs.average != null ? `${(images.durationMs.average / 1000).toFixed(1)} s` : '–'],
 ['p95', images.durationMs.p95 != null ? `${(images.durationMs.p95 / 1000).toFixed(1)} s` : '–'],
 ].map(([label, value]) => (
 <div key={label as string}>
 <p className="text-2xl font-bold text-[var(--color-text-main)]">{value}</p>
 <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{label}</p>
 </div>
 ))}
 </div>
 <p className="text-[11px] text-[var(--color-text-main)]">
 “A cuadrar con la factura” cuenta cada recorte que se pagó: terminado, descartado o inválido. Es la cifra que hay que comparar con el cobro del proveedor.
 </p>

 {images.byProvider.length > 0 && (
 <ul>
 {images.byProvider.map((p) => (
 <li key={p.provider} className="flex items-center gap-4 border-b border-[var(--color-border-light)] py-2 text-xs">
 <span className="flex-1 font-semibold text-[var(--color-text-main)]">{p.provider}</span>
 <span className="text-[var(--color-text-main)]">{p.completed} terminados · {p.failed} fallidos</span>
 <span className="w-24 text-right font-bold text-[var(--color-text-main)]">{p.billable} facturables</span>
 </li>
 ))}
 </ul>
 )}

 {images.topBusinesses.length > 0 && (
 <div>
 <h3 className="mb-1 text-xs font-bold text-[var(--color-text-main)]">Comercios que más consumen</h3>
 <ul>
 {images.topBusinesses.map((b) => (
 <li key={b.businessId} className="flex items-center gap-4 border-b border-[var(--color-border-light)] py-2 text-xs">
 <span className="flex-1 font-semibold text-[var(--color-text-main)]">{b.name ?? 'Comercio eliminado'}</span>
 <span className="text-[var(--color-text-main)]">{b.completed} terminados · {b.failed} fallidos</span>
 <span className="w-24 text-right font-bold text-[var(--color-text-main)]">{b.billable} facturables</span>
 </li>
 ))}
 </ul>
 </div>
 )}
 </>
 )}
 </section>
 </div>
 );
}
