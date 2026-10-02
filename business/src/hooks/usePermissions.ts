import { useQuery } from '@tanstack/react-query';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import type { BusinessPermission, MyAccess } from '../lib/permissions';

/**
 * Papel y permisos de quien está conectado en el local seleccionado.
 *
 * `GET /businesses/:id/my-permissions` existía desde que se crearon los
 * empleados y nadie lo leía: el panel le enseñaba al mostrador el menú del
 * dueño y cada pantalla le respondía 403.
 */
export function usePermissions(businessId: string | undefined) {
  const query = useQuery({
    queryKey: qk.permissions(businessId),
    enabled: !!businessId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MyAccess> => {
      const data = (await api.get(`/businesses/${businessId}/my-permissions`)).data.data ?? {};
      return { role: data.role ?? null, permissions: data.permissions ?? [] };
    },
  });
  const access = query.data;
  return {
    access,
    /** Sin respuesta todavía se asume que sí: ver `canSee`. */
    can: (permission: BusinessPermission) => !access || access.permissions.includes(permission),
  };
}
