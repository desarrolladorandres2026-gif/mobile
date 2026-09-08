import { useEffect, useState } from 'react';
import {
  View, ScrollView, StyleSheet, Alert, Pressable, Linking,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Button, Card, Notice, OtpInput, Input, Badge, StatusPill,
  Screen, Header, LoadingScreen, ErrorState, SuccessCheck,
} from '../../../components/ui';
import { OrderChatSheet } from '../../../components/domain/OrderChatSheet';
import { OrderCallSheet } from '../../../components/domain/OrderCallSheet';
import { DriverRouteCard } from '../../../components/domain/DriverRouteCard';
import { useDriverTrackingContext } from '../../../hooks/useDriverTracking';
import {
  useOrder, useOrderFlow, useOrderArrive, useUploadOrderEvidence,
  useVerifyOrderCode, useUpdateOrderStatus, useConfirmCash, useDeclareErrandCost,
} from '../../../hooks/useApi';
import { useOrderRealtime, useOrderFlowRealtime } from '../../../hooks/useRealtime';
import { useTheme } from '../../../hooks/useTheme';
import { useBottomInset } from '../../../hooks/useBottomSpace';
import { captureEvidence } from '../../../lib/evidence';
import { captureCoordsForEvidence } from '../../../hooks/useLocation';
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
  const confirmCash = useConfirmCash();

  const [chatOpen, setChatOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callStartedByMe, setCallStartedByMe] = useState(false);
  const [pickupCode, setPickupCode] = useState('');
  const [pickupError, setPickupError] = useState('');
  const [deliveryCode, setDeliveryCode] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  const [justCompleted, setJustCompleted] = useState<'pickup' | 'delivery' | null>(null);
  const [uploadingStage, setUploadingStage] = useState<'pickup' | 'delivery' | null>(null);
  const [cashError, setCashError] = useState('');
  const [spentText, setSpentText] = useState('');
  const [spentError, setSpentError] = useState('');
  const declareCost = useDeclareErrandCost();

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
      const coords = await captureCoordsForEvidence();
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
      const coords = await captureCoordsForEvidence();
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
      const coords = await captureCoordsForEvidence();
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

  /**
   * Registra lo que costó y da la recogida por hecha.
   *
   * Son dos pasos del servidor y uno solo para el domiciliario, a
   * propósito: en la calle, con el mercado en una mano y el teléfono en la
   * otra, dos botones seguidos son un botón que alguien se deja sin pulsar
   * — y un mandado a medias es un pedido que nadie sabe si va o no va.
   */
  const submitSpent = async () => {
    const spent = Number(spentText.replace(/[^\d]/g, ''));
    const receipt = flow?.pickup.evidence?.url;

    if (!spent) return setSpentError('Escribe cuánto pagaste.');
    if (!receipt) return setSpentError('Falta la foto del recibo.');

    setSpentError('');
    try {
      await declareCost.mutateAsync({ orderId, actualCost: spent, receiptUrl: receipt });
      await updateStatus.mutateAsync({ id: orderId, status: 'picked_up' });
      tap('success');
      await refetch();
    } catch (error) {
      tap('error');
      setSpentError(apiMessage(error, 'No pudimos registrar el gasto.'));
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

  // ── Cobro en efectivo ──
  // El servidor no acepta la confirmación hasta que el pedido está
  // entregado, así que la tarjeta aparece exactamente cuando la acción es
  // posible. Enseñarla antes sería ofrecer un botón que va a fallar.
  const isCashOrder = order.paymentMethod === 'cash_on_delivery';
  const cashPending = isCashOrder && order.paymentStatus === 'pending_cash';
  const cashCollected = isCashOrder && order.paymentStatus === 'paid';
  const cashDisputed = isCashOrder && order.paymentStatus === 'cash_not_received';

  const declareCash = (received: boolean) => {
    tap(received ? 'success' : 'warning');
    setCashError('');
    confirmCash.mutate(
      { orderId, received },
      {
        onSuccess: () => refetch(),
        onError: (error) => {
          tap('error');
          setCashError(apiMessage(error, 'No pudimos registrar el cobro. Inténtalo de nuevo.'));
        },
      }
    );
  };

  const isReady = order.status === 'ready';
  const isPickedUp = order.status === 'picked_up';
  const isOnWay = order.status === 'on_way';
  const isDelivered = order.status === 'delivered';
  const isCancelled = order.status === 'cancelled';
  const inDeliveryPhase = isPickedUp || isOnWay;
  const isErrand = order.kind === 'errand';

  return (
    <Screen>
      <Header
        title={`Pedido #${order.orderNumber ?? orderCode(orderId)}`}
        subtitle={!connected ? 'Sin conexión' : undefined}
        fallback="/(driver)/(tabs)/orders"
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
        ) : isDelivered && cashPending ? (
          /*
            La entrega terminó, pero el pedido todavía no está cerrado: falta
            el dinero. Esta tarjeta ocupa el sitio de "entrega completada" a
            propósito — enseñar el mensaje de éxito y la pregunta a la vez
            invitaría a salirse sin contestarla, y entonces el cobro quedaría
            pendiente sin que nadie sepa por qué.
          */
          <Card style={styles.section}>
            <SectionTitle icon="efectivo" label="COBRO EN EFECTIVO" />
            <Text v="titleM">¿Recibiste el efectivo?</Text>
            <Text v="bodyM" tone="textSecondary">
              El cliente debía pagarte {money(order.total)} al recibir el pedido.
            </Text>

            <Button
              title="Sí, recibí el efectivo"
              icon="checkCirculo"
              full
              loading={confirmCash.isPending}
              onPress={() => declareCash(true)}
            />
            <Button
              title="No, no lo recibí"
              variant="secondary"
              full
              disabled={confirmCash.isPending}
              onPress={() =>
                Alert.alert(
                  'No recibiste el efectivo',
                  'Se abrirá una revisión con soporte. La comisión de este ' +
                    'pedido sigue en tu saldo hasta que se resuelva.',
                  [
                    { text: 'Cancelar', style: 'cancel' },
                    { text: 'Confirmar', style: 'destructive', onPress: () => declareCash(false) },
                  ]
                )
              }
            />

            {cashError ? <Notice tone="error">{cashError}</Notice> : null}

            {/* Decir de antemano qué implica cada botón evita la pregunta
                que sigue: "¿y ahora quién me cobra la comisión?". */}
            <Notice tone="info">
              De este cobro, la comisión de Zipp queda en tu saldo pendiente y la
              liquidas como siempre.
            </Notice>
          </Card>
        ) : isDelivered && cashDisputed ? (
          <Card style={styles.section}>
            <SectionTitle icon="alerta" label="COBRO EN REVISIÓN" />
            <Text v="titleM">El incidente fue registrado</Text>
            {/*
              Dos frases, en este orden, y ninguna acusatoria. La primera
              porque un domiciliario que reporta un faltante necesita saber
              que su reporte llegó a algún sitio; la segunda porque lo
              siguiente que se pregunta es si el saldo ya desapareció — y
              enterarse de que no cuando intente tomar otro pedido sería
              peor que leerlo aquí.
            */}
            <Text v="bodyM" tone="textSecondary">
              No se eliminará automáticamente el saldo pendiente. Nuestro equipo
              revisará el caso.
            </Text>
            <Text v="bodyS" tone="textMuted">
              Te avisamos aquí mismo en cuanto haya una decisión.
            </Text>
            <Button
              title="Volver a mis entregas"
              full
              onPress={() => router.replace('/(driver)/(tabs)/orders')}
            />
          </Card>
        ) : isDelivered ? (
          <Card style={styles.doneCard}>
            <SuccessCheck size={72} />
            <Text v="titleL" center>Entrega completada</Text>
            <Text v="bodyM" tone="textSecondary" center>
              {cashCollected
                ? `Cobraste ${money(order.total)} en efectivo. Buen trabajo.`
                : 'Buen trabajo. Ya puedes tomar tu próximo pedido.'}
            </Text>
            <Button title="Volver a mis entregas" full onPress={() => router.replace('/(driver)/(tabs)/orders')} />
          </Card>
        ) : isErrand && !inDeliveryPhase ? (
          <>
            {/* ── Fase 1 de un mandado: comprar ── */}
            {/*
              No hay comercio que entregue nada ni que dicte un código: la
              prueba de que la recogida ocurrió es el recibo, y además es la
              única que dice qué se compró y por cuánto.
            */}
            <Card style={styles.section}>
              <SectionTitle icon="mercado" label="COMPRAR EN" />
              <Text v="titleM">{order.errand?.pickupAddress}</Text>
              <Pressable
                onPress={() =>
                  openMap(
                    order.errand?.pickupAddress,
                    order.errand?.pickupLocation?.coordinates?.[1],
                    order.errand?.pickupLocation?.coordinates?.[0]
                  )
                }
              >
                <View style={styles.addrRow}>
                  <Icon name="ubicacion" size="sm" color={c.textMuted} />
                  <Text v="bodyS" tone="textSecondary" style={styles.flex}>Abrir en el mapa</Text>
                  <Icon name="navegar" size="sm" color={c.primaryText} />
                </View>
              </Pressable>

              <View style={styles.errandBrief}>
                <Text v="strongS" tone="textSecondary">EL ENCARGO</Text>
                <Text v="bodyM">{order.errand?.description}</Text>
                {order.notes ? (
                  <Text v="bodyS" tone="textSecondary">{order.notes}</Text>
                ) : null}
              </View>

              {/* El tope no es una sugerencia: por encima, el servidor lo
                  rechaza. Enseñarlo antes de la caja evita descubrirlo con
                  las bolsas ya empacadas. */}
              <Notice tone="warning" icon="efectivo">
                Puedes gastar hasta {money(order.errand?.maxCost)}. El cliente calculó{' '}
                {money(order.errand?.estimatedCost)}.
              </Notice>

              {!flow?.pickup.arrivedAt ? (
                <Button
                  title="Llegué al sitio"
                  icon="ubicacion"
                  onPress={() => markArrived('pickup')}
                  loading={arrive.isPending}
                  full
                />
              ) : (
                <>
                  <EvidenceStep
                    label="Foto del recibo de la compra"
                    evidence={flow?.pickup.evidence ?? null}
                    uploading={uploadingStage === 'pickup'}
                    onCapture={() => takePhoto('pickup')}
                  />

                  {flow?.pickup.evidence ? (
                    <View style={styles.codeBlock}>
                      <Input
                        label="¿Cuánto pagaste?"
                        placeholder={String(order.errand?.estimatedCost ?? '')}
                        value={spentText}
                        onChangeText={(t) => { setSpentText(t); setSpentError(''); }}
                        keyboardType="number-pad"
                        numeric
                        prefix="$"
                        error={spentError || undefined}
                      />
                      <Button
                        title="Registrar gasto y salir"
                        icon="check"
                        full
                        loading={declareCost.isPending || updateStatus.isPending}
                        onPress={submitSpent}
                      />
                      <Text v="caption" tone="textMuted">
                        Se te devuelve este dinero al entregar, junto con lo que ganas por
                        el viaje.
                      </Text>
                    </View>
                  ) : null}
                </>
              )}
            </Card>
          </>
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

        {/* ── Este pedido exige cédula ──
            Va lo más arriba posible: la responsabilidad de no venderle
            licor a un menor es de quien entrega, y enterarse al final del
            recorrido no sirve de nada. */}
        {order?.requiresAgeVerification ? (
          <Notice tone="error">
            Este pedido lleva productos para mayores de edad. Pide la cédula antes
            de entregarlo. Si quien recibe es menor, no lo entregues y repórtalo.
          </Notice>
        ) : null}

        {/* ── El pedido es para otra persona ──
            Va antes de los botones de contacto a propósito: el domiciliario
            tiene que saber a quién busca ANTES de pulsar "Llamar", o llamará
            a quien pagó, que puede estar en otra ciudad. */}
        {order?.recipient ? (
          <Card tone="accent" style={styles.recipientCard}>
            <View style={styles.recipientHead}>
              <Icon name="amigos" size="md" color={c.primary} />
              <Text v="strongS">Entregar a otra persona</Text>
            </View>

            <Text v="titleM">{order.recipient.name}</Text>

            <Pressable
              onPress={() => { tap('light'); Linking.openURL(`tel:${order.recipient.phone}`); }}
              accessibilityRole="button"
              accessibilityLabel={`Llamar a ${order.recipient.name}`}
              style={styles.recipientPhone}
            >
              <Icon name="llamar" size="sm" color={c.primary} />
              <Text v="bodyM" color={c.primary}>{order.recipient.phone}</Text>
            </Pressable>

            {order.recipient.note ? (
              <Text v="bodyS" tone="textSecondary">“{order.recipient.note}”</Text>
            ) : null}
          </Card>
        ) : null}

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
  recipientCard: { gap: Spacing.sm },
  recipientHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  recipientPhone: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },

  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  section: { gap: Spacing.md },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  addrRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  errandBrief: { gap: Spacing.xs },
  evidenceStep: { gap: Spacing.sm },
  evidenceThumb: { width: '100%', height: 180, borderRadius: BorderRadius.lg },

  codeBlock: { gap: Spacing.sm, marginTop: Spacing.xs },
  centerRow: { alignItems: 'center', paddingVertical: Spacing.md },

  commsRow: { flexDirection: 'row', gap: Spacing.sm },

  doneCard: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.xl },
});
