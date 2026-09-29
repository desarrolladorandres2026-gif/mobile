import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import { fetchBusinessOptions } from '../lib/businessOptions';
import { apiMessage } from '../lib/apiError';

/**
 * Qué busca la gente en la app y, sobre todo, qué busca sin encontrarlo.
 *
 * La segunda tabla es la que justifica esta pantalla: cada término sin
 * resultados es alguien que quiso comprar algo que Zipp no tiene. Es la
 * lista priorizada de qué comercios salir a captar, y nadie más la tiene —
 * el cliente que no encuentra nada se va sin decírselo a nadie.
 *
 * Cada término sin resultado se puede resolver con una regla: sinónimo
 * (busca otro término), redirección (lleva a una categoría o negocio) o
 * atendido (sale de la lista).
 */

interface TermRow {
 term: string;
 count: number;
}

type RuleKind = 'synonym' | 'redirect' | 'handled';

interface RuleView {
 kind: RuleKind;
 synonymOf: string | null;
 redirect: { kind: 'category' | 'business'; category?: string; businessId?: string; label?: string } | null;
}

interface EmptyRow extends TermRow {
 key: string;
 lastAt: string;
 rule: RuleView | null;
}

interface RuleRow {
 _id: string;
 termRaw: string;
 kind: RuleKind;
 synonymOf: string | null;
 redirect: { kind: 'category' | 'business'; category?: string; businessId?: { name?: string } | string } | null;
 note?: string;
}

interface Insights {
 top: TermRow[];
 empty: EmptyRow[];
 days: number;
}

const CATEGORY_LABEL: Record<string, string> = {
 restaurant: 'Restaurantes',
 fast_food: 'Comidas rápidas',
 pharmacy: 'Droguerías',
 cafe: 'Cafeterías',
 supermarket: 'Mercados',
};

const KIND_LABEL: Record<RuleKind, string> = {
 synonym: 'Sinónimo',
 redirect: 'Redirección',
 handled: 'Atendido',
};

function describeRule(rule: RuleView): string {
 if (rule.kind === 'synonym') return `busca"${rule.synonymOf}"`;
 if (rule.kind === 'redirect' && rule.redirect) {
 return rule.redirect.kind === 'category'
 ? `lleva a ${CATEGORY_LABEL[rule.redirect.category ?? ''] ?? rule.redirect.category}`
 : `abre ${rule.redirect.label ?? 'un negocio'}`;
 }
 return '';
}

function formatDate(iso: string): string {
 return new Date(iso).toLocaleDateString('es-CO', {
 day: 'numeric',
 month: 'short',
 hour: '2-digit',
 minute: '2-digit',
 });
}

const fieldClass = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-main)]';

const EMPTY_FORM = {
 kind: 'synonym' as RuleKind,
 synonymOf: '',
 redirectKind: 'category' as 'category' | 'business',
 category: 'restaurant',
 businessId: '',
 note: '',
};

