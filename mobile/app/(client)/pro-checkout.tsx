import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, BackHandler } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import {
  Text, Icon, Button, Screen, Header, SuccessCheck, Notice, ConfirmDialog,
} from '../../components/ui';
import { TrazoLoader } from '../../components/brand/Trazo';
import { PaymentMethodSheet } from '../../components/domain/PaymentMethodSheet';
import { PaymentWebView } from '../../components/domain/PaymentWebView';
import { SecurePaymentMark } from '../../components/domain/SecurePaymentMark';
import { declinedMessage } from '../../lib/paymentCopy';
import {
  useCheckoutConfig,
  usePaymentMethods,
  usePaymentStatus,
  useProStatus,
  useSubscribePro,
  useAbandonPayment,
  type NativePaymentResult,
} from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { socketService, type PaymentUpdate } from '../../services/socket';
import { payNativeBody, isReusable, type SelectedInstrument } from '../../lib/paymentInstrument';
import { money } from '../../lib/format';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { BorderRadius, Spacing } from '../../theme/tokens';

/**
 * El cobro de Zipp Pro.
 *
 * Pariente de `NativePaymentFlow` —la pantalla que cobra los pedidos— y
 * deliberadamente **no** el mismo componente. Aquella sabe esperar a Nequi,
 * abrir el banco de PSE y ofrecer otro método sobre un pedido que ya existe
 * y que caduca; aquí no hay pedido, solo hay tarjeta, y la mitad de sus
 * estados no significan nada. Meter las dos cosas en un componente con un
 * `if` por medio deja la pantalla que cobra pedidos al cuidado de cada
 * cambio que pida la membresía, que es lo último que conviene tocar.
 *
 * Lo que sí es idéntico es de quién se fía: el resultado no se deduce de lo
 * que pase en pantalla. Lo dice el backend, que lo confirma con Wompi; aquí
 * llega por socket y, de respaldo, consultando.
 */

type Phase =
  | 'preparing' // esperando la configuración de la pasarela
  | 'choose' // la hoja está abierta
  | 'charging' // creando la transacción
  | 'challenge' // 3D Secure, en el WebView
  | 'waiting' // la pasarela resuelve
  | 'approved'
  | 'declined'
  | 'pending' // tarda más de lo normal
  | 'error';

/** Pasado esto, la espera se da por "pendiente" y se deja ir a la persona. */
const LONG_WAIT_MS = 5 * 60_000;

