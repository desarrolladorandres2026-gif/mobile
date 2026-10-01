import { Fragment, useCallback, useEffect, useState } from 'react';
import { useLiveReload } from '../hooks/useLiveReload';
import { AlertCircle } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { PermissionGate } from '../components/PermissionGate';
import { Permission } from '../lib/permissions';
import SummaryGrid from '../components/SummaryGrid';

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

 useLiveReload(['orders', 'drivers', 'businesses'], load);
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
 className={`cursor-pointer text-xs font-bold ${days === d ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-main)]'}`}
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
 <SummaryGrid
 items={[
 { label: 'Reportes', value: crashes.totals.total },
 { label: 'Fatales (pantalla en blanco)', value: crashes.totals.fatal },
 { label: 'Personas afectadas', value: crashes.totals.usersAffected },
 ]}
 />

 {crashes.byVersion.length > 0 && (
 <p className="text-xs text-[var(--color-text-main)]">
 Por versión: {crashes.byVersion.map((v) => `${v.appVersion} (${v.total}${v.fatal ? `, ${v.fatal} fatales` : ''})`).join(' · ')}
 </p>
 )}

 {resolvedCount > 0 && (
 <button
 onClick={() => setShowResolved((v) => !v)}
 className="cursor-pointer text-xs font-bold text-[var(--color-text-main)]"
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
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Error</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Veces</th>
 <th className="table-header-cell">Fatales</th>
 <th className="table-header-cell">Versión</th>
 <th className="table-header-cell">Plataformas</th>
 <th className="table-header-cell">Personas</th>
 <th className="table-header-cell">Primera vez</th>
 <th className="table-header-cell">Última vez</th>
 <th className="table-header-cell">Pedido</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {visibleGroups.map((g) => {
 const key = `${g.appVersion}|${g.message}`;
 return (
 <Fragment key={key}>
 <tr className={g.status === 'resolved' ? 'opacity-60' : ''}>
 <td className="table-body-cell wrap text-[var(--color-text-main)]">
 <span className="break-words">{g.message}</span>
 {g.scope && <span> · {g.scope}</span>}
 {g.stack && (
 <button
 onClick={() => setOpenStack(openStack === key ? null : key)}
 className="ml-2 cursor-pointer text-[var(--color-text-main)]"
 >
 {openStack === key ? 'Ocultar traza' : 'Ver traza'}
 </button>
 )}
 </td>
 <td className={`table-body-cell ${g.status === 'regression' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {g.status === 'regression' ? 'Regresión' : g.status === 'resolved' ? 'Resuelto' : 'Abierto'}
 </td>
 <td className="table-body-cell text-[var(--color-text-main)]">{g.count}</td>
 <td className={`table-body-cell ${g.fatal > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>{g.fatal}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">v{g.appVersion}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{g.platforms.join(', ')}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{g.usersAffected}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{when(g.firstAt)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{when(g.lastAt)}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{g.sampleOrderId ? `…${g.sampleOrderId.slice(-6)}` : '—'}</td>
 <td className="table-body-cell">
 <PermissionGate permission={Permission.SETTINGS_UPDATE}>
 <button
 onClick={() => toggleResolved(g)}
 disabled={acting === g.message}
 className="cursor-pointer text-[var(--color-text-main)] disabled:opacity-50"
 >
 {g.status === 'resolved' ? 'Reabrir' : 'Marcar resuelto'}
 </button>
 </PermissionGate>
 </td>
 </tr>
 {g.stack && openStack === key && (
 <tr>
 <td colSpan={11} className="table-body-cell wrap">
 <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-main)]">{g.stack}</pre>
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
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
 <SummaryGrid
 items={[
 { label: 'A cuadrar con la factura', value: images.totals.billable },
 { label: 'Terminados', value: images.totals.completed },
 { label: 'Fallidos', value: images.totals.failed },
 { label: 'Por límite', value: images.totals.limited },
 { label: 'Tiempo medio', value: images.durationMs.average != null ? `${(images.durationMs.average / 1000).toFixed(1)} s` : '–' },
 { label: 'p95', value: images.durationMs.p95 != null ? `${(images.durationMs.p95 / 1000).toFixed(1)} s` : '–' },
 ]}
 />
 <p className="text-[11px] text-[var(--color-text-main)]">
 “A cuadrar con la factura” cuenta cada recorte que se pagó: terminado, descartado o inválido. Es la cifra que hay que comparar con el cobro del proveedor.
 </p>

 {images.byProvider.length > 0 && (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Proveedor</th>
 <th className="table-header-cell">Terminados</th>
 <th className="table-header-cell">Fallidos</th>
 <th className="table-header-cell">Facturables</th>
 </tr>
 </thead>
 <tbody>
 {images.byProvider.map((p) => (
 <tr key={p.provider}>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.provider}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.completed}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.failed}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{p.billable}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {images.topBusinesses.length > 0 && (
 <div>
 <h3 className="mb-1 text-xs font-bold text-[var(--color-text-main)]">Comercios que más consumen</h3>
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Comercio</th>
 <th className="table-header-cell">Terminados</th>
 <th className="table-header-cell">Fallidos</th>
 <th className="table-header-cell">Facturables</th>
 </tr>
 </thead>
 <tbody>
 {images.topBusinesses.map((b) => (
 <tr key={b.businessId}>
 <td className="table-body-cell text-[var(--color-text-main)]">{b.name ?? 'Comercio eliminado'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{b.completed}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{b.failed}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{b.billable}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 )}
 </>
 )}
 </section>
 </div>
 );
}
