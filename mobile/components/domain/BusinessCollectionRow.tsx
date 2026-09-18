import { memo, useCallback } from 'react';
import { View, Pressable, FlatList, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { businessAccent } from '../../lib/business';
import { categoryIllustration, contentIllustration } from '../illustrations';
import { CollectionHeader } from './CollectionHeader';
import { minutes } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import type { BusinessCollectionEntry, CuratedHomeBusiness } from '../../services/endpoints';

const CARD_WIDTH = 195;

/**
 * `businessCollection`: fila horizontal de negocios curados por un admin —
 * mismo patrón visual y de scroll que `ProductCollectionRow`, pero con
 * tarjetas de negocio (portada, nombre, categoría, calificación, tiempo de
 * entrega) en vez de tarjetas de producto.
 */
export const BusinessCollectionRow = memo(function BusinessCollectionRow({
  entry,
}: { entry: BusinessCollectionEntry }) {
  const router = useRouter();

  const goToBusiness = useCallback((business: CuratedHomeBusiness) => {
    tap('medium');
    router.push(`/(client)/business/${business._id}`);
  }, [router]);

  if (entry.businesses.length === 0) return null;

  return (
    <View style={styles.section}>
      <CollectionHeader
        variant="minimal"
        title={entry.title}
        subtitle={entry.subtitle}
        Illustration={contentIllustration('trofeo')}
      />
      <FlatList
        horizontal
        data={entry.businesses}
        keyExtractor={(item) => item._id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.hList}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        windowSize={9}
        initialNumToRender={6}
        renderItem={({ item }) => (
          <BusinessCollectionCard business={item} onPress={() => goToBusiness(item)} />
        )}
      />
    </View>
  );
});

const BusinessCollectionCard = memo(function BusinessCollectionCard({
  business, onPress,
}: { business: CuratedHomeBusiness; onPress: () => void }) {
  const { c } = useTheme();
  const accent = businessAccent(business._id, business.brandColor);
  const Illustration = categoryIllustration(business.category);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${business.name}, ${minutes(business.deliveryTime)}, calificación ${business.rating.toFixed(1)}`}
      accessibilityHint="Abre el perfil del negocio"
      style={[styles.card, { width: CARD_WIDTH }]}
    >
      <View style={[styles.image, { backgroundColor: accent }]}>
        {business.coverImage ? (
          <Image
            source={{ uri: business.coverImage }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            recyclingKey={business._id}
            accessible={false}
          />
        ) : (
          <View style={styles.badgeCircle}>
            <Illustration size={34} />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text v="bodyS" numberOfLines={1} style={styles.name}>{business.name}</Text>
        <View style={styles.metaRow}>
          <View style={styles.rating}>
            <Icon name="calificacion" size={11} color={c.warning} />
            <Text v="caption" tone="textMuted">{business.rating.toFixed(1)}</Text>
          </View>
          {business.deliveryTime > 0 ? (
            <View style={styles.rating}>
              <Icon name="domiciliario" size={11} color={c.text} />
              <Text v="captionStrong" tone="text">{minutes(business.deliveryTime)}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl, paddingHorizontal: Spacing.xl },
  hList: { gap: Spacing.md, paddingRight: Spacing.xl },
  card: {
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
  },
  image: { width: '100%', height: 120, alignItems: 'center', justifyContent: 'center' },
  badgeCircle: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    ...Shadow.sm,
  },
  body: { padding: Spacing.sm, gap: 3 },
  name: { minHeight: 18 },
  metaRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: 1 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
