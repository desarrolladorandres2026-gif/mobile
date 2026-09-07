import { useState, useMemo, memo } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  Text, Card, Button, StatusPill, EmptyState, ErrorState,
  BusinessCardSkeleton, PulseDot,
} from '../../../components/ui';
import { useMyOrders } from '../../../hooks/useApi';
import { useOrderRealtime, orderProgress } from '../../../hooks/useRealtime';
import { reorder, type UsualOrder } from '../../../hooks/useUsual';
import { useTheme } from '../../../hooks/useTheme';
import { useTabContentPadding, CLIENT_DOCK_CLEARANCE } from '../../../hooks/useBottomSpace';
import { ACTIVE_ORDER_STATUSES } from '../../../constants/config';
import { categoryIllustration } from '../../../components/illustrations';
import { BorderRadius, Spacing } from '../../../theme/tokens';
import { money, orderDate, orderCode } from '../../../lib/format';
import { tap } from '../../../lib/haptics';

type Tab = 'active' | 'past';

export default function OrdersScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomSpace = useTabContentPadding(CLIENT_DOCK_CLEARANCE);
  const [tab, setTab] = useState<Tab>('active');

  const { data, isLoading, isError, refetch, isRefetching } = useMyOrders(1);
  useOrderRealtime();

  const { active, past } = useMemo(() => {
    const orders: any[] = data?.orders ?? [];
    const isActive = (o: any) =>
      (ACTIVE_ORDER_STATUSES as readonly string[]).includes(o.status);
    return {
      active: orders.filter(isActive),
      past: orders.filter((o) => !isActive(o)),
    };
  }, [data]);

  // Se abre en "En curso" solo si hay algo que seguir; si no, en el historial.
  const list = tab === 'active' ? active : past;

  const repeat = (order: any) => {
    tap('medium');
    const usual: UsualOrder = {
      orderId: order._id,
      businessId: order.businessId._id,
      businessName: order.businessId.name,
      businessCategory: order.businessId.category ?? 'restaurant',
      summary: '',
      itemCount: order.items?.length ?? 0,
      total: order.total ?? 0,
      timesOrdered: 1,
      items: order.items ?? [],
    };
    reorder(usual);
    router.push('/(client)/cart');
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top']}>
      <View style={styles.top}>
        <Text v="displayM">Pedidos</Text>

        <View style={[styles.segments, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
          <Segment
            label="En curso"
            count={active.length}
            live={active.length > 0}
            active={tab === 'active'}
            onPress={() => setTab('active')}
          />
          <Segment
            label="Historial"
            count={past.length}
            active={tab === 'past'}
            onPress={() => setTab('past')}
          />
        </View>
      </View>

      {isError ? (
        <ErrorState onRetry={refetch} />
      ) : isLoading ? (
        <View style={styles.skeletons}>
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
          <BusinessCardSkeleton />
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item) => item._id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomSpace }]}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={9}
          initialNumToRender={8}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={c.primary}
              colors={[c.primary]}
            />
          }
          renderItem={({ item }) => (
            <OrderCard
              order={item}
              onPress={() =>
                router.push({ pathname: '/(client)/order-tracking', params: { id: item._id } })
              }
              onRepeat={item.status === 'delivered' ? () => repeat(item) : undefined}
            />
          )}
          ListEmptyComponent={
            tab === 'active' ? (
              <EmptyState
                icon="ruta"
                title="Nada en camino"
                message="Cuando pidas algo, aquí vas a poder seguirlo paso a paso."
                actionLabel="Ver qué hay abierto"
                onAction={() => router.push('/(client)/(tabs)/home')}
              />
            ) : (
              <EmptyState
                icon="pedidos"
                title="Sin pedidos todavía"
                message="Tu primer pedido en Zipp te está esperando. Casi todo llega en menos de 20 minutos."
                actionLabel="Explorar negocios"
                onAction={() => router.push('/(client)/(tabs)/search')}
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
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'pedido' : 'pedidos'}`}
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

const OrderCard = memo(function OrderCard({
  order, onPress, onRepeat,
}: { order: any; onPress: () => void; onRepeat?: () => void }) {
  const { c } = useTheme();
  const running = (ACTIVE_ORDER_STATUSES as readonly string[]).includes(order.status);
  const progress = orderProgress(order.status);
  const Illustration = categoryIllustration(order.businessId?.category ?? '');

  return (
    <Animated.View entering={FadeIn.duration(240)}>
      <Card
        onPress={onPress}
        padded={false}
        accessibilityLabel={`Pedido ${order.orderNumber ?? orderCode(order._id)} de ${order.businessId?.name}. Total ${money(order.total)}`}
        accessibilityHint="Abre el detalle del pedido"
        style={styles.card}
      >
        <View style={styles.cardTop}>
          <View style={[styles.cardIcon, { backgroundColor: c.surfaceLight }]}>
            <Illustration size={32} />
          </View>

          <View style={styles.cardBody}>
            <Text v="titleM" numberOfLines={1}>
              {order.businessId?.name ?? 'Negocio'}
            </Text>
            <Text v="dataS" tone="textMuted">
              {order.orderNumber ?? orderCode(order._id)} · {orderDate(order.createdAt)}
            </Text>
          </View>

          <Text v="dataL">{money(order.total)}</Text>
        </View>

        <View style={styles.cardBottom}>
          <StatusPill status={order.status} />
          {running ? (
            <Button
              title="Seguir en vivo"
              icon="ruta"
              size="sm"
              onPress={onPress}
            />
          ) : onRepeat ? (
            <Button title="Pedir otra vez" icon="repetir" variant="ghost" size="sm" onPress={onRepeat} />
          ) : null}
        </View>

        {/* Avance del pedido, pegado al borde inferior de la tarjeta. */}
        {running ? (
          <View style={[styles.track, { backgroundColor: c.border }]}>
            <View style={[styles.fill, { backgroundColor: c.lime, width: `${progress * 100}%` }]} />
          </View>
        ) : null}
      </Card>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
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

  list: { padding: Spacing.xl, gap: Spacing.md },
  skeletons: { padding: Spacing.xl, gap: Spacing.md },

  card: { padding: Spacing.md, gap: Spacing.md, overflow: 'hidden' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cardIcon: {
    width: 46, height: 46, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  cardBody: { flex: 1, gap: 2 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  fill: { height: '100%' },
});
