import { View, StyleSheet } from 'react-native';
import { Text } from '../ui';
import { TicketCard } from './TicketCard';
import { BorderRadius, Spacing, palette } from '../../theme/tokens';
import type { CouponStatus } from '../../lib/offers';
import type { OfferCoupon } from '../../services/endpoints';

/**
 * La cabecera de Descuentos: una franja de obsidiana con el mejor cupón.
 *
 * El oro de la marca sobre gris claro queda mate — es un amarillo oscuro
 * sobre un fondo casi blanco, y no hay contraste que lo haga brillar. Sobre
 * obsidiana sí. Esta franja existe para eso y para darle a la pestaña una
 * forma reconocible de lejos, que era el problema: seis secciones con la
 * misma tarjeta blanca sobre el mismo gris.
 *
 * Aparece **una sola vez**. Un fondo oscuro de pantalla completa con un
 * acento brillante es el aspecto que tienen todas las apps que quieren
 * parecer caras; una franja es un gesto, una pantalla entera es un disfraz.
 *
 * Sin cupón destacado se queda en el título. Sigue marcando la pestaña, y
 * ese hueco es más honesto que rellenarlo con algo decorativo.
 */
export function OffersHero({
  coupon, status, topInset = 0, onPressCoupon, onExpire,
}: {
  coupon: OfferCoupon | null;
  status?: CouponStatus;
  /**
   * El alto de la barra de estado. La franja pasa por debajo de ella en
   * vez de empezar más abajo: cortarla ahí dejaría una banda blanca
   * flotando sobre la obsidiana y el gesto se perdería.
   */
  topInset?: number;
  onPressCoupon?: () => void;
  onExpire?: () => void;
}) {
  return (
    <View
      style={[
        styles.band,
        !coupon && styles.bandBare,
        { paddingTop: topInset + Spacing.lg },
      ]}
    >
      <View style={styles.titleRow}>
        <Text v="displayM" color={palette.paper0}>Descuentos</Text>
        {coupon ? (
          <Text v="bodyS" color={palette.ink100}>El mejor de hoy</Text>
        ) : null}
      </View>

      {coupon ? (
        <TicketCard
          coupon={coupon}
          width="100%"
          tone="ink"
          notchColor={palette.ink900}
          status={status}
          onPress={onPressCoupon}
          onExpire={onExpire}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    backgroundColor: palette.ink900,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xxl,
    borderBottomLeftRadius: BorderRadius.xxl,
    borderBottomRightRadius: BorderRadius.xxl,
    gap: Spacing.lg,
  },
  bandBare: { paddingBottom: Spacing.xl },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
});
