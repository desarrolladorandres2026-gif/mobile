import { useEffect, type ReactNode } from 'react';
import { View, StyleSheet, type ViewStyle, type DimensionValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  withSequence, withDelay, Easing, FadeIn, SlideInUp, SlideOutUp,
} from 'react-native-reanimated';
import { Text } from './Text';
import { Icon } from './Icon';
import { Button } from './Button';
import { TrazoLoader } from '../brand/Trazo';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Motion, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

// ──────────────────────────────────────────────────────────────
// Vacío
// ──────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  /** Qué hacer ahora. Una pantalla vacía es una invitación, no un aviso. */
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

export function EmptyState({
  icon, title, message, actionLabel, onAction, compact,
}: EmptyStateProps) {
  const { c } = useTheme();

  return (
    <Animated.View
      entering={FadeIn.duration(Motion.base)}
      style={[styles.state, compact && styles.stateCompact]}
    >
      <View style={[styles.stateIcon, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Icon name={icon} size={28} color={c.textMuted} />
      </View>
      <Text v="titleL" center>{title}</Text>
      <Text v="bodyM" tone="textSecondary" center style={styles.stateMessage}>{message}</Text>
      {actionLabel && onAction ? (
        <Button title={actionLabel} onPress={onAction} style={styles.stateAction} />
      ) : null}
    </Animated.View>
  );
}

// ──────────────────────────────────────────────────────────────
// Error
// ──────────────────────────────────────────────────────────────

/**
 * Algo falló y se puede reintentar.
 *
 * Dice qué pasó y ofrece la salida. Sin disculpas y sin culpar al usuario:
 * lo que necesita es el botón de reintentar, no una explicación larga.
 */
export function ErrorState({
  title = 'No pudimos cargar esto',
  message = 'Revisa tu conexión y vuelve a intentarlo.',
  onRetry,
}: { title?: string; message?: string; onRetry?: () => void }) {
  const { c } = useTheme();

  return (
    <Animated.View entering={FadeIn.duration(Motion.base)} style={styles.state}>
      <View style={[styles.stateIcon, { backgroundColor: c.errorSoft, borderColor: 'transparent' }]}>
        <Icon name="alerta" size={28} color={c.error} />
      </View>
      <Text v="titleL" center>{title}</Text>
      <Text v="bodyM" tone="textSecondary" center style={styles.stateMessage}>{message}</Text>
      {onRetry ? (
        <Button
          title="Reintentar"
          icon="reintentar"
          variant="secondary"
          onPress={onRetry}
          style={styles.stateAction}
        />
      ) : null}
    </Animated.View>
  );
}

/** Aviso en línea. Para bloqueos que el usuario puede resolver sin salir. */
export function Notice({
  tone = 'warning', icon, children,
}: { tone?: 'warning' | 'error' | 'info' | 'lime'; icon?: IconName; children: ReactNode }) {
  const { c } = useTheme();

  const skin = {
    warning: { bg: c.warningSoft, fg: c.warningText, icon: 'alerta' as IconName },
    error: { bg: c.errorSoft, fg: c.errorText, icon: 'error' as IconName },
    info: { bg: c.primarySoft, fg: c.primaryText, icon: 'info' as IconName },
    lime: { bg: c.limeSoft, fg: c.limeText, icon: 'checkCirculo' as IconName },
  }[tone];

  return (
    <View style={[styles.notice, { backgroundColor: skin.bg }]}>
      <Icon name={icon ?? skin.icon} size="md" color={skin.fg} />
      <View style={styles.noticeBody}>
        {typeof children === 'string' ? (
          <Text v="bodyS" color={skin.fg}>{children}</Text>
        ) : children}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Carga
// ──────────────────────────────────────────────────────────────

/**
 * Bloque fantasma con brillo.
 *
 * Se prefiere sobre un spinner cuando ya sabemos la forma de lo que viene:
 * la página no salta al llegar los datos, y la espera se siente más corta
 * porque el usuario ya ve la estructura.
 */
export function Skeleton({
  width = '100%', height = 16, radius = BorderRadius.sm, style,
}: { width?: DimensionValue; height?: number; radius?: number; style?: ViewStyle }) {
  const { c } = useTheme();
  const shimmer = useSharedValue(0.4);

  useEffect(() => {
    shimmer.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
  }, []);

  const animated = useAnimatedStyle(() => ({ opacity: shimmer.value }));

  return (
    <Animated.View
      style={[{ width, height, borderRadius: radius, backgroundColor: c.skeleton }, animated, style]}
    />
  );
}

/** Fantasma de una tarjeta de negocio en la lista. */
export function BusinessCardSkeleton() {
  const { c } = useTheme();
  return (
    <View style={[styles.skelCard, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Skeleton width={64} height={64} radius={BorderRadius.md} />
      <View style={styles.skelBody}>
        <Skeleton width="62%" height={17} />
        <Skeleton width="86%" height={13} />
      </View>
    </View>
  );
}

/** Carga a pantalla completa. Solo cuando no hay forma que anticipar. */
export function LoadingScreen({ message }: { message?: string }) {
  const { c } = useTheme();
  return (
    <View style={[styles.loading, { backgroundColor: c.background }]}>
      <TrazoLoader width={120} />
      {message ? <Text v="bodyS" tone="textMuted">{message}</Text> : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Sin conexión
// ──────────────────────────────────────────────────────────────

/**
 * Banda de conexión perdida.
 *
 * Entra desde arriba y se queda: en una app donde el pedido cambia de estado
 * en vivo, saber que dejaste de recibir novedades importa tanto como las
 * novedades mismas.
 */
export function OfflineBanner({ visible }: { visible: boolean }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();

  // Se monta solo cuando aplica, y entra y sale con las animaciones de layout
  // de Reanimated. La versión anterior vivía siempre montada y se escondía
  // desplazándose una distancia fija: como esa distancia era menor que su
  // altura real, dejaba una franja amarilla asomada de forma permanente.
  if (!visible) return null;

  return (
    <Animated.View
      entering={SlideInUp.duration(Motion.base)}
      exiting={SlideOutUp.duration(Motion.fast)}
      // El fondo llega hasta el borde de la pantalla, pero el texto arranca
      // debajo de la barra de estado, con la medida real del dispositivo en
      // vez de un valor fijo que solo acierta en algunos teléfonos.
      style={[
        styles.offline,
        { backgroundColor: c.warning, paddingTop: insets.top + Spacing.sm },
      ]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
    >
      <Icon name="sinConexion" size="sm" color={c.black} />
      <Text v="captionStrong" color={c.black}>
        Sin conexión. Reintentando…
      </Text>
    </Animated.View>
  );
}

/**
 * Aviso de que la PWA ya descargó una versión nueva (solo web).
 *
 * No recarga sola: el usuario puede estar a mitad de un pedido o escribiendo
 * una dirección, y recargar sin avisar le borraría eso. Le dejamos elegir el
 * momento con "Actualizar", o cerrar el aviso con "Luego" y seguir.
 */
export function UpdateBanner({
  visible, onUpdate, onDismiss,
}: { visible: boolean; onUpdate: () => void; onDismiss: () => void }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  return (
    <Animated.View
      entering={SlideInUp.duration(Motion.base)}
      exiting={SlideOutUp.duration(Motion.fast)}
      style={[
        styles.update,
        {
          backgroundColor: c.surfaceRaised,
          borderBottomColor: c.border,
          paddingTop: insets.top + Spacing.sm,
        },
      ]}
      accessibilityLiveRegion="polite"
    >
      <Text v="bodyS" style={styles.updateText}>
        Hay una versión nueva de Zipp.
      </Text>
      <Button title="Luego" variant="ghost" size="sm" haptic="none" onPress={onDismiss} />
      <Button title="Actualizar" size="sm" onPress={onUpdate} />
    </Animated.View>
  );
}

// ──────────────────────────────────────────────────────────────
// Éxito
// ──────────────────────────────────────────────────────────────

/** Marca de verificación que entra con rebote. El premio de una acción cumplida. */
export function SuccessCheck({ size = 72, delay = 0 }: { size?: number; delay?: number }) {
  const { c } = useTheme();
  const scale = useSharedValue(0);

  useEffect(() => {
    scale.value = withDelay(
      delay,
      withSequence(
        withTiming(1.15, { duration: 280, easing: Easing.out(Easing.back(2.4)) }),
        withTiming(1, { duration: 140 })
      )
    );
  }, []);

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      style={[
        {
          width: size, height: size, borderRadius: size / 2,
          backgroundColor: c.lime, alignItems: 'center', justifyContent: 'center',
        },
        animated,
      ]}
    >
      <Icon name="check" size={size * 0.5} color={c.textOnLime} strong />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  state: {
    alignItems: 'center',
    paddingVertical: Spacing.huge,
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.sm,
  },
  stateCompact: { paddingVertical: Spacing.xxl },
  stateIcon: {
    width: 76, height: 76, borderRadius: BorderRadius.xl,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginBottom: Spacing.sm,
  },
  stateMessage: { maxWidth: 300 },
  stateAction: { marginTop: Spacing.lg },

  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md + 2,
    borderRadius: BorderRadius.lg,
  },
  noticeBody: { flex: 1 },

  skelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
  },
  skelBody: { flex: 1, gap: Spacing.sm },

  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg },

  offline: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingBottom: Spacing.sm + 2,
    paddingHorizontal: Spacing.lg,
  },
  update: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 101,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingBottom: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  updateText: { flex: 1 },
});
