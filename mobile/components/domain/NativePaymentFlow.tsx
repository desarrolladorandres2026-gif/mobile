import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, StyleSheet, BackHandler, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import Animated, {
  FadeIn, FadeInDown, useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing,
} from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import { Text, Icon, Button, Screen, Header, EmptyState, SuccessCheck, OtpInput, ConfirmDialog } from '../ui';
import { TrazoLoader } from '../brand/Trazo';
import { PaymentMethodSheet } from './PaymentMethodSheet';
import { PaymentWebView } from './PaymentWebView';
import {
  useCheckoutConfig,
  usePayNative,
  usePaymentMethods,
  usePaymentStatus,
  useResendOtp,
  useValidateOtp,
  useAbandonPayment,
  type NativePaymentResult,
  type OtpAttempts,
} from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { socketService, type PaymentUpdate } from '../../services/socket';
import { usePendingPaymentStore } from '../../stores/pendingPaymentStore';
import {
  isExpiredSelection,
  isReusable,
  payNativeBody,
  type SelectedInstrument,
} from '../../lib/paymentInstrument';
import { orderCode, money } from '../../lib/format';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { NequiLogo, NEQUI } from '../brand/NequiLogo';
import { SecurePaymentMark } from './SecurePaymentMark';
import { declinedMessage } from '../../lib/paymentCopy';

/**
 * El cobro dentro de la app, de principio a fin.
 *
 * Esta pantalla es la única que cobra: el checkout (o el mandado) crea el
 * pedido y la manda aquí con el método elegido en memoria. Así un solo
 * sitio sabe esperar a Nequi, abrir el banco de PSE o el reto 3D Secure en
 * un WebView propio, y ofrecer otro método cuando el primero falla.
 *
 * Igual que con el Web Checkout, el resultado nunca se deduce de lo que
 * pase en pantalla. Lo decide el backend, que lo confirma con Wompi; aquí
 * llega por socket (`payment:updated`) y, de respaldo, consultando.
 */

type Phase =
  | 'preparing' // esperando la configuración de la pasarela
  | 'choose' // no hay método: la hoja está abierta
  | 'charging' // creando la transacción
  | 'handoff' // Bancolombia listo: se explica qué va a pasar antes de abrirlo
  | 'challenge' // banco o 3D Secure, en el WebView
  | 'otp' // DaviPlata: la persona escribe el código que le llegó por SMS
  | 'waiting' // la pasarela resuelve
  | 'approved'
  | 'declined'
  | 'pending' // tarda más de lo normal; se avisa por push
  | 'error';

/** Pasado esto, la espera se da por "pendiente" y se deja ir a la persona. */
const LONG_WAIT_MS = 5 * 60_000;

/** Largo del código de DaviPlata. Los de prueba de Wompi también son de seis. */
const OTP_LENGTH = 6;

/** Cuánto esperar antes de ofrecer otro SMS: menos, y el primero aún viene en camino. */
const OTP_RESEND_COOLDOWN_S = 30;

interface Props {
  orderId?: string;
  code?: string;
}