export default function SearchInsights() {
 const queryClient = useQueryClient();
 const [data, setData] = useState<Insights | null>(null);
 const [rules, setRules] = useState<RuleRow[]>([]);
 const [businesses, setBusinesses] = useState<{ _id: string; name: string }[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [acting, setActing] = useState<EmptyRow | null>(null);
 const [form, setForm] = useState(EMPTY_FORM);
 const [saving, setSaving] = useState(false);
 const [actionError, setActionError] = useState('');

 const fetchAll = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const [{ data: body }, rulesRes] = await Promise.all([
 api.get('/search/insights'),
 api.get('/search/rules'),
 ]);
 setData(body.data);
 setRules(rulesRes.data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar las búsquedas.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 fetchAll();
 fetchBusinessOptions(queryClient)
 .then(({ data: body }) => setBusinesses(body.data ?? []))
 .catch(() => setBusinesses([]));
 }, [fetchAll, queryClient]);

 const openAction = (row: EmptyRow) => {
 setActing(row);
 setActionError('');
 setForm(EMPTY_FORM);
 };

 const saveRule = async () => {
 if (!acting) return;
 setSaving(true);
 setActionError('');
 try {
 await api.put('/search/rules', {
 term: acting.term,
 kind: form.kind,
 ...(form.kind === 'synonym' ? { synonymOf: form.synonymOf } : {}),
 ...(form.kind === 'redirect'
 ? {
 redirect:
 form.redirectKind === 'category'
 ? { kind: 'category', category: form.category }
 : { kind: 'business', businessId: form.businessId },
 }
 : {}),
 ...(form.note.trim() ? { note: form.note.trim() } : {}),
 });
 setActing(null);
 await fetchAll();
 } catch (err) {
 setActionError(apiMessage(err, 'No se pudo guardar la regla.'));
 } finally {
 setSaving(false);
 }
 };

 const removeRule = async (id: string) => {
 try {
 await api.delete(`/search/rules/${id}`);
 await fetchAll();
 } catch (err) {
 setError(apiMessage(err, 'No se pudo quitar la regla.'));
 }
 };

 const days = data?.days ?? 30;
 const saveDisabled =
 saving ||
 (form.kind === 'synonym' && form.synonymOf.trim().length < 2) ||
 (form.kind === 'redirect' && form.redirectKind === 'business' && !form.businessId);

 return (
 <div className="space-y-3">
 <div className="flex items-center justify-between">
 <div>
 <h1 className="text-lg font-bold text-[var(--color-text-main)] flex items-center gap-2">
 Búsquedas
 </h1>
 <p className="mt-1 text-xs font-medium text-[var(--color-text-main)]">
 Lo que la gente escribió en la app durante los últimos {days} días.
 </p>
 </div>
 <button
 onClick={fetchAll}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center gap-2"
 >
 Actualizar
 </button>
 </div>

 {error ? (
 <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
 {error}
 </div>
 ) : null}

 {loading && !data ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando búsquedas…
 </div>
 ) : (
 <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
 {/* ── Lo que sí se encuentra ── */}
 <section className="space-y-3">
 <header className="flex items-center gap-2">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Lo más buscado</h2>
 </header>
 <p className="text-[11px] font-medium text-[var(--color-text-main)]">
 Alimenta las sugerencias de la pantalla de búsqueda en la app.
 </p>

 <div className="table-container overflow-x-auto">
 <table className="data-grid min-w-[380px]">
 <thead>
 <tr className="border-b border-[var(--color-border-light)]">
 <th className="table-header-cell">Término</th>
 <th className="table-header-cell text-right">Búsquedas</th>
 </tr>
 </thead>
 <tbody>
 {data?.top.length ? (
 data.top.map((row) => (
 <tr
 key={row.term}
 className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-bg)] transition-colors"
 >
 <td className="px-4 py-3 text-xs font-semibold text-[var(--color-text-main)]">{row.term}</td>
 <td className="px-4 py-3 text-xs font-bold text-right text-[var(--color-text-main)]">{row.count}</td>
 </tr>
 ))
 ) : (
 <tr>
 <td colSpan={2} className="px-4 py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">
 Todavía no hay búsquedas registradas.
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </section>

 {/* ── Lo que falta en el catálogo ── */}
 <section className="space-y-3">
 <header className="flex items-center gap-2">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Buscado y no encontrado</h2>
 </header>
 <p className="text-[11px] font-medium text-[var(--color-text-main)]">
 Cada línea es una venta que se perdió. Ordenado por cuánta gente lo pidió: es la lista de qué comercios o
 productos hacen falta. Lo que ya está marcado como atendido no aparece.
 </p>

 <div className="table-container overflow-x-auto">
 <table className="data-grid min-w-[480px]">
 <thead>
 <tr className="border-b border-[var(--color-border-light)]">
 <th className="table-header-cell">Término</th>
 <th className="table-header-cell text-right">Veces</th>
 <th className="table-header-cell text-right">Última vez</th>
 <th className="table-header-cell text-right">Acción</th>
 </tr>
 </thead>
 <tbody>
 {data?.empty.length ? (
 data.empty.map((row) => (
 <tr
 key={row.key}
 className="border-b border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-bg)] transition-colors"
 >
 <td className="px-4 py-3 text-xs font-semibold text-[var(--color-text-main)]">
 {row.term}
 {row.rule && (
 <span className="block text-[11px] font-medium text-[var(--color-text-main)]">
 {KIND_LABEL[row.rule.kind]} · {describeRule(row.rule)}
 </span>
 )}
 </td>
 <td className="px-4 py-3 text-xs font-bold text-right text-[var(--color-danger)]">{row.count}</td>
 <td className="px-4 py-3 text-[11px] font-medium text-right text-[var(--color-text-main)] whitespace-nowrap">
 {formatDate(row.lastAt)}
 </td>
 <td className="px-4 py-3 text-right">
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={() => openAction(row)}
 className="cursor-pointer text-[11px] font-bold text-[var(--color-primary)]"
 >
 {row.rule ? 'Cambiar' : 'Resolver'}
 </button>
 </PermissionGate>
 </td>
 </tr>
 ))
 ) : (
 <tr>
 <td colSpan={4} className="px-4 py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">
 Nadie se ha ido con las manos vacías. Por ahora.
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </section>

 {acting && (
 <section className="xl:col-span-2 space-y-3 border-y border-[var(--color-border-light)] py-4">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Resolver “{acting.term}”</h2>
 <div className="flex flex-wrap items-center gap-3">
 <select
 value={form.kind}
 onChange={(e) => setForm({ ...form, kind: e.target.value as RuleKind })}
 className={fieldClass}
 >
 <option value="synonym">Es lo mismo que otro término</option>
 <option value="redirect">Llevar a una categoría o negocio</option>
 <option value="handled">Marcar como atendido</option>
 </select>
 {form.kind === 'synonym' && (
 <input
 value={form.synonymOf}
 onChange={(e) => setForm({ ...form, synonymOf: e.target.value })}
 placeholder="Término que sí existe (ej. pechuga apanada)"
 maxLength={100}
 className={`${fieldClass} min-w-[260px]`}
 />
 )}
 {form.kind === 'redirect' && (
 <>
 <select
 value={form.redirectKind}
 onChange={(e) => setForm({ ...form, redirectKind: e.target.value as 'category' | 'business' })}
 className={fieldClass}
 >
 <option value="category">Categoría</option>
 <option value="business">Negocio</option>
 </select>
 {form.redirectKind === 'category' ? (
 <select
 value={form.category}
 onChange={(e) => setForm({ ...form, category: e.target.value })}
 className={fieldClass}
 >
 {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
 <option key={k} value={k}>{v}</option>
 ))}
 </select>
 ) : (
 <select
 value={form.businessId}
 onChange={(e) => setForm({ ...form, businessId: e.target.value })}
 className={fieldClass}
 >
 <option value="">Elige un negocio</option>
 {businesses.map((b) => (
 <option key={b._id} value={b._id}>{b.name}</option>
 ))}
 </select>
 )}
 </>
 )}
 <input
 value={form.note}
 onChange={(e) => setForm({ ...form, note: e.target.value })}
 placeholder="Nota (opcional)"
 maxLength={200}
 className={`${fieldClass} min-w-[200px] flex-1`}
 />
 </div>
 <p className="text-[11px] font-medium text-[var(--color-text-main)]">
 {form.kind === 'synonym' &&
 'Solo se usa cuando la búsqueda literal no encuentra nada; nunca pisa un resultado. El destino debe devolver resultados.'}
 {form.kind === 'redirect' && 'La app ofrece ir al destino cuando la búsqueda sigue vacía.'}
 {form.kind === 'handled' && 'Sale de esta lista. Vuelve a aparecer si quitas la regla.'}
 </p>
 {actionError && <p className="text-xs font-semibold text-[var(--color-danger)]">{actionError}</p>}
 <div className="flex gap-3">
 <button
 onClick={saveRule}
 disabled={saveDisabled}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
 >
 Guardar
 </button>
 <button
 onClick={() => setActing(null)}
 className="cursor-pointer text-xs font-semibold text-[var(--color-text-main)]"
 >
 Cancelar
 </button>
 </div>
 </section>
 )}

 {rules.length > 0 && (
 <section className="xl:col-span-2 space-y-2">
 <h2 className="text-sm font-bold text-[var(--color-text-main)]">Reglas activas</h2>
 <ul>
 {rules.map((r) => (
 <li
 key={r._id}
 className="flex flex-wrap items-center gap-x-4 border-b border-[var(--color-border-light)] py-2 text-xs"
 >
 <span className="font-semibold text-[var(--color-text-main)]">{r.termRaw}</span>
 <span className="text-[var(--color-text-main)]">
 {KIND_LABEL[r.kind]}
 {r.kind === 'synonym' && ` · busca"${r.synonymOf}"`}
 {r.kind === 'redirect' &&
 r.redirect &&
 (r.redirect.kind === 'category'
 ? ` · ${CATEGORY_LABEL[r.redirect.category ?? ''] ?? r.redirect.category}`
 : ` · ${typeof r.redirect.businessId === 'object' ? r.redirect.businessId?.name ?? 'negocio' : 'negocio'}`)}
 </span>
 {r.note && <span className="flex-1 text-[var(--color-text-main)]">{r.note}</span>}
 <PermissionGate permission={Permission.CONTENT_MANAGE}>
 <button
 onClick={() => removeRule(r._id)}
 aria-label={`Quitar regla de ${r.termRaw}`}
 className="ml-auto cursor-pointer text-[var(--color-text-main)]"
 >
 <Trash2 className="h-4 w-4" />
 </button>
 </PermissionGate>
 </li>
 ))}
 </ul>
 </section>
 )}
 </div>
 )}
 </div>
 );
}
