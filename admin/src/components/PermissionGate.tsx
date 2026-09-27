import type { ReactNode } from 'react';
import { useAuthStore } from '../stores/authStore';

interface PermissionGateProps {
 /** Requiere TODOS estos permisos. */
 permission?: string;
 permissions?: string[];
 /** Si se da junto a `permissions`, basta con UNO de ellos. */
 any?: boolean;
 role?: string;
 children: ReactNode;
 /** Qué mostrar si no tiene el permiso (por defecto, nada). */
 fallback?: ReactNode;
}

/**
 * Oculta contenido según los permisos efectivos del admin autenticado.
 *
 * Es azúcar de UX, no seguridad: el backend vuelve a exigir el permiso en
 * cada endpoint (`requirePermission`). Reutilizar este componente evita
 * repetir `hasPermission(...)` a mano por todo el panel.
 */
export function PermissionGate({ permission, permissions, any, role, children, fallback = null }: PermissionGateProps) {
 const { hasPermission, hasAnyPermission, hasAllPermissions, hasRole } = useAuthStore();

 if (permission && !hasPermission(permission)) return <>{fallback}</>;
 if (permissions && permissions.length > 0) {
 const ok = any ? hasAnyPermission(permissions) : hasAllPermissions(permissions);
 if (!ok) return <>{fallback}</>;
 }
 if (role && !hasRole(role)) return <>{fallback}</>;

 return <>{children}</>;
}
