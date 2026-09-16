import { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Pressable, Alert, Linking } from 'react-native';
import Animated, {
  useAnimatedStyle, useSharedValue, withRepeat, withTiming, withSequence, Easing,
} from 'react-native-reanimated';
import { Text, Icon, Sheet, Button } from '../ui';
import { useTheme } from '../../hooks/useTheme';
import { useDriverProfile } from '../../hooks/useApi';
import { sosApi } from '../../services/endpoints';
import { socketService } from '../../services/socket';
import { captureCurrentPosition } from '../../hooks/useLocation';
import { tap } from '../../lib/haptics';
import { Spacing, BorderRadius } from '../../theme/tokens';

/**
 * Botón de pánico del domiciliario.
 *
 * Repartir de noche en moto tiene riesgos reales, y la app ya sabe dónde
 * está esta persona: el seguimiento está montado y el mapa de flota
 * funciona. Esto es la forma de decir "esto no es un pedido, esto es una
 * emergencia".
 *
 * Vive como una fila más dentro de Perfil → Ayuda y legal, no como un FAB
 * flotante sobre toda la app. Un botón rojo siempre a la vista en cada
 * pantalla resultaba más alarmante que útil, y activarlo por accidente
 * (con el pulgar, sacando el teléfono del bolsillo) era demasiado fácil.
 * El coste es real —hay que entrar al perfil para usarlo— pero es el
 * mismo lugar donde ya vive el contacto de emergencia, así que no es un
 * sitio inesperado para buscarlo.
 *
 * Tres decisiones que gobiernan el resto del diseño:
 *
 * 1. **Mantener pulsado, no un toque.** Un botón rojo grande que se activa
 *    con un roce en el bolsillo genera falsas alarmas hasta que nadie las
 *    mira, y entonces deja de servir para lo único que existe.
 * 2. **Si falla la red, se dice.** Nada de reintentos silenciosos: quien
 *    cree que ya avisó a alguien no llama al 123.
 * 3. **La ubicación no bloquea.** Si el GPS tarda, la alerta sale igual con
 *    la última posición conocida. Una alerta sin coordenadas exactas vale
 *    infinitamente más que ninguna alerta.
 */

/** Cuánto hay que mantener pulsado. Suficiente para no ser un accidente. */
const HOLD_MS = 1500;

