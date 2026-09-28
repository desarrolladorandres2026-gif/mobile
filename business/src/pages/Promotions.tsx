import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Tag, Power, Pencil, RotateCcw, Trash2, Info } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { CouponLogo, DeliveryLogo } from '../components/logos';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { money } from '../lib/orderFlow';
import ConfirmDialog from '../components/ConfirmDialog';
import ProductMultiSelect from '../components/ProductMultiSelect';
import DateRangeField from '../components/DateRangeField';
import PromotionStatusBadge from '../components/PromotionStatusBadge';

/**
 * Promociones que crea el propio comercio.
 *
 * Dos formas de descontar, y las dos las paga el comercio de su
 * liquidación — se dice en voz alta y en varios sitios porque es la
 * diferencia entre una herramienta útil y una sorpresa a fin de mes:
 *
 *  · **Con código**: el cliente lo escribe. Descuenta sobre el subtotal
 *    entero del pedido. Es lo que ya existía.
 *  · **Automática por productos**: sin código, se aplica sola cuando el
 *    carrito trae alguno de los productos elegidos, con fecha de inicio y
 *    fin. Es el mismo motor de cupones —presupuesto, auditoría, reparto—
 *    con un modo nuevo (`autoApply`) en vez de un mecanismo aparte.
 */

interface Coupon {
  _id: string;
  code: string;
  title: string;
  description?: string;
  type: 'percentage' | 'fixed' | 'free_delivery';
  scope?: 'product' | 'delivery' | 'service_fee';
  value: number;
  maxDiscountAmount?: number;
  minOrderAmount?: number;
  budgetLimit?: number;
  budgetSpent?: number;
  usageLimit?: number;
  usedCount?: number;
  validFrom?: string;
  validUntil: string;
  isActive: boolean;
  autoApply?: boolean;
  productIds?: string[];
  availability?: { state: 'active' | 'scheduled' | 'exhausted' };
}

const TYPE_LABELS: Record<Coupon['type'], string> = {
  percentage: 'Porcentaje',
  fixed: 'Monto fijo',
  free_delivery: 'Envío gratis',
};

function couponArt(type: Coupon['type']): ComponentType<{ size?: number }> {
  if (type === 'free_delivery') return DeliveryLogo;
  return CouponLogo;
}

const toDateInput = (iso?: string) => (iso ? iso.slice(0, 10) : '');

const emptyCodeForm = {
  code: '',
  title: '',
  type: 'percentage' as 'percentage' | 'fixed' | 'free_delivery',
  value: 10,
  minOrderAmount: 0,
  budgetLimit: 0,
  usageLimit: 0,
  perUserLimit: 1,
  validUntil: '',
};

const emptyAutoForm = {
  title: '',
  description: '',
  type: 'percentage' as 'percentage' | 'fixed',
  value: 20,
  maxDiscountAmount: 0,
  budgetLimit: 0,
  validFrom: new Date().toISOString().slice(0, 10),
  validUntil: '',
  productIds: [] as string[],
};

