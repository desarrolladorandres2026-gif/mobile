import { useState, useEffect, useCallback, memo } from 'react';
import {
  View, FlatList, StyleSheet, Pressable, RefreshControl, Linking, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Icon, Card, Button, Badge, StatusPill, EmptyState, ErrorState,
  LoadingScreen, PulseDot, Notice, DetailRow,
} from '../../../components/ui';
import {
  useAvailableOrders, useDriverOrders, useDriverProfile, useAssignDriver, useUpdateOrderStatus,
} from '../../../hooks/useApi';
import { useTheme } from '../../../hooks/useTheme';
import { socketService } from '../../../services/socket';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { money, orderCode, orderDate } from '../../../lib/format';
import { tap } from '../../../lib/haptics';

const BOTTOM_SPACE = 100;
type OrderTab = 'available' | 'my_deliveries';

export default function DriverOrdersScreen() {
  const { c } = useTheme();
  const [tab, setTab] = useState<OrderTab>('available');

  const { data: driverProfile } = useDriverProfile();
  const {
    data: availableOrdersData, isLoading: loadingAvailable, refetch: refetchAvailable, isRefetching: refetchingAvailable,
  } = useAvailableOrders();
  const {
    data: driverOrdersData, isLoading: loadingDriverOrders, refetch: refetchMy, isRefetching: refetchingMy,
  } = useDriverOrders();

  const assignDriverMutation = useAssignDriver();
  const updateStatusMutation = useUpdateOrderStatus();

  useEffect(() => {
    socketService.connect();
    const handleOrderAvailable = () => { refetchAvailable(); };
    socketService.onOrderAvailable(handleOrderAvailable);
    return () => { socketService.offOrderAvailable(handleOrderAvailable); };
  }, [refetchAvailable]);

  const isRefetching = tab === 'available' ? refetchingAvailable : refetchingMy;

  const handleRefresh = async () => {
    if (tab === 'available') {
      await refetchAvailable();
    } else {
      await refetchMy();
    }
  };

  const availableOrders = availableOrdersData?.data || availableOrdersData || [];
  const myOrders = driverOrdersData?.data || driverOrdersData || [];
  const list = tab === 'available' ? availableOrders : myOrders;
  const isLoading = tab === 'available' ? loadingAvailable : loadingDriverOrders;

  const handleAcceptOrder = useCallback((orderId: string) => {
    if (!driverProfile) {
      Alert.alert('Error', 'No se encontró tu perfil de domiciliario');
      return;
    }
    tap('medium');
    assignDriverMutation.mutate(
      { orderId, driverId: driverProfile._id },
      {
        onSuccess: (updatedOrder: any) => {
          tap('success');
          Alert.alert('¡Pedido aceptado!', 'Dirígete al negocio para recoger los productos.');
          refetchAvailable();
          refetchMy();
          setTab('my_deliveries');

          socketService.emitOrderStatusUpdate({
            orderId,
            status: 'ready',
            clientId: updatedOrder.clientId,
            driverId: driverProfile.userId?._id || driverProfile.userId,
          });
        },
        onError: (error: any) => {
          tap('error');
          Alert.alert('Error', error.response?.data?.message || 'No se pudo aceptar el pedido');
        },
      }
    );
  }, [driverProfile, assignDriverMutation, refetchAvailable, refetchMy]);

  const handleUpdateStatus = useCallback((orderId: string, nextStatus: string) => {
    const order = list.find((o: any) => o._id === orderId);
    tap('medium');
    updateStatusMutation.mutate(
      { id: orderId, status: nextStatus },
      {
        onSuccess: () => {
          tap('success');
          refetchMy();

          socketService.emitOrderStatusUpdate({
            orderId,
            status: nextStatus,
            clientId: order?.clientId?._id || order?.clientId,
            driverId: driverProfile?.userId?._id || driverProfile?.userId,
          });
        },
        onError: (error: any) => {
          tap('error');
          Alert.alert('Error', error.response?.data?.message || 'No se pudo actualizar el estado');
        },
      }
    );
  }, [list, updateStatusMutation, refetchMy, driverProfile]);

  const openMap = useCallback((address: string, lat?: number, lng?: number) => {
    tap('light');
    const query = lat && lng ? `${lat},${lng}` : encodeURIComponent(address);
    const url = `https://www.google.com/maps/search/?api=1&query=${query}`;
    Linking.openURL(url).catch(() => {});
  }, []);


  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.top}>
        <Text v="displayM">Entregas</Text>

        {/* ── Selector de Pestañas ── */}
        <View style={[styles.segments, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
          <Segment
            label="Disponibles"
            count={availableOrders.length}
            live={availableOrders.length > 0}
            active={tab === 'available'}
            onPress={() => { tap('select'); setTab('available'); }}
          />
          <Segment
            label="Mis Entregas"
            count={myOrders.length}
            active={tab === 'my_deliveries'}
            onPress={() => { tap('select'); setTab('my_deliveries'); }}
          />
        </View>
      </View>

      {isLoading && !isRefetching ? (
        <LoadingScreen message="Actualizando pedidos..." />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={8}
          windowSize={7}
          initialNumToRender={6}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={handleRefresh}
              tintColor={c.primary}
              colors={[c.primary]}
            />
          }
          renderItem={({ item }) => (
            <DriverOrderCard
              order={item}
              isAvailable={tab === 'available'}
              onAccept={handleAcceptOrder}
              onNextStatus={handleUpdateStatus}
              onOpenMap={openMap}
            />
          )}
          ListEmptyComponent={
            tab === 'available' ? (
              <EmptyState
                icon="ruta"
                title="Sin pedidos disponibles"
                message="En cuanto un restaurante prepare un pedido, aparecerá aquí al instante."
                actionLabel="Actualizar"
                onAction={handleRefresh}
              />
            ) : (
              <EmptyState
                icon="pedidos"
                title="No tienes pedidos asignados"
                message="Pasa a la pestaña 'Disponibles' para aceptar tu próxima entrega."
                actionLabel="Ver disponibles"
                onAction={() => setTab('available')}
              />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

function Segment({
  label, count, active, live, onPress,
}: { label: string; count: number; active: boolean; live?: boolean; onPress: () => void }) {
  const { c } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.segment, active && { backgroundColor: c.surface }]}
    >
      {live ? <PulseDot color={c.lime} size={6} /> : null}
      <Text v="strongS" tone={active ? 'text' : 'textMuted'}>{label}</Text>
      {count > 0 ? (
        <Text v="dataXS" tone={active ? 'primaryText' : 'textMuted'}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

const DriverOrderCard = memo(function DriverOrderCard({
  order, isAvailable, onAccept, onNextStatus, onOpenMap,
}: {
  order: any;
  isAvailable: boolean;
  onAccept: (orderId: string) => void;
  onNextStatus: (orderId: string, status: string) => void;
  onOpenMap: (addr: string, lat?: number, lng?: number) => void;
}) {
  const { c } = useTheme();
  const router = useRouter();

  const business = order.businessId;
  const client = order.clientId;
  const deliveryFee = order.deliveryFee || 0;
  const tip = order.tip || 0;
  const totalEarning = deliveryFee + tip;

  // La recogida y la entrega ya exigen evidencia y código de seguridad —
  // ver esta pantalla es donde eso se resuelve. Sin el badge de reparto
  // activo bien podría confundirse con "toca para aceptar".
  const goToDetail = () => router.push(`/(driver)/order/${order._id}` as never);

  return (
    <Animated.View entering={FadeIn.duration(240)}>
      <Card style={styles.card} onPress={!isAvailable ? goToDetail : undefined}>
        {!isAvailable ? (
          <View style={styles.detailHint}>
            <Icon name="candado" size="sm" color={c.textMuted} />
            <Text v="caption" tone="textMuted">Toca para ver evidencia, código, chat y llamada</Text>
          </View>
        ) : null}
        <View style={styles.cardHeader}>
          <View>
            <Text v="caption" tone="textMuted">{orderDate(order.createdAt)}</Text>
            <Text v="titleM">{business?.name || 'Local comercial'}</Text>
          </View>
          <Badge
            label={money(totalEarning)}
            tone="lime"
          />
        </View>

        {/* ── Ruta de entrega ── */}
        <View style={[styles.routeBox, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
          {/* Origen */}
          <Pressable
            onPress={() => onOpenMap(business?.address, business?.location?.coordinates?.[1], business?.location?.coordinates?.[0])}
            style={styles.routeRow}
          >
            <View style={[styles.pointDot, { backgroundColor: c.primary }]} />
            <View style={styles.flex}>
              <Text v="caption" tone="textMuted">RECOGER EN</Text>
              <Text v="strongS" numberOfLines={1}>{business?.address || 'Dirección del negocio'}</Text>
            </View>
            <Icon name="navegar" size="sm" color={c.primaryText} />
          </Pressable>

          <View style={[styles.routeDivider, { backgroundColor: c.border }]} />

          {/* Destino */}
          <Pressable
            onPress={() => onOpenMap(order.deliveryAddress, order.deliveryLatitude, order.deliveryLongitude)}
            style={styles.routeRow}
          >
            <View style={[styles.pointDot, { backgroundColor: c.lime }]} />
            <View style={styles.flex}>
              <Text v="caption" tone="textMuted">ENTREGAR A {client?.name?.toUpperCase() || 'CLIENTE'}</Text>
              <Text v="strongS" numberOfLines={1}>{order.deliveryAddress}</Text>
            </View>
            <Icon name="navegar" size="sm" color={c.limeText} />
          </Pressable>
        </View>

        {/* ── Alerta si es Pago en Efectivo ── */}
        {order.paymentMethod === 'cash_on_delivery' ? (
          <Notice tone="warning" icon="efectivo">
            Cobrar al cliente: {money(order.total)} en efectivo.
          </Notice>
        ) : (
          <Notice tone="info" icon="tarjeta">
            Pedido pagado digitalmente. No cobrar nada en la entrega.
          </Notice>
        )}

        {/* ── Botones de Acción ── */}
        {/*
          Sin botón de llamada directa aquí: llamar al cliente expondría su
          número personal, justo lo que la sesión de llamada en la pantalla
          del pedido evita. "Toca para ver..." arriba ya lleva hasta ahí.
        */}
        <View style={styles.cardActions}>
          {isAvailable ? (
            <Button
              title="Aceptar pedido"
              icon="check"
              style={styles.flex}
              onPress={() => onAccept(order._id)}
            />
          ) : order.status === 'ready' ? (
            // Recoger ya exige foto + código de seguridad del comercio: se
            // resuelve en la pantalla del pedido, no con un solo toque aquí.
            <Button
              title="Recoger en local"
              icon="paquete"
              style={styles.flex}
              onPress={goToDetail}
            />
          ) : order.status === 'picked_up' ? (
            // Sin código de por medio: es un simple cambio de estado.
            <Button
              title="Iniciar camino"
              icon="ruta"
              style={styles.flex}
              onPress={() => onNextStatus(order._id, 'on_way')}
            />
          ) : order.status === 'on_way' ? (
            // Entregar exige foto + el código que le pide al cliente.
            <Button
              title="Confirmar entrega"
              icon="check"
              style={styles.flex}
              onPress={goToDetail}
            />
          ) : (
            <StatusPill status={order.status} />
          )}
        </View>
      </Card>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  top: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, gap: Spacing.lg },
  segments: {
    flexDirection: 'row',
    gap: Spacing.xs,
    padding: 4,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs + 2,
    height: 42,
    borderRadius: BorderRadius.full,
  },

  list: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: BOTTOM_SPACE },
  card: { padding: Spacing.lg, gap: Spacing.md },
  detailHint: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -4 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  routeBox: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  pointDot: { width: 10, height: 10, borderRadius: 5 },
  routeDivider: { height: StyleSheet.hairlineWidth, marginVertical: 2 },

  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
});
