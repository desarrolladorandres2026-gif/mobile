import { useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, Share, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Button, IconButton, Card, Badge, StatusPill, Notice,
  DetailRow, Screen, Header, LoadingScreen, ErrorState, PulseDot,
} from '../../components/ui';
import { TrazoRuta, TrazoConnector } from '../../components/brand/Trazo';
import { SecurityCodeBox, SecurityCodePending } from '../../components/domain/SecurityCodeBox';
import { OrderChatSheet } from '../../components/domain/OrderChatSheet';
import { OrderCallSheet } from '../../components/domain/OrderCallSheet';
import { useOrder, useOrderFlow } from '../../hooks/useApi';
import { useOrderRealtime, useOrderFlowRealtime, orderProgress } from '../../hooks/useRealtime';
import { useTheme } from '../../hooks/useTheme';
import { ORDER_STATUS_DETAIL } from '../../constants/config';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money, orderCode, etaClock, initials } from '../../lib/format';
import { tap } from '../../lib/haptics';

/** Los cinco momentos que le importan al cliente. */
const STEPS = [
  { key: 'sent', label: 'Pedido enviado', statuses: ['pending'] },
  { key: 'accepted', label: 'Aceptado y en preparación', statuses: ['accepted', 'preparing'] },
  { key: 'ready', label: 'Listo para recoger', statuses: ['ready'] },
  { key: 'way', label: 'En camino a tu dirección', statuses: ['picked_up', 'on_way'] },
  { key: 'done', label: 'Entregado', statuses: ['delivered'] },
] as const;

function currentStep(status: string): number {
  const index = STEPS.findIndex((s) => (s.statuses as readonly string[]).includes(status));
  return index === -1 ? 0 : index;
}

