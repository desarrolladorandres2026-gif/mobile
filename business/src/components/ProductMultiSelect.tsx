import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { money } from '../lib/orderFlow';
import type { Product } from '../lib/catalog';

/**
 * Selector de productos para una promoción automática.
 *
 * Comparte `queryKey` con la carta de Menú (`qk.menu`), así que si ya está
 * en caché no vuelve a pedirla. Cada fila muestra si el producto ya está
 * cubierto por OTRA promoción activa — la misma regla de no-solapamiento
 * que el backend hace cumplir al guardar, mostrada antes de que el envío
 * falle.
 */

interface OtherPromotion {
  couponId: string;
  title: string;
  validUntil: string;
}

export default function ProductMultiSelect({
  businessId,
  selected,
  onChange,
  /** Productos cubiertos por OTRAS promociones activas: id → de cuál y hasta cuándo. */
  coveredByOther = new Map<string, OtherPromotion>(),
}: {
  businessId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  coveredByOther?: Map<string, OtherPromotion>;
}) {
  const [search, setSearch] = useState('');

  const menuQuery = useQuery({
    queryKey: qk.menu(businessId),
    queryFn: async () => {
      const [resCats, resProds] = await Promise.all([
        api.get(`/categories/business/${businessId}`),
        api.get(`/products/business/${businessId}?includeUnavailable=true`),
      ]);
      return { categories: resCats.data.data, products: resProds.data.data as Product[] };
    },
  });

  const products = menuQuery.data?.products ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return products;
    return products.filter((p) => p.name.toLowerCase().includes(term));
  }, [products, search]);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else onChange([...selected, id]);
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar producto…"
          className="w-full pl-8 pr-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
        />
      </div>

      <div className="max-h-64 overflow-y-auto divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md">
        {menuQuery.isPending ? (
          <p className="py-4 text-center text-xs text-[var(--color-text-secondary)]">Cargando productos…</p>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-center text-xs text-[var(--color-text-secondary)]">
            {search ? 'Ningún producto coincide.' : 'No tienes productos todavía.'}
          </p>
        ) : (
          filtered.map((product) => {
            const other = coveredByOther.get(product._id);
            const disabled = !!other && !selected.includes(product._id);

            return (
              <label
                key={product._id}
                className={`flex items-center gap-3 px-3 py-2 text-sm ${
                  disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--color-bg-alt)]'
                }`}
                title={other ? `Ya está en «${other.title}» hasta ${new Date(other.validUntil).toLocaleDateString('es-CO')}` : undefined}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(product._id)}
                  disabled={disabled}
                  onChange={() => toggle(product._id)}
                  className="accent-[var(--color-primary)]"
                />
                <span className="flex-1 min-w-0 truncate text-[var(--color-text-main)]">{product.name}</span>
                <span className="text-xs text-[var(--color-text-secondary)] font-mono">{money(product.price)}</span>
                {other && (
                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-bg-alt)] text-[var(--color-text-muted)] shrink-0">
                    En otra promo
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>

      {selected.length > 0 && (
        <p className="text-xs text-[var(--color-text-secondary)]">{selected.length} producto(s) seleccionado(s)</p>
      )}
    </div>
  );
}
