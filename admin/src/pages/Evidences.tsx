import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Camera, RotateCw, X, Package, ShieldCheck, Clock, ShieldAlert } from 'lucide-react';
import api from '../services/api';

interface EvidenceRow {
  id: string;
  orderId: string;
  type: 'pickup_evidence' | 'delivery_evidence';
  url: string;
  uploadedAt: string;
  order?: { orderNumber?: string; status?: string };
  business?: { name?: string };
  uploader?: { name?: string; phone?: string };
  metadata: { bytes: number; format: string };
}

interface SecurityCode {
  status: 'pending' | 'used' | 'expired' | 'blocked' | 'void';
  attempts: number;
  usedAt: string | null;
  lockedUntil: string | null;
  verifiedRole: string | null;
}

interface SecurityDossier {
  orderId: string;
  orderNumber?: string;
  status: string;
  pickup: SecurityCode | null;
  delivery: SecurityCode | null;
  evidences: EvidenceRow[];
  events: Array<{ action: string; description: string; timestamp: string; userRole: string }>;
}

const codeStatusStyle: Record<string, { label: string; bg: string; text: string; Icon: typeof ShieldCheck }> = {
  pending: { label: 'Pendiente', bg: 'bg-[var(--color-warning-bg)]', text: 'text-[#B45309]', Icon: Clock },
  used: { label: 'Validado', bg: 'bg-[var(--color-success-bg)]', text: 'text-[#047857]', Icon: ShieldCheck },
  expired: { label: 'Expirado', bg: 'bg-[var(--color-bg-alt)]', text: 'text-[var(--color-text-secondary)]', Icon: Clock },
  blocked: { label: 'Bloqueado', bg: 'bg-[var(--color-danger-bg)]', text: 'text-[#B91C1C]', Icon: ShieldAlert },
  void: { label: 'Anulado', bg: 'bg-[var(--color-bg-alt)]', text: 'text-[var(--color-text-secondary)]', Icon: X },
};

const typeOptions = [
  { key: '', label: 'Todas' },
  { key: 'pickup_evidence', label: 'Recogida' },
  { key: 'delivery_evidence', label: 'Entrega' },
];

/**
 * Navegador de evidencias y expediente de seguridad por pedido.
 *
 * Las fotos se muestran con la URL firmada que ya trae el backend —nunca
 * se guarda ni se reconstruye aquí— y el código de cada pedido nunca
 * aparece en claro: solo su estado (pendiente, validado, bloqueado…),
 * que es lo único que hace falta para auditar sin poder suplantar a
 * nadie con lo que ve un administrador.
 */
