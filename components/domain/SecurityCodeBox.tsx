import { View, StyleSheet } from 'react-native';
import { Text, Icon } from '../ui';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

/**
 * El código de seguridad, tal como lo pinta la parte que debe enseñarlo.
 *
 * Solo se renderiza cuando `code` llega del backend — nunca antes: el
 * servidor ya decidió que a esta persona, en este momento, le toca verlo
 * (ver `OrderSecurityService.viewFor`). El componente no oculta nada por su
 * cuenta porque no tiene nada que ocultar: si el código llegó, es porque
 * corresponde mostrarlo.
 */
export function SecurityCodeBox({
  code,
  warning,
}: {
  code: string;
  /** Instrucción de a quién dárselo y cuándo. Cambia según la etapa. */
  warning: string;
}) {
  const { c } = useTheme();

  return (
    <View style={[styles.box, { backgroundColor: c.limeSoft, borderColor: c.limeSoftBorder }]}>
      <View style={styles.header}>
        <Icon name="candado" size="sm" color={c.limeText} />
        <Text v="captionStrong" tone="limeText">CÓDIGO DE SEGURIDAD</Text>
      </View>
      <Text
        v="dataXL"
        tone="limeText"
        style={styles.code}
        accessibilityLabel={`Código de seguridad: ${code.split('').join(' ')}`}
      >
        {code}
      </Text>
      <View style={styles.warningRow}>
        <Icon name="atencion" size="sm" color={c.warningText} />
        <Text v="bodyS" tone="warningText" style={styles.flex}>{warning}</Text>
      </View>
    </View>
  );
}

/** Mientras el código todavía no corresponde a esta etapa. */
export function SecurityCodePending({ label }: { label: string }) {
  const { c } = useTheme();
  return (
    <View style={[styles.box, styles.pending, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
      <Icon name="candado" size="sm" color={c.textMuted} />
      <Text v="bodyS" tone="textMuted" style={styles.flex}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  box: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    padding: Spacing.lg,
    gap: Spacing.sm,
    alignItems: 'center',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  code: { letterSpacing: 6 },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.xs,
    marginTop: Spacing.xs,
  },
  pending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
});
