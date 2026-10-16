import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Star, AlertCircle, ArrowUp, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { dateTime } from '../lib/orderFlow';
import Pagination from '../components/Pagination';

/**
 * Reseñas del comercio, con derecho a réplica.
 *
 * Hasta ahora el negocio veía su nota pero no podía hacer nada con ella:
 * una mala reseña era una sentencia. Poder contestar cambia lo que
 * significa — deja de ser un veredicto y pasa a ser una conversación que
 * los siguientes clientes leen. Es la diferencia entre un comercio que
 * parece ignorar los problemas y uno que los resuelve.
 *
 * La pantalla imita la de comentarios de TikTok porque es el gesto que ya
 * conoce quien contesta desde el celular: una sola columna, foto redonda a
 * la izquierda, «Responder» bajo el texto, la respuesta anidada y con su
 * etiqueta de autor. Nada de columnas ni tarjetas: es una conversación, no
 * un tablero.
 */

interface Review {
  _id: string;
  businessRating?: number;
  driverRating?: number;
  comment?: string;
  businessReply?: string;
  businessRepliedAt?: string;
  createdAt: string;
  userId?: { _id: string; name?: string; avatar?: string };
}

type Filter = 'all' | 'pending' | 1 | 2 | 3 | 4 | 5;

const PAGE_SIZE = 20;

interface ReviewsMeta {
  total: number;
  totalPages: number;
  limit: number;
  stats?: { rated: number; average: number; unanswered: number; byRating: Record<string, number> };
}

const initialOf = (name?: string) => (name?.trim()[0] ?? '?').toUpperCase();

/** «hace 3 h», «hace 2 d»; pasado un mes, la fecha. */
function ago(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return dateTime(value);
}

