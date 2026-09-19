import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, StyleSheet, BackHandler } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import Animated, {
  FadeIn, FadeInDown, useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing,
} from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import { Text, Icon, Button, Screen, Header, EmptyState, SuccessCheck } from '../ui';
import { TrazoLoader } from '../brand/Trazo';
import { PaymentMethodSheet } from './PaymentMethodSheet';
import { PaymentWebView } from './PaymentWebView';
import {
  useCheckoutConfig,
  usePayNative,
  usePaymentMethods,
  usePaymentStatus,
  type NativePaymentResult,
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
import { WompiLogo } from '../brand/WompiLogo';

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
  | 'challenge' // banco o 3D Secure, en el WebView
  | 'waiting' // la pasarela resuelve
  | 'approved'
  | 'declined'
  | 'pending' // tarda más de lo normal; se avisa por push
  | 'error';

/** Pasado esto, la espera se da por "pendiente" y se deja ir a la persona. */
const LONG_WAIT_MS = 5 * 60_000;

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
  const [sheet, setSheet] = useState(false);
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
   * El último reto 3DS que se abrió. Wompi lo sigue publicando mientras
   * esté pendiente, y sin esto cada consulta lo volvería a abrir encima de
   * quien acaba de cerrarlo.
   */
  const shownChallenge = useRef<string | null>(null);
  const reference = code || orderCode(orderId ?? '');
  const capabilities = { pse: !!methods?.inApp?.pse, savedCards: !!methods?.inApp?.savedCards };

  const watching = phase === 'waiting' || phase === 'challenge' || phase === 'pending';
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
      setPhase('declined');
      return;
    }
    if (result?.threeDsChallengeHtml) {
      shownChallenge.current = result.threeDsChallengeHtml;
      setWeb({ html: result.threeDsChallengeHtml });
      setPhase('challenge');
      return;
    }
    if (result?.asyncPaymentUrl) {
      setWeb({ uri: result.asyncPaymentUrl });
      setPhase('challenge');
      return;
    }
    startWaiting();
  };

  const charge = async (instrument: SelectedInstrument) => {
    if (!orderId) return;
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status, status?.threeDsChallengeHtml]);

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
        if (live === 'waiting' || live === 'challenge' || live === 'pending') {
          settle('declined', update.declineReason);
        }
      }
    };
    socketService.onPaymentUpdated(onUpdate);
    return () => socketService.offPaymentUpdated(onUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

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
    const busy = phase === 'charging' || phase === 'challenge' || phase === 'waiting';
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
          <Text v="titleL" center>{declined ? 'No se pudo cobrar' : 'No pudimos procesar el pago'}</Text>
          <Text v="bodyM" tone="text" center style={styles.stateMessage}>
            {message || (declined
              ? 'No se hizo ningún cobro. Puedes intentarlo con otro método.'
              : 'Revisa tu conexión e inténtalo de nuevo.')}
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

  // 'preparing' | 'charging' | 'waiting' | 'challenge' (el WebView va encima)
  const kind = selected?.instrument.kind;
  const seconds = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const amount = attempt?.amount ? money(attempt.amount) : null;

  const title =
    phase === 'preparing' ? 'Preparando el pago…'
    : phase === 'charging' ? 'Procesando tu pago…'
    : kind === 'nequi' ? 'Abre tu app de Nequi'
    : kind === 'pse' ? 'Confirmando con tu banco…'
    : 'Validando con tu banco…';

  const body =
    phase === 'waiting' && kind === 'nequi'
      ? `Te enviamos una notificación para aprobar el pago${amount ? ` de ${amount}` : ''}. Apruébala y vuelve: aquí verás el resultado.`
      : 'No cierres la aplicación. Esto solo toma un momento.';

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
        </View>

        <View style={styles.secure} accessible accessibilityLabel="Pago protegido por Wompi">
          <Icon name="candado" size="sm" color="rgba(255,255,255,0.7)" />
          <Text v="caption" color="rgba(255,255,255,0.7)">Pago protegido por</Text>
          <WompiLogo height={14} color="#FFFFFF" />
        </View>
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
        {phase === 'waiting' && status?.threeDsChallengeHtml ? (
          <Button
            title="Volver a la verificación del banco"
            icon="seguridad"
            variant="secondary"
            onPress={() => {
              tap('light');
              setWeb({ html: status.threeDsChallengeHtml });
              setPhase('challenge');
            }}
          />
        ) : null}
      </View>

      {/* Quien espera con dinero en juego mira aquí de quién es el cobro. */}
      <View
        style={styles.secure}
        accessible
        accessibilityLabel="Pago protegido por Wompi"
      >
        <Icon name="candado" size="sm" color={c.textMuted} />
        <Text v="caption" tone="textMuted">Pago protegido por</Text>
        <WompiLogo height={14} color={c.text} />
      </View>

      <PaymentWebView
        visible={phase === 'challenge' && !!web}
        source={web}
        title={kind === 'pse' ? 'Tu banco' : 'Verificación de tu banco'}
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
