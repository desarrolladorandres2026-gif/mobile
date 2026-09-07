import { useEffect, useState } from 'react';
import { Store, Star, MapPin, Clock, ToggleLeft, ToggleRight, X, AlertCircle, Trash2, Plus, Search } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';
import type { AdminUser } from '../lib/apiTypes';

interface Business {
  _id: string;
  name: string;
  category: string;
  rating: number;
  totalReviews?: number;
  address: string;
  deliveryTime: number;
  commissionRate: number;
  commissionRateBps: number;
  isActive: boolean;
  isApproved: boolean;
  isFeatured: boolean;
}

export default function Businesses() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    category: 'restaurant',
    address: '',
    phone: '',
    latitude: 2.1958,
    longitude: -75.6258,
    deliveryTime: 30,
    commissionRate: 0.10,
    ownerId: '',
  });
  const [owners, setOwners] = useState<AdminUser[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<Business | null>(null);

  const fetchBusinessesAndOwners = async () => {
    try {
      setLoading(true);
      setError('');
      const [resBus, resUsers] = await Promise.all([
        api.get('/businesses?limit=100&includeInactive=true'),
        api.get('/admin/users?role=business&limit=100'),
      ]);
      setBusinesses(resBus.data.data);
      setOwners(resUsers.data.data);
      if (resUsers.data.data.length > 0) {
        setForm((prev) => ({ ...prev, ownerId: resUsers.data.data[0]._id }));
      }
    } catch (err) {
      console.error(err);
      setError('No se pudieron cargar los negocios.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBusinessesAndOwners();
  }, []);

  const handleToggleActive = async (business: Business) => {
    try {
      const { data } = await api.patch(`/admin/businesses/${business._id}/toggle`);
      setBusinesses((prev) =>
        prev.map((b) => (b._id === business._id ? { ...b, isActive: data.data.isActive } : b))
      );
    } catch (err) {
      setError(apiMessage(err, 'No se pudo actualizar el estado del comercio.'));
    }
  };

  const handleToggleFeatured = async (business: Business) => {
    try {
      const { data } = await api.patch(`/admin/businesses/${business._id}/featured`);
      setBusinesses((prev) =>
        prev.map((b) => (b._id === business._id ? { ...b, isFeatured: data.data.isFeatured } : b))
      );
    } catch (err) {
      setError(apiMessage(err, 'No se pudo destacar el comercio.'));
    }
  };

  const handleDeleteBusiness = async () => {
    if (!confirmDelete) return;
    try {
      await api.delete(`/admin/businesses/${confirmDelete._id}`);
      setBusinesses((prev) => prev.filter((b) => b._id !== confirmDelete._id));
      setConfirmDelete(null);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo eliminar el comercio.'));
      setConfirmDelete(null);
    }
  };

  const handleCreateBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.ownerId) {
      setError('Debe existir al menos un usuario con rol Negocio para asignarlo como dueño.');
      return;
    }
    try {
      setError('');
      const { data } = await api.post('/businesses', {
        ownerId: form.ownerId,
        name: form.name,
        description: form.description || undefined,
        category: form.category,
        address: form.address,
        phone: form.phone,
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        deliveryTime: Number(form.deliveryTime),
      });

      await api.patch(`/finance/businesses/${data.data._id}/terms`, {
        commissionRateBps: Math.round(Number(form.commissionRate) * 10000),
        isApproved: true,
      });

      setShowModal(false);
      fetchBusinessesAndOwners();
      setForm({
        name: '', description: '', category: 'restaurant', address: '', phone: '',
        latitude: 2.1958, longitude: -75.6258, deliveryTime: 30,
        commissionRate: 0.10, ownerId: owners[0]?._id || '',
      });
    } catch (err) {
      setError(apiMessage(err, 'No se pudo registrar el comercio.'));
    }
  };

  const getCategoryLabel = (cat: string) => {
    const map: Record<string, string> = {
      restaurant: 'Restaurante', fast_food: 'Comidas Rápidas',
      pharmacy: 'Droguería', cafe: 'Cafetería', supermarket: 'Supermercado',
    };
    return map[cat] || cat;
  };

  const filteredBusinesses = businesses.filter((b) => {
    const matchesSearch = b.name.toLowerCase().includes(search.toLowerCase()) || b.address.toLowerCase().includes(search.toLowerCase());
    const matchesCat = selectedCategory === 'all' || b.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  const inputClass = 'w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all placeholder:text-[var(--color-text-muted)]';
  const labelClass = 'block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5';

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Gestión de Comercios Aliados</h1>
          <p className="page-subtitle">Administra los restaurantes y tiendas registrados</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-xs font-bold text-white rounded-lg transition-all shadow-xs cursor-pointer flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          <span>Nuevo Establecimiento</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col md:flex-row gap-4 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o dirección..."
            className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] focus:outline-none transition-all"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
          {[
            { id: 'all', label: 'Todas' },
            { id: 'restaurant', label: 'Restaurantes' },
            { id: 'fast_food', label: 'Comidas Rápidas' },
            { id: 'pharmacy', label: 'Droguerías' },
            { id: 'cafe', label: 'Cafeterías' },
            { id: 'supermarket', label: 'Supermercados' },
          ].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${selectedCategory === cat.id
                ? 'bg-[var(--color-primary)] text-white shadow-xs'
                : 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-border)]'
                }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando catálogo de negocios...
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredBusinesses.map((b) => (
            <div
              key={b._id}
              className="zipp-card p-5 flex flex-col md:flex-row md:items-center justify-between gap-5"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-[var(--color-primary-bg)] border border-[var(--color-primary-bg)] flex items-center justify-center flex-shrink-0">
                  <Store className="w-6 h-6 text-[var(--color-primary)]" />
                </div>

                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="text-base font-bold text-[var(--color-text-main)]">{b.name}</h3>
                    <button
                      onClick={() => handleToggleFeatured(b)}
                      className={`text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider transition-all cursor-pointer border ${b.isFeatured
                        ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning-bg)]'
                        : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text-main)]'
                        }`}
                    >
                      <Star className={`w-3 h-3 inline mr-1 ${b.isFeatured ? 'fill-[var(--color-warning)]' : ''}`} />
                      {b.isFeatured ? 'Destacado' : 'Destacar'}
                    </button>
                  </div>

                  <p className="text-xs text-[var(--color-text-secondary)] font-medium">{getCategoryLabel(b.category)}</p>

                  <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--color-text-secondary)]">
                    <span className="flex items-center gap-1 text-[var(--color-text-main)] font-medium">
                      <Star className="w-3.5 h-3.5 text-[var(--color-warning)] fill-[var(--color-warning)]" />
                      {b.rating || 'S/V'} ({b.totalReviews || 0})
                    </span>
                    <span className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                      <MapPin className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                      {b.address}
                    </span>
                    <span className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                      <Clock className="w-3.5 h-3.5 text-[var(--color-primary-light)]" />
                      {b.deliveryTime} min
                    </span>
                    <span className="px-2 py-0.5 rounded bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-[var(--color-primary)] font-mono font-bold text-[11px]">
                      Comisión: {b.commissionRateBps >= 0 ? `${(b.commissionRateBps / 100).toFixed(1)}%` : 'Global'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between md:justify-end gap-3 border-t border-[var(--color-border-light)] md:border-0 pt-3 md:pt-0">
                <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border uppercase tracking-wider ${b.isActive ? 'bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-[var(--color-primary-bg)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-bg)]'
                  }`}>
                  {b.isActive ? 'Activo' : 'Inactivo'}
                </span>

                <button
                  onClick={() => handleToggleActive(b)}
                  className="cursor-pointer hover:scale-105 transition-transform"
                  title={b.isActive ? 'Desactivar comercio' : 'Activar comercio'}
                >
                  {b.isActive ? (
                    <ToggleRight className="w-8 h-8 text-[var(--color-primary)]" />
                  ) : (
                    <ToggleLeft className="w-8 h-8 text-[var(--color-text-muted)]" />
                  )}
                </button>

                <button
                  onClick={() => setConfirmDelete(b)}
                  className="p-2 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] transition-colors cursor-pointer"
                  title="Eliminar comercio"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {filteredBusinesses.length === 0 && (
            <div className="zipp-card p-12 text-center text-[var(--color-text-muted)] text-xs font-semibold">
              No hay establecimientos que coincidan con la búsqueda.
            </div>
          )}
        </div>
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && (
        <ConfirmDialog
          title="Eliminar Establecimiento"
          message={`¿Estás seguro de eliminar "${confirmDelete.name}"? Esta acción removerá el comercio de la app.`}
          confirmLabel="Eliminar Definitivamente"
          onConfirm={handleDeleteBusiness}
          onCancel={() => setConfirmDelete(null)}
          variant="danger"
        />
      )}

      {/* Create Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="Zipp-modal w-full max-w-xl rounded-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-4">
              <div className="flex items-center gap-2">
                <Store className="w-5 h-5 text-[var(--color-primary)]" />
                <h3 className="text-base font-bold text-[var(--color-text-main)]">Nuevo Comercio Aliado</h3>
              </div>
              <button onClick={() => setShowModal(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateBusiness} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Nombre del Establecimiento</label>
                  <input type="text" required value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputClass} placeholder="Ej. Pollo Frito" />
                </div>
                <div>
                  <label className={labelClass}>Usuario Propietario</label>
                  <select value={form.ownerId}
                    onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
                    className={inputClass + ' cursor-pointer'}>
                    {owners.map((o) => (
                      <option key={o._id} value={o._id} className="text-[var(--color-text-main)]">
                        {o.name} ({o.phone})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className={labelClass}>Descripción del Menú / Especialidad</label>
                <textarea value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none min-h-[60px] placeholder:text-[var(--color-text-muted)]"
                  placeholder="Descripción atractiva para los usuarios" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Categoría Principal</label>
                  <select value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={inputClass + ' cursor-pointer'}>
                    <option value="restaurant">Restaurante</option>
                    <option value="fast_food">Comidas Rápidas</option>
                    <option value="pharmacy">Droguería</option>
                    <option value="cafe">Cafetería</option>
                    <option value="supermarket">Supermercado</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Teléfono de Contacto</label>
                  <input type="tel" required value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className={inputClass} placeholder="3151234567" />
                </div>
              </div>

              <div>
                <label className={labelClass}>Dirección Exacta</label>
                <input type="text" required value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className={inputClass} placeholder="Calle 7 # 10-45" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Tiempo Promedio de Entrega (min)</label>
                  <input type="number" required value={form.deliveryTime}
                    onChange={(e) => setForm({ ...form, deliveryTime: Number(e.target.value) })}
                    className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Comisión ZIPP (Decimal, ej: 0.12 = 12%)</label>
                  <input type="number" step="0.01" required value={form.commissionRate}
                    onChange={(e) => setForm({ ...form, commissionRate: Number(e.target.value) })}
                    className={inputClass} />
                </div>
              </div>

              <button
                type="submit"
                className="w-full h-11 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-white font-bold text-xs uppercase tracking-wider rounded-lg shadow-sm cursor-pointer mt-2"
              >
                Crear y Activar Comercio
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
