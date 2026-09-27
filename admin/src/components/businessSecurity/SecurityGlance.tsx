import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import { dateTime } from './labels';
import type { SecuritySummary } from './types';

/**
 * La sección "Seguridad" de la ficha del comercio: lo justo para saber, sin
 * abrir nada más, si hay sesiones abiertas que nadie reconoce. El detalle vive
 * en `/businesses/:id/security`.
 */
export default function SecurityGlance({ businessId }: { businessId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['business-security', businessId, 'summary'],
    queryFn: async () => (await api.get(`/admin/businesses/${businessId}/security/summary`)).data.data as SecuritySummary,
    staleTime: 10_000,
  });

  if (isLoading) return <p className="text-[var(--color-text-secondary)]">Cargando…</p>;
  if (error || !data) return <p className="font-semibold text-[var(--color-danger)]">{apiMessage(error, 'No se pudo cargar la seguridad del comercio.')}</p>;

  const owner = data.members.find((m) => m.businessRole === 'owner');
  const withoutTwoFactor = data.members.filter((m) => !m.twoFactorEnabled).length;

  return (
    <div className="space-y-3">
      {data.unknownActiveSessions > 0 && (
        <p className="flex items-start gap-1.5 font-semibold text-[var(--color-warning)]">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {data.unknownActiveSessions === 1
            ? '1 sesión abierta desde un dispositivo nuevo o sin identificar.'
            : `${data.unknownActiveSessions} sesiones abiertas desde dispositivos nuevos o sin identificar.`}
        </p>
      )}
      <ul className="space-y-1.5 text-[var(--color-text-main)]">
        <li>
          {data.activeSessions === 1 ? '1 sesión abierta' : `${data.activeSessions} sesiones abiertas`} · {data.knownDevices} dispositivos conocidos
        </li>
        <li>
          {data.failedAttempts7d === 0 ? 'Sin accesos fallidos esta semana' : `${data.failedAttempts7d} accesos fallidos en 7 días`}
        </li>
        <li>
          {owner?.twoFactorEnabled ? 'El dueño usa verificación en dos pasos' : 'El dueño no usa verificación en dos pasos'}
          {withoutTwoFactor > 0 && data.members.length > 1 ? ` · ${withoutTwoFactor} de ${data.members.length} cuentas sin 2FA` : ''}
        </li>
        {data.lastSuccessfulLogin && (
          <li className="text-[var(--color-text-secondary)]">
            Último acceso: {data.lastSuccessfulLogin.user.name}, {dateTime(data.lastSuccessfulLogin.createdAt)}
          </li>
        )}
      </ul>
      <Link to={`/businesses/${businessId}/security`} className="inline-block text-xs font-bold text-[var(--color-primary)] hover:underline">
        Abrir centro de seguridad
      </Link>
    </div>
  );
}
