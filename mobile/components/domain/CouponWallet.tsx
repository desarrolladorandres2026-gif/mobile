import { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { Text, Button, Chip, Card, Skeleton, Notice } from '../ui';
import { ContentIcon } from '../illustrations';
import { TicketCard } from './TicketCard';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { useLoyalty, useMyCoupons, useRedeemPoints } from '../../hooks/useApi';
import { redeemOptions } from '../../lib/loyalty';
import { apiMessage } from '../../lib/errors';
import { money } from '../../lib/format';
import { tap } from '../../lib/haptics';
import type { OfferCoupon, OwnCoupon } from '../../services/endpoints';

/**
 * Lo que ya es tuyo: los puntos y los cupones a tu nombre.
 *
 * Vivía en Recompensas, a dos toques de aquí, mientras esta pantalla pintaba
 * los mismos cupones públicos con otro diseño y otro endpoint. Dos sitios
 * distintos hablando de lo mismo terminan diciendo cosas distintas; y el
 * cupón que compraste con tus puntos no aparecía donde la gente va a buscar
 * descuentos.
 *
 * El canje también se mudó porque es el paso siguiente natural: se mira el
 * saldo y se convierte en algo gastable sin cambiar de pantalla.
 */
export function CouponWallet({ onCouponPress }: { onCouponPress?: (coupon: OfferCoupon) => void }) {
  const { c } = useTheme();
  const { data: loyalty, isPending, isError } = useLoyalty();
  const { data: ownCoupons = [] } = useMyCoupons();
  const redeem = useRedeemPoints();

  const points = loyalty?.balance ?? 0;
  const minRedeem = loyalty?.minRedeem ?? 0;
  const options = redeemOptions(points, minRedeem);

  const [amount, setAmount] = useState<number | null>(null);
  const selected = amount !== null && options.includes(amount) ? amount : options[0];

  // Un fallo de red no puede verse igual que "tienes cero puntos": lo
  // primero se arregla reintentando y lo segundo pidiendo comida.
  if (isError) {
    return (
      <Notice tone="warning">
        No pudimos cargar tus puntos. Desliza hacia abajo para reintentar.
      </Notice>
    );
  }

  if (isPending) {
    return (
      <Card>
        <Skeleton width="45%" height={26} />
        <Skeleton width="70%" height={14} />
      </Card>
    );
  }

  return (
    <View style={styles.wrap}>
      <Card style={styles.balance}>
        <View style={styles.balanceHead}>
          <ContentIcon name="trofeo" size={34} />
          <View style={styles.flex}>
            <Text v="displayS">{points.toLocaleString('es-CO')} puntos</Text>
            {/* Un punto vale un peso y se dice en voz alta. Los programas
                donde "1000 puntos son 12.500 pesos" existen para que el
                cliente no sepa cuánto tiene. */}
            <Text v="bodyS" tone="textSecondary">
              {points > 0 ? `Valen ${money(points)} en tu próximo pedido` : 'Cada pedido entregado suma'}
            </Text>
          </View>
        </View>

        {options.length > 0 && selected ? (
          <>
            <View style={styles.amounts}>
              {options.map((option) => (
                <Chip
                  key={option}
                  label={option === points ? `Todo, ${money(option)}` : money(option)}
                  active={option === selected}
                  onPress={() => setAmount(option)}
                />
              ))}
            </View>
            <Button
              title={`Canjear ${selected.toLocaleString('es-CO')} puntos`}
              icon="cupon"
              full
              loading={redeem.isPending}
              onPress={() => {
                tap('medium');
                redeem.mutate(selected, {
                  onSuccess: (result) => {
                    tap('success');
                    setAmount(null);
                    Alert.alert(
                      '¡Cupón listo!',
                      `Te descuenta ${money(result.value)}. Queda aquí abajo y al pagar se ` +
                        'aplica con un toque.'
                    );
                  },
                  onError: (err) =>
                    Alert.alert('No pudimos canjear', apiMessage(err, 'Inténtalo de nuevo.')),
                });
              }}
            />
          </>
        ) : points > 0 && minRedeem > 0 ? (
          <Text v="caption" tone="textMuted">
            Te faltan {(minRedeem - points).toLocaleString('es-CO')} puntos para tu primer canje
          </Text>
        ) : null}
      </Card>

      {ownCoupons.length > 0 ? (
        <View style={styles.own}>
          {ownCoupons.map((own) => (
            <TicketCard
              key={own._id}
              coupon={asOfferCoupon(own)}
              width="100%"
              notchColor={c.background}
              onPress={onCouponPress ? () => onCouponPress(asOfferCoupon(own)) : undefined}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Un cupón propio, con la forma que espera la tarjeta común.
 *
 * `/coupons/mine` devuelve menos campos que `/offers` —no tiene cupo global
 * ni franja horaria, porque un cupón nominal es de un solo uso y de quien lo
 * canjeó—. Adaptarlo aquí evita una segunda tarjeta que se vería casi igual
 * y envejecería por separado, que es como Recompensas acabó con su propio
 * diseño de cupón.
 */
function asOfferCoupon(own: OwnCoupon): OfferCoupon {
  return {
    _id: own._id,
    code: own.code,
    title: own.title,
    type: own.type as OfferCoupon['type'],
    value: own.value,
    minOrderAmount: own.minOrderAmount,
    validUntil: own.validUntil,
    businessId: own.businessId,
  };
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.md },
  flex: { flex: 1 },
  balance: { gap: Spacing.md },
  balanceHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  amounts: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  own: { gap: Spacing.sm },
});
