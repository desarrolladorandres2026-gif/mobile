import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, IconButton, EmptyState, Screen, Header } from '../../components/ui';
import { BusinessRow } from '../../components/domain/BusinessCard';
import { useFavoritesStore } from '../../stores/favoritesStore';
import { Spacing, BorderRadius } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

export default function FavoritesScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const { favorites, toggleFavorite } = useFavoritesStore();

  return (
    <Screen style={{ backgroundColor: isDark ? '#0C101C' : '#F1F3F7' }}>
      <Header title="Negocios favoritos" fallback="/(client)/(tabs)/profile" />

      <FlatList
        data={favorites}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          favorites.length > 0 ? (
            <View
              style={[
                styles.infoCard,
                {
                  backgroundColor: c.surface,
                  borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                },
              ]}
            >
              <Text v="bodyM" tone="textSecondary">
                {favorites.length} {favorites.length === 1 ? 'negocio guardado' : 'negocios guardados'}.
                Toca el corazón en cualquier negocio para agregarlo.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View
            style={[
              styles.rowCard,
              {
                backgroundColor: c.surface,
                borderColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
              },
            ]}
          >
            <View style={styles.flex}>
              <BusinessRow
                business={item}
                showStatus={false}
                onPress={() => router.push(`/(client)/business/${item._id}`)}
              />
            </View>
            <IconButton
              icon="favorito"
              label={`Quitar ${item.name} de favoritos`}
              tone="danger"
              filled
              onPress={() => { tap('light'); toggleFavorite(item); }}
            />
          </View>
        )}
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
              icon="favorito"
              title="Sin favoritos todavía"
              message="Guarda los negocios a los que más pides y tenlos siempre a la mano."
              actionLabel="Explorar negocios"
              onAction={() => router.push('/(client)/(tabs)/search')}
            />
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.huge },
  infoCard: {
    padding: Spacing.lg,
    borderRadius: 22,
    borderWidth: 1,
    marginBottom: Spacing.xs,
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: 22,
    borderWidth: 1,
    gap: Spacing.sm,
  },
  emptyCard: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
