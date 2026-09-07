import { FlatList, View, StyleSheet, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Text, Icon, Button, EmptyState, ErrorState, Screen, Header, Skeleton,
} from '../../components/ui';
import { ContentIcon, type ContentIllustrationName } from '../../components/illustrations';
import { useNotifications, useMarkAllRead, useMarkRead } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing, FontSize } from '../../theme/tokens';
import { orderDate } from '../../lib/format';

/** Qué mini-ilustración (o alerta funcional) va en cada tipo de aviso. */
type Look = { kind: 'illustration'; name: ContentIllustrationName } | { kind: 'alert' };

function look(type: string): Look {
  if (type?.includes('order')) return { kind: 'illustration', name: 'paquete' };
  if (type?.includes('promo') || type?.includes('coupon')) return { kind: 'illustration', name: 'cupon' };
  if (type?.includes('payment')) return { kind: 'illustration', name: 'tarjeta' };
  if (type?.includes('cancel')) return { kind: 'alert' };
  return { kind: 'illustration', name: 'notificaciones' };
}

export default function NotificationsScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();

  const { data, isLoading, isError, refetch, isRefetching } = useNotifications();
  const markAll = useMarkAllRead();
  const markOne = useMarkRead();

  const notifications: any[] = Array.isArray(data) ? data : data?.notifications ?? [];
  const unread = notifications.filter((n) => !n.isRead).length;

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header
        title="Avisos y notificaciones"
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
            <View
              key={i}
              style={[
                styles.itemCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
              ]}
            >
              <Skeleton width={44} height={44} radius={14} />
              <View style={styles.flex}>
                <Skeleton width="55%" height={16} />
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
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={9}
          initialNumToRender={8}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={c.primary} />
          }
          renderItem={({ item }) => {
            const info = look(item.type ?? '');
            const orderId = item.data?.orderId;

            return (
              <View
                style={[
                  styles.itemCard,
                  {
                    backgroundColor: c.surface,
                    borderColor: !item.isRead
                      ? isDark ? 'rgba(75, 59, 255, 0.40)' : 'rgba(75, 59, 255, 0.25)'
                      : isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                  },
                ]}
              >
                <View style={styles.cleanIcon}>
                  {info.kind === 'illustration' ? (
                    <ContentIcon name={info.name} size={30} />
                  ) : (
                    <Icon name="error" size="lg" color={c.errorText} />
                  )}
                </View>

                <View style={styles.itemBody}>
                  <View style={styles.itemTitleRow}>
                    <Text v="strongM" numberOfLines={2} style={styles.flex}>
                      {item.title}
                    </Text>
                    {!item.isRead ? (
                      <View style={[styles.unreadPill, { backgroundColor: c.primary }]}>
                        <Text v="dataXS" color="#FFFFFF">Nuevo</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text v="bodyS" tone="textSecondary" numberOfLines={3}>
                    {item.body}
                  </Text>
                  <Text v="dataXS" tone="textMuted">
                    {orderDate(item.createdAt)}
                  </Text>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View
              style={[
                styles.emptyCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
              ]}
            >
              <EmptyState
                icon="notificaciones"
                title="Sin avisos todavía"
                message="Cuando tengas novedades sobre tus pedidos o promociones activas las verás aquí."
              />
            </View>
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.huge },
  skeletons: { padding: Spacing.lg, gap: Spacing.md },

  itemCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
  },
  cleanIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  itemBody: { flex: 1, gap: 4 },
  itemTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  unreadPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
  },
  emptyCard: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
