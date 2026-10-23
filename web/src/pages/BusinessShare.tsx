import { setPageMeta } from '../lib/meta';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getStorefrontBySlug, type MenuProduct, type Storefront } from '../lib/api';
import { LinkButton } from '../components/Button';
import { CartBar } from '../components/CartBar';
import { ProductSheet } from '../components/ProductSheet';
import { ProductRow } from '../components/ProductRow';
import { StateMessage } from '../components/StateMessage';
import { sizedImage } from '../lib/cloudinary';
import { categoryLabel, freeDeliveryText, money, ratingText } from '../lib/format';
import { isOpenNow, todayHoursText } from '../lib/hours';

type Load = { slug: string; data: Storefront | null } | { slug: string; failed: true };

/**
 * La página pública de un comercio: ficha, carta y una sola salida real,
 * "Abrir en la app".
 *
 * Es también a donde llega el enlace del botón "Compartir" de la app. No hay
 * carrito en la web: el pedido exige sesión de cliente y se hace en la app.
 * El botón usa el esquema `zipp://` — funciona si la app ya está instalada y
 * no hace nada visible si no. No hay enlace de tienda de aplicaciones porque
 * ZIPP no está publicada: prometerlo sería un enlace roto.
 */
export default function BusinessShare() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [load, setLoad] = useState<Load | null>(null);
  const [selected, setSelected] = useState<MenuProduct | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStorefrontBySlug(slug)
      .then((data) => { if (!cancelled) setLoad({ slug, data }); })
      .catch(() => { if (!cancelled) setLoad({ slug, failed: true }); });
    return () => { cancelled = true; };
  }, [slug]);

  const current = load?.slug === slug ? load : null;
  const data = current && 'data' in current ? current.data : undefined;
  const business = data?.business;

  useEffect(() => {
    if (business) {
      setPageMeta({
        title: `${business.name} en ${business.city} | ZIPP`,
        description: business.description || `Pide en ${business.name}, ${business.city}. Mira la carta, el horario y el tiempo de entrega.`,
        path: `/negocio/${business.slug}`,
      });
    }
  }, [business]);

  if (!current) {
    return (
      <div className="mx-auto max-w-3xl px-6 sm:px-10">
        <StateMessage kind="loading" title="Cargando comercio" />
      </div>
    );
  }

  if ('failed' in current) {
    return (
      <div className="mx-auto max-w-3xl px-6 sm:px-10">
        <StateMessage kind="error" title="No pudimos cargar este comercio">
          Revisa tu conexión y recarga la página.
        </StateMessage>
      </div>
    );
  }

  if (!business || !data) {
    return (
      <div className="mx-auto max-w-3xl px-6 sm:px-10">
        <StateMessage kind="empty" title="No encontramos este comercio">
          El enlace puede estar mal escrito o el comercio ya no está en ZIPP.
          <LinkButton href="/comercios" variant="secondary" className="mt-6">Ver comercios</LinkButton>
        </StateMessage>
      </div>
    );
  }

  const open = isOpenNow(business.schedule);
  const rating = ratingText(business.rating, business.totalReviews);
  const free = freeDeliveryText(business.freeDeliveryThreshold, business.showPromoBanner);
  const hours = todayHoursText(business.schedule);

  const categories = [...data.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const sections = categories
    .map((c) => ({ id: c._id, name: c.name, items: data.products.filter((p) => p.categoryId === c._id) }))
    .filter((s) => s.items.length > 0);
  const known = new Set(categories.map((c) => c._id));
  const orphans: MenuProduct[] = data.products.filter((p) => !known.has(p.categoryId));
  if (orphans.length > 0) sections.push({ id: 'otros', name: 'Otros', items: orphans });

  const facts: [string, string][] = [
    ['Tipo', categoryLabel(business.category)],
    ['Tiempo estimado', `${business.deliveryTime} min`],
    ['Domicilio', business.deliveryFeeFrom ? `Desde ${money(business.deliveryFeeFrom)}` : 'Se calcula con tu dirección'],
    ['Pedido mínimo', business.minOrder > 0 ? money(business.minOrder) : 'Sin mínimo'],
  ];
  if (rating) facts.push(['Calificación', rating]);

  return (
    <div className="mx-auto max-w-3xl px-6 pt-10 pb-28 sm:px-10">
      {business.coverImage && (
        <img
          src={sizedImage(business.coverImage, 1200)}
          alt={`Portada de ${business.name}`}
          width={1200}
          height={450}
          fetchPriority="high"
          className="mb-8 aspect-[8/3] w-full rounded-sm object-cover"
        />
      )}

      <h1 className="text-2xl font-semibold text-text-main">{business.name}</h1>
      {business.description && <p className="mt-2 max-w-xl text-base text-text-secondary">{business.description}</p>}

      <p className="mt-4 text-base text-text-main">
        {open ? 'Abierto ahora' : 'Cerrado ahora'}
        {hours ? ` · ${hours}` : ''}
      </p>
      {free && <p className="text-base text-text-main">{free}</p>}

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-y border-border py-4 sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-text-secondary">{label}</dt>
            <dd className="text-base font-semibold text-text-main">{value}</dd>
          </div>
        ))}
      </dl>

      {business.address && <p className="mt-4 text-base text-text-secondary">{business.address}</p>}
      {business.phone && (
        <a href={`tel:${business.phone}`} className="inline-flex min-h-11 items-center text-base text-text-main underline underline-offset-4">
          {business.phone}
        </a>
      )}

      {!open && (
        <p className="mt-6 text-base text-text-main">
          Este comercio está cerrado ahora. Puedes ver la carta; volverás a poder pedir cuando abra.
        </p>
      )}

      <h2 className="mt-12 text-xl font-semibold text-text-main">Carta</h2>
      {sections.length === 0 ? (
        <StateMessage kind="empty" title="Este comercio todavía no tiene productos publicados">
          Vuelve más tarde.
        </StateMessage>
      ) : (
        <>
          <nav aria-label="Secciones de la carta" className="sticky top-16 z-10 mt-2 flex gap-x-6 overflow-x-auto border-b border-border bg-bg">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#seccion-${s.id}`}
                className="inline-flex min-h-11 shrink-0 items-center text-base text-text-secondary transition-colors duration-100 hover:text-text-main"
              >
                {s.name}
              </a>
            ))}
          </nav>
          {sections.map((s) => (
            <section key={s.id} id={`seccion-${s.id}`} className="scroll-mt-32">
              <h3 className="mt-8 text-lg font-semibold text-text-main">{s.name}</h3>
              <ul>{s.items.map((p) => <ProductRow key={p._id} product={p} onAdd={open ? setSelected : undefined} />)}</ul>
            </section>
          ))}
        </>
      )}
      {selected && (
        <ProductSheet
          product={selected}
          business={{ id: business._id, name: business.name, slug: business.slug }}
          onClose={() => setSelected(null)}
        />
      )}
      <CartBar />
    </div>
  );
}
