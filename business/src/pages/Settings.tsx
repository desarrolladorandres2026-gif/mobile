import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Clock, Truck, Save } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

/**
 * Ajustes del comercio: cuándo abre y cuándo regala el domicilio.
 *
 * Las dos cosas de esta pantalla las paga el negocio, y por eso las decide
 * el negocio. Su comisión y su aprobación no están aquí: eso es el acuerdo
 * con ZIPP y se toca desde el panel de administración.
 *
 * El horario no es decorativo. El servidor decide con él si la tienda está
 * abierta, así que dejar mal un día cierra la tienda de verdad — por eso se
 * avisa antes de guardar y no después.
 */

type DaySchedule = { open?: string; close?: string; isOpen?: boolean };
type Schedule = Record<string, DaySchedule>;

const DAYS: Array<{ key: string; label: string }> = [
  { key: 'monday', label: 'Lunes' },
  { key: 'tuesday', label: 'Martes' },
  { key: 'wednesday', label: 'Miércoles' },
  { key: 'thursday', label: 'Jueves' },
  { key: 'friday', label: 'Viernes' },
  { key: 'saturday', label: 'Sábado' },
  { key: 'sunday', label: 'Domingo' },
];

const money = (value: number) => `$${value.toLocaleString('es-CO')}`;

export default function Settings() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const [schedule, setSchedule] = useState<Schedule>({});
  const [threshold, setThreshold] = useState(0);
  const [minOrder, setMinOrder] = useState(0);
  const [deliveryTime, setDeliveryTime] = useState(30);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get(`/businesses/${businessId}`);
      const business = data.data;

      setSchedule(business.schedule ?? {});
      setThreshold(business.freeDeliveryThreshold ?? 0);
      setMinOrder(business.minOrder ?? 0);
      setDeliveryTime(business.deliveryTime ?? 30);
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar los ajustes.'));
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const setDay = (key: string, patch: DaySchedule) => {
    setSaved(false);
    setSchedule((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const save = async () => {
    if (!businessId) return;
    try {
      setError('');
      setSaving(true);
      await api.put(`/businesses/${businessId}`, {
        schedule,
        freeDeliveryThreshold: threshold,
        minOrder,
        deliveryTime,
      });
      setSaved(true);
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron guardar los ajustes.'));
    } finally {
      setSaving(false);
    }
  };

  const openDays = DAYS.filter((d) => schedule[d.key]?.isOpen).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Ajustes</h1>
          <p className="page-subtitle">
            Tu horario y tus promociones. Lo que decides aquí sale de tu bolsillo, no del de ZIPP
          </p>
        </div>

        <button
          onClick={save}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
        >
          {saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando…' : saved ? 'Guardado' : 'Guardar cambios'}
        </button>
      </div>

      {error && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {openDays === 0 && !loading && (
        <div className="bg-[var(--color-warning-bg)] text-[var(--color-warning)] text-xs p-4 rounded-xl flex items-start gap-3 font-semibold">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">
            No tienes ningún día abierto. Con este horario, tu tienda aparece cerrada
            y nadie puede pedirte.
          </p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando ajustes...
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ── Horario ── */}
          <div className="zipp-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Horario de atención</h2>
            </div>

            <p className="text-xs text-[var(--color-text-secondary)]">
              Fuera de este horario tu tienda se muestra cerrada y no recibe pedidos.
            </p>

            <div className="space-y-2">
              {DAYS.map((day) => {
                const value = schedule[day.key] ?? {};
                const isOpen = !!value.isOpen;

                return (
                  <div
                    key={day.key}
                    className="flex flex-wrap items-center gap-3 p-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]"
                  >
                    <label className="flex items-center gap-2 min-w-[110px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isOpen}
                        onChange={(e) => setDay(day.key, { isOpen: e.target.checked })}
                        className="accent-[var(--color-primary)] cursor-pointer"
                      />
                      <span className="text-xs font-bold text-[var(--color-text-main)]">
                        {day.label}
                      </span>
                    </label>

                    {isOpen ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={value.open ?? '08:00'}
                          onChange={(e) => setDay(day.key, { open: e.target.value })}
                          className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
                        />
                        <span className="text-xs text-[var(--color-text-muted)]">a</span>
                        <input
                          type="time"
                          value={value.close ?? '20:00'}
                          onChange={(e) => setDay(day.key, { close: e.target.value })}
                          className="px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)] font-medium">Cerrado</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Entregas ── */}
          <div className="zipp-card p-5 space-y-4 self-start">
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-[var(--color-primary)]" />
              <h2 className="text-sm font-bold text-[var(--color-text-main)]">Entregas</h2>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--color-text-main)]">
                Envío gratis desde
              </label>
              <input
                type="number"
                min={0}
                step={1000}
                value={threshold}
                onChange={(e) => { setSaved(false); setThreshold(Number(e.target.value)); }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                {threshold > 0 ? (
                  <>
                    Los pedidos de {money(threshold)} o más no pagan domicilio.{' '}
                    <strong className="text-[var(--color-text-main)]">
                      Ese costo se descuenta de tu liquidación
                    </strong>{' '}
                    — el domiciliario cobra igual.
                  </>
                ) : (
                  'En cero, tus clientes pagan siempre el domicilio.'
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--color-text-main)]">
                Pedido mínimo
              </label>
              <input
                type="number"
                min={0}
                step={1000}
                value={minOrder}
                onChange={(e) => { setSaved(false); setMinOrder(Number(e.target.value)); }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                Por debajo de este monto no se puede completar un pedido tuyo.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--color-text-main)]">
                Tiempo de preparación (minutos)
              </label>
              <input
                type="number"
                min={5}
                max={120}
                value={deliveryTime}
                onChange={(e) => { setSaved(false); setDeliveryTime(Number(e.target.value)); }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
              />
              <p className="text-xs text-[var(--color-text-secondary)]">
                Es lo que el cliente ve como estimado. Prometer de menos genera reclamos.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
