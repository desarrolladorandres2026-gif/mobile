import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, Badge } from '../ui';
import { ContentIcon } from '../illustrations';
import { LiveCountdown } from './LiveCountdown';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { money } from '../../lib/format';
import { isExpiringSoon, usageProgress } from '../../lib/offers';
import type { OfferCoupon } from '../../services/endpoints';

/**
 * Lo que un cupón le promete al cliente, en una frase.
 *
 * Vivía escrito dos veces —en el carrusel del inicio y en la pantalla de
 * puntos— con la misma regla pero no idéntica: es la clase de duplicación
 * que un día deja de decir lo mismo en los dos sitios. Un solo lugar es la
 * única forma de que "20% hasta $8.000" signifique eso en toda la app.
 */
export function couponBenefit(coupon: {
  type: string;
  value: number;
  maxDiscount?: number;
}): string {
  if (coupon.type === 'free_delivery') return 'Envío gratis';

  if (coupon.type === 'percentage') {
    return coupon.maxDiscount && coupon.maxDiscount > 0
      ? `${coupon.value}% hasta ${money(coupon.maxDiscount)}`
      : `${coupon.value}% de descuento`;
  }

  return `${money(coupon.value)} de descuento`;
}

/**
 * Cupón vigente, en formato ticket.
 *
 * El código se muestra grande porque hay que escribirlo a mano en el
 * checkout. Lo demás —cupo, vencimiento, condiciones— solo aparece cuando
 * el cupón en concreto lo tiene: un cupón sin límite de usos no lleva barra,
 * uno que vence en una semana no lleva reloj. Nada de eso se inventa para
 * rellenar la tarjeta.
 */
export const CouponCard = memo(function CouponCard({
  coupon, width = 232, onExpire,
}: { coupon: OfferCoupon; width?: number | `${number}%`; onExpire?: () => void }) {
  const { c } = useTheme();
  const progress = usageProgress(coupon);
  const expiring = isExpiringSoon(coupon);
  const hasTags = coupon.firstOrderOnly || !!coupon.minOrderAmount;

  return (
    <View style={[styles.coupon, { width, backgroundColor: c.card, borderColor: c.primary }]}>
      <View style={styles.top}>
        <ContentIcon name="cupon" size={28} />
        <Text v="strongM" tone="primaryText" numberOfLines={1} style={styles.flex}>
          {couponBenefit(coupon)}
        </Text>
      </View>

      <Text v="bodyS" tone="textSecondary" numberOfLines={2}>{coupon.title}</Text>

      {hasTags ? (
        <View style={styles.tagsRow}>
          {coupon.firstOrderOnly ? <Badge label="Tu primer pedido" tone="lime" /> : null}
          {coupon.minOrderAmount ? (
            <Badge label={`Desde ${money(coupon.minOrderAmount)}`} tone="neutral" icon="bolsa" />
          ) : null}
        </View>
      ) : null}

      {progress !== null ? (
        <View style={styles.progressBlock}>
          <View style={[styles.progressTrack, { backgroundColor: c.surfaceLight }]}>
            <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: c.primary }]} />
          </View>
          <Text v="caption" tone="textMuted">
            {progress >= 1 ? 'Se agotó por hoy' : `${Math.round(progress * 100)}% ya canjeado`}
          </Text>
        </View>
      ) : null}

      <View style={styles.bottomRow}>
        <View style={[styles.code, { borderColor: c.limeSoftBorder }]}>
          <Text v="code" tone="limeText">{coupon.code}</Text>
        </View>
        {expiring ? <LiveCountdown target={coupon.validUntil} onExpire={onExpire} /> : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  coupon: {
    gap: Spacing.sm,
    padding: Spacing.lg,
    borderRadius: BorderRadius.xl,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  progressBlock: { gap: 4 },
  progressTrack: {
    height: 5,
    borderRadius: BorderRadius.full,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: BorderRadius.full,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  code: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
});
