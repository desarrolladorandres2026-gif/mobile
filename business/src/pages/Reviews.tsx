import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Star, AlertCircle, Send, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { dateTime } from '../lib/orderFlow';

/**
 * Reseñas del comercio, con derecho a réplica.
 *
 * Hasta ahora el negocio veía su nota pero no podía hacer nada con ella:
 * una mala reseña era una sentencia. Poder contestar cambia lo que
 * significa — deja de ser un veredicto y pasa a ser una conversación que
 * los siguientes clientes leen. Es la diferencia entre un comercio que
 * parece ignorar los problemas y uno que los resuelve.
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

function Stars({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`w-3.5 h-3.5 ${
            star <= value
              ? 'text-[var(--color-warning)] fill-[var(--color-warning)]'
              : 'text-[var(--color-border)]'
          }`}
        />
      ))}
    </div>
  );
}

export default function Reviews() {
  const selectedBusiness = useAuthStore((s) => s.selectedBusiness);
  const businessId = selectedBusiness?._id;

  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);

  const reviewsQuery = useQuery({
    queryKey: qk.reviews(businessId),
    enabled: !!businessId,
    queryFn: async () => {
      const { data } = await api.get(`/reviews/business/${businessId}`);
      return (data.data.reviews ?? data.data) as Review[];
    },
  });
  const reviews = useMemo(() => reviewsQuery.data ?? [], [reviewsQuery.data]);
  const loading = !!businessId && reviewsQuery.isPending;
  const loadError = reviewsQuery.isError ? apiMessage(reviewsQuery.error, 'No se pudieron cargar las reseñas.') : '';

  const fetchReviews = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.reviews(businessId) }),
    [queryClient, businessId]
  );

  const sendReply = async (reviewId: string) => {
    const reply = (drafts[reviewId] ?? '').trim();
    if (!reply) return;

    try {
      setError('');
      setSending(reviewId);
      await api.post(`/reviews/${reviewId}/reply`, { reply });
      setDrafts((prev) => ({ ...prev, [reviewId]: '' }));
      await fetchReviews();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo publicar la respuesta.'));
    } finally {
      setSending(null);
    }
  };

  const rated = reviews.filter((r) => typeof r.businessRating === 'number');
  const average = rated.length
    ? rated.reduce((sum, r) => sum + (r.businessRating ?? 0), 0) / rated.length
    : 0;
  const unanswered = rated.filter((r) => !r.businessReply).length;

  // Función, no componente: un componente declarado dentro del render se
  // remonta en cada tecla y el campo de respuesta perdería el foco.
  const renderReview = (review: (typeof rated)[number]) => (
            <li key={review._id} className="py-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-bold text-[var(--color-text-main)]">
              {review.userId?.name ?? 'Cliente'}
            </h3>
            <Stars value={review.businessRating ?? 0} />
          </div>
          <p className="text-xs text-[var(--color-text-muted)] font-medium">
            {dateTime(review.createdAt)}
          </p>
        </div>
      </div>

      {review.comment ? (
        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
          {review.comment}
        </p>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)] italic">
          Calificó sin dejar comentario.
        </p>
      )}

      {review.businessReply ? (
        <div className="pl-3 border-l-2 border-[var(--color-primary)] space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary)]">
            Tu respuesta
          </p>
          <p className="text-sm text-[var(--color-text-secondary)]">{review.businessReply}</p>
          {review.businessRepliedAt && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {dateTime(review.businessRepliedAt)}
            </p>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            value={drafts[review._id] ?? ''}
            onChange={(e) =>
              setDrafts((prev) => ({ ...prev, [review._id]: e.target.value }))
            }
            onKeyDown={(e) => { if (e.key === 'Enter') sendReply(review._id); }}
            maxLength={500}
            placeholder="Responde a este cliente…"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
          />
          <button
            onClick={() => sendReply(review._id)}
            className="px-3.5 py-2 rounded-lg bg-[var(--color-primary)] text-white font-bold text-xs uppercase tracking-wider hover:bg-[#8A5D08] transition-all cursor-pointer flex items-center justify-center gap-1.5"
          >
            <Send className="w-4 h-4" />
            {sending === review._id ? 'Enviando…' : 'Responder'}
          </button>
        </div>
      )}

      {/* Solo se puede responder una vez: se avisa antes, no después. */}
      {!review.businessReply && (
        <p className="text-xs text-[var(--color-text-muted)]">
          La respuesta es pública y no se puede editar después.
        </p>
      )}
    </li>
  );

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reseñas</h1>
          <p className="page-subtitle">
            Lo que dicen tus clientes, y tu oportunidad de contestarles
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[var(--color-text-main)] shadow-xs">
            <Star className="w-3.5 h-3.5 text-[var(--color-warning)] fill-[var(--color-warning)]" />
            <span>{average ? average.toFixed(1) : 'Sin calificar'}</span>
            <span className="text-[var(--color-text-muted)] font-semibold">
              ({rated.length})
            </span>
          </div>

          <button
            onClick={fetchReviews}
            className="p-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
            title="Actualizar"
          >
            <RefreshCw className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>
      </div>

      {(error || loadError) && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      {loading ? (
        <p className="py-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando reseñas...
        </p>
      ) : rated.length === 0 ? (
        <div className="py-16 text-center space-y-2">
          <Star className="w-8 h-8 text-[var(--color-text-muted)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">Todavía no hay reseñas</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Aparecerán aquí cuando tus clientes califiquen sus pedidos.
          </p>
        </div>
      ) : (
        <div className="cols3">
          <section>
            <h2 className="col-title">Calificación</h2>
            <p className="text-4xl font-semibold tracking-[-0.03em] tabular text-[var(--color-text-main)]">
              {average ? average.toFixed(1) : '—'}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{rated.length} reseña(s)</p>
            <ul className="mt-4 space-y-1.5">
              {[5, 4, 3, 2, 1].map((n) => {
                const count = rated.filter((r) => Math.round(r.businessRating ?? 0) === n).length;
                return (
                  <li key={n} className="flex items-center gap-3 text-xs">
                    <span className="w-6 tabular text-[var(--color-text-secondary)]">{n}★</span>
                    <span className="flex-1 h-1.5 bg-[var(--color-border)]">
                      <span className="block h-full bg-[var(--color-warning)]" style={{ width: `${(count / rated.length) * 100}%` }} />
                    </span>
                    <span className="w-6 text-right tabular font-semibold text-[var(--color-text-main)]">{count}</span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-5 text-xs text-[var(--color-text-secondary)]">
              Contestar, sobre todo a las malas, es lo que ven los siguientes clientes.
            </p>
          </section>

          <section>
            <h2 className="col-title">Sin responder · {unanswered}</h2>
            {unanswered === 0 ? (
              <p className="py-2 text-xs text-[var(--color-text-muted)]">Todas tienen respuesta.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {rated.filter((r) => !r.businessReply).map((review) => (
                  renderReview(review)
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="col-title">Respondidas · {rated.length - unanswered}</h2>
            {rated.length === unanswered ? (
              <p className="py-2 text-xs text-[var(--color-text-muted)]">Aún no has respondido ninguna.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {rated.filter((r) => r.businessReply).map((review) => (
                  renderReview(review)
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
