import { View, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown, FadeOutDown, Layout } from 'react-native-reanimated';
import { Text } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { PulseDot } from '../ui/Badge';
import { BorderRadius, Shadow, Size, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { useCartStore } from '../../stores/cartStore';
import { useActiveOrder, orderProgress } from '../../hooks/useRealtime';
import { ORDER_STATUS_LABELS, ORDER_STATUS_DETAIL } from '../../constants/config';
import { money } from '../../lib/format';
import { tap } from '../../lib/haptics';

/**
 * Dock: lo urgente, siempre al alcance del pulgar.
 *
 * Flota sobre las pestañas con dos piezas que aparecen solo cuando aplican.
 * Arriba, el pedido que va en camino; abajo, la bolsa en curso. Las dos cosas
 * que en una app de domicilios uno quiere tocar sin buscar, y que en la
 * esquina superior derecha —donde suele ir el carrito— no se alcanzan con una
 * mano en un teléfono grande.
 */
export function Dock() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const itemCount = useCartStore((s) => s.getItemCount());
  const subtotal = useCartStore((s) => s.getSubtotal());
  const businessName = useCartStore((s) => s.businessName);
  const activeOrder = useActiveOrder();

  if (itemCount === 0 && !activeOrder) return null;

  return (
    <View
      style={[styles.dock, { bottom: Size.tabBar + insets.bottom + Spacing.sm }]}
      pointerEvents="box-none"
    >
      {activeOrder ? (
        <LiveOrderStrip
          order={activeOrder}
          onPress={() =>
            router.push({ pathname: '/(client)/order-tracking', params: { id: activeOrder._id } })
          }
        />
      ) : null}

      {itemCount > 0 ? (
        <CartBar
          count={itemCount}
          subtotal={subtotal}
          businessName={businessName}
          onPress={() => router.push('/(client)/cart')}
        />
      ) : null}
    </View>
  );
}

/** Tira del pedido en curso. Late mientras se mueve. */
function LiveOrderStrip({ order, onPress }: { order: any; onPress: () => void }) {
  const { c } = useTheme();
  const progress = orderProgress(order.status);

  return (
    <Animated.View entering={FadeInDown.springify().damping(18)} exiting={FadeOutDown} layout={Layout}>
      <Pressable
        onPress={() => { tap('light'); onPress(); }}
        accessibilityRole="button"
        accessibilityLabel={`Pedido de ${order.businessId?.name ?? 'tu negocio'}. ${ORDER_STATUS_DETAIL[order.status] ?? ''}`}
        accessibilityHint="Abre el seguimiento del pedido"
        style={[
          styles.strip,
          { backgroundColor: c.surface, borderColor: c.limeSoftBorder },
          Shadow.md,
        ]}
      >
        <View style={[styles.stripIcon, { backgroundColor: c.limeSoft }]}>
          <Icon name="domiciliario" size="md" color={c.limeText} />
        </View>

        <View style={styles.stripBody}>
          <View style={styles.stripTop}>
            <PulseDot color={c.lime} size={6} />
            <Text v="captionStrong" tone="limeText">
              {ORDER_STATUS_LABELS[order.status]?.toUpperCase()}
            </Text>
          </View>
          <Text v="strongS" numberOfLines={1}>
            {order.businessId?.name ?? 'Tu pedido'}
          </Text>
        </View>

        <Icon name="siguiente" size="md" color={c.textMuted} />

        {/* Avance real del pedido, pegado al borde inferior de la tira. */}
        <View style={[styles.stripTrack, { backgroundColor: c.border }]}>
          <View
            style={[styles.stripFill, { backgroundColor: c.lime, width: `${progress * 100}%` }]}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

/** Barra de la bolsa. La acción principal cuando hay algo por pedir. */
function CartBar({
  count, subtotal, businessName, onPress,
}: { count: number; subtotal: number; businessName: string | null; onPress: () => void }) {
  const { c } = useTheme();

  return (
    <Animated.View entering={FadeInDown.springify().damping(18)} exiting={FadeOutDown} layout={Layout}>
      <Pressable
        onPress={() => { tap('medium'); onPress(); }}
        accessibilityRole="button"
        accessibilityLabel={`Ver la bolsa. ${count} ${count === 1 ? 'producto' : 'productos'} de ${businessName ?? 'tu negocio'}. Subtotal ${money(subtotal)}`}
        style={[styles.cart, { backgroundColor: c.primary }, Shadow.primaryGlow]}
      >
        <View style={[styles.cartCount, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
          <Text v="dataM" color={c.textOnPrimary}>{count}</Text>
        </View>

        <View style={styles.cartBody}>
          <Text v="buttonMd" color={c.textOnPrimary}>Ver la bolsa</Text>
          {businessName ? (
            <Text v="caption" color="rgba(255,255,255,0.75)" numberOfLines={1}>
              {businessName}
            </Text>
          ) : null}
        </View>

        <Text v="dataL" color={c.textOnPrimary}>{money(subtotal)}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    gap: Spacing.sm,
  },

  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.sm + 2,
    paddingRight: Spacing.md,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  stripIcon: {
    width: 38, height: 38, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  stripBody: { flex: 1, gap: 2 },
  stripTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs + 1 },
  stripTrack: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: 3,
  },
  stripFill: { height: '100%' },

  cart: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    height: 60,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.lg,
  },
  cartCount: {
    minWidth: 34, height: 34, borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  cartBody: { flex: 1, gap: 1 },
});
