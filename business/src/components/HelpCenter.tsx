import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, LifeBuoy, MessageCircle, Search, X } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { SUPPORT_PHONE_DISPLAY, supportWhatsAppUrl } from '../lib/contact';
import { canSee, type MyAccess } from '../lib/permissions';
import { dateTime } from '../lib/orderFlow';
import {
  DISPLAY_STATUS, HELP_CATEGORIES, REASONS, TOPIC_ACTIONS, normalizeText,
  type HelpArticle, type HelpCategory, type Reason, type Ticket,
} from '../lib/support';
import {
  CashLogo, CouponLogo, DashboardLogo, DeliveryLogo, PackageLogo, PrepTimeLogo, RestaurantLogo, StoreLogo, WalletLogo,
} from './logos';

/**
 * Centro de ayuda. Los artículos los mantiene Soporte desde el panel de
 * administración; aquí solo se leen. Una categoría sin artículos dice que su
 * contenido está pendiente: una respuesta inventada cuesta más que no tenerla.
 *
 * Se navega como un centro de ayuda y no como una lista: inicio con búsqueda y
 * temas, página de tema con su lista de artículos y página de artículo.
 */

const CATEGORY_LOGO: Record<HelpCategory, ComponentType<{ size?: number }>> = {
  orders: PackageLogo,
  products: RestaurantLogo,
  drivers: DeliveryLogo,
  payments: WalletLogo,
  commissions: DashboardLogo,
  promotions: CouponLogo,
  cancellations: PrepTimeLogo,
  refunds: CashLogo,
  account: StoreLogo,
};

/** Cuántos artículos asoma el inicio; el orden lo pone Soporte con "Orden". */
const FEATURED = 6;

type View =
  | { name: 'home' }
  | { name: 'category'; key: HelpCategory }
  | { name: 'article'; id: string };

const labelOf = (key: HelpCategory) => HELP_CATEGORIES.find((c) => c.key === key)?.label ?? key;
const countLabel = (n: number) => (n === 0 ? 'Pendiente' : n === 1 ? '1 artículo' : `${n} artículos`);
const snippet = (text: string) => (text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text);

const linkClass = 'cursor-pointer font-semibold text-[var(--color-primary)] underline underline-offset-2';