export function NativePaymentFlow({ orderId, code }: Props) {
  const router = useRouter();
  const { c } = useTheme();
  const queryClient = useQueryClient();
  const { data: methods } = usePaymentMethods();
  const config = useCheckoutConfig(!!orderId);
  const payNative = usePayNative();
  const takePending = usePendingPaymentStore((s) => s.take);

  const [phase, setPhase] = useState<Phase>('preparing');
  const [selected, setSelected] = useState<SelectedInstrument | null>(null);
  const [attempt, setAttempt] = useState<NativePaymentResult | null>(null);
  const [web, setWeb] = useState<{ uri: string } | { html: string } | null>(null);
  const [message, setMessage] = useState('');
  /**
   * Si el "no" lo dio el banco (la transacción se resolvió rechazada) y no
   * el servidor al crearla. Solo lo primero merece "Tu banco no aprobó el
   * pago": un celular mal escrito no es culpa del banco.
   */
  const [bankDeclined, setBankDeclined] = useState(false);
  const [sheet, setSheet] = useState(false);
  /** La dirección de Bancolombia, guardada mientras la persona lee qué va a pasar. */
  const [bankUrl, setBankUrl] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<string | undefined>();
  const [otpAttempts, setOtpAttempts] = useState<OtpAttempts | undefined>();
  const [otpCooldown, setOtpCooldown] = useState(0);
  const resendOtp = useResendOtp();
  const validateOtp = useValidateOtp();
  const abandonPayment = useAbandonPayment();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [waitStart, setWaitStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);

  // Los manejadores del socket viven fuera del ciclo de render: leen el
  // intento vigente de aquí, no de un cierre viejo.
  const attemptRef = useRef<NativePaymentResult | null>(null);
  attemptRef.current = attempt;
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  /**
   * El carril del intento vigente. `settle` corre en el mismo tick en que
   * se eligió el método, antes de que `selected` llegue al estado.
   */
  const kindRef = useRef<SelectedInstrument['instrument']['kind'] | null>(null);
  /**
   * El último reto 3DS que se abrió. Wompi lo sigue publicando mientras
   * esté pendiente, y sin esto cada consulta lo volvería a abrir encima de
   * quien acaba de cerrarlo.
   */
  const shownChallenge = useRef<string | null>(null);
  /** La última URL de banco (PSE) que se abrió; mismo motivo que `shownChallenge`. */
  const shownAsyncUrl = useRef<string | null>(null);
  const reference = code || orderCode(orderId ?? '');
  const capabilities = {
    pse: !!methods?.inApp?.pse,
    savedCards: !!methods?.inApp?.savedCards,
    bancolombiaTransfer: !!methods?.inApp?.bancolombiaTransfer,
    daviplata: !!methods?.inApp?.daviplata,
  };

  const watching =
    phase === 'waiting' || phase === 'challenge' || phase === 'pending' ||
    phase === 'handoff' || phase === 'otp';
  const { data: status } = usePaymentStatus(attempt?.transactionId, watching);

  const startWaiting = () => {
    setWaitStart(Date.now());
    setElapsed(0);
    setPhase('waiting');
  };

  /** Lleva la pantalla al estado que corresponde a lo que dijo la pasarela. */
  const settle = (next: string, reason?: string, result?: NativePaymentResult) => {
    if (next === 'approved') {
      tap('success');
      setWeb(null);
      setPhase('approved');
      return;
    }
    if (next === 'declined' || next === 'voided' || next === 'error') {
      tap('error');
      setWeb(null);
      setMessage(reason ?? '');
      setBankDeclined(next === 'declined');
      setPhase('declined');
      return;
    }
    if (result?.threeDsChallengeHtml) {
      shownChallenge.current = result.threeDsChallengeHtml;
      setWeb({ html: result.threeDsChallengeHtml });
      setPhase('challenge');
      return;
    }
    if (result?.otpRequired) {
      openOtp();
      return;
    }
    if (result?.asyncPaymentUrl) {
      openBank(result.asyncPaymentUrl);
      return;
    }
    startWaiting();
  };

  /**
   * Abre la página del banco. Bancolombia pasa antes por una pantalla que
   * dice qué va a pasar y cuánto se paga: la persona sale a otra marca, a
   * escribir claves, y tiene que saber a qué va y cómo vuelve. PSE ya lo
   * sabe desde la hoja, donde eligió su banco a mano.
   */
  const openBank = (url: string) => {
    shownAsyncUrl.current = url;
    if (kindRef.current === 'bancolombia_transfer') {
      setBankUrl(url);
      setPhase('handoff');
      return;
    }
    setWeb({ uri: url });
    setPhase('challenge');
  };

  const openOtp = () => {
    setOtp('');
    setOtpError(undefined);
    setOtpCooldown(OTP_RESEND_COOLDOWN_S);
    setPhase('otp');
  };

  const submitOtp = async () => {
    const transactionId = attemptRef.current?.transactionId;
    if (!transactionId) return;
    // El botón no se apaga: con el código incompleto, dice qué falta.
    if (otp.length !== OTP_LENGTH) {
      tap('error');
      setOtpError(`Escribe los ${OTP_LENGTH} dígitos del código`);
      return;
    }
    setOtpError(undefined);
    try {
      const result = await validateOtp.mutateAsync({ transactionId, code: otp });
      setOtpAttempts(result.attempts);
      if (result.status === 'approved') return settle('approved');
      if (result.status === 'declined' || result.status === 'voided' || result.status === 'error') {
        return settle('declined', result.declineReason);
      }
      if (result.accepted) {
        // DaviPlata aceptó el código; la aprobación final llega sola.
        startWaiting();
        return;
      }
      tap('error');
      setOtp('');
      const left = result.attempts
        ? result.attempts.maxValidations - result.attempts.validated
        : undefined;
      setOtpError(
        left === 1 ? 'Código incorrecto. Te queda un intento.'
        : left && left > 1 ? `Código incorrecto. Te quedan ${left} intentos.`
        : 'Código incorrecto. Revisa el mensaje y vuelve a escribirlo.'
      );
    } catch (error) {
      tap('error');
      const errorCode = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (errorCode === 'OTP_REJECTED' || errorCode === 'PAYMENT_NOT_PENDING') {
        // Ya no hay código que valga: el desenlace lo dice la pasarela, y la
        // espera lo recoge por socket o consultando.
        setMessage(apiMessage(error, 'DaviPlata ya no acepta códigos para este pago.'));
        setPhase('pending');
        return;
      }
      setOtpError(apiMessage(error, 'No pudimos verificar el código. Intenta de nuevo.'));
    }
  };

  /**
   * Cancelar la transacción a medias. Wompi no deja anular un cobro
   * pendiente, así que el servidor le pregunta primero: si ya entró, se
   * muestra aprobado; si no, se suelta el intento y se elige otro método.
   */
  const cancelTransaction = async () => {
    setConfirmCancel(false);
    const transactionId = attemptRef.current?.transactionId;
    if (!transactionId) return;
    setCancelError(null);
    try {
      const result = await abandonPayment.mutateAsync(transactionId);
      if (result.status === 'approved') {
        settle('approved');
        return;
      }
      // Abandonado, o ya había terminado sin aprobarse: en los dos casos
      // no hay cobro vivo y toca elegir cómo pagar.
      tap('light');
      setWeb(null);
      setAttempt(null);
      setBankUrl(null);
      shownChallenge.current = null;
      shownAsyncUrl.current = null;
      setMessage('');
      setPhase('choose');
      setSheet(true);
    } catch (error) {
      tap('error');
      setCancelError(apiMessage(error, 'No pudimos cancelar la transacción. Intenta de nuevo.'));
    }
  };

  const requestNewOtp = async () => {
    const transactionId = attemptRef.current?.transactionId;
    if (!transactionId) return;
    tap('light');
    try {
      const result = await resendOtp.mutateAsync(transactionId);
      setOtpAttempts(result.attempts);
      setOtp('');
      setOtpError(undefined);
      setOtpCooldown(OTP_RESEND_COOLDOWN_S);
    } catch (error) {
      tap('error');
      setOtpError(apiMessage(error, 'No pudimos reenviar el código.'));
    }
  };

  const charge = async (instrument: SelectedInstrument) => {
    if (!orderId) return;
    if (!config.data) {
      setMessage('No pudimos preparar el pago. Intenta de nuevo en un momento.');
      setPhase('error');
      return;
    }
    setSelected(instrument);
    kindRef.current = instrument.instrument.kind;
    setMessage('');
    setAttempt(null);
    setBankUrl(null);
    setOtpAttempts(undefined);
    setPhase('charging');

    try {
      const result = await payNative.mutateAsync({
        orderId,
        body: payNativeBody(instrument, config.data),
      });
      setAttempt(result);
      settle(result.status, result.declineReason, result);
    } catch (error) {
      const errorCode = (error as { response?: { data?: { code?: string }; status?: number } })?.response
        ?.data?.code;
      const httpStatus = (error as { response?: { status?: number } })?.response?.status;

      if (errorCode === 'PAYMENT_ALREADY_PAID') {
        settle('approved');
        return;
      }
      if (errorCode === 'PAYMENT_IN_PROGRESS') {
        // Hay un cobro anterior vivo en la pasarela (un Nequi sin aprobar,
        // un PSE a medias). No se abre otro: se espera a ese, y el socket
        // avisa cuando se resuelva.
        setMessage(apiMessage(error, 'Ya hay un cobro en curso para este pedido.'));
        setPhase('pending');
        return;
      }
      tap('error');
      setMessage(apiMessage(error, 'No pudimos procesar el pago.'));
      // Un "no" de verdad —la pasarela lo rechazó (502) o el pedido no
      // pasó una regla (4xx)— se presenta como rechazo y ofrece otro
      // método. Demasiados intentos (429), un fallo nuestro (5xx) o no
      // tener respuesta no son un rechazo del banco: son un error, y
      // decir "no se pudo cobrar" haría pensar que la tarjeta falló.
      const declined =
        httpStatus === 502 || (!!httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429);
      setBankDeclined(false);
      setPhase(declined ? 'declined' : 'error');
    }
  };

  // ── Arranque: el método que dejó el checkout, o preguntarlo ──
  useEffect(() => {
    if (started.current || !orderId || !config.data) return;
    started.current = true;
    const pending = takePending(orderId);
    if (pending && !isExpiredSelection(pending)) {
      charge(pending);
    } else {
      // Mandados, reintentos desde "Mis pedidos" o una app que Android
      // cerró por el camino: no hay método en memoria y se pide aquí.
      setPhase('choose');
      setSheet(true);
    }
    // `charge` y `takePending` son estables a efectos de este arranque único.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, config.data]);

  useEffect(() => {
    if (config.isError && phaseRef.current === 'preparing') {
      setMessage('No pudimos preparar el pago dentro de la app.');
      setPhase('error');
    }
  }, [config.isError]);

  // ── Respaldo: consultar ──
  // También es por aquí por donde llega el reto 3D Secure: Wompi no lo
  // incluye al crear la transacción, lo publica unos segundos después.
  useEffect(() => {
    if (!status || !watching) return;
    if (status.status === 'approved') settle('approved');
    else if (status.status === 'declined') settle('declined', status.declineReason);
    else if (status.threeDsChallengeHtml && status.threeDsChallengeHtml !== shownChallenge.current) {
      shownChallenge.current = status.threeDsChallengeHtml;
      setWeb({ html: status.threeDsChallengeHtml });
      setPhase('challenge');
    } else if (status.asyncPaymentUrl && status.asyncPaymentUrl !== shownAsyncUrl.current) {
      // PSE y Bancolombia tampoco traen la URL del banco al crear la
      // transacción: Wompi la resuelve segundos después. Sin esta rama, la
      // pantalla se quedaba en "esperando" hasta el timeout de 5 minutos sin
      // abrir nunca el banco.
      openBank(status.asyncPaymentUrl);
    } else if (status.otpRequired && phaseRef.current === 'waiting' && kindRef.current === 'daviplata') {
      // Igual con DaviPlata: el servicio de código puede publicarse tarde.
      openOtp();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status, status?.threeDsChallengeHtml, status?.asyncPaymentUrl, status?.otpRequired]);

  // ── Aviso principal: el socket ──
  useEffect(() => {
    if (!orderId) return;
    const onUpdate = (update: PaymentUpdate) => {
      if (update.orderId !== orderId) return;
      queryClient.invalidateQueries({ queryKey: ['payments', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });

      const live = phaseRef.current;
      if (live === 'approved') return;

      // Cualquier aprobado de este pedido es verdad: el pedido quedó pagado.
      if (update.status === 'approved') {
        settle('approved');
        return;
      }
      // Un rechazo solo cuenta si es del intento vigente: el de un intento
      // anterior ya retirado no puede tumbar el que está en curso.
      const current = attemptRef.current;
      if (update.status === 'declined' && (!current || current.reference === update.reference)) {
        if (
          live === 'waiting' || live === 'challenge' || live === 'pending' ||
          live === 'handoff' || live === 'otp'
        ) {
          settle('declined', update.declineReason);
        }
      }
    };
    socketService.onPaymentUpdated(onUpdate);
    return () => socketService.offPaymentUpdated(onUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // ── Cuenta atrás para pedir otro código ──
  useEffect(() => {
    if (phase !== 'otp' || otpCooldown <= 0) return;
    const id = setTimeout(() => setOtpCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, otpCooldown]);

  // ── Reloj de la espera ──
  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = setInterval(() => setElapsed(Date.now() - waitStart), 1000);
    return () => clearInterval(id);
  }, [phase, waitStart]);

  useEffect(() => {
    if (phase === 'waiting' && elapsed > LONG_WAIT_MS) setPhase('pending');
  }, [phase, elapsed]);

  // Atrás bloqueado mientras hay dinero en vuelo; libre en lo demás.
  useEffect(() => {
    const busy = phase === 'charging' || phase === 'challenge' || phase === 'waiting' || phase === 'otp';
    const sub = BackHandler.addEventListener('hardwareBackPress', () => busy);
    return () => sub.remove();
  }, [phase]);

  const goOrders = () => router.replace('/(client)/orders');
  const retry = () => {
    tap('light');
    if (selected && isReusable(selected)) charge(selected);
    else setSheet(true);
  };

  const sheetEl = (
    <PaymentMethodSheet
      visible={sheet}
      onClose={() => setSheet(false)}
      capabilities={capabilities}
      onSelect={(next) => { setSheet(false); charge(next); }}
    />
  );

  // ── Vistas ──

  if (!orderId) {
    return (
      <Screen>
        <Header title="Pago" fallback="/(client)/(tabs)/home" />
        <EmptyState
          icon="pedidos"
          title="No encontramos el pedido"
          message="Revisa el estado de tu pago en Mis pedidos."
          actionLabel="Ver mis pedidos"
          onAction={goOrders}
        />
      </Screen>
    );
  }

  if (phase === 'approved') {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Animated.View entering={FadeIn.duration(300)}>
            <SuccessCheck size={96} delay={120} />
          </Animated.View>
          <Animated.View entering={FadeInDown.delay(320).duration(420)} style={styles.copy}>
            <Text v="displayL" center>¡Pago aprobado!</Text>
            <Text v="bodyL" tone="text" center>
              Ya confirmamos tu pedido {reference} con el negocio.
            </Text>
          </Animated.View>
        </View>
        <View style={styles.actions}>
          <Button
            title="Continuar"
            icon="checkCirculo"
            size="lg"
            full
            haptic="medium"
            onPress={() =>
              router.replace({ pathname: '/(client)/order-confirmed', params: { id: orderId, code: reference } })
            }
          />
        </View>
      </Screen>
    );
  }

  if (phase === 'declined' || phase === 'error') {
    const declined = phase === 'declined';
    return (
      <Screen>
        <Header title={declined ? 'Pago no aprobado' : 'Algo falló'} fallback="/(client)/(tabs)/home" />
        <View style={styles.state}>
          <View style={[styles.stateIcon, { backgroundColor: c.errorSoft }]}>
            <Icon name={declined ? 'tarjeta' : 'sinConexion'} size={28} color={c.errorText} />
          </View>
          <Text v="titleL" center>
            {!declined ? 'No pudimos procesar el pago'
              : bankDeclined ? 'Tu banco no aprobó el pago'
              : 'No se pudo cobrar'}
          </Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            {declined
              ? declinedMessage(message, 'Puedes intentarlo con otro método.')
              : message || 'Revisa tu conexión e inténtalo de nuevo.'}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title="Pagar con otro método" icon="tarjeta" size="lg" full onPress={() => { tap('light'); setSheet(true); }} />
          {selected && isReusable(selected) ? (
            <Button title={`Reintentar con ${selected.label}`} variant="secondary" full onPress={retry} />
          ) : null}
          <Button title="Ver mis pedidos" variant="ghost" full onPress={goOrders} />
        </View>
        {sheetEl}
      </Screen>
    );
  }

  if (phase === 'choose') {
    return (
      <Screen>
        <Header title="Pagar pedido" fallback="/(client)/(tabs)/home" />
        <View style={styles.state}>
          <View style={[styles.stateIcon, { backgroundColor: c.primarySoft }]}>
            <Icon name="billetera" size={28} color={c.primaryText} />
          </View>
          <Text v="titleL" center>Elige cómo pagar</Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            Tu pedido {reference} está listo; falta el pago para enviarlo al negocio.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title="Elegir método de pago" icon="tarjeta" size="lg" full onPress={() => { tap('light'); setSheet(true); }} />
          <Button title="Ver mis pedidos" variant="ghost" full onPress={goOrders} />
        </View>
        {sheetEl}
      </Screen>
    );
  }

  if (phase === 'pending') {
    return (
      <Screen>
        <Header title="Pago pendiente" fallback="/(client)/(tabs)/home" />
        <View style={styles.state}>
          <View style={[styles.stateIcon, { backgroundColor: c.warningSoft }]}>
            <Icon name="reloj" size={28} color={c.warningText} />
          </View>
          <Text v="titleL" center>Tu pago está en proceso</Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            {message ||
              `Tu banco aún no confirma el pago del pedido ${reference}. Te avisamos apenas lo haga; si cerraste sin pagar, el intento se cancela solo en unos minutos.`}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title="Ver mis pedidos" variant="secondary" full onPress={goOrders} />
        </View>
      </Screen>
    );
  }

  if (phase === 'handoff' && bankUrl) {
    // Bancolombia: antes de mandar a la persona a otra marca, decirle cuánto
    // paga, adónde va y cómo vuelve. Sin cajas: logo, cifra y texto.
    return (
      <Screen edges={['top', 'bottom']}>
        <Header title="Pagar con Bancolombia" fallback="/(client)/(tabs)/home" />
        <View style={styles.handoff}>
          <Image
            source={require('../../assets/banks/bancolombia.png')}
            style={styles.bancolombiaHero}
            contentFit="contain"
            accessibilityLabel="Bancolombia"
          />
          <View style={styles.amountBlock}>
            <Text v="label" tone="textMuted">Vas a pagar</Text>
            <Text v="dataXL">{attempt?.amount ? money(attempt.amount) : '—'}</Text>
            <Text v="caption" tone="textMuted">Pedido {reference}</Text>
          </View>
          <View style={[styles.rule, { backgroundColor: c.border }]} />
          <View style={styles.handoffSteps}>
            <Text v="bodyM" tone="text">
              Abrimos Bancolombia aquí mismo, dentro de Zipp. Entras con tu usuario de la Sucursal
              Virtual y autorizas con la clave dinámica de tu app Bancolombia.
            </Text>
            <Text v="bodyS" tone="textMuted">
              Al terminar vuelves solo a Zipp y verás el resultado. Si cierras antes de autorizar, no se
              cobra nada.
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Button
            title="Continuar con Bancolombia"
            iconRight="siguiente"
            size="lg"
            full
            haptic="medium"
            onPress={() => { setWeb({ uri: bankUrl }); setPhase('challenge'); }}
          />
          <Button title="Ver mis pedidos" variant="ghost" full onPress={goOrders} />
        </View>
      </Screen>
    );
  }

  if (phase === 'otp') {
    const left = otpAttempts ? otpAttempts.maxSends - otpAttempts.sent : undefined;
    return (
      <Screen edges={['top', 'bottom']}>
        <Header title="Código de DaviPlata" fallback="/(client)/(tabs)/home" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.otpBody} keyboardShouldPersistTaps="handled">
            <Image
              source={require('../../assets/banks/daviplata.png')}
              style={styles.daviplataHero}
              contentFit="contain"
              accessibilityLabel="DaviPlata"
            />
            <View style={styles.amountBlock}>
              <Text v="label" tone="textMuted">Vas a pagar</Text>
              <Text v="dataXL">{attempt?.amount ? money(attempt.amount) : '—'}</Text>
            </View>
            <Text v="bodyM" tone="text" center style={styles.stateMessage}>
              Escribe el código que te llegó por mensaje de texto al celular que tienes registrado en
              DaviPlata.
            </Text>
            <OtpInput
              value={otp}
              onChange={(next) => { setOtp(next); setOtpError(undefined); }}
              length={OTP_LENGTH}
              error={!!otpError}
              autoFocus
            />
            {otpError ? <Text v="bodyS" tone="errorText" center>{otpError}</Text> : null}
            {otpCooldown > 0 ? (
              <Text v="caption" tone="textMuted" center>
                ¿No te llegó? Puedes pedir otro en {otpCooldown} s
              </Text>
            ) : left === 0 ? (
              <Text v="caption" tone="textMuted" center>
                Ya pediste todos los códigos que permite DaviPlata para este pago.
              </Text>
            ) : (
              <Button
                title="Reenviar código"
                variant="ghost"
                icon="reintentar"
                loading={resendOtp.isPending}
                onPress={requestNewOtp}
              />
            )}
          </ScrollView>
          <View style={styles.actions}>
            <Button
              title="Confirmar pago"
              icon="candado"
              size="lg"
              full
              haptic="medium"
              loading={validateOtp.isPending}
              onPress={submitOtp}
            />
            <Button title="Ver mis pedidos" variant="ghost" full onPress={goOrders} />
          </View>
        </KeyboardAvoidingView>
      </Screen>
    );
  }

  // 'preparing' | 'charging' | 'waiting' | 'challenge' (el WebView va encima)
  const kind = selected?.instrument.kind;
  const seconds = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const amount = attempt?.amount ? money(attempt.amount) : null;

  const title =
    phase === 'preparing' ? 'Preparando el pago…'
    : phase === 'charging' && kind === 'bancolombia_transfer' ? 'Estamos preparando tu pago'
    : phase === 'charging' ? 'Procesando tu pago…'
    : kind === 'nequi' ? 'Aprueba el pago en Nequi'
    : kind === 'pse' ? 'Confirmando con tu banco…'
    : 'Verificando tu pago…';

  const body =
    phase === 'waiting' && kind === 'nequi'
      ? `Nequi te mandó una notificación para aprobar ${amount ? amount : 'el pago'}. Abre tu app, entra con tu clave y apruébala en la campana de notificaciones. Aquí verás el resultado sin hacer nada más.`
      : phase === 'waiting' && kind === 'daviplata'
        ? 'DaviPlata recibió tu código. Estamos esperando la confirmación final.'
        : phase === 'waiting' && kind === 'bancolombia_transfer'
          ? 'Estamos esperando que Bancolombia confirme la transferencia.'
          : 'No cierres la aplicación. Esto solo toma un momento.';

  /** Lo que le pasa a quien no ve llegar la notificación de Nequi. */
  const nequiHelp =
    'Si la notificación no aparece, abre Nequi y revisa la campana. Si la rechazas o se vence, no se cobra nada y puedes pagar con otro método.';

  // Con Nequi, mientras se cobra y se espera, la pantalla se viste de
  // Nequi: quien va y vuelve de su app reconoce el mismo entorno.
  if (kind === 'nequi' && (phase === 'charging' || phase === 'waiting')) {
    return (
      <Screen edges={['top', 'bottom']} style={{ backgroundColor: NEQUI.plum }}>
        <StatusBar style="light" />
        <View style={styles.loading}>
          <NequiHalo>
            <NequiLogo height={34} onDark />
          </NequiHalo>
          <Text v="titleM" center color="#FFFFFF">{title}</Text>
          <Text v="bodyS" center color="rgba(255,255,255,0.78)" style={styles.stateMessage}>{body}</Text>
          {selected ? (
            <View style={[styles.chip, { backgroundColor: NEQUI.plumRaised }]}>
              <Icon name={selected.icon} size="sm" color={NEQUI.magenta} />
              <Text v="caption" color="#FFFFFF">{selected.label}</Text>
            </View>
          ) : null}
          {phase === 'waiting' ? (
            <Text v="dataM" color={NEQUI.magenta} accessibilityLabel={`Esperando hace ${seconds} segundos`}>
              {clock}
            </Text>
          ) : null}
          {phase === 'waiting' ? (
            <Text v="caption" center color="rgba(255,255,255,0.62)" style={styles.stateMessage}>
              {nequiHelp}
            </Text>
          ) : null}
        </View>

        <SecurePaymentMark onDark style={styles.secure} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.loading}>
        <TrazoLoader width={120} />
        <Text v="titleM" center>{title}</Text>
        <Text v="bodyS" tone="textMuted" center style={styles.stateMessage}>{body}</Text>
        {selected && phase !== 'preparing' ? (
          <View style={[styles.chip, { backgroundColor: c.surfaceLight }]}>
            <Icon name={selected.icon} size="sm" color={c.text} />
            <Text v="caption" tone="text">{selected.label}</Text>
          </View>
        ) : null}
        {phase === 'waiting' ? (
          <Text v="dataM" tone="textMuted" accessibilityLabel={`Esperando hace ${seconds} segundos`}>
            {clock}
          </Text>
        ) : null}
        {/* Quien cerró la verificación del banco sin terminarla necesita
            una forma de volver a ella: el reto sigue pendiente y no se
            reabre solo. */}
        {phase === 'waiting' && (status?.threeDsChallengeHtml || status?.asyncPaymentUrl) ? (
          <Button
            title="Volver a la verificación del banco"
            icon="seguridad"
            variant="secondary"
            onPress={() => {
              tap('light');
              if (status.threeDsChallengeHtml) setWeb({ html: status.threeDsChallengeHtml });
              else setWeb({ uri: status.asyncPaymentUrl });
              setPhase('challenge');
            }}
          />
        ) : null}
        {/* Y una salida: quien no quiere seguir con el banco no debería
            tener que esperar a que el cobro caduque solo. */}
        {phase === 'waiting' && (status?.threeDsChallengeHtml || status?.asyncPaymentUrl) ? (
          <Button
            title="Cancelar transacción"
            icon="cerrar"
            variant="ghost"
            loading={abandonPayment.isPending}
            onPress={() => { tap('light'); setCancelError(null); setConfirmCancel(true); }}
          />
        ) : null}
        {cancelError && phase === 'waiting' ? (
          <Text v="bodyS" tone="errorText" center style={styles.stateMessage}>{cancelError}</Text>
        ) : null}
      </View>

      <ConfirmDialog
        visible={confirmCancel}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={cancelTransaction}
        title="¿Cancelar esta transacción?"
        message="Si todavía no autorizaste el pago en tu banco, no se cobra nada y puedes pagar con otro método. Si ya lo autorizaste, mejor espera: a veces tarda unos minutos en confirmarse."
        confirmText="Sí, cancelar"
        cancelText="Seguir esperando"
        icon="cerrar"
        tone="danger"
      />

      {/* Quien espera con dinero en juego mira aquí de quién es el cobro. */}
      <SecurePaymentMark style={styles.secure} />

      <PaymentWebView
        visible={phase === 'challenge' && !!web}
        source={web}
        title={
          kind === 'pse' ? 'Tu banco'
          : kind === 'bancolombia_transfer' ? 'Bancolombia'
          : 'Verificación de tu banco'
        }
        returnUrl={config.data?.returnUrl}
        onReturned={() => { setWeb(null); startWaiting(); }}
        onClosed={() => { setWeb(null); startWaiting(); }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.xxl,
  },
  copy: { gap: Spacing.md, alignItems: 'center' },
  actions: { padding: Spacing.xl, paddingBottom: Spacing.xxl, gap: Spacing.md },
  loading: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg,
    paddingHorizontal: Spacing.xxl,
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.sm,
  },
  stateIcon: {
    width: 76, height: 76, borderRadius: BorderRadius.xl,
    alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm,
  },
  stateMessage: { maxWidth: 320 },
  flex: { flex: 1 },
  handoff: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.xxl,
  },
  amountBlock: { gap: Spacing.xs, alignItems: 'center' },
  handoffSteps: { gap: Spacing.md },
  rule: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  otpBody: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.xl,
    gap: Spacing.lg,
  },
  bancolombiaHero: { width: 36 * 4.258, height: 36, alignSelf: 'center' },
  daviplataHero: { width: 48 * 1.214, height: 48 },
  nequiHalo: {
    width: 188, height: 188, alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  nequiRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 94, borderWidth: 2, borderColor: NEQUI.magenta,
  },
  nequiCore: {
    width: 150, height: 150, borderRadius: 75,
    backgroundColor: NEQUI.plumRaised, alignItems: 'center', justifyContent: 'center',
  },
  secure: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.xs, paddingVertical: Spacing.xl,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
  },
});

/**
 * El logo sobre un círculo ciruela con un anillo magenta que late: dice
 * "estamos esperando a Nequi" sin un spinner genérico.
 */
function NequiHalo({ children }: { children: ReactNode }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }), -1, false);
  }, [pulse]);
  const ring = useAnimatedStyle(() => ({
    opacity: 0.9 * (1 - pulse.value),
    transform: [{ scale: 0.8 + pulse.value * 0.25 }],
  }));
  return (
    <View style={styles.nequiHalo}>
      <Animated.View style={[styles.nequiRing, ring]} />
      <View style={styles.nequiCore}>{children}</View>
    </View>
  );
}
