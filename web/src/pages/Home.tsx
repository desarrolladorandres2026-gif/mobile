import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DeliverySimulator from '../components/DeliverySimulator';
import { LinkButton } from '../components/Button';
import { BusinessRow } from '../components/BusinessRow';
import { StateMessage } from '../components/StateMessage';
import { TEXT_LINK } from '../components/ui';
import { listBusinesses, type BusinessListItem } from '../lib/api';
import { CitySelect } from '../components/CitySelect';
import { useCity } from '../lib/city';
import { CATEGORIES, freeDeliveryText } from '../lib/format';
import { supportWhatsAppUrl } from '../lib/contact';
import { BUSINESS_URL } from '../lib/config';
import { setPageMeta } from '../lib/meta';


export default function Home() {
  const { city } = useCity();
  const [loaded, setLoaded] = useState<{ city: string; rows: BusinessListItem[] } | null>(null);
  const [failedCity, setFailedCity] = useState<string | null>(null);

  useEffect(() => {
    setPageMeta({
      title: `ZIPP | Domicilios en ${city}`,
      description: `Pide en los comercios de ${city} con precio claro y seguimiento en tiempo real.`,
      path: '/',
    });
  }, [city]);

  useEffect(() => {
    let cancelled = false;
    listBusinesses({ city })
      .then((rows) => { if (!cancelled) setLoaded({ city, rows }); })
      .catch(() => { if (!cancelled) setFailedCity(city); });
    return () => { cancelled = true; };
  }, [city]);

  const businesses = loaded?.city === city ? loaded.rows : null;
  const error = failedCity === city;

  const promos = (businesses ?? []).filter((b) => freeDeliveryText(b.freeDeliveryThreshold, b.showPromoBanner));

  return (
    <div className="bg-bg text-text-main">
      {/* Primer bloque: qué se puede pedir y cómo empezar. Sin imagen decorativa. */}
      <section id="inicio" className="px-6 pb-12 pt-12 sm:px-10 sm:pb-16 sm:pt-20">
        <div className="mx-auto max-w-6xl">
          <h1 className="max-w-xl text-2xl font-semibold leading-tight text-text-main lg:text-hero">
            Pide en los comercios de {city}
          </h1>
          <CitySelect />
          <p className="mt-4 max-w-lg text-base text-text-secondary">
            Mira comercios, precios y tiempos de entrega sin crear cuenta. El domicilio se
            calcula por la distancia real a tu dirección.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <LinkButton href="/comercios" variant="primary">Ver comercios</LinkButton>
            <LinkButton href="#descargar" variant="secondary">Cómo pedir</LinkButton>
          </div>

          <nav aria-label="Categorías" className="mt-10 flex gap-x-6 overflow-x-auto border-t border-border pt-2">
            {CATEGORIES.map((c) => (
              <Link key={c.key} to={`/comercios?categoria=${c.key}`} className={`${TEXT_LINK} shrink-0`}>
                {c.label}
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <section id="comercios" className="px-6 pb-16 sm:px-10">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-xl font-semibold text-text-main">Comercios en {city}</h2>
          {error ? (
            <StateMessage kind="error" title="No pudimos cargar los comercios">
              Revisa tu conexión y recarga la página.
            </StateMessage>
          ) : businesses === null ? (
            <div className="min-h-[30rem]">
              <StateMessage kind="loading" title="Cargando comercios" />
            </div>
          ) : businesses.length === 0 ? (
            <StateMessage kind="empty" title="Todavía no hay comercios en esta ciudad">
              Vuelve pronto o escríbenos para sumar el tuyo.
            </StateMessage>
          ) : (
            <>
              <ul className="mt-2">{businesses.slice(0, 8).map((b) => <BusinessRow key={b._id} business={b} />)}</ul>
              <Link to="/comercios" className={`${TEXT_LINK} mt-2 font-semibold`}>
                Ver los {businesses.length} comercios
              </Link>
            </>
          )}
        </div>
      </section>

      {promos.length > 0 && (
        <section id="promociones" className="px-6 pb-16 sm:px-10">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-xl font-semibold text-text-main">Envío gratis</h2>
            <p className="mt-2 max-w-lg text-base text-text-secondary">
              Condiciones de cada comercio, vigentes hoy.
            </p>
            <ul className="mt-2">
              {promos.map((b) => (
                <li key={b._id} className="border-b border-border">
                  <Link
                    to={`/negocio/${b.slug}`}
                    className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 py-2 text-base text-text-main hover:text-primary-text"
                  >
                    <span className="font-semibold">{b.name}</span>
                    <span>{freeDeliveryText(b.freeDeliveryThreshold, b.showPromoBanner)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section id="simulador" className="bg-bg-alt px-6 py-16 sm:px-10">
        <DeliverySimulator />
      </section>

      <section className="px-6 py-16 sm:px-10">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 md:grid-cols-2">
          <div id="vende" className="scroll-mt-24">
            <h2 className="text-xl font-semibold text-text-main">Vende en ZIPP</h2>
            <p className="mt-2 max-w-md text-base text-text-secondary">
              Recibe los pedidos en tu panel de cocina, con aviso sonoro apenas entran, y despacha
              con los repartidores disponibles más cerca de tu local.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <LinkButton href="/unete-comercio" variant="primary">Registrar mi comercio</LinkButton>
              <LinkButton href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" variant="secondary">
                Acceder al portal
              </LinkButton>
            </div>
          </div>
          <div id="reparte" className="scroll-mt-24">
            <h2 className="text-xl font-semibold text-text-main">Reparte con ZIPP</h2>
            <p className="mt-2 max-w-md text-base text-text-secondary">
              Ves el valor de la carrera y la propina antes de aceptar. La propina llega completa
              a quien entrega, sin comisión.
            </p>
            <LinkButton href="/repartidores" variant="primary" className="mt-6">
              Quiero repartir
            </LinkButton>
          </div>
        </div>
      </section>

      <section id="descargar" className="bg-bg-alt px-6 py-16 sm:px-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-text-main">Los pedidos se hacen en la app</h2>
            <p className="mt-2 max-w-md text-base text-text-secondary">
              La app de ZIPP está en fase piloto y todavía no está en App Store ni Google Play.
              Escríbenos y te avisamos cuando esté disponible.
            </p>
          </div>
          <LinkButton
            href={supportWhatsAppUrl('Hola, quiero que me avisen cuando la app de ZIPP esté disponible.')}
            target="_blank"
            rel="noopener noreferrer"
            variant="primary"
            className="shrink-0"
          >
            Avísenme cuando esté disponible
          </LinkButton>
        </div>
      </section>

      <section className="px-6 py-16 sm:px-10" aria-labelledby="atajos">
        <div className="mx-auto max-w-6xl">
          <h2 id="atajos" className="text-xl font-semibold text-text-main">Qué pedir en {city}</h2>
          <ul className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {CATEGORIES.map((c) => (
              <li key={c.key}>
                <Link to={`/comercios?categoria=${c.key}`} className={TEXT_LINK}>
                  {c.label} en {city}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
