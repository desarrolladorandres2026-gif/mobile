import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import type { VersionRow } from './types';

/**
 * El historial de publicaciones: fecha, quién y qué dijo al publicar.
 *
 * Es una hoja flotante (una de las superficies que sí llevan fondo). Nada
 * de lo publicado se borra ni se reescribe: restaurar trae una versión al
 * borrador, o la republica como una versión nueva.
 */
export function VersionHistory({ onClose, onRestore, canManage }: {
 onClose: () => void;
 onRestore: (version: number, mode: 'draft' | 'publish') => void;
 canManage: boolean;
}) {
 const [rows, setRows] = useState<VersionRow[] | null>(null);
 const [current, setCurrent] = useState(0);
 const [error, setError] = useState('');

 useEffect(() => {
 api.get('/explore-layout/versions')
 .then(({ data }) => {
 setRows(data.data.versions);
 setCurrent(data.data.currentVersion);
 })
 .catch((err) => setError(apiMessage(err, 'No se pudo cargar el historial.')));
 }, []);

 return (
 <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-xs flex justify-end animate-fade-in" onClick={onClose}>
 <aside
 className="zipp-modal h-full w-full max-w-md p-6 overflow-y-auto space-y-5"
 onClick={(e) => e.stopPropagation()}
 aria-label="Historial de publicaciones"
 >
 <div className="flex items-center justify-between pb-4 border-b border-[var(--color-border-light)]">
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Historial de publicaciones</h3>
 <button onClick={onClose} className="p-1 text-[var(--color-text-main)] hover:text-[var(--color-text-main)] cursor-pointer" aria-label="Cerrar">
 <X className="w-5 h-5" />
 </button>
 </div>

 {error ? <p className="text-xs text-[var(--color-danger)]">{error}</p> : null}
 {!rows && !error ? (
 <p className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Cargando…
 </p>
 ) : null}
 {rows && rows.length === 0 ? (
 <p className="text-xs text-[var(--color-text-main)]">
 Todavía no se ha publicado nada: la app muestra el Explorar de siempre.
 </p>
 ) : null}

 <ol className="divide-y divide-[var(--color-border-light)]">
 {rows?.map((row) => (
 <li key={row._id} className="py-4 space-y-1.5">
 <div className="flex items-baseline gap-2">
 <span className="font-mono text-sm font-bold text-[var(--color-text-main)]">v{row.version}</span>
 {row.version === current ? (
 <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">En la app</span>
 ) : null}
 <span className="ml-auto text-[11px] text-[var(--color-text-main)]">
 {new Date(row.publishedAt).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}
 </span>
 </div>
 <p className="text-xs text-[var(--color-text-main)]">
 {row.publishedBy?.name ?? row.publishedBy?.email ?? 'Migración'}
 {row.restoredFrom ? ` · restauró la v${row.restoredFrom}` : ''}
 </p>
 {row.note ? <p className="text-xs text-[var(--color-text-main)]">{row.note}</p> : null}
 {canManage ? (
 <div className="flex gap-4 pt-1">
 <button type="button" onClick={() => onRestore(row.version, 'draft')}
 className="text-xs font-semibold text-[var(--color-text-main)] cursor-pointer">
 Traer al borrador
 </button>
 {row.version !== current ? (
 <button type="button" onClick={() => onRestore(row.version, 'publish')}
 className="text-xs font-semibold text-[var(--color-text-main)] hover:text-[var(--color-text-main)] cursor-pointer">
 Republicar tal cual
 </button>
 ) : null}
 </div>
 ) : null}
 </li>
 ))}
 </ol>
 </aside>
 </div>
 );
}
