import { useCallback, useEffect, useState } from 'react';
import { Search, Star, AlertCircle, CheckCircle, X, Ban, PlayCircle, Eye, RotateCw } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import Pagination from '../components/Pagination';
import EntityLink from '../components/EntityLink';
import { FICHA_CHANGED_EVENT, useFicha } from '../lib/entityLinks';
import { PermissionGate } from '../components/PermissionGate';
import { useAuthStore } from '../stores/authStore';
import { Permission } from '../lib/permissions';
import { apiMessage } from '../lib/apiError';
import {
  accountStateStyles,
  availabilityStyles,
  day,
  driverAccountState,
  money,
  relativeTime,
  vehicleLabel,
  type DriverListItem,
} from '../lib/drivers';

const PAGE_SIZE = 25;

const accountFilters = [
  { value: '', label: 'Todos' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'active', label: 'Activos' },
  { value: 'suspended', label: 'Suspendidos' },
];

const sortOptions = [
  { value: 'createdAt:desc', label: 'Más recientes' },
  { value: 'name:asc', label: 'Nombre (A-Z)' },
  { value: 'rating:desc', label: 'Mejor calificados' },
  { value: 'totalDeliveries:desc', label: 'Más pedidos' },
  { value: 'lastLocationAt:desc', label: 'Última conexión' },
];

const fieldClass =
  'h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] focus:border-[var(--color-primary)] outline-none';

const headClass =
  'px-3 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] whitespace-nowrap';
const cellClass =
  'px-3 py-3.5 text-xs align-middle border-t border-[var(--color-border-light)] text-[var(--color-text-main)]';

