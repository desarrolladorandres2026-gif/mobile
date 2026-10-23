import type { MenuProduct } from '../lib/api';
import { sizedImage } from '../lib/cloudinary';
import { money } from '../lib/format';

/** Fila de carta: nombre, descripción corta y precio a la izquierda, foto cuadrada pequeña a la derecha. */
export function ProductRow({ product, onAdd }: { product: MenuProduct; onAdd?: (product: MenuProduct) => void }) {
  const discounted = product.discountPrice != null && product.discountPrice < product.price;
  const soldOut = product.isAvailable === false;

  return (
    <li className="flex min-h-[72px] items-start justify-between gap-4 border-b border-border py-4">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-text-main">{product.name}</h3>
        {product.description && (
          <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{product.description}</p>
        )}
        <p className="mt-2 text-base tabular-nums text-text-main">
          {soldOut ? (
            'Agotado'
          ) : discounted ? (
            <>
              <span className="font-semibold">{money(product.discountPrice!)}</span>
              <span className="ml-2 text-sm text-text-secondary line-through">{money(product.price)}</span>
            </>
          ) : (
            money(product.price)
          )}
        </p>
        {onAdd && !soldOut && (
          <button
            type="button"
            onClick={() => onAdd(product)}
            className="mt-2 min-h-11 text-base font-semibold text-primary-text underline underline-offset-4"
            aria-label={`Agregar ${product.name}`}
          >
            Agregar
          </button>
        )}
      </div>
      {product.image && (
        <img
          src={sizedImage(product.image, 128)}
          alt={product.name}
          width={64}
          height={64}
          loading="lazy"
          className="h-16 w-16 shrink-0 rounded-sm object-cover"
        />
      )}
    </li>
  );
}
