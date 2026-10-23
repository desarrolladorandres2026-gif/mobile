import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listBusinesses, type BusinessListItem } from '../lib/api';
import { CitySelect } from '../components/CitySelect';
import { useCity } from '../lib/city';
import { CATEGORIES } from '../lib/format';
import { isOpenNow } from '../lib/hours';
import { setPageMeta } from '../lib/meta';
import { BusinessRow } from '../components/BusinessRow';
import { StateMessage } from '../components/StateMessage';
import { INPUT } from '../components/ui';

type Sort = 'recomendados' | 'rapidos' | 'minimo';

const SORTS: { key: Sort; label: string }[] = [
  { key: 'recomendados', label: 'Recomendados' },
  { key: 'rapidos', label: 'Más rápidos' },
  { key: 'minimo', label: 'Menor pedido mínimo' },
];

const FILTER_LINK =
  'inline-flex min-h-11 items-center border-l-2 px-3 text-left text-base transition-colors duration-100 hover:text-text-main';

export default function Businesses() {
  const { city } = useCity();
  const [params, setParams] = useSearchParams();
  const category = params.get('categoria') ?? '';
  const search = params.get('q') ?? '';
  const onlyOpen = params.get('abierto') === '1';
  const sort = (params.get('orden') as Sort) || 'recomendados';

  const [draft, setDraft] = useState(search);
  const [loaded, setLoaded] = useState<{ key: string; rows: BusinessListItem[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const requestKey = `${city}|${category}|${search}`;

  useEffect(() => {
    setPageMeta({
      title: `Comercios en ${city} | ZIPP`,
      description: `Restaurantes, droguerías, mercados y más en ${city}. Mira precios y tiempos de entrega.`,
      path: '/comercios',
    });
  }, [city]);

  useEffect(() => {
    let cancelled = false;
    listBusinesses({ city, category: category || undefined, search: search || undefined })
      .then((rows) => { if (!cancelled) setLoaded({ key: requestKey, rows }); })
      .catch(() => { if (!cancelled) setFailedKey(requestKey); });
    return () => { cancelled = true; };
  }, [city, category, search, requestKey]);

  const rows = loaded?.key === requestKey ? loaded.rows : null;
  const error = failedKey === requestKey;

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next);
  };

  const visible = (rows ?? [])
    .filter((b) => !onlyOpen || isOpenNow(b.schedule))
    .sort((a, b) => {
      if (sort === 'rapidos') return a.deliveryTime - b.deliveryTime;
      if (sort === 'minimo') return a.minOrder - b.minOrder;
      return 0;
    });

  const categoryClass = (active: boolean) =>
    `${FILTER_LINK} ${active ? 'border-primary text-text-main' : 'border-transparent text-text-secondary'}`;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">Comercios en {city}</h1>
      <CitySelect />

      <form
        role="search"
        className="mt-6 flex flex-col gap-3 sm:flex-row"
        onSubmit={(e) => { e.preventDefault(); update({ q: draft.trim() || null }); }}
      >
        <label className="sr-only" htmlFor="buscar">Buscar comercio por nombre</label>
        <input
          id="buscar"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Buscar comercio por nombre"
          className={`${INPUT} sm:max-w-md`}
        />
        <button
          type="submit"
          className="min-h-11 rounded-sm bg-primary px-6 text-base font-semibold text-text-main transition-colors duration-100 hover:bg-primary-light"
        >
          Buscar
        </button>
      </form>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[14rem_1fr]">
        <aside aria-label="Filtros">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-controls="filtros"
            className="min-h-11 text-base font-semibold text-text-main underline underline-offset-4 lg:hidden"
          >
            Filtros
          </button>
          <div id="filtros" className={`${filtersOpen ? 'mt-2 block' : 'hidden'} lg:block`}>
            <p className="text-base font-semibold text-text-main">Tipo de comercio</p>
            <div className="mt-2 flex flex-col">
              <button
                type="button"
                onClick={() => update({ categoria: null })}
                aria-pressed={!category}
                className={categoryClass(!category)}
              >
                Todos
              </button>
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => update({ categoria: c.key })}
                  aria-pressed={category === c.key}
                  className={categoryClass(category === c.key)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <label className="mt-6 flex min-h-11 items-center gap-3 text-base font-normal text-text-main">
              <input
                type="checkbox"
                checked={onlyOpen}
                onChange={(e) => update({ abierto: e.target.checked ? '1' : null })}
                className="h-5 w-5 accent-primary"
              />
              Abierto ahora
            </label>
          </div>
        </aside>

        <section aria-label="Resultados">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <p className="text-base text-text-secondary" aria-live="polite">
              {rows ? `${visible.length} ${visible.length === 1 ? 'comercio' : 'comercios'}` : 'Cargando comercios'}
            </p>
            <label className="flex items-center gap-2 text-base font-normal text-text-main">
              Ordenar por
              <select
                value={sort}
                onChange={(e) => update({ orden: e.target.value === 'recomendados' ? null : e.target.value })}
                className="min-h-11 rounded-sm border border-border-strong bg-bg px-2 text-base text-text-main"
              >
                {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
          </div>

          {error ? (
            <StateMessage kind="error" title="No pudimos cargar los comercios">
              Revisa tu conexión y recarga la página.
            </StateMessage>
          ) : rows === null ? (
            <StateMessage kind="loading" title="Cargando comercios" />
          ) : visible.length === 0 ? (
            <StateMessage kind="empty" title="No hay comercios con estos filtros">
              Quita algún filtro o busca con otro nombre.
            </StateMessage>
          ) : (
            <ul>{visible.map((b) => <BusinessRow key={b._id} business={b} />)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