export default function OrderTrackingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { width } = useWindowDimensions();

  const { data: order, isLoading, isError, refetch } = useOrder(id);
  const { connected } = useOrderRealtime();
  const { data: flow } = useOrderFlow(order?._id);
  const { incomingCall, clearIncomingCall } = useOrderFlowRealtime(order?._id);

  const [chatOpen, setChatOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callStartedByMe, setCallStartedByMe] = useState(false);

  // Una llamada entrante abre la hoja sola, aunque el cliente esté leyendo
  // el detalle del pedido en ese momento — no depende de que haya tocado
  // "Llamar" para enterarse.
  useEffect(() => {
    if (incomingCall) {
      setCallStartedByMe(false);
      setCallOpen(true);
    }
  }, [incomingCall]);

  if (isLoading) return <LoadingScreen message="Buscando tu pedido…" />;

  if (isError || !order) {
    return (
      <Screen>
        <Header title="Seguimiento" fallback="/(client)/(tabs)/orders" />
        <ErrorState
          title="No encontramos este pedido"
          message="Puede que se haya archivado. Revísalo en tu historial."
          onRetry={refetch}
        />
      </Screen>
    );
  }

  const cancelled = order.status === 'cancelled';
  const delivered = order.status === 'delivered';
  const step = currentStep(order.status);
  const progress = orderProgress(order.status);
  const reference = order.orderNumber ?? orderCode(order._id);

  const share = async () => {
    tap('light');
    try {
      await Share.share({
        message: `Mi pedido en Zipp (${reference}) de ${order.businessId?.name ?? 'un negocio'}: ${ORDER_STATUS_DETAIL[order.status] ?? ''}`,
      });
    } catch {
      // Cancelar la hoja de compartir no es un error.
    }
  };

  return (
    <Screen>
      <Header
        title="Tu pedido"
        subtitle={reference}
        fallback="/(client)/(tabs)/orders"
        onBack={() => router.replace('/(client)/(tabs)/orders')}
        right={<IconButton icon="compartir" label="Compartir el estado del pedido" onPress={share} />}
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {cancelled ? (
          <Card style={styles.cancelled}>
            <View style={[styles.cancelledIcon, { backgroundColor: c.errorSoft }]}>
              <Icon name="error" size={30} color={c.error} />
            </View>
            <Text v="titleL" center>Este pedido se canceló</Text>
            <Text v="bodyM" tone="textSecondary" center>
              {order.cancellationReason || 'El local no pudo tomarlo.'}
            </Text>
            {order.paymentMethod === 'online' ? (
              <Notice tone="info">
                Si ya se hizo el cobro, la devolución sale automáticamente y llega en
                pocos días hábiles.
              </Notice>
            ) : null}
          </Card>
        ) : (
          <>
            {/* ── El trazo: dónde va el pedido ── */}
            <Animated.View entering={FadeIn.duration(360)} style={styles.hero}>
              <View style={styles.heroTop}>
                <StatusPill status={order.status} />
                {!connected ? (
                  <Badge label="Sin señal" tone="warning" icon="sinConexion" />
                ) : !delivered ? (
                  <View style={styles.live}>
                    <PulseDot color={c.lime} size={6} />
                    <Text v="captionStrong" tone="limeText">EN VIVO</Text>
                  </View>
                ) : null}
              </View>

              <Text v="displayM">{ORDER_STATUS_DETAIL[order.status]}</Text>

              <TrazoRuta
                progress={progress}
                width={width - Spacing.xl * 2}
                settled={delivered}
              />

              <View style={styles.route}>
                <View style={styles.routeEnd}>
                  <Text v="caption" tone="textMuted">DESDE</Text>
                  <Text v="strongS" numberOfLines={1}>{order.businessId?.name ?? 'El local'}</Text>
                </View>
                <View style={[styles.routeEnd, styles.routeRight]}>
                  <Text v="caption" tone="textMuted">HASTA</Text>
                  <Text v="strongS" numberOfLines={1}>{order.deliveryAddress}</Text>
                </View>
              </View>

              {!delivered && order.businessId?.deliveryTime ? (
                <View style={[styles.etaPill, { backgroundColor: c.primarySoft, borderColor: c.primary }]}>
                  <Icon name="minutos" size="md" color={c.primaryText} />
                  <View style={styles.flex}>
                    <Text v="caption" tone="textMuted">TIEMPO ESTIMADO DE ENTREGA</Text>
                    <Text v="strongM" tone="primaryText">
                      {`Aproximadamente a las ${etaClock(order.businessId.deliveryTime)}`}
                    </Text>
                  </View>
                </View>
              ) : null}
            </Animated.View>

            {/* ── Domiciliario ── */}
            {order.driverId ? (
              <Card style={styles.driver}>
                <View style={[styles.avatar, { backgroundColor: c.primary }]}>
                  <Text v="titleM" color={c.textOnPrimary}>
                    {initials(order.driverId.userId?.name)}
                  </Text>
                </View>
                <View style={styles.flex}>
                  <Text v="caption" tone="textMuted">TE LO LLEVA</Text>
                  <Text v="titleM" numberOfLines={1}>
                    {order.driverId.userId?.name ?? 'Domiciliario'}
                  </Text>
                  <View style={styles.vehicle}>
                    <Icon name="domiciliario" size="sm" color={c.textMuted} />
                    <Text v="bodyS" tone="textSecondary">
                      {order.driverId.vehicleType === 'bicycle' ? 'Bicicleta' : 'Moto'}
                      {order.driverId.licensePlate ? ` · ${order.driverId.licensePlate}` : ''}
                    </Text>
                  </View>
                </View>
              </Card>
            ) : null}

            {/* ── Comunicación: nunca el teléfono directo ── */}
            {flow?.chat.available || flow?.call.available ? (
              <View style={styles.commsRow}>
                <Button
                  title={flow?.chat.unread ? `Chat (${flow.chat.unread})` : 'Chat'}
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

            {/* ── Código de seguridad de la entrega ── */}
            {flow?.delivery.code ? (
              <SecurityCodeBox
                code={flow.delivery.code}
                warning="No lo compartas hasta recibir tu pedido en mano."
              />
            ) : order.driverId && !delivered && flow?.pickup.codeStatus !== 'used' ? (
              <SecurityCodePending label="Tu código de entrega aparecerá aquí en cuanto el domiciliario recoja tu pedido." />
            ) : null}

            {/* ── Evidencia de entrega ── */}
            {delivered && flow?.delivery.evidence ? (
              <Card style={styles.evidenceCard}>
                <Text v="label" tone="textMuted">Foto de entrega</Text>
                <Image
                  source={{ uri: flow.delivery.evidence.url }}
                  style={styles.evidenceImage}
                  contentFit="cover"
                  transition={200}
                />
              </Card>
            ) : null}

            {/* ── Pasos ── */}
            <Card style={styles.steps}>
              <Text v="label" tone="textMuted">Cómo va</Text>
              {STEPS.map((item, index) => {
                const done = index < step;
                const active = index === step;
                const last = index === STEPS.length - 1;

                return (
                  <View key={item.key} style={styles.step}>
                    <View style={styles.stepRail}>
                      <View
                        style={[
                          styles.stepDot,
                          {
                            backgroundColor: done ? c.lime : active ? c.background : c.surfaceLight,
                            borderColor: done || active ? c.lime : c.border,
                            borderWidth: active ? 3 : done ? 0 : 1.5,
                          },
                        ]}
                      >
                        {done ? <Icon name="check" size={12} color={c.textOnLime} strong /> : null}
                        {active ? <PulseDot color={c.lime} size={8} /> : null}
                      </View>
                      {!last ? <TrazoConnector done={done} animate={active} /> : null}
                    </View>

                    <View style={[styles.stepBody, !last && styles.stepBodySpaced]}>
                      <Text
                        v={active ? 'strongM' : 'bodyM'}
                        tone={active ? 'text' : done ? 'textSecondary' : 'textMuted'}
                      >
                        {item.label}
                      </Text>
                      {active ? (
                        <Text v="bodyS" tone="textMuted">{ORDER_STATUS_DETAIL[order.status]}</Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </Card>
          </>
        )}

        {/* ── Efectivo listo ── */}
        {order.paymentMethod === 'cash_on_delivery' && !delivered && !cancelled ? (
          <Notice tone="warning" icon="efectivo">
            {`Ten listos ${money(order.total)} en efectivo. El domiciliario no siempre lleva cambio.`}
          </Notice>
        ) : null}

        {/* ── Detalle ── */}
        <Card style={styles.summary}>
          <Text v="label" tone="textMuted">Lo que pediste</Text>

          {order.items?.map((item: any, index: number) => (
            <View key={`${item.productName}-${index}`} style={styles.summaryItem}>
              <Text v="dataM" tone="primaryText">{item.quantity}×</Text>
              <View style={styles.flex}>
                <Text v="bodyM" numberOfLines={2}>{item.productName}</Text>
                {item.selectedExtras?.length ? (
                  <Text v="caption" tone="textMuted" numberOfLines={2}>
                    {item.selectedExtras.map((e: any) => e.name).join(' · ')}
                  </Text>
                ) : null}
              </View>
              <Text v="dataS" tone="textSecondary">{money(item.totalPrice)}</Text>
            </View>
          ))}

          <View style={[styles.divider, { backgroundColor: c.border }]} />

          <DetailRow label="Productos" value={money(order.subtotal)} />
          {order.deliveryFee ? <DetailRow label="Envío" value={money(order.deliveryFee)} /> : null}
          {order.discount ? (
            <DetailRow label="Descuento" value={`−${money(order.discount)}`} tone="successText" />
          ) : null}
          {order.tip ? <DetailRow label="Propina" value={money(order.tip)} /> : null}

          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <DetailRow label="Total" value={money(order.total)} strong />
        </Card>

        <Button
          title="Algo anda mal con mi pedido"
          icon="soporte"
          variant="secondary"
          full
          onPress={() => router.push('/(client)/help')}
        />
      </ScrollView>

      <OrderChatSheet visible={chatOpen} onClose={() => setChatOpen(false)} orderId={order._id} />
      <OrderCallSheet
        visible={callOpen}
        onClose={() => { setCallOpen(false); clearIncomingCall(); }}
        orderId={order._id}
        orderNumber={reference}
        startOnOpen={callStartedByMe}
        onOpenChat={() => { setCallOpen(false); setChatOpen(true); }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },

  hero: { gap: Spacing.lg },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  live: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs + 1 },
  route: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.lg },
  routeEnd: { flex: 1, gap: 2 },
  routeRight: { alignItems: 'flex-end' },

  etaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },

  driver: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  commsRow: { flexDirection: 'row', gap: Spacing.sm },
  evidenceCard: { gap: Spacing.sm },
  evidenceImage: { width: '100%', height: 220, borderRadius: BorderRadius.lg },
  avatar: {
    width: 54, height: 54, borderRadius: 27,
    alignItems: 'center', justifyContent: 'center',
  },
  vehicle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginTop: 2 },

  steps: { gap: 0 },
  step: { flexDirection: 'row', gap: Spacing.md },
  stepRail: { width: 24, alignItems: 'center' },
  stepDot: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginTop: Spacing.md,
  },
  stepBody: { flex: 1, gap: 2, paddingTop: Spacing.md + 2 },
  stepBodySpaced: { paddingBottom: Spacing.lg },

  cancelled: { alignItems: 'center', gap: Spacing.md },
  cancelledIcon: {
    width: 62, height: 62, borderRadius: BorderRadius.xl,
    alignItems: 'center', justifyContent: 'center',
  },

  summary: { gap: Spacing.md },
  summaryItem: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  divider: { height: StyleSheet.hairlineWidth },
});