export default function Evidences() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState({ page: 1, totalPages: 1, total: 0 });

  // ── Filtro escrito vs. filtro aplicado ──
  //
  // No son lo mismo y confundirlos costaba dos errores a la vez. Las
  // pastillas de tipo y la paginación se aplican al pulsarlas; el pedido y
  // las fechas se escriben y solo cuentan al pulsar "Aplicar" —por eso
  // existe el botón—. Cuando todo vivía en el mismo estado, `applyFilters`
  // hacía `setPage(1)` y llamaba a `fetchRows()` en la misma línea: la
  // llamada leía el `page` del render en curso, que todavía era el viejo,
  // así que se pedía la página 3 con los filtros nuevos y, acto seguido,
  // el efecto pedía la página 1. Dos peticiones y un parpadeo con datos
  // que nadie había pedido.
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);

  /** Lo que hay escrito en las casillas ahora mismo. */
  const [orderId, setOrderId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  /** Lo que de verdad está filtrando la lista. */
  const [applied, setApplied] = useState({ orderId: '', from: '', to: '' });

  const [dossier, setDossier] = useState<SecurityDossier | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // `useCallback` con sus dependencias de verdad, y el efecto colgando de
  // ella. La lista de dependencias ya no hay que mantenerla a mano: es
  // exactamente lo que la función lee, y por eso no puede quedarse atrás.
  const fetchRows = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/admin/evidences', {
        params: {
          type: type || undefined,
          orderId: applied.orderId.trim() || undefined,
          from: applied.from || undefined,
          to: applied.to || undefined,
          page,
          limit: 24,
        },
      });
      setRows(data.data);
      setMeta(data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [type, page, applied]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Solo commit: el efecto se encarga de pedir. Una sola petición, con la
  // página ya reiniciada, y sin llamadas manuales que puedan leer estado
  // viejo.
  const applyFilters = () => {
    setPage(1);
    setApplied({ orderId, from, to });
  };

  const openDossier = async (id: string) => {
    setDossierLoading(true);
    setDossier(null);
    try {
      const { data } = await api.get(`/admin/orders/${id}/security`);
      setDossier(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setDossierLoading(false);
    }
  };

  // Enlace directo desde el detalle de un pedido (Pedidos → "Ver
  // seguimiento"): si llega con `?orderId=`, precarga el filtro y abre el
  // expediente de una vez, sin que el administrador tenga que pegarlo dos
  // veces.
  //
  // Va aquí abajo, y no junto al resto de efectos, porque llama a
  // `openDossier`: leerla antes de su `const` era acceder a una variable
  // en su zona muerta temporal. Funcionaba de milagro —el efecto corre
  // después del render— pero es la clase de orden que se rompe sola en
  // cuanto alguien mueve una línea.
  useEffect(() => {
    const linked = searchParams.get('orderId');
    if (!linked) return;
    setOrderId(linked);
    setApplied((current) => ({ ...current, orderId: linked }));
    openDossier(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Evidencias y Trazabilidad</h1>
          <p className="page-subtitle">Fotos de recogida y entrega, y el expediente de seguridad de cada pedido</p>
        </div>
        <button
          onClick={fetchRows}
          className="px-4 py-2 bg-[var(--color-surface)] hover:bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] rounded-lg transition-all cursor-pointer flex items-center justify-center gap-2 shadow-xs"
        >
          <RotateCw className="w-4 h-4 text-[var(--color-primary)]" />
          <span>Actualizar</span>
        </button>
      </div>

      {/* Filtros */}
      <div className="flex flex-col md:flex-row gap-3 md:items-end pb-4 border-b border-[var(--color-border-light)]">
        <div className="flex-1 min-w-[180px]">
          <label className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">ID de pedido</label>
          <input
            type="text"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
            placeholder="Pega el ID completo del pedido…"
            className="w-full h-10 mt-1 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none transition-all"
          />
        </div>
        <div>
          <label className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Desde</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full h-10 mt-1 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
          />
        </div>
        <div>
          <label className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Hasta</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full h-10 mt-1 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
          />
        </div>
        <button
          onClick={applyFilters}
          className="h-10 px-4 rounded-lg bg-[var(--color-primary)] text-white text-xs font-bold cursor-pointer hover:bg-[var(--color-chart-purple)] transition-colors"
        >
          Filtrar
        </button>

        <div className="flex gap-1.5 md:ml-auto">
          {typeOptions.map((t) => (
            <button
              key={t.key}
              onClick={() => { setType(t.key); setPage(1); }}
              className={`px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                type === t.key ? 'bg-[var(--color-primary)] text-white shadow-xs' : 'bg-[var(--color-bg-alt)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cuadrícula de evidencias */}
      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          <RotateCw className="w-6 h-6 text-[var(--color-primary)] animate-spin mx-auto mb-2" />
          Cargando evidencias...
        </div>
      ) : rows.length === 0 ? (
        <div className="table-container p-16 text-center text-[var(--color-text-muted)] text-xs font-semibold flex flex-col items-center gap-2">
          <Camera className="w-6 h-6" />
          No hay evidencias que coincidan con el filtro.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            {rows.map((row) => (
              <button
                key={row.id}
                onClick={() => openDossier(row.orderId)}
                className="zipp-card p-0 overflow-hidden text-left cursor-pointer group"
              >
                <div className="relative">
                  <img
                    src={row.url}
                    alt={row.type === 'pickup_evidence' ? 'Evidencia de recogida' : 'Evidencia de entrega'}
                    className="w-full h-28 object-cover group-hover:opacity-90 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); setPreview(row.url); }}
                  />
                  <span
                    className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${
                      row.type === 'pickup_evidence' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-primary)] text-[var(--color-text-main)]'
                    }`}
                  >
                    {row.type === 'pickup_evidence' ? 'Recogida' : 'Entrega'}
                  </span>
                </div>
                <div className="p-2 space-y-0.5">
                  <p className="text-[10px] font-mono font-bold text-[var(--color-primary)] truncate">
                    #{row.order?.orderNumber ?? row.orderId.slice(-8).toUpperCase()}
                  </p>
                  <p className="text-[10px] text-[var(--color-text-secondary)] truncate">{row.business?.name ?? '—'}</p>
                  <p className="text-[9px] text-[var(--color-text-muted)]">
                    {new Date(row.uploadedAt).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {meta.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg bg-[var(--color-bg-alt)] text-xs font-semibold text-[var(--color-text-secondary)] disabled:opacity-40 cursor-pointer"
              >
                Anterior
              </button>
              <span className="text-xs text-[var(--color-text-muted)] font-semibold">Página {meta.page} de {meta.totalPages}</span>
              <button
                disabled={page >= meta.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-lg bg-[var(--color-bg-alt)] text-xs font-semibold text-[var(--color-text-secondary)] disabled:opacity-40 cursor-pointer"
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}

      {/* Visor de imagen simple */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-fade-in cursor-zoom-out"
          onClick={() => setPreview(null)}
        >
          <img src={preview} alt="Evidencia" className="max-w-full max-h-full rounded-xl shadow-2xl" />
        </div>
      )}

      {/* Expediente de seguridad del pedido */}
      {(dossier || dossierLoading) && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-2xl rounded-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--color-border-light)] pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--color-primary-bg)] text-[var(--color-primary)] flex items-center justify-center">
                  <Package className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-[var(--color-text-main)]">
                    Expediente #{dossier?.orderNumber ?? dossier?.orderId.slice(-8).toUpperCase()}
                  </h3>
                  <p className="text-xs text-[var(--color-text-muted)]">Códigos, evidencias y bitácora del traspaso</p>
                </div>
              </div>
              <button
                onClick={() => setDossier(null)}
                className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {dossierLoading ? (
              <div className="p-10 text-center text-[var(--color-text-muted)] text-xs font-semibold">Cargando expediente…</div>
            ) : dossier ? (
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <CodeStatusCard title="Código de recogida" code={dossier.pickup} />
                  <CodeStatusCard title="Código de entrega" code={dossier.delivery} />
                </div>

                {dossier.evidences.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Evidencias</p>
                    <div className="grid grid-cols-2 gap-3">
                      {dossier.evidences.map((ev) => (
                        <button
                          key={ev.id}
                          onClick={() => setPreview(ev.url)}
                          className="rounded-xl overflow-hidden border border-[var(--color-border-light)] cursor-zoom-in"
                        >
                          <img src={ev.url} alt="" className="w-full h-32 object-cover" />
                          <div className="px-2 py-1.5 bg-[var(--color-bg)] text-[10px] font-semibold text-[var(--color-text-secondary)]">
                            {ev.type === 'pickup_evidence' ? 'Recogida' : 'Entrega'} ·{' '}
                            {new Date(ev.uploadedAt).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {dossier.events.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Bitácora</p>
                    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                      {dossier.events.map((ev, idx) => (
                        <div key={idx} className="flex items-start gap-2 p-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border-light)]">
                          <span className="text-[9px] font-mono text-[var(--color-text-muted)] whitespace-nowrap mt-0.5">
                            {new Date(ev.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span className="text-[var(--color-text-main)] font-medium flex-1">{ev.description}</span>
                          <span className="text-[9px] uppercase font-bold text-[var(--color-text-muted)]">{ev.userRole}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setDossier(null)}
                className="px-4 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] text-xs font-semibold text-[var(--color-text-main)] border border-[var(--color-border)] cursor-pointer transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CodeStatusCard({ title, code }: { title: string; code: SecurityCode | null }) {
  const skin = code ? codeStatusStyle[code.status] : null;
  const Icon = skin?.Icon ?? Clock;

  return (
    <div className="p-3.5 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border-light)] space-y-1.5">
      <span className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">{title}</span>
      {code ? (
        <>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide ${skin!.bg} ${skin!.text}`}>
            <Icon className="w-3.5 h-3.5" /> {skin!.label}
          </span>
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            {code.attempts > 0 ? `${code.attempts} intento(s) fallido(s)` : 'Sin intentos fallidos'}
          </p>
          {code.usedAt && (
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              Validado {new Date(code.usedAt).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {code.verifiedRole ? ` por ${code.verifiedRole}` : ''}
            </p>
          )}
        </>
      ) : (
        <p className="text-[10px] text-[var(--color-text-muted)]">Aún no se ha emitido</p>
      )}
    </div>
  );
}