export function SosButton() {
  const { c } = useTheme();
  const { data: driverProfile } = useDriverProfile();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const progress = useSharedValue(0);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (!sent) return;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 600, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 600, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );
  }, [sent, pulse]);

  // Saber que alguien la vio es la diferencia entre pulsar un botón y
  // pulsar un botón que sirve para algo.
  useEffect(() => {
    const handle = () => { tap('success'); setAcknowledged(true); };
    socketService.getSocket()?.on('sos:acknowledged', handle);
    return () => { socketService.getSocket()?.off('sos:acknowledged', handle); };
  }, []);

  /**
   * El cierre de la alerta tampoco se escuchaba.
   *
   * El backend emite `sos:resolved` (`sos.service.ts:147`) desde siempre;
   * solo `sos:acknowledged` tenía oyente. Sin esto, la hoja se quedaba
   * mostrando "Ya te están atendiendo" para siempre, aunque el equipo ya
   * hubiera cerrado el caso — el domiciliario nunca sabía que podía dejar
   * de esperar.
   */
  useEffect(() => {
    const handle = () => {
      tap('success');
      setSent(false);
      setAcknowledged(false);
      setSheetOpen(false);
    };
    socketService.getSocket()?.on('sos:resolved', handle);
    return () => { socketService.getSocket()?.off('sos:resolved', handle); };
  }, []);

  const fireAlert = useCallback(async () => {
    try {
      setSending(true);

      // No se espera al GPS más de lo razonable: si tarda, sale con lo que
      // haya. El servidor prefiere una alerta con posición aproximada.
      let coords: { lat: number; lng: number } | null = null;
      try {
        const result = await captureCurrentPosition();
        if (result.ok) {
          coords = { lat: result.position.latitude, lng: result.position.longitude };
        }
      } catch {
        // Sin ubicación: la alerta sale igual.
      }

      await sosApi.trigger(coords?.lat ?? 0, coords?.lng ?? 0);

      tap('success');
      setSent(true);
    } catch {
      // Se dice en voz alta y se ofrece la salida real. Quien cree que ya
      // avisó a alguien no llama a emergencias.
      Alert.alert(
        'No pudimos enviar la alerta',
        'Revisa tu conexión. Si estás en peligro, llama al 123 ahora.',
        [
          { text: 'Cerrar', style: 'cancel' },
          { text: 'Llamar al 123', onPress: () => Linking.openURL('tel:123') },
        ]
      );
    } finally {
      setSending(false);
    }
  }, []);

  const startHold = useCallback(() => {
    tap('warning');
    progress.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear });
  }, [progress]);

  const cancelHold = useCallback(() => {
    progress.value = withTiming(0, { duration: 180 });
  }, [progress]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  const hasContact = !!driverProfile?.emergencyContact?.phone;

  return (
    <>
      <Pressable
        onPress={() => { tap('light'); setSheetOpen(true); }}
        accessibilityRole="button"
        accessibilityLabel={sent ? 'Emergencia activa' : 'Botón de emergencia'}
        accessibilityHint="Abre el botón de pánico"
        style={({ pressed }) => [styles.menuRow, pressed && { opacity: 0.7 }]}
      >
        <View style={[styles.menuIcon, { backgroundColor: c.error + '1A' }]}>
          <Animated.View style={sent ? pulseStyle : undefined}>
            <Icon name="alerta" size="md" color={c.error} />
          </Animated.View>
        </View>
        <View style={styles.flex}>
          <Text v="strongS" color={c.error}>
            {sent ? 'Emergencia en curso' : 'Botón de emergencia'}
          </Text>
          <Text v="caption" tone="textMuted">
            {sent
              ? (acknowledged ? 'El equipo ya te está atendiendo' : 'Avisando al equipo…')
              : 'Mantén pulsado si algo va mal en el reparto'}
          </Text>
        </View>
        <Icon name="siguiente" size="sm" color={c.textMuted} />
      </Pressable>

      <Sheet
        visible={sheetOpen}
        onClose={() => { setSheetOpen(false); setSent(false); setAcknowledged(false); }}
        title={sent ? 'Alerta enviada' : 'Emergencia'}
        height={0.6}
        scroll={false}
      >
        <View style={styles.body}>
          {sent ? (
            <>
              <View style={[styles.statusDot, { backgroundColor: acknowledged ? c.lime : c.error }]} />
              <Text v="titleM" center>
                {acknowledged ? 'Ya te están atendiendo' : 'Avisando al equipo…'}
              </Text>
              <Text v="bodyM" tone="textSecondary" center>
                {acknowledged
                  ? 'Alguien del equipo vio tu alerta y está en ello. Mantén el teléfono a mano.'
                  : 'Estamos viendo tu ubicación en vivo. Si puedes, quédate donde estás.'}
              </Text>

              <Button
                title="Llamar al 123"
                icon="llamar"
                variant="secondary"
                style={styles.action}
                onPress={() => { tap('medium'); Linking.openURL('tel:123'); }}
              />
            </>
          ) : (
            <>
              <Text v="bodyM" tone="textSecondary" center>
                Mantén pulsado el botón durante un segundo y medio. Enviaremos tu
                ubicación al equipo de ZIPP.
              </Text>

              {!hasContact ? (
                // Encadenado al paso que falta en vez de deshabilitado: el
                // botón funciona igual, pero se avisa de que nadie más
                // recibirá la alerta.
                <Text v="caption" tone="warning" center>
                  No tienes contacto de emergencia. Agrégalo en tu perfil para que
                  también podamos avisar a alguien tuyo.
                </Text>
              ) : null}

              <Pressable
                onPressIn={startHold}
                onPressOut={cancelHold}
                onLongPress={fireAlert}
                delayLongPress={HOLD_MS}
                style={[styles.holdButton, { backgroundColor: c.error }]}
                accessibilityRole="button"
                accessibilityLabel="Mantén pulsado para pedir ayuda"
              >
                <Animated.View style={[styles.holdFill, fillStyle]} />
                <Text v="buttonLg" color="#FFFFFF">
                  {sending ? 'Enviando…' : 'Mantén pulsado'}
                </Text>
              </Pressable>

              <Text v="caption" tone="textMuted" center>
                Si estás en peligro inmediato, llama al 123 primero.
              </Text>
            </>
          )}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
  },
  menuIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  flex: { flex: 1 },
  body: { gap: Spacing.lg, paddingTop: Spacing.md, alignItems: 'center' },
  statusDot: { width: 14, height: 14, borderRadius: 7 },
  holdButton: {
    width: '100%',
    height: 64,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  holdFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  action: { width: '100%' },
});
