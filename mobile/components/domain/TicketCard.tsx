import { memo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text } from '../ui';
import { LiveCountdown } from './LiveCountdown';
import { BorderRadius, Spacing, Shadow, palette } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { money } from '../../lib/format';
import {
  couponMagnitude, couponBenefit, usageProgress, isExpiringSoon, windowLabel,
  type CouponStatus,
} from '../../lib/offers';
import type { OfferCoupon } from '../../services/endpoints';

/**
 * Un cupón, con forma de tiquete.
 *
 * La versión anterior era un rectángulo de borde punteado, igual que las
 * tarjetas de plato, de negocio y de saldo: seis secciones con la misma
 * silueta. Aquí el cupón se rompe por la mitad como un tiquete de verdad
 * —dos muescas y una perforación— para que se reconozca sin leerlo, con la
 * pantalla borrosa.
 *
 * El otro cambio es de jerarquía: el héroe es la magnitud. "25%" a 32px y
 * el título del cupón debajo, pequeño. Antes el título mandaba y el
 * descuento iba en una frase del mismo tamaño, en una pantalla cuyo único
 * trabajo es contestar "¿cuánto me ahorro?".
 *
 * `notchColor` tiene que ser el color de lo que hay detrás: las muescas son
 * dos círculos pintados del color del fondo que se comen el borde. Con el
 * color equivocado se ven dos lunares en vez de un corte.
 */
export const TicketCard = memo(function TicketCard({
  coupon, width = 244, status, onPress, onExpire, notchColor,
}: {
  coupon: OfferCoupon;
  width?: number | `${number}%`;
  status?: CouponStatus;
  onPress?: () => void;
  onExpire?: () => void;
  /** El color del fondo sobre el que se apoya el tiquete. */
  notchColor: string;
}) {
  const { c } = useTheme();

  const { value, qualifier } = couponMagnitude(coupon);
  const progress = usageProgress(coupon);
  const expiring = isExpiringSoon(coupon);
  const blocked = !!status && status.kind !== 'active';

  const surface = c.surface;
  const magnitude = palette.gold600;
  const ink = c.text;
  const quiet = c.textMuted;
  const rule = c.border;

  const Container: typeof View | typeof Pressable = onPress ? Pressable : View;

  return (
    <Container
      onPress={onPress ? () => { tap('light'); onPress(); } : undefined}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `${couponBenefit(coupon)}. ${coupon.title}` : undefined}
      accessibilityHint={onPress ? 'Abre las condiciones del cupón' : undefined}
      style={[
        styles.ticket,
        Shadow.sm,
        blocked && styles.blocked,
        { width, backgroundColor: surface },
      ]}
    >
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text v="displayL" color={magnitude} numberOfLines={1} style={styles.magnitude}>
            {value}
          </Text>
          {qualifier ? (
            <Text v="bodyS" color={quiet} numberOfLines={1}>{qualifier}</Text>
          ) : null}
        </View>

        {expiring && !blocked ? (
          <LiveCountdown target={coupon.validUntil} onExpire={onExpire} />
        ) : null}
      </View>

      <Text v="titleS" color={ink} numberOfLines={2} style={styles.title}>
        {coupon.title}
      </Text>

      <Condition coupon={coupon} status={status} color={quiet} />

      {/* ── La perforación ──
          El corte: una línea de guiones entre dos muescas que muerden el
          borde. Es lo que separa la promesa (arriba) del talón que se
          arranca (abajo, con el código). */}
      <View style={styles.perforation}>
        <View style={[styles.notch, styles.notchLeft, { backgroundColor: notchColor }]} />
        <View style={[styles.cut, { borderColor: rule }]} />
        <View style={[styles.notch, styles.notchRight, { backgroundColor: notchColor }]} />
      </View>

      <View style={styles.stub}>
        <Text v="code" color={magnitude} numberOfLines={1} style={styles.flex}>
          {coupon.code}
        </Text>
        <Stub coupon={coupon} status={status} progress={progress} color={quiet} />
      </View>
    </Container>
  );
});

/**
 * La condición que de verdad limita este cupón, una sola.
 *
 * Antes se apilaban dos o tres insignias —primer pedido, mínimo, cupo— y en
 * una tarjeta de riel eso es más ruido que información. Se enseña la que
 * bloquea antes: el mínimo de compra es lo que hace que un cupón no aplique
 * en la mayoría de los carritos.
 */
function Condition({
  coupon, status, color,
}: { coupon: OfferCoupon; status?: CouponStatus; color: string }) {
  if (status?.window) {
    return <Text v="caption" color={color} numberOfLines={1}>{windowLabel(status.window)}</Text>;
  }
  if (coupon.minOrderAmount) {
    return (
      <Text v="caption" color={color} numberOfLines={1}>
        Desde {money(coupon.minOrderAmount)}
      </Text>
    );
  }
  if (coupon.firstOrderOnly) {
    return <Text v="caption" color={color} numberOfLines={1}>Tu primer pedido</Text>;
  }
  return <Text v="caption" color={color} numberOfLines={1}>Sin pedido mínimo</Text>;
}

/**
 * Lo que va a la derecha del código: el estado, o cuánto queda.
 *
 * El estado gana al cupo. Saber que ya lo usaste importa más que saber que
 * al resto del mundo le queda el 30%.
 */
function Stub({
  coupon, status, progress, color,
}: {
  coupon: OfferCoupon;
  status?: CouponStatus;
  progress: number | null;
  color: string;
}) {
  const label = status && status.kind !== 'active'
    ? {
        used: 'Ya lo usaste',
        not_first_order: 'Solo primer pedido',
        scheduled: 'Vuelve más tarde',
        unavailable: 'No disponible',
      }[status.kind]
    : null;

  if (label) return <Text v="caption" color={color} numberOfLines={1}>{label}</Text>;

  if (progress !== null) {
    const left = Math.max(0, Math.round((1 - progress) * 100));
    return (
      <Text v="caption" color={color} numberOfLines={1}>
        {left <= 0 ? 'Se agotó' : `Queda ${left}%`}
      </Text>
    );
  }

  return (
    <Text v="caption" color={color} numberOfLines={1}>
      {coupon.type === 'free_delivery' ? 'En el envío' : 'En tu pedido'}
    </Text>
  );
}

/** El diámetro de la muesca. La mitad sobresale por cada lado. */
const NOTCH = 20;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  ticket: {
    // Radio pequeño y deliberado: esto es papel impreso, no una tarjeta
    // blanda. La baldosa de comida usa uno mucho mayor, y esa diferencia
    // es la que deja distinguirlas de un vistazo.
    borderRadius: BorderRadius.sm,
    paddingTop: Spacing.lg,
    gap: 2,
    overflow: 'hidden',
  },
  blocked: { opacity: 0.5 },

  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  magnitude: { marginBottom: -2 },
  title: { paddingHorizontal: Spacing.lg, marginTop: Spacing.sm },

  perforation: {
    height: NOTCH,
    marginTop: Spacing.md,
    justifyContent: 'center',
  },
  cut: {
    borderTopWidth: 1,
    borderStyle: 'dashed',
    marginHorizontal: NOTCH / 2 + Spacing.sm,
  },
  notch: {
    position: 'absolute',
    width: NOTCH,
    height: NOTCH,
    borderRadius: NOTCH / 2,
  },
  notchLeft: { left: -NOTCH / 2 },
  notchRight: { right: -NOTCH / 2 },

  stub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
  },
});
