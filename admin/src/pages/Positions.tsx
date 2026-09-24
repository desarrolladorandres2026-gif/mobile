import { useEffect, useMemo, useState } from 'react';
import {
  Search, RotateCw, Plus, X, CheckCircle2, Briefcase, Pencil, Trash2, Users as UsersIcon,
} from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { PermissionGate } from '../components/PermissionGate';
import { Permission } from '../lib/permissions';
import { apiMessage } from '../lib/apiError';
import type { AdminUser } from '../lib/apiTypes';

interface RoleRef { _id: string; name: string; slug: string; isActive: boolean }
interface PositionType {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  roleIds: RoleRef[];
  isActive: boolean;
  createdAt: string;
}

const emptyForm = { name: '', description: '', roleIds: [] as string[] };

export default function Positions() {
  const [positions, setPositions] = useState<PositionType[]>([]);
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [editing, setEditing] = useState<PositionType | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<PositionType | null>(null);
  const [confirmToggle, setConfirmToggle] = useState<PositionType | null>(null);
  const [usersOfPosition, setUsersOfPosition] = useState<{ position: PositionType; users: AdminUser[] } | null>(null);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [posRes, rolesRes] = await Promise.all([
        api.get('/rbac/positions?limit=200'),
        api.get('/rbac/roles?limit=200&isActive=true'),
      ]);
      setPositions(posRes.data.data);
      setRoles(rolesRes.data.data);
    } catch (err) {
      console.error(err);
      setToast({ message: 'Error al cargar cargos', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(
    () => positions.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())),
    [positions, search]
  );

  const openCreate = () => { setForm(emptyForm); setCreating(true); };
  const openEdit = (p: PositionType) => {
    setForm({ name: p.name, description: p.description || '', roleIds: p.roleIds.map((r) => r._id) });
    setEditing(p);
  };
  const closeModal = () => { setCreating(false); setEditing(null); setForm(emptyForm); };

  const toggleRole = (roleId: string) => {
    setForm((f) => ({
      ...f,
      roleIds: f.roleIds.includes(roleId) ? f.roleIds.filter((id) => id !== roleId) : [...f.roleIds, roleId],
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setToast({ message: 'El nombre del cargo es requerido', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/rbac/positions/${editing._id}`, form);
        setToast({ message: 'Cargo actualizado', type: 'success' });
      } else {
        await api.post('/rbac/positions', form);
        setToast({ message: 'Cargo creado', type: 'success' });
      }
      closeModal();
      fetchAll();
    } catch (err) {
      setToast({ message: apiMessage(err, 'Error al guardar el cargo'), type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    if (!confirmToggle) return;
    try {
      await api.patch(`/rbac/positions/${confirmToggle._id}`, { isActive: !confirmToggle.isActive });
      setToast({ message: `Cargo ${confirmToggle.isActive ? 'desactivado' : 'activado'}`, type: 'success' });
      setConfirmToggle(null);
      fetchAll();
    } catch (err) {
      setToast({ message: apiMessage(err, 'Error al cambiar el estado'), type: 'error' });
      setConfirmToggle(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api.delete(`/rbac/positions/${confirmDelete._id}`);
      setToast({ message: 'Cargo eliminado', type: 'success' });
      setConfirmDelete(null);
      fetchAll();
    } catch (err) {
      setToast({ message: apiMessage(err, 'No se pudo eliminar el cargo'), type: 'error' });
      setConfirmDelete(null);
    }
  };

  const openUsers = async (position: PositionType) => {
    try {
      const { data } = await api.get(`/rbac/positions/${position._id}/users`);
      setUsersOfPosition({ position, users: data.data });
    } catch (err) {
      console.error(err);
      setToast({ message: 'Error al obtener usuarios del cargo', type: 'error' });
    }
  };

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Cargos</h1>
          <p className="page-subtitle">El puesto de cada persona en la organización. Cada cargo trae consigo los roles que le asignes.</p>
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={fetchAll}
            className="px-4 py-2 bg-[var(--color-surface)] hover:bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-xs"
          >
            <RotateCw className="w-4 h-4 text-[var(--color-primary)]" />
            <span>Actualizar</span>
          </button>
          <PermissionGate permission={Permission.POSITIONS_CREATE}>
            <button
              onClick={openCreate}
              className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-white text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-lg shadow-[var(--color-primary)]/25"
            >
              <Plus className="w-4 h-4" />
              <span>Nuevo Cargo</span>
            </button>
          </PermissionGate>
        </div>
      </div>

      <div className="zipp-card p-4 flex items-center gap-3">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar cargo..."
            className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
          />
        </div>
      </div>

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
          Cargando cargos...
        </div>
      ) : (
        <div className="table-container">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="table-header-cell">Cargo</th>
                  <th className="table-header-cell">Roles asociados</th>
                  <th className="table-header-cell">Estado</th>
                  <th className="table-header-cell">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-light)]">
                {filtered.map((p) => (
                  <tr key={p._id} className="hover:bg-[var(--color-bg)] transition-colors">
                    <td className="table-body-cell">
                      <div className="flex items-center gap-2">
                        <Briefcase className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                        <div>
                          <p className="text-xs font-bold text-[var(--color-text-main)]">{p.name}</p>
                          {p.description && <p className="text-[10px] text-[var(--color-text-muted)]">{p.description}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="table-body-cell">
                      <div className="flex flex-wrap gap-1">
                        {p.roleIds.length === 0 && <span className="text-[10px] text-[var(--color-text-muted)]">Sin roles</span>}
                        {p.roleIds.map((r) => (
                          <span key={r._id} className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)]">
                            {r.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="table-body-cell">
                      <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${
                        p.isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-danger)]'}`} />
                        {p.isActive ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="table-body-cell">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => openUsers(p)}
                          title="Ver usuarios con este cargo"
                          className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
                        >
                          <UsersIcon className="w-3.5 h-3.5" />
                        </button>
                        <PermissionGate permission={Permission.POSITIONS_UPDATE}>
                          <button
                            onClick={() => openEdit(p)}
                            title="Editar"
                            className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </PermissionGate>
                        <PermissionGate permission={Permission.POSITIONS_UPDATE}>
                          <button
                            onClick={() => setConfirmToggle(p)}
                            className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase border bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-alt)] cursor-pointer"
                          >
                            {p.isActive ? 'Desactivar' : 'Activar'}
                          </button>
                        </PermissionGate>
                        <PermissionGate permission={Permission.POSITIONS_DELETE}>
                          <button
                            onClick={() => setConfirmDelete(p)}
                            title="Eliminar"
                            className="p-1.5 rounded-lg bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white transition-all cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </PermissionGate>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-[var(--color-text-muted)] text-xs font-medium">
                      No hay cargos que coincidan con la búsqueda.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(creating || editing) && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
              <div className="flex items-center gap-2">
                <Briefcase className="w-5 h-5 text-[var(--color-primary)]" />
                <h3 className="text-base font-bold text-[var(--color-text-main)]">{editing ? 'Editar Cargo' : 'Nuevo Cargo'}</h3>
              </div>
              <button onClick={closeModal} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Nombre</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
                placeholder="Ej. Coordinador de Operaciones"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Descripción</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
                placeholder="Opcional"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">Roles asociados</label>
              <div className="space-y-1.5 max-h-52 overflow-y-auto divide-y divide-[var(--color-border-light)] border-y border-[var(--color-border-light)] py-1">
                {roles.length === 0 && <p className="text-xs text-[var(--color-text-muted)] p-2">No hay roles activos. Crea uno primero.</p>}
                {roles.map((r) => {
                  const checked = form.roleIds.includes(r._id);
                  return (
                    <label
                      key={r._id}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer select-none text-xs font-medium ${
                        checked ? 'bg-[var(--color-primary-bg)] text-[#8A5D08]' : 'hover:bg-[var(--color-bg)] text-[var(--color-text-secondary)]'
                      }`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleRole(r._id)} className="w-3.5 h-3.5 rounded border-[var(--color-border)] text-[var(--color-primary)]" />
                      {r.name}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={closeModal}
                className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-all cursor-pointer"
              >
                {saving ? 'Guardando...' : editing ? 'Guardar Cambios' : 'Crear Cargo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {usersOfPosition && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5">
            <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">Usuarios en "{usersOfPosition.position.name}"</h3>
              <button onClick={() => setUsersOfPosition(null)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {usersOfPosition.users.length === 0 && (
                <p className="text-xs text-[var(--color-text-muted)] text-center py-6">Ningún usuario tiene este cargo asignado.</p>
              )}
              {usersOfPosition.users.map((u) => (
                <div key={u._id} className="flex items-center gap-3 p-2 rounded-lg bg-[var(--color-bg)]">
                  <div className="w-7 h-7 rounded-full bg-[var(--color-sidebar-hover)] flex items-center justify-center text-[10px] font-bold text-white">
                    {u.name?.charAt(0)?.toUpperCase()}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-[var(--color-text-main)]">{u.name}</p>
                    <p className="text-[10px] text-[var(--color-text-muted)] font-mono">{u.phone}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {confirmToggle && (
        <ConfirmDialog
          title={confirmToggle.isActive ? 'Desactivar Cargo' : 'Activar Cargo'}
          message={`¿Deseas ${confirmToggle.isActive ? 'desactivar' : 'activar'} el cargo "${confirmToggle.name}"?`}
          confirmLabel={confirmToggle.isActive ? 'Desactivar' : 'Activar'}
          onConfirm={handleToggleActive}
          onCancel={() => setConfirmToggle(null)}
          variant={confirmToggle.isActive ? 'warning' : 'default'}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Eliminar Cargo"
          message={`¿Eliminar el cargo "${confirmDelete.name}"? Esta acción no se puede deshacer.`}
          confirmLabel="Eliminar"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
          variant="danger"
        />
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-2 shadow-lg animate-fade-in ${
          toast.type === 'success' ? 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)] text-[var(--color-primary)]' : 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)] text-[var(--color-danger)]'
        }`}>
          <CheckCircle2 className="w-4 h-4" />
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
