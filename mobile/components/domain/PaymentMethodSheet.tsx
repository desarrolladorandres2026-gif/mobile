import { useEffect, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text, Icon, Button, Sheet, Input, Notice, Skeleton } from '../ui';
import { PaymentConsent } from './PaymentConsent';
import { PaymentCardFields } from './PaymentCardFields';
import {
  PaymentPseFields,
  validatePseForm,
  type PseFormErrors,
  type PseFormValues,
} from './PaymentPseFields';
import { useTheme } from '../../hooks/useTheme';
import {
  useCheckoutConfig,
  useSavedCards,
  usePseBanks,
  useDeleteSavedCard,
  type SavedCardSummary,
} from '../../hooks/useApi';
import { useAuthStore } from '../../stores/authStore';
import { usePrefsStore } from '../../stores/prefsStore';
import {
  validateCardForm,
  parseExpiry,
  type CardFormErrors,
  type CardFormValues,
} from '../../lib/card';
import { tokenizeCard, CardTokenizationError } from '../../lib/wompi';
import {
  cardLabel,
  maskPhone,
  CARD_TOKEN_TTL_MS,
  type SelectedInstrument,
} from '../../lib/paymentInstrument';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';
import type { IconName } from '../../theme/icons';

/**
 * Elegir cómo pagar, sin salir de la app.
 *
 * Una sola hoja con pasos (lista → tarjeta / Nequi / PSE) y no una hoja por
 * método: un `Modal` encima de otro en React Native parpadea al abrir y se
 * lleva el teclado al cerrarse, justo en el formulario donde más se escribe.
 *
 * La hoja **no cobra**. Devuelve un `SelectedInstrument` y el cobro lo
 * dispara quien la abrió, después de crear el pedido. Una tarjeta nueva sí
 * se tokeniza aquí, contra Wompi y desde el teléfono: tokenizar no necesita
 * pedido, y así el botón "Confirmar" del checkout es un solo toque.
 */

type Step = 'list' | 'card' | 'nequi' | 'pse';

const TITLES: Record<Step, string> = {
  list: 'Cómo quieres pagar',
  card: 'Tarjeta de crédito o débito',
  nequi: 'Nequi',
  pse: 'PSE',
};

const EMPTY_CARD: CardFormValues = { number: '', expiry: '', cvc: '', holder: '' };
const EMPTY_PSE: PseFormValues = { bankCode: '', bankName: '', userType: 0, docType: 'CC', docNumber: '' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (selected: SelectedInstrument) => void;
  /** Lo que el backend deja ofrecer, de `GET /payments/methods`. */
  capabilities: { pse: boolean; savedCards: boolean };
}

