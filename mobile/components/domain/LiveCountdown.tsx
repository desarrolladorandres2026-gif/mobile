import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, Icon, Badge } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { msUntil, formatCountdown } from '../../lib/offers';
import { Spacing } from '../../theme/tokens';

/**
 * Reloj que baja segundo a segundo hasta que un cupón vence.
 *
 * Solo se monta para cupones que ya calificaron como "por vencer" (quien lo
 * usa decide eso antes, comparando `validUntil` una sola vez por render):
 * así el timer de 1s vive únicamente en las tarjetas que de verdad lo
 * necesitan, no en cada cupón de la lista.
 */
export function LiveCountdown({
  target, variant = 'chip', onExpire,
}: {
  target: string;
  variant?: 'chip' | 'large';
  onExpire?: () => void;
}) {
  const { c } = useTheme();
  const [ms, setMs] = useState(() => msUntil(target));

  useEffect(() => {
    const id = setInterval(() => {
      const next = msUntil(target);
      setMs(next);
      if (next <= 0) {
        clearInterval(id);
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [target, onExpire]);

  if (ms <= 0) return null;
  const label = formatCountdown(ms);

  if (variant === 'large') {
    return (
      <View style={styles.large}>
        <Icon name="reloj" size="sm" color={c.warningText} />
        <Text v="dataL" tone="warningText" style={styles.tabular}>{label}</Text>
      </View>
    );
  }

  return <Badge label={`Vence en ${label}`} tone="warning" icon="reloj" pulse />;
}

const styles = StyleSheet.create({
  large: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  tabular: { fontVariant: ['tabular-nums'] },
});
