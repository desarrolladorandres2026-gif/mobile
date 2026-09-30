import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Plus, Power, Pencil, RotateCcw, Trash2, Info } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { CouponLogo, DeliveryLogo } from '../components/logos';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { money } from '../lib/orderFlow';
import {
  TYPE_LABELS, toDateInput, emptyCodeForm, emptyAutoForm, discountLabel, groupOf, consumption,
  type Coupon, type PromotionGroup,
} from '../lib/promotions';
import ConfirmDialog from '../components/ConfirmDialog';
import PromotionStatusBadge from '../components/PromotionStatusBadge';
import PromotionPanel from '../components/PromotionPanel';

/**
 * Promociones que crea el propio comercio.
 *
 * Dos formas de descontar, y las dos las paga el comercio de su
 * liquidación — se dice en voz alta y en varios sitios porque es la
 * diferencia entre una herramienta útil y una sorpresa a fin de mes:
 *
 *  · **Con código**: el cliente lo escribe. Descuenta sobre el subtotal
 *    entero del pedido.
 *  · **Automática por productos**: sin código, se aplica sola cuando el
 *    carrito trae alguno de los productos elegidos. Es el mismo motor de
 *    cupones —presupuesto, auditoría, reparto— con un modo (`autoApply`).
 *
 * La pantalla es solo la lista, agrupada por estado; crear y editar viven
 * en un panel lateral (`PromotionPanel`) con vista previa del costo.
 */

function couponArt(type: Coupon['type']): ComponentType<{ size?: number }> {
  return type === 'free_delivery' ? DeliveryLogo : CouponLogo;
}

const GROUPS: Array<{ key: PromotionGroup; title: string }> = [
  { key: 'active', title: 'Activas' },
  { key: 'scheduled', title: 'Programadas' },
  { key: 'ended', title: 'Finalizadas y desactivadas' },
];