function Avatar({ name, src, size, brand }: { name?: string; src?: string; size: number; brand?: boolean }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        style={box}
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      style={{ ...box, fontSize: size * 0.42 }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${
        brand
          ? 'bg-[var(--color-primary)] text-[var(--zipp-obsidian)]'
          : 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]'
      }`}
    >
      {initialOf(name)}
    </span>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" role="img" aria-label={`${value} de 5 estrellas`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`h-3 w-3 ${
            star <= value
              ? 'fill-[var(--color-warning)] text-[var(--color-warning)]'
              : 'text-[var(--color-border-strong)]'
          }`}
        />
      ))}
    </span>
  );
}

/**
 * Un comentario con su respuesta. Tiene estado propio (si el campo está
 * abierto y lo escrito) porque un componente declarado dentro de la página
 * se remonta en cada tecla y el campo perdería el foco.
 */
function Comment({
  review,
  businessName,
  onReply,
}: {
  review: Review;
  businessName: string;
  onReply: (reviewId: string, reply: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // La respuesta es pública y no se edita: Enter o la flecha piden confirmar,
  // no publican. Una tecla de más no puede dejar escrito un borrador a medias.
  const [confirming, setConfirming] = useState(false);

  const close = () => {
    setOpen(false);
    setDraft('');
    setConfirming(false);
  };

  const send = async () => {
    const reply = draft.trim();
    if (!reply || sending) return;
    setSending(true);
    try {
      await onReply(review._id, reply);
      close();
    } catch {
      // `onReply` ya muestra el error arriba; el borrador se conserva.
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  const name = review.userId?.name ?? 'Cliente';

  return (
    <li className="flex gap-3">
      <Avatar name={name} src={review.userId?.avatar} size={40} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">{name}</h3>
          <Stars value={review.businessRating ?? 0} />
        </div>

        {review.comment ? (
          <p className="text-sm leading-relaxed text-[var(--color-text-main)]">{review.comment}</p>
        ) : (
          <p className="text-sm italic text-[var(--color-text-secondary)]">Calificó sin dejar comentario.</p>
        )}

        <div className="flex items-center gap-4 text-xs text-[var(--color-text-secondary)]">
          <span>{ago(review.createdAt)}</span>
          {!review.businessReply && !open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="cursor-pointer font-semibold hover:text-[var(--color-text-main)]"
            >
              Responder
            </button>
          ) : null}
        </div>

        {review.businessReply ? (
          <div className="flex gap-2.5 pt-3">
            <Avatar name={businessName} size={28} brand />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-semibold text-[var(--color-text-secondary)]">{businessName}</p>
                <span className="bg-[var(--color-primary)] px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-[var(--zipp-obsidian)]">
                  Comercio
                </span>
              </div>
              <p className="text-sm leading-relaxed text-[var(--color-text-main)]">{review.businessReply}</p>
              {review.businessRepliedAt ? (
                <p className="text-xs text-[var(--color-text-secondary)]">{ago(review.businessRepliedAt)}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {open ? (
          <div className="space-y-1.5 pt-3">
            <div className="flex items-center gap-2.5">
              <Avatar name={businessName} size={28} brand />
              <div className="flex min-w-0 flex-1 items-center rounded-full bg-[var(--color-surface-hover)] pl-4 pr-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setConfirming(false); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && draft.trim()) setConfirming(true);
                    if (e.key === 'Escape') close();
                  }}
                  maxLength={500}
                  placeholder={`Responde a ${name}…`}
                  aria-label={`Responder a ${name}`}
                  className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-main)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!draft.trim() || sending}
                  aria-label="Revisar y publicar respuesta"
                  className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--zipp-obsidian)] disabled:cursor-default disabled:opacity-30"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* Solo se puede responder una vez: se avisa antes, no después. */}
            {confirming ? (
              <p className="pl-[38px] text-xs text-[var(--color-text-main)]">
                ¿Publicar? Es pública y no se puede editar después.{' '}
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending}
                  className="cursor-pointer font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-60"
                >
                  {sending ? 'Publicando…' : 'Publicar'}
                </button>{' '}
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="cursor-pointer font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]"
                >
                  Seguir editando
                </button>
              </p>
            ) : (
              <p className="pl-[38px] text-xs text-[var(--color-text-secondary)]">
                Es pública y no se puede editar después.{' '}
                <button
                  type="button"
                  onClick={close}
                  className="cursor-pointer font-semibold hover:text-[var(--color-text-main)]"
                >
                  Cancelar
                </button>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export default function Reviews() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;
  const businessName = selectedBusiness?.name ?? 'Tu negocio';

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);

  const reviewsQuery = useQuery({
    queryKey: qk.reviews(businessId, page, filter),
    enabled: !!businessId,
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const { data } = await api.get(`/reviews/business/${businessId}`, {
        params: {
          page,
          limit: PAGE_SIZE,
          ...(typeof filter === 'number' ? { rating: filter } : {}),
          ...(filter === 'pending' ? { unanswered: true } : {}),
        },
      });
      return {
        reviews: (data.data.reviews ?? data.data) as Review[],
        meta: (data.meta ?? { total: 0, totalPages: 1, limit: PAGE_SIZE }) as ReviewsMeta,
      };
    },
  });
  const reviews = useMemo(() => reviewsQuery.data?.reviews ?? [], [reviewsQuery.data]);
  const meta = reviewsQuery.data?.meta ?? { total: 0, totalPages: 1, limit: PAGE_SIZE };
  const stats = meta.stats ?? { rated: 0, average: 0, unanswered: 0, byRating: {} as Record<string, number> };
  const loading = !!businessId && reviewsQuery.isPending;
  const loadError = reviewsQuery.isError ? apiMessage(reviewsQuery.error, 'No se pudieron cargar las reseñas.') : '';

  const fetchReviews = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.reviews(businessId) }),
    [queryClient, businessId]
  );

  const sendReply = async (reviewId: string, reply: string) => {
    try {
      setError('');
      await api.post(`/reviews/${reviewId}/reply`, { reply });
      await fetchReviews();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo publicar la respuesta.'));
      throw err;
    }
  };

  // El promedio y los conteos son de todas las reseñas del local (los calcula
  // el servidor), no de la página que se está viendo.
  const rated = useMemo(() => reviews.filter((r) => typeof r.businessRating === 'number'), [reviews]);
  const average = stats.average;
  const unanswered = stats.unanswered;

  const countOf = (n: number) => stats.byRating[String(n)] ?? 0;
  const visible = useMemo(() => {
    // Lo que espera respuesta primero dentro de la página; luego, lo más reciente.
    return [...rated].sort(
      (a, b) =>
        Number(!!a.businessReply) - Number(!!b.businessReply) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [rated]);

  const tabs: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: `Todas ${stats.rated}` },
    { key: 'pending', label: `Sin responder ${unanswered}` },
    ...([5, 4, 3, 2, 1] as const).map((n) => ({ key: n as Filter, label: `${n}★ ${countOf(n)}` })),
  ];

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reseñas</h1>
          <p className="page-subtitle">
            Lo que dicen tus clientes, y tu oportunidad de contestarles
          </p>
        </div>

        <button
          onClick={fetchReviews}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)]"
          title="Actualizar"
        >
          <RefreshCw className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
          Actualizar
        </button>
      </div>

      {(error || loadError) && (
        <div className="flex items-start gap-3 text-xs text-[var(--color-danger)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      {loading ? (
        <p className="py-16 text-center text-xs font-semibold text-[var(--color-text-secondary)]">
          Cargando reseñas...
        </p>
      ) : stats.rated === 0 ? (
        <div className="space-y-2 py-16 text-center">
          <Star className="mx-auto h-8 w-8 text-[var(--color-text-secondary)]" />
          <p className="text-sm font-semibold text-[var(--color-text-main)]">Todavía no hay reseñas</p>
          <p className="text-xs font-medium text-[var(--color-text-secondary)]">
            Aparecerán aquí cuando tus clientes califiquen sus pedidos.
          </p>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <div className="flex items-baseline gap-3">
            <p className="text-3xl font-semibold tabular text-[var(--color-text-main)]">
              {average.toFixed(1).replace('.', ',')}
            </p>
            <Stars value={Math.round(average)} />
            <p className="text-xs text-[var(--color-text-secondary)]">
              {stats.rated} {stats.rated === 1 ? 'reseña' : 'reseñas'}
            </p>
          </div>

          <div role="tablist" aria-label="Filtrar reseñas" className="-mx-1 flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-1">
            {tabs.map((t) => (
              <button
                key={String(t.key)}
                type="button"
                role="tab"
                aria-selected={filter === t.key}
                onClick={() => { setFilter(t.key); setPage(1); }}
                className={`-mb-px shrink-0 cursor-pointer border-b-2 px-3 pb-2.5 text-xs font-semibold tabular transition-colors ${
                  filter === t.key
                    ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                    : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="py-10 text-center text-xs text-[var(--color-text-secondary)]">
              {filter === 'pending' ? 'Todas tienen respuesta.' : 'No hay reseñas con este filtro.'}
            </p>
          ) : (
            <ul className="space-y-6">
              {visible.map((review) => (
                <Comment key={review._id} review={review} businessName={businessName} onReply={sendReply} />
              ))}
            </ul>
          )}

          <Pagination
            page={page}
            totalPages={meta.totalPages}
            total={meta.total}
            limit={meta.limit}
            onPageChange={setPage}
          />

          <p className="pt-2 text-xs text-[var(--color-text-secondary)]">
            Contestar, sobre todo a las malas, es lo que ven los siguientes clientes.
          </p>
        </div>
      )}
    </div>
  );
}
