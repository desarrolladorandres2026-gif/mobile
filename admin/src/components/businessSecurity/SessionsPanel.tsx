import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import { Permission } from '../../lib/permissions';
import { useAuthStore } from '../../stores/authStore';
import Pagination from '../Pagination';
import { DeviceCell, MfaMark, StateLine, UserCell } from './shared';
import { REASON_LABELS, STATUS_STYLES, dangerLink, dateTime, filterInput, filterLabel, linkButton } from './labels';
import type { PageInfo, SecuritySummary, SessionFilters, SessionRow } from './types';

interface Props {
  businessId: string;
  members: SecuritySummary['members'];
  filters: SessionFilters;
  onFiltersChange: (next: SessionFilters) => void;
  onRevoke: (session: SessionRow) => void;
  onRevokeUser: (userId: string, name: string) => void;
  onOpenDevice: (recordId: string) => void;
}

/** Sesiones del dueño y del personal activo, con filtros y paginación del servidor. */
export default function SessionsPanel({ businessId, members, filters, onFiltersChange, onRevoke, onRevokeUser, onOpenDevice }: Props) {
  const [page, setPage] = useState(1);
  // Texto libre e IP se aplican al pulsar Enter o salir del campo, no a cada
  // tecla: cada tecla sería una consulta al servidor.
  const [search, setSearch] = useState(filters.search);
  const [ip, setIp] = useState(filters.ip);
  const canManage = useAuthStore((s) => s.hasPermission(Permission.SECURITY_MANAGE));

  const { data, isLoading, error } = useQuery({
    queryKey: ['business-security', businessId, 'sessions', filters, page],
    queryFn: async () => {
      const params: Record<string, string | number> = { status: filters.status, page, limit: 20 };
      if (filters.userId) params.userId = filters.userId;
      if (filters.search.trim()) params.search = filters.search.trim();
      if (filters.ip.trim()) params.ip = filters.ip.trim();
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.unidentified) params.unidentified = 'true';
      const res = await api.get(`/admin/businesses/${businessId}/security/sessions`, { params });
      return res.data.data as { sessions: SessionRow[]; pagination: PageInfo };
    },
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const set = (patch: Partial<SessionFilters>) => {
    setPage(1);
    onFiltersChange({ ...filters, ...patch });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>Estado</span>
          <select value={filters.status} onChange={(e) => set({ status: e.target.value as SessionFilters['status'] })} className={filterInput}>
            <option value="active">Activas</option>
            <option value="revoked">Revocadas</option>
            <option value="expired">Expiradas</option>
            <option value="all">Todas</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>Usuario</span>
          <select value={filters.userId} onChange={(e) => set({ userId: e.target.value })} className={filterInput}>
            <option value="">Todos</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        </label>
        <label className="min-w-[14rem] flex-1 space-y-1">
          <span className={`block ${filterLabel}`}>Buscar</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => search !== filters.search && set({ search })}
            onKeyDown={(e) => e.key === 'Enter' && set({ search })}
            placeholder="Correo, nombre o id de dispositivo · Enter"
            className={`${filterInput} w-full`}
          />
        </label>
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>IP</span>
          <input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            onBlur={() => ip !== filters.ip && set({ ip })}
            onKeyDown={(e) => e.key === 'Enter' && set({ ip })}
            placeholder="181.50.1.10"
            className={`${filterInput} w-36`}
          />
        </label>
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>Desde</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} className={filterInput} />
        </label>
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>Hasta</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} className={filterInput} />
        </label>
        <label className="flex h-9 cursor-pointer items-center gap-2 text-xs text-[var(--color-text-main)]">
          <input type="checkbox" checked={filters.unidentified} onChange={(e) => set({ unidentified: e.target.checked })} />
          Solo sin identificar
        </label>
      </div>

      <StateLine
        loading={isLoading}
        error={error ? apiMessage(error, 'No se pudieron cargar las sesiones.') : ''}
        empty={!!data && data.sessions.length === 0}
      >
        <div className="table-container overflow-x-auto">
          <table className="data-grid min-w-[960px]">
            <thead>
              <tr>
                <th className="table-header-cell text-left">Usuario</th>
                <th className="table-header-cell text-left">Dispositivo</th>
                <th className="table-header-cell text-left">IP</th>
                <th className="table-header-cell text-left">Inicio</th>
                <th className="table-header-cell text-left">Última actividad</th>
                <th className="table-header-cell text-left">Expira</th>
                <th className="table-header-cell text-left">Estado</th>
                <th className="table-header-cell text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data?.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="table-body-cell max-w-[14rem]"><UserCell user={s.user} /></td>
                  <td className="table-body-cell max-w-[16rem]"><DeviceCell device={s.device} /></td>
                  <td className="table-body-cell tabular text-[11px]">
                    {s.ip}
                    {s.lastIp !== s.ip && <p className="text-[var(--color-text-main)]" title="La sesión cambió de red">ahora {s.lastIp}</p>}
                  </td>
                  <td className="table-body-cell text-[11px]">{dateTime(s.createdAt)}</td>
                  <td className="table-body-cell text-[11px]">{dateTime(s.lastActivity)}</td>
                  <td className="table-body-cell text-[11px]">{s.status === 'revoked' ? '—' : dateTime(s.expiresAt)}</td>
                  <td className="table-body-cell">
                    <p className={`text-xs font-bold ${STATUS_STYLES[s.status].text}`}>{STATUS_STYLES[s.status].label}</p>
                    {s.mfa && <MfaMark />}
                    {s.status === 'revoked' && s.revokedReason && (
                      <p className="text-[11px] text-[var(--color-text-secondary)]">
                        {s.revokedBy ? `${s.revokedBy.name}` : REASON_LABELS[s.revokedReason] ?? s.revokedReason}
                      </p>
                    )}
                  </td>
                  <td className="table-body-cell">
                    <div className="flex flex-col items-end gap-1">
                      {s.device.recordId && (
                        <button type="button" onClick={() => onOpenDevice(s.device.recordId!)} className={linkButton}>Dispositivo</button>
                      )}
                      {canManage && s.status === 'active' && (
                        <>
                          <button type="button" onClick={() => onRevoke(s)} className={dangerLink}>Cerrar sesión</button>
                          <button type="button" onClick={() => onRevokeUser(s.user.id, s.user.name)} className={dangerLink}>Cerrar todas de {s.user.name.split(' ')[0]}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && (
            <Pagination page={data.pagination.page} totalPages={data.pagination.pages} total={data.pagination.total} limit={data.pagination.limit} onPageChange={setPage} />
          )}
        </div>
      </StateLine>
    </div>
  );
}
