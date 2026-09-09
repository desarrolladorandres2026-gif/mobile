import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '../ui/Text';
import { ContentIcon } from '../illustrations';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { money } from '../../lib/format';

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
 * Cupón vigente, en formato ticket. El código se muestra grande porque hay
 * que escribirlo a mano en el checkout.
 */
export const CouponCard = memo(function CouponCard({
  coupon, width = 232,
}: { coupon: any; width?: number | `${number}%` }) {
  const { c } = useTheme();

  return (
    <View style={[styles.coupon, { width, backgroundColor: c.limeSoft, borderColor: c.limeSoftBorder }]}>
      <View style={styles.top}>
        <ContentIcon name="cupon" size={28} />
        <Text v="strongM" numberOfLines={1} style={styles.flex}>{couponBenefit(coupon)}</Text>
      </View>
      <Text v="bodyS" tone="textSecondary" numberOfLines={2}>{coupon.title}</Text>
      <View style={[styles.code, { borderColor: c.limeSoftBorder }]}>
        <Text v="code" tone="limeText">{coupon.code}</Text>
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
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  code: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    marginTop: Spacing.xs,
  },
});
