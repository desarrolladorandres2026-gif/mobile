import type { ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { firstAccessiblePath } from '../lib/navigation';
import { permissionLabel } from '../lib/authzShadow';

/** Pantalla para quien todavía no tiene ningún permiso asignado. */
export function NoRoleScreen() {
 const navigate = useNavigate();
 const logout = useAuthStore((s) => s.logout);
 return (
 <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] px-6">
 <div className="max-w-md text-center space-y-4">
 <h1 className="text-lg font-bold text-[var(--color-text-main)]">Sin rol asignado</h1>
 <p className="text-sm text-[var(--color-text-main)]">
 Aún no tienes un rol asignado. Pide a un Super Administrador que te lo asigne.
 </p>
 <button
 onClick={async () => {
 await logout();
 navigate('/login');
 }}
 className="px-4 py-2 bg-[var(--color-primary)] text-white text-xs font-bold rounded-lg cursor-pointer"
 >
 Cerrar sesión
 </button>
 </div>
 </div>
 );
}

/** Envuelve una ruta: sin el permiso muestra"Sin acceso" (o, en el inicio, redirige). */
export default function RequireAccess({
 permission,
 redirectHome,
 children,
}: {
 permission: string;
 /** En `/`: si falta el permiso, ir a la primera pantalla permitida. */
 redirectHome?: boolean;
 children: ReactNode;
}) {
 const hasPermission = useAuthStore((s) => s.hasPermission);
 // Suscripción para re-renderizar cuando cambian los permisos.
 useAuthStore((s) => s.permissions);
 if (hasPermission(permission)) return <>{children}</>;
 if (redirectHome) {
 const first = firstAccessiblePath(hasPermission);
 if (first && first !== '/') return <Navigate to={first} replace />;
 }
 return (
 <div className="py-16 max-w-lg">
 <h1 className="text-base font-bold text-[var(--color-text-main)]">Sin acceso</h1>
 <p className="text-sm text-[var(--color-text-main)] mt-2">
 Tu rol no incluye el permiso necesario para esta pantalla ({permissionLabel(permission)}). Pídelo a un
 Super Administrador.
 </p>
 </div>
 );
}
