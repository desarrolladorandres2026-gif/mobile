import { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { Text, Button, Sheet, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { useDriverProfile, useAssignDriver } from '../../hooks/useApi';
import { socketService, type OrderOffer } from '../../services/socket';
import { ordersApi, type DeclineReason } from '../../services/endpoints';
import { subscribeToOffers } from '../../lib/offerInbox';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * La oferta de un pedido, con su reloj.
 *
 * El reparto automático ya no espera a que el domiciliario mire la lista:
 * le ofrece el pedido durante una ventana en la que es solo suyo. Esta
 * hoja es el otro extremo de ese cable — sin ella, el servidor reserva un
 * pedido que su destinatario no puede ver ni aceptar.
 *
 * Vive en el layout y no en la pantalla de pedidos porque una oferta llega
 * cuando llega: el domiciliario puede estar mirando sus ganancias o su
 * perfil, y perder el turno por no estar en la pestaña correcta sería
 * perder dinero por un detalle de navegación.
 */
export function OfferSheet() {
  const { c } = useTheme();
  const router = useRouter();
  const { data: driverProfile } = useDriverProfile();
  const assignDriver = useAssignDriver();

  const [offer, setOffer] = useState<OrderOffer | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [working, setWorking] = useState(false);
  /** El pedido que se acaba de soltar, mientras se pregunta por qué. */
  const [asking, setAsking] = useState<string | null>(null);

  const progress = useSharedValue(1);

  const dismiss = useCallback(() => {
    setOffer(null);
    setWorking(false);
  }, []);

  useEffect(() => {
    const handleOffer = (incoming: OrderOffer) => {
      const remaining = Math.max(
        0,
        Math.round((new Date(incoming.expiresAt).getTime() - Date.now()) / 1000)
      );

      // Una oferta que llega ya vencida —el teléfono estuvo sin cobertura y
      // el socket entregó tarde— no se muestra: enseñar un contador en cero
      // solo invita a pulsar un botón que va a fallar.
      if (remaining <= 0) return;

      tap('medium');
      setOffer(incoming);
      setSecondsLeft(remaining);

      progress.value = 1;
      progress.value = withTiming(0, {
        duration: remaining * 1000,
        easing: Easing.linear,
      });
    };

    socketService.onOrderOffer(handleOffer);

    /**
     * El otro camino de entrada: la notificación.
     *
     * El socket solo entrega si la app estaba viva y conectada. Con el
     * teléfono bloqueado en el bolsillo —que es donde está mientras se
     * conduce, y por tanto cuando más ofertas llegan— la push es lo único
     * que llega, y trae la oferta entera para poder levantar esta hoja sin
     * preguntarle nada al servidor. Ver `lib/offerInbox.ts`.
     */
    const unsubscribe = subscribeToOffers(handleOffer);

    return () => {
      socketService.offOrderOffer(handleOffer);
      unsubscribe();
    };
  }, [progress]);

  // Cuenta atrás visible. La barra se anima aparte, en el hilo de UI, para
  // que siga corriendo suave aunque el hilo de JS esté ocupado.
  useEffect(() => {
    if (!offer) return;

    const timer = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.round((new Date(offer.expiresAt).getTime() - Date.now()) / 1000)
      );
      setSecondsLeft(remaining);
      if (remaining <= 0) dismiss();
    }, 1000);

    return () => clearInterval(timer);
  }, [offer, dismiss]);

  const handleAccept = useCallback(() => {
    if (!offer || !driverProfile?._id) return;
    tap('medium');
    setWorking(true);

    assignDriver.mutate(
      { orderId: offer.orderId, driverId: driverProfile._id },
      {
        onSuccess: () => {
          tap('success');
          dismiss();
          router.push(`/(driver)/order/${offer.orderId}`);
        },
        onError: (err: any) => {
          setWorking(false);
          // El 409 no es un fallo del domiciliario: alguien se adelantó, o
          // la ventana venció mientras pulsaba. Se cierra sin drama.
          const status = err?.response?.status;
          if (status === 409) {
            dismiss();
            Alert.alert('Se adelantaron', 'Otro domiciliario tomó este pedido.');
            return;
          }
          Alert.alert(
            'No pudimos asignarte',
            err?.response?.data?.message ?? 'Inténtalo de nuevo.'
          );
        },
      }
    );
  }, [offer, driverProfile, assignDriver, dismiss, router]);

  /**
   * Suelta el pedido ya, y luego pregunta por qué.
   *
   * Este orden es todo. El pedido se libera en el acto —hay un cliente
   * esperando y una cocina con la comida hecha— y la pregunta ocurre
   * después, sobre un pedido que ya está circulando. Preguntar primero
   * costaría segundos de la ventana de otro domiciliario, y el motivo no
   * vale ni de lejos eso.
   */
  const handleDecline = useCallback(() => {
    if (!offer) return;
    tap('light');
    const orderId = offer.orderId;

    dismiss();
    setAsking(orderId);

    void ordersApi.declineOffer(orderId).catch(() => {
      // Sin rechazo explícito la oferta vence sola en unos segundos.
    });
  }, [offer, dismiss]);

  /**
   * El motivo, si lo da.
   *
   * Va al mismo endpoint que el rechazo, con el motivo en el cuerpo. Al
   * llegar, el pedido ya no tiene a este domiciliario entre sus
   * candidatos, así que el servidor no vuelve a rechazar nada: solo anota
   * el motivo sobre el rechazo que ya existe (`annotateDecline`). Es puro
   * añadido de información, y si falla no pasa nada que le importe a quien
   * va conduciendo.
   */
  const sendReason = useCallback((reason: DeclineReason | null) => {
    const orderId = asking;
    setAsking(null);
    if (!orderId || !reason) return;
    tap('light');
    void ordersApi.declineOffer(orderId, reason).catch(() => {});
  }, [asking]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  /**
   * El paso del motivo.
   *
   * Vive aquí y no en un modal aparte porque solo aparece justo después de
   * rechazar, y es lo único que hay en pantalla en ese instante. Sin
   * botón de "cancelar": cerrar la hoja ya es no contestar, y añadir una
   * tercera forma de decir lo mismo solo hace la decisión más lenta.
   */
  if (asking) {
    return (
      <Sheet
        visible
        onClose={() => sendReason(null)}
        title="¿Por qué no?"
        height={0.42}
        scroll={false}
      >
        <View style={styles.reasons}>
          <Text v="bodyS" tone="textSecondary" center>
            Ya soltamos el pedido. Esto es solo para mejorar el reparto — puedes
            saltártelo.
          </Text>

          {REASONS.map(([value, label]) => (
            <Button
              key={value}
              title={label}
              variant="secondary"
              full
              onPress={() => sendReason(value)}
            />
          ))}

          <Button title="Prefiero no decirlo" variant="ghost" full onPress={() => sendReason(null)} />
        </View>
      </Sheet>
    );
  }

  if (!offer) return null;

  const minutes = Math.floor(offer.etaSeconds / 60);
  const urgent = secondsLeft <= 10;

  return (
    <Sheet
      visible
      onClose={handleDecline}
      title="Pedido para ti"
      height={0.52}
      scroll={false}
      footer={
        <View style={styles.actions}>
          <Button
            title="No puedo"
            variant="secondary"
            onPress={handleDecline}
            style={styles.action}
          />
          <Button
            title={working ? 'Aceptando…' : 'Aceptar'}
            onPress={handleAccept}
            style={styles.action}
          />
        </View>
      }
    >
      <View style={styles.body}>
        {/* El reloj es lo primero: es la única información que caduca. */}
        <View style={[styles.track, { backgroundColor: c.surface }]}>
          <Animated.View
            style={[
              styles.bar,
              barStyle,
              { backgroundColor: urgent ? c.error : c.primary },
            ]}
          />
        </View>

        <Text v="dataXL" center color={urgent ? c.error : c.text}>
          {secondsLeft}s
        </Text>

        <View style={styles.detail}>
          <Text v="titleL" center>{offer.businessName ?? 'Recoger pedido'}</Text>
          <Text v="bodyS" tone="textSecondary" center>
            Pedido {offer.orderNumber}
          </Text>
        </View>

        <View style={[styles.eta, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Icon name="reloj" size="sm" color={c.textSecondary} />
          <Text v="bodyS" tone="textSecondary">
            {minutes < 1 ? 'Menos de un minuto' : `A unos ${minutes} min`} del negocio
          </Text>
        </View>

        {offer.round > 1 ? (
          // Saber que no es exclusiva cambia la decisión: en la primera
          // ronda puede pensárselo, en las siguientes hay más gente mirando.
          <Text v="caption" tone="textMuted" center>
            Otros domiciliarios también lo están viendo
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

/**
 * Los tres motivos que de verdad separan problemas distintos.
 *
 * "Muy lejos" señala al reparto; "no me compensa" señala a la tarifa; "ya
 * voy con otro" no señala a nada que haya que arreglar. Más opciones que
 * estas harían la lista imposible de leer con el casco puesto, y ninguna
 * de las que faltan cambiaría una decisión de operaciones.
 */
const REASONS: Array<[DeclineReason, string]> = [
  ['too_far', 'Está muy lejos'],
  ['busy', 'Ya voy con otro pedido'],
  ['low_pay', 'No me compensa lo que paga'],
  ['other', 'Otro motivo'],
];

const styles = StyleSheet.create({
  body: { gap: Spacing.lg, paddingTop: Spacing.sm },
  track: { height: 6, borderRadius: BorderRadius.sm, overflow: 'hidden' },
  bar: { height: '100%', borderRadius: BorderRadius.sm },
  detail: { gap: Spacing.xs },
  eta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  actions: { flexDirection: 'row', gap: Spacing.md },
  reasons: { gap: Spacing.sm, paddingTop: Spacing.md },
  action: { flex: 1 },
});
