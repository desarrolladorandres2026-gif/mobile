import { View, StyleSheet } from 'react-native';
import { Text } from '../ui';
import { TicketCard } from './TicketCard';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';
import type { CouponStatus } from '../../lib/offers';
import type { OfferCoupon } from '../../services/endpoints';

/**
 * La cabecera de Descuentos: el título y el mejor cupón.
 *
 * Va sobre el mismo papel que el resto de la pestaña. Antes era una franja
 * de obsidiana; se quitó porque encerraba el título en una caja, y lo que
 * distingue la cabecera ya lo hace el tamaño del título y el cupón ancho.
 *
 * Sin cupón destacado se queda en el título. Ese hueco es más honesto que
 * rellenarlo con algo decorativo.
 */
export function OffersHero({
  coupon, status, topInset = 0, onPressCoupon, onExpire,
}: {
  coupon: OfferCoupon | null;
  status?: CouponStatus;
  /** El alto de la barra de estado: la pestaña no tiene cabecera propia. */
  topInset?: number;
  onPressCoupon?: () => void;
  onExpire?: () => void;
}) {
  const { c } = useTheme();

  return (
    <View style={[styles.header, { paddingTop: topInset + Spacing.lg }]}>
      <View style={styles.titleRow}>
        <Text v="displayM">Descuentos</Text>
        {coupon ? (
          <Text v="bodyS" tone="textMuted">El mejor de hoy</Text>
        ) : null}
      </View>

      {coupon ? (
        <TicketCard
          coupon={coupon}
          width="100%"
          notchColor={c.background}
          status={status}
          onPress={onPressCoupon}
          onExpire={onExpire}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: Spacing.xl, gap: Spacing.lg },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
});