export default function Promotions() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  const [searchParams] = useSearchParams();
  const preselectProductId = searchParams.get('productId');

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'code' | 'auto'>(preselectProductId ? 'auto' : 'code');
  const [codeForm, setCodeForm] = useState(emptyCodeForm);
  const [autoForm, setAutoForm] = useState(emptyAutoForm);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (preselectProductId) {
      setAutoForm((f) => (f.productIds.includes(preselectProductId) ? f : { ...f, productIds: [...f.productIds, preselectProductId] }));
    }
  }, [preselectProductId]);

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

  // Productos ya cubiertos por otra promoción automática activa/programada,
  // para que el selector los muestre bloqueados antes de que el envío falle.
  const coveredByOther = useMemo(() => {
    const map = new Map<string, { couponId: string; title: string; validUntil: string }>();
    for (const c of coupons) {
      if (!c.autoApply || !c.isActive || c._id === editingId) continue;
      if (c.availability?.state === 'exhausted') continue;
      for (const productId of c.productIds ?? []) {
        map.set(productId, { couponId: c._id, title: c.title, validUntil: c.validUntil });
      }
    }
    return map;
  }, [coupons, editingId]);

  const resetForms = () => {
    setCodeForm(emptyCodeForm);
    setAutoForm(emptyAutoForm);
    setEditingId(null);
  };

  const startEdit = (coupon: Coupon) => {
    setEditingId(coupon._id);
    if (coupon.autoApply) {
      setMode('auto');
      setAutoForm({
        title: coupon.title,
        description: coupon.description ?? '',
        type: coupon.type === 'free_delivery' ? 'percentage' : coupon.type,
        value: coupon.value,
        maxDiscountAmount: coupon.maxDiscountAmount ?? 0,
        budgetLimit: coupon.budgetLimit ?? 0,
        validFrom: toDateInput(coupon.validFrom),
        validUntil: toDateInput(coupon.validUntil),
        productIds: coupon.productIds ?? [],
      });
    } else {
      setMode('code');
      setCodeForm({
        code: coupon.code,
        title: coupon.title,
        type: coupon.type,
        value: coupon.value,
        minOrderAmount: coupon.minOrderAmount ?? 0,
        budgetLimit: coupon.budgetLimit ?? 0,
        usageLimit: coupon.usageLimit ?? 0,
        perUserLimit: 1,
        validUntil: toDateInput(coupon.validUntil),
      });
    }
  };

  const createOrUpdateCode = async () => {
    if (!businessId) return;
    try {
      setError('');
      setSaving(true);
      const payload = {
        ...codeForm,
        code: codeForm.code.trim().toUpperCase(),
        scope: codeForm.type === 'free_delivery' ? 'delivery' : 'product',
        validUntil: new Date(codeForm.validUntil).toISOString(),
      };
      if (editingId) {
        const { code: _code, ...editable } = payload;
        void _code;
        await api.patch(`/coupons/business/${editingId}`, editable);
      } else {
        await api.post(`/coupons/business/${businessId}`, payload);
      }
      resetForms();
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo guardar la promoción.'));
    } finally {
      setSaving(false);
    }
  };

  const createOrUpdateAuto = async () => {
    if (!businessId) return;
    if (autoForm.productIds.length === 0) {
      setError('Elige al menos un producto para la promoción.');
      return;
    }
    try {
      setError('');
      setSaving(true);
      const payload = {
        title: autoForm.title,
        description: autoForm.description,
        type: autoForm.type,
        value: autoForm.value,
        maxDiscountAmount: autoForm.maxDiscountAmount,
        budgetLimit: autoForm.budgetLimit,
        validFrom: new Date(autoForm.validFrom).toISOString(),
        validUntil: new Date(autoForm.validUntil).toISOString(),
        productIds: autoForm.productIds,
        autoApply: true,
      };
      if (editingId) {
        const { autoApply: _autoApply, ...editable } = payload;
        void _autoApply;
        await api.patch(`/coupons/business/${editingId}`, editable);
      } else {
        await api.post(`/coupons/business/${businessId}`, payload);
      }
      resetForms();
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo guardar la promoción.'));
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

  const reactivate = async (couponId: string) => {
    try {
      setError('');
      await api.patch(`/coupons/business/${couponId}/reactivate`);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo reactivar la promoción.'));
    }
  };

  const remove = async () => {
    if (!confirmDeleteId) return;
    try {
      setError('');
      await api.delete(`/coupons/business/${confirmDeleteId}`);
      setConfirmDeleteId(null);
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo eliminar la promoción.'));
      setConfirmDeleteId(null);
    }
  };

  const active = coupons.filter((c) => c.isActive && c.availability?.state === 'active');
  const rest = coupons.filter((c) => !(c.isActive && c.availability?.state === 'active'));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Promociones</h1>
        <p className="page-subtitle">
          El descuento sale de tu liquidación, así que tú decides cuánto, sobre qué y hasta cuándo.
        </p>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)] flex items-center gap-2">
        <Info className="w-3.5 h-3.5 shrink-0" />
        El envío gratis por compra mínima se configura en{' '}
        <a href="/settings" className="font-semibold text-[var(--color-primary)] hover:underline">
          Perfil
        </a>
        , no aquí.
      </p>

      {(error || loadError) && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      <div className="cols3">
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="col-title flex-1">{editingId ? 'Editar promoción' : 'Nueva promoción'}</h2>
            {editingId && (
              <button onClick={resetForms} className="text-xs font-semibold text-[var(--color-text-secondary)] hover:underline">
                Cancelar edición
              </button>
            )}
          </div>

          {!editingId && (
            <div className="flex gap-1.5 p-1 rounded-lg bg-[var(--color-bg-alt)] w-fit">
              {(['code', 'auto'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer ${
                    mode === m
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                  }`}
                >
                  {m === 'code' ? 'Con código' : 'Automática por productos'}
                </button>
              ))}
            </div>
          )}

          {mode === 'code' ? (
            <div className="space-y-4">
              <div className="grid gap-3 grid-cols-2">
                <Field label="Código" hint="Lo que el cliente escribe en el carrito">
                  <input
                    value={codeForm.code}
                    onChange={(e) => setCodeForm({ ...codeForm, code: e.target.value.toUpperCase() })}
                    maxLength={20}
                    placeholder="MARTES20"
                    disabled={!!editingId}
                    className={inputClass}
                  />
                </Field>

                <Field label="Título" hint="Lo que el cliente ve en la lista de promociones">
                  <input
                    value={codeForm.title}
                    onChange={(e) => setCodeForm({ ...codeForm, title: e.target.value })}
                    maxLength={80}
                    placeholder="20% los martes"
                    className={inputClass}
                  />
                </Field>

                <Field label="Tipo">
                  <select
                    value={codeForm.type}
                    onChange={(e) => setCodeForm({ ...codeForm, type: e.target.value as Coupon['type'] })}
                    disabled={!!editingId}
                    className={inputClass}
                  >
                    <option value="percentage">Porcentaje de descuento</option>
                    <option value="fixed">Monto fijo de descuento</option>
                    <option value="free_delivery">Envío gratis</option>
                  </select>
                </Field>

                {codeForm.type !== 'free_delivery' && (
                  <Field
                    label={codeForm.type === 'percentage' ? 'Porcentaje' : 'Monto'}
                    hint={codeForm.type === 'percentage' ? 'Entre 1 y 100' : 'En pesos'}
                  >
                    <input
                      type="number"
                      min={1}
                      value={codeForm.value}
                      onChange={(e) => setCodeForm({ ...codeForm, value: Number(e.target.value) })}
                      className={inputClass}
                    />
                  </Field>
                )}

                <Field label="Pedido mínimo" hint="Cero: sin mínimo">
                  <input
                    type="number" min={0} step={1000}
                    value={codeForm.minOrderAmount}
                    onChange={(e) => setCodeForm({ ...codeForm, minOrderAmount: Number(e.target.value) })}
                    className={inputClass}
                  />
                </Field>

                <Field label="Presupuesto máximo" hint="Cero: sin tope">
                  <input
                    type="number" min={0} step={10000}
                    value={codeForm.budgetLimit}
                    onChange={(e) => setCodeForm({ ...codeForm, budgetLimit: Number(e.target.value) })}
                    className={inputClass}
                  />
                </Field>

                <Field label="Usos totales" hint="Cero: ilimitado">
                  <input
                    type="number" min={0}
                    value={codeForm.usageLimit}
                    onChange={(e) => setCodeForm({ ...codeForm, usageLimit: Number(e.target.value) })}
                    className={inputClass}
                  />
                </Field>

                <Field label="Válida hasta">
                  <input
                    type="date"
                    value={codeForm.validUntil}
                    onChange={(e) => setCodeForm({ ...codeForm, validUntil: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              </div>

              <p className="text-[var(--color-warning)] text-xs font-semibold">
                El presupuesto máximo solo frena de verdad si además pones un tope de usos: es el
                que sí controla cuántas veces se cobra sin código.
              </p>

              <button onClick={createOrUpdateCode} disabled={saving} className={submitClass}>
                {saving ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Crear promoción'}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="Título" hint="Lo que verás en tu lista de promociones">
                <input
                  value={autoForm.title}
                  onChange={(e) => setAutoForm({ ...autoForm, title: e.target.value })}
                  maxLength={80}
                  placeholder="20% en hamburguesas"
                  className={inputClass}
                />
              </Field>

              <div className="grid gap-3 grid-cols-2">
                <Field label="Tipo">
                  <select
                    value={autoForm.type}
                    onChange={(e) => setAutoForm({ ...autoForm, type: e.target.value as 'percentage' | 'fixed' })}
                    className={inputClass}
                  >
                    <option value="percentage">Porcentaje de descuento</option>
                    <option value="fixed">Monto fijo de descuento</option>
                  </select>
                </Field>
                <Field label={autoForm.type === 'percentage' ? 'Porcentaje' : 'Monto'}>
                  <input
                    type="number" min={1}
                    value={autoForm.value}
                    onChange={(e) => setAutoForm({ ...autoForm, value: Number(e.target.value) })}
                    className={inputClass}
                  />
                </Field>
              </div>

              {autoForm.type === 'percentage' && (
                <Field label="Tope del descuento" hint="En pesos. Cero: sin tope">
                  <input
                    type="number" min={0} step={1000}
                    value={autoForm.maxDiscountAmount}
                    onChange={(e) => setAutoForm({ ...autoForm, maxDiscountAmount: Number(e.target.value) })}
                    className={inputClass}
                  />
                </Field>
              )}

              <DateRangeField
                from={autoForm.validFrom}
                to={autoForm.validUntil}
                onChangeFrom={(v) => setAutoForm({ ...autoForm, validFrom: v })}
                onChangeTo={(v) => setAutoForm({ ...autoForm, validUntil: v })}
              />

              <Field label="Productos en promoción" hint="Un producto solo puede estar en una promoción automática a la vez">
                {businessId && (
                  <ProductMultiSelect
                    businessId={businessId}
                    selected={autoForm.productIds}
                    onChange={(ids) => setAutoForm({ ...autoForm, productIds: ids })}
                    coveredByOther={coveredByOther}
                  />
                )}
              </Field>

              <button onClick={createOrUpdateAuto} disabled={saving} className={submitClass}>
                {saving ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Crear promoción'}
              </button>
            </div>
          )}
        </section>

        {([
          { key: 'active', title: 'Activas', list: active },
          { key: 'rest', title: 'Programadas, finalizadas y desactivadas', list: rest },
        ] as const).map(({ key, title, list }) => (
          <section key={key}>
            <h2 className="col-title">{title} · {list.length}</h2>
            {loading ? (
              <p className="py-2 text-xs text-[var(--color-text-secondary)]">Cargando promociones…</p>
            ) : list.length === 0 ? (
              <div className="py-6 text-center space-y-2">
                <Tag className="w-6 h-6 text-[var(--color-text-muted)] mx-auto" />
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {key === 'active'
                    ? 'Un cupón bien puesto llena las horas flojas. Empieza por un día concreto.'
                    : 'Nada por aquí todavía.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {list.map((coupon) => {
                  const CouponArt = couponArt(coupon.type);
                  return (
                    <li key={coupon._id} className={`py-4 flex flex-col gap-3 ${coupon.isActive ? '' : 'opacity-70'}`}>
                      <div className="flex items-start gap-4 min-w-0">
                        <CouponArt size={30} />
                        <div className="min-w-0 space-y-1.5 flex-1">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <h3 className="text-sm font-bold text-[var(--color-text-main)]">{coupon.title}</h3>
                            {coupon.autoApply ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                                {coupon.productIds?.length ?? 0} producto(s)
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] border border-[var(--color-border)] font-mono">
                                {coupon.code}
                              </span>
                            )}
                            <PromotionStatusBadge promotion={coupon} />
                          </div>

                          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
                            {TYPE_LABELS[coupon.type]}
                            {coupon.type === 'percentage' ? ` · ${coupon.value}%` : ''}
                            {coupon.type === 'fixed' ? ` · ${money(coupon.value)}` : ''}
                            {coupon.minOrderAmount ? ` · Mínimo ${money(coupon.minOrderAmount)}` : ''}
                            {coupon.validFrom ? ` · Desde el ${new Date(coupon.validFrom).toLocaleDateString('es-CO')}` : ''}
                            {` · Hasta el ${new Date(coupon.validUntil).toLocaleDateString('es-CO')}`}
                          </p>

                          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
                            <span>
                              Usada {coupon.usedCount ?? 0}
                              {coupon.usageLimit ? ` de ${coupon.usageLimit}` : ' veces'}
                            </span>
                            {(coupon.budgetLimit ?? 0) > 0 && (
                              <span className="font-mono">
                                Gastado {money(coupon.budgetSpent ?? 0)} de {money(coupon.budgetLimit ?? 0)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => startEdit(coupon)}
                          className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] transition-all cursor-pointer flex items-center gap-1.5"
                        >
                          <Pencil className="w-4 h-4" />
                          Editar
                        </button>

                        {coupon.isActive ? (
                          <button
                            onClick={() => deactivate(coupon._id)}
                            className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5"
                          >
                            <Power className="w-4 h-4" />
                            Desactivar
                          </button>
                        ) : (
                          <button
                            onClick={() => reactivate(coupon._id)}
                            className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-success-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-success)] transition-all cursor-pointer flex items-center gap-1.5"
                          >
                            <RotateCcw className="w-4 h-4" />
                            Reactivar
                          </button>
                        )}

                        {(coupon.usedCount ?? 0) === 0 && (
                          <button
                            onClick={() => setConfirmDeleteId(coupon._id)}
                            className="px-3.5 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-danger-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5"
                          >
                            <Trash2 className="w-4 h-4" />
                            Eliminar
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {key === 'rest' && list.length > 0 && (
              <p className="pt-2 text-xs text-[var(--color-text-muted)]">
                Desactivar no borra la promoción: los pedidos que ya la usaron siguen apareciendo
                en tus liquidaciones. Solo se puede eliminar de verdad una que nunca tuvo pedidos.
              </p>
            )}
          </section>
        ))}
      </div>

      {confirmDeleteId && (
        <ConfirmDialog
          title="¿Eliminar esta promoción?"
          message="No se puede deshacer. Si prefieres poder reactivarla después, desactívala en vez de eliminarla."
          confirmLabel="Eliminar"
          variant="danger"
          onConfirm={remove}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

const inputClass =
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50';

const submitClass =
  'px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer shadow-xs disabled:opacity-60';

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
