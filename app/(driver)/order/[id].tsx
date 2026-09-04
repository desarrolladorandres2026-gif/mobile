import { useEffect, useState } from 'react';
import {
  View, ScrollView, StyleSheet, Alert, Pressable, Linking,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Button, Card, Notice, OtpInput, Badge, StatusPill,
  Screen, Header, LoadingScreen, ErrorState, SuccessCheck,
} from '../../../components/ui';
import { OrderChatSheet } from '../../../components/domain/OrderChatSheet';
import { OrderCallSheet } from '../../../components/domain/OrderCallSheet';
import { DriverRouteCard } from '../../../components/domain/DriverRouteCard';
import { useDriverTrackingContext } from '../../../hooks/useDriverTracking';
import {
  useOrder, useOrderFlow, useOrderArrive, useUploadOrderEvidence,
  useVerifyOrderCode, useUpdateOrderStatus,
} from '../../../hooks/useApi';
import { useOrderRealtime, useOrderFlowRealtime } from '../../../hooks/useRealtime';
import { useTheme } from '../../../hooks/useTheme';
import { useBottomInset } from '../../../hooks/useBottomSpace';
import { captureEvidence } from '../../../lib/evidence';
import { captureCurrentPosition } from '../../../hooks/useLocation';
import { apiMessage } from '../../../lib/errors';
import { money, orderCode } from '../../../lib/format';
import { tap } from '../../../lib/haptics';
import { Spacing, BorderRadius } from '../../../theme/tokens';

const CODE_LENGTH = 6;

