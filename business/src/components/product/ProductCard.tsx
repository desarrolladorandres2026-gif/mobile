import type { MutableRefObject } from 'react';
import { Edit, Tag, ToggleLeft, ToggleRight, Trash2, Clock } from 'lucide-react';
import SmartImage from '../SmartImage';
import { money } from '../../lib/orderFlow';
import { discountPercent } from '../../lib/productForm';
import type { Product } from '../../lib/catalog';

/**
 * Las acciones de la carta, en un `ref` para que la tarjeta memorizada
 * llame siempre a la versión vigente sin volver a pintarse.
 */
export interface ProductCardActions {
  toggle: (product: Product) => void;
  edit: (product: Product) => void;
  deleteProduct: (productId: string) => void;
}

interface Props {
  product: Product;
  categoryName: string;
  actions: MutableRefObject<ProductCardActions>;
  canEdit: boolean;
  canDelete: boolean;
  canAvailability: boolean;
  canSeePromotions: boolean;
}

/**
 * Un producto de la carta del comercio: foto arriba, datos al centro y las
 * acciones abajo. La malla de `Menu` reparte tantas columnas como quepan.
 */
export default function ProductCard({
  product, categoryName, actions, canEdit, canDelete, canAvailability, canSeePromotions,
}: Props) {
  const offer = product.discountPrice ?? null;
  const percent = discountPercent(product.price, offer);
  const soldOut = !product.isAvailable;
  const backAt =
    soldOut && product.unavailableUntil
      ? new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }).format(
          new Date(product.unavailableUntil)
        )
      : null;
  const hasStock = typeof product.stock === 'number';
  const lowStock = hasStock && product.stock! > 0 && product.stock! <= (product.lowStockThreshold || 3);
  const canToggle = canEdit || canAvailability;

  return (
    <li className="zipp-card flex flex-col overflow-hidden transition-colors hover:border-[var(--color-border-strong)]">
      <div className="relative">
        <SmartImage
          images={product.images}
          alt={product.name}
          base="catalog"
          sizes="(min-width: 1536px) 16vw, (min-width: 1024px) 22vw, (min-width: 640px) 45vw, 90vw"
          className={`aspect-[4/3] w-full ${soldOut ? 'opacity-50 grayscale' : ''}`}
        />
        {percent ? (
          <span className="absolute left-2 top-2 rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-primary-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-primary-dark)]">
            -{percent}%
          </span>
        ) : null}
        {soldOut && (
          <span className="absolute right-2 top-2 rounded-full bg-[var(--color-danger)] px-2 py-0.5 text-[11px] font-bold text-white">
            Agotado
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
          <span>{categoryName}</span>
          {product.prepTimeMinutes ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden />~{product.prepTimeMinutes} min
            </span>
          ) : null}
          {product.requiresAgeVerification ? <span>+18</span> : null}
          {!product.images ? <span>Sin foto</span> : null}
        </p>

        <h3 className="text-[15px] font-bold leading-snug text-[var(--color-text-main)] line-clamp-2">
          {product.name}
        </h3>

        {product.description ? (
          <p className="text-xs leading-snug text-[var(--color-text-secondary)] line-clamp-2">
            {product.description}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1 text-xs font-medium empty:hidden">
          {product.promotedBy && (canSeePromotions ? (
            <a
              href={`/promotions?productId=${product._id}`}
              className="flex items-center gap-1 text-[var(--color-info)]"
            >
              <Tag className="h-3 w-3" />
              En promoción
            </a>
          ) : (
            // Sin `promotions:view` el enlace llevaría a una sección que el
            // panel esconde: se informa, no se enlaza.
            <span className="flex items-center gap-1 text-[var(--color-info)]">
              <Tag className="h-3 w-3" />
              En promoción
            </span>
          ))}
          {/* Solo aparece si el negocio lleva la cuenta. `null` es "no lo
              cuento" y no se muestra. */}
          {hasStock && (
            <span
              className={
                product.stock === 0
                  ? 'text-[var(--color-danger)]'
                  : lowStock
                    ? 'text-[var(--color-warning)]'
                    : 'text-[var(--color-text-main)]'
              }
            >
              {product.stock === 0 ? 'Sin unidades' : `Quedan ${product.stock}`}
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-2 pt-1 tabular">
          <span className="text-xl font-bold tracking-tight text-[var(--color-primary-dark)]">
            {money(offer ?? product.price)}
          </span>
          {offer ? (
            <span className="text-xs text-[var(--color-text-secondary)] line-through">
              {money(product.price)}
            </span>
          ) : null}
        </div>
      </div>

      {(canToggle || canEdit || canDelete) && (
        <div className="flex items-center gap-1 border-t border-[var(--color-border)] px-2.5 py-2">
          {canToggle && (
            <button
              onClick={() => actions.current.toggle(product)}
              aria-label={`Cambiar disponibilidad de ${product.name}`}
              aria-pressed={product.isAvailable}
              title={soldOut ? 'Volver a ofrecerlo' : 'Marcar como agotado'}
              className="mr-auto inline-flex items-center gap-1.5 rounded-md py-1 pr-2 text-xs font-medium text-[var(--color-text-main)] cursor-pointer"
            >
              {soldOut ? (
                <ToggleLeft className="h-6 w-6 text-[var(--color-text-muted)]" />
              ) : (
                <ToggleRight className="h-6 w-6 text-[var(--color-primary)]" />
              )}
              {soldOut ? 'Agotado' : 'Disponible'}
              {soldOut && backAt ? (
                <span className="font-normal text-[var(--color-text-secondary)]">· vuelve {backAt}</span>
              ) : null}
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => actions.current.edit(product)}
              aria-label={`Editar ${product.name}`}
              title="Editar"
              className="rounded-md p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-main)] cursor-pointer"
            >
              <Edit className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => actions.current.deleteProduct(product._id)}
              aria-label={`Eliminar ${product.name}`}
              title="Eliminar"
              className="rounded-md p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-danger)] cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
