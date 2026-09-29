import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import Pagination from '../Pagination';
import { DeviceCell, StateLine, UserCell } from './shared';
import { dateTime, filterInput, filterLabel, linkButton } from './labels';
import type { DeviceRow, PageInfo, SecuritySummary } from './types';

interface Props {
  businessId: string;
  members: SecuritySummary['members'];
  onOpenDevice: (recordId: string) => void;
}

/** Todos los dispositivos que alguna vez entraron con una cuenta del negocio. */
export default function DevicesPanel({ businessId, members, onOpenDevice }: Props) {
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['business-security', businessId, 'devices', userId, page],
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: 20 };
      if (userId) params.userId = userId;
      const res = await api.get(`/admin/businesses/${businessId}/security/devices`, { params });
      return res.data.data as { devices: DeviceRow[]; pagination: PageInfo };
    },
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  return (
    <div className="space-y-4">
      <label className="inline-block space-y-1">
        <span className={`block ${filterLabel}`}>Usuario</span>
        <select value={userId} onChange={(e) => { setPage(1); setUserId(e.target.value); }} className={filterInput}>
          <option value="">Todos</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </select>
      </label>

      <StateLine
        loading={isLoading}
        error={error ? apiMessage(error, 'No se pudieron cargar los dispositivos.') : ''}
        empty={!!data && data.devices.length === 0}
      >
        <div className="table-container overflow-x-auto">
          <table className="data-grid min-w-[880px]">
            <thead>
              <tr>
                <th className="table-header-cell text-left">Dispositivo</th>
                <th className="table-header-cell text-left">Usuario</th>
                <th className="table-header-cell text-left">Visto por primera vez</th>
                <th className="table-header-cell text-left">Última vez</th>
                <th className="table-header-cell text-left">IP</th>
                <th className="table-header-cell text-right">Inicios</th>
                <th className="table-header-cell text-right">Sesiones abiertas</th>
                <th className="table-header-cell" />
              </tr>
            </thead>
            <tbody>
              {data?.devices.map((d) => (
                <tr key={d.id}>
                  <td className="table-body-cell max-w-[16rem]"><DeviceCell device={d} /></td>
                  <td className="table-body-cell max-w-[14rem]"><UserCell user={d.user} /></td>
                  <td className="table-body-cell text-[11px]">{dateTime(d.firstSeen)}</td>
                  <td className="table-body-cell text-[11px]">{dateTime(d.lastSeen)}</td>
                  <td className="table-body-cell tabular text-[11px]">
                    {d.lastIp ?? '—'}
                    {d.firstIp && d.firstIp !== d.lastIp && <p className="text-[var(--color-text-secondary)]">antes {d.firstIp}</p>}
                  </td>
                  <td className="table-body-cell tabular text-right">{d.loginCount}</td>
                  <td className={`table-body-cell tabular text-right ${d.activeSessions > 0 ? 'font-bold' : 'text-[var(--color-text-secondary)]'}`}>{d.activeSessions}</td>
                  <td className="table-body-cell text-right">
                    <button type="button" onClick={() => onOpenDevice(d.id)} className={linkButton}>Detalle</button>
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
