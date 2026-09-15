import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn, Layout, FadeOut } from 'react-native-reanimated';
import {
  Text, Icon, Button, IconButton, Card, QtyStepper, EmptyState,
  Screen, ScreenFooter, Header, DetailRow,
} from '../../components/ui';
import { useCartStore } from '../../stores/cartStore';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money } from '../../lib/format';
import { describeExtras } from '../../lib/modifiers';
import { tap } from '../../lib/haptics';

/**
 * La bolsa.
 *
 * Antes esta pantalla también pedía dirección, pago, cupón y propina: casi
 * mil líneas y un muro de decisiones antes de poder confirmar. Ahora hace una
 * sola cosa —revisar lo que vas a pedir— y el resto vive en el checkout. Dos
 * pasos cortos se completan mejor que uno larguísimo.
 */
export default function CartScreen() {
  const router = useRouter();
  const { c } = useTheme();

  const items = useCartStore((s) => s.items);
  const businessId = useCartStore((s) => s.businessId);
  const businessName = useCartStore((s) => s.businessName);
  const subtotal = useCartStore((s) => s.getSubtotal());
  const getLineTotal = useCartStore((s) => s.getLineTotal);
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const clearCart = useCartStore((s) => s.clearCart);

  const confirmClear = () => {
    Alert.alert(
      'Vaciar la bolsa',
      'Se quitan todos los productos. Esto no se puede deshacer.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Vaciar', style: 'destructive', onPress: () => { clearCart(); router.back(); } },
      ]
    );
  };

  if (items.length === 0) {
    return (
      <Screen>
        <Header title="Tu bolsa" fallback="/(client)/(tabs)/home" />
        <EmptyState
          icon="bolsa"
          title="Tu bolsa está vacía"
          message="Mira qué hay abierto cerca de ti. Casi todo llega en menos de 20 minutos."
          actionLabel="Ver negocios"
          onAction={() => router.replace('/(client)/(tabs)/home')}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="Tu bolsa"
        fallback="/(client)/(tabs)/home"
        right={
          <IconButton icon="eliminar" label="Vaciar la bolsa" tone="danger" onPress={confirmClear} />
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* De qué negocio es esta bolsa */}
        <Card tone="accent" style={styles.business}>
          <View style={[styles.businessIcon, { backgroundColor: c.primary }]}>
            <Icon name="negocio" size="md" color={c.textOnPrimary} />
          </View>
          <View style={styles.flex}>
            <Text v="caption" tone="textMuted">PEDIDO A</Text>
            <Text v="strongM" numberOfLines={1}>{businessName}</Text>
          </View>
        </Card>

        {/* Productos */}
        <View style={styles.items}>
          {items.map((item) => (
            <Animated.View
              key={item.lineId}
              entering={FadeIn.duration(200)}
              exiting={FadeOut.duration(160)}
              layout={Layout.springify().damping(18)}
            >
              <Card padded={false} style={styles.item}>
                <View style={styles.itemBody}>
                  <Text v="titleS">{item.productName}</Text>

                  {item.selectedExtras.length > 0 ? (
                    <Text v="bodyS" tone="primaryText" numberOfLines={2}>
                      {describeExtras(item.selectedExtras)}
                    </Text>
                  ) : null}

                  {item.notes ? (
                    <Text v="bodyS" tone="textMuted" numberOfLines={2}>“{item.notes}”</Text>
                  ) : null}

                  <Text v="dataM" tone="text">{money(getLineTotal(item))}</Text>
                </View>

                <QtyStepper
                  value={item.quantity}
                  onChange={(next) => updateQuantity(item.lineId, next)}
                  itemName={item.productName}
                  size="sm"
                />
              </Card>
            </Animated.View>
          ))}
        </View>

        <Button
          title="Agregar algo más"
          icon="mas"
          variant="ghost"
          full
          onPress={() => {
            tap('light');
            if (businessId) router.push(`/(client)/business/${businessId}`);
            else router.replace('/(client)/(tabs)/home');
          }}
        />

        {/* El subtotal es lo único que la app puede calcular sola: el envío,
            los impuestos y el descuento los define el servidor en el checkout. */}
        <Card style={styles.summary}>
          <DetailRow label="Subtotal" value={money(subtotal)} />
          <Text v="caption" tone="textMuted">
            El envío y los descuentos se calculan en el siguiente paso, según tu dirección.
          </Text>
        </Card>
      </ScrollView>

      <ScreenFooter>
        <Button
          title="Continuar"
          trailing={money(subtotal)}
          size="lg"
          full
          iconRight="adelante"
          onPress={() => router.push('/(client)/checkout')}
          haptic="medium"
        />
      </ScreenFooter>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },

  business: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  businessIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.sm,
    alignItems: 'center', justifyContent: 'center',
  },

  items: { gap: Spacing.md },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
  },
  itemBody: { flex: 1, gap: 3 },

  summary: { gap: Spacing.sm },
});
