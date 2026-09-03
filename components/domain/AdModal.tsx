import { useEffect, useRef, useState } from 'react';
import { Modal, View, Pressable, StyleSheet, Linking, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Text, Icon } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { useActiveAd } from '../../hooks/useApi';
import { adsApi } from '../../services/endpoints';
import { getDeviceId } from '../../lib/deviceId';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * Publicidad patrocinada al abrir la app.
 *
 * Se monta siempre, en paralelo a la navegación — nunca retrasa a dónde va
 * el usuario. Si no hay campaña activa, o la consulta falla, no renderiza
 * nada: la app arranca normal, sin espacios vacíos.
 */
export function AdModal() {
  const { c } = useTheme();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const { data: ad } = useActiveAd(true);

  const [visible, setVisible] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const trackedImpression = useRef<string | null>(null);

  useEffect(() => {
    setVisible(!!ad && ad.id !== dismissedId);
  }, [ad, dismissedId]);

  if (!ad) return null;

  const dismiss = () => setDismissedId(ad.id);

  const close = () => {
    tap('light');
    dismiss();
  };

  // Se llama desde onShow del Modal nativo: solo cuenta como impresión lo
  // que el usuario realmente vio en pantalla, no lo que la app descargó.
  const handleShown = () => {
    if (trackedImpression.current === ad.id) return;
    trackedImpression.current = ad.id;
    getDeviceId().then((deviceId) => {
      adsApi.registerImpression(ad.id, deviceId).catch(() => {});
    });
  };

  const handlePress = () => {
    tap('medium');
    getDeviceId().then((deviceId) => {
      adsApi.registerClick(ad.id, deviceId).catch(() => {});
    });

    dismiss();

    if (ad.actionType === 'url' && ad.actionUrl) {
      Linking.openURL(ad.actionUrl).catch(() => {});
    } else if (ad.actionType === 'business' && ad.businessId) {
      router.push(`/(client)/business/${ad.businessId}`);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
      onShow={handleShown}
    >
      <View style={[styles.overlay, { backgroundColor: c.overlay }]}>
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
        />

        <View style={{ width: width * 0.88, maxWidth: 420 }}>
          <Pressable
            onPress={handlePress}
            style={[styles.flyerWrap, { height: height * 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={`Publicidad: ${ad.campaignName}`}
          >
            <Image
              source={{ uri: ad.flyerUrl }}
              style={StyleSheet.absoluteFillObject}
              contentFit="contain"
              transition={200}
            />

            <View style={styles.badge}>
              <Text v="dataS" color="#FFFFFF" style={styles.badgeText}>Publicidad</Text>
            </View>

            <Pressable
              onPress={close}
              style={styles.closeBtn}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cerrar publicidad"
            >
              <Icon name="cerrar" size="md" color="#FFFFFF" />
            </Pressable>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  flyerWrap: {
    width: '100%',
    borderRadius: BorderRadius.lg,
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  badge: {
    position: 'absolute',
    top: Spacing.md,
    left: Spacing.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: BorderRadius.sm,
  },
  badgeText: { textTransform: 'uppercase', letterSpacing: 0.6 },
  closeBtn: {
    position: 'absolute',
    top: Spacing.md,
    right: Spacing.md,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
