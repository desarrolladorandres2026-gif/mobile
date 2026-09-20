import { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text } from './Text';
import { Icon } from './Icon';
import { useTheme } from '../../hooks/useTheme';
import type { IconName } from '../../theme/icons';
import { Spacing, BorderRadius, Motion } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

// ──────────────────────────────────────────────────────────────
// El `PlainField` de los desplegables: mismo ícono + etiqueta + línea
// delgada, pero en vez de un cursor abre sus opciones debajo, en el
// mismo flujo de la hoja.
//
// Se despliega en línea y no en un modal aparte a propósito: estas hojas
// ya son un `Modal`, y en Android un modal dentro de otro se queda a veces
// por debajo del primero. Además así la lista empuja el contenido y se ve
// de dónde salió.
// ──────────────────────────────────────────────────────────────

export interface PlainSelectOption<T extends string> {
  value: T;
  /** El nombre completo, sin abreviar: es lo que se lee en la lista y en el campo. */
  label: string;
}

export interface PlainSelectProps<T extends string> {
  label: string;
  icon: IconName;
  options: PlainSelectOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
}

export function PlainSelect<T extends string>({
  label, icon, options, value, onChange, placeholder = 'Elige una opción', error, hint,
}: PlainSelectProps<T>) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);

  const selected = options.find((option) => option.value === value);
  const lineColor = error ? c.error : open ? c.primary : c.border;
  const iconColor = error ? c.error : open ? c.primaryText : c.text;

  return (
    <View style={styles.field}>
      <Pressable
        onPress={() => { tap('light'); setOpen((v) => !v); }}
        style={styles.row}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={
          selected ? `${label}: ${selected.label}. Toca para cambiarlo` : `${label}. ${placeholder}`
        }
      >
        <Icon name={icon} size={28} color={iconColor} />

        <View style={styles.body}>
          <Text v="caption" tone="textMuted">{label}</Text>
          <Text v="bodyM" tone={selected ? 'text' : 'textMuted'} numberOfLines={1}>
            {selected?.label ?? placeholder}
          </Text>
        </View>

        <Icon name={open ? 'plegar' : 'desplegar'} size="md" color={c.textMuted} />
      </Pressable>

      <View
        style={[
          styles.line,
          { backgroundColor: lineColor, height: open || error ? 2 : StyleSheet.hairlineWidth },
        ]}
      />

      {open ? (
        <Animated.View
          entering={FadeIn.duration(Motion.fast)}
          style={[styles.list, { backgroundColor: c.surface, borderColor: c.border }]}
          accessibilityRole="radiogroup"
        >
          {options.map((option, index) => {
            const active = option.value === value;
            return (
              <Pressable
                key={option.value}
                onPress={() => { tap('select'); onChange(option.value); setOpen(false); }}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                style={[
                  styles.option,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                ]}
              >
                <Text v={active ? 'strongS' : 'bodyM'} style={styles.flex}>{option.label}</Text>
                {active ? <Icon name="checkCirculo" size="md" color={c.primaryText} /> : null}
              </Pressable>
            );
          })}
        </Animated.View>
      ) : null}

      {error ? (
        <View style={styles.messageRow}>
          <Icon name="atencion" size="sm" color={c.error} />
          <Text v="caption" tone="errorText" style={styles.flex}>{error}</Text>
        </View>
      ) : hint ? (
        <Text v="caption" tone="textMuted" style={styles.indent}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  body: { flex: 1, gap: 2 },
  line: { marginLeft: 28 + Spacing.md },
  list: {
    marginLeft: 28 + Spacing.md,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, minHeight: 48,
  },
  flex: { flex: 1 },
  messageRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginLeft: 28 + Spacing.md },
  indent: { marginLeft: 28 + Spacing.md },
});
