import { Clock, Plus } from 'lucide-react';
import { money } from '../../lib/orderFlow';
import {
  CafeLogo, FastFoodLogo, PharmacyLogo, RestaurantLogo, StoreLogo, SupermarketLogo,
} from '../logos';

/**
 * La ilustración que la app pone en un producto sin foto, por tipo de
 * negocio. Mismo reparto que `IllustrationRegistry` en
 * mobile/components/illustrations: lo que no está ahí cae en la tienda.
 */
const CATEGORY_LOGOS: Record<string, typeof StoreLogo> = {
  restaurant: RestaurantLogo,
  fast_food: FastFoodLogo,
  pharmacy: PharmacyLogo,
  cafe: CafeLogo,
  supermarket: SupermarketLogo,
};

/**
 * El producto tal y como aparece en la carta de la app.
 *
 * Réplica de `ProductRow` en mobile/app/(client)/business/[id].tsx —foto
 * de 136 con esquinas de 18, nombre en una sola línea, el tiempo, la
 * descripción en dos líneas, el precio con su tachado y el botón de
 * agregar—, con las mismas medidas de letra. Lo que se corta aquí se
 * corta allá: para eso está. Si la fila cambia en la app, cambia aquí.
 *
 * Plana, sin marco de teléfono: basta con el ancho de una pantalla para
 * que los cortes caigan donde caerían.
 */

interface Props {
  name: string;
  description: string;
  price: number | null;
  /** Solo si es una oferta válida (menor que el precio). */
  discountPrice: number | null;
  /** Etiqueta −X % ya resuelta con las reglas de la app. */
  discountPercent: number | null;
  /** Los minutos que enseña la app: los del plato o, si no tiene, los del negocio. */
  prepMinutes: number | null;
  imageSrc: string | null;
  /** Tipo de negocio: decide la ilustración cuando no hay foto. */
  businessCategory?: string;
}

export default function ProductPreview({
  name, description, price, discountPrice, discountPercent, prepMinutes, imageSrc, businessCategory,
}: Props) {
  const shownPrice = discountPrice ?? price;
  const hasName = name.trim().length > 0;

  return (
    <div className="flex w-full max-w-[360px] items-center gap-4 py-2">
      <div className="relative grid h-[136px] w-[136px] shrink-0 place-items-center overflow-hidden rounded-[18px] bg-[var(--color-bg-alt)]">
        {imageSrc ? (
          <img src={imageSrc} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <CategoryIllustration category={businessCategory} />
        )}
        {discountPercent ? (
          <span className="absolute left-1 top-1 rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-primary-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-primary-dark)]">
            -{discountPercent}%
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={`truncate text-[17px] font-bold leading-[22px] tracking-[-0.2px] ${
            hasName ? 'text-[var(--color-text-main)]' : 'text-[var(--color-text-muted)]'
          }`}
        >
          {hasName ? name.trim() : 'Tu producto'}
        </p>

        {prepMinutes ? (
          <p className="flex items-center gap-1 text-[11px] font-medium leading-[15px] text-[var(--color-text-main)]">
            <Clock className="h-3 w-3" aria-hidden />~{prepMinutes} min
          </p>
        ) : null}

        {description.trim() ? (
          <p className="line-clamp-2 text-[13px] leading-[19px] text-[var(--color-text-main)]">
            {description.trim()}
          </p>
        ) : null}

        <p className="mt-[3px] flex items-center gap-2 tabular">
          <span className="text-[15px] font-bold leading-5 tracking-[-0.4px] text-[var(--color-primary-dark)]">
            {shownPrice ? money(shownPrice) : '$ —'}
          </span>
          {discountPrice && price ? (
            <span className="text-[13px] leading-[17px] text-[var(--color-text-main)] line-through">
              {money(price)}
            </span>
          ) : null}
        </p>
      </div>

      <span
        aria-hidden
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--color-primary-light)] text-[var(--zipp-obsidian)] shadow-sm"
      >
        <Plus className="h-5 w-5" strokeWidth={2.5} />
      </span>
    </div>
  );
}

function CategoryIllustration({ category }: { category?: string }) {
  const Logo = (category && CATEGORY_LOGOS[category]) || StoreLogo;
  return <Logo size={64} />;
}
