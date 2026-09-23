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
import {
  contentIllustration,
  illustrationForIcon,
  type ContentIllustrationName,
} from '../illustrations';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Motion, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';

// ──────────────────────────────────────────────────────────────
// Vacío
// ──────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  icon: IconName;
  /**
   * Fuerza una ilustración concreta. Casi nunca hace falta: el `icon` ya
   * resuelve la suya cuando el concepto la tiene. Úsala solo cuando el icono
   * correcto y la ilustración correcta no sean el mismo concepto.
   */
  illustration?: ContentIllustrationName;
  title: string;
  /** Qué hacer ahora. Una pantalla vacía es una invitación, no un aviso. */
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

export function EmptyState({
  icon, illustration, title, message, actionLabel, onAction, compact,
}: EmptyStateProps) {
  const { c } = useTheme();

  // Una pantalla vacía es la peor primera impresión posible: es el único
  // momento en que la app no tiene contenido con el que defenderse. Por eso
  // se prefiere la ilustración propia al glifo genérico siempre que exista.
  const Illustration = illustration
    ? contentIllustration(illustration)
    : illustrationForIcon(icon);

  return (
    <Animated.View
      entering={FadeIn.duration(Motion.base)}
      style={[styles.state, compact && styles.stateCompact]}
    >
      {Illustration ? (
        // Sin cuadro: la ilustración ya trae su propio halo y encerrarla
        // dibujaría dos fondos concéntricos.
        <View style={styles.stateArt}>
          <Illustration size={88} />
        </View>
      ) : (
        <View style={[styles.stateIcon, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Icon name={icon} size={28} color={c.textMuted} />
        </View>
      )}
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
/**
 * ¿Son solo textos? JSX con interpolaciones (`Faltan {money(x)} más`) no llega
 * como un string sino como un arreglo de strings; RN no admite texto suelto
 * dentro de un `View`, así que ese caso también hay que envolverlo en `Text`.
 */
const isPlainText = (node: ReactNode): boolean =>
  typeof node === 'string' ||
  typeof node === 'number' ||
  (Array.isArray(node) && node.every((part) => typeof part === 'string' || typeof part === 'number'));

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
        {isPlainText(children) ? (
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

/**
 * Fantasma de una tarjeta de negocio en la lista.
 *
 * Copia la silueta real de `BusinessRow` —foto ancha arriba, insignia del
 * logo superpuesta, nombre y meta debajo— y no la fila delgada de antes:
 * si el fantasma es más bajo que la tarjeta que reemplaza, la lista da un
 * salto hacia abajo justo cuando llegan los datos.
 */
export function BusinessCardSkeleton() {
  const { c } = useTheme();
  return (
    <View style={[styles.skelCard, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Skeleton width="100%" height={140} radius={0} />
      <View style={[styles.skelLogoRing, { backgroundColor: c.surface }]}>
        <Skeleton width={44} height={44} radius={22} />
      </View>
      <View style={styles.skelBody}>
        <Skeleton width="62%" height={17} />
        <Skeleton width="40%" height={13} />
      </View>
    </View>
  );
}

/**
 * Fantasma de una fila de resultado.
 *
 * Copia la silueta de `BusinessResultRow` —distintivo cuadrado, dos líneas de
 * texto, la columna de datos a la derecha— y no la tarjeta de Inicio. Buscar
 * enseñaba cuatro fantasmas con portada de 140 px para una lista de filas de
 * 88: al llegar los datos, lo que se ve es un salto.
 */
export function BusinessResultRowSkeleton() {
  const { c } = useTheme();
  return (
    <View style={[styles.skelResult, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Skeleton width={64} height={64} radius={BorderRadius.md} />
      <View style={styles.skelResultBody}>
        <Skeleton width="58%" height={17} />
        <Skeleton width="34%" height={13} />
      </View>
      <View style={styles.skelResultData}>
        <Skeleton width={34} height={14} />
        <Skeleton width={46} height={12} />
      </View>
    </View>
  );
}

/**
 * Fantasma de un tiquete de cupón.
 *
 * Copia la silueta real de `TicketCard` —magnitud grande arriba, corte a la
 * mitad, código en el talón— y no una tarjeta genérica. Un esqueleto que no
 * se parece a lo que viene no reserva sitio, solo entretiene: la pestaña de
 * Descuentos enseñaba tres fantasmas de negocio en vertical para un feed
 * que empieza con tiquetes en horizontal, y al llegar los datos se
 * reorganizaba entera.
 */
export function CouponCardSkeleton({ width = 244 }: { width?: DimensionValue }) {
  const { c } = useTheme();
  return (
    <View style={[styles.skelCoupon, { width, backgroundColor: c.surface }]}>
      <Skeleton width="55%" height={34} />
      <Skeleton width="80%" height={15} style={styles.skelCouponGap} />
      <View style={[styles.skelCouponCut, { borderColor: c.border }]} />
      <Skeleton width="45%" height={16} />
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
  stateArt: { marginBottom: Spacing.sm },
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

  skelCoupon: {
    gap: Spacing.sm,
    padding: Spacing.lg,
    borderRadius: BorderRadius.sm,
  },
  skelCouponGap: { marginBottom: Spacing.xs },
  skelCouponCut: { borderTopWidth: 1, borderStyle: 'dashed', marginVertical: Spacing.xs },
  skelCard: {
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    overflow: 'hidden',
  },
  skelLogoRing: {
    width: 50, height: 50, borderRadius: 25,
    marginTop: -25,
    marginLeft: Spacing.md,
    padding: 3,
    alignItems: 'center', justifyContent: 'center',
  },
  skelBody: { gap: Spacing.sm, padding: Spacing.md, paddingTop: Spacing.sm },

  skelResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
  },
  skelResultBody: { flex: 1, gap: Spacing.sm },
  skelResultData: { alignItems: 'flex-end', gap: Spacing.sm },

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
});
