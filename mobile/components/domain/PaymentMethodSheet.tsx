import { useEffect, useState, type ReactNode } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text, Icon, Button, Sheet, Input, Notice, Skeleton } from '../ui';
import { PaymentConsent, PaymentTermsNotice } from './PaymentConsent';
import { WompiLogo } from '../brand/WompiLogo';
import { NequiLogo, NEQUI } from '../brand/NequiLogo';
import { CardBrandLogo } from '../brand/CardBrandLogo';
import { Image } from 'expo-image';
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

/** Azul del logotipo de PSE, para el icono de su fila. */
const PSE_BLUE = '#1F5FA8';

const EMPTY_CARD: CardFormValues = { number: '', expiry: '', cvc: '', holder: '' };
const EMPTY_PSE: PseFormValues = { bankCode: '', bankName: '', userType: null, docType: '', docNumber: '' };

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

  // Sin correo en la cuenta (registro por teléfono) hay que pedirlo: Wompi
  // lo exige para mandar el comprobante.
  const needsEmail = !user?.email;
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();

  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Al abrir: el teléfono y el correo, precargados.
  useEffect(() => {
    if (!visible) return;
    setPhone((current) => current || (user?.phone ?? '').replace(/\D/g, '').slice(-10));
    setEmail((current) => current || savedEmail || '');
  }, [visible, user?.phone, savedEmail]);

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
    setEmailError(undefined);
    setSubmitError(null);
    setBusy(false);
    onClose();
  };

  /** Lo que todos los métodos piden: un correo para el comprobante. */
  const commonReady = (): boolean => {
    if (needsEmail && !EMAIL_RE.test(email.trim())) {
      setEmailError('Escribe un correo válido para el comprobante');
      tap('error');
      return false;
    }
    return true;
  };

  const finish = (selected: Omit<SelectedInstrument, 'customerEmail'>) => {
    const customerEmail = needsEmail ? email.trim().toLowerCase() : undefined;
    if (customerEmail) setSavedEmail(customerEmail);
    tap('success');
    onSelect({ ...selected, customerEmail });
    close();
  };

  // ── Acciones por método ──

  /** El botón "Usar esta tarjeta": aquí sí se exige todo. */
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
    if (Object.keys(errors).length || !common || pse.userType === null) return;
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

  // ── Pie: aviso de términos + acción del paso ──

  const pickedCard = cards.data?.find((saved) => saved.id === pickedCardId);
  // En PSE, hasta elegir banco solo se ve la lista: ni correo, ni términos,
  // ni botón. Elegir el banco es el paso; lo demás llega después.
  const choosingBank = step === 'pse' && !pse.bankCode;
  const action: { title: string; onPress: () => void } | null =
    choosingBank ? null
    : step === 'card' ? { title: 'Usar esta tarjeta', onPress: submitCard }
    : step === 'nequi' ? { title: 'Usar Nequi', onPress: submitNequi }
    : step === 'pse' ? { title: 'Usar PSE', onPress: submitPse }
    : pickedCard ? { title: `Usar ${cardLabel(pickedCard.brand, pickedCard.lastFour)}`, onPress: () => pickSavedCard(pickedCard) }
    : null;

  const footer = action ? (
    <View style={styles.footer}>
      <PaymentTermsNotice url={config.data?.permalinks.termsAndConditions} />
      <Button
        title={busy ? 'Validando tarjeta…' : action.title}
        full
        size="lg"
        loading={busy}
        variant={step === 'nequi' ? 'nequi' : 'primary'}
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
    <Sheet visible={visible} onClose={close} title={TITLES[step]} height={0.86} footer={footer} fullScreen={step !== 'list'}>
      <View style={styles.body}>
        {step !== 'list' ? (
          <Pressable
            onPress={() => { tap('light'); setStep('list'); setSubmitError(null); }}
            accessibilityRole="button"
            accessibilityLabel="Volver a los métodos de pago"
            style={styles.back}
            hitSlop={8}
          >
            <Icon name="atras" size="sm" color={c.text} />
            <Text v="bodyS" tone="text">Otros métodos</Text>
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
            {/* La franja de Nequi: quien paga reconoce su app antes de
                escribir el número. */}
            <View style={[styles.nequiBand, { backgroundColor: NEQUI.plum }]}>
              <NequiLogo height={26} onDark />
              <View style={[styles.nequiPill, { backgroundColor: NEQUI.magenta }]}>
                <Icon name="celular" size="sm" color="#FFFFFF" />
                <Text v="caption" color="#FFFFFF">Apruebas en tu app</Text>
              </View>
            </View>
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
            <Text v="bodyS" tone="text">
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

        {(step !== 'list' && !choosingBank) || pickedCard ? emailField : null}
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
                onPress={() => {
                  tap('select');
                  setConfirmDeleteId(null);
                  // El segundo pedido es de un toque: si no falta correo,
                  // tocar la tarjeta basta. Si falta, solo se marca y el
                  // pie lo pide, sin regañar antes de que el campo se vea.
                  const ready = !needsEmail || EMAIL_RE.test(email.trim());
                  if (ready) pickSavedCard(savedCard);
                  else setPickedCardId(savedCard.id);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                accessibilityLabel={`${cardLabel(savedCard.brand, savedCard.lastFour)}, vence ${savedCard.expMonth}/${savedCard.expYear}`}
                style={styles.rowMain}
              >
                <Icon name="tarjeta" size="md" color={picked ? c.primaryText : c.text} />
                <View style={styles.flex}>
                  <Text v="strongS">{cardLabel(savedCard.brand, savedCard.lastFour)}</Text>
                  <Text v="caption" tone="textMuted">Vence {savedCard.expMonth}/{savedCard.expYear}</Text>
                </View>
              </Pressable>
              {confirming ? (
                <View style={styles.confirm}>
                  <Pressable onPress={() => setConfirmDeleteId(null)} hitSlop={8} accessibilityRole="button">
                    <Text v="caption" tone="text">No</Text>
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
        <MethodRow
          icon="tarjeta"
          title="Tarjeta de crédito o débito"
          subtitle="Crédito o débito"
          brand={
            <View style={styles.brandRow}>
              <CardBrandLogo brand="VISA" height={12} ink={c.text} />
              <CardBrandLogo brand="MASTERCARD" height={16} />
              <CardBrandLogo brand="AMEX" height={16} ink={c.text} />
            </View>
          }
          accent={c.primaryText}
          onPress={() => setStep('card')}
        />
        <MethodRow
          icon="celular"
          title="Nequi"
          subtitle="Apruebas desde tu app de Nequi"
          brand={<NequiLogo height={17} />}
          accent={NEQUI.magenta}
          onPress={() => setStep('nequi')}
        />
        {capabilities.pse ? (
          <MethodRow
            icon="edificio"
            title="PSE"
            subtitle="Débito desde tu cuenta de ahorros o corriente"
            brand={
              <Image
                source={require('../../assets/banks/pse.png')}
                style={styles.pseLogo}
                contentFit="contain"
                accessibilityLabel="PSE"
              />
            }
            accent={PSE_BLUE}
            onPress={() => setStep('pse')}
          />
        ) : null}

        <View
          style={[styles.protected, styles.gapTop]}
          accessible
          accessibilityLabel="Compra protegida con Wompi"
        >
          <Icon name="candado" size="sm" color={c.textMuted} />
          <Text v="caption" tone="textMuted">Compra protegida con</Text>
          <WompiLogo height={14} color={c.text} />
        </View>
      </>
    );
  }
}

function MethodRow({
  icon, title, subtitle, brand, accent, onPress,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  /** El logotipo del método, en lugar del título escrito. */
  brand?: ReactNode;
  /** Color de marca del método para el icono. */
  accent?: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      style={[styles.row, styles.rowMain, { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}
    >
      <Icon name={icon} size="md" color={accent ?? c.text} />
      <View style={styles.flex}>
        {brand ?? <Text v="strongS">{title}</Text>}
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
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pseLogo: { width: 30, height: 30 },
  nequiBand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
  },
  nequiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
  },
  protected: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
  },
});
