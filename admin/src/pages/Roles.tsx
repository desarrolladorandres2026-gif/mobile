import { useEffect, useMemo, useState } from 'react';
import {
 Search, RotateCw, Plus, X, CheckCircle2, ShieldCheck, Lock, Pencil, Trash2, Users as UsersIcon,
} from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { PermissionGate } from '../components/PermissionGate';
import { Permission, moduleLabel, actionLabel } from '../lib/permissions';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import type { AdminUser } from '../lib/apiTypes';
import AccessReview from './AccessReview';

interface RoleType {
 _id: string;
 name: string;
 slug: string;
 description?: string;
 permissions: string[];
 isActive: boolean;
 isSystem: boolean;
 createdAt: string;
}

interface PermissionGroup {
 module: string;
 actions: string[];
}

const emptyForm = { name: '', description: '', permissions: [] as string[] };

function RolesList() {
 const { hasPermission, permissions: myPermissions } = useAuthStore();
 const [roles, setRoles] = useState<RoleType[]>([]);
 const [catalog, setCatalog] = useState<PermissionGroup[]>([]);
 const [loading, setLoading] = useState(true);
 const [search, setSearch] = useState('');
 const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

 const [editing, setEditing] = useState<RoleType | null>(null);
 const [creating, setCreating] = useState(false);
 const [form, setForm] = useState(emptyForm);
 const [saving, setSaving] = useState(false);

 const [confirmDelete, setConfirmDelete] = useState<RoleType | null>(null);
 const [confirmToggle, setConfirmToggle] = useState<RoleType | null>(null);
 const [usersOfRole, setUsersOfRole] = useState<{ role: RoleType; users: AdminUser[] } | null>(null);

 const fetchAll = async () => {
 try {
 setLoading(true);
 const [rolesRes, catalogRes] = await Promise.all([
 api.get('/rbac/roles?limit=200'),
 api.get('/rbac/permissions'),
 ]);
 setRoles(rolesRes.data.data);
 setCatalog(catalogRes.data.data);
 } catch (err) {
 console.error(err);
 setToast({ message: 'Error al cargar roles', type: 'error' });
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

 const filteredRoles = useMemo(
 () => roles.filter((r) => r.name.toLowerCase().includes(search.toLowerCase())),
 [roles, search]
 );

 const openCreate = () => {
 setForm(emptyForm);
 setCreating(true);
 };

 const openEdit = (role: RoleType) => {
 setForm({ name: role.name, description: role.description || '', permissions: [...role.permissions] });
 setEditing(role);
 };

 const closeModal = () => {
 setCreating(false);
 setEditing(null);
 setForm(emptyForm);
 };

 const togglePermission = (perm: string) => {
 setForm((f) => ({
 ...f,
 permissions: f.permissions.includes(perm)
 ? f.permissions.filter((p) => p !== perm)
 : [...f.permissions, perm],
 }));
 };

 const toggleModule = (group: PermissionGroup, allSelected: boolean) => {
 const modulePerms = group.actions.map((a) => `${group.module}:${a}`);
 setForm((f) => ({
 ...f,
 permissions: allSelected
 ? f.permissions.filter((p) => !modulePerms.includes(p))
 : Array.from(new Set([...f.permissions, ...modulePerms])),
 }));
 };

 const selectAll = () => {
 const all = catalog.flatMap((g) => g.actions.map((a) => `${g.module}:${a}`));
 setForm((f) => ({ ...f, permissions: all }));
 };
 const deselectAll = () => setForm((f) => ({ ...f, permissions: [] }));

 const handleSave = async () => {
 if (!form.name.trim()) {
 setToast({ message: 'El nombre del rol es requerido', type: 'error' });
 return;
 }
 setSaving(true);
 try {
 if (editing) {
 await api.patch(`/rbac/roles/${editing._id}`, form);
 setToast({ message: 'Rol actualizado', type: 'success' });
 } else {
 await api.post('/rbac/roles', form);
 setToast({ message: 'Rol creado', type: 'success' });
 }
 closeModal();
 fetchAll();
 } catch (err) {
 setToast({ message: apiMessage(err, 'Error al guardar el rol'), type: 'error' });
 } finally {
 setSaving(false);
 }
 };

 const handleToggleActive = async () => {
 if (!confirmToggle) return;
 try {
 await api.patch(`/rbac/roles/${confirmToggle._id}`, { isActive: !confirmToggle.isActive });
 setToast({ message: `Rol ${confirmToggle.isActive ? 'desactivado' : 'activado'}`, type: 'success' });
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
 await api.delete(`/rbac/roles/${confirmDelete._id}`);
 setToast({ message: 'Rol eliminado', type: 'success' });
 setConfirmDelete(null);
 fetchAll();
 } catch (err) {
 setToast({ message: apiMessage(err, 'No se pudo eliminar el rol'), type: 'error' });
 setConfirmDelete(null);
 }
 };

 const openUsers = async (role: RoleType) => {
 try {
 const { data } = await api.get(`/rbac/roles/${role._id}/users`);
 setUsersOfRole({ role, users: data.data });
 } catch (err) {
 console.error(err);
 setToast({ message: 'Error al obtener usuarios del rol', type: 'error' });
 }
 };

 // Permisos que el propio actor no posee: el backend los rechaza igual,
 // pero mostrarlos deshabilitados evita un viaje al servidor solo para
 // enterarse.
 const canGrant = (perm: string) => myPermissions.includes(perm);

 return (
 <div className="space-y-3 animate-fade-in">
 <div className="page-header">
 <div>
 <h1 className="page-title">Roles</h1>
 <p className="page-subtitle">Agrupan permisos por módulo y acción. Un usuario puede tener uno o varios.</p>
 </div>
 <div className="flex justify-center gap-2">
 <button
 onClick={fetchAll}
 className="px-4 py-2 bg-[var(--color-surface)] hover:bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-xs"
 >
 <RotateCw className="w-4 h-4 text-[var(--color-primary)]" />
 <span>Actualizar</span>
 </button>
 <PermissionGate permission={Permission.ROLES_CREATE}>
 <button
 onClick={openCreate}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-white text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-lg shadow-[var(--color-primary)]/25"
 >
 <Plus className="w-4 h-4" />
 <span>Nuevo Rol</span>
 </button>
 </PermissionGate>
 </div>
 </div>

 <div className="zipp-card p-4 flex items-center gap-3">
 <div className="relative w-full md:w-80">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar rol..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
 />
 </div>
 </div>

 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
 Cargando roles...
 </div>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Rol</th>
 <th className="table-header-cell">Permisos</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Acciones</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-[var(--color-border-light)]">
 {filteredRoles.map((role) => (
 <tr key={role._id} className="hover:bg-[var(--color-bg)] transition-colors">
 <td className="table-body-cell">
 <div className="flex items-center gap-2">
 {role.isSystem ? (
 <span title="Rol de sistema: no editable">
 <Lock className="w-3.5 h-3.5 text-[var(--color-warning)]" />
 </span>
 ) : (
 <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-primary)]" />
 )}
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{role.name}</p>
 {role.description && <p className="text-[10px] text-[var(--color-text-main)]">{role.description}</p>}
 </div>
 </div>
 </td>
 <td className="table-body-cell">
 <button
 onClick={() => openUsers(role)}
 className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline cursor-pointer"
 >
 {role.permissions.length} permiso{role.permissions.length !== 1 ? 's' : ''}
 </button>
 </td>
 <td className="table-body-cell">
 <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${
 role.isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]'
 }`}>
 <span className={`w-1.5 h-1.5 rounded-full ${role.isActive ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-danger)]'}`} />
 {role.isActive ? 'Activo' : 'Inactivo'}
 </span>
 </td>
 <td className="table-body-cell">
 <div className="flex items-center gap-1.5">
 <button
 onClick={() => openUsers(role)}
 title="Ver usuarios con este rol"
 className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
 >
 <UsersIcon className="w-3.5 h-3.5" />
 </button>
 {!role.isSystem && (
 <PermissionGate permission={Permission.ROLES_UPDATE}>
 <button
 onClick={() => openEdit(role)}
 title="Editar"
 className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
 >
 <Pencil className="w-3.5 h-3.5" />
 </button>
 </PermissionGate>
 )}
 {!role.isSystem && (
 <PermissionGate permission={Permission.ROLES_UPDATE}>
 <button
 onClick={() => setConfirmToggle(role)}
 className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase border bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] cursor-pointer"
 >
 {role.isActive ? 'Desactivar' : 'Activar'}
 </button>
 </PermissionGate>
 )}
 {!role.isSystem && (
 <PermissionGate permission={Permission.ROLES_DELETE}>
 <button
 onClick={() => setConfirmDelete(role)}
 title="Eliminar"
 className="p-1.5 rounded-lg bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] hover:underline transition-all cursor-pointer"
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 </PermissionGate>
 )}
 </div>
 </td>
 </tr>
 ))}
 {filteredRoles.length === 0 && (
 <tr>
 <td colSpan={4} className="px-6 py-12 text-center text-[var(--color-text-main)] text-xs font-medium">
 No hay roles que coincidan con la búsqueda.
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {/* ── Crear / Editar rol ── */}
 {(creating || editing) && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-2xl rounded-2xl p-6 space-y-2.5 max-h-[90vh] overflow-y-auto">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <div className="flex items-center gap-2">
 <ShieldCheck className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">{editing ? 'Editar Rol' : 'Nuevo Rol'}</h3>
 </div>
 <button onClick={closeModal} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <div>
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5">Nombre</label>
 <input
 type="text"
 value={form.name}
 onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
 placeholder="Ej. Soporte Nivel 1"
 />
 </div>
 <div>
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5">Descripción</label>
 <input
 type="text"
 value={form.description}
 onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
 placeholder="Opcional"
 />
 </div>
 </div>

 <div className="flex items-center justify-between">
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider">
 Permisos ({form.permissions.length})
 </label>
 <div className="flex gap-2">
 <button onClick={selectAll} className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline cursor-pointer">Seleccionar todos</button>
 <span className="text-[var(--color-border)]">|</span>
 <button onClick={deselectAll} className="text-[11px] font-semibold text-[var(--color-text-main)] hover:underline cursor-pointer">Deseleccionar todos</button>
 </div>
 </div>

 <div className="border-y border-[var(--color-border-light)]">
 <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
 <table className="data-grid text-xs">
 <tbody className="divide-y divide-[var(--color-border-light)]">
 {catalog.map((group) => {
 const modulePerms = group.actions.map((a) => `${group.module}:${a}`);
 const allSelected = modulePerms.every((p) => form.permissions.includes(p));
 const someSelected = modulePerms.some((p) => form.permissions.includes(p));
 return (
 <tr key={group.module}>
 <td className="p-3 align-top w-40 bg-[var(--color-bg)]">
 <label className="flex items-center gap-2 cursor-pointer select-none">
 <input
 type="checkbox"
 checked={allSelected}
 ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
 onChange={() => toggleModule(group, allSelected)}
 className="w-3.5 h-3.5 rounded border-[var(--color-border)] text-[var(--color-primary)]"
 />
 <span className="font-bold text-[var(--color-text-main)]">{moduleLabel(group.module)}</span>
 </label>
 </td>
 <td className="p-3">
 <div className="flex flex-wrap gap-2">
 {group.actions.map((action) => {
 const key = `${group.module}:${action}`;
 const checked = form.permissions.includes(key);
 const grantable = canGrant(key);
 return (
 <label
 key={key}
 title={!grantable ? 'No posees este permiso: no puedes otorgarlo' : undefined}
 className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border cursor-pointer select-none text-[11px] font-medium ${
 checked ? 'bg-[var(--color-primary-bg)] border-[var(--color-primary)]/40 text-[#8A5D08]' : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-main)]'
 } ${!grantable ? 'opacity-40 cursor-not-allowed' : 'hover:border-[var(--color-primary)]/50'}`}
 >
 <input
 type="checkbox"
 checked={checked}
 disabled={!grantable}
 onChange={() => togglePermission(key)}
 className="w-3 h-3"
 />
 {actionLabel(action)}
 </label>
 );
 })}
 </div>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
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
 {saving ? 'Guardando...' : editing ? 'Guardar Cambios' : 'Crear Rol'}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* ── Usuarios con este rol ── */}
 {usersOfRole && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Usuarios con"{usersOfRole.role.name}"</h3>
 <button onClick={() => setUsersOfRole(null)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>
 <div className="space-y-2 max-h-80 overflow-y-auto">
 {usersOfRole.users.length === 0 && (
 <p className="text-xs text-[var(--color-text-main)] text-center py-6">Ningún usuario tiene este rol asignado directamente.</p>
 )}
 {usersOfRole.users.map((u) => (
 <div key={u._id} className="flex items-center gap-3 p-2 rounded-lg bg-[var(--color-bg)]">
 <div className="w-7 h-7 rounded-full bg-[var(--color-sidebar-hover)] flex items-center justify-center text-[10px] font-bold text-white">
 {u.name?.charAt(0)?.toUpperCase()}
 </div>
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{u.name}</p>
 <p className="text-[10px] text-[var(--color-text-main)] font-mono">{u.phone}</p>
 </div>
 </div>
 ))}
 </div>
 </div>
 </div>
 )}

 {confirmToggle && (
 <ConfirmDialog
 title={confirmToggle.isActive ? 'Desactivar Rol' : 'Activar Rol'}
 message={`¿Deseas ${confirmToggle.isActive ? 'desactivar' : 'activar'} el rol"${confirmToggle.name}"? ${confirmToggle.isActive ? 'Los usuarios que solo tengan este rol perderán esos permisos.' : ''}`}
 confirmLabel={confirmToggle.isActive ? 'Desactivar' : 'Activar'}
 onConfirm={handleToggleActive}
 onCancel={() => setConfirmToggle(null)}
 variant={confirmToggle.isActive ? 'warning' : 'default'}
 />
 )}

 {confirmDelete && (
 <ConfirmDialog
 title="Eliminar Rol"
 message={`¿Eliminar el rol"${confirmDelete.name}"? Esta acción no se puede deshacer.`}
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

 {!hasPermission(Permission.ROLES_VIEW) && (
 <p className="text-xs text-[var(--color-text-main)]">No tienes permiso para ver roles.</p>
 )}
 </div>
 );
}

export default function Roles() {
 const isSuperAdmin = useAuthStore((s) => s.roleSlugs.includes('super_admin'));
 const [tab, setTab] = useState<'roles' | 'review'>('roles');
 const active = isSuperAdmin ? tab : 'roles';
 const tabClass = (t: string) =>
 `pb-2 text-xs font-bold cursor-pointer border-b-2 ${
 active === t
 ? 'border-[var(--color-primary)] text-[var(--color-text-main)]'
 : 'border-transparent text-[var(--color-text-main)]'
 }`;
 return (
 <div className="space-y-3">
 {isSuperAdmin && (
 <div className="flex gap-6 border-b border-[var(--color-border-light)]">
 <button className={tabClass('roles')} onClick={() => setTab('roles')}>Roles</button>
 <button className={tabClass('review')} onClick={() => setTab('review')}>Revisión de accesos</button>
 </div>
 )}
 {active === 'review' ? <AccessReview /> : <RolesList />}
 </div>
 );
}
