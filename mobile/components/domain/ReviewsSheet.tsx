import { View, StyleSheet } from 'react-native';
import { Text, Icon, Button, Sheet, Skeleton, EmptyState } from '../ui';
import { Avatar } from './Avatar';
import { useBusinessReviews } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { orderDate } from '../../lib/format';
import { Spacing, BorderRadius } from '../../theme/tokens';
import type { BusinessReview } from '../../services/endpoints';

/** Fila de cinco estrellas, solo para mostrar. */
function StarRow({ value, size = 14 }: { value: number; size?: number }) {
  const { c } = useTheme();
  return (
    <View style={styles.starRow}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Icon
          key={star}
          name="calificacion"
          size={size}
          color={star <= value ? c.warning : c.border}
          fill={star <= value ? c.warning : 'transparent'}
        />
      ))}
    </View>
  );
}

function ReviewRow({ review, businessName }: { review: BusinessReview; businessName: string }) {
  const { c } = useTheme();
  const author = typeof review.userId === 'object' ? review.userId?.name : undefined;
  const avatarUri = typeof review.userId === 'object' ? review.userId?.avatar : undefined;

  return (
    <View style={[styles.review, { borderBottomColor: c.border }]}>
      <Avatar uri={avatarUri} name={author} size={40} fontVariant="titleL" />
      <View style={styles.reviewBody}>
        <View style={styles.reviewHead}>
          <Text v="strongS" numberOfLines={1} style={styles.flex}>{author || 'Cliente Zipp'}</Text>
          <Text v="caption" tone="textMuted">{orderDate(review.createdAt)}</Text>
        </View>
        <StarRow value={review.businessRating ?? 0} />
        {review.comment ? (
          <Text v="bodyS" tone="textSecondary" style={styles.comment}>{review.comment}</Text>
        ) : null}

        {review.businessReply ? (
          <View style={[styles.reply, { backgroundColor: c.surfaceLight }]}>
            <Text v="captionStrong" tone="text">Respuesta de {businessName}</Text>
            <Text v="bodyS" tone="textSecondary">{review.businessReply}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function ReviewsSheet({
  visible, onClose, businessId, businessName, rating, totalReviews,
}: {
  visible: boolean;
  onClose: () => void;
  businessId: string;
  businessName: string;
  rating: number;
  totalReviews: number;
}) {
  const { c } = useTheme();
  const {
    data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage,
  } = useBusinessReviews(businessId, visible);

  const reviews = data?.pages.flatMap((page) => page.reviews) ?? [];

  return (
    <Sheet visible={visible} onClose={onClose} title="Reseñas" height={0.86}>
      <View style={styles.summary}>
        <Text v="displayL">{rating.toFixed(1)}</Text>
        <View style={styles.summaryMeta}>
          <StarRow value={Math.round(rating)} size={18} />
          <Text v="bodyS" tone="textMuted">
            {totalReviews} {totalReviews === 1 ? 'reseña' : 'reseñas'}
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.skeletons}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width={40} height={40} radius={20} />
              <View style={styles.flex}>
                <Skeleton width="50%" height={14} />
                <Skeleton width="90%" height={13} style={{ marginTop: 8 }} />
              </View>
            </View>
          ))}
        </View>
      ) : reviews.length === 0 ? (
        <EmptyState
          icon="calificacion"
          title="Todavía no hay reseñas"
          message="Sé el primero en contar qué tal estuvo tu pedido en este negocio."
          compact
        />
      ) : (
        <>
          {reviews.map((review) => (
            <ReviewRow key={review._id} review={review} businessName={businessName} />
          ))}
          {hasNextPage ? (
            <Button
              title={isFetchingNextPage ? 'Cargando…' : 'Ver más reseñas'}
              variant="secondary"
              onPress={() => fetchNextPage()}
              style={styles.more}
            />
          ) : null}
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    paddingBottom: Spacing.lg,
  },
  summaryMeta: { gap: Spacing.xs },
  starRow: { flexDirection: 'row', gap: 2 },

  skeletons: { gap: Spacing.lg },
  skeletonRow: { flexDirection: 'row', gap: Spacing.md },

  review: {
    flexDirection: 'row',
    gap: Spacing.md,
    paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  reviewBody: { flex: 1, gap: Spacing.xs },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  comment: { marginTop: 2 },
  reply: {
    marginTop: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    gap: 2,
  },
  more: { marginTop: Spacing.md },
});
