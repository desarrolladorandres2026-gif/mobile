import { useRef, useState } from 'react';
import {
  View, TextInput, Pressable, StyleSheet,
  type TextInputProps, type ViewStyle,
} from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Size, Spacing } from '../../theme/tokens';
import { Type } from '../../theme/typography';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  icon?: IconName;
  /** Mensaje de error. Su presencia pinta el campo en rojo. */
  error?: string;
  /** Texto de apoyo bajo el campo. Desaparece cuando hay error. */
  hint?: string;
  password?: boolean;
  /** Sufijo fijo dentro del campo, por ejemplo la unidad o el prefijo país. */
  prefix?: string;
  containerStyle?: ViewStyle;
  /** Cifras en mono: teléfonos, códigos, montos. */
  numeric?: boolean;
}

/**
 * Campo de texto.
 *
 * El borde se ilumina al enfocar y se pinta de cereza cuando hay error, con
 * el mensaje justo debajo. Nada de errores en un diálogo aparte: el problema
 * se explica donde está, que es donde el usuario va a corregirlo.
 */
export function Input({
  label, icon, error, hint, password, prefix, containerStyle, numeric,
  ...rest
}: InputProps) {
  const { c } = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const ref = useRef<TextInput>(null);

  const borderColor = error ? c.error : focused ? c.primary : c.border;

  return (
    <View style={[styles.group, containerStyle]}>
      {label ? <Text v="strongS" tone="textSecondary">{label}</Text> : null}

      <Pressable
        onPress={() => ref.current?.focus()}
        style={[
          styles.field,
          {
            backgroundColor: c.surface,
            borderColor,
            borderWidth: focused || error ? 2 : 1,
            // Compensa el borde extra para que el campo no salte al enfocar.
            paddingHorizontal: focused || error ? Spacing.lg - 1 : Spacing.lg,
          },
        ]}
      >
        {icon ? (
          <Icon name={icon} size="md" color={error ? c.error : focused ? c.primaryText : c.textMuted} />
        ) : null}

        {prefix ? <Text v="dataM" tone="textMuted">{prefix}</Text> : null}

        <TextInput
          ref={ref}
          style={[
            styles.input,
            numeric ? Type.dataM : Type.bodyM,
            { color: c.text },
          ]}
          placeholderTextColor={c.textMuted}
          secureTextEntry={password && !revealed}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          {...rest}
        />

        {password ? (
          <Pressable
            onPress={() => { tap('light'); setRevealed((v) => !v); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            <Icon name={revealed ? 'ocultar' : 'ver'} size="md" color={c.textMuted} />
          </Pressable>
        ) : null}
      </Pressable>

      {error ? (
        <View style={styles.messageRow}>
          <Icon name="atencion" size="sm" color={c.error} />
          <Text v="caption" tone="errorText" style={styles.message}>{error}</Text>
        </View>
      ) : hint ? (
        <Text v="caption" tone="textMuted">{hint}</Text>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Código de verificación
// ──────────────────────────────────────────────────────────────

export interface OtpInputProps {
  value: string;
  onChange: (code: string) => void;
  length?: number;
  error?: boolean;
  autoFocus?: boolean;
}

/**
 * Casillas del código de verificación.
 *
 * Detrás hay un solo campo invisible en vez de seis campos reales: así el
 * pegado del SMS llena las seis casillas de una, y el autocompletado del
 * sistema funciona. Seis campos separados rompen ambas cosas.
 */
export function OtpInput({ value, onChange, length = 6, error, autoFocus }: OtpInputProps) {
  const { c } = useTheme();
  const ref = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      onPress={() => ref.current?.focus()}
      style={styles.otpRow}
      accessibilityRole="none"
    >
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(t) => onChange(t.replace(/[^0-9]/g, '').slice(0, length))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={length}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.otpHidden}
        accessibilityLabel={`Código de verificación de ${length} dígitos`}
      />

      {Array.from({ length }).map((_, i) => {
        const char = value[i] ?? '';
        const isNext = focused && i === value.length;
        return (
          <View
            key={i}
            style={[
              styles.otpCell,
              {
                backgroundColor: c.surface,
                borderColor: error ? c.error : isNext ? c.primary : char ? c.borderStrong : c.border,
                borderWidth: isNext || error ? 2 : 1,
              },
            ]}
          >
            <Text v="dataL" tone={error ? 'errorText' : 'text'}>{char}</Text>
          </View>
        );
      })}
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────
// Barra de búsqueda
// ──────────────────────────────────────────────────────────────

export function SearchField({
  value, onChange, placeholder, onFilters, autoFocus, filtersActive,
}: {
  value: string;
  onChange: (t: string) => void;
  placeholder: string;
  onFilters?: () => void;
  autoFocus?: boolean;
  filtersActive?: boolean;
}) {
  const { c } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={[
        styles.search,
        {
          backgroundColor: c.surface,
          borderColor: focused ? c.primary : c.border,
          borderWidth: focused ? 2 : 1,
        },
      ]}
    >
      <Icon name="explorar" size="md" color={focused ? c.primaryText : c.textMuted} />
      <TextInput
        style={[styles.input, Type.bodyM, { color: c.text }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        returnKeyType="search"
        autoFocus={autoFocus}
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel="Buscar"
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => { tap('light'); onChange(''); }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Borrar búsqueda"
        >
          <Icon name="cerrar" size="md" color={c.textMuted} />
        </Pressable>
      ) : onFilters ? (
        <Pressable
          onPress={() => { tap('light'); onFilters(); }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Filtros"
          style={[
            styles.filterBtn,
            {
              backgroundColor: filtersActive ? c.primary : c.surfaceLight,
              borderColor: filtersActive ? c.primary : c.border,
            },
          ]}
        >
          <Icon name="filtros" size="sm" color={filtersActive ? c.textOnPrimary : c.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: Spacing.sm },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    height: Size.inputHeight,
    borderRadius: BorderRadius.lg,
  },
  input: { flex: 1, paddingVertical: 0 },
  messageRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  message: { flex: 1 },

  otpRow: { flexDirection: 'row', gap: Spacing.sm },
  otpHidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
  otpCell: {
    flex: 1,
    height: 60,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    height: 54,
    borderRadius: BorderRadius.full,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.sm + 2,
  },
  filterBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
});
