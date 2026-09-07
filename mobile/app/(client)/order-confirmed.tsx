import { useEffect } from 'react';
import { View, StyleSheet, Share, BackHandler } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Text, Button, SuccessCheck, Screen } from '../../components/ui';
import { TrazoDivider } from '../../components/brand/Trazo';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { orderCode } from '../../lib/format';
import { tap } from '../../lib/haptics';

/**
 * Pedido confirmado.
 *
 * Es el momento que la gente quiere mostrar, así que se le da pantalla
 * completa en vez de un aviso que se va solo. El número queda grande y en
 * mono porque es lo que se dicta por teléfono cuando algo se complica.
 *
 * No se puede volver atrás con gesto ni con el botón físico: retroceder
 * llevaría a un checkout de un pedido que ya se creó.
 */
export default function OrderConfirmedScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const { id, code } = useLocalSearchParams<{ id: string; code?: string }>();

  const reference = code || orderCode(id);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const share = async () => {
    tap('light');
    try {
      await Share.share({
        message: `Acabo de pedir por Zipp. Pedido ${reference}.`,
      });
    } catch {
      // Cancelar la hoja de compartir no es un error.
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.container}>
        <Animated.View entering={FadeIn.duration(300)}>
          <SuccessCheck size={96} delay={120} />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(320).duration(420)} style={styles.copy}>
          <Text v="displayL" center>¡Listo!{'\n'}Ya está pedido</Text>
          <Text v="bodyL" tone="textSecondary" center>
            Le avisamos al local. En cuanto lo acepten te lo contamos aquí mismo.
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.delay(480).duration(420)}
          style={[styles.ticket, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <Text v="label" tone="textMuted">TU PEDIDO</Text>
          <Text v="dataXL" tone="primaryText">{reference}</Text>
          <TrazoDivider />
          <Text v="caption" tone="textMuted" center>
            Guarda este número por si necesitas hablar con el local o con soporte.
          </Text>
        </Animated.View>
      </View>

      <Animated.View entering={FadeInDown.delay(620).duration(400)} style={styles.actions}>
        <Button
          title="Seguir mi pedido"
          icon="ruta"
          size="lg"
          full
          onPress={() => router.replace({ pathname: '/(client)/order-tracking', params: { id } })}
          haptic="medium"
        />
        <View style={styles.secondary}>
          <Button title="Compartir" icon="compartir" variant="secondary" style={styles.flex} onPress={share} />
          <Button
            title="Al inicio"
            variant="secondary"
            style={styles.flex}
            onPress={() => router.replace('/(client)/(tabs)/home')}
          />
        </View>
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.xxl,
  },
  copy: { gap: Spacing.md, alignItems: 'center' },
  ticket: {
    alignItems: 'center',
    gap: Spacing.sm,
    alignSelf: 'stretch',
    padding: Spacing.xl,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  actions: { padding: Spacing.xl, gap: Spacing.md },
  secondary: { flexDirection: 'row', gap: Spacing.md },
});
