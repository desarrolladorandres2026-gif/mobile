import { useEffect, useMemo, useRef } from 'react';
import { Animated, View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { adsApi, type ActiveAd } from '../../services/endpoints';
import { getDeviceId } from '../../lib/deviceId';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

interface AdSplashProps {
  ad: ActiveAd;
  /** La pantalla de carga sigue su curso normal: navegar a login/home/etc. */
  onDone: () => void;
}

/**
 * Publicidad patrocinada en la pantalla de carga.
 *
 * Se muestra a pantalla completa durante `ad.durationSeconds` (5s por
 * defecto) y luego llama a `onDone` sola — el arranque de ZIPP nunca
 * depende de que la persona la cierre a mano. Tocar el flyer navega al
 * negocio de inmediato si la campaña lo define; el botón de cerrar hace
 * lo mismo que dejarla correr, solo que antes.
 */
export function AdSplash({ ad, onDone }: AdSplashProps) {
  const { c } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const finished = useRef(false);

  const finish = (action?: 'business') => {
    if (finished.current) return;
    finished.current = true;
    if (action === 'business' && ad.businessId) {
      router.replace(`/(client)/business/${ad.businessId}`);
    } else {
      onDone();
    }
  };

  useEffect(() => {
    // Cuenta como impresión lo que de verdad se pintó, no lo que se
    // descargó — igual que la publicidad de banners de inicio.
    getDeviceId().then((deviceId) => {
      adsApi.registerImpression(ad.id, deviceId).catch(() => {});
    });

    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: ad.durationSeconds * 1000,
      useNativeDriver: false,
    });
    animation.start(({ finished: completed }) => {
      if (completed) finish();
    });

    return () => animation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad.id]);

  const barWidth = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
    [progress]
  );

  const close = () => {
    tap('light');
    finish();
  };

  const handlePress = () => {
    tap('medium');
    getDeviceId().then((deviceId) => {
      adsApi.registerClick(ad.id, deviceId).catch(() => {});
    });

    if (ad.actionType === 'business' && ad.businessId) {
      finish('business');
    } else {
      finish();
    }
  };

  return (
    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: c.background }]}>
      <Pressable
        onPress={handlePress}
        style={{ width, height }}
        accessibilityRole="button"
        accessibilityLabel={`Publicidad: ${ad.campaignName}`}
      >
        <Image
          source={{ uri: ad.flyerUrl }}
          style={StyleSheet.absoluteFillObject}
          // Regla de flyers: siempre a pantalla completa, sin deformar y sin
          // márgenes. `cover` (igual que object-fit: cover en la web) escala
          // manteniendo proporción y recorta solo el sobrante de los bordes
          // — nunca estira la imagen ni dibuja un fondo alrededor.
          contentFit="cover"
          transition={200}
        />
      </Pressable>

      <View style={[styles.progressTrack, { top: insets.top + Spacing.sm }]}>
        <Animated.View style={[styles.progressFill, { width: barWidth }]} />
      </View>

      <View style={[styles.badge, { top: insets.top + Spacing.lg }]}>
        <Text v="dataS" color="#FFFFFF" style={styles.badgeText}>Publicidad</Text>
      </View>

      <Pressable
        onPress={close}
        style={[styles.closeBtn, { top: insets.top + Spacing.lg }]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Cerrar publicidad"
      >
        <Icon name="cerrar" size="md" color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  progressTrack: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    height: 3,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.35)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: BorderRadius.full,
    backgroundColor: '#FFFFFF',
  },
  badge: {
    position: 'absolute',
    left: Spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: BorderRadius.sm,
  },
  badgeText: { textTransform: 'uppercase', letterSpacing: 0.6 },
  closeBtn: {
    position: 'absolute',
    right: Spacing.lg,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
