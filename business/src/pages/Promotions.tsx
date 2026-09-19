import { useCallback, useMemo, useState, type ComponentType } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Plus, Tag, Power, X } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { CouponIllustration, DeliveryIllustration } from '../components/illustrations';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

/**
 * Promociones que crea el propio comercio.
 *
 * Hasta ahora los cupones solo los creaba un administrador de ZIPP, así que
 * un negocio que quería hacer una promoción tenía que pedirla por WhatsApp
 * y esperar. El modelo ya estaba preparado para esto —tiene quién financia,
 * de qué negocio es y su presupuesto—; lo que faltaba era la puerta.
 *
 * Todo lo de esta pantalla lo paga el comercio. Se dice en voz alta y en
 * varios sitios porque es la diferencia entre una herramienta útil y una
 * sorpresa en la liquidación de fin de mes.
 */

interface Coupon {
  _id: string;
  code: string;
  title: string;
  type: 'percentage' | 'fixed' | 'free_delivery';
  scope?: 'product' | 'delivery' | 'service_fee';
  value: number;
  minOrderAmount?: number;
  budgetLimit?: number;
  budgetSpent?: number;
  usageLimit?: number;
  usedCount?: number;
  validUntil: string;
  isActive: boolean;
}

const money = (value: number) => `$${(value ?? 0).toLocaleString('es-CO')}`;

const TYPE_LABELS: Record<Coupon['type'], string> = {
  percentage: 'Porcentaje',
  fixed: 'Monto fijo',
  free_delivery: 'Envío gratis',
};

/**
 * Mini-ilustración por tipo de promoción, en lugar del icono lucide genérico.
 * Un descuento (porcentaje o monto) es un cupón; el envío gratis es otra cosa.
 *
 * TODO(diseño): elegir la ilustración de `free_delivery`. `DeliveryIllustration`
 * (moto de reparto) es lo más literal, pero `PackageIllustration` —que ya se usa
 * en el Dashboard— podría leer mejor como "pedido sin costo de envío" y mantener
 * el set del panel más cerrado. Son 1–2 líneas; decide cuál cuenta mejor la
 * promoción de un vistazo en la lista.
 */
function couponArt(type: Coupon['type']): ComponentType<{ size?: number }> {
  if (type === 'free_delivery') return DeliveryIllustration;
  return CouponIllustration;
}

const emptyForm = {
  code: '',
  title: '',
  type: 'percentage' as Coupon['type'],
  value: 10,
  minOrderAmount: 0,
  budgetLimit: 0,
  usageLimit: 0,
  perUserLimit: 1,
  validUntil: '',
};

