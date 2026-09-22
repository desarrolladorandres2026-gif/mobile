import { useState, useMemo } from 'react';
import { View, ScrollView, StyleSheet, Alert, TouchableOpacity, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { sizedImageUri } from '../../lib/cloudinaryImage';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Animated, { FadeIn, Layout, FadeOut } from 'react-native-reanimated';
import { Swipeable } from 'react-native-gesture-handler';
import {
  Text, Icon, Button, IconButton, Card, QtyStepper, EmptyState,
  Screen, ScreenFooter, Header, DetailRow,
} from '../../components/ui';
import { SuggestionRow, type SuggestedProduct } from '../../components/domain/SuggestionRow';
import { useCartStore, type BusinessCart } from '../../stores/cartStore';
import { useBusiness, useBusinessProducts } from '../../hooks/useApi';
import { useFavorites } from '../../hooks/useFavorites';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { money } from '../../lib/format';
import { businessAccent } from '../../lib/business';
import { freeDeliveryGap, pickSuggestions } from '../../lib/catalog';
import { productImageUri } from '../../lib/productImage';
import { describeExtras, needsChoices, type ModifierGroup } from '../../lib/modifiers';
import { tap } from '../../lib/haptics';

/** Verde vivo de la barra de progreso (emerald500 de la paleta); igual en claro y oscuro. */
const GOAL_GREEN = '#10B981';

/** Lo que la bolsa necesita del catálogo para poder sugerir y agregar. */
interface CatalogProduct extends SuggestedProduct {
  categoryId?: string;
  modifierGroups?: ModifierGroup[];
}

/**
 * La bolsa.
 *
 * Antes esta pantalla también pedía dirección, pago, cupón y propina: casi
 * mil líneas y un muro de decisiones antes de poder confirmar. Ahora hace una
 * sola cosa —revisar lo que vas a pedir— y el resto vive en el checkout. Dos
 * pasos cortos se completan mejor que uno larguísimo. La propina tiene su
 * propia pantalla entre las dos.
 *
 * Cada negocio tiene su propia bolsa y las dos pueden estar vivas a la vez.
 * Sin un `businessId` en la URL (por ejemplo, tocando el ícono genérico del
 * carrito), y con más de una abierta, primero hay que elegir cuál revisar.
 */
export default function CartScreen() {
  const router = useRouter();
  const { businessId: paramBusinessId } = useLocalSearchParams<{ businessId?: string }>();
  const carts = useCartStore((s) => s.carts);

  if (carts.length === 0) {
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

  const businessId = paramBusinessId ?? (carts.length === 1 ? carts[0].businessId : undefined);

  if (!businessId) {
    return <CartChooser carts={carts} />;
  }

  const cart = carts.find((c) => c.businessId === businessId);
  if (!cart) {
    return <CartChooser carts={carts} />;
  }

  return <BusinessCartScreen cart={cart} />;
}

/**
 * Con más de una bolsa abierta, esta es la puerta: qué llevas y de dónde,
 * para elegir cuál revisar o pagar primero. Cada una se confirma por
 * separado porque cada una llega de un negocio distinto.
 */
function CartChooser({ carts }: { carts: BusinessCart[] }) {
  const router = useRouter();
  const { c } = useTheme();
  const getSubtotal = useCartStore((s) => s.getSubtotal);

  return (
    <Screen>
      <Header title="Tus bolsas" fallback="/(client)/(tabs)/home" />
      <ScrollView contentContainerStyle={styles.chooserContent} showsVerticalScrollIndicator={false}>
        <Text v="bodyS">
          Tienes pedidos de {carts.length} negocios distintos. Cada uno se revisa y se paga por su cuenta.
        </Text>

        {carts.map((cart) => {
          const count = cart.items.reduce((sum, i) => sum + i.quantity, 0);
          return (
            <Pressable
              key={cart.businessId}
              onPress={() => {
                tap('light');
                router.push({ pathname: '/(client)/cart', params: { businessId: cart.businessId } });
              }}
              accessibilityRole="button"
              accessibilityLabel={`Bolsa de ${cart.businessName}. ${count} ${count === 1 ? 'producto' : 'productos'}. Subtotal ${money(getSubtotal(cart.businessId))}`}
            >
              <Card style={styles.chooserCard}>
                {cart.businessLogo ? (
                  <Image
                    source={{ uri: sizedImageUri(cart.businessLogo, 40) }}
                    style={styles.businessIcon}
                    contentFit="cover"
                    transition={150}
                  />
                ) : (
                  <View style={[styles.businessIcon, { backgroundColor: c.primary }]}>
                    <Icon name="negocio" size="md" color={c.textOnPrimary} />
                  </View>
                )}
                <View style={styles.flex}>
                  <Text v="strongM" numberOfLines={1}>{cart.businessName}</Text>
                  <Text v="bodyS">
                    {count} {count === 1 ? 'producto' : 'productos'}
                  </Text>
                </View>
                <Text v="dataM" tone="text">{money(getSubtotal(cart.businessId))}</Text>
                <Icon name="siguiente" size="md" color={c.text} />
              </Card>
            </Pressable>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

/** Bolsa de un solo negocio: lo que hasta ahora era toda la pantalla. */
function BusinessCartScreen({ cart }: { cart: BusinessCart }) {
  const router = useRouter();
  const { c } = useTheme();

  const { businessId, businessName, businessLogo, items } = cart;

  const getSubtotal = useCartStore((s) => s.getSubtotal);
  const getSavings = useCartStore((s) => s.getSavings);
  const getLineTotal = useCartStore((s) => s.getLineTotal);
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);
  const clearCart = useCartStore((s) => s.clearCart);
  const addItem = useCartStore((s) => s.addItem);
  const { isFavorite, toggle: toggleFavorite } = useFavorites();

  const subtotal = getSubtotal(businessId);
  const savings = getSavings(businessId);

  // Las dos consultas comparten clave de react-query con la pantalla de la
  // tienda: viniendo de ahí no se pide nada, y llegando en frío (desde el
  // Dock, o con la bolsa restaurada al abrir la app) es una sola petición.
  const { data: products = [] } = useBusinessProducts(businessId) as { data: CatalogProduct[] };
  const { data: business } = useBusiness(businessId) as {
    data?: { category?: string; minOrder?: number; freeDeliveryThreshold?: number };
  };

  const [justAdded, setJustAdded] = useState<string | null>(null);

  // Ni lo que ya lleva, ni más de lo mismo: se sugiere de las secciones de la
  // carta que el pedido todavía no toca.
  const suggestions = useMemo(() => {
    const inCart = items.map((item) => item.productId);
    const covered = inCart.map(
      (id) => products.find((product) => product._id === id)?.categoryId
    );
    return pickSuggestions(products, { exclude: inCart, covered });
  }, [products, items]);

  const addSuggestion = (product: CatalogProduct) => {
    // Con opciones obligatorias no se puede agregar a ciegas —el checkout lo
    // rechazaría—, así que se abre su ficha, que ya sabe abrirse sola cuando
    // le llega el `productId`.
    if (needsChoices(product)) {
      tap('light');
      router.push({
        pathname: '/(client)/business/[id]',
        params: { id: businessId, productId: product._id },
      });
      return;
    }

    tap('success');
    addItem(businessId, businessName, {
      productId: product._id,
      productName: product.name,
      quantity: 1,
      unitPrice: product.discountPrice ?? product.price,
      originalUnitPrice: product.discountPrice != null ? product.price : undefined,
      image: productImageUri(product, 'thumb') ?? undefined,
      selectedExtras: [],
      notes: '',
    }, businessLogo);

    setJustAdded(product._id);
    setTimeout(() => {
      setJustAdded((current) => (current === product._id ? null : current));
    }, 1200);
  };

  const confirmClear = () => {
    Alert.alert(
      'Vaciar la bolsa',
      'Se quitan todos los productos. Esto no se puede deshacer.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Vaciar', style: 'destructive', onPress: () => { clearCart(businessId); router.back(); } },
      ]
    );
  };

  return (
    <Screen>
      <Header
        title="Resumen de pedido"
        fallback="/(client)/(tabs)/home"
        right={
          <IconButton icon="eliminar" label="Vaciar la bolsa" tone="neutral" onPress={confirmClear} />
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* De qué negocio es esta bolsa */}
        <View style={styles.business}>
          {businessLogo ? (
            <Image
              source={{ uri: sizedImageUri(businessLogo, 40) }}
              style={styles.businessIcon}
              contentFit="cover"
              transition={150}
            />
          ) : (
            <View style={[styles.businessIcon, { backgroundColor: c.primary }]}>
              <Icon name="negocio" size="md" color={c.textOnPrimary} />
            </View>
          )}
          <View style={styles.flex}>
            <Text v="caption">PEDIDO A</Text>
            <Text v="strongM" numberOfLines={1}>{businessName}</Text>
          </View>
        </View>

        {/* Productos */}
        <View style={styles.items}>
          {items.map((item) => (
            <Animated.View
              key={item.lineId}
              entering={FadeIn.duration(200)}
              exiting={FadeOut.duration(160)}
              layout={Layout.springify().damping(18)}
            >
              <Swipeable
                renderRightActions={() => (
                  <TouchableOpacity
                    style={[styles.deleteAction, { backgroundColor: c.error }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Quitar ${item.productName} de la bolsa`}
                    onPress={() => {
                      tap('warning');
                      removeItem(businessId, item.lineId);
                    }}
                  >
                    <Icon name="eliminar" size="md" color={c.textOnPrimary} />
                  </TouchableOpacity>
                )}
                overshootRight={false}
              >
                <View style={styles.item}>
                  {item.image ? (
                    <Image
                      source={{ uri: item.image }}
                      style={[styles.itemImage, { backgroundColor: c.surfaceLight }]}
                      contentFit="cover"
                      transition={150}
                    />
                  ) : (
                    <View style={[styles.itemImage, styles.itemImageFallback, { backgroundColor: c.surfaceLight }]}>
                      <Icon name="catRestaurante" size="md" color={c.text} />
                    </View>
                  )}

                  <View style={styles.itemBody}>
                    <View style={styles.itemHeader}>
                      <Text v="titleS" style={styles.flex} numberOfLines={2}>{item.productName}</Text>
                      <IconButton
                        icon="favorito"
                        label={
                          isFavorite(item.productId, 'product')
                            ? `Quitar ${item.productName} de favoritos`
                            : `Guardar ${item.productName} en favoritos`
                        }
                        tone={isFavorite(item.productId, 'product') ? 'primary' : 'neutral'}
                        filled={isFavorite(item.productId, 'product')}
                        onPress={() => toggleFavorite(item.productId, 'product')}
                        size={28}
                      />
                    </View>

                    {item.selectedExtras.length > 0 ? (
                      <Text v="bodyS" numberOfLines={2}>
                        {describeExtras(item.selectedExtras)}
                      </Text>
                    ) : null}

                    {item.notes ? (
                      <Text v="bodyS" numberOfLines={2}>“{item.notes}”</Text>
                    ) : null}

                    <View style={styles.itemFooter}>
                      <Text v="dataM" tone="text">{money(getLineTotal(item))}</Text>
                      <QtyStepper
                        value={item.quantity}
                        onChange={(next) => updateQuantity(businessId, item.lineId, next)}
                        itemName={item.productName}
                        size="sm"
                      />
                    </View>
                  </View>
                </View>
              </Swipeable>
            </Animated.View>
          ))}
        </View>

        {/* Desliza a la izquierda para quitar un producto sin abrir la
            alerta de vaciar toda la bolsa. */}
        <Text v="caption" style={styles.swipeHint}>
          Desliza un producto para quitarlo
        </Text>

        {/* Aquí y no en la tienda: es el momento en que el cliente ya decidió
            qué pide y mira el total, que es cuando de verdad se plantea si le
            falta la bebida. */}
        <SuggestionRow
          products={suggestions}
          accent={businessAccent(businessId)}
          category={business?.category ?? ''}
          justAddedId={justAdded}
          onAdd={addSuggestion}
          title="¿Le agregas algo?"
          bleed={Spacing.xl}
        />

        <Button
          title="Ver toda la carta"
          icon="mas"
          variant="ghost"
          full
          onPress={() => {
            tap('light');
            router.push(`/(client)/business/${businessId}`);
          }}
        />

        {/* El subtotal es lo único que la app puede calcular sola: el envío,
            los impuestos y el descuento los define el servidor en el checkout. */}
        <View style={styles.summary}>
          <DetailRow label="Subtotal" value={money(subtotal)} strong />
          {savings > 0 ? (
            <DetailRow label="Ahorraste" value={money(savings)} tone="successText" labelTone="text" />
          ) : null}
          <CartGoal
            subtotal={subtotal}
            minOrder={business?.minOrder ?? 0}
            freeDeliveryThreshold={business?.freeDeliveryThreshold}
          />
          <Text v="strongS">
            El envío y los descuentos se calculan en el siguiente paso, según tu dirección.
          </Text>
        </View>
      </ScrollView>

      <ScreenFooter>
        <Button
          title="Continuar"
          trailing={money(subtotal)}
          size="lg"
          full
          iconRight="adelante"
          onPress={() => router.push({ pathname: '/(client)/tip', params: { businessId } })}
          haptic="medium"
        />
      </ScreenFooter>
    </Screen>
  );
}

/**
 * Cuánto falta para la siguiente meta del pedido.
 *
 * El mínimo de compra manda sobre el envío gratis: sin alcanzarlo no hay
 * pedido que hacer, así que anunciar el premio antes que el requisito es
 * ofrecer algo que todavía no se puede comprar. Las dos cifras se piden al
 * negocio y no al presupuesto porque aquí todavía no hay dirección, y sin
 * dirección el servidor no cotiza.
 */
function CartGoal({
  subtotal, minOrder, freeDeliveryThreshold,
}: {
  subtotal: number;
  minOrder: number;
  freeDeliveryThreshold: number | undefined;
}) {
  const { c } = useTheme();

  const missingForMin = minOrder > 0 && subtotal < minOrder ? minOrder - subtotal : 0;
  const deliveryGap = freeDeliveryGap(subtotal, freeDeliveryThreshold);

  const goal = missingForMin > 0
    ? { target: minOrder, label: `Te faltan ${money(missingForMin)} para el mínimo de este negocio` }
    : deliveryGap && freeDeliveryThreshold
    ? { target: freeDeliveryThreshold, label: `Te faltan ${money(deliveryGap)} para el envío gratis` }
    : null;

  if (!goal) {
    return freeDeliveryThreshold && subtotal >= freeDeliveryThreshold ? (
      <Text v="strongS" tone="successText">Este pedido ya tiene el envío gratis.</Text>
    ) : null;
  }

  return (
    <View style={styles.goal}>
      <View style={[styles.goalTrack, { backgroundColor: c.surfaceLight }]}>
        <View
          style={[
            styles.goalFill,
            { width: `${Math.min(1, subtotal / goal.target) * 100}%`, backgroundColor: GOAL_GREEN },
          ]}
        />
      </View>
      <Text v="strongS">{goal.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  goal: { gap: Spacing.xs },
  goalTrack: { height: 6, borderRadius: BorderRadius.full, overflow: 'hidden' },
  goalFill: { height: '100%', borderRadius: BorderRadius.full },
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: Spacing.huge },

  chooserContent: { padding: Spacing.xl, gap: Spacing.md, paddingBottom: Spacing.huge },
  chooserCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },

  business: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  businessIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.full, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },

  items: { gap: Spacing.md },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  itemImage: {
    width: 72,
    height: 72,
    borderRadius: BorderRadius.sm,
  },
  itemImageFallback: { alignItems: 'center', justifyContent: 'center' },
  itemBody: { flex: 1, gap: 0 },
  itemHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  itemFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },

  deleteAction: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.sm,
    marginLeft: Spacing.sm,
  },
  swipeHint: { textAlign: 'center', marginTop: -Spacing.sm },

  summary: { gap: Spacing.sm },
});