export default function Drivers() {
  const [drivers, setDrivers] = useState<DriverListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, limit: PAGE_SIZE });

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [availability, setAvailability] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState('createdAt:desc');

  // La ficha vive en la URL (`?ficha=driver:<id>`); ver `FichaHost`.
  const { open: openFicha } = useFicha();
  const [showFundModal, setShowFundModal] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<DriverListItem | null>(null);
  const [newBaseFund, setNewBaseFund] = useState('');
  const [fundReason, setFundReason] = useState('');
  const [fundError, setFundError] = useState('');
  const canManageFinance = useAuthStore((s) => s.hasPermission(Permission.FINANCE_MANAGE));
  const [confirmSuspend, setConfirmSuspend] = useState<DriverListItem | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, accountFilter, availability, vehicleType, dateFrom, dateTo, sort]);

  const fetchDrivers = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [sortBy, sortOrder] = sort.split(':');
      const params: Record<string, string | number> = { page, limit: PAGE_SIZE, sortBy, sortOrder };
      if (debouncedSearch) params.search = debouncedSearch;
      if (accountFilter) params.driverStatus = accountFilter;
      if (availability) params.availability = availability;
      if (vehicleType) params.vehicleType = vehicleType;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      const { data } = await api.get('/drivers', { params });
      setDrivers(data.data);
      if (data.meta) setMeta(data.meta);
    } catch (err) {
      console.error(err);
      setError(apiMessage(err, 'No se pudieron obtener los domiciliarios.'));
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, accountFilter, availability, vehicleType, dateFrom, dateTo, sort]);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  // La ficha (montada en Layout) avisa cuando cambia algo del domiciliario.
  useEffect(() => {
    window.addEventListener(FICHA_CHANGED_EVENT, fetchDrivers);
    return () => window.removeEventListener(FICHA_CHANGED_EVENT, fetchDrivers);
  }, [fetchDrivers]);

  const handleApprove = async (driverId: string) => {
    try {
      setError('');
      await api.patch(`/drivers/${driverId}/approve`);
      setDrivers((prev) => prev.map((d) => (d._id === driverId ? { ...d, isApproved: true } : d)));
    } catch (err) {
      setError(apiMessage(err, 'No se pudo aprobar al domiciliario.'));
    }
  };

  const handleToggleSuspend = async () => {
    if (!confirmSuspend) return;
    const action = confirmSuspend.isActive ? 'suspend' : 'reactivate';
    try {
      setError('');
      await api.patch(`/admin/drivers/${confirmSuspend._id}/${action}`);
      setDrivers((prev) =>
        prev.map((d) => (d._id === confirmSuspend._id ? { ...d, isActive: !d.isActive } : d))
      );
    } catch (err) {
      setError(apiMessage(err, 'No se pudo actualizar al domiciliario.'));
    } finally {
      setConfirmSuspend(null);
    }
  };

  const handleOpenFundModal = (driver: DriverListItem) => {
    setSelectedDriver(driver);
    setNewBaseFund(String(driver.baseFund));
    setFundReason('');
    setFundError('');
    setShowFundModal(true);
  };

  // Entero en COP y con motivo: es dinero y queda auditado con el antes y el después.
  const handleUpdateBaseFund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDriver) return;
    const baseFund = Number(newBaseFund);
    if (!Number.isInteger(baseFund) || baseFund <= 0) {
      setFundError('Escribe el fondo en pesos enteros, mayor que cero.');
      return;
    }
    if (fundReason.trim().length < 5) {
      setFundError('Escribe el motivo (mínimo 5 caracteres).');
      return;
    }
    try {
      setFundError('');
      await api.patch(`/drivers/${selectedDriver._id}/base-fund`, { baseFund, reason: fundReason.trim() });
      setShowFundModal(false);
      fetchDrivers();
    } catch (err) {
      setFundError(apiMessage(err, 'No se pudo actualizar el fondo base.'));
    }
  };

  const onlineCount = drivers.filter((d) => d.status === 'available' || d.status === 'busy').length;

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Domiciliarios</h1>
          <p className="page-subtitle">
            {meta.total} registrados · {onlineCount} en línea en esta página
          </p>
        </div>
      </div>

      {error && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      <div className="space-y-2.5 pb-4 border-b border-[var(--color-border-light)]">
        <div className="flex flex-col md:flex-row gap-2.5 justify-between md:items-center">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, documento, teléfono, correo o placa..."
              className={`${fieldClass} w-full pl-9`}
            />
          </div>

          <div className="flex gap-1.5 overflow-x-auto w-full md:w-auto">
            {accountFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setAccountFilter(f.value)}
                className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer border-b-2 ${
                  accountFilter === f.value
                    ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
                    : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Disponibilidad
            </span>
            <select value={availability} onChange={(e) => setAvailability(e.target.value)} className={fieldClass}>
              <option value="">Todas</option>
              <option value="available">Disponible</option>
              <option value="busy">Ocupado</option>
              <option value="offline">Desconectado</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Vehículo
            </span>
            <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className={fieldClass}>
              <option value="">Todos</option>
              <option value="motorcycle">Moto</option>
              <option value="bicycle">Bicicleta</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Registro desde
            </span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={fieldClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Hasta
            </span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={fieldClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Ordenar por
            </span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className={fieldClass}>
              {sortOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
          Cargando domiciliarios...
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px]">
              <thead>
                <tr>
                  <th className={headClass}>Domiciliario</th>
                  <th className={headClass}>Documento</th>
                  <th className={headClass}>Contacto</th>
                  <th className={headClass}>Estado</th>
                  <th className={headClass}>Disponibilidad</th>
                  <th className={headClass}>Vehículo</th>
                  <th className={headClass}>Registro</th>
                  <th className={headClass} title="Última ubicación reportada por la app">Última conexión</th>
                  <th className={`${headClass} text-right`}>Pedidos</th>
                  <th className={headClass}>Calificación</th>
                  <th className={`${headClass} text-right`}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((d) => {
                  const account = driverAccountState(d);
                  const availabilityStyle = availabilityStyles[d.status] ?? availabilityStyles.offline;
                  const debt = d.baseFund - d.currentFund;
                  return (
                    <tr key={d._id} className="hover:bg-[var(--color-bg)] transition-colors">
                      <td className={cellClass}>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 shrink-0 overflow-hidden rounded-full border border-[var(--color-border)] flex items-center justify-center text-sm font-bold uppercase text-[var(--color-text-secondary)]">
                            {d.userId?.avatar ? (
                              <img src={d.userId.avatar} alt="" className="h-full w-full object-cover" />
                            ) : (
                              d.userId?.name?.charAt(0) || 'D'
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold truncate max-w-[180px]">
                              <EntityLink type="driver" id={d._id}>{d.userId?.name || 'Domiciliario'}</EntityLink>
                            </p>
                            {debt > 0 && (
                              <p className="text-[10px] font-bold text-[var(--color-warning)]">
                                Fondo por debajo: {money(debt)}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className={`${cellClass} font-mono whitespace-nowrap`}>
                        {d.userId?.documentNumber
                          ? `${d.userId.documentType ? `${d.userId.documentType} ` : ''}${d.userId.documentNumber}`
                          : '—'}
                      </td>
                      <td className={cellClass}>
                        <p className="font-mono">{d.userId?.phone || '—'}</p>
                        <p className="text-[var(--color-text-secondary)] truncate max-w-[200px]">
                          {d.userId?.email || '—'}
                        </p>
                      </td>
                      <td className={cellClass}>
                        <p className={`text-[10px] font-bold uppercase tracking-wide ${accountStateStyles[account].text}`}>
                          {accountStateStyles[account].label}
                        </p>
                        {d.userId?.isBlocked && (
                          <p className="text-[10px] font-bold uppercase text-[var(--color-danger)]">Cuenta bloqueada</p>
                        )}
                      </td>
                      <td className={cellClass}>
                        <span
                          className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${availabilityStyle.text}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${availabilityStyle.dot}`} />
                          {availabilityStyle.label}
                        </span>
                      </td>
                      <td className={cellClass}>
                        <p>{vehicleLabel(d.vehicleType)}</p>
                        <p className="font-mono text-[var(--color-text-secondary)]">{d.licensePlate || 'Sin placa'}</p>
                      </td>
                      <td className={`${cellClass} whitespace-nowrap`}>{day(d.createdAt)}</td>
                      <td
                        className={`${cellClass} whitespace-nowrap`}
                        title={d.lastLocationAt ? new Date(d.lastLocationAt).toLocaleString('es-CO') : undefined}
                      >
                        {relativeTime(d.lastLocationAt ?? d.userId?.lastLoginAt)}
                      </td>
                      <td className={`${cellClass} text-right font-semibold`}>{d.totalDeliveries || 0}</td>
                      <td className={`${cellClass} whitespace-nowrap`}>
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Star className="w-3.5 h-3.5 text-[var(--color-warning)] fill-[var(--color-warning)]" />
                          {d.rating > 0 ? d.rating.toFixed(1) : 'S/V'}
                          <span className="text-[var(--color-text-muted)]">({d.totalReviews ?? 0})</span>
                        </span>
                      </td>
                      <td className={cellClass}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => openFicha('driver', d._id)}
                            title="Ver perfil completo"
                            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] cursor-pointer"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {account === 'pending' && (
                            <PermissionGate permission={Permission.DRIVERS_APPROVE}>
                              <button
                                onClick={() => handleApprove(d._id)}
                                title="Aprobar"
                                className="p-2 rounded-lg bg-[var(--color-primary)] text-white cursor-pointer"
                              >
                                <CheckCircle className="w-4 h-4" />
                              </button>
                            </PermissionGate>
                          )}
                          {account !== 'pending' && (
                            <PermissionGate permission={Permission.DRIVERS_SUSPEND}>
                              <button
                                onClick={() => setConfirmSuspend(d)}
                                title={d.isActive ? 'Suspender' : 'Reactivar'}
                                className={`p-2 rounded-lg border cursor-pointer ${
                                  d.isActive
                                    ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                                    : 'border-[var(--color-primary)] text-[var(--color-primary)]'
                                }`}
                              >
                                {d.isActive ? <Ban className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
                              </button>
                            </PermissionGate>
                          )}
                          {canManageFinance && (
                            <button
                              onClick={() => handleOpenFundModal(d)}
                              className="px-2.5 py-2 rounded-lg border border-[var(--color-border)] text-[11px] font-semibold text-[var(--color-text-main)] cursor-pointer whitespace-nowrap"
                            >
                              Fondo
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {drivers.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-6 py-14 text-center text-[var(--color-text-muted)] text-xs font-semibold">
                      No hay domiciliarios que coincidan con los filtros.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={meta.totalPages} total={meta.total} limit={meta.limit} onPageChange={setPage} />
        </>
      )}

      {confirmSuspend && (
        <ConfirmDialog
          title={confirmSuspend.isActive ? 'Suspender Domiciliario' : 'Reactivar Domiciliario'}
          message={
            confirmSuspend.isActive
              ? `¿Deseas suspender temporalmente a ${confirmSuspend.userId?.name}? No podrá recibir asignaciones. Si tiene un pedido en curso, la suspensión se rechaza.`
              : `¿Deseas reactivar la cuenta de ${confirmSuspend.userId?.name}?`
          }
          confirmLabel={confirmSuspend.isActive ? 'Suspender' : 'Reactivar'}
          onConfirm={handleToggleSuspend}
          onCancel={() => setConfirmSuspend(null)}
          variant={confirmSuspend.isActive ? 'danger' : 'default'}
        />
      )}

      {showFundModal && selectedDriver && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-sm rounded-2xl p-6 space-y-2.5">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-3">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">Modificar Fondo Base</h3>
              <button onClick={() => setShowFundModal(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateBaseFund} className="space-y-2.5">
              <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                Tope de efectivo de <strong className="text-[var(--color-text-main)]">{selectedDriver.userId?.name}</strong>.
                Hoy: {money(selectedDriver.baseFund)} de base, {money(selectedDriver.currentFund)} disponibles.
                Solo se ajusta la diferencia: lo retenido en pedidos en curso se respeta.
              </p>
              <div>
                <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Nuevo fondo base ($ COP, sin decimales)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  value={newBaseFund}
                  onChange={(e) => setNewBaseFund(e.target.value.replace(/[^\d]/g, ''))}
                  className={`${fieldClass} w-full font-mono font-bold`}
                  placeholder="50000"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Motivo</label>
                <input
                  type="text"
                  value={fundReason}
                  maxLength={300}
                  onChange={(e) => setFundReason(e.target.value)}
                  className={`${fieldClass} w-full`}
                  placeholder="Ej. ya tiene 3 meses sin faltantes"
                />
              </div>
              {fundError && <p className="text-xs font-semibold text-[var(--color-danger)]">{fundError}</p>}
              <button
                type="submit"
                className="w-full h-10 bg-[var(--color-primary)] hover:bg-[#8A5D08] text-white font-bold text-xs uppercase tracking-wider rounded-lg cursor-pointer"
              >
                Guardar Nuevo Fondo
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
