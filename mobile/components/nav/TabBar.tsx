import { useEffect, useRef } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions, InteractionManager } from 'react-native';
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
  // La membresía. Va en el centro exacto de las cinco pestañas y se pinta
  // distinta —ver `TabDome`—: es la única que vende algo.
  pro: { icon: 'corona', label: 'Zipp Pro' },
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

/**
 * Montar por detrás las pestañas que todavía no se han abierto.
 *
 * Una pestaña de `expo-router` es perezosa: no existe hasta que se toca por
 * primera vez, así que ese primer toque paga el montaje de la pantalla
 * entera *y* la primera vuelta de sus consultas. El dedo ya recibió su
 * respuesta —el trazo dorado se mueve en el hilo de UI— pero el contenido
 * llega tarde, y lo que se recuerda es el esqueleto.
 *
 * `navigation.preload` monta la pantalla fuera de la vista, con sus datos,
 * para que el toque no tenga nada que hacer salvo enseñarla. Se hace cuando
 * la app ya está quieta y de una en una: montar cuatro pantallas de golpe
 * durante el arranque cambiaría un retraso por otro, y este sí se nota en la
 * primera impresión.
 *
 * La pestaña inicial nunca entra aquí —ya está montada— y una pestaña que se
 * visite antes de que le toque el turno se salta: en cuanto se navega a ella,
 * el router la saca de la lista de precargadas y vuelve a congelarse al
 * salir, que es justo lo que `freezeOnBlur` busca.
 */
const PRELOAD_AFTER_MS = 1200;
const PRELOAD_GAP_MS = 350;

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

  usePreloadSiblings(state, navigation);

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
      {/* El trazo no firma la pestaña del centro: ahí manda la corona, y
          dos marcas de "estás aquí" a la vez se estorban. */}
      {state.routes[state.index]?.name === 'pro' ? null : (
        <Animated.View style={[styles.indicator, indicator]} />
      )}

      {state.routes.map((route, index) => {
        const config = TABS[route.name];
        if (!config) return null;

        const focused = state.index === index;
        const Item = route.name === 'pro' ? TabDome : TabItem;

        return (
          <Item
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
        {/* Con cinco pestañas cada una mide ~78 px: "Descuentos" cabe
            justo, y una segunda línea rompería el alto de la barra. */}
        <Text v="caption" color={focused ? ON_GOLD : inactiveColor} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * La pestaña del centro: Zipp Pro.
 *
 * Un disco dorado con la corona, no un icono más. Es la única entrada de la
 * barra que no lleva a mirar sino a contratar, y tratarla igual que a las
 * otras cuatro la escondería justo en el sitio donde más se mira.
 *
 * El disco vive **dentro** del alto de la barra a propósito, en vez de
 * sobresalir por arriba como el botón central de otras apps: la barra
 * recorta a sus bordes para que el reflejo no se salga, y un disco que
 * asomara aparecería cortado. El anillo del color del fondo hace el resto
 * del trabajo —separa el disco de la barra y da la sensación de relieve—
 * sin depender de que nada se dibuje fuera.
 */
function TabDome({
  icon, label, focused, width, onPress,
}: {
  icon: IconName;
  label: string;
  focused: boolean;
  inactiveColor: string;
  width: number;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const lift = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    lift.value = withSpring(focused ? 1 : 0, { damping: 14, stiffness: 240 });
  }, [focused]);

  // Al entrar, el disco crece un pelo y sube: el mismo gesto de las otras
  // pestañas, con más cuerpo porque el elemento es más grande.
  const animated = useAnimatedStyle(() => ({
    transform: [
      { translateY: -3 * lift.value },
      { scale: 1 + 0.06 * lift.value },
    ],
  }));

  return (
    <Pressable
      onPress={onPress}
      style={[styles.tab, { width }]}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
    >
      <Animated.View style={[styles.domeInner, animated]}>
        <View style={[styles.domeRing, { borderColor: c.background }]}>
          <LinearGradient
            colors={[palette.gold300, palette.gold500]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.domeFill}
          >
            <Icon name={icon} size="md" color={palette.ink900} strong />
          </LinearGradient>
        </View>
        <Text v="caption" color={ON_GOLD} numberOfLines={1}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

/** Ver `PRELOAD_AFTER_MS`. */
function usePreloadSiblings(
  state: BottomTabBarProps['state'],
  navigation: BottomTabBarProps['navigation'],
) {
  // Lo ya visitado no se precarga: sería devolverlo a "precargado" y, con
  // eso, dejarlo sin congelar el resto de la sesión.
  const visited = useRef(new Set<string>());
  const currentKey = state.routes[state.index]?.key;
  if (currentKey) visited.current.add(currentKey);

  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const pending = state.routes.filter((_, i) => i !== state.index);
    const timers: ReturnType<typeof setTimeout>[] = [];

    const task = InteractionManager.runAfterInteractions(() => {
      pending.forEach((route, i) => {
        timers.push(
          setTimeout(() => {
            if (visited.current.has(route.key)) return;
            navigation.preload(route.name);
          }, PRELOAD_AFTER_MS + i * PRELOAD_GAP_MS),
        );
      });
    });

    return () => {
      task.cancel();
      timers.forEach(clearTimeout);
    };
    // Una sola vez por montaje del navegador: la lista de pestañas no cambia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // Sin relleno arriba: el disco ya es alto, y la barra mide 64. Lo que
  // sobrepase se recorta, así que aquí se cuenta al píxel.
  domeInner: { alignItems: 'center', gap: 2 },
  domeRing: {
    width: 42,
    height: 42,
    borderRadius: BorderRadius.full,
    borderWidth: 3,
    overflow: 'hidden',
  },
  domeFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
