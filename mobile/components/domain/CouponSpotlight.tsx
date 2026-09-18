import { View, StyleSheet } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text, Icon } from '../ui';
import { ContentIcon } from '../illustrations';
import { LiveCountdown } from './LiveCountdown';
import { couponBenefit } from './CouponCard';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { money } from '../../lib/format';
import { isExpiringSoon, usageProgress } from '../../lib/offers';
import type { OfferCoupon } from '../../services/endpoints';

/**
 * La oferta más fuerte del momento, arriba de todo el feed.
 *
 * `pickSpotlightCoupon` (en `lib/offers.ts`) ya decidió cuál es: el que
 * vence antes si algo está por vencer, o si no el de mayor descuento. Esta
 * tarjeta solo la presenta con el peso visual que ese lugar en la pantalla
 * merece — es la única con halo dorado de toda la sección.
 */
export function CouponSpotlight({ coupon, onExpire }: { coupon: OfferCoupon; onExpire?: () => void }) {
  const { c } = useTheme();
  const expiring = isExpiringSoon(coupon);
  const progress = usageProgress(coupon);
  const remaining = coupon.usageLimit
    ? Math.max(0, coupon.usageLimit - (coupon.usedCount ?? 0))
    : null;

  return (
    <Animated.View entering={FadeIn.duration(260)} style={styles.section}>
      <View style={[styles.card, Shadow.goldGlow, { backgroundColor: c.card, borderColor: c.primary }]}>
        <View style={styles.badgeRow}>
          <ContentIcon name="corona" size={22} />
          <Text v="captionStrong" tone="primaryText" style={styles.eyebrow}>
            {expiring ? 'SE ACABA PRONTO' : 'OFERTA DESTACADA'}
          </Text>
        </View>

        <Text v="displayS" numberOfLines={2}>{couponBenefit(coupon)}</Text>
        <Text v="bodyM" tone="textSecondary" numberOfLines={2}>{coupon.title}</Text>

        <View style={styles.bottomRow}>
          <View style={[styles.code, { borderColor: c.primary, backgroundColor: c.primarySoft }]}>
            <Text v="code" tone="primaryText">{coupon.code}</Text>
          </View>

          {expiring ? (
            <LiveCountdown target={coupon.validUntil} variant="large" onExpire={onExpire} />
          ) : remaining !== null ? (
            <View style={styles.remaining}>
              <Icon name="rayo" size="sm" color={c.warningText} />
              <Text v="strongS" tone="warningText">
                {remaining <= 0 ? 'Se agotó' : `Quedan ${remaining}`}
              </Text>
            </View>
          ) : null}
        </View>

        {progress !== null ? (
          <View style={[styles.progressTrack, { backgroundColor: c.surfaceLight }]}>
            <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: c.primary }]} />
          </View>
        ) : null}

        {coupon.minOrderAmount ? (
          <Text v="caption" tone="textMuted">Pide desde {money(coupon.minOrderAmount)}</Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  card: {
    borderRadius: BorderRadius.xxl,
    borderWidth: 1.5,
    padding: Spacing.xl,
    gap: Spacing.xs,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginBottom: 2 },
  eyebrow: { letterSpacing: 1 },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginTop: Spacing.md,
  },
  code: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  remaining: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  progressTrack: {
    height: 6,
    borderRadius: BorderRadius.full,
    overflow: 'hidden',
    marginTop: Spacing.md,
  },
  progressFill: { height: '100%', borderRadius: BorderRadius.full },
});