export default function Promotions() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  const [searchParams] = useSearchParams();
  const preselectProductId = searchParams.get('productId');

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(!!preselectProductId);
  const [mode, setMode] = useState<'code' | 'auto'>(preselectProductId ? 'auto' : 'code');
  const [codeForm, setCodeForm] = useState(emptyCodeForm);
  const [autoForm, setAutoForm] = useState(emptyAutoForm);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);

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

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setCodeForm(emptyCodeForm);
    setAutoForm(emptyAutoForm);
    setEditingId(null);
    setError('');
  }, []);

  const startCreate = () => {
    setError('');
    setEditingId(null);
    setCodeForm(emptyCodeForm);
    setAutoForm(emptyAutoForm);
    setPanelOpen(true);
  };

  const startEdit = (coupon: Coupon) => {
    setError('');
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
    setPanelOpen(true);
  };

  const createOrUpdateCode = async () => {
    if (!businessId) return;
    if (!codeForm.validUntil) {
      setError('Elige hasta cuándo es válida la promoción.');
      return;
    }
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
      closePanel();
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
    if (!autoForm.validFrom || !autoForm.validUntil) {
      setError('Elige desde y hasta cuándo corre la promoción.');
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
      closePanel();
      await load();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo guardar la promoción.'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (couponId: string, action: 'deactivate' | 'reactivate') => {
    try {
      setError('');
      await api.patch(`/coupons/business/${couponId}/${action}`);
      await load();
    } catch (err) {
      setError(apiMessage(err, action === 'deactivate' ? 'No se pudo desactivar la promoción.' : 'No se pudo reactivar la promoción.'));
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

  const grouped = useMemo(() => {
    const map: Record<PromotionGroup, Coupon[]> = { active: [], scheduled: [], ended: [] };
    for (const coupon of coupons) map[groupOf(coupon)].push(coupon);
    return map;
  }, [coupons]);

  const rowButton = 'flex items-center gap-1.5 text-xs font-semibold cursor-pointer hover:underline';

  return (
    <div className="space-y-8">
      <div className="page-header">
        <div>
          <h1 className="page-title">Promociones</h1>
          <p className="page-subtitle">
            El descuento sale de tu liquidación, así que tú decides cuánto, sobre qué y hasta cuándo.
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[var(--color-primary-dark)] transition-colors cursor-pointer flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Nueva promoción
        </button>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)] flex items-center gap-2">
        <Info className="w-3.5 h-3.5 shrink-0" />
        El envío gratis por compra mínima se configura en{' '}
        <a href="/settings" className="font-semibold text-[var(--color-primary)] hover:underline">
          Perfil
        </a>
        , no aquí.
      </p>

      {((!panelOpen && error) || loadError) && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      {loading ? (
        <p className="py-2 text-xs text-[var(--color-text-secondary)]">Cargando promociones…</p>
      ) : coupons.length === 0 ? (
        <div className="py-16 space-y-3 max-w-md">
          <p className="text-sm font-bold text-[var(--color-text-main)]">Todavía no tienes promociones</p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Un cupón bien puesto llena las horas flojas. Empieza por un día concreto.
          </p>
          <button type="button" onClick={startCreate} className="text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer">
            Crear la primera
          </button>
        </div>
      ) : (
        GROUPS.map(({ key, title }) => {
          const list = grouped[key];
          if (list.length === 0 && key !== 'active') return null;
          const collapsed = key === 'ended' && !showEnded;
          return (
            <section key={key} className="space-y-1">
              <div className="flex items-baseline justify-between border-b border-[var(--color-border)] pb-2">
                <h2 className="col-title border-b-0 pb-0 mb-0">{title} · {list.length}</h2>
                {key === 'ended' && (
                  <button type="button" onClick={() => setShowEnded((v) => !v)} className="text-xs font-semibold text-[var(--color-primary)] hover:underline cursor-pointer">
                    {showEnded ? 'Ocultar' : 'Mostrar'}
                  </button>
                )}
              </div>

              {list.length === 0 ? (
                <p className="py-6 text-xs text-[var(--color-text-secondary)]">Nada activo ahora mismo.</p>
              ) : collapsed ? null : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {list.map((coupon) => {
                    const CouponArt = couponArt(coupon.type);
                    const used = consumption(coupon);
                    return (
                      <li
                        key={coupon._id}
                        className={`py-5 grid gap-4 md:grid-cols-[minmax(0,2fr)_7rem_minmax(0,1.2fr)_auto] md:items-center ${coupon.isActive ? '' : 'opacity-70'}`}
                      >
                        <div className="flex items-start gap-4 min-w-0">
                          <CouponArt size={30} />
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <h3 className="text-sm font-bold text-[var(--color-text-main)]">{coupon.title}</h3>
                              <PromotionStatusBadge promotion={coupon} />
                            </div>
                            <p className="text-xs text-[var(--color-text-secondary)]">
                              {coupon.autoApply ? (
                                <>Automática · {coupon.productIds?.length ?? 0} producto(s)</>
                              ) : (
                                <>Código <span className="font-mono font-bold text-[var(--color-text-main)]">{coupon.code}</span></>
                              )}
                              {coupon.minOrderAmount ? ` · Mínimo ${money(coupon.minOrderAmount)}` : ''}
                            </p>
                            <p className="text-xs text-[var(--color-text-secondary)]">
                              {coupon.validFrom ? `${new Date(coupon.validFrom).toLocaleDateString('es-CO')} → ` : 'Hasta el '}
                              {new Date(coupon.validUntil).toLocaleDateString('es-CO')}
                            </p>
                          </div>
                        </div>

                        <div>
                          <p className="text-xl font-bold tabular text-[var(--color-primary)]">{discountLabel(coupon.type, coupon.value)}</p>
                          <p className="text-[11px] text-[var(--color-text-secondary)]">{TYPE_LABELS[coupon.type]}</p>
                        </div>

                        <div className="space-y-1.5 min-w-0">
                          <p className="text-xs text-[var(--color-text-secondary)] tabular">
                            {coupon.usedCount ?? 0} {(coupon.usedCount ?? 0) === 1 ? 'uso' : 'usos'}
                            {used ? ` · ${used.label}` : ' · sin tope'}
                          </p>
                          {used && (
                            <div className="h-0.5 w-full bg-[var(--color-border)]" role="progressbar" aria-valuenow={Math.round(used.ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
                              <div
                                className={`h-full ${used.ratio >= 0.9 ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-primary)]'}`}
                                style={{ width: `${used.ratio * 100}%` }}
                              />
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:justify-end">
                          <button onClick={() => startEdit(coupon)} className={`${rowButton} text-[var(--color-text-main)]`}>
                            <Pencil className="w-3.5 h-3.5" />
                            Editar
                          </button>
                          {coupon.isActive ? (
                            <button onClick={() => toggle(coupon._id, 'deactivate')} className={`${rowButton} text-[var(--color-text-secondary)]`}>
                              <Power className="w-3.5 h-3.5" />
                              Desactivar
                            </button>
                          ) : (
                            <button onClick={() => toggle(coupon._id, 'reactivate')} className={`${rowButton} text-[var(--color-success)]`}>
                              <RotateCcw className="w-3.5 h-3.5" />
                              Reactivar
                            </button>
                          )}
                          {(coupon.usedCount ?? 0) === 0 && (
                            <button onClick={() => setConfirmDeleteId(coupon._id)} className={`${rowButton} text-[var(--color-danger)]`}>
                              <Trash2 className="w-3.5 h-3.5" />
                              Eliminar
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {key === 'ended' && showEnded && list.length > 0 && (
                <p className="pt-2 text-xs text-[var(--color-text-secondary)]">
                  Desactivar no borra la promoción: los pedidos que ya la usaron siguen apareciendo
                  en tus liquidaciones. Solo se puede eliminar de verdad una que nunca tuvo pedidos.
                </p>
              )}
            </section>
          );
        })
      )}

      {panelOpen && businessId && (
        <PromotionPanel
          mode={mode}
          editing={!!editingId}
          onModeChange={setMode}
          codeForm={codeForm}
          onCodeChange={setCodeForm}
          autoForm={autoForm}
          onAutoChange={setAutoForm}
          businessId={businessId}
          coveredByOther={coveredByOther}
          saving={saving}
          error={error}
          onSubmit={mode === 'code' ? createOrUpdateCode : createOrUpdateAuto}
          onClose={closePanel}
        />
      )}

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
