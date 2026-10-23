import { Link } from 'react-router-dom';
import type { BusinessListItem } from '../lib/api';
import { sizedImage } from '../lib/cloudinary';
import { categoryLabel, freeDeliveryText, money, ratingText } from '../lib/format';
import { isOpenNow } from '../lib/hours';

/**
 * Una fila de comercio: foto de 64 px, nombre y una línea de datos reales.
 * El domicilio no va aquí porque el listado no lo trae (solo la ficha, con
 * `deliveryFeeFrom`); pedir una ficha por fila sería N peticiones.
 */
export function BusinessRow({ business }: { business: BusinessListItem }) {
  const open = isOpenNow(business.schedule);
  const rating = ratingText(business.rating, business.totalReviews);
  const free = freeDeliveryText(business.freeDeliveryThreshold, business.showPromoBanner);

  const facts = [
    categoryLabel(business.category),
    `${business.deliveryTime} min`,
    business.minOrder > 0 ? `Mínimo ${money(business.minOrder)}` : 'Sin pedido mínimo',
    rating,
  ].filter(Boolean);

  return (
    <li className="border-b border-border">
      <Link
        to={`/negocio/${business.slug}`}
        className="flex min-h-[72px] items-center gap-4 py-3 transition-colors duration-100 hover:bg-surface-hover"
      >
        {business.logo ? (
          <img
            src={sizedImage(business.logo, 128)}
            alt={business.name}
            width={64}
            height={64}
            loading="lazy"
            className="h-16 w-16 shrink-0 rounded-sm object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-sm bg-surface text-lg font-semibold text-text-main"
          >
            {business.name.slice(0, 1).toUpperCase()}
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold text-text-main">{business.name}</span>
          <span className="block text-sm text-text-secondary">{facts.join(' · ')}</span>
          <span className="block text-sm text-text-main">
            {open ? 'Abierto ahora' : 'Cerrado ahora'}
            {free ? ` · ${free}` : ''}
          </span>
        </span>
      </Link>
    </li>
  );
}
