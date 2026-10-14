import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

/**
 * Artículos del Centro de ayuda del panel de comercios.
 *
 * Lo que se escribe aquí lo leen los comercios tal cual: solo debe decir lo que
 * ZIPP hace de verdad. Una categoría sin artículos aparece en su panel como
 * "pendiente de configuración", que es mejor que una respuesta inventada.
 * El texto es plano; no admite HTML.
 */

type Category = 'orders' | 'products' | 'drivers' | 'payments' | 'commissions' | 'promotions' | 'cancellations' | 'refunds' | 'account';

interface Article {
 _id: string;
 category: Category;
 question: string;
 answer: string;
 sortOrder: number;
 isPublished: boolean;
}

const CATEGORY_LABEL: Record<Category, string> = {
 orders: 'Pedidos',
 products: 'Productos e inventario',
 drivers: 'Domiciliarios',
 payments: 'Pagos y liquidaciones',
 commissions: 'Comisiones',
 promotions: 'Promociones',
 cancellations: 'Cancelaciones',
 refunds: 'Reembolsos',
 account: 'Administración de la cuenta',
};

const EMPTY = { category: 'orders' as Category, question: '', answer: '', sortOrder: 0, isPublished: true };

export default function HelpArticles() {
 const [articles, setArticles] = useState<Article[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [editing, setEditing] = useState<string | 'new' | null>(null);
 const [form, setForm] = useState(EMPTY);
 const [toDelete, setToDelete] = useState<Article | null>(null);

 const load = useCallback(async () => {
 try {
 setLoading(true);
 setError('');
 const { data } = await api.get('/help-articles/manage');
 setArticles(data.data ?? []);
 } catch (err) {
 setError(apiMessage(err, 'No se pudieron cargar los artículos de ayuda.'));
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { load(); }, [load]);

 const run = async (action: () => Promise<unknown>, fallback: string) => {
 try {
 setError('');
 await action();
 await load();
 } catch (err) {
 setError(apiMessage(err, fallback));
 }
 };

 const startEdit = (article?: Article) => {
 setEditing(article ? article._id : 'new');
 setForm(article
 ? { category: article.category, question: article.question, answer: article.answer, sortOrder: article.sortOrder, isPublished: article.isPublished }
 : EMPTY);
 };

 const save = () =>
 run(async () => {
 if (editing === 'new') await api.post('/help-articles', form);
 else await api.patch(`/help-articles/${editing}`, form);
 setEditing(null);
 }, 'No se pudo guardar el artículo.');

 const fieldClass = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]';

 return (
 <div className="space-y-4 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Centro de ayuda</h1>
 <p className="page-subtitle">
 Preguntas frecuentes del panel de comercios. Publica solo lo que ZIPP hace de verdad: las categorías sin artículos se muestran como pendientes.
 </p>
 </div>
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <button
 onClick={() => startEdit()}
 className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-bold text-white"
 >
 <Plus className="h-4 w-4" /> Nuevo artículo
 </button>
 </PermissionGate>
 </div>

 {error && (
 <p className="flex items-center gap-2 text-xs font-semibold text-[var(--color-danger)]">
 <AlertCircle className="h-4 w-4" /> {error}
 </p>
 )}

 {editing && (
 <div className="space-y-3 border-y border-[var(--color-border-light)] py-4">
 <div className="flex flex-wrap gap-3">
 <select
 value={form.category}
 onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
 aria-label="Categoría"
 className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-main)]"
 >
 {Object.entries(CATEGORY_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
 </select>
 <label className="flex items-center gap-2 text-xs text-[var(--color-text-main)]">
 Orden
 <input
 type="number"
 min={0}
 max={9999}
 value={form.sortOrder}
 onChange={(e) => setForm({ ...form, sortOrder: Math.max(0, Math.min(9999, Math.trunc(Number(e.target.value) || 0))) })}
 className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm text-[var(--color-text-main)]"
 />
 </label>
 <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-main)]">
 <input
 type="checkbox"
 checked={form.isPublished}
 onChange={(e) => setForm({ ...form, isPublished: e.target.checked })}
 className="cursor-pointer accent-[var(--color-primary)]"
 />
 Publicado
 </label>
 </div>
 <input
 value={form.question}
 onChange={(e) => setForm({ ...form, question: e.target.value })}
 placeholder="Pregunta (mínimo 5 caracteres)"
 maxLength={200}
 className={fieldClass}
 />
 <textarea
 value={form.answer}
 onChange={(e) => setForm({ ...form, answer: e.target.value })}
 rows={6}
 maxLength={4000}
 placeholder="Respuesta (mínimo 10 caracteres). Texto plano."
 className={fieldClass}
 />
 <div className="flex justify-end gap-2">
 <button
 onClick={() => setEditing(null)}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-main)]"
 >
 Cancelar
 </button>
 <button
 onClick={save}
 className="cursor-pointer rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-bold text-white"
 >
 Guardar
 </button>
 </div>
 </div>
 )}

 {loading ? (
 <p className="py-10 text-center text-xs font-semibold text-[var(--color-text-main)]">Cargando…</p>
 ) : (
 <div className="space-y-5">
 {(Object.keys(CATEGORY_LABEL) as Category[]).map((category) => {
 const items = articles.filter((a) => a.category === category);
 return (
 <section key={category}>
 <h2 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-main)]">{CATEGORY_LABEL[category]}</h2>
 {items.length === 0 ? (
 <p className="py-2 text-xs text-[var(--color-text-main)] opacity-70">Pendiente de configuración: sin artículos.</p>
 ) : (
 <ul>
 {items.map((article) => (
 <li key={article._id} className="flex flex-wrap items-start gap-3 border-b border-[var(--color-border-light)] py-3">
 <div className={`min-w-0 flex-1 ${article.isPublished ? '' : 'opacity-50'}`}>
 <p className="font-bold text-[var(--color-text-main)]">
 {article.question}
 {!article.isPublished && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-text-main)]">sin publicar</span>}
 </p>
 <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-main)]">{article.answer}</p>
 </div>
 <PermissionGate permission={Permission.SUPPORT_MANAGE}>
 <div className="flex gap-1.5">
 <button
 onClick={() => startEdit(article)}
 title="Editar"
 className="cursor-pointer rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-text-main)]"
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 <button
 onClick={() => run(() => api.patch(`/help-articles/${article._id}`, { isPublished: !article.isPublished }), 'No se pudo cambiar el estado.')}
 title={article.isPublished ? 'Quitar de publicados' : 'Publicar'}
 className="cursor-pointer rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-text-main)]"
 >
 {article.isPublished ? <Archive className="h-3.5 w-3.5" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
 </button>
 <button
 onClick={() => setToDelete(article)}
 title="Eliminar"
 className="cursor-pointer rounded-lg border border-[var(--color-danger)] p-2 text-[var(--color-danger)]"
 >
 <Trash2 className="h-3.5 w-3.5" />
 </button>
 </div>
 </PermissionGate>
 </li>
 ))}
 </ul>
 )}
 </section>
 );
 })}
 </div>
 )}

 {toDelete && (
 <ConfirmDialog
 title="Eliminar artículo"
 message={`«${toDelete.question}» se elimina para siempre. Si solo quieres dejar de mostrarlo, quítalo de publicados.`}
 confirmLabel="Eliminar"
 onConfirm={() => {
 const id = toDelete._id;
 setToDelete(null);
 run(() => api.delete(`/help-articles/${id}`), 'No se pudo eliminar el artículo.');
 }}
 onCancel={() => setToDelete(null)}
 />
 )}
 </div>
 );
}
