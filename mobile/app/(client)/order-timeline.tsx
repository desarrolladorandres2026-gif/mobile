import { View, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAuthStore } from '../../stores/authStore';
import {
  Text, Icon, Card, Screen, Header, LoadingScreen, ErrorState,
} from '../../components/ui';
import { useOrderTimeline } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * La cronología real del pedido, con quién hizo qué y cuándo.
 *
 * `GET /orders/:id/timeline` servía hasta 20 hitos etiquetados con actor
 * desde hacía tiempo —incluso reconstruye hitos históricos derivados— y
 * ninguna pantalla lo pedía: `order-tracking.tsx` pinta su propia barra de
 * cinco pasos deducida solo de `order.status`, sin poder decir nunca
 * "aceptado a las 7:42".
 */
export default function OrderTimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const { data: entries = [], isLoading, isError, refetch } = useOrderTimeline(id, true);

  // Vive en (client) porque nació ahí, pero un domiciliario tambien enlaza
  // aqui desde su propia pantalla de pedido -- el "volver" tiene que
  // llevarlo a su lista y no a la del cliente.
  const isDriver = useAuthStore((s) => s.user?.role === 'driver');
  const fallback = isDriver ? '/(driver)/(tabs)/orders' : '/(client)/orders';

  if (isLoading) return <LoadingScreen message="Buscando la cronología…" />;

  if (isError) {
    return (
      <Screen>
        <Header title="Cronología" fallback={fallback} />
        <ErrorState
          title="No pudimos cargar la cronología"
          message="Intenta de nuevo en un momento."
          onRetry={refetch}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Cronología del pedido" fallback={fallback} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {entries.length === 0 ? (
          <Text v="bodyM" tone="textSecondary" center>
            Todavía no hay nada que contar de este pedido.
          </Text>
        ) : (
          entries.map((entry, index) => {
            const last = index === entries.length - 1;
            const at = new Date(entry.at);
            return (
              <View key={`${entry.action}-${entry.at}-${index}`} style={styles.row}>
                <View style={styles.rail}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: entry.incident ? c.error : c.primary },
                    ]}
                  />
                  {!last ? <View style={[styles.line, { backgroundColor: c.border }]} /> : null}
                </View>

                <Card style={styles.entryCard}>
                  <Text v="strongS">{entry.label}</Text>
                  <View style={styles.entryMeta}>
                    <Icon name="reloj" size="sm" color={c.textMuted} />
                    <Text v="caption" tone="textMuted">
                      {at.toLocaleString('es-CO', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </Text>
                  </View>
                  {entry.actor?.name ? (
                    <Text v="caption" tone="textMuted">
                      {ROLE_LABEL[entry.actor.role] ?? entry.actor.role}: {entry.actor.name}
                    </Text>
                  ) : null}
                </Card>
              </View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const ROLE_LABEL: Record<string, string> = {
  client: 'Tú',
  business: 'El negocio',
  driver: 'Tu domiciliario',
  admin: 'Soporte Zipp',
  system: 'Zipp',
};

const styles = StyleSheet.create({
  content: { padding: Spacing.xl, paddingBottom: Spacing.huge },
  row: { flexDirection: 'row', gap: Spacing.md },
  rail: { alignItems: 'center', width: 16 },
  dot: { width: 10, height: 10, borderRadius: BorderRadius.full, marginTop: 6 },
  line: { flex: 1, width: 2, marginTop: 4, marginBottom: 4 },
  entryCard: { flex: 1, marginBottom: Spacing.md, gap: 4 },
  entryMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