export function PaymentMethodSheet({ visible, onClose, onSelect, capabilities }: Props) {
  const { c } = useTheme();
  const user = useAuthStore((s) => s.user);
  const acceptedTerms = usePrefsStore((s) => s.acceptedPaymentTerms);
  const setAcceptedTerms = usePrefsStore((s) => s.setAcceptedPaymentTerms);
  const savedEmail = usePrefsStore((s) => s.receiptEmail);
  const setSavedEmail = usePrefsStore((s) => s.setReceiptEmail);

  const config = useCheckoutConfig(visible);
  const cards = useSavedCards(visible && capabilities.savedCards);
  const deleteCard = useDeleteSavedCard();

  const [step, setStep] = useState<Step>('list');
  const banks = usePseBanks(visible && step === 'pse');

  const [pickedCardId, setPickedCardId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [card, setCard] = useState<CardFormValues>(EMPTY_CARD);
  const [cardErrors, setCardErrors] = useState<CardFormErrors>({});
  const [saveCard, setSaveCard] = useState(false);

  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | undefined>();

  const [pse, setPse] = useState<PseFormValues>(EMPTY_PSE);
  const [pseErrors, setPseErrors] = useState<PseFormErrors>({});

  const termsUrl = config.data?.permalinks.termsAndConditions;
  const [terms, setTerms] = useState(false);
  const [termsError, setTermsError] = useState<string | undefined>();

  // Sin correo en la cuenta (registro por teléfono) hay que pedirlo: Wompi
  // lo exige para mandar el comprobante.
  const needsEmail = !user?.email;
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();

  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Al abrir: los términos vienen marcados solo si esta persona ya aceptó
  // exactamente este documento; el teléfono y el correo, precargados.
  useEffect(() => {
    if (!visible) return;
    setTerms(Boolean(termsUrl) && acceptedTerms === termsUrl);
    setPhone((current) => current || (user?.phone ?? '').replace(/\D/g, '').slice(-10));
    setEmail((current) => current || savedEmail || '');
  }, [visible, termsUrl, acceptedTerms, user?.phone, savedEmail]);

  /**
   * Cierra y **olvida** lo escrito. El número y el código de la tarjeta no
   * tienen por qué seguir en memoria un segundo más de lo necesario.
   */
  const close = () => {
    setStep('list');
    setCard(EMPTY_CARD);
    setCardErrors({});
    setSaveCard(false);
    setPhoneError(undefined);
    setPse(EMPTY_PSE);
    setPseErrors({});
    setPickedCardId(null);
    setConfirmDeleteId(null);
    setTermsError(undefined);
    setEmailError(undefined);
    setSubmitError(null);
    setBusy(false);
    onClose();
  };

  /** Lo que todos los métodos piden: términos aceptados y un correo. */
  const commonReady = (): boolean => {
    let ok = true;
    if (!terms) {
      setTermsError('Acepta los términos para continuar');
      ok = false;
    }
    if (needsEmail && !EMAIL_RE.test(email.trim())) {
      setEmailError('Escribe un correo válido para el comprobante');
      ok = false;
    }
    if (!ok) tap('error');
    return ok;
  };

  const finish = (selected: Omit<SelectedInstrument, 'customerEmail'>) => {
    if (termsUrl) setAcceptedTerms(termsUrl);
    const customerEmail = needsEmail ? email.trim().toLowerCase() : undefined;
    if (customerEmail) setSavedEmail(customerEmail);
    tap('success');
    onSelect({ ...selected, customerEmail });
    close();
  };

  // ── Acciones por método ──

  const pickSavedCard = (saved: SavedCardSummary) => {
    if (!commonReady()) {
      setPickedCardId(saved.id);
      return;
    }
    finish({
      instrument: { kind: 'saved_card', savedCardId: saved.id, installments: 1 },
      label: cardLabel(saved.brand, saved.lastFour),
      detail: `Vence ${saved.expMonth}/${saved.expYear}`,
      icon: 'tarjeta',
    });
  };

  const submitCard = async () => {
    const errors = validateCardForm(card);
    setCardErrors(errors);
    const common = commonReady();
    if (Object.keys(errors).length || !common || !config.data) {
      if (Object.keys(errors).length) tap('error');
      return;
    }

    const expiry = parseExpiry(card.expiry)!;
    setBusy(true);
    setSubmitError(null);
    try {
      const token = await tokenizeCard(config.data.publicKey, {
        number: card.number,
        cvc: card.cvc,
        expMonth: expiry.month,
        expYear: expiry.year,
        holder: card.holder,
      });
      const display = {
        brand: token.brand,
        lastFour: token.lastFour,
        expMonth: token.expMonth,
        expYear: token.expYear,
      };
      finish({
        instrument: {
          kind: 'card_token',
          token: token.token,
          installments: 1,
          ...(saveCard ? { save: true, card: display } : {}),
        },
        label: cardLabel(token.brand, token.lastFour),
        detail: saveCard ? 'La guardaremos para tu próxima compra' : 'Tarjeta de crédito o débito',
        icon: 'tarjeta',
        expiresAt: Date.now() + CARD_TOKEN_TTL_MS,
      });
    } catch (error) {
      setBusy(false);
      tap('error');
      if (error instanceof CardTokenizationError && error.field) {
        setCardErrors({ [error.field === 'expiry' ? 'expiry' : error.field]: error.message });
      } else {
        setSubmitError(error instanceof Error ? error.message : 'No pudimos validar la tarjeta.');
      }
    }
  };

  const submitNequi = () => {
    const digits = phone.replace(/\D/g, '');
    const valid = /^3\d{9}$/.test(digits);
    setPhoneError(valid ? undefined : 'Escribe el celular de tu cuenta Nequi, 10 dígitos');
    const common = commonReady();
    if (!valid || !common) return;
    finish({
      instrument: { kind: 'nequi', phone: digits },
      label: `Nequi ${maskPhone(digits)}`,
      detail: 'Te llega una notificación para aprobar',
      icon: 'celular',
    });
  };

  const submitPse = () => {
    const errors = validatePseForm(pse);
    setPseErrors(errors);
    const common = commonReady();
    if (Object.keys(errors).length || !common) return;
    finish({
      instrument: {
        kind: 'pse',
        financialInstitutionCode: pse.bankCode,
        userType: pse.userType,
        userLegalIdType: pse.docType,
        userLegalId: pse.docNumber.trim(),
      },
      label: 'PSE',
      detail: pse.bankName,
      icon: 'edificio',
    });
  };

  const removeCard = async (id: string) => {
    try {
      await deleteCard.mutateAsync(id);
      tap('success');
      if (pickedCardId === id) setPickedCardId(null);
    } catch (error) {
      tap('error');
      setSubmitError(apiMessage(error, 'No pudimos eliminar la tarjeta.'));
    } finally {
      setConfirmDeleteId(null);
    }
  };

  // ── Pie: consentimiento + acción del paso ──

  const pickedCard = cards.data?.find((saved) => saved.id === pickedCardId);
  const action: { title: string; onPress: () => void } | null =
    step === 'card' ? { title: 'Usar esta tarjeta', onPress: submitCard }
    : step === 'nequi' ? { title: 'Usar Nequi', onPress: submitNequi }
    : step === 'pse' ? { title: 'Usar PSE', onPress: submitPse }
    : pickedCard ? { title: `Usar ${cardLabel(pickedCard.brand, pickedCard.lastFour)}`, onPress: () => pickSavedCard(pickedCard) }
    : null;

  const footer = action ? (
    <View style={styles.footer}>
      <PaymentConsent
        checked={terms}
        onToggle={(next) => { setTerms(next); setTermsError(undefined); }}
        lead="Acepto los"
        linkText="términos de Wompi para este pago"
        url={termsUrl}
        error={termsError}
      />
      <Button
        title={busy ? 'Validando tarjeta…' : action.title}
        full
        size="lg"
        loading={busy}
        onPress={action.onPress}
      />
    </View>
  ) : undefined;

  const emailField = needsEmail ? (
    <Input
      label="Correo para el comprobante"
      icon="correo"
      value={email}
      onChangeText={(text) => { setEmail(text); setEmailError(undefined); }}
      keyboardType="email-address"
      autoCapitalize="none"
      autoComplete="email"
      error={emailError}
      hint="Tu cuenta no tiene correo; Wompi te manda ahí el recibo"
    />
  ) : null;

  return (
    <Sheet visible={visible} onClose={close} title={TITLES[step]} height={0.86} footer={footer}>
      <View style={styles.body}>
        {step !== 'list' ? (
          <Pressable
            onPress={() => { tap('light'); setStep('list'); setSubmitError(null); }}
            accessibilityRole="button"
            accessibilityLabel="Volver a los métodos de pago"
            style={styles.back}
            hitSlop={8}
          >
            <Icon name="atras" size="sm" color={c.textSecondary} />
            <Text v="bodyS" tone="textSecondary">Otros métodos</Text>
          </Pressable>
        ) : null}

        {config.isError ? (
          <Notice tone="error">
            No pudimos preparar el pago dentro de la app. Cierra e inténtalo de nuevo en un momento.
          </Notice>
        ) : null}

        {step === 'list' ? renderList() : null}
        {step === 'card' ? (
          <>
            <PaymentCardFields values={card} errors={cardErrors} onChange={(next) => { setCard(next); setCardErrors({}); }} />
            {capabilities.savedCards ? (
              <PaymentConsent
                checked={saveCard}
                onToggle={setSaveCard}
                lead="Guardar para mi próxima compra. Autorizo el"
                linkText="tratamiento de mis datos"
                url={config.data?.permalinks.personalDataAuth}
              />
            ) : null}
            <View style={[styles.secure, { backgroundColor: c.surfaceLight }]}>
              <Icon name="candado" size="sm" color={c.textMuted} />
              <Text v="caption" tone="textMuted" style={styles.flex}>
                Tu tarjeta va cifrada directo a Wompi. Zipp nunca ve ni guarda el número ni el código.
              </Text>
            </View>
          </>
        ) : null}
        {step === 'nequi' ? (
          <>
            <Input
              label="Celular de tu cuenta Nequi"
              icon="celular"
              numeric
              value={phone}
              onChangeText={(text) => { setPhone(text.replace(/\D/g, '').slice(0, 10)); setPhoneError(undefined); }}
              keyboardType="number-pad"
              maxLength={10}
              autoComplete="tel"
              error={phoneError}
            />
            <Text v="bodyS" tone="textSecondary">
              Al confirmar el pedido te llega una notificación de Nequi. Ábrela y aprueba el pago; aquí
              verás el resultado sin salir de Zipp.
            </Text>
          </>
        ) : null}
        {step === 'pse' ? (
          <PaymentPseFields
            values={pse}
            errors={pseErrors}
            onChange={(next) => { setPse(next); setPseErrors({}); }}
            banks={banks.data}
            loading={banks.isLoading}
            loadError={banks.isError}
          />
        ) : null}

        {step !== 'list' || pickedCard ? emailField : null}
        {submitError ? <Notice tone="error">{submitError}</Notice> : null}
      </View>
    </Sheet>
  );

  // ── Paso 1: la lista ──

  function renderList() {
    const saved = cards.data ?? [];

    return (
      <>
        {capabilities.savedCards && cards.isLoading ? <Skeleton height={60} radius={BorderRadius.md} /> : null}

        {saved.length ? <Text v="label" tone="textMuted">Tus tarjetas</Text> : null}
        {saved.map((savedCard) => {
          const picked = pickedCardId === savedCard.id;
          const confirming = confirmDeleteId === savedCard.id;
          return (
            <View
              key={savedCard.id}
              style={[
                styles.row,
                {
                  backgroundColor: picked ? c.primarySoft : c.surface,
                  borderColor: picked ? c.primary : c.border,
                  borderWidth: picked ? 2 : 1,
                },
              ]}
            >
              <Pressable
                onPress={() => { tap('select'); setConfirmDeleteId(null); pickSavedCard(savedCard); }}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                accessibilityLabel={`${cardLabel(savedCard.brand, savedCard.lastFour)}, vence ${savedCard.expMonth}/${savedCard.expYear}`}
                style={styles.rowMain}
              >
                <Icon name="tarjeta" size="md" color={picked ? c.primaryText : c.textSecondary} />
                <View style={styles.flex}>
                  <Text v="strongS">{cardLabel(savedCard.brand, savedCard.lastFour)}</Text>
                  <Text v="caption" tone="textMuted">Vence {savedCard.expMonth}/{savedCard.expYear}</Text>
                </View>
              </Pressable>
              {confirming ? (
                <View style={styles.confirm}>
                  <Pressable onPress={() => setConfirmDeleteId(null)} hitSlop={8} accessibilityRole="button">
                    <Text v="caption" tone="textSecondary">No</Text>
                  </Pressable>
                  <Pressable onPress={() => removeCard(savedCard.id)} hitSlop={8} accessibilityRole="button">
                    <Text v="strongS" tone="errorText">Eliminar</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => { tap('light'); setConfirmDeleteId(savedCard.id); }}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Eliminar ${cardLabel(savedCard.brand, savedCard.lastFour)}`}
                  style={styles.trash}
                >
                  <Icon name="eliminar" size="sm" color={c.textMuted} />
                </Pressable>
              )}
            </View>
          );
        })}

        {saved.length ? <Text v="label" tone="textMuted" style={styles.gapTop}>Otro método</Text> : null}
        <MethodRow icon="tarjeta" title="Tarjeta de crédito o débito" subtitle="Visa, Mastercard, American Express" onPress={() => setStep('card')} />
        <MethodRow icon="celular" title="Nequi" subtitle="Apruebas desde tu app de Nequi" onPress={() => setStep('nequi')} />
        {capabilities.pse ? (
          <MethodRow icon="edificio" title="PSE" subtitle="Débito desde tu cuenta de ahorros o corriente" onPress={() => setStep('pse')} />
        ) : null}
      </>
    );
  }
}

function MethodRow({
  icon, title, subtitle, onPress,
}: { icon: IconName; title: string; subtitle: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      style={[styles.row, styles.rowMain, { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}
    >
      <Icon name={icon} size="md" color={c.textSecondary} />
      <View style={styles.flex}>
        <Text v="strongS">{title}</Text>
        <Text v="caption" tone="textMuted">{subtitle}</Text>
      </View>
      <Icon name="siguiente" size="sm" color={c.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.md, paddingBottom: Spacing.md },
  footer: { gap: Spacing.sm },
  flex: { flex: 1 },
  back: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, alignSelf: 'flex-start', minHeight: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: BorderRadius.md,
    minHeight: 60,
    paddingRight: Spacing.sm,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingLeft: Spacing.md,
  },
  trash: { padding: Spacing.sm },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.sm },
  secure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  gapTop: { marginTop: Spacing.sm },
});
