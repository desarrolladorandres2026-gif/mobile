import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Text, Icon } from '../ui';
import { WompiLogo } from '../brand/WompiLogo';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';

/**
 * El sello de pago seguro: Zipp primero, Wompi debajo y en pequeño.
 *
 * Mucha gente no conoce Wompi, y un "protegido por" una marca desconocida
 * justo antes de pagar asusta más de lo que tranquiliza. El cobro se hace en
 * Zipp; Wompi es quien lo procesa, y queda a la vista para quien sí lo
 * reconoce, pero no es el mensaje.
 *
 * Es uno solo para las cinco pantallas que lo muestran, para que el sello
 * no vuelva a divergir entre el checkout, la hoja de métodos y la espera.
 */
export function SecurePaymentMark({
  align = 'center',
  onDark = false,
  style,
}: {
  align?: 'center' | 'start';
  /** Sobre una superficie de color propia (la espera de Nequi), no sobre el tema. */
  onDark?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const strong = onDark ? 'rgba(255,255,255,0.85)' : c.text;
  const faint = onDark ? 'rgba(255,255,255,0.6)' : c.textMuted;

  return (
    <View
      style={[styles.wrap, { alignItems: align === 'center' ? 'center' : 'flex-start' }, style]}
      accessible
      accessibilityLabel="Pago seguro en Zipp, procesado por Wompi"
    >
      <View style={styles.line}>
        <Icon name="candado" size="sm" color={faint} />
        <Text v="captionStrong" color={strong}>Pago seguro en Zipp</Text>
      </View>
      <View style={styles.line}>
        <Text v="caption" color={faint}>procesado por</Text>
        <WompiLogo height={9} color={faint} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
});