export default function HelpCenter({ onAsk, tickets, access, onOpenTicket }: {
  /** Con motivo, abre el formulario ya encaminado; sin él, en blanco. */
  onAsk: (reason?: Reason) => void;
  tickets: Ticket[];
  access: MyAccess | undefined;
  onOpenTicket: (id: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [view, setView] = useState<View>({ name: 'home' });

  const query = useQuery({
    queryKey: ['help-articles'],
    staleTime: 5 * 60_000,
    queryFn: async () => (await api.get('/help-articles')).data.data as HelpArticle[],
  });
  const articles = useMemo(() => query.data ?? [], [query.data]);

  const searching = term.trim().length > 0;
  const results = useMemo(() => {
    const needle = normalizeText(term.trim());
    if (!needle) return [];
    return articles.filter((a) => normalizeText(`${a.question} ${a.answer}`).includes(needle));
  }, [articles, term]);

  const byCategory = (key: HelpCategory) => articles.filter((a) => a.category === key);
  const article = view.name === 'article' ? articles.find((a) => a._id === view.id) : undefined;
  // Estar dentro de un artículo cuenta como estar en su tema.
  const activeCategory = view.name === 'category' ? view.key : article?.category;

  const open = (next: View) => { setTerm(''); setView(next); };

  const search = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-secondary)]" />
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Busca una respuesta: liquidación, comisión, cancelar…"
        aria-label="Buscar en el Centro de ayuda"
        className="w-full rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pl-11 pr-10 text-sm text-[var(--color-text-main)]"
      />
      {searching && (
        <button
          onClick={() => setTerm('')}
          aria-label="Borrar búsqueda"
          className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-[var(--color-text-secondary)]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  const contact = (
    <p className="border-t border-[var(--color-border-light)] pt-4 text-xs text-[var(--color-text-secondary)]">
      ¿No encontraste lo que buscabas?{' '}
      <button onClick={() => onAsk()} className={linkClass}>Pedir ayuda</button>
      {' · '}
      <a
        href={supportWhatsAppUrl('Hola, soy un comercio de Zipp y necesito ayuda.')}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1 ${linkClass}`}
      >
        <MessageCircle className="h-3.5 w-3.5" /> WhatsApp {SUPPORT_PHONE_DISPLAY}
      </a>
    </p>
  );

  if (query.isError) {
    return (
      <p className="text-xs font-semibold text-[var(--color-danger)]">
        {apiMessage(query.error, 'No se pudo cargar el Centro de ayuda.')}
      </p>
    );
  }
  if (query.isPending) return <p className="text-xs text-[var(--color-text-secondary)]">Cargando…</p>;

  const onHome = view.name === 'home' && !searching;

  // Los temas, a la izquierda en cualquier página que no sea el inicio.
  const sidebar = (
    <nav aria-label="Temas de ayuda" className="md:sticky md:top-4 md:self-start">
      <button
        onClick={() => open({ name: 'home' })}
        className="mb-1 cursor-pointer text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]"
      >
        Centro de ayuda
      </button>
      <ul>
        {HELP_CATEGORIES.map((c) => {
          const Logo = CATEGORY_LOGO[c.key];
          const active = activeCategory === c.key && !searching;
          return (
            <li key={c.key}>
              <button
                onClick={() => open({ name: 'category', key: c.key })}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full cursor-pointer items-center gap-2 border-l-2 py-1.5 pl-2 text-left text-sm ${active ? 'border-[var(--color-primary)] font-semibold text-[var(--color-text-main)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'}`}
              >
                <Logo size={22} />
                <span className="truncate">{c.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  const articleRow = (a: HelpArticle, withCategory: boolean) => (
    <li key={a._id}>
      <button
        onClick={() => open({ name: 'article', id: a._id })}
        className="group flex w-full cursor-pointer items-start gap-3 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--color-text-main)] group-hover:text-[var(--color-primary)]">{a.question}</span>
          {withCategory && (
            <span className="block text-[11px] text-[var(--color-text-secondary)]">{labelOf(a.category)}</span>
          )}
          <span className="block truncate text-xs text-[var(--color-text-secondary)]">{snippet(a.answer)}</span>
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />
      </button>
    </li>
  );

  if (onHome) {
    const featured = [...articles].sort((a, b) => a.sortOrder - b.sortOrder).slice(0, FEATURED);
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="mx-auto max-w-xl space-y-3 text-center">
          <h2 className="text-xl font-semibold text-[var(--color-text-main)]">¿Cómo podemos ayudarte?</h2>
          <div className="text-left">{search}</div>
        </div>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Temas de ayuda</h3>
          <ul className="grid border-t border-[var(--color-border-light)] sm:grid-cols-2 lg:grid-cols-3">
            {HELP_CATEGORIES.map((c) => {
              const Logo = CATEGORY_LOGO[c.key];
              const count = byCategory(c.key).length;
              return (
                <li key={c.key} className="border-b border-[var(--color-border-light)]">
                  <button
                    onClick={() => open({ name: 'category', key: c.key })}
                    className="group flex w-full cursor-pointer items-center gap-3 px-1 py-2 text-left"
                  >
                    <Logo size={32} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-[var(--color-text-main)] group-hover:text-[var(--color-primary)]">{c.label}</span>
                      <span className="block text-[11px] text-[var(--color-text-secondary)]">{countLabel(count)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Preguntas frecuentes</h3>
          {featured.length === 0 ? (
            <p className="py-2 text-sm text-[var(--color-text-secondary)]">
              Aún no hay artículos publicados. Mientras tanto, cuéntanos tu caso y lo revisamos.
            </p>
          ) : (
            <ul className="grid border-t border-[var(--color-border-light)] lg:grid-cols-2 lg:gap-x-8 [&>li]:border-b [&>li]:border-[var(--color-border-light)]">
              {featured.map((a) => articleRow(a, true))}
            </ul>
          )}
        </section>

        {contact}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="max-w-xl">{search}</div>
      <div className="grid gap-x-10 gap-y-6 md:grid-cols-[14rem_minmax(0,1fr)]">
        {sidebar}
        <div className="min-w-0 space-y-6">
          {searching ? (
            <section>
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">
                {results.length === 0 ? 'Sin resultados' : `Resultados (${results.length})`}
              </h2>
              {results.length === 0 ? (
                <p className="py-2 text-sm text-[var(--color-text-secondary)]">
                  Ningún artículo coincide con «{term.trim()}». Prueba con otra palabra o{' '}
                  <button onClick={() => onAsk()} className={linkClass}>pide ayuda</button>.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-border-light)]">{results.map((a) => articleRow(a, true))}</ul>
              )}
            </section>
          ) : view.name === 'article' ? (
            article ? (
              <article className="max-w-2xl space-y-4">
                <p className="text-xs text-[var(--color-text-secondary)]">
                  <button onClick={() => open({ name: 'home' })} className="cursor-pointer hover:underline">Centro de ayuda</button>
                  {' › '}
                  <button onClick={() => open({ name: 'category', key: article.category })} className="cursor-pointer hover:underline">
                    {labelOf(article.category)}
                  </button>
                </p>
                <h2 className="text-lg font-semibold text-[var(--color-text-main)]">{article.question}</h2>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text-main)]">{article.answer}</p>
                {byCategory(article.category).length > 1 && (
                  <section>
                    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Más sobre {labelOf(article.category).toLowerCase()}</h3>
                    <ul className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
                      {byCategory(article.category).filter((a) => a._id !== article._id).slice(0, 5).map((a) => articleRow(a, false))}
                    </ul>
                  </section>
                )}
              </article>
            ) : (
              <p className="text-sm text-[var(--color-text-secondary)]">
                Ese artículo ya no está disponible.{' '}
                <button onClick={() => open({ name: 'home' })} className={linkClass}>Volver al inicio</button>
              </p>
            )
          ) : view.name === 'category' ? (
            <TopicPage
              category={view.key}
              articles={byCategory(view.key)}
              tickets={tickets}
              access={access}
              onAsk={onAsk}
              onOpenTicket={onOpenTicket}
              renderArticle={(a) => articleRow(a, false)}
            />
          ) : null}
          {contact}
        </div>
      </div>
    </div>
  );
}

const sectionTitle = 'mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]';
const rowClass = 'group flex w-full cursor-pointer items-center gap-3 py-3 text-left text-sm font-semibold text-[var(--color-text-main)] hover:text-[var(--color-primary)]';

/**
 * Un tema: lo que se puede hacer (ir a la sección del panel o reportar un
 * problema ya encaminado), los artículos y los casos propios sobre el tema.
 */
function TopicPage({ category, articles, tickets, access, onAsk, onOpenTicket, renderArticle }: {
  category: HelpCategory;
  articles: HelpArticle[];
  tickets: Ticket[];
  access: MyAccess | undefined;
  onAsk: (reason?: Reason) => void;
  onOpenTicket: (id: string) => void;
  renderArticle: (article: HelpArticle) => ReactNode;
}) {
  const actions = TOPIC_ACTIONS[category];
  const links = actions.links.filter((l) => canSee(l.to, access));
  const reports = REASONS.filter((r) => actions.reports.includes(r.key));
  const related = tickets.filter((t) => t.reason && actions.reports.includes(t.reason));

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[var(--color-text-main)]">{labelOf(category)}</h2>

      {(links.length > 0 || reports.length > 0) && (
        <section>
          <h3 className={sectionTitle}>Qué puedes hacer</h3>
          <ul className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
            {links.map((l) => (
              <li key={l.to}>
                <Link to={l.to} className={rowClass}>
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />
                  <span className="flex-1">Ir a {l.label}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />
                </Link>
              </li>
            ))}
            {reports.map((r) => (
              <li key={r.key}>
                <button onClick={() => onAsk(r.key)} className={rowClass}>
                  <LifeBuoy className="h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />
                  <span className="flex-1">Reportar: {r.label}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-secondary)]" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className={sectionTitle}>Artículos</h3>
        {articles.length === 0 ? (
          <p className="py-2 text-sm text-[var(--color-text-secondary)]">
            Los artículos de este tema están pendientes de configuración.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
            {articles.map((a) => renderArticle(a))}
          </ul>
        )}
      </section>

      {related.length > 0 && (
        <section>
          <h3 className={sectionTitle}>Tus solicitudes sobre este tema</h3>
          <ul className="divide-y divide-[var(--color-border-light)] border-t border-[var(--color-border-light)]">
            {related.map((t) => {
              const status = DISPLAY_STATUS[t.displayStatus];
              return (
                <li key={t._id}>
                  <button onClick={() => onOpenTicket(t._id)} className="flex w-full cursor-pointer flex-col py-3 text-left">
                    <span className="truncate text-sm font-semibold text-[var(--color-text-main)]">{t.subject}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} aria-hidden />
                      {t.code} · {status.label} · {dateTime(t.updatedAt || t.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
