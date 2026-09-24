import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { businessAccent } from '../../lib/business';
import { categoryIllustration, contentIllustration } from '../illustrations';
import { CollectionHeader } from './CollectionHeader';
import { usePreviewMode } from './explore/PreviewContext';
import { SpotlightCarousel, type SpotlightRenderOpts } from './SpotlightCarousel';
import { tap } from '../../lib/haptics';
import { Spacing } from '../../theme/tokens';
import type { BusinessBannerEntry, CuratedHomeBusiness } from '../../services/endpoints';
import { sizedImageUri, screenWidth } from '../../lib/cloudinaryImage';

/**
 * `businessBanner`: mismo carrusel apilado que `ProductBannerBlock`, pero
 * con tres negocios curados por un admin en vez de tres productos.
 */
export const BusinessBannerBlock = memo(function BusinessBannerBlock({
  entry,
}: { entry: BusinessBannerEntry }) {
  const router = useRouter();
  const preview = usePreviewMode();

  const goToBusiness = useCallback((business: CuratedHomeBusiness) => {
    if (preview) return;
    tap('medium');
    router.push(`/(client)/business/${business._id}`);
  }, [router, preview]);

  if (entry.businesses.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <CollectionHeader
          variant="featured"
          title={entry.title}
          subtitle={entry.subtitle}
          Illustration={contentIllustration('trofeo')}
        />
      </View>
      <SpotlightCarousel
        items={entry.businesses}
        keyExtractor={(business) => business._id}
        accessibilityLabel={(business) => `${business.name}. Calificación ${business.rating.toFixed(1)}`}
        onPressActive={goToBusiness}
        aspect={0.92}
        sizeScale={0.7}
        renderCard={(business, opts) => <BusinessCardContent business={business} opts={opts} />}
      />
    </View>
  );
});

function BusinessCardContent({
  business, opts,
}: { business: CuratedHomeBusiness; opts: SpotlightRenderOpts }) {
  const { c } = useTheme();
  const accent = businessAccent(business._id, business.brandColor);
  const Illustration = categoryIllustration(business.category);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.surface }]}>
      <View style={[styles.image, { backgroundColor: accent }]}>
        {business.coverImage ? (
          <Image
            source={{ uri: sizedImageUri(business.coverImage, screenWidth()) }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            recyclingKey={business._id}
            accessible={false}
          />
        ) : (
          <View style={styles.badgeCircle}>
            <Illustration size={40} />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text v="bodyS" numberOfLines={1} style={styles.name}>{business.name}</Text>
        <View style={styles.metaRow}>
          <Icon name="calificacion" size={11} color={c.warning} />
          <Text v="caption" tone="textMuted">{business.rating.toFixed(1)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl },
  // Mismo margen de título que el resto del inicio; el carrusel se queda a
  // sangre para que los laterales asomen fuera del borde, como `PromoCarousel`.
  header: { paddingHorizontal: Spacing.xl },
  image: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  badgeCircle: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  body: { padding: Spacing.md, gap: 3 },
  name: {},
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
