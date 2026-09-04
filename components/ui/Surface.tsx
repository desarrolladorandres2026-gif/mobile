import type { ReactNode } from 'react';
import {
  View, Pressable, Modal, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, type ViewStyle, type StyleProp,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Text } from './Text';
import { IconButton } from './Button';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

// ──────────────────────────────────────────────────────────────
// Tarjeta
// ──────────────────────────────────────────────────────────────

export interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  /** `flat` sin sombra · `raised` con sombra · `outline` solo borde. */
  tone?: 'flat' | 'raised' | 'outline' | 'accent';
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export function Card({
  children, onPress, tone = 'flat', padded = true, style,
  accessibilityLabel, accessibilityHint,
}: CardProps) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const skin: ViewStyle = {
    flat: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 },
    raised: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 },
    outline: { backgroundColor: 'transparent', borderColor: c.border, borderWidth: 1.5 },
    accent: { backgroundColor: c.primarySoft, borderColor: c.primarySoftBorder, borderWidth: 1 },
  }[tone];

  const cardShadow = tone === 'raised' ? Shadow.md : Shadow.none;

  // Combina el style que llega por props (puede traer su propia sombra, p.
  // ej. `Shadow.sm` en el estado de turno) con la de la tarjeta.
  const flatStyle = StyleSheet.flatten([style]) ?? {};
  const {
    shadowColor, shadowOffset, shadowOpacity, shadowRadius, elevation, ...restStyle
  } = flatStyle as ViewStyle;
  const outerShadow: ViewStyle = {
    ...cardShadow,
    ...(shadowColor !== undefined && { shadowColor }),
    ...(shadowOffset !== undefined && { shadowOffset }),
    ...(shadowOpacity !== undefined && { shadowOpacity }),
    ...(shadowRadius !== undefined && { shadowRadius }),
    ...(elevation !== undefined && { elevation }),
  };

  /**
   * La sombra y el recorte viven en Views distintas.
   *
   * En Android, `elevation` y `overflow: 'hidden'` sobre la misma vista con
   * esquinas redondeadas y un fondo translúcido (p. ej. `limeSoft`) hacen que
   * el rectángulo que Android dibuja para la sombra se filtre como una franja
   * clara encima del contenido en vez de quedar oculto detrás. La vista
   * externa solo lleva la sombra; la interna recorta y pinta el fondo.
   */
  const body = (
    <View style={outerShadow}>
      <View style={[styles.card, skin, padded && styles.cardPadded, restStyle]}>{children}</View>
    </View>
  );

  if (!onPress) return body;

  return (
    <Animated.View style={animated}>
      <Pressable
        onPress={() => { tap('light'); onPress(); }}
        onPressIn={() => { scale.value = withSpring(0.98, { damping: 20, stiffness: 400 }); }}
        onPressOut={() => { scale.value = withSpring(1, { damping: 15, stiffness: 350 }); }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
      >
        {body}
      </Pressable>
    </Animated.View>
  );
}

// ──────────────────────────────────────────────────────────────
// Encabezado de sección
// ──────────────────────────────────────────────────────────────

export function SectionHeader({
  title, action, onAction, subtitle,
}: { title: string; action?: string; onAction?: () => void; subtitle?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitles}>
        <Text v="titleL">{title}</Text>
        {subtitle ? <Text v="bodyS" tone="textMuted">{subtitle}</Text> : null}
      </View>
      {action && onAction ? (
        <Pressable
          onPress={() => { tap('light'); onAction(); }}
          accessibilityRole="button"
          hitSlop={10}
        >
          <Text v="strongS" tone="primaryText">{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────
// Hoja inferior
// ──────────────────────────────────────────────────────────────

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Altura como fracción de la pantalla. */
  height?: number;
  /** Barra fija al pie, para la acción principal. */
  footer?: ReactNode;
  scroll?: boolean;
}

/**
 * Hoja que sube desde abajo.
 *
 * Todo lo que se decide sin salir del flujo vive aquí —elegir dirección,
 * armar un producto, aplicar un cupón— porque abrir una pantalla nueva para
 * eso hace perder el hilo y obliga a volver.
 */
export function Sheet({
  visible, onClose, title, children, height = 0.8, footer, scroll = true,
}: SheetProps) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const Body = scroll ? ScrollView : View;

  // El home indicator de iPhone / la barra de Android van por debajo de la
  // hoja: el contenido y el pie tienen que dejar libre ese inset real.
  const safeBottom = Math.max(insets.bottom, Spacing.md);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.sheetOverlay, { backgroundColor: c.overlay }]}>
        {/* Tocar fuera cierra: es lo que la gente intenta primero. */}
        <Pressable
          style={styles.sheetBackdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={[
            styles.sheet,
            { backgroundColor: c.background, height: `${height * 100}%` },
          ]}
        >
          <View style={[styles.sheetHandle, { backgroundColor: c.borderStrong }]} />
          <View style={[styles.sheetHeader, { borderBottomColor: c.border }]}>
            <Text v="titleL" style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
            <IconButton icon="cerrar" onPress={onClose} label="Cerrar" size={36} />
          </View>

          <Body
            style={styles.sheetBody}
            {...(scroll
              ? {
                  contentContainerStyle: [
                    styles.sheetContent,
                    // Sin pie fijo, el último elemento no debe morir contra el
                    // borde: se suma el inset del dispositivo al relleno.
                    !footer && { paddingBottom: Spacing.xxxl + safeBottom },
                  ],
                  showsVerticalScrollIndicator: false,
                  keyboardShouldPersistTaps: 'handled' as const,
                }
              : null)}
          >
            {children}
          </Body>

          {footer ? (
            <View
              style={[
                styles.sheetFooter,
                {
                  borderTopColor: c.border,
                  backgroundColor: c.background,
                  paddingBottom: safeBottom + Spacing.sm,
                },
              ]}
            >
              {footer}
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────
// Fila de detalle
// ──────────────────────────────────────────────────────────────

/** Fila etiqueta/valor. La base del desglose de precios. */
export function DetailRow({
  label, value, tone = 'text', strong, mono = true,
}: {
  label: string;
  value: string;
  tone?: 'text' | 'textSecondary' | 'successText' | 'errorText';
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={styles.detailRow}>
      <Text v={strong ? 'strongM' : 'bodyM'} tone={strong ? 'text' : 'textSecondary'}>
        {label}
      </Text>
      <Text v={mono ? (strong ? 'dataL' : 'dataM') : strong ? 'strongM' : 'bodyM'} tone={tone}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: BorderRadius.xl, overflow: 'hidden' },
  cardPadded: { padding: Spacing.lg },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  sectionTitles: { flex: 1, gap: 2 },

  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    borderTopLeftRadius: BorderRadius.xxl,
    borderTopRightRadius: BorderRadius.xxl,
    overflow: 'hidden',
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2,
    alignSelf: 'center', marginTop: Spacing.md,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { flex: 1 },
  sheetBody: { flex: 1 },
  sheetContent: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
  sheetFooter: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },

  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
});
