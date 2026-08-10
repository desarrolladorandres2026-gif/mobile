import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, IconButton, EmptyState, Screen, Header } from '../../components/ui';
import { BusinessRow } from '../../components/domain/BusinessCard';
import { useFavoritesStore } from '../../stores/favoritesStore';
import { Spacing } from '../../theme/tokens';
import { tap } from '../../lib/haptics';

/**
 * Favoritos.
 *
 * Se guardan en el teléfono, no en el servidor, así que aparecen al instante
 * y funcionan sin señal. Lo que se guarda es una copia ligera del negocio; al
 * tocarlo se abre la ficha con los datos frescos.
 */
export default function FavoritesScreen() {
  const router = useRouter();
  const { favorites, toggleFavorite } = useFavoritesStore();

  return (
    <Screen>
      <Header title="Favoritos" fallback="/(client)/(tabs)/profile" />

      <FlatList
        data={favorites}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          favorites.length > 0 ? (
            <Text v="bodyM" tone="textSecondary" style={styles.intro}>
              {favorites.length} {favorites.length === 1 ? 'negocio guardado' : 'negocios guardados'}.
              Toca el corazón en cualquier negocio para agregarlo.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
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
          <EmptyState
            icon="favorito"
            title="Sin favoritos todavía"
            message="Guarda los negocios a los que más pides y tenlos siempre a la mano."
            actionLabel="Explorar negocios"
            onAction={() => router.push('/(client)/(tabs)/search')}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: Spacing.xl, gap: Spacing.md, paddingBottom: Spacing.huge },
  intro: { marginBottom: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
});
