import { useEffect, useState } from 'react';
import { Truck, Star, DollarSign, AlertCircle, CheckCircle, X, Ban, PlayCircle } from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

interface DriverType {
  _id: string;
  userId?: { _id: string; name: string; phone: string; avatar?: string };
  vehicleType: string;
  licensePlate: string;
  status: string;
  rating: number;
  totalDeliveries: number;
  baseFund: number;
  currentFund: number;
  isApproved: boolean;
  isActive: boolean;
}

// Semáforo de despacho: verde = libre y en línea, ámbar = ocupado en una
// entrega, gris = desconectado. El verde "disponible" usa la esmeralda de
// seguridad de mobile (palette.emerald).
const statusStyles: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  available: { label: 'Disponible',    bg: 'bg-[var(--color-success-bg)] border-[var(--color-success-bg)]', text: 'text-[#047857]', dot: 'bg-[var(--color-success)]' },
  busy:      { label: 'En Entrega',    bg: 'bg-[var(--color-warning-bg)] border-[var(--color-warning-bg)]', text: 'text-[#B45309]', dot: 'bg-[var(--color-warning)]' },
  offline:   { label: 'Desconectado', bg: 'bg-[var(--color-bg-alt)] border-[var(--color-border)]', text: 'text-[var(--color-text-muted)]', dot: 'bg-[var(--color-text-muted)]' },
};

