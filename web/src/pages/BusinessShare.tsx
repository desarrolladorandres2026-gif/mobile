import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Star, MapPin, Phone, Clock, ShoppingBag, Percent } from 'lucide-react';
import { getSharedBusiness, type SharedBusiness } from '../lib/api';
import { StoreIllustration } from '../components/illustrations';
import { LinkButton } from '../components/Button';
import { sizedImage } from '../lib/cloudinary';

/** Mismas etiquetas que `mobile/constants/config.ts` — BUSINESS_CATEGORIES. */
const CATEGORY_LABEL: Record<string, string> = {
  restaurant: 'Restaurante',
  fast_food: 'Comida rápida',
  pharmacy: 'Droguería',
  cafe: 'Cafetería',
  supermarket: 'Mercado',
};

const money = (value: number) => `$${Math.round(value).toLocaleString('es-CO')}`;

/**
 * Lo que abre alguien que toca un enlace compartido desde la app —el botón
 * "Compartir" de la ficha de un negocio manda aquí, no un mensaje de texto.
 *
 * Sin sesión, sin carrito, sin nada que solo tenga sentido dentro de la app:
 * es una tarjeta de presentación con una sola salida real, "Abrir en la
 * app". Ese botón usa el esquema `zipp://` — funciona si quien lo toca ya
 * tiene Zipp instalada (el sistema operativo la abre directo, sin pedir
 * permiso ni verificar dominio) y no hace nada visible si no la tiene. No
 * hay enlace de tienda de aplicaciones todavía porque Zipp no está
 * publicada: prometerlo sería un enlace roto.
 */
export default function BusinessShare() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [business, setBusiness] = useState<SharedBusiness | null | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusiness(undefined);
    setError(false);
    getSharedBusiness(slug)
      .then((b) => { if (!cancelled) setBusiness(b); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [slug]);

  if (business === undefined && !error) {
    return (
      <div className="px-6 sm:px-10 py-24 text-center text-sm text-text-secondary">
        Cargando…
      </div>
    );
  }

  if (error || business === null) {
    return (
      <div className="px-6 sm:px-10 py-24 text-center max-w-md mx-auto">
        <h1 className="text-2xl font-bold tracking-tight">No encontramos este negocio</h1>
        <p className="mt-3 text-sm text-text-secondary">
          El enlace puede estar mal escrito o el negocio ya no está disponible en Zipp.
        </p>
        <LinkButton href="/" variant="secondary" className="mt-8">
          Ir al inicio
        </LinkButton>
      </div>
    );
  }

  // Inalcanzable en la práctica: los dos `return` de arriba ya cubren
  // `undefined` y `null`. TypeScript no cruza los dos `if` para deducirlo,
  // así que queda explícito en vez de un `!` que oculte el caso real.
  if (!business) return null;

  const appLink = `zipp://business/${business._id}`;
  const backdrop = business.brandColor || '#141B2A';

  return (
    <div>
      {/* ── Portada ── */}
      <div
        className="relative h-56 sm:h-72 flex items-end justify-center overflow-hidden"
        style={{ backgroundColor: backdrop }}
      >
        {business.coverImage ? (
          <img
            src={sizedImage(business.coverImage, 1200)}
            alt=""
            fetchPriority="high"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(10,13,20,0.1), rgba(10,13,20,0.85))',
          }}
        />

        <div className="relative flex flex-col items-center gap-2 pb-6 px-6 text-center">
          <div className="h-20 w-20 rounded-full border-2 border-white/80 bg-surface overflow-hidden grid place-items-center shadow-lg">
            {business.logo ? (
              <img src={sizedImage(business.logo, 240)} alt="" width={80} height={80} className="h-full w-full object-cover" />
            ) : (
              <StoreIllustration size={40} />
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            {business.name}
          </h1>
          {business.description && (
            <p className="max-w-sm text-sm text-white/85">{business.description}</p>
          )}
        </div>
      </div>

      {/* ── Datos ── */}
      <div className="mx-auto max-w-xl px-6 sm:px-10 py-8 space-y-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text-secondary">
          <span className="flex items-center gap-1.5">
            <Star className="h-4 w-4 text-primary" fill="currentColor" />
            <span className="font-semibold text-text-main">{business.rating.toFixed(1)}</span>
            <span>({business.totalReviews} reseñas)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4" />
            {business.deliveryTime} min
          </span>
          <span>{CATEGORY_LABEL[business.category] ?? business.category}</span>
        </div>

        {business.address && (
          <div className="flex items-start gap-2 text-sm text-text-secondary">
            <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{business.address}</span>
          </div>
        )}

        {business.phone && (
          <a
            href={`tel:${business.phone}`}
            className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-main transition-colors w-fit"
          >
            <Phone className="h-4 w-4 shrink-0" />
            {business.phone}
          </a>
        )}

        <div className="flex flex-wrap gap-2">
          {business.minOrder > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-text-secondary">
              <ShoppingBag className="h-3.5 w-3.5" />
              Pedido mínimo {money(business.minOrder)}
            </span>
          )}
          {business.showPromoBanner && business.freeDeliveryThreshold > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-primary-bg text-primary px-3 py-1.5 text-xs font-semibold">
              <Percent className="h-3.5 w-3.5" />
              Envío gratis desde {money(business.freeDeliveryThreshold)}
            </span>
          )}
        </div>

        <div className="pt-4 border-t border-border">
          <LinkButton href={appLink} variant="primary" className="w-full sm:w-auto">
            Abrir en la app Zipp
          </LinkButton>
          <p className="mt-3 text-xs text-text-muted">
            Necesitas tener Zipp instalada. Si el botón no hace nada, es que todavía no la
            tienes en este dispositivo.
          </p>
        </div>
      </div>
    </div>
  );
}
