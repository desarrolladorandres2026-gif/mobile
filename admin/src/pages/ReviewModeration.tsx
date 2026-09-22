import { useEffect, useState } from 'react';
import { Star, AlertCircle, EyeOff, Eye, MessageSquare, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';

/**
 * Moderación de reseñas.
 *
 * Una reseña inventada o insultante se quedaba contando en la media del
 * negocio para siempre, porque no había forma de retirarla. Ocultarla no la
 * borra —el rastro sigue ahí para poder revisar la decisión— pero deja de
 * mostrarse y deja de pesar en la nota, que es lo que de verdad afecta al
 * comercio.
 */

interface Review {
  _id: string;
  businessRating?: number;
  driverRating?: number;
  clientRatingByBusiness?: number;
  clientRatingByDriver?: number;
  comment?: string;
  businessReply?: string;
  clientNotes?: string;
  isHidden?: boolean;
  hiddenReason?: string;
  createdAt: string;
  userId?: { _id: string; name?: string };
  businessId?: { _id: string; name?: string };
}

function Stars({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
      <span className="font-semibold">{label}</span>
      <span className="inline-flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`w-3 h-3 ${
              star <= value
                ? 'text-[var(--color-warning)] fill-[var(--color-warning)]'
                : 'text-[var(--color-border)]'
            }`}
          />
        ))}
      </span>
    </span>
  );
}

export default function ReviewModeration() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [onlyHidden, setOnlyHidden] = useState(false);

  const fetchReviews = async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await api.get('/reviews/moderation');
      setReviews(data.data);
    } catch (err) {
      setError(apiMessage(err, 'No se pudieron cargar las reseñas.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchReviews(); }, []);

  const moderate = async (reviewId: string, hidden: boolean) => {
    // El motivo se pide solo al ocultar: restaurar no necesita justificarse,
    // pero retirar contenido de otro sí.
    const reason = hidden
      ? window.prompt('¿Por qué se oculta esta reseña?') ?? undefined
      : undefined;

    if (hidden && !reason) return;

    try {
      setError('');
      setWorking(reviewId);
      await api.patch(`/reviews/${reviewId}/moderate`, { hidden, reason });
      await fetchReviews();
    } catch (err) {
      setError(apiMessage(err, 'No se pudo moderar la reseña.'));
    } finally {
      setWorking(null);
    }
  };

  const visible = onlyHidden ? reviews.filter((r) => r.isHidden) : reviews;
  const hiddenCount = reviews.filter((r) => r.isHidden).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Moderación de Reseñas</h1>
          <p className="page-subtitle">
            Ocultar una reseña la retira de la media del negocio. No la borra: la decisión queda registrada
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setOnlyHidden((v) => !v)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
              onlyHidden
                ? 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)] text-[var(--color-danger)]'
                : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-main)]'
            }`}
          >
            <EyeOff className="w-3.5 h-3.5" />
            <span>{hiddenCount} ocultas</span>
          </button>

          <button
            onClick={fetchReviews}
            className="p-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] hover:bg-[var(--color-bg-alt)] transition-all cursor-pointer"
            title="Actualizar"
          >
            <RefreshCw className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[var(--color-danger)] text-xs flex items-start gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="flex-1 font-semibold">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="table-container p-16 text-center text-[var(--color-text-secondary)] text-xs font-semibold">
          Cargando reseñas...
        </div>
      ) : visible.length === 0 ? (
        <div className="table-container p-16 text-center space-y-2">
          <Star className="w-8 h-8 text-[var(--color-text-muted)] mx-auto" />
          <p className="text-sm font-bold text-[var(--color-text-main)]">
            {onlyHidden ? 'No hay reseñas ocultas' : 'Todavía no hay reseñas'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {visible.map((review) => (
            <div
              key={review._id}
              className={`zipp-card p-5 space-y-3 ${review.isHidden ? 'opacity-60' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="text-sm font-bold text-[var(--color-text-main)]">
                      {review.businessId?.name ?? 'Negocio'}
                    </h3>
                    {review.isHidden && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-danger)]">
                        Oculta
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    {typeof review.businessRating === 'number' && (
                      <Stars value={review.businessRating} label="Negocio" />
                    )}
                    {typeof review.driverRating === 'number' && (
                      <Stars value={review.driverRating} label="Domiciliario" />
                    )}
                  </div>

                  <p className="text-xs text-[var(--color-text-muted)] font-medium">
                    Por {review.userId?.name ?? 'cliente'} · {new Date(review.createdAt).toLocaleDateString('es-CO')}
                  </p>
                </div>

                <button
                  onClick={() => moderate(review._id, !review.isHidden)}
                  className={`px-3.5 py-2 rounded-lg font-bold text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                    review.isHidden
                      ? 'bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)]'
                      : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
                  }`}
                >
                  {review.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {working === review._id
                    ? 'Guardando…'
                    : review.isHidden
                      ? 'Restaurar'
                      : 'Ocultar'}
                </button>
              </div>

              {review.comment && (
                <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  {review.comment}
                </p>
              )}

              {review.businessReply && (
                <div className="p-3 rounded-lg bg-[var(--color-bg)] border-l-2 border-[var(--color-primary)]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-primary)] mb-1">
                    Respuesta del negocio
                  </p>
                  <p className="text-sm text-[var(--color-text-secondary)]">{review.businessReply}</p>
                </div>
              )}

              {/* Lo que el negocio o el domiciliario opinaron del cliente. No
                  es público en ninguna parte: solo se ve aquí, para soporte. */}
              {(review.clientRatingByBusiness || review.clientRatingByDriver || review.clientNotes) && (
                <div className="p-3 rounded-lg bg-[var(--color-bg-alt)] space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3" />
                    Sobre el cliente (privado)
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    {review.clientRatingByBusiness && (
                      <Stars value={review.clientRatingByBusiness} label="Negocio dice" />
                    )}
                    {review.clientRatingByDriver && (
                      <Stars value={review.clientRatingByDriver} label="Domiciliario dice" />
                    )}
                  </div>
                  {review.clientNotes && (
                    <p className="text-xs text-[var(--color-text-secondary)]">{review.clientNotes}</p>
                  )}
                </div>
              )}

              {review.isHidden && review.hiddenReason && (
                <p className="text-xs text-[var(--color-danger)] font-semibold">
                  Motivo: {review.hiddenReason}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
