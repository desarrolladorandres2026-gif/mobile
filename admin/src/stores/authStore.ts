import { create } from 'zustand';
import api from '../services/api';

/**
 * Fuente única de "qué puede ver/hacer este admin" en el frontend.
 *
 * IMPORTANTE: esto es solo para UX (ocultar botones, condicionar rutas).
 * El backend vuelve a validar cada permiso en cada request — ver
 * `requirePermission` en el backend. Nada de lo que hay aquí es una
 * frontera de seguridad real.
 */

export interface AdminUser {
  _id: string;
  name: string;
  phone: string;
  email?: string;
  role: string;
  /** Solo quien lo tiene puede mover dinero (`requireFinanceAdmin` en el backend). */
  isFinanceAdmin?: boolean;
  isActive: boolean;
  isBlocked?: boolean;
  status?: 'active' | 'inactive' | 'blocked';
  positionId?: { _id: string; name: string; slug: string } | string | null;
  roleIds?: Array<{ _id: string; name: string; slug: string } | string>;
}

interface AuthState {
  user: AdminUser | null;
  permissions: string[];
  roleSlugs: string[];
  authzMode: 'observe' | 'enforce';
  /** Permisos que hoy usa por la unión antigua y perderá al activar el bloqueo. */
  observedPermissions: string[];
  hydrated: boolean;
  setSession: (
    user: AdminUser,
    permissions: string[],
    roleSlugs: string[],
    authz?: { authzMode?: 'observe' | 'enforce'; observedPermissions?: string[] },
  ) => void;
  refresh: () => Promise<void>;
  clear: () => void;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: string[]) => boolean;
  hasAllPermissions: (permissions: string[]) => boolean;
  hasRole: (slug: string) => boolean;
}

function loadFromStorage(): {
  user: AdminUser | null;
  permissions: string[];
  roleSlugs: string[];
  authzMode: 'observe' | 'enforce';
  observedPermissions: string[];
} {
  try {
    const userStr = localStorage.getItem('admin_user');
    const permStr = localStorage.getItem('admin_permissions');
    const roleStr = localStorage.getItem('admin_role_slugs');
    const modeStr = localStorage.getItem('admin_authz_mode');
    const obsStr = localStorage.getItem('admin_observed_permissions');
    return {
      user: userStr ? JSON.parse(userStr) : null,
      permissions: permStr ? JSON.parse(permStr) : [],
      roleSlugs: roleStr ? JSON.parse(roleStr) : [],
      authzMode: modeStr === 'observe' ? 'observe' : 'enforce',
      observedPermissions: obsStr ? JSON.parse(obsStr) : [],
    };
  } catch {
    return { user: null, permissions: [], roleSlugs: [], authzMode: 'enforce', observedPermissions: [] };
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ...loadFromStorage(),
  hydrated: false,

  setSession: (user, permissions, roleSlugs, authz) => {
    const authzMode = authz?.authzMode === 'observe' ? 'observe' : 'enforce';
    const observedPermissions = authz?.observedPermissions ?? [];
    localStorage.setItem('admin_user', JSON.stringify(user));
    localStorage.setItem('admin_permissions', JSON.stringify(permissions));
    localStorage.setItem('admin_role_slugs', JSON.stringify(roleSlugs));
    localStorage.setItem('admin_authz_mode', authzMode);
    localStorage.setItem('admin_observed_permissions', JSON.stringify(observedPermissions));
    set({ user, permissions, roleSlugs, authzMode, observedPermissions, hydrated: true });
  },

  /**
   * Reconsulta `/auth/me`. Se llama al montar el panel para que un cambio
   * de rol/permiso hecho por otro administrador se refleje sin tener que
   * volver a iniciar sesión — el backend recalcula los permisos efectivos
   * en cada request, así que basta con volver a pedirlos.
   */
  refresh: async () => {
    try {
      const { data } = await api.get('/auth/me');
      const { user, permissions, roleSlugs, authzMode, observedPermissions } = data.data;
      get().setSession(user, permissions || [], roleSlugs || [], { authzMode, observedPermissions });
    } catch {
      // authStore no decide qué hacer con un 401 — el interceptor de
      // api.ts ya redirige a /login.
    } finally {
      set({ hydrated: true });
    }
  },

  clear: () => {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_refresh_token');
    localStorage.removeItem('admin_user');
    localStorage.removeItem('admin_permissions');
    localStorage.removeItem('admin_role_slugs');
    localStorage.removeItem('admin_authz_mode');
    localStorage.removeItem('admin_observed_permissions');
    set({ user: null, permissions: [], roleSlugs: [], authzMode: 'enforce', observedPermissions: [], hydrated: true });
  },

  // Borrar solo el navegador dejaba el refresh token vivo en el servidor.
  logout: async () => {
    const refreshToken = localStorage.getItem('admin_refresh_token') ?? undefined;
    try {
      await api.post('/auth/logout', { refreshToken });
    } catch {
      // Sin red o con la sesión ya caducada: igual se limpia el navegador.
    } finally {
      get().clear();
    }
  },

  // En observación el backend todavía deja pasar lo observado: la interfaz
  // también, para que nadie pierda una pantalla antes de que se active el bloqueo.
  hasPermission: (permission) => {
    const s = get();
    return s.permissions.includes(permission) || (s.authzMode === 'observe' && s.observedPermissions.includes(permission));
  },
  hasAnyPermission: (permissions) => permissions.some((p) => get().hasPermission(p)),
  hasAllPermissions: (permissions) => permissions.every((p) => get().hasPermission(p)),
  hasRole: (slug) => get().roleSlugs.includes(slug),
}));
