import { useEffect, useState } from 'react';
import { Star, AlertCircle, EyeOff, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { Permission } from '../lib/permissions';
import { PermissionGate } from '../components/PermissionGate';
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
 <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-main)]">
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
 <div className="space-y-3">
 <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
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
 <RefreshCw className="w-4 h-4 text-[var(--color-text-main)]" />
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
 <div className="table-container p-16 text-center text-[var(--color-text-main)] text-xs font-semibold">
 Cargando reseñas...
 </div>
 ) : visible.length === 0 ? (
 <div className="table-container p-16 text-center space-y-2">
 <Star className="w-8 h-8 text-[var(--color-text-main)] mx-auto" />
 <p className="text-sm font-bold text-[var(--color-text-main)]">
 {onlyHidden ? 'No hay reseñas ocultas' : 'Todavía no hay reseñas'}
 </p>
 </div>
 ) : (
 <div className="table-container">
 <div className="overflow-x-auto">
 <table className="data-grid">
 <thead>
 <tr className="text-left">
 <th className="table-header-cell">Negocio</th>
 <th className="table-header-cell">Cliente</th>
 <th className="table-header-cell">Fecha</th>
 <th className="table-header-cell">Calificación</th>
 <th className="table-header-cell">Comentario</th>
 <th className="table-header-cell">Respuesta del negocio</th>
 <th className="table-header-cell">Sobre el cliente (privado)</th>
 <th className="table-header-cell">Estado</th>
 <th className="table-header-cell">Acción</th>
 </tr>
 </thead>
 <tbody>
 {visible.map((review) => (
 <tr key={review._id} className={review.isHidden ? 'opacity-60' : ''}>
 <td className="table-body-cell text-[var(--color-text-main)]">{review.businessId?.name ?? 'Negocio'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{review.userId?.name ?? 'cliente'}</td>
 <td className="table-body-cell text-[var(--color-text-main)]">{new Date(review.createdAt).toLocaleDateString('es-CO')}</td>
 <td className="table-body-cell">
 <div className="flex flex-col gap-1">
 {typeof review.businessRating === 'number' && <Stars value={review.businessRating} label="Negocio" />}
 {typeof review.driverRating === 'number' && <Stars value={review.driverRating} label="Domiciliario" />}
 </div>
 </td>
 <td className="table-body-cell wrap text-[var(--color-text-main)]">{review.comment ?? '—'}</td>
 <td className="table-body-cell wrap text-[var(--color-text-main)]">{review.businessReply ?? '—'}</td>
 <td className="table-body-cell wrap">
 {/* Lo que el negocio o el domiciliario opinaron del cliente. No es público en ninguna parte: solo se ve aquí, para soporte. */}
 {review.clientRatingByBusiness || review.clientRatingByDriver || review.clientNotes ? (
 <div className="flex flex-col gap-1">
 {review.clientRatingByBusiness && <Stars value={review.clientRatingByBusiness} label="Negocio dice" />}
 {review.clientRatingByDriver && <Stars value={review.clientRatingByDriver} label="Domiciliario dice" />}
 {review.clientNotes && <span className="text-[var(--color-text-main)]">{review.clientNotes}</span>}
 </div>
 ) : (
 <span className="text-[var(--color-text-main)]">—</span>
 )}
 </td>
 <td className={`table-body-cell wrap ${review.isHidden ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-main)]'}`}>
 {review.isHidden ? `Oculta${review.hiddenReason ? ` · ${review.hiddenReason}` : ''}` : 'Visible'}
 </td>
 <td className="table-body-cell">
 <PermissionGate permission={Permission.REVIEWS_MODERATE}>
 <button
 onClick={() => moderate(review._id, !review.isHidden)}
 className={review.isHidden ? 'cursor-pointer text-[var(--color-text-main)]' : 'cursor-pointer text-[var(--color-danger)]'}
 >
 {working === review._id ? 'Guardando…' : review.isHidden ? 'Restaurar' : 'Ocultar'}
 </button>
 </PermissionGate>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 </div>
 );
}