export default function Drivers() {
  const [drivers, setDrivers] = useState<DriverType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showFundModal, setShowFundModal] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<DriverType | null>(null);
  const [newBaseFund, setNewBaseFund] = useState('');
  const [confirmSuspend, setConfirmSuspend] = useState<DriverType | null>(null);

  const fetchDrivers = async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get('/drivers?limit=100');
      setDrivers(data.data);
    } catch (err) {
      console.error(err);
      setError('No se pudieron obtener los domiciliarios.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDrivers(); }, []);

  const handleApprove = async (driverId: string) => {
    try {
      setError('');
      await api.patch(`/drivers/${driverId}/approve`);
      setDrivers((prev) => prev.map((d) => (d._id === driverId ? { ...d, isApproved: true } : d)));
    } catch (err) {
      setError(apiMessage(err, 'No se pudo aprobar al domiciliario.'));
    }
  };

  const handleOpenFundModal = (driver: DriverType) => {
    setSelectedDriver(driver);
    setNewBaseFund(driver.baseFund.toString());
    setShowFundModal(true);
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
      setConfirmSuspend(null);
    } catch (err) {
      setError(apiMessage(err, 'No se pudo actualizar al domiciliario.'));
      setConfirmSuspend(null);
    }
  };

  const handleUpdateBaseFund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDriver || !newBaseFund) return;
    try {
      setError('');
      await api.patch(`/drivers/${selectedDriver._id}/base-fund`, { baseFund: parseFloat(newBaseFund) });
      setShowFundModal(false);
      fetchDrivers();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo actualizar el fondo base.'));
    }
  };

  const onlineCount = drivers.filter((d) => d.status === 'available' || d.status === 'busy').length;
  const offlineCount = drivers.filter((d) => d.status === 'offline' || !d.status).length;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Flota de Domiciliarios</h1>
          <p className="page-subtitle">Monitoreo de repartidores, fondos de efectivo y aprobaciones</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-main)] shadow-xs">
            <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-pulse" />
            <span>{onlineCount} en línea</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-secondary)]">
            <span className="w-2 h-2 rounded-full bg-[var(--color-text-muted)]" />
            <span>{offlineCount} offline</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-[var(--color-danger)] shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando repartidores...
        </div>
      ) : (
        <div className="grid gap-4">
          {drivers.map((d) => {
            const statusConfig = statusStyles[d.status] || { label: 'Desconectado', bg: 'bg-[var(--color-bg-alt)] border-[var(--color-border)]', text: 'text-[var(--color-text-muted)]', dot: 'bg-[var(--color-text-muted)]' };
            const debt = d.baseFund - d.currentFund;

            return (
              <div
                key={d._id}
                className="zipp-card p-5 flex flex-col md:flex-row md:items-center justify-between gap-5"
              >
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[var(--color-sidebar-hover)] flex items-center justify-center text-lg font-bold text-white uppercase flex-shrink-0">
                    {d.userId?.name?.charAt(0) || 'D'}
                  </div>

                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h3 className="text-base font-bold text-[var(--color-text-main)]">
                        {d.userId?.name || 'Domiciliario'}
                      </h3>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border ${statusConfig.bg} ${statusConfig.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot} flex-shrink-0`} />
                        {statusConfig.label}
                      </span>

                      {!d.isApproved && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-warning-bg)] text-[var(--color-warning)] border border-[var(--color-warning-bg)]">
                          Pendiente aprobación
                        </span>
                      )}

                      {!d.isActive && d.isApproved && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-danger-bg)] text-[var(--color-danger)] border border-[var(--color-danger-bg)]">
                          Suspendido
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                      {d.userId?.phone || 'Sin teléfono registrado'} • Vehículo: <strong className="text-[var(--color-text-main)] capitalize">{d.vehicleType === 'motorcycle' ? 'Moto' : 'Bicicleta'}</strong> • Placa: <strong className="text-[var(--color-primary)] font-mono">{d.licensePlate || 'N/A'}</strong>
                    </p>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
                      <span className="flex items-center gap-1 text-[var(--color-text-main)] font-medium">
                        <Star className="w-3.5 h-3.5 text-[var(--color-warning)] fill-[var(--color-warning)]" />
                        {d.rating > 0 ? d.rating.toFixed(1) : 'S/V'}
                      </span>
                      <span className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                        <Truck className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                        {d.totalDeliveries || 0} entregas realizadas
                      </span>
                      <span className="px-2.5 py-0.5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] font-mono text-xs font-semibold flex items-center gap-1">
                        <DollarSign className="w-3 h-3 text-[var(--color-primary)]" />
                        Base: ${(d.currentFund || 0).toLocaleString('es-CO')} / ${(d.baseFund || 0).toLocaleString('es-CO')}
                      </span>
                      {debt > 0 && (
                        <span className="px-2.5 py-0.5 rounded-md bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] text-[var(--color-warning)] font-bold text-xs flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          Deuda: ${(debt).toLocaleString('es-CO')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 border-t border-[var(--color-border-light)] md:border-0 pt-3 md:pt-0 justify-end flex-wrap">
                  {!d.isApproved && (
                    <button
                      onClick={() => handleApprove(d._id)}
                      className="px-3.5 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Aprobar
                    </button>
                  )}

                  <button
                    onClick={() => handleOpenFundModal(d)}
                    className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] transition-all cursor-pointer"
                  >
                    Ajustar Fondo
                  </button>

                  <button
                    onClick={() => setConfirmSuspend(d)}
                    className={`px-3.5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all border cursor-pointer flex items-center gap-1.5 ${
                      d.isActive
                        ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-bg)] hover:bg-[var(--color-danger-bg)]'
                        : 'bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-[var(--color-primary-bg)] hover:bg-[var(--color-primary-bg)]'
                    }`}
                  >
                    {d.isActive ? (
                      <><Ban className="w-4 h-4" />Suspender</>
                    ) : (
                      <><PlayCircle className="w-4 h-4" />Reactivar</>
                    )}
                  </button>
                </div>
              </div>
            );
          })}

          {drivers.length === 0 && (
            <div className="zipp-card p-12 text-center text-[var(--color-text-muted)] text-xs font-semibold">
              No hay domiciliarios registrados en el sistema.
            </div>
          )}
        </div>
      )}

      {/* Confirm Suspend Modal */}
      {confirmSuspend && (
        <ConfirmDialog
          title={confirmSuspend.isActive ? 'Suspender Domiciliario' : 'Reactivar Domiciliario'}
          message={confirmSuspend.isActive
            ? `¿Deseas suspender temporalmente a ${confirmSuspend.userId?.name}? No podrá recibir asignaciones.`
            : `¿Deseas reactivar la cuenta de ${confirmSuspend.userId?.name}?`
          }
          confirmLabel={confirmSuspend.isActive ? 'Suspender' : 'Reactivar'}
          onConfirm={handleToggleSuspend}
          onCancel={() => setConfirmSuspend(null)}
          variant={confirmSuspend.isActive ? 'danger' : 'default'}
        />
      )}

      {/* Fund Adjustment Modal */}
      {showFundModal && selectedDriver && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-sm rounded-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-3">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">Modificar Fondo Base</h3>
              <button onClick={() => setShowFundModal(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateBaseFund} className="space-y-4">
              <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                Establece el tope de efectivo asignado para <strong className="text-[var(--color-text-main)]">{selectedDriver.userId?.name}</strong>.
              </p>
              <div>
                <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">Fondo Base ($ COP)</label>
                <input
                  type="number"
                  required
                  value={newBaseFund}
                  onChange={(e) => setNewBaseFund(e.target.value)}
                  className="w-full h-10 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3.5 text-xs font-mono font-bold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
                  placeholder="50000"
                />
              </div>
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

