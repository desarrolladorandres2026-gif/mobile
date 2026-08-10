import { FlatList, View, StyleSheet, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Text, Icon, Card, Button, EmptyState, ErrorState, Screen, Header, Skeleton,
} from '../../components/ui';
import { useNotifications, useMarkAllRead, useMarkRead } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { orderDate } from '../../lib/format';

/** Icono y color según de qué trata el aviso. */
function look(type: string): { icon: IconName; tone: 'primary' | 'lime' | 'warning' | 'error' } {
  if (type?.includes('order')) return { icon: 'paquete', tone: 'primary' };
  if (type?.includes('promo') || type?.includes('coupon')) return { icon: 'cupon', tone: 'lime' };
  if (type?.includes('payment')) return { icon: 'tarjeta', tone: 'primary' };
  if (type?.includes('cancel')) return { icon: 'error', tone: 'error' };
  return { icon: 'info', tone: 'warning' };
}

export default function NotificationsScreen() {
  const router = useRouter();
  const { c } = useTheme();

  const { data, isLoading, isError, refetch, isRefetching } = useNotifications();
  const markAll = useMarkAllRead();
  const markOne = useMarkRead();

  const notifications: any[] = Array.isArray(data) ? data : data?.notifications ?? [];
  const unread = notifications.filter((n) => !n.isRead).length;

  return (
    <Screen>
      <Header
        title="Avisos"
        subtitle={unread > 0 ? `${unread} sin leer` : undefined}
        fallback="/(client)/(tabs)/profile"
        right={
          unread > 0 ? (
            <Button
              title="Marcar leídos"
              variant="ghost"
              size="sm"
              loading={markAll.isPending}
              onPress={() => markAll.mutate()}
            />
          ) : undefined
        }
      />

      {isError ? (
        <ErrorState onRetry={refetch} />
      ) : isLoading ? (
        <View style={styles.skeletons}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width={40} height={40} radius={BorderRadius.sm} />
              <View style={styles.flex}>
                <Skeleton width="55%" height={15} />
                <Skeleton width="88%" height={13} style={{ marginTop: 8 }} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} />
          }
          renderItem={({ item }) => {
            const { icon, tone } = look(item.type ?? '');
            const orderId = item.data?.orderId;

            return (
              <Card
                padded={false}
                tone={item.isRead ? 'flat' : 'accent'}
                onPress={() => {
                  if (!item.isRead) markOne.mutate(item._id);
                  if (orderId) {
                    router.push({ pathname: '/(client)/order-tracking', params: { id: String(orderId) } });
                  }
                }}
                accessibilityLabel={`${item.title}. ${item.body}`}
                accessibilityHint={orderId ? 'Abre el pedido relacionado' : undefined}
                style={styles.item}
              >
                <View
                  style={[
                    styles.itemIcon,
                    {
                      backgroundColor:
                        tone === 'lime' ? c.limeSoft
                        : tone === 'error' ? c.errorSoft
                        : tone === 'warning' ? c.warningSoft
                        : c.primarySoft,
                    },
                  ]}
                >
                  <Icon
                    name={icon}
                    size="md"
                    color={
                      tone === 'lime' ? c.limeText
                      : tone === 'error' ? c.errorText
                      : tone === 'warning' ? c.warningText
                      : c.primaryText
                    }
                  />
                </View>

                <View style={styles.itemBody}>
                  <Text v={item.isRead ? 'strongS' : 'titleS'} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Text v="bodyS" tone="textSecondary" numberOfLines={3}>{item.body}</Text>
                  <Text v="dataXS" tone="textMuted">{orderDate(item.createdAt)}</Text>
                </View>

                {!item.isRead ? <View style={[styles.unreadDot, { backgroundColor: c.lime }]} /> : null}
              </Card>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              icon="notificaciones"
              title="Nada por aquí"
              message="Cuando tengas un pedido en curso o una promoción nueva, te avisamos en esta pantalla."
            />
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: Spacing.xl, gap: Spacing.md, paddingBottom: Spacing.huge },
  skeletons: { padding: Spacing.xl, gap: Spacing.lg },
  skeletonRow: { flexDirection: 'row', gap: Spacing.md },

  item: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, padding: Spacing.md },
  itemIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  itemBody: { flex: 1, gap: 3 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, marginTop: Spacing.sm },
});
