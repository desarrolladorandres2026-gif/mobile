import { memo, useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { useHomeBanners } from '../../hooks/useApi';
import { hasAction, runBannerAction } from '../../lib/bannerAction';
import { sizedImageUri, screenWidth } from '../../lib/cloudinaryImage';
import { tap } from '../../lib/haptics';
import type { PromoBanner } from '../../services/endpoints';
import { BorderRadius, Motion, Spacing } from '../../theme/tokens';
import { SpotlightCarousel, SpotlightSkeleton, type SpotlightRenderOpts } from './SpotlightCarousel';

/** Cada banner trae su propia duración desde el panel; el de adelante manda. */
const DEFAULT_DURATION = 5;

/**
 * Promociones de la pantalla inicial.
 *
 * No decide nada sobre qué se muestra: pinta, en orden, lo que el servidor
 * ya resolvió que está vigente. Si no hay nada que pintar —lista vacía, sin
 * conexión, API caída, todas las imágenes rotas— devuelve `null` y la
 * sección de Categorías sube sola, sin hueco.
 */
export function PromoCarousel({
  placement = 'home', banners: providedBanners,
}: {
  placement?: 'home' | 'offers';
  /**
   * Banners ya resueltos, para cuando el carrusel se intercala en una
   * posición fija del inicio (`kind: 'promo'` de `/home-sections`, banners
   * con `homeOrder` asignado). Sin esto, el componente pide los suyos
   * propios — el carrusel fijo de siempre, justo después de "Buscar".
   */
  banners?: PromoBanner[];
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { data: fetchedBanners, isLoading: fetching } = useHomeBanners(placement, !providedBanners);
  const banners = providedBanners ?? fetchedBanners;
  const isLoading = providedBanners ? false : fetching;

  // Una imagen que no carga saca a su banner del carrusel en vez de dejar
  // un rectángulo vacío rotando. Se guarda por id, no por índice: si el
  // admin borra un banner mientras la app está abierta, los índices se
  // corren y el fallo se pegaría al banner equivocado.
  const [brokenIds, setBrokenIds] = useState<string[]>([]);
  const markBroken = useCallback((id: string) => {
    setBrokenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const visible = useMemo(
    () => (banners ?? []).filter((b) => !brokenIds.includes(b.id)),
    [banners, brokenIds]
  );

  // Cada banner trae su propia duración desde el panel de admin, así que el
  // temporizador se rearma con la del banner que está al frente en cada vuelta.
  const durationSeconds = useCallback(
    (banner: PromoBanner) => banner.durationSeconds ?? DEFAULT_DURATION,
    []
  );

  const press = useCallback(
    (banner: PromoBanner) => {
      if (!hasAction(banner)) return;
      tap('medium');
      runBannerAction(banner, router);
    },
    [router]
  );

  if (isLoading) {
    return (
      <View style={styles.section}>
        <SpotlightSkeleton width={width} />
      </View>
    );
  }
  if (visible.length === 0) return null;

  return (
    <Animated.View entering={FadeIn.duration(Motion.base)} style={styles.section}>
      <SpotlightCarousel
        items={visible}
        keyExtractor={(banner) => banner.id}
        accessibilityLabel={(banner) => banner.title || 'Promoción de Zipp'}
        onPressActive={press}
        durationSeconds={durationSeconds}
        renderCard={(banner, opts) => (
          <PromoCardContent banner={banner} opts={opts} onBroken={markBroken} />
        )}
      />
    </Animated.View>
  );
}

function PromoCardContent({
  banner, opts, onBroken,
}: { banner: PromoBanner; opts: SpotlightRenderOpts; onBroken: (id: string) => void }) {
  const { c } = useTheme();
  const { front } = opts;
  const hasCaption = !!(banner.title || banner.description || banner.buttonText);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.surface }]}>
      <Image
        // Al ancho de la pantalla, que es el techo de la tarjeta: el banner
        // se guarda a 1080 px en el formato que se subió, y `sizedImageUri`
        // lo reduce y lo entrega en WebP/AVIF.
        source={{ uri: sizedImageUri(banner.imageUrl, screenWidth()) }}
        style={StyleSheet.absoluteFill}
        // La imagen llena la tarjeta sin deformarse, venga vertical,
        // cuadrada o panorámica desde el panel.
        contentFit="cover"
        // Memoria y disco: la misma promoción no se vuelve a descargar en
        // cada arranque ni en cada vuelta del carrusel.
        cachePolicy="memory-disk"
        recyclingKey={banner.id}
        transition={Motion.base}
        onError={() => onBroken(banner.id)}
        accessible={false}
      />

      {hasCaption ? (
        <LinearGradient
          colors={['transparent', 'rgba(8,11,20,0.55)', 'rgba(8,11,20,0.92)']}
          locations={[0.25, 0.6, 1]}
          style={styles.scrim}
        >
          {banner.title ? (
            <Text v="titleM" color="#FFFFFF" numberOfLines={1}>{banner.title}</Text>
          ) : null}
          {banner.description ? (
            <Text v="bodyS" color="rgba(255,255,255,0.84)" numberOfLines={1}>
              {banner.description}
            </Text>
          ) : null}
          {banner.buttonText ? (
            <View style={[styles.cta, { backgroundColor: c.warning }]}>
              <Text v="strongS" color={c.black} numberOfLines={1}>{banner.buttonText}</Text>
              <Icon name="adelante" size={14} color={c.black} />
            </View>
          ) : null}
        </LinearGradient>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: Spacing.xxxl },

  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: Spacing.md,
    gap: 2,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.xs,
    marginTop: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
  },
});
