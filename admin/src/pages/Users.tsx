import {
 Search, CheckCircle2, RotateCw, X, Shield, UserCog, User, Store, Bike, Zap,
 Plus, Briefcase, KeyRound, Ban, Copy, History, ShieldOff, type LucideIcon,
} from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { useFicha } from '../lib/entityLinks';
import { PermissionGate } from '../components/PermissionGate';
import { Permission } from '../lib/permissions';
import { useAuthStore } from '../stores/authStore';
import { useCallback, useEffect, useState, useRef } from 'react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

type Status = 'active' | 'inactive' | 'blocked';

interface RoleRef { _id: string; name: string; slug: string }
interface PositionRef { _id: string; name: string; slug: string }

interface UserType {
 _id: string;
 name: string;
 phone: string;
 email?: string;
 role: string;
 isActive: boolean;
 isBlocked?: boolean;
 status?: Status;
 positionId?: PositionRef | string | null;
 roleIds?: Array<RoleRef | string>;
 createdAt: string;
 lastLoginAt?: string;
 twoFactorEnabled?: boolean;
}

const roles: Array<{ value: string; label: string; description: string; icon: LucideIcon }> = [
 { value: 'client', label: 'Cliente', description: 'Usuario estándar que realiza pedidos', icon: User },
 { value: 'business', label: 'Negocio', description: 'Propietario de un comercio', icon: Store },
 { value: 'driver', label: 'Domiciliario', description: 'Repartidor de la plataforma ZIPP', icon: Bike },
 { value: 'admin', label: 'Administrador', description: 'Cuenta de tipo administrativo (el acceso real lo dan sus Roles/Cargo)', icon: Zap },
];

const roleLabels: Record<string, { label: string; classes: string }> = {
 client: { label: 'Cliente', classes: 'text-[#8A5D08]' },
 business: { label: 'Negocio', classes: 'text-[var(--color-primary-light)]' },
 driver: { label: 'Domiciliario', classes: 'text-[var(--color-primary)]' },
 admin: { label: 'Admin', classes: 'text-[var(--color-text-main)] font-extrabold' },
};

const statusMeta: Record<Status, { label: string; dot: string; text: string }> = {
 active: { label: 'Activo', dot: 'bg-[var(--color-primary)]', text: 'text-[var(--color-primary)]' },
 inactive: { label: 'Inactivo', dot: 'bg-[var(--color-text-muted)]', text: 'text-[var(--color-text-main)]' },
 blocked: { label: 'Bloqueado', dot: 'bg-[var(--color-danger)]', text: 'text-[var(--color-danger)]' },
};

function refName(ref: RoleRef | PositionRef | string | null | undefined): string | null {
 if (!ref) return null;
 return typeof ref === 'string' ? null : ref.name;
}

