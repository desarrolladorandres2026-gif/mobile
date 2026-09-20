import { useState, useRef } from 'react';
import { View, Pressable, StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { useTheme } from '../../hooks/useTheme';
import type { IconName } from '../../theme/icons';
import { Spacing } from '../../theme/tokens';
import { Type, FontFamily } from '../../theme/typography';

// ──────────────────────────────────────────────────────────────
// Campo de texto sin caja: ícono + etiqueta + valor, con una línea
// delgada debajo en vez del recuadro con fondo del `Input` genérico.
// Mismo lenguaje que las filas de Perfil: nada de contenedores.
//
// Nació dentro de la hoja "Editar perfil" de profile.tsx; vive aquí desde
// que esa hoja se volvió la pantalla Mi cuenta, que lo usa en cada hoja.
// ──────────────────────────────────────────────────────────────

export interface PlainFieldProps {
  label: string;
  icon: IconName;
  value: string;
  onChangeText?: (t: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  prefix?: string;
  keyboardType?: TextInputProps['keyboardType'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoComplete?: TextInputProps['autoComplete'];
  returnKeyType?: TextInputProps['returnKeyType'];
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
  editable?: boolean;
  maxLength?: number;
  numeric?: boolean;
}

export function PlainField({
  label, icon, value, onChangeText, placeholder, error, hint, prefix,
  keyboardType, autoCapitalize, autoComplete, returnKeyType, onSubmitEditing, autoFocus,
  editable = true, maxLength, numeric,
}: PlainFieldProps) {
  const { c } = useTheme();
  const [focused, setFocused] = useState(false);
  const ref = useRef<TextInput>(null);

  const lineColor = error ? c.error : focused ? c.primary : c.border;
  const iconColor = error ? c.error : focused ? c.primaryText : c.text;

  return (
    <View style={styles.plainField}>
      <Pressable
        onPress={() => ref.current?.focus()}
        style={styles.plainFieldRow}
        accessibilityRole="none"
      >
        <Icon name={icon} size={28} color={iconColor} />

        <View style={styles.plainFieldBody}>
          <Text v="caption" tone="textMuted">{label}</Text>
          <View style={styles.plainFieldInputRow}>
            {prefix ? (
              <Text v="dataM" tone="textSecondary" style={{ fontFamily: FontFamily.data }}>
                {prefix}
              </Text>
            ) : null}
            <TextInput
              ref={ref}
              value={value}
              onChangeText={onChangeText}
              placeholder={placeholder}
              placeholderTextColor={c.textMuted}
              keyboardType={keyboardType}
              autoCapitalize={autoCapitalize}
              autoComplete={autoComplete}
              returnKeyType={returnKeyType}
              onSubmitEditing={onSubmitEditing}
              autoFocus={autoFocus}
              editable={editable}
              maxLength={maxLength}
              accessibilityLabel={label}
              style={[styles.plainFieldInput, numeric ? Type.dataM : Type.bodyM, { color: c.text }]}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
          </View>
        </View>
      </Pressable>

      <View
        style={[
          styles.plainFieldLine,
          { backgroundColor: lineColor, height: focused || error ? 2 : StyleSheet.hairlineWidth },
        ]}
      />

      {error ? (
        <View style={styles.messageRow}>
          <Icon name="atencion" size="sm" color={c.error} />
          <Text v="caption" tone="errorText" style={styles.flexText}>{error}</Text>
        </View>
      ) : hint ? (
        <Text v="caption" tone="textMuted" style={styles.hintIndent}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  plainField: { gap: Spacing.sm },
  plainFieldRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  plainFieldBody: { flex: 1, gap: 2 },
  plainFieldInputRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  plainFieldInput: { flex: 1, paddingVertical: 4 },
  plainFieldLine: { marginLeft: 28 + Spacing.md },
  messageRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginLeft: 28 + Spacing.md },
  flexText: { flex: 1 },
  hintIndent: { marginLeft: 28 + Spacing.md },
});
