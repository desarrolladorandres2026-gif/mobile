import { Pressable, View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, Icon } from '../ui';
import { ContentIcon } from '../illustrations';
import { useLoyalty } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { BorderRadius, Spacing } from '../../theme/tokens';

/**
 * Puente entre Descuentos y los puntos ZIPP.
 *
 * Las dos pantallas prometían lo mismo —"esto te cuesta menos"— pero vivían
 * separadas: para saber cuánto le faltaba a alguien para su primer canje
 * tenía que entrar a Perfil. Se muestra siempre, incluso en cero, porque a
 * quien nunca ganó un punto es a quien más le sirve enterarse de que el
 * programa existe.
 */
export function LoyaltyProgressBanner() {
  const router = useRouter();
  const { c } = useTheme();
  const { data } = useLoyalty();

  const balance = data?.balance ?? 0;
  const minRedeem = data?.minRedeem ?? 0;
  const canRedeem = minRedeem > 0 && balance >= minRedeem;
  const progress = minRedeem > 0 ? Math.min(1, balance / minRedeem) : 0;

  const message = canRedeem
    ? `Ya puedes canjear tus ${balance.toLocaleString('es-CO')} puntos por un cupón`
    : minRedeem > 0
    ? `Te faltan ${(minRedeem - balance).toLocaleString('es-CO')} puntos para tu primer canje`
    : 'Gana puntos con cada pedido entregado';

  return (
    <Pressable
      onPress={() => { tap('light'); router.push('/(client)/rewards'); }}
      style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}
      accessibilityRole="button"
      accessibilityLabel="Tus puntos ZIPP"
      accessibilityHint="Abre la pantalla de puntos y canjes"
    >
      <View style={styles.top}>
        <ContentIcon name="trofeo" size={30} />
        <View style={styles.flex}>
          <Text v="strongM">Tus puntos ZIPP</Text>
          <Text v="bodyS" tone="textSecondary" numberOfLines={1}>{message}</Text>
        </View>
        <Icon name="adelante" size="sm" color={c.textMuted} />
      </View>

      <View style={[styles.track, { backgroundColor: c.surfaceLight }]}>
        <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: c.primary }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  track: {
    height: 6,
    borderRadius: BorderRadius.full,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: BorderRadius.full },
});