function openMap(address?: string, lat?: number, lng?: number) {
  tap('light');
  const query = lat && lng ? `${lat},${lng}` : encodeURIComponent(address ?? '');
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`).catch(() => {});
}

export default function DriverActiveOrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const bottomInset = useBottomInset();

  const { data: order, isLoading, isError, refetch } = useOrder(id);
  const { data: flow } = useOrderFlow(id);
  const { connected } = useOrderRealtime();
  const { incomingCall, clearIncomingCall } = useOrderFlowRealtime(id);

  const arrive = useOrderArrive();
  const uploadEvidence = useUploadOrderEvidence();
  const verifyCode = useVerifyOrderCode();
  const updateStatus = useUpdateOrderStatus();

  const [chatOpen, setChatOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callStartedByMe, setCallStartedByMe] = useState(false);
  const [pickupCode, setPickupCode] = useState('');
  const [pickupError, setPickupError] = useState('');
  const [deliveryCode, setDeliveryCode] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  const [justCompleted, setJustCompleted] = useState<'pickup' | 'delivery' | null>(null);
  const [uploadingStage, setUploadingStage] = useState<'pickup' | 'delivery' | null>(null);

  useEffect(() => {
    if (incomingCall) { setCallStartedByMe(false); setCallOpen(true); }
  }, [incomingCall]);

  /**
   * Avisa al seguimiento de que hay una entrega en curso.
   *
   * Es lo que sube la precisión del GPS: un repartidor esperando pedidos
   * solo tiene que estar localizable, pero con una entrega encima hay un
   * cliente mirando su punto en tiempo real. Se limpia al salir para que
   * el teléfono vuelva al muestreo económico en cuanto la pantalla se
   * cierra — si no, la precisión alta se quedaría encendida el resto del
   * turno.
   */
  const tracking = useDriverTrackingContext();

  useEffect(() => {
    if (!id) return;
    tracking.setActiveOrder(id);
    return () => tracking.setActiveOrder(null);
  }, [id]);

  if (isLoading) return <LoadingScreen message="Cargando el pedido…" />;

  if (isError || !order || !id) {
    return (
      <Screen>
        <Header title="Pedido" fallback="/(driver)/(tabs)/orders" />
        <ErrorState
          title="No encontramos este pedido"
          message="Puede que ya no esté asignado a ti."
          onRetry={refetch}
        />
      </Screen>
    );
  }

  const business = order.businessId as any;
  const client = order.clientId as any;
  const orderId = order._id;

  const takePhoto = async (stage: 'pickup' | 'delivery') => {
    try {
      const uri = await captureEvidence();
      if (!uri) return;
      setUploadingStage(stage);
      const coords = await captureCurrentPosition();
      await uploadEvidence.mutateAsync({
        orderId,
        stage,
        uri,
        coords: coords ? { latitude: coords.latitude, longitude: coords.longitude } : undefined,
      });
      tap('success');
    } catch (error) {
      tap('error');
      Alert.alert('No se pudo registrar la foto', apiMessage(error, 'Inténtalo de nuevo.'));
    } finally {
      setUploadingStage(null);
    }
  };

  const markArrived = async (stage: 'pickup' | 'delivery') => {
    tap('medium');
    try {
      const coords = await captureCurrentPosition();
      await arrive.mutateAsync({
        orderId,
        stage,
        coords: coords ? { latitude: coords.latitude, longitude: coords.longitude } : undefined,
      });
    } catch (error) {
      Alert.alert('No se pudo registrar la llegada', apiMessage(error, 'Inténtalo de nuevo.'));
    }
  };

  const submitCode = async (stage: 'pickup' | 'delivery', code: string) => {
    const setCode = stage === 'pickup' ? setPickupCode : setDeliveryCode;
    const setError = stage === 'pickup' ? setPickupError : setDeliveryError;
    setError('');
    try {
      const coords = await captureCurrentPosition();
      await verifyCode.mutateAsync({
        orderId,
        stage,
        code,
        coords: coords ? { latitude: coords.latitude, longitude: coords.longitude } : undefined,
      });
      tap('success');
      setJustCompleted(stage);
      setCode('');
      await refetch();
      setTimeout(() => setJustCompleted(null), 1400);
    } catch (error) {
      tap('error');
      setCode('');
      setError(apiMessage(error, 'Ese código no es correcto.'));
    }
  };

  const startWay = () => {
    tap('medium');
    updateStatus.mutate(
      { id: orderId, status: 'on_way' },
      {
        onSuccess: () => refetch(),
        onError: (error) => Alert.alert('No se pudo actualizar', apiMessage(error, 'Inténtalo de nuevo.')),
      }
    );
  };

  const isReady = order.status === 'ready';
  const isPickedUp = order.status === 'picked_up';
  const isOnWay = order.status === 'on_way';
  const isDelivered = order.status === 'delivered';
  const isCancelled = order.status === 'cancelled';
  const inDeliveryPhase = isPickedUp || isOnWay;

  return (
    <Screen>
      <Header
        title={`Pedido #${order.orderNumber ?? orderCode(orderId)}`}
        subtitle={!connected ? 'Sin conexión' : undefined}
        fallback="/(driver)/(tabs)/orders"
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={60}
      >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.huge }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headRow}>
          <StatusPill status={order.status} />
          <Badge label={money((order.deliveryFee || 0) + (order.tip || 0))} tone="lime" />
        </View>

        {/*
          La ruta va arriba del todo: es lo que el repartidor mira con el
          teléfono en el soporte de la moto. La evidencia y los códigos
          solo importan cuando ya llegó, y para entonces tiene el teléfono
          en la mano y puede desplazarse.
        */}
        {!isDelivered && !isCancelled ? (
          <DriverRouteCard orderId={orderId} status={order.status} />
        ) : null}

        {isCancelled ? (
          <Notice tone="error">Este pedido se canceló. No hay nada más que hacer aquí.</Notice>
        ) : isDelivered ? (
          <Card style={styles.doneCard}>
            <SuccessCheck size={72} />
            <Text v="titleL" center>Entrega completada</Text>
            <Text v="bodyM" tone="textSecondary" center>Buen trabajo. Ya puedes tomar tu próximo pedido.</Text>
            <Button title="Volver a mis entregas" full onPress={() => router.replace('/(driver)/(tabs)/orders')} />
          </Card>
        ) : !inDeliveryPhase ? (
          <>
            {/* ── Fase 1: recogida en el comercio ── */}
            <Card style={styles.section}>
              <SectionTitle icon="negocio" label="RECOGER EN" />
              <Text v="titleM">{business?.name ?? 'El negocio'}</Text>
              <Pressable onPress={() => openMap(business?.address, business?.location?.coordinates?.[1], business?.location?.coordinates?.[0])}>
                <View style={styles.addrRow}>
                  <Icon name="ubicacion" size="sm" color={c.textMuted} />
                  <Text v="bodyS" tone="textSecondary" style={styles.flex}>{business?.address}</Text>
                  <Icon name="navegar" size="sm" color={c.primaryText} />
                </View>
              </Pressable>

              {!flow?.pickup.arrivedAt ? (
                <Button title="Llegué al local" icon="ubicacion" onPress={() => markArrived('pickup')} loading={arrive.isPending} full />
              ) : !isReady ? null : (
                <>
                  <Notice tone="lime" icon="checkCirculo">Llegada registrada. Sigue con la evidencia y el código.</Notice>

                  <EvidenceStep
                    label="Foto de lo que recibes del comercio"
                    evidence={flow?.pickup.evidence ?? null}
                    uploading={uploadingStage === 'pickup'}
                    onCapture={() => takePhoto('pickup')}
                  />

                  {flow?.pickup.evidence ? (
                    justCompleted === 'pickup' ? (
                      <View style={styles.centerRow}><SuccessCheck size={56} /></View>
                    ) : (
                      <View style={styles.codeBlock}>
                        <Text v="strongS" tone="textSecondary">
                          Código de recogida — te lo da el comercio
                        </Text>
                        <OtpInput
                          length={CODE_LENGTH}
                          value={pickupCode}
                          onChange={(next) => {
                            setPickupCode(next);
                            setPickupError('');
                            if (next.length === CODE_LENGTH) submitCode('pickup', next);
                          }}
                          error={!!pickupError}
                        />
                        {pickupError ? <Notice tone="error">{pickupError}</Notice> : null}
                        {flow?.pickup.lockedUntil ? (
                          <Notice tone="warning">
                            Demasiados intentos. Espera un momento antes de volver a probar.
                          </Notice>
                        ) : null}
                      </View>
                    )
                  ) : null}
                </>
              )}
            </Card>
          </>
        ) : (
          <>
            {/* ── Fase 2: entrega al cliente ── */}
            <Card style={styles.section}>
              <SectionTitle icon="ubicacion" label="ENTREGAR A" />
              <Text v="titleM">{client?.name ?? 'El cliente'}</Text>
              <Pressable onPress={() => openMap(order.deliveryAddress, order.deliveryLocation?.coordinates?.[1], order.deliveryLocation?.coordinates?.[0])}>
                <View style={styles.addrRow}>
                  <Icon name="ubicacion" size="sm" color={c.textMuted} />
                  <Text v="bodyS" tone="textSecondary" style={styles.flex}>{order.deliveryAddress}</Text>
                  <Icon name="navegar" size="sm" color={c.primaryText} />
                </View>
              </Pressable>

              {order.paymentMethod === 'cash_on_delivery' ? (
                <Notice tone="warning" icon="efectivo">Cobra {money(order.total)} en efectivo.</Notice>
              ) : (
                <Notice tone="info" icon="tarjeta">Pedido ya pagado. No cobres nada en la entrega.</Notice>
              )}

              {isPickedUp ? (
                <Button title="Iniciar camino" icon="ruta" onPress={startWay} loading={updateStatus.isPending} full />
              ) : !flow?.delivery.arrivedAt ? (
                <Button title="Llegué al destino" icon="ubicacion" onPress={() => markArrived('delivery')} loading={arrive.isPending} full />
              ) : (
                <>
                  <Notice tone="lime" icon="checkCirculo">Llegada registrada. Sigue con la evidencia y el código.</Notice>

                  <EvidenceStep
                    label="Foto de la entrega"
                    evidence={flow?.delivery.evidence ?? null}
                    uploading={uploadingStage === 'delivery'}
                    onCapture={() => takePhoto('delivery')}
                  />

                  {flow?.delivery.evidence ? (
                    justCompleted === 'delivery' ? (
                      <View style={styles.centerRow}><SuccessCheck size={56} /></View>
                    ) : (
                      <View style={styles.codeBlock}>
                        <Text v="strongS" tone="textSecondary">
                          Código de entrega — pídeselo al cliente, no lo sabes de antemano
                        </Text>
                        <OtpInput
                          length={CODE_LENGTH}
                          value={deliveryCode}
                          onChange={(next) => {
                            setDeliveryCode(next);
                            setDeliveryError('');
                            if (next.length === CODE_LENGTH) submitCode('delivery', next);
                          }}
                          error={!!deliveryError}
                        />
                        {deliveryError ? <Notice tone="error">{deliveryError}</Notice> : null}
                        {flow?.delivery.lockedUntil ? (
                          <Notice tone="warning">
                            Demasiados intentos. Espera un momento antes de volver a probar.
                          </Notice>
                        ) : null}
                      </View>
                    )
                  ) : null}
                </>
              )}
            </Card>
          </>
        )}

        {/* ── Comunicación con el cliente ── */}
        {!isDelivered && !isCancelled && (flow?.chat.available || flow?.call.available) ? (
          <View style={styles.commsRow}>
            <Button
              title={flow?.chat.unread ? `Chat (${flow.chat.unread})` : 'Chat con el cliente'}
              icon="chat"
              variant="secondary"
              style={styles.flex}
              onPress={() => { tap('light'); setChatOpen(true); }}
            />
            {flow?.call.available ? (
              <Button
                title="Llamar"
                icon="llamar"
                variant="lime"
                style={styles.flex}
                onPress={() => { tap('light'); setCallStartedByMe(true); setCallOpen(true); }}
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      </KeyboardAvoidingView>

      <OrderChatSheet visible={chatOpen} onClose={() => setChatOpen(false)} orderId={orderId} />
      <OrderCallSheet
        visible={callOpen}
        onClose={() => { setCallOpen(false); clearIncomingCall(); }}
        orderId={orderId}
        orderNumber={order.orderNumber ?? orderCode(orderId)}
        startOnOpen={callStartedByMe}
        onOpenChat={() => { setCallOpen(false); setChatOpen(true); }}
      />
    </Screen>
  );
}

function SectionTitle({ icon, label }: { icon: any; label: string }) {
  const { c } = useTheme();
  return (
    <View style={styles.sectionTitleRow}>
      <Icon name={icon} size="sm" color={c.textMuted} />
      <Text v="caption" tone="textMuted">{label}</Text>
    </View>
  );
}

function EvidenceStep({
  label, evidence, uploading, onCapture,
}: {
  label: string;
  evidence: { url: string } | null;
  uploading: boolean;
  onCapture: () => void;
}) {
  const { c } = useTheme();
  return (
    <View style={styles.evidenceStep}>
      <Text v="strongS" tone="textSecondary">{label}</Text>
      {evidence ? (
        <Animated.View entering={FadeIn.duration(240)}>
          <Image source={{ uri: evidence.url }} style={styles.evidenceThumb} contentFit="cover" />
        </Animated.View>
      ) : (
        <Button
          title={uploading ? 'Subiendo…' : 'Tomar foto'}
          icon="camara"
          variant="secondary"
          onPress={onCapture}
          loading={uploading}
          disabled={uploading}
          full
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  section: { gap: Spacing.md },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  addrRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  evidenceStep: { gap: Spacing.sm },
  evidenceThumb: { width: '100%', height: 180, borderRadius: BorderRadius.lg },

  codeBlock: { gap: Spacing.sm, marginTop: Spacing.xs },
  centerRow: { alignItems: 'center', paddingVertical: Spacing.md },

  commsRow: { flexDirection: 'row', gap: Spacing.sm },

  doneCard: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.xl },
});
