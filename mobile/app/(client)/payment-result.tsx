import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, BackHandler } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import {
  Text, Icon, Button, Screen, Header, ErrorState, EmptyState, SuccessCheck,
} from '../../components/ui';
import { TrazoLoader } from '../../components/brand/Trazo';
import { NativePaymentFlow } from '../../components/domain/NativePaymentFlow';
import { usePaymentStatus, usePayOrder } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { orderCode } from '../../lib/format';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

type Phase = 'opening' | 'waiting' | 'approved' | 'declined' | 'pending' | 'error';

/**
 * La pantalla del pago en línea. Dos modos:
 *
 * - `mode=native`: el cobro dentro de la app (`NativePaymentFlow`). Es el
 *   camino normal cuando el backend lo ofrece.
 * - Sin `mode`: el Web Checkout de Wompi en el navegador, que se mantiene
 *   para cuando el proveedor activo solo sabe redirigir (el sandbox de
 *   desarrollo, por ejemplo).
 */
export default function PaymentResultScreen() {
  const { id, code, mode } = useLocalSearchParams<{ id?: string; code?: string; mode?: string }>();
  if (mode === 'native') return <NativePaymentFlow orderId={id} code={code} />;
  return <WebCheckoutResult />;
}

/**
 * "Wompi → Resultado" del flujo de pago.
 *
 * El navegador hospedado de Wompi (Web Checkout) decide qué pasó, pero
 * nunca se le cree directamente: al volver, se consulta el estado real al
 * backend — que a su vez lo confirma con Wompi por webhook o consulta
 * directa — y solo esa respuesta decide qué pantalla se muestra. El pedido
 * jamás se marca como pagado desde aquí.
 */
function WebCheckoutResult() {
  const router = useRouter();
  const { c } = useTheme();
  const { id, code, checkoutUrl, transactionId, redirectUrl } = useLocalSearchParams<{
    id: string; code?: string; checkoutUrl?: string; transactionId?: string; redirectUrl?: string;
  }>();

  const [phase, setPhase] = useState<Phase>('opening');
  const [openError, setOpenError] = useState('');
  const openedOnce = useRef(false);
  const payOrder = usePayOrder();

  const polling = phase === 'waiting' || phase === 'pending';
  const { data: status, error: statusError } = usePaymentStatus(transactionId, polling);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => phase !== 'error');
    return () => sub.remove();
  }, [phase]);

  const openCheckout = async (url: string) => {
    setOpenError('');
    setPhase('opening');
    try {
      // No se confía en el resultado del navegador (`type`): solo indica que
      // el usuario terminó de interactuar con la página de Wompi. El estado
      // real llega por el polling de abajo, respaldado por el webhook.
      await WebBrowser.openAuthSessionAsync(url, redirectUrl || undefined);
      setPhase('waiting');
    } catch {
      setOpenError('No pudimos abrir la pasarela de pago.');
      setPhase('error');
    }
  };

  useEffect(() => {
    if (openedOnce.current || !checkoutUrl) return;
    openedOnce.current = true;
    openCheckout(checkoutUrl);
  }, [checkoutUrl]);

  useEffect(() => {
    if (!status) return;
    if (status.status === 'approved') { tap('success'); setPhase('approved'); }
    else if (status.status === 'declined') { tap('error'); setPhase('declined'); }
    else if (status.status === 'pending') setPhase('pending');
  }, [status?.status]);

  const retry = async () => {
    tap('light');
    setPhase('opening');
    try {
      const intent = await payOrder.mutateAsync({ orderId: id, redirectUrl: redirectUrl || undefined });
      if (intent?.checkoutUrl) {
        router.setParams({ transactionId: intent.transactionId ?? '' });
        await openCheckout(intent.checkoutUrl);
      } else {
        setOpenError('No pudimos reintentar el cobro.');
        setPhase('error');
      }
    } catch (error) {
      setOpenError(apiMessage(error, 'No pudimos reintentar el cobro.'));
      setPhase('error');
    }
  };

  const reference = code || orderCode(id);

  // Android puede cerrar la app mientras la persona está en Wompi; al
  // volver por `zipp://payment-result` la pantalla llega sin parámetros y
  // no hay nada que abrir ni que consultar. Antes eso dejaba el cargador
  // girando para siempre.
  if (!checkoutUrl && !transactionId) {
    return (
      <Screen>
        <Header title="Tu pago" fallback="/(client)/(tabs)/home" />
        <EmptyState
          icon="pedidos"
          title="Revisa tu pedido"
          message="No pudimos recuperar este pago aquí. Su estado real está en Mis pedidos."
          actionLabel="Ver mis pedidos"
          onAction={() => router.replace('/(client)/orders')}
        />
      </Screen>
    );
  }

  if (phase === 'approved') {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.container}>
          <Animated.View entering={FadeIn.duration(300)}>
            <SuccessCheck size={96} delay={120} />
          </Animated.View>
          <Animated.View entering={FadeInDown.delay(320).duration(420)} style={styles.copy}>
            <Text v="displayL" center>¡Pago aprobado!</Text>
            <Text v="bodyL" tone="textSecondary" center>
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
              router.replace({ pathname: '/(client)/order-confirmed', params: { id, code: reference } })
            }
          />
        </View>
      </Screen>
    );
  }

  if (phase === 'declined') {
    return (
      <Screen>
        <Header title="Pago rechazado" fallback="/(client)/(tabs)/home" />
        <ErrorState
          title="Wompi rechazó el pago"
          message={status?.declineReason || 'No se realizó ningún cobro. Puedes intentarlo de nuevo con otro método.'}
          onRetry={retry}
        />
        <View style={styles.actions}>
          <Button
            title="Ver mis pedidos"
            variant="secondary"
            full
            onPress={() => router.replace('/(client)/orders')}
          />
        </View>
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen>
        <Header title="Algo falló" fallback="/(client)/(tabs)/home" />
        <ErrorState
          title="No pudimos procesar el pago"
          message={openError || apiMessage(statusError, 'Ocurrió un error inesperado.')}
          onRetry={retry}
        />
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
          <Text v="titleL" center>Tu pago está pendiente</Text>
          <Text v="bodyM" tone="textSecondary" center style={styles.stateMessage}>
            Algunos métodos, como PSE, tardan unos minutos en confirmarse. Te
            avisaremos apenas Wompi confirme el pago de tu pedido {reference}.
          </Text>
          <Button
            title="Ver mis pedidos"
            variant="secondary"
            style={styles.stateAction}
            onPress={() => router.replace('/(client)/orders')}
          />
        </View>
      </Screen>
    );
  }

  // 'opening' | 'waiting' — el navegador de Wompi está abierto o se acaba de cerrar.
  return (
    <Screen>
      <View style={styles.loading}>
        <TrazoLoader width={120} />
        <Text v="titleM" center>
          {phase === 'opening' ? 'Abriendo la pasarela de pago…' : 'Confirmando tu pago…'}
        </Text>
        <Text v="bodyS" tone="textMuted" center style={styles.stateMessage}>
          No cierres la aplicación. Esto solo toma un momento.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
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
  stateMessage: { maxWidth: 300 },
  stateAction: { marginTop: Spacing.lg },
});
