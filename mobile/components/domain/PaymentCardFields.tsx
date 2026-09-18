import { View, StyleSheet } from 'react-native';
import { Input } from '../ui';
import {
  BRAND_LABEL,
  cvcLengthFor,
  detectBrand,
  formatCardNumber,
  formatExpiry,
  maxLengthFor,
  onlyDigits,
  type CardFormErrors,
  type CardFormValues,
} from '../../lib/card';
import { Spacing } from '../../theme/tokens';

/**
 * Los cuatro campos de una tarjeta nueva.
 *
 * Solo presentación: el estado vive en `PaymentMethodSheet`, que es quien
 * tiene el botón y decide cuándo tokenizar. Nada de lo escrito aquí sale
 * del teléfono salvo hacia Wompi.
 *
 * Los `autoComplete`/`textContentType` dejan que el sistema ofrezca las
 * tarjetas que la persona ya tiene guardadas en Google o en el llavero de
 * iOS, que es la forma más rápida y menos propensa a errores de escribir
 * dieciséis dígitos.
 */
interface Props {
  values: CardFormValues;
  errors: CardFormErrors;
  onChange: (next: CardFormValues) => void;
}

export function PaymentCardFields({ values, errors, onChange }: Props) {
  const brand = detectBrand(values.number);
  const set = (patch: Partial<CardFormValues>) => onChange({ ...values, ...patch });

  // Un espacio por cada grupo, además de los dígitos.
  const numberMaxLength = maxLengthFor(brand) + 4;

  return (
    <View style={styles.wrap}>
      <Input
        label="Número de la tarjeta"
        icon="tarjeta"
        numeric
        value={values.number}
        onChangeText={(text) => set({ number: formatCardNumber(text) })}
        placeholder="0000 0000 0000 0000"
        keyboardType="number-pad"
        maxLength={numberMaxLength}
        autoComplete="cc-number"
        textContentType="creditCardNumber"
        error={errors.number}
        hint={brand !== 'UNKNOWN' ? BRAND_LABEL[brand] : undefined}
      />

      <View style={styles.row}>
        <Input
          label="Vence"
          numeric
          value={values.expiry}
          onChangeText={(text) => set({ expiry: formatExpiry(text) })}
          placeholder="MM/AA"
          keyboardType="number-pad"
          maxLength={5}
          autoComplete="cc-exp"
          error={errors.expiry}
          containerStyle={styles.half}
        />
        <Input
          label="Código"
          numeric
          value={values.cvc}
          onChangeText={(text) => set({ cvc: onlyDigits(text).slice(0, cvcLengthFor(brand)) })}
          placeholder={brand === 'AMEX' ? '0000' : '000'}
          keyboardType="number-pad"
          maxLength={cvcLengthFor(brand)}
          secureTextEntry
          autoComplete="cc-csc"
          error={errors.cvc}
          hint={brand === 'AMEX' ? 'Al frente, 4 dígitos' : 'Al reverso, 3 dígitos'}
          containerStyle={styles.half}
        />
      </View>

      <Input
        label="Nombre en la tarjeta"
        value={values.holder}
        onChangeText={(text) => set({ holder: text })}
        placeholder="Como aparece impreso"
        autoCapitalize="characters"
        autoComplete="cc-name"
        textContentType="name"
        maxLength={60}
        error={errors.holder}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.md },
  row: { flexDirection: 'row', gap: Spacing.md },
  half: { flex: 1 },
});
