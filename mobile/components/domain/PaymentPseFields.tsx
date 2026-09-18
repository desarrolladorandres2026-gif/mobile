import { useMemo, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text, Icon, Input, Chip, SearchField, Skeleton, Notice } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import type { PseBank } from '../../hooks/useApi';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

export interface PseFormValues {
  bankCode: string;
  bankName: string;
  userType: 0 | 1;
  docType: string;
  docNumber: string;
}

export type PseFormErrors = Partial<Record<'bank' | 'docNumber', string>>;

const DOC_TYPES: { code: string; label: string }[] = [
  { code: 'CC', label: 'Cédula' },
  { code: 'CE', label: 'Extranjería' },
  { code: 'NIT', label: 'NIT' },
  { code: 'PP', label: 'Pasaporte' },
];

export function validatePseForm(values: PseFormValues): PseFormErrors {
  const errors: PseFormErrors = {};
  // Wompi pone en la lista una fila "A continuación seleccione su banco"
  // con código 0; elegirla no es elegir un banco.
  if (!values.bankCode || values.bankCode === '0') errors.bank = 'Elige tu banco';
  if (!/^[A-Za-z0-9]{4,20}$/.test(values.docNumber.trim())) {
    errors.docNumber = 'Escribe el número del documento, sin puntos';
  }
  return errors;
}

interface Props {
  values: PseFormValues;
  errors: PseFormErrors;
  onChange: (next: PseFormValues) => void;
  banks: PseBank[] | undefined;
  loading: boolean;
  loadError: boolean;
}

/**
 * Banco, tipo de persona y documento para PSE.
 *
 * El pago en sí lo autoriza el banco en su propia página, que la app abre
 * en un WebView propio. Aquí solo se reúne lo que Wompi necesita para saber
 * a qué banco mandar a la persona.
 */
export function PaymentPseFields({ values, errors, onChange, banks, loading, loadError }: Props) {
  const { c } = useTheme();
  const [query, setQuery] = useState('');
  const set = (patch: Partial<PseFormValues>) => onChange({ ...values, ...patch });

  const visibleBanks = useMemo(() => {
    const list = (banks ?? []).filter((bank) => bank.code !== '0');
    const q = query.trim().toLowerCase();
    return q ? list.filter((bank) => bank.name.toLowerCase().includes(q)) : list;
  }, [banks, query]);

  return (
    <View style={styles.wrap}>
      <Text v="label" tone="textMuted">Tu banco</Text>

      {values.bankCode && !query ? (
        <Pressable
          onPress={() => { tap('select'); set({ bankCode: '', bankName: '' }); }}
          accessibilityRole="button"
          accessibilityLabel={`Banco elegido: ${values.bankName}. Toca para cambiarlo`}
          style={[styles.bank, { backgroundColor: c.primarySoft, borderColor: c.primary }]}
        >
          <Icon name="edificio" size="sm" color={c.primaryText} />
          <Text v="strongS" style={styles.flex}>{values.bankName}</Text>
          <Text v="caption" tone="primaryText">Cambiar</Text>
        </Pressable>
      ) : (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Busca tu banco" />
          {loading ? (
            <View style={styles.list}>
              <Skeleton height={48} />
              <Skeleton height={48} />
              <Skeleton height={48} />
            </View>
          ) : loadError ? (
            <Notice tone="error">No pudimos cargar la lista de bancos. Cierra y vuelve a intentarlo.</Notice>
          ) : (
            <View style={styles.list}>
              {visibleBanks.slice(0, 40).map((bank) => (
                <Pressable
                  key={bank.code}
                  onPress={() => {
                    tap('select');
                    setQuery('');
                    set({ bankCode: bank.code, bankName: bank.name });
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: values.bankCode === bank.code }}
                  style={[styles.bank, { backgroundColor: c.surface, borderColor: c.border }]}
                >
                  <Icon name="edificio" size="sm" color={c.textMuted} />
                  <Text v="bodyM" style={styles.flex} numberOfLines={1}>{bank.name}</Text>
                </Pressable>
              ))}
              {visibleBanks.length === 0 ? (
                <Text v="bodyS" tone="textMuted">Ningún banco coincide con “{query}”.</Text>
              ) : null}
            </View>
          )}
        </>
      )}
      {errors.bank ? <Text v="caption" tone="errorText">{errors.bank}</Text> : null}

      <Text v="label" tone="textMuted" style={styles.gapTop}>Titular de la cuenta</Text>
      <View style={styles.chips}>
        <Chip label="Persona natural" active={values.userType === 0} onPress={() => { tap('select'); set({ userType: 0 }); }} />
        <Chip label="Empresa" active={values.userType === 1} onPress={() => { tap('select'); set({ userType: 1 }); }} />
      </View>

      <View style={styles.chips}>
        {DOC_TYPES.map((doc) => (
          <Chip
            key={doc.code}
            label={doc.label}
            active={values.docType === doc.code}
            onPress={() => { tap('select'); set({ docType: doc.code }); }}
          />
        ))}
      </View>

      <Input
        label="Número de documento"
        numeric
        value={values.docNumber}
        onChangeText={(text) => set({ docNumber: text.replace(/[^A-Za-z0-9]/g, '') })}
        keyboardType={values.docType === 'PP' ? 'default' : 'number-pad'}
        maxLength={20}
        error={errors.docNumber}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.sm },
  list: { gap: Spacing.xs },
  bank: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    minHeight: 48,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
  },
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  gapTop: { marginTop: Spacing.sm },
});
