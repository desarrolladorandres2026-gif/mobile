import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import api from '../../services/api';
import { apiMessage } from '../../lib/apiError';
import Pagination from '../Pagination';
import { StateLine } from './shared';
import { EVENT_LABELS, EVENT_TYPES, FAILURE_TYPES, METHOD_LABELS, REASON_LABELS, dateTime, deviceLabel, filterInput, filterLabel } from './labels';
import type { EventFilters, PageInfo, SecurityEventRow, SecuritySummary } from './types';

interface Props {
  businessId: string;
  members: SecuritySummary['members'];
  filters: EventFilters;
  onFiltersChange: (next: EventFilters) => void;
}

const RESULT_TEXT: Record<string, string> = {
  success: 'text-[var(--color-success)]',
  failure: 'text-[var(--color-danger)]',
  info: 'text-[var(--color-text-main)]',
};

/** Una línea de detalle legible a partir del motivo, la nota y los metadatos. */
function detailOf(e: SecurityEventRow): string {
  const parts: string[] = [];
  const meta = e.metadata ?? {};
  if (typeof meta.method === 'string') parts.push(METHOD_LABELS[meta.method] ?? meta.method);
  if (meta.identified === false) parts.push('dispositivo sin identificar');
  if (typeof meta.count === 'number' && meta.count > 1) parts.push(`${meta.count} sesiones`);
  if (typeof meta.previousIp === 'string') parts.push(`antes ${meta.previousIp}`);
  if (meta.locked === true) parts.push('reto bloqueado por intentos');
  if (e.reason && e.reason !== 'admin') parts.push(REASON_LABELS[e.reason] ?? e.reason);
  if (e.actor) parts.push(`por ${e.actor.name}`);
  if (e.note) parts.push(`«${e.note}»`);
  return parts.join(' · ');
}

/** Historial inmutable de la cuenta del dueño y de su personal (12 meses). */
export default function EventsPanel({ businessId, members, filters, onFiltersChange }: Props) {
  const [page, setPage] = useState(1);
  const [ip, setIp] = useState(filters.ip);

  const { data, isLoading, error } = useQuery({
    queryKey: ['business-security', businessId, 'events', filters, page],
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: 25 };
      if (filters.type) params.type = filters.type;
      if (filters.userId) params.userId = filters.userId;
      if (filters.ip.trim()) params.ip = filters.ip.trim();
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      const res = await api.get(`/admin/businesses/${businessId}/security/events`, { params });
      return res.data.data as { events: SecurityEventRow[]; pagination: PageInfo };
    },
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const set = (patch: Partial<EventFilters>) => {
    setPage(1);
    onFiltersChange({ ...filters, ...patch });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>Evento</span>
          <select value={filters.type} onChange={(e) => set({ type: e.target.value })} className={filterInput}>
            <option value="">Todos</option>
            <option value={FAILURE_TYPES}>Solo fallos y cierres forzados</option>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className={`block ${filterLabel}`}>Usuario</span>
          <select value={filters.userId} onChange={(e) => set({ userId: e.target.value })} className={filterInput}>
            <option value="">Todos</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
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
      </div>

      <StateLine
        loading={isLoading}
        error={error ? apiMessage(error, 'No se pudo cargar el historial.') : ''}
        empty={!!data && data.events.length === 0}
      >
        <div className="table-container overflow-x-auto">
          <table className="data-grid min-w-[900px]">
            <thead>
              <tr>
                <th className="table-header-cell text-left">Fecha</th>
                <th className="table-header-cell text-left">Evento</th>
                <th className="table-header-cell text-left">Usuario</th>
                <th className="table-header-cell text-left">IP</th>
                <th className="table-header-cell text-left">Dispositivo</th>
                <th className="table-header-cell text-left">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {data?.events.map((e) => (
                <tr key={e.id}>
                  <td className="table-body-cell whitespace-nowrap text-[11px]">{dateTime(e.createdAt)}</td>
                  <td className={`table-body-cell text-xs font-bold ${RESULT_TEXT[e.result] ?? ''}`}>{EVENT_LABELS[e.type] ?? e.type}</td>
                  <td className="table-body-cell text-xs">{e.user.name}</td>
                  <td className="table-body-cell tabular text-[11px]">{e.ip}</td>
                  <td className="table-body-cell text-[11px]">
                    {deviceLabel(e.device)}
                    {e.deviceShortId && <span className="tabular text-[var(--color-text-secondary)]"> · {e.deviceShortId}</span>}
                  </td>
                  <td className="table-body-cell max-w-[22rem] text-[11px] text-[var(--color-text-secondary)]">{detailOf(e) || '—'}</td>
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
