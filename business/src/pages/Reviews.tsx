import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Star, AlertCircle, MessageSquare, Send, RefreshCw } from 'lucide-react';
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
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

      {unanswered > 0 && (
        <div className="bg-[var(--color-warning-bg)] text-[var(--color-warning)] text-xs p-4 rounded-xl flex items-start gap-3 font-semibold">
          <MessageSquare className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1">
            {unanswered} {unanswered === 1 ? 'reseña sin responder' : 'reseñas sin responder'}.
            Contestar, sobre todo a las malas, es lo que ven los siguientes clientes.
          </p>
        </div>
      )}

      {(error || loadError) && (
        <div className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger)] text-xs p-4 rounded-xl flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error || loadError}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando reseñas...
        </div>
      ) : rated.length === 0 ? (
        <div className="table-container p-16 text-center space-y-2">
          <Star className="w-8 h-8 text-[var(--color-text-muted)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">Todavía no hay reseñas</p>
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">
            Aparecerán aquí cuando tus clientes califiquen sus pedidos.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {rated.map((review) => (
            <div key={review._id} className="zipp-card p-5 space-y-4">
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
                <div className="p-3 rounded-lg bg-[var(--color-bg)] border-l-2 border-[var(--color-primary)] space-y-1">
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
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={drafts[review._id] ?? ''}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [review._id]: e.target.value }))
                    }
                    onKeyDown={(e) => { if (e.key === 'Enter') sendReply(review._id); }}
                    maxLength={500}
                    placeholder="Responde a este cliente…"
                    className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-main)] outline-none focus:border-[var(--color-primary)]"
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
