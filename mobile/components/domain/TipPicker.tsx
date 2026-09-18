import { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text, Input } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { TIP_ACCENT, TIP_PRESETS, tipInputError, validTip } from '../../lib/tip';
import { groupThousands, money } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { BorderRadius, Spacing } from '../../theme/tokens';

/**
 * Los montos de propina: cuatro fijos y "Otro valor".
 *
 * Lo comparten la pantalla previa al pedido y la de después de la entrega,
 * así que el dinero se elige igual en las dos. `value` es `null` mientras no
 * haya nada elegido — ninguno viene marcado de antemano: la propina es una
 * decisión de quien paga, no un valor que se acepta por inercia.
 */
export function TipPicker({
  value, onChange,
}: {
  value: number | null;
  onChange: (amount: number | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [digits, setDigits] = useState('');

  const pickPreset = (amount: number) => {
    setCustom(false);
    setDigits('');
    onChange(amount);
  };

  const pickCustom = () => {
    setCustom(true);
    onChange(validTip(digits ? Number(digits) : null));
  };

  const typeCustom = (text: string) => {
    const clean = text.replace(/\D/g, '').slice(0, 6);
    setDigits(clean);
    onChange(validTip(clean ? Number(clean) : null));
  };

  return (
    <View style={styles.group}>
      <View style={styles.chips}>
        {TIP_PRESETS.map((amount) => (
          <TipChip
            key={amount}
            label={money(amount)}
            active={!custom && value === amount}
            onPress={() => pickPreset(amount)}
          />
        ))}
        <TipChip label="Otro valor" active={custom} onPress={pickCustom} />
      </View>

      {custom ? (
        <Input
          label="¿Cuánto quieres dejar?"
          prefix="$"
          numeric
          keyboardType="number-pad"
          placeholder="2.500"
          autoFocus
          value={digits ? groupThousands(Number(digits)) : ''}
          onChangeText={typeCustom}
          error={tipInputError(digits)}
        />
      ) : null}

      <Text v="bodyS" tone="textMuted">
        El 100 % va para el domiciliario. ZIPP no se queda con nada.
      </Text>
    </View>
  );
}

/** Chip con el rojo de la propina; el `Chip` común pinta con el color primario del tema. */
function TipChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[
        styles.chip,
        {
          backgroundColor: active ? TIP_ACCENT : c.surface,
          borderColor: active ? TIP_ACCENT : c.border,
        },
      ]}
    >
      <Text v="strongM" color={active ? '#FFFFFF' : undefined}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { gap: Spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    minHeight: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