export default function ProCheckoutScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const queryClient = useQueryClient();

  const { data: methods } = usePaymentMethods();
  const config = useCheckoutConfig();
  const { data: status } = useProStatus();
  const subscribe = useSubscribePro();

  const [phase, setPhase] = useState<Phase>('preparing');
  const [selected, setSelected] = useState<SelectedInstrument | null>(null);
  const [attempt, setAttempt] = useState<NativePaymentResult | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  /** El "no" lo dio el banco, no el servidor al crear el cobro. Ver NativePaymentFlow. */
  const [bankDeclined, setBankDeclined] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [waitStart, setWaitStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const abandonPayment = useAbandonPayment();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const attemptRef = useRef<NativePaymentResult | null>(null);
  attemptRef.current = attempt;
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const shownChallenge = useRef<string | null>(null);

  const price = status?.plan.price;
  const watching = phase === 'waiting' || phase === 'challenge' || phase === 'pending';
  const { data: remote } = usePaymentStatus(attempt?.transactionId, watching);

  // Sin tarjetas guardadas no hay renovación posible, así que tampoco hay
  // suscripción que vender. Se dice antes de pedir una tarjeta, no después
  // de cobrarla.
  const canSubscribe = !!methods?.inApp?.native && !!methods?.inApp?.savedCards;

  const startWaiting = () => {
    setWaitStart(Date.now());
    setElapsed(0);
    setPhase('waiting');
  };

  /**
   * Cancelar el cobro a medias. El servidor le pregunta a Wompi antes de
   * soltar nada: si ya entró, la membresía queda activa; si no, se vuelve a
   * elegir tarjeta sin activarla.
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
      tap('light');
      setChallenge(null);
      setAttempt(null);
      shownChallenge.current = null;
      setMessage('');
      setPhase('choose');
      setSheet(true);
    } catch (error) {
      tap('error');
      setCancelError(apiMessage(error, 'No pudimos cancelar la transacción. Intenta de nuevo.'));
    }
  };

  const settle = (next: string, reason?: string, result?: NativePaymentResult) => {
    if (next === 'approved') {
      tap('success');
      setChallenge(null);
      // La membresía la enciende el backend; aquí solo se deja de creer en
      // la copia vieja del estado.
      queryClient.invalidateQueries({ queryKey: ['pro'] });
      queryClient.invalidateQueries({ queryKey: ['orders', 'quote'] });
      setPhase('approved');
      return;
    }
    if (next === 'declined' || next === 'voided' || next === 'error') {
      tap('error');
      setChallenge(null);
      setMessage(reason ?? '');
      setBankDeclined(next === 'declined');
      setPhase('declined');
      return;
    }
    if (result?.threeDsChallengeHtml) {
      shownChallenge.current = result.threeDsChallengeHtml;
      setChallenge(result.threeDsChallengeHtml);
      setPhase('challenge');
      return;
    }
    startWaiting();
  };

  const charge = async (instrument: SelectedInstrument) => {
    if (!config.data) {
      setMessage('No pudimos preparar el pago. Intenta de nuevo en un momento.');
      setPhase('error');
      return;
    }
    setSelected(instrument);
    setMessage('');
    setAttempt(null);
    setPhase('charging');

    try {
      const result = await subscribe.mutateAsync(payNativeBody(instrument, config.data));
      setAttempt(result);
      settle(result.status, result.declineReason, result);
    } catch (error) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      const httpStatus = (error as { response?: { status?: number } })?.response?.status;

      if (code === 'PRO_ALREADY_ACTIVE' || code === 'PAYMENT_ALREADY_PAID') {
        queryClient.invalidateQueries({ queryKey: ['pro'] });
        settle('approved');
        return;
      }
      if (code === 'PAYMENT_IN_PROGRESS') {
        setMessage(apiMessage(error, 'Ya hay un cobro de tu membresía en curso.'));
        setPhase('pending');
        return;
      }

      tap('error');
      setMessage(apiMessage(error, 'No pudimos procesar el pago.'));
      // Mismo criterio que en el cobro de un pedido: un "no" del banco
      // (502) o una regla incumplida (4xx) se presentan como rechazo; un
      // 429 o un fallo nuestro, como error — decir "no se pudo cobrar"
      // haría pensar que la tarjeta falló.
      const declined =
        httpStatus === 502 || (!!httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429);
      setBankDeclined(false);
      setPhase(declined ? 'declined' : 'error');
    }
  };

  // ── Arranque: se pide el método en cuanto la pasarela está lista ──
  useEffect(() => {
    if (phase !== 'preparing') return;
    if (config.isError) {
      setMessage('No pudimos preparar el pago dentro de la app.');
      setPhase('error');
      return;
    }
    if (config.data && methods) {
      if (!canSubscribe) {
        setMessage(
          'Ahora mismo no podemos cobrar la membresía dentro de la app. Inténtalo de nuevo más tarde.'
        );
        setPhase('error');
        return;
      }
      setPhase('choose');
      setSheet(true);
    }
  }, [config.data, config.isError, methods, canSubscribe, phase]);

  // ── Respaldo: consultar ──
  useEffect(() => {
    if (!remote || !watching) return;
    if (remote.status === 'approved') settle('approved');
    else if (remote.status === 'declined') settle('declined', remote.declineReason);
    else if (remote.threeDsChallengeHtml && remote.threeDsChallengeHtml !== shownChallenge.current) {
      shownChallenge.current = remote.threeDsChallengeHtml;
      setChallenge(remote.threeDsChallengeHtml);
      setPhase('challenge');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.status, remote?.threeDsChallengeHtml]);

  // ── Aviso principal: el socket ──
  useEffect(() => {
    const onUpdate = (update: PaymentUpdate) => {
      // El aviso de la membresía llega sin pedido. Uno con pedido es de
      // otra pantalla y aquí no significa nada.
      if (update.orderId) return;
      const current = attemptRef.current;
      if (current && update.reference && update.reference !== current.reference) return;

      const live = phaseRef.current;
      if (live === 'approved') return;

      if (update.status === 'approved') {
        settle('approved');
        return;
      }
      if (update.status === 'declined' && (live === 'waiting' || live === 'challenge' || live === 'pending')) {
        settle('declined', update.declineReason);
      }
    };
    socketService.onPaymentUpdated(onUpdate);
    return () => socketService.offPaymentUpdated(onUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reloj de la espera ──
  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = setInterval(() => setElapsed(Date.now() - waitStart), 1000);
    return () => clearInterval(id);
  }, [phase, waitStart]);

  useEffect(() => {
    if (phase === 'waiting' && elapsed > LONG_WAIT_MS) setPhase('pending');
  }, [phase, elapsed]);

  // Atrás bloqueado mientras hay dinero en vuelo.
  useEffect(() => {
    const busy = phase === 'charging' || phase === 'challenge' || phase === 'waiting';
    const sub = BackHandler.addEventListener('hardwareBackPress', () => busy);
    return () => sub.remove();
  }, [phase]);

  const goPro = () => router.replace('/(client)/(tabs)/pro');

  const sheetEl = (
    <PaymentMethodSheet
      visible={sheet}
      onClose={() => setSheet(false)}
      capabilities={{ pse: false, savedCards: !!methods?.inApp?.savedCards }}
      recurring
      onSelect={(next) => { setSheet(false); charge(next); }}
    />
  );

  if (phase === 'approved') {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Animated.View entering={FadeIn.duration(300)}>
            <SuccessCheck size={96} delay={120} />
          </Animated.View>
          <Animated.View entering={FadeInDown.delay(320).duration(420)} style={styles.copy}>
            <Text v="displayL" center>¡Ya eres Pro!</Text>
            <Text v="bodyL" tone="text" center>
              Desde tu próximo pedido verás el ahorro aplicado solo, sin códigos ni pasos extra.
            </Text>
          </Animated.View>
        </View>
        <View style={styles.actions}>
          <Button title="Ver mi membresía" icon="corona" size="lg" full haptic="medium" onPress={goPro} />
        </View>
      </Screen>
    );
  }

  if (phase === 'declined' || phase === 'error') {
    const declined = phase === 'declined';
    return (
      <Screen>
        <Header title={declined ? 'Pago no aprobado' : 'Algo falló'} fallback="/(client)/(tabs)/pro" />
        <View style={styles.state}>
          <View style={[styles.stateIcon, { backgroundColor: c.errorSoft }]}>
            <Icon name={declined ? 'tarjeta' : 'sinConexion'} size={28} color={c.errorText} />
          </View>
          <Text v="titleL" center>
            {!declined ? 'No pudimos procesar el pago'
              : bankDeclined ? 'Tu banco no aprobó el pago'
              : 'No se pudo cobrar tu membresía'}
          </Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            {declined
              ? declinedMessage(message, 'Puedes intentarlo con otra tarjeta.')
              : message || 'Revisa tu conexión e inténtalo de nuevo.'}
          </Text>
        </View>
        <View style={styles.actions}>
          {canSubscribe ? (
            <Button
              title="Probar con otra tarjeta"
              icon="tarjeta"
              size="lg"
              full
              onPress={() => { tap('light'); setSheet(true); }}
            />
          ) : null}
          {selected && isReusable(selected) ? (
            <Button
              title={`Reintentar con ${selected.label}`}
              variant="secondary"
              full
              onPress={() => { tap('light'); charge(selected); }}
            />
          ) : null}
          <Button title="Volver" variant="ghost" full onPress={goPro} />
        </View>
        {sheetEl}
      </Screen>
    );
  }

  if (phase === 'choose') {
    return (
      <Screen>
        <Header title="Hazte Pro" fallback="/(client)/(tabs)/pro" />
        <View style={styles.state}>
          <View style={[styles.stateIcon, { backgroundColor: c.primarySoft }]}>
            <Icon name="corona" size={28} color={c.primaryText} />
          </View>
          <Text v="titleL" center>
            {price ? `${money(price)} al mes` : 'Elige cómo pagar'}
          </Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            Se cobra hoy y se renueva solo cada mes con la misma tarjeta. Puedes cancelarlo cuando
            quieras desde tu membresía.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            title="Elegir tarjeta"
            icon="tarjeta"
            size="lg"
            full
            onPress={() => { tap('light'); setSheet(true); }}
          />
          <Button title="Ahora no" variant="ghost" full onPress={goPro} />
        </View>
        {sheetEl}
      </Screen>
    );
  }

  if (phase === 'pending') {
    return (
      <Screen>
        <Header title="Cobro en proceso" fallback="/(client)/(tabs)/pro" />
        <View style={styles.state}>
          <View style={[styles.stateIcon, { backgroundColor: c.warningSoft }]}>
            <Icon name="reloj" size={28} color={c.warningText} />
          </View>
          <Text v="titleL" center>Tu pago está en proceso</Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            {message ||
              'Tu banco aún no confirma el cobro. Te avisamos apenas lo haga; tu membresía se activa sola en cuanto entre.'}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title="Volver" variant="secondary" full onPress={goPro} />
        </View>
      </Screen>
    );
  }

  // 'preparing' | 'charging' | 'waiting' | 'challenge' (el WebView va encima)
  const seconds = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  const title =
    phase === 'preparing' ? 'Preparando el pago…'
    : phase === 'charging' ? 'Cobrando tu membresía…'
    : 'Validando con tu banco…';

  return (
    <Screen>
      <View style={styles.loading}>
        <TrazoLoader width={120} />
        <Text v="titleM" center>{title}</Text>
        <Text v="bodyS" tone="textMuted" center style={styles.stateMessage}>
          No cierres la aplicación. Esto solo toma un momento.
        </Text>
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
        {phase === 'waiting' && remote?.threeDsChallengeHtml ? (
          <Button
            title="Volver a la verificación del banco"
            icon="seguridad"
            variant="secondary"
            onPress={() => {
              tap('light');
              setChallenge(remote.threeDsChallengeHtml);
              setPhase('challenge');
            }}
          />
        ) : null}
        {phase === 'waiting' && remote?.threeDsChallengeHtml ? (
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
        {message ? <Notice tone="info">{message}</Notice> : null}
      </View>

      <ConfirmDialog
        visible={confirmCancel}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={cancelTransaction}
        title="¿Cancelar esta transacción?"
        message="Si todavía no autorizaste el pago en tu banco, no se cobra nada y tu membresía no se activa. Si ya lo autorizaste, mejor espera: a veces tarda unos minutos en confirmarse."
        confirmText="Sí, cancelar"
        cancelText="Seguir esperando"
        icon="cerrar"
        tone="danger"
      />

      <SecurePaymentMark style={styles.secure} />

      <PaymentWebView
        visible={phase === 'challenge' && !!challenge}
        source={challenge ? { html: challenge } : null}
        title="Verificación de tu banco"
        returnUrl={config.data?.returnUrl}
        onReturned={() => { setChallenge(null); startWaiting(); }}
        onClosed={() => { setChallenge(null); startWaiting(); }}
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