export default function Users() {
 const currentUserId = useAuthStore((s) => s.user?._id);
 const authzMode = useAuthStore((s) => s.authzMode);
 const observedPermissions = useAuthStore((s) => s.observedPermissions);
 const [users, setUsers] = useState<UserType[]>([]);
 const [loading, setLoading] = useState(true);
 const [search, setSearch] = useState('');
 const [roleFilter, setRoleFilter] = useState('all');
 const [page, setPage] = useState(1);
 const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: 25 });
 const PAGE_SIZE = 25;

 const [confirmStatus, setConfirmStatus] = useState<{ user: UserType; status: Status } | null>(null);
 const [confirmRoleChange, setConfirmRoleChange] = useState(false);

 const [editingUser, setEditingUser] = useState<UserType | null>(null);
 const [selectedRole, setSelectedRole] = useState('');
 const [saving, setSaving] = useState(false);
 const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
 const modalRef = useRef<HTMLDivElement>(null);

 // Cargo / Roles (RBAC)
 const [accessUser, setAccessUser] = useState<UserType | null>(null);
 const [allPositions, setAllPositions] = useState<PositionRef[]>([]);
 const [allRoles, setAllRoles] = useState<RoleRef[]>([]);
 const [accessForm, setAccessForm] = useState<{ positionId: string; roleIds: string[] }>({ positionId: '', roleIds: [] });
 const [effectivePermissions, setEffectivePermissions] = useState<string[]>([]);

 // Restablecer contraseña
 const [resetUser, setResetUser] = useState<UserType | null>(null);
 const [tempPassword, setTempPassword] = useState<string | null>(null);

 // Restablecer 2FA (perdió el celular y sus códigos de recuperación)
 const [reset2faUser, setReset2faUser] = useState<UserType | null>(null);
 const [reset2faReason, setReset2faReason] = useState('');
 const [reset2faError, setReset2faError] = useState('');
 const [reset2faTempPassword, setReset2faTempPassword] = useState<string | null>(null);

 // Crear cuenta administrativa
 // Historial completo de una persona. Se abre desde su fila porque es
 // donde nace la pregunta que contesta: quien la necesita ya esta
 // mirando a ese usuario. La ficha vive en la URL (`?ficha=user:<id>`).
 const { open: openFicha } = useFicha();
 const [loadError, setLoadError] = useState('');
 const [creatingStaff, setCreatingStaff] = useState(false);
 const [staffForm, setStaffForm] = useState({ name: '', phone: '', email: '', password: '', positionId: '' });

 // `useCallback` con sus dependencias de verdad, y el efecto colgando de
 // ella. Antes la función se recreaba en cada render y el efecto
 // dependía de [roleFilter] a mano: la lista tenía que mantenerse
 // sincronizada con lo que la función lee por dentro, y cuando dejaba
 // de estarlo el panel se quedaba pidiendo datos del filtro anterior.
 // La búsqueda se manda al servidor (ahí vive el índice y el `$regex`
 // sobre toda la tabla), no se filtra en el navegador sobre la página
 // actual — si no,"buscar" solo encontraría coincidencias dentro de
 // los 25 usuarios ya cargados.
 const [debouncedSearch, setDebouncedSearch] = useState('');
 useEffect(() => {
 const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
 return () => clearTimeout(t);
 }, [search]);
 useEffect(() => { setPage(1); }, [roleFilter, debouncedSearch]);

 const fetchUsers = useCallback(async () => {
 try {
 setLoading(true);
 const params: Record<string, string | number> = { page, limit: PAGE_SIZE };
 if (roleFilter !== 'all') params.role = roleFilter;
 if (debouncedSearch) params.search = debouncedSearch;
 const { data } = await api.get('/admin/users', { params });
 setUsers(data.data);
 if (data.meta) setMeta(data.meta);
 setLoadError('');
 } catch (err) {
 console.error(err);
 setLoadError(apiMessage(err, 'No se pudieron cargar los usuarios.'));
 } finally {
 setLoading(false);
 }
 }, [roleFilter, debouncedSearch, page]);

 const fetchRbacCatalog = async () => {
 try {
 const [posRes, rolesRes] = await Promise.all([
 api.get('/rbac/positions?limit=200&isActive=true'),
 api.get('/rbac/roles?limit=200&isActive=true'),
 ]);
 setAllPositions(posRes.data.data);
 setAllRoles(rolesRes.data.data);
 } catch {
 // Sin permiso de Cargos/Roles: la sección de acceso del modal
 // simplemente no tendrá opciones para elegir.
 }
 };

 useEffect(() => { fetchUsers(); }, [fetchUsers]);
 useEffect(() => { fetchRbacCatalog(); }, []);

 useEffect(() => {
 const handler = (e: KeyboardEvent) => {
 if (e.key === 'Escape') { setEditingUser(null); setAccessUser(null); setResetUser(null); setReset2faUser(null); setCreatingStaff(false); }
 };
 window.addEventListener('keydown', handler);
 return () => window.removeEventListener('keydown', handler);
 }, []);

 useEffect(() => {
 if (!toast) return;
 const timer = setTimeout(() => setToast(null), 3500);
 return () => clearTimeout(timer);
 }, [toast]);

 const applyStatus = async () => {
 if (!confirmStatus) return;
 try {
 await api.patch(`/admin/users/${confirmStatus.user._id}/status`, { status: confirmStatus.status });
 setUsers((prev) => prev.map((u) => (u._id === confirmStatus.user._id ? { ...u, status: confirmStatus.status, isActive: confirmStatus.status === 'active', isBlocked: confirmStatus.status === 'blocked' } : u)));
 setToast({ message: 'Estado del usuario actualizado', type: 'success' });
 } catch (err) {
 setToast({ message: apiMessage(err, 'Error al cambiar el estado'), type: 'error' });
 } finally {
 setConfirmStatus(null);
 }
 };

 const openRoleModal = (user: UserType) => {
 setEditingUser(user);
 setSelectedRole(user.role);
 };

 const handleSaveRole = async () => {
 if (!editingUser || selectedRole === editingUser.role) return;
 setConfirmRoleChange(true);
 };

 const confirmHandleSaveRole = async () => {
 if (!editingUser) return;
 setConfirmRoleChange(false);
 setSaving(true);
 const roleName = roles.find((r) => r.value === selectedRole)?.label || selectedRole;
 try {
 await api.patch(`/admin/users/${editingUser._id}/role`, { role: selectedRole });
 setUsers((prev) => prev.map((u) => (u._id === editingUser._id ? { ...u, role: selectedRole } : u)));
 setToast({ message: `Rol cambiado a"${roleName}"`, type: 'success' });
 setEditingUser(null);
 } catch (err) {
 setToast({ message: apiMessage(err, 'Error al actualizar el rol'), type: 'error' });
 } finally {
 setSaving(false);
 }
 };

 // ── Cargo y Roles (RBAC) ──

 const openAccessModal = async (user: UserType) => {
 setAccessUser(user);
 setAccessForm({
 positionId: typeof user.positionId === 'object' && user.positionId ? user.positionId._id : '',
 roleIds: (user.roleIds || []).map((r) => (typeof r === 'string' ? r : r._id)),
 });
 try {
 const { data } = await api.get(`/admin/users/${user._id}/access`);
 setEffectivePermissions(data.data.permissions || []);
 } catch {
 setEffectivePermissions([]);
 }
 };

 const toggleAccessRole = (roleId: string) => {
 setAccessForm((f) => ({
 ...f,
 roleIds: f.roleIds.includes(roleId) ? f.roleIds.filter((id) => id !== roleId) : [...f.roleIds, roleId],
 }));
 };

 const saveAccess = async () => {
 if (!accessUser) return;
 setSaving(true);
 // Uno tras otro y no en paralelo: el backend rechaza con 403 lo que dé
 // más permisos de los que tiene quien asigna, y en paralelo podía
 // guardarse el cargo y fallar los roles sin que el aviso lo dijera.
 let positionSaved = false;
 try {
 await api.patch(`/admin/users/${accessUser._id}/position`, { positionId: accessForm.positionId || null });
 positionSaved = true;
 await api.patch(`/admin/users/${accessUser._id}/roles`, { roleIds: accessForm.roleIds });
 setToast({ message: 'Cargo y roles actualizados', type: 'success' });
 setAccessUser(null);
 fetchUsers();
 } catch (err) {
 const reason = apiMessage(err, 'Error al actualizar el acceso');
 setToast({
 message: positionSaved ? `Se guardó el cargo, pero no los roles: ${reason}` : `No se guardó nada: ${reason}`,
 type: 'error',
 });
 if (positionSaved) fetchUsers();
 } finally {
 setSaving(false);
 }
 };

 // ── Restablecer contraseña ──

 const doResetPassword = async () => {
 if (!resetUser) return;
 setSaving(true);
 try {
 const { data } = await api.post(`/admin/users/${resetUser._id}/reset-password`);
 setTempPassword(data.data.temporaryPassword);
 } catch (err) {
 setToast({ message: apiMessage(err, 'Error al restablecer la contraseña'), type: 'error' });
 setResetUser(null);
 } finally {
 setSaving(false);
 }
 };

 // ── Restablecer 2FA ──

 const doResetTwoFactor = async () => {
 if (!reset2faUser) return;
 if (reset2faReason.trim().length < 10) {
 setReset2faError('Escribe el motivo y el canal por el que verificaste la identidad (mínimo 10 caracteres).');
 return;
 }
 setSaving(true);
 setReset2faError('');
 try {
 const { data } = await api.post(`/admin/users/${reset2faUser._id}/reset-2fa`, { reason: reset2faReason.trim() });
 setReset2faTempPassword(data.data.temporaryPassword);
 fetchUsers();
 } catch (err) {
 setReset2faError(apiMessage(err, 'No se pudo restablecer la verificación en dos pasos'));
 } finally {
 setSaving(false);
 }
 };

 // ── Crear cuenta administrativa ──

 const createStaffUser = async () => {
 setSaving(true);
 try {
 await api.post('/admin/users', { ...staffForm, positionId: staffForm.positionId || undefined });
 setToast({ message: 'Cuenta administrativa creada', type: 'success' });
 setCreatingStaff(false);
 setStaffForm({ name: '', phone: '', email: '', password: '', positionId: '' });
 fetchUsers();
 } catch (err) {
 setToast({ message: apiMessage(err, 'Error al crear la cuenta'), type: 'error' });
 } finally {
 setSaving(false);
 }
 };

 return (
 <div className="space-y-3 animate-fade-in">
 {/* Header */}
 <div className="page-header">
 <div>
 <h1 className="page-title">Directorio de Usuarios</h1>
 <p className="page-subtitle">Administración de clientes, comercios, domiciliarios y administradores</p>
 </div>
 <div className="flex justify-center gap-2">
 <button
 onClick={fetchUsers}
 className="px-4 py-2 bg-[var(--color-surface)] hover:bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-xs"
 >
 <RotateCw className="w-4 h-4 text-[var(--color-primary)]" />
 <span>Actualizar</span>
 </button>
 <PermissionGate permission={Permission.USERS_CREATE}>
 <button
 onClick={() => setCreatingStaff(true)}
 className="px-4 py-2 bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-white text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-lg shadow-[var(--color-primary)]/25"
 >
 <Plus className="w-4 h-4" />
 <span>Nueva Cuenta Admin</span>
 </button>
 </PermissionGate>
 </div>
 </div>

 {/* Filter and Search Bar */}
 <div className="flex flex-col md:flex-row gap-2.5 justify-between items-center pb-4 border-b border-[var(--color-border-light)]">
 <div className="relative w-full md:w-80">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-main)]" />
 <input
 type="text"
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 placeholder="Buscar por nombre o teléfono..."
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] pl-9 pr-4 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
 />
 </div>

 <div className="flex gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
 {['all', 'client', 'business', 'driver', 'admin'].map((r) => (
 <button
 key={r}
 onClick={() => setRoleFilter(r)}
 className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${
 roleFilter === r
 ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
 : 'border-transparent text-[var(--color-text-main)] hover:text-[var(--color-text-main)]'
 }`}
 >
 {r === 'all' ? 'Todos los roles' : roleLabels[r]?.label}
 </button>
 ))}
 </div>
 </div>

 {loadError && (
 <p className="text-xs font-semibold text-[var(--color-danger)]">{loadError}</p>
 )}

 {/* Table */}
 {loading ? (
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
 Cargando listado de usuarios...
 </div>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="w-full">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Usuario</th>
 <th className="table-header-cell">Celular</th>
 <th className="table-header-cell">Rol / Cargo</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Último acceso</th>
 <th className="table-header-cell">Acciones</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-[var(--color-border-light)]">
 {users.map((u) => {
 const status: Status = u.status || (u.isBlocked ? 'blocked' : u.isActive ? 'active' : 'inactive');
 const isSelf = u._id === currentUserId;
 const positionName = refName(u.positionId);
 return (
 <tr key={u._id} className="hover:bg-[var(--color-bg)] transition-colors">
 <td className="table-body-cell">
 <div className="flex items-center gap-3">
 <div className="w-8 h-8 rounded-full bg-[var(--color-sidebar-hover)] flex items-center justify-center text-xs font-bold text-white select-none">
 {u.name?.charAt(0)?.toUpperCase() || '?'}
 </div>
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]"><EntityLink type="user" id={u._id}>{u.name}</EntityLink>{isSelf && <span className="ml-1.5 text-[9px] text-[var(--color-text-main)] font-normal">(tú)</span>}</p>
 {u.email && <p className="text-[10px] text-[var(--color-text-main)]">{u.email}</p>}
 </div>
 </div>
 </td>
 <td className="table-body-cell font-mono text-xs text-[var(--color-text-main)] font-medium">{u.phone}</td>
 <td className="table-body-cell">
 <button
 onClick={() => openRoleModal(u)}
 className={`inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer hover:underline underline-offset-2 ${roleLabels[u.role]?.classes || 'text-gray-700'}`}
 >
 {roleLabels[u.role]?.label || u.role}
 <UserCog className="w-3 h-3 opacity-50" />
 </button>
 {u.role === 'admin' && (
 <button
 onClick={() => openAccessModal(u)}
 className="flex items-center gap-1 text-[10px] text-[var(--color-text-main)] hover:text-[var(--color-primary)] cursor-pointer mt-0.5"
 >
 <Briefcase className="w-2.5 h-2.5" />
 {positionName || 'Sin cargo'}
 </button>
 )}
 </td>
 <td className="table-body-cell">
 <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${statusMeta[status].text}`}>
 <span className={`w-1.5 h-1.5 rounded-full ${statusMeta[status].dot}`} />
 {statusMeta[status].label}
 </span>
 </td>
 <td className="table-body-cell text-xs text-[var(--color-text-main)] font-mono">
 {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
 </td>
 <td className="table-body-cell">
 <div className="flex items-center gap-1.5 flex-wrap">
 <PermissionGate permission={Permission.USERS_VIEW}>
 <button
 onClick={() => openFicha('user', u._id)}
 title="Historial completo"
 className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
 >
 <History className="w-3.5 h-3.5" />
 </button>
 </PermissionGate>
 {u.role === 'admin' && (
 <PermissionGate permission={Permission.USERS_UPDATE}>
 <button
 onClick={() => openAccessModal(u)}
 title="Cargo y roles"
 className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
 >
 <Shield className="w-3.5 h-3.5" />
 </button>
 </PermissionGate>
 )}
 {!isSelf && (
 <PermissionGate permissions={[Permission.USERS_UPDATE, Permission.USERS_BLOCK]} any>
 {status !== 'active' && (
 <button
 onClick={() => setConfirmStatus({ user: u, status: 'active' })}
 className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase border bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-[var(--color-primary-bg)] hover:bg-[var(--color-primary-bg)] cursor-pointer"
 >
 Activar
 </button>
 )}
 {status === 'active' && (
 <button
 onClick={() => setConfirmStatus({ user: u, status: 'inactive' })}
 className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase border bg-[var(--color-bg)] text-[var(--color-text-main)] border-[var(--color-border)] hover:bg-[var(--color-bg-alt)] cursor-pointer"
 >
 Desactivar
 </button>
 )}
 {status !== 'blocked' ? (
 <button
 onClick={() => setConfirmStatus({ user: u, status: 'blocked' })}
 title="Bloquear"
 className="p-1.5 rounded-lg bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white transition-all cursor-pointer"
 >
 <Ban className="w-3.5 h-3.5" />
 </button>
 ) : (
 <button
 onClick={() => setConfirmStatus({ user: u, status: 'active' })}
 className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase border bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-bg)] hover:bg-[var(--color-danger)] hover:text-white cursor-pointer"
 >
 Desbloquear
 </button>
 )}
 </PermissionGate>
 )}
 {!isSelf && (
 <PermissionGate permission={Permission.USERS_UPDATE}>
 <button
 onClick={() => { setResetUser(u); setTempPassword(null); }}
 title="Restablecer contraseña"
 className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
 >
 <KeyRound className="w-3.5 h-3.5" />
 </button>
 </PermissionGate>
 )}
 {!isSelf && u.twoFactorEnabled && (
 <PermissionGate permission={Permission.USERS_RESET_2FA}>
 <button
 onClick={() => { setReset2faUser(u); setReset2faReason(''); setReset2faError(''); setReset2faTempPassword(null); }}
 title="Restablecer verificación en dos pasos"
 className="p-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
 >
 <ShieldOff className="w-3.5 h-3.5" />
 </button>
 </PermissionGate>
 )}
 </div>
 </td>
 </tr>
 );
 })}

 {users.length === 0 && (
 <tr>
 <td colSpan={6} className="px-6 py-12 text-center text-[var(--color-text-main)] text-xs font-medium">
 No se encontraron usuarios que coincidan con la búsqueda.
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
 </div>
 )}

 {/* Confirm status change */}
 {confirmStatus && (
 <ConfirmDialog
 title={
 confirmStatus.status === 'blocked' ? 'Bloquear Usuario'
 : confirmStatus.status === 'inactive' ? 'Desactivar Usuario'
 : 'Activar Usuario'
 }
 message={
 confirmStatus.status === 'blocked'
 ? `¿Deseas bloquear a ${confirmStatus.user.name}? Perderá acceso de inmediato y sus sesiones activas se cerrarán.`
 : confirmStatus.status === 'inactive'
 ? `¿Deseas desactivar a ${confirmStatus.user.name}? Perderá acceso al sistema.`
 : `¿Deseas activar la cuenta de ${confirmStatus.user.name}?`
 }
 confirmLabel={confirmStatus.status === 'blocked' ? 'Bloquear' : confirmStatus.status === 'inactive' ? 'Desactivar' : 'Activar'}
 onConfirm={applyStatus}
 onCancel={() => setConfirmStatus(null)}
 variant={confirmStatus.status === 'active' ? 'default' : 'danger'}
 />
 )}

 {/* Confirm role change */}
 {confirmRoleChange && editingUser && (
 <ConfirmDialog
 title="Cambiar Rol de Usuario"
 message={`¿Confirmas cambiar el rol de"${editingUser.name}" a"${roles.find((r) => r.value === selectedRole)?.label}"?`}
 confirmLabel="Cambiar Rol"
 onConfirm={confirmHandleSaveRole}
 onCancel={() => setConfirmRoleChange(false)}
 variant="warning"
 />
 )}

 {/* Role Modal */}
 {editingUser && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div ref={modalRef} className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <div className="flex items-center gap-2">
 <Shield className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Tipo de Cuenta</h3>
 </div>
 <button onClick={() => setEditingUser(null)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <div className="pb-3 border-b border-[var(--color-border-light)] flex items-center gap-3">
 <div className="w-9 h-9 rounded-full bg-[var(--color-sidebar-hover)] flex items-center justify-center text-xs font-bold text-white">
 {editingUser.name?.charAt(0)?.toUpperCase()}
 </div>
 <div>
 <p className="text-xs font-bold text-[var(--color-text-main)]">{editingUser.name}</p>
 <p className="text-[10px] text-[var(--color-text-main)] font-mono">{editingUser.phone}</p>
 </div>
 </div>

 <div className="space-y-2">
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-2">Selecciona el tipo de cuenta</label>
 {roles.map((role) => {
 const isSelected = selectedRole === role.value;
 return (
 <button
 key={role.value}
 onClick={() => setSelectedRole(role.value)}
 className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer text-left ${
 isSelected
 ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)] text-[var(--color-primary)] shadow-xs'
 : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] text-[var(--color-text-main)]'
 }`}
 >
 <role.icon className={`w-5 h-5 ${isSelected ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-main)]'}`} />
 <div className="flex-1 min-w-0">
 <p className="text-xs font-bold text-[var(--color-text-main)]">{role.label}</p>
 <p className="text-[10px] opacity-80 text-[var(--color-text-main)]">{role.description}</p>
 </div>
 </button>
 );
 })}
 </div>

 <div className="flex gap-2 pt-2">
 <button
 onClick={() => setEditingUser(null)}
 className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer"
 >
 Cancelar
 </button>
 <button
 onClick={handleSaveRole}
 disabled={saving || selectedRole === editingUser.role}
 className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-all cursor-pointer"
 >
 {saving ? 'Guardando...' : 'Guardar'}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Cargo y Roles (RBAC) */}
 {accessUser && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5 max-h-[90vh] overflow-y-auto">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <div className="flex items-center gap-2">
 <Shield className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Cargo y Roles — {accessUser.name}</h3>
 </div>
 <button onClick={() => setAccessUser(null)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 <div>
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5">Cargo</label>
 <select
 value={accessForm.positionId}
 onChange={(e) => setAccessForm((f) => ({ ...f, positionId: e.target.value }))}
 className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
 >
 <option value="">Sin cargo</option>
 {allPositions.map((p) => (
 <option key={p._id} value={p._id}>{p.name}</option>
 ))}
 </select>
 </div>

 <div>
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-2">Roles adicionales</label>
 <div className="space-y-1.5 max-h-40 overflow-y-auto divide-y divide-[var(--color-border-light)] border-y border-[var(--color-border-light)] py-1">
 {allRoles.length === 0 && <p className="text-xs text-[var(--color-text-main)] p-2">No hay roles disponibles.</p>}
 {allRoles.map((r) => {
 const checked = accessForm.roleIds.includes(r._id);
 return (
 <label key={r._id} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer select-none text-xs font-medium ${checked ? 'bg-[var(--color-primary-bg)] text-[#8A5D08]' : 'hover:bg-[var(--color-bg)] text-[var(--color-text-main)]'}`}>
 <input type="checkbox" checked={checked} onChange={() => toggleAccessRole(r._id)} className="w-3.5 h-3.5 rounded border-[var(--color-border)] text-[var(--color-primary)]" />
 {r.name}
 </label>
 );
 })}
 </div>
 </div>

 {effectivePermissions.length > 0 && (
 <div>
 <label className="block text-[11px] font-bold text-[var(--color-text-main)] uppercase tracking-wider mb-1.5">
 Permisos efectivos actuales ({effectivePermissions.length})
 </label>
 <div className="flex flex-wrap gap-x-2 gap-y-1 max-h-24 overflow-y-auto">
 {effectivePermissions.map((p) => (
 <span key={p} className="text-[9px] font-mono text-[var(--color-text-main)]">{p}</span>
 ))}
 </div>
 </div>
 )}

 {/* Solo se conoce lo que perdería la propia cuenta (viene de /auth/me);
 lo de las demás personas está en Roles > Revisión de accesos. */}
 {authzMode === 'observe' && accessUser._id === currentUserId && observedPermissions.length > 0 && (
 <div>
 <label className="block text-[11px] font-bold text-[var(--color-warning)] uppercase tracking-wider mb-1.5">
 Perdería al activar el bloqueo ({observedPermissions.length})
 </label>
 <div className="flex flex-wrap gap-x-2 gap-y-1 max-h-24 overflow-y-auto">
 {observedPermissions.map((p) => (
 <span key={p} className="text-[9px] font-mono text-[var(--color-text-main)]">{p}</span>
 ))}
 </div>
 </div>
 )}

 <div className="flex gap-2 pt-2">
 <button onClick={() => setAccessUser(null)} className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer">
 Cancelar
 </button>
 <button onClick={saveAccess} disabled={saving} className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-all cursor-pointer">
 {saving ? 'Guardando...' : 'Guardar Acceso'}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Restablecer contraseña */}
 {resetUser && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-sm rounded-2xl p-6 space-y-2.5">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <div className="flex items-center gap-2">
 <KeyRound className="w-5 h-5 text-[var(--color-primary)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Restablecer Contraseña</h3>
 </div>
 <button onClick={() => { setResetUser(null); setTempPassword(null); }} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>

 {!tempPassword ? (
 <>
 <p className="text-xs text-[var(--color-text-main)]">
 Se generará una contraseña temporal para <strong>{resetUser.name}</strong> y se cerrarán todas sus sesiones activas. Deberás entregársela por un canal seguro.
 </p>
 <div className="flex gap-2 pt-2">
 <button onClick={() => setResetUser(null)} className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer">
 Cancelar
 </button>
 <button onClick={doResetPassword} disabled={saving} className="flex-1 py-2 rounded-lg bg-[var(--color-warning)] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-all cursor-pointer">
 {saving ? 'Generando...' : 'Restablecer'}
 </button>
 </div>
 </>
 ) : (
 <>
 <p className="text-xs text-[var(--color-text-main)]">
 Contraseña temporal generada. No se volverá a mostrar: cópiala ahora. Caduca en 24 horas y la persona tendrá que cambiarla al entrar.
 </p>
 <div className="flex items-center gap-2 border-y border-[var(--color-border-light)] py-3">
 <code className="flex-1 text-xs font-mono text-[var(--color-text-main)] break-all">{tempPassword}</code>
 <button
 onClick={() => { navigator.clipboard?.writeText(tempPassword); setToast({ message: 'Copiado al portapapeles', type: 'success' }); }}
 className="p-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-primary)] cursor-pointer"
 >
 <Copy className="w-3.5 h-3.5" />
 </button>
 </div>
 <button
 onClick={() => { setResetUser(null); setTempPassword(null); }}
 className="w-full py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold uppercase tracking-wider cursor-pointer"
 >
 Listo
 </button>
 </>
 )}
 </div>
 </div>
 )}

 {/* Restablecer 2FA */}
 {reset2faUser && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-sm rounded-2xl p-6 space-y-3">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <div className="flex items-center gap-2">
 <ShieldOff className="w-5 h-5 text-[var(--color-danger)]" />
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Restablecer verificación en dos pasos</h3>
 </div>
 <button onClick={() => { setReset2faUser(null); setReset2faTempPassword(null); }} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>
 {!reset2faTempPassword ? (
 <>
 <p className="text-xs text-[var(--color-text-main)] leading-relaxed">
 Se quitará el 2FA de <strong>{reset2faUser.name}</strong>, su contraseña se cambiará por una temporal y se cerrarán todas sus sesiones. Hazlo solo si perdió el celular <strong>y</strong> sus códigos de recuperación, y después de verificar su identidad por un canal distinto al de quien lo pide (por ejemplo, devolviendo la llamada al teléfono registrado).
 </p>
 <p className="text-xs text-[var(--color-text-main)] leading-relaxed">
 Cambiar la contraseña evita que alguien que ya la tenga entre primero y registre su propio autenticador.
 </p>
 <textarea
 value={reset2faReason}
 onChange={(e) => { setReset2faReason(e.target.value); setReset2faError(''); }}
 rows={3}
 maxLength={500}
 placeholder="Motivo y canal de verificación (no escribas números de documento)"
 className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
 />
 {reset2faError && <p className="text-xs font-medium text-[var(--color-danger)]">{reset2faError}</p>}
 <div className="flex gap-2 pt-1">
 <button onClick={() => setReset2faUser(null)} className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer">
 Cancelar
 </button>
 <button onClick={doResetTwoFactor} disabled={saving} className="flex-1 py-2 rounded-lg bg-[var(--color-danger)] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-all cursor-pointer">
 {saving ? 'Restableciendo...' : 'Restablecer'}
 </button>
 </div>
 </>
 ) : (
 <>
 <p className="text-xs text-[var(--color-text-main)] leading-relaxed">
 2FA quitado y sesiones cerradas. Entrégale esta contraseña temporal <strong>solo por el canal donde verificaste su identidad</strong>. No se volverá a mostrar y caduca en 24 horas. Al entrar, si el 2FA es obligatorio para su cuenta, lo activará de nuevo con su nuevo celular.
 </p>
 <div className="flex items-center gap-2 border-y border-[var(--color-border-light)] py-3">
 <code className="flex-1 text-xs font-mono text-[var(--color-text-main)] break-all">{reset2faTempPassword}</code>
 <button
 onClick={() => { navigator.clipboard?.writeText(reset2faTempPassword); setToast({ message: 'Copiado al portapapeles', type: 'success' }); }}
 className="p-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:text-[var(--color-primary)] cursor-pointer"
 >
 <Copy className="w-3.5 h-3.5" />
 </button>
 </div>
 <button
 onClick={() => { setReset2faUser(null); setReset2faTempPassword(null); }}
 className="w-full py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold uppercase tracking-wider cursor-pointer"
 >
 Listo
 </button>
 </>
 )}
 </div>
 </div>
 )}

 {/* Crear cuenta administrativa */}
 {creatingStaff && (
 <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
 <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5 max-h-[90vh] overflow-y-auto">
 <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-3">
 <h3 className="text-base font-bold text-[var(--color-text-main)]">Nueva Cuenta Administrativa</h3>
 <button onClick={() => setCreatingStaff(false)} className="text-[var(--color-text-main)] hover:text-[var(--color-text-main)] p-1 rounded-lg cursor-pointer">
 <X className="w-5 h-5" />
 </button>
 </div>
 <div className="space-y-3">
 <input placeholder="Nombre completo" value={staffForm.name} onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))} className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs" />
 <input placeholder="Correo (con esto entra al panel)" type="email" value={staffForm.email} onChange={(e) => setStaffForm((f) => ({ ...f, email: e.target.value }))} className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs" />
 <input placeholder="Celular (opcional)" value={staffForm.phone} onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))} className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs" />
 <input placeholder="Contraseña inicial" type="password" value={staffForm.password} onChange={(e) => setStaffForm((f) => ({ ...f, password: e.target.value }))} className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs" />
 <select value={staffForm.positionId} onChange={(e) => setStaffForm((f) => ({ ...f, positionId: e.target.value }))} className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs">
 <option value="">Sin cargo (asignar después)</option>
 {allPositions.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
 </select>
 </div>
 <div className="flex gap-2 pt-2">
 <button onClick={() => setCreatingStaff(false)} className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer">
 Cancelar
 </button>
 <button onClick={createStaffUser} disabled={saving} className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-all cursor-pointer">
 {saving ? 'Creando...' : 'Crear Cuenta'}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Toast Notification */}
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