export default function Promotions() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const couponsQuery = useQuery({
    queryKey: qk.promotions(businessId),
    enabled: !!businessId,
    queryFn: async () => (await api.get(`/coupons/business/${businessId}`)).data.data as Coupon[],
  });
  const coupons = useMemo(() => couponsQuery.data ?? [], [couponsQuery.data]);
  const loading = !!businessId && couponsQuery.isPending;
  const loadError = couponsQuery.isError ? apiMessage(couponsQuery.error, 'No se pudieron cargar tus promociones.') : '';

  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.promotions(businessId) }),
    [queryClient, businessId]
  );

  const create = async () => {
    if (!businessId) return;
    try {
      setError('');
      setSaving(true);
      await api.post(`/coupons/business/${businessId}`, {
        ...form,
        code: form.code.trim().toUpperCase(),
        // El envío gratis actúa sobre el domicilio; el resto, sobre productos.
        scope: form.type === 'free_delivery' ? 'delivery' : 'product',
        validUntil: new Date(form.validUntil).toISOString(),
      });
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo crear la promoción.'));
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (couponId: string) => {
    try {
      setError('');
      await api.patch(`/coupons/business/${couponId}/deactivate`);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo desactivar la promoción.'));
    }
  };

  const active = coupons.filter((c) => c.isActive);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Promociones</h1>
          <p className="page-subtitle">
            Tus propios cupones. El descuento sale de tu liquidación, así que tú decides cuánto y hasta cuándo
          </p>
        </div>

        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs flex items-center gap-1.5"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm ? 'Cancelar' : 'Nueva promoción'}
        </button>
      </div>

      {(error || loadError) && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      {showForm && (
        <div className="zipp-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-[var(--color-text-main)]">Nueva promoción</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Código" hint="Lo que el cliente escribe en el carrito">
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                maxLength={20}
                placeholder="MARTES20"
                className={inputClass}
              />
            </Field>

            <Field label="Título" hint="Lo que el cliente ve en la lista de promociones">
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                maxLength={80}
                placeholder="20% los martes"
                className={inputClass}
              />
            </Field>

            <Field label="Tipo">
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as Coupon['type'] })}
                className={inputClass}
              >
                <option value="percentage">Porcentaje de descuento</option>
                <option value="fixed">Monto fijo de descuento</option>
                <option value="free_delivery">Envío gratis</option>
              </select>
            </Field>

            {form.type !== 'free_delivery' && (
              <Field
                label={form.type === 'percentage' ? 'Porcentaje' : 'Monto'}
                hint={form.type === 'percentage' ? 'Entre 1 y 100' : 'En pesos'}
              >
                <input
                  type="number"
                  min={1}
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: Number(e.target.value) })}
                  className={inputClass}
                />
              </Field>
            )}

            <Field label="Pedido mínimo" hint="Cero: sin mínimo">
              <input
                type="number"
                min={0}
                step={1000}
                value={form.minOrderAmount}
                onChange={(e) => setForm({ ...form, minOrderAmount: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>

            <Field
              label="Presupuesto máximo"
              hint="Cuánto estás dispuesto a gastar en total. Cero: sin tope"
            >
              <input
                type="number"
                min={0}
                step={10000}
                value={form.budgetLimit}
                onChange={(e) => setForm({ ...form, budgetLimit: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>

            <Field label="Usos totales" hint="Cero: ilimitado">
              <input
                type="number"
                min={0}
                value={form.usageLimit}
                onChange={(e) => setForm({ ...form, usageLimit: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>

            <Field label="Usos por cliente" hint="Evita que una sola persona la agote">
              <input
                type="number"
                min={0}
                value={form.perUserLimit}
                onChange={(e) => setForm({ ...form, perUserLimit: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>

            <Field label="Válida hasta">
              <input
                type="date"
                value={form.validUntil}
                onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="bg-[var(--color-warning-bg)] text-[var(--color-warning)] text-xs p-3 rounded-lg font-semibold">
            El descuento de esta promoción se descuenta de tu liquidación. El presupuesto
            máximo es tu freno: cuando se agota, la promoción deja de aplicarse sola.
          </div>

          <button
            onClick={create}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs"
          >
            {saving ? 'Creando…' : 'Crear promoción'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando promociones...
        </div>
      ) : coupons.length === 0 ? (
        <div className="table-container p-16 text-center space-y-2">
          <Tag className="w-8 h-8 text-[var(--color-text-muted)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">Todavía no tienes promociones</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Un cupón bien puesto llena las horas flojas. Empieza por un día concreto.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {coupons.map((coupon) => {
            const spent = coupon.budgetSpent ?? 0;
            const budget = coupon.budgetLimit ?? 0;
            const exhausted = budget > 0 && spent >= budget;
            const CouponArt = couponArt(coupon.type);

            return (
              <div
                key={coupon._id}
                className={`zipp-card p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                  coupon.isActive ? '' : 'opacity-60'
                }`}
              >
                <div className="flex items-start gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-[var(--color-sidebar-hover)] flex items-center justify-center flex-shrink-0 overflow-hidden">
                    <CouponArt size={34} />
                  </div>

                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h3 className="text-base font-bold text-[var(--color-text-main)]">{coupon.title}</h3>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] border border-[var(--color-border)] font-mono">
                        {coupon.code}
                      </span>
                      {!coupon.isActive && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-danger-bg)] text-[var(--color-danger)]">
                          Desactivada
                        </span>
                      )}
                      {exhausted && coupon.isActive && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-warning-bg)] text-[var(--color-warning)]">
                          Presupuesto agotado
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                      {TYPE_LABELS[coupon.type]}
                      {coupon.type === 'percentage' ? ` · ${coupon.value}%` : ''}
                      {coupon.type === 'fixed' ? ` · ${money(coupon.value)}` : ''}
                      {coupon.minOrderAmount ? ` · Mínimo ${money(coupon.minOrderAmount)}` : ''}
                      {` · Hasta el ${new Date(coupon.validUntil).toLocaleDateString('es-CO')}`}
                    </p>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
                      <span>
                        Usada {coupon.usedCount ?? 0}
                        {coupon.usageLimit ? ` de ${coupon.usageLimit}` : ' veces'}
                      </span>
                      {budget > 0 && (
                        <span className="font-mono">
                          Gastado {money(spent)} de {money(budget)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {coupon.isActive && (
                  <button
                    onClick={() => deactivate(coupon._id)}
                    className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
                  >
                    <Power className="w-4 h-4" />
                    Desactivar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {active.length > 0 && (
        <p className="text-xs text-[var(--color-text-muted)] font-medium">
          Desactivar no borra la promoción: los pedidos que ya la usaron siguen
          apareciendo en tus liquidaciones.
        </p>
      )}
    </div>
  );
}

const inputClass =
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-bold text-[var(--color-text-main)]">{label}</label>
      {children}
      {hint && <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}
