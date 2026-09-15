import { useEffect } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming,
  withRepeat, withDelay, interpolate, Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '../ui/Text';
import { Icon } from '../ui/Icon';
import type { IconName } from '../../theme/icons';
import { BorderRadius, Motion, Size, Spacing, palette } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';

const TABS: Record<string, { icon: IconName; label: string }> = {
  home: { icon: 'inicio', label: 'Inicio' },
  search: { icon: 'explorar', label: 'Explorar' },
  dashboard: { icon: 'rayo', label: 'Turno' },
  // Pedidos ya no vive en la barra del cliente —se movió a la pila, con
  // puerta desde Perfil— pero la entrada sigue sirviendo a la barra del
  // domiciliario, que usa la misma tabla.
  orders: { icon: 'pedidos', label: 'Pedidos' },
  offers: { icon: 'descuento', label: 'Descuentos' },
  earnings: { icon: 'billetera', label: 'Ganancias' },
  profile: { icon: 'perfil', label: 'Perfil' },
};

const INDICATOR_W = 22;
const SHEEN_W = 180;

// El dorado de marca marca qué pestaña está activa (icono, label e
// indicador) y no cambia con el tema. El fondo de la barra sí sigue el
// tema: mismo color de superficie que el resto del aplicativo, claro u
// oscuro.
const ON_GOLD = palette.gold500;    // icono/label activo, indicador

/**
 * Reflejo que recorre la barra.
 *
 * Una banda dorada muy tenue, inclinada, que cruza de izquierda a derecha
 * cada pocos segundos: un guiño metálico sin robar atención, sobre
 * cualquier fondo (claro u oscuro).
 */
function Sheen({ trackWidth }: { trackWidth: number }) {
  const p = useSharedValue(0);

  useEffect(() => {
    p.value = withRepeat(
      withDelay(1800, withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.ease) })),
      -1,
      false,
    );
  }, [trackWidth]);

  const slide = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(p.value, [0, 1], [-SHEEN_W, trackWidth + SHEEN_W]) },
      { skewX: '-18deg' },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.sheen, slide]}>
      <LinearGradient
        colors={['rgba(213,158,38,0)', 'rgba(213,158,38,0.28)', 'rgba(213,158,38,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/**
 * Barra de navegación.
 *
 * El indicador de pestaña activa es el trazo de la marca en pequeño: un
 * segmento dorado que se desliza sobre la barra al cambiar de sección. Es
 * el mismo gesto del logo y del seguimiento, así que la navegación queda
 * firmada.
 */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { c } = useTheme();

  const count = state.routes.length;
  const tabWidth = width / count;
  const x = useSharedValue(state.index * tabWidth + tabWidth / 2 - INDICATOR_W / 2);

  useEffect(() => {
    x.value = withSpring(state.index * tabWidth + tabWidth / 2 - INDICATOR_W / 2, {
      damping: 20,
      stiffness: 220,
    });
  }, [state.index, tabWidth]);

  const indicator = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: c.background,
          borderTopColor: c.border,
          height: Size.tabBar + insets.bottom,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <Sheen trackWidth={width} />
      <Animated.View style={[styles.indicator, indicator]} />

      {state.routes.map((route, index) => {
        const config = TABS[route.name];
        if (!config) return null;

        const focused = state.index === index;

        return (
          <TabItem
            key={route.key}
            icon={config.icon}
            label={config.label}
            focused={focused}
            inactiveColor={c.text}
            width={tabWidth}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (focused || event.defaultPrevented) return;
              tap('light');
              navigation.navigate(route.name);
            }}
          />
        );
      })}
    </View>
  );
}

function TabItem({
  icon, label, focused, inactiveColor, width, onPress,
}: {
  icon: IconName;
  label: string;
  focused: boolean;
  inactiveColor: string;
  width: number;
  onPress: () => void;
}) {
  const lift = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    lift.value = withTiming(focused ? 1 : 0, { duration: Motion.fast });
  }, [focused]);

  // La pestaña activa sube dos píxeles. Suficiente para notarse, no para distraer.
  const animated = useAnimatedStyle(() => ({
    transform: [{ translateY: -2 * lift.value }],
  }));

  return (
    <Pressable
      onPress={onPress}
      style={[styles.tab, { width }]}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
    >
      <Animated.View style={[styles.tabInner, animated]}>
        {/* Sin contadores aquí: la bolsa y el pedido en curso viven en el dock,
            que es donde además se pueden tocar. */}
        <Icon
          name={icon}
          size="lg"
          color={focused ? ON_GOLD : inactiveColor}
          strong={focused}
        />
        <Text v="caption" color={focused ? ON_GOLD : inactiveColor}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden', // recorta el reflejo a los bordes de la barra
  },
  sheen: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: SHEEN_W,
  },
  indicator: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: INDICATOR_W,
    height: 3,
    borderRadius: BorderRadius.full,
    backgroundColor: ON_GOLD,
  },
  tab: { alignItems: 'center', justifyContent: 'center' },
  tabInner: { alignItems: 'center', gap: 3, paddingTop: Spacing.md },
});
