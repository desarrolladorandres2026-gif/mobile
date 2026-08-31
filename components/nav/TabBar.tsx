import { useEffect } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming,
} from 'react-native-reanimated';
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
  orders: { icon: 'pedidos', label: 'Pedidos' },
  earnings: { icon: 'billetera', label: 'Ganancias' },
  profile: { icon: 'perfil', label: 'Perfil' },
};

const INDICATOR_W = 22;

/**
 * Barra de navegación.
 *
 * El indicador de pestaña activa es el trazo de la marca en pequeño: un
 * segmento lima que se desliza al cambiar de sección. Es el mismo gesto del
 * logo y del seguimiento, así que la navegación queda firmada.
 */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

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
          backgroundColor: c.surface,
          borderTopColor: c.border,
          height: Size.tabBar + insets.bottom,
          paddingBottom: insets.bottom,
        },
      ]}
    >
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
  icon, label, focused, width, onPress,
}: {
  icon: IconName;
  label: string;
  focused: boolean;
  width: number;
  onPress: () => void;
}) {
  const { c } = useTheme();
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
          color={focused ? c.primaryText : c.textMuted}
          strong={focused}
        />
        <Text v="caption" tone={focused ? 'primaryText' : 'textMuted'}>
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
  },
  indicator: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: INDICATOR_W,
    height: 3,
    borderRadius: BorderRadius.full,
    backgroundColor: palette.lima500,
  },
  tab: { alignItems: 'center', justifyContent: 'center' },
  tabInner: { alignItems: 'center', gap: 3, paddingTop: Spacing.md },
});
