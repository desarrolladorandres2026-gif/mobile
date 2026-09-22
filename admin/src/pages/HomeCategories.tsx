import { useEffect, useRef, useState } from 'react';
import {
  LayoutGrid, Plus, Search, X, AlertCircle, Trash2, Pencil, GripVertical,
  ToggleLeft, ToggleRight, ImagePlus,
} from 'lucide-react';
import api from '../services/api';
import { sizedImage } from '../lib/cloudinary';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import { categoryLogo } from '../components/logos';

type CategoryStatus = 'active' | 'inactive';

interface HomeCategoryItem {
  _id: string;
  key: string;
  name: string;
  imageUrl: string;
  color: string;
  status: CategoryStatus;
  order: number;
}

interface CategoryForm {
  key: string;
  name: string;
  imageUrl: string;
  color: string;
  status: CategoryStatus;
}

const emptyForm = (): CategoryForm => ({ key: '', name: '', imageUrl: '', color: '', status: 'active' });

export default function HomeCategories() {
  const [categories, setCategories] = useState<HomeCategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryForm>(emptyForm());
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<HomeCategoryItem | null>(null);

  const dragId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const fetchAll = async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get('/home-categories/admin');
      setCategories(data.data);
    } catch (err) {
      console.error(err);
      setError('No se pudieron cargar las categorías de inicio.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setShowModal(true);
  };

  const openEdit = (c: HomeCategoryItem) => {
    setEditingId(c._id);
    setForm({ key: c.key, name: c.name, imageUrl: c.imageUrl || '', color: c.color || '', status: c.status });
    setShowModal(true);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('image', file);
      const { data } = await api.post('/home-categories/upload', fd, {
        headers: { 'Content-Type': undefined },
      });
      setForm((f) => ({ ...f, imageUrl: data.data.url }));
    } catch (err) {
      setError(apiMessage(err, 'No se pudo subir la imagen.'));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.key.trim() || !form.name.trim()) {
      setError('La clave y el nombre son requeridos.');
      return;
    }
    try {
      setError('');
      if (editingId) {
        await api.put(`/home-categories/${editingId}`, {
          name: form.name,
          imageUrl: form.imageUrl,
          color: form.color,
          status: form.status,
        });
      } else {
        await api.post('/home-categories', {
          key: form.key.trim().toLowerCase(),
          name: form.name,
          imageUrl: form.imageUrl,
          color: form.color,
          status: form.status,
        });
      }
      setShowModal(false);
      fetchAll();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo guardar la categoría.'));
    }
  };

  const handleToggle = async (c: HomeCategoryItem) => {
    try {
      const { data } = await api.put(`/home-categories/${c._id}`, {
        status: c.status === 'active' ? 'inactive' : 'active',
      });
      setCategories((prev) => prev.map((x) => (x._id === c._id ? data.data : x)));
    } catch (err) {
      setError(apiMessage(err, 'No se pudo cambiar el estado de la categoría.'));
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api.delete(`/home-categories/${confirmDelete._id}`);
      setCategories((prev) => prev.filter((c) => c._id !== confirmDelete._id));
      setConfirmDelete(null);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo eliminar la categoría.'));
      setConfirmDelete(null);
    }
  };

  /**
   * Arrastrar y soltar para reordenar.
   *
   * No hay endpoint de reorden en lote para categorías (son pocas y cambian
   * poco), así que aquí se manda un PUT por cada una que cambió de
   * posición. Si algo falla se recarga desde la API.
   */
  const handleDrop = async (targetId: string) => {
    const sourceId = dragId.current;
    dragId.current = null;
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;

    const from = categories.findIndex((c) => c._id === sourceId);
    const to = categories.findIndex((c) => c._id === targetId);
    if (from < 0 || to < 0) return;

    const next = [...categories];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setCategories(next);

    try {
      await Promise.all(
        next.map((c, index) =>
          c.order === index ? null : api.put(`/home-categories/${c._id}`, { order: index })
        )
      );
      fetchAll();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo guardar el nuevo orden.'));
      fetchAll();
    }
  };

  const filtered = categories.filter((c) =>
    `${c.name} ${c.key}`.toLowerCase().includes(search.toLowerCase())
  );

  const canDrag = search === '';

  const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-muted)]';
  const labelClass = 'block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5';

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Categorías de Inicio</h1>
          <p className="page-subtitle">
            Las tarjetas de categoría que aparecen en el Home de la app
          </p>
        </div>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" />
          <span>Crear categoría</span>
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-4 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o clave..."
            className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all"
          />
        </div>
      </div>

      {error && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando categorías...
        </div>
      ) : (
        <div className="table-container overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="border-b border-[var(--color-border-light)]">
                <th className="table-header-cell w-10" />
                <th className="table-header-cell">Imagen</th>
                <th className="table-header-cell">Nombre</th>
                <th className="table-header-cell">Clave</th>
                <th className="table-header-cell">Orden</th>
                <th className="table-header-cell">Activa</th>
                <th className="table-header-cell text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const CategoryArt = categoryLogo(c.key);
                return (
                <tr
                  key={c._id}
                  draggable={canDrag}
                  onDragStart={() => { dragId.current = c._id; }}
                  onDragOver={(e) => { e.preventDefault(); setDragOverId(c._id); }}
                  onDragLeave={() => setDragOverId((id) => (id === c._id ? null : id))}
                  onDrop={() => handleDrop(c._id)}
                  className={`border-b border-[var(--color-border-light)] last:border-0 transition-colors ${
                    dragOverId === c._id ? 'bg-[var(--color-primary-bg)]' : 'hover:bg-[var(--color-bg)]'
                  }`}
                >
                  <td className="table-body-cell">
                    <GripVertical
                      className={`w-4 h-4 ${canDrag ? 'text-[var(--color-text-muted)] cursor-grab' : 'text-[var(--color-border)]'}`}
                    />
                  </td>
                  <td className="table-body-cell">
                    <div
                      className="w-10 h-10 rounded-lg overflow-hidden bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center"
                      style={c.imageUrl || !c.color ? undefined : { backgroundColor: c.color }}
                    >
                      {c.imageUrl ? (
                        <img src={sizedImage(c.imageUrl, 240)} alt={c.name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                      ) : (
                        <CategoryArt size={28} />
                      )}
                    </div>
                  </td>
                  <td className="table-body-cell">
                    <p className="text-xs font-bold text-[var(--color-text-main)]">{c.name}</p>
                  </td>
                  <td className="table-body-cell">
                    <span className="px-2 py-0.5 rounded bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-text-secondary)] font-mono text-[11px]">
                      {c.key}
                    </span>
                  </td>
                  <td className="table-body-cell">
                    <span className="px-2 py-0.5 rounded bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-primary)] font-mono font-bold text-[11px]">
                      {c.order}
                    </span>
                  </td>
                  <td className="table-body-cell">
                    <button
                      onClick={() => handleToggle(c)}
                      className="cursor-pointer hover:scale-105 transition-transform"
                      title={c.status === 'active' ? 'Desactivar categoría' : 'Activar categoría'}
                    >
                      {c.status === 'active' ? (
                        <ToggleRight className="w-8 h-8 text-[var(--color-primary)]" />
                      ) : (
                        <ToggleLeft className="w-8 h-8 text-[var(--color-text-muted)]" />
                      )}
                    </button>
                  </td>
                  <td className="table-body-cell">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEdit(c)}
                        className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
                        title="Editar categoría"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(c)}
                        className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
                        title="Eliminar categoría"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>

          {filtered.length === 0 && (
            <div className="p-12 text-center text-[var(--color-text-muted)] text-xs font-semibold">
              {categories.length === 0
                ? 'Todavía no hay categorías. Crea la primera y aparecerá en el Home de la app.'
                : 'No hay categorías que coincidan con la búsqueda.'}
            </div>
          )}

          {!canDrag && categories.length > 1 && (
            <p className="px-5 py-3 text-[11px] text-[var(--color-text-muted)] border-t border-[var(--color-border-light)]">
              Quita la búsqueda para reordenar arrastrando.
            </p>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Eliminar Categoría"
          message={`¿Eliminar "${confirmDelete.name}"? Es permanente y dejará de aparecer en el Home de inmediato.`}
          confirmLabel="Eliminar Definitivamente"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
          variant="danger"
        />
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="Zipp-modal w-full max-w-md rounded-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
              <div className="flex items-center gap-2">
                <LayoutGrid className="w-5 h-5 text-[var(--color-primary)]" />
                <h3 className="text-base font-bold text-[var(--color-text-main)]">
                  {editingId ? 'Editar Categoría' : 'Nueva Categoría de Inicio'}
                </h3>
              </div>
              <button onClick={() => setShowModal(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className={labelClass}>Imagen (opcional)</label>
                {form.imageUrl ? (
                  <div className="relative rounded-xl overflow-hidden border border-[var(--color-border)] group w-24 h-24 mx-auto">
                    <img src={form.imageUrl} alt={form.name} className="w-full h-full object-cover" />
                    <label
                      htmlFor="category-upload"
                      className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all cursor-pointer text-white text-[10px] font-bold text-center"
                    >
                      Cambiar
                    </label>
                  </div>
                ) : (
                  <label
                    htmlFor="category-upload"
                    className="flex flex-col items-center justify-center h-24 rounded-xl border-2 border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] cursor-pointer hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
                  >
                    <ImagePlus className="w-5 h-5 mb-1" />
                    <span className="text-[11px] font-semibold text-center px-2">
                      {uploading ? 'Subiendo...' : 'Sube una mini-ilustración (JPG, PNG, WEBP)'}
                    </span>
                  </label>
                )}
                <input
                  id="category-upload" type="file" accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange} className="hidden" disabled={uploading}
                />
                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)] text-center">
                  Sin imagen, la app usa un icono de respaldo local.
                </p>
              </div>

              <div>
                <label className={labelClass}>Nombre</label>
                <input type="text" required maxLength={40} value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inputClass} placeholder="Ej. Restaurantes" />
              </div>

              <div>
                <label className={labelClass}>Color de respaldo (opcional)</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={form.color || '#D69E26'}
                    onChange={(e) => setForm({ ...form, color: e.target.value })}
                    className="h-10 w-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] cursor-pointer"
                    aria-label="Color de respaldo de la categoría"
                  />
                  <input
                    type="text" maxLength={7} value={form.color}
                    onChange={(e) => setForm({ ...form, color: e.target.value })}
                    className={inputClass + ' flex-1 font-mono'}
                    placeholder="#D69E26"
                  />
                  {form.color ? (
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, color: '' })}
                      className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-danger)] border border-[var(--color-border)] cursor-pointer"
                      title="Quitar el color"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  ) : null}
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                  Solo se ve cuando no hay imagen: tiñe el cuadro detrás del icono de
                  respaldo, para que una categoría nueva no quede en gris.
                </p>
              </div>

              <div>
                <label className={labelClass}>Clave</label>
                <input type="text" required maxLength={40} value={form.key}
                  disabled={!!editingId}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  className={inputClass + (editingId ? ' opacity-60 cursor-not-allowed' : '')}
                  placeholder="Ej. restaurant" />
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  Debe coincidir con la clave que usa la app. No se puede cambiar después de creada.
                </p>
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer w-fit">
                <input type="checkbox" checked={form.status === 'active'}
                  onChange={(e) => setForm({ ...form, status: e.target.checked ? 'active' : 'inactive' })}
                  className="w-4 h-4 rounded accent-[var(--color-primary)] cursor-pointer" />
                <span className="text-xs font-semibold text-[var(--color-text-main)]">Categoría activa</span>
              </label>

              <button
                type="submit"
                disabled={uploading}
                className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer mt-2"
              >
                {editingId ? 'Guardar Cambios' : 'Crear Categoría'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
