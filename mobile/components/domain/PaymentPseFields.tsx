import { useMemo, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text, Icon, Input, SearchField, Skeleton, Notice } from '../ui';
import { BankLogo } from '../brand/BankLogo';
import { useTheme } from '../../hooks/useTheme';
import type { PseBank } from '../../hooks/useApi';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

export interface PseFormValues {
  bankCode: string;
  bankName: string;
  /** null hasta que la persona lo elige: no se da por hecho que es persona natural. */
  userType: 0 | 1 | null;
  docType: string;
  docNumber: string;
}

export type PseFormErrors = Partial<Record<'bank' | 'userType' | 'docType' | 'docNumber', string>>;

const PERSON_TYPES: { code: 0 | 1; label: string }[] = [
  { code: 0, label: 'Persona natural' },
  { code: 1, label: 'Empresa' },
];

const DOC_TYPES: { code: string; label: string }[] = [
  { code: 'CC', label: 'Cédula de ciudadanía' },
  { code: 'CE', label: 'Cédula de extranjería' },
  { code: 'NIT', label: 'NIT' },
  { code: 'PP', label: 'Pasaporte' },
];

export function validatePseForm(values: PseFormValues): PseFormErrors {
  const errors: PseFormErrors = {};
  // Wompi pone en la lista una fila "A continuación seleccione su banco"
  // con código 0; elegirla no es elegir un banco.
  if (!values.bankCode || values.bankCode === '0') errors.bank = 'Elige tu banco';
  if (values.userType === null) errors.userType = 'Elige el tipo de persona';
  if (!values.docType) errors.docType = 'Elige el tipo de documento';
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
  // Uno abierto a la vez: dos listas desplegadas empujan el número de
  // documento fuera de la hoja.
  const [open, setOpen] = useState<'person' | 'doc' | null>(null);
  const toggle = (which: 'person' | 'doc') => setOpen((now) => (now === which ? null : which));
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
          <BankLogo name={values.bankName} />
          <Text v="strongS" style={styles.flex} numberOfLines={1}>{values.bankName}</Text>
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
                  style={styles.bankRow}
                >
                  <BankLogo name={bank.name} />
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

      {/* Mientras se busca el banco, la hoja es solo la lista: los datos del
          titular aparecen cuando ya hay banco, y se van si lo cambia. */}
      {values.bankCode ? (
        <>
          <Text v="label" tone="textMuted" style={styles.gapTop}>Titular de la cuenta</Text>
          {/* Desplegables y no chips: arrancar sin elegir obliga a fijarse en vez
              de dejar "Persona natural" o "Cédula" puestos por defecto. */}
          <Dropdown
            placeholder="Selecciona tipo de persona"
            a11yName="Tipo de persona"
            options={PERSON_TYPES}
            value={values.userType}
            open={open === 'person'}
            onToggle={() => toggle('person')}
            onSelect={(code) => { set({ userType: code }); setOpen(null); }}
            error={errors.userType}
          />
          <Dropdown
            placeholder="Selecciona tipo de documento"
            a11yName="Tipo de documento"
            options={DOC_TYPES}
            value={values.docType || null}
            open={open === 'doc'}
            onToggle={() => toggle('doc')}
            onSelect={(code) => { set({ docType: code }); setOpen(null); }}
            error={errors.docType}
          />

          <Input
            label="Número de documento"
            numeric
            value={values.docNumber}
            onChangeText={(text) => set({ docNumber: text.replace(/[^A-Za-z0-9]/g, '') })}
            keyboardType={values.docType === 'PP' ? 'default' : 'number-pad'}
            maxLength={20}
            error={errors.docNumber}
          />
        </>
      ) : null}
    </View>
  );
}

interface DropdownProps<T extends string | number> {
  placeholder: string;
  /** Qué se está eligiendo, para el lector de pantalla. */
  a11yName: string;
  options: { code: T; label: string }[];
  value: T | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (code: T) => void;
  error?: string;
}

/** Campo con flecha que despliega sus opciones debajo, en el mismo flujo. */
function Dropdown<T extends string | number>({
  placeholder, a11yName, options, value, open, onToggle, onSelect, error,
}: DropdownProps<T>) {
  const { c } = useTheme();
  const label = options.find((option) => option.code === value)?.label;

  return (
    <>
      <Pressable
        onPress={() => { tap('light'); onToggle(); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label ? `${a11yName}: ${label}. Toca para cambiarlo` : placeholder}
        style={[
          styles.bank,
          { backgroundColor: c.surface, borderColor: error ? c.error : open ? c.primary : c.border },
        ]}
      >
        <Text v="bodyM" tone={label ? 'text' : 'textMuted'} style={styles.flex} numberOfLines={1}>
          {label ?? placeholder}
        </Text>
        <Icon name={open ? 'plegar' : 'desplegar'} size="md" color={c.textMuted} />
      </Pressable>
      {open ? (
        <View style={[styles.dropdown, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityRole="radiogroup">
          {options.map((option, index) => {
            const active = option.code === value;
            return (
              <Pressable
                key={String(option.code)}
                onPress={() => { tap('select'); onSelect(option.code); }}
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
        </View>
      ) : null}
      {error ? <Text v="caption" tone="errorText">{error}</Text> : null}
    </>
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
  bankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 48,
  },
  dropdown: { borderWidth: 1, borderRadius: BorderRadius.md, overflow: 'hidden' },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, minHeight: 48,
  },
  flex: { flex: 1 },
  gapTop: { marginTop: Spacing.sm },
});
