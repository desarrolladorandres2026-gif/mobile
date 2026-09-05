import { useState, useMemo } from 'react';
import {
  View, ScrollView, Pressable, StyleSheet, Share, Linking, Platform, TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeOutDown, Layout } from 'react-native-reanimated';
import {
  Text, Icon, IconButton, Button, Badge, MetaRow, Notice, Sheet,
  QtyStepper, EmptyState, ErrorState, Skeleton, LoadingScreen,
} from '../../../components/ui';
import { useBusiness, useBusinessCategories, useBusinessProducts } from '../../../hooks/useApi';
import { useCartStore } from '../../../stores/cartStore';
import { useFavoritesStore } from '../../../stores/favoritesStore';
import { useTheme } from '../../../hooks/useTheme';
import { useBottomInset } from '../../../hooks/useBottomSpace';
import { categoryIllustration } from '../../../components/illustrations';
import { Type } from '../../../theme/typography';
import { BorderRadius, Shadow, Spacing } from '../../../theme/tokens';
import { businessAccent, openState } from '../../../lib/business';
import { money, minutes } from '../../../lib/format';
import { tap } from '../../../lib/haptics';
import {
  productImageUri, productImagePlaceholder, hasProductImage,
  type ProductImages,
} from '../../../lib/productImage';

interface Extra { name: string; price: number }

interface Product {
  _id: string;
  name: string;
  description?: string;
  price: number;
  discountPrice?: number;
  /** URL de catálogo. Los productos antiguos solo tienen esto. */
  image?: string;
  /** Las cuatro variantes que calcula el servidor. */
  images?: ProductImages | null;
  isAvailable: boolean;
  extras?: Extra[];
  categoryId?: string;
}

/** Espacio que reserva el scroll cuando la barra de "mi coronita" está a la vista. */
const STORE_CART_CLEARANCE = 92;
/** Cuántos platos sugeridos como acompañamiento se muestran como máximo. */
const MAX_SUGGESTIONS = 6;

export default function BusinessScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();

  const { data: business, isLoading, isError, refetch } = useBusiness(id);
  const { data: sections = [] } = useBusinessCategories(id);
  const { data: products = [], isLoading: loadingProducts } =
    useBusinessProducts(id) as { data: Product[]; isLoading: boolean };

  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);

  const { toggleFavorite, isFavorite } = useFavoritesStore();
  const bottomInset = useBottomInset();

  const cartBusinessId = useCartStore((s) => s.businessId);
  const cartItemCount = useCartStore((s) => s.getItemCount());
  const cartSubtotal = useCartStore((s) => s.getSubtotal());

  const status = openState(business?.schedule);
  const accent = businessAccent(id);

  const visibleProducts = useMemo(() => {
    if (!activeSection) return products;
    return products.filter((p) => p.categoryId === activeSection);
  }, [products, activeSection]);

  if (isLoading) return <LoadingScreen message="Abriendo el menú…" />;

  if (isError || !business) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
        <ErrorState
          title="No encontramos este negocio"
          message="Puede que ya no esté disponible en Zipp."
          onRetry={refetch}
        />
        <View style={styles.errorAction}>
          <Button
            title="Volver al inicio"
            variant="secondary"
            full
            onPress={() => router.replace('/(client)/(tabs)/home')}
          />
        </View>
      </SafeAreaView>
    );
  }

  const HeroIllustration = categoryIllustration(business.category);

  // Solo se ofrece "seguir agregando" cuando lo que hay en la bolsa es de
  // ESTE negocio: la bolsa es de un solo negocio a la vez, así que si el
  // cliente trae algo de otro lado, esta pantalla no debe insinuar que
  // puede sumarlo aquí.
  const showCartBar = cartItemCount > 0 && cartBusinessId === business._id;

  const share = async () => {
    try {
      await Share.share({
        message: `${business.name} está en Zipp. ${business.description || 'Pide a domicilio.'}`,
      });
    } catch {
      // El usuario canceló la hoja de compartir. No hay nada que reportar.
    }
  };

  const openMap = () => {
    const lat = business.location?.coordinates?.[1];
    const lng = business.location?.coordinates?.[0];
    if (!lat || !lng) return;

    const url = Platform.select({
      ios: `maps:0,0?q=${business.name}@${lat},${lng}`,
      android: `geo:0,0?q=${lat},${lng}(${business.name})`,
    });
    if (url) Linking.openURL(url).catch(() => {});
  };

  const call = () => {
    if (business.phone) Linking.openURL(`tel:${business.phone}`).catch(() => {});
  };

  const favorite = isFavorite(business._id);

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <SafeAreaView edges={['top']} style={styles.navWrap}>
        <View style={styles.nav}>
          <IconButton
            icon="atras"
            label="Volver"
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/(client)/(tabs)/home');
            }}
          />
          <View style={styles.navRight}>
            <IconButton icon="compartir" label="Compartir este negocio" onPress={share} />
            <IconButton
              icon="favorito"
              label={favorite ? 'Quitar de favoritos' : 'Guardar en favoritos'}
              tone={favorite ? 'danger' : 'neutral'}
              filled={favorite}
              onPress={() => {
                tap(favorite ? 'light' : 'success');
                toggleFavorite({
                  _id: business._id,
                  name: business.name,
                  category: business.category,
                  rating: business.rating,
                  deliveryTime: business.deliveryTime,
                  description: business.description,
                });
              }}
            />
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={sections.length > 0 ? [1] : undefined}
        contentContainerStyle={{
          paddingBottom: bottomInset + Spacing.huge + (showCartBar ? STORE_CART_CLEARANCE : 0),
        }}
      >
        {/* ── Portada e identidad ── */}
        <View>
          <View style={[styles.hero, { backgroundColor: accent }]}>
            {business.coverImage ? (
              <Image
                source={{ uri: business.coverImage }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={220}
                accessible={false}
              />
            ) : (
              <View style={styles.heroBadgeCircle}>
                <HeroIllustration size={56} />
              </View>
            )}
            <View style={[styles.heroFade, { backgroundColor: c.background }]} />
          </View>

          <View style={styles.info}>
            <Text v="displayL">{business.name}</Text>
            {business.description ? (
              <Text v="bodyM" tone="textSecondary">{business.description}</Text>
            ) : null}

            <MetaRow
              items={[
                { icon: 'calificacion', text: business.rating.toFixed(1), strong: true, tone: 'text' },
                { text: `${business.totalReviews ?? 0} reseñas` },
                { icon: 'minutos', text: minutes(business.deliveryTime) },
              ]}
            />

            <View style={styles.badges}>
              <Badge
                label={status.label || (status.open ? 'Abierto' : 'Cerrado')}
                tone={status.open ? 'lime' : 'neutral'}
                icon="reloj"
              />
              {business.minOrder ? (
                <Badge label={`Pedido mínimo ${money(business.minOrder)}`} tone="neutral" icon="bolsa" />
              ) : null}
            </View>

            <View style={styles.actions}>
              {business.phone ? (
                <Button title="Llamar" icon="llamar" variant="secondary" size="sm" onPress={call} />
              ) : null}
              <Button title="Cómo llegar" icon="ubicacion" variant="secondary" size="sm" onPress={openMap} />
            </View>

            {!status.open ? (
              <Notice tone="warning">
                Este negocio está cerrado ahora. Puedes mirar el menú, pero no recibir pedidos hasta que abra.
              </Notice>
            ) : null}
          </View>
        </View>

        {/* ── Secciones del menú (fijas al desplazar) ── */}
        {sections.length > 0 ? (
          <View style={[styles.tabs, { backgroundColor: c.background, borderBottomColor: c.border }]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabsRow}
            >
              <SectionTab
                label="Todo"
                active={activeSection === null}
                onPress={() => setActiveSection(null)}
              />
              {sections.map((section: any) => (
                <SectionTab
                  key={section._id}
                  label={section.name}
                  active={activeSection === section._id}
                  onPress={() => setActiveSection(section._id)}
                />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* ── Productos ── */}
        <View style={styles.products}>
          {loadingProducts ? (
            <View style={styles.productSkeletons}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={styles.productSkeleton}>
                  <Skeleton width={84} height={84} radius={BorderRadius.md} />
                  <View style={styles.flex}>
                    <Skeleton width="70%" height={17} />
                    <Skeleton width="90%" height={13} style={{ marginTop: 8 }} />
                    <Skeleton width="35%" height={15} style={{ marginTop: 12 }} />
                  </View>
                </View>
              ))}
            </View>
          ) : visibleProducts.length === 0 ? (
            <EmptyState
              icon="catRestaurante"
              title="Sin productos aquí"
              message="Esta sección todavía no tiene nada. Prueba con otra."
              compact
            />
          ) : (
            visibleProducts.map((product) => (
              <ProductRow
                key={product._id}
                product={product}
                accent={accent}
                category={business.category}
                disabled={!status.open}
                onPress={() => { tap('light'); setSelected(product); }}
              />
            ))
          )}
        </View>
      </ScrollView>

      {selected ? (
        <ProductSheet
          product={selected}
          allProducts={products}
          accent={accent}
          category={business.category}
          businessId={business._id}
          businessName={business.name}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {/*
        Resumen fijo de la bolsa mientras se sigue viendo la misma tienda.
        Vive en esta pantalla (no en el Dock de las pestañas) porque solo
        tiene sentido dentro del negocio donde se está agregando: al salir,
        el Dock retoma el aviso y el cliente puede seguir sumando cosas
        desde el inicio o la búsqueda.
      */}
      {showCartBar ? (
        <StoreCartBar
          count={cartItemCount}
          subtotal={cartSubtotal}
          bottomInset={bottomInset}
          onPress={() => router.push('/(client)/cart')}
        />
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────

function SectionTab({
  label, active, onPress,
}: { label: string; active: boolean; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => { tap('select'); onPress(); }}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={styles.tab}
    >
      <Text v={active ? 'strongM' : 'bodyM'} tone={active ? 'text' : 'textMuted'}>
        {label}
      </Text>
      {/* El trazo de la marca marcando la sección activa. */}
      <View
        style={[
          styles.tabMark,
          { backgroundColor: active ? c.lime : 'transparent' },
        ]}
      />
    </Pressable>
  );
}

function ProductRow({
  product, accent, category, disabled, onPress,
}: { product: Product; accent: string; category: string; disabled: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const unavailable = !product.isAvailable || disabled;
  const hasDiscount = product.discountPrice != null;
  const Illustration = categoryIllustration(category);

  return (
    <Pressable
      onPress={unavailable ? undefined : onPress}
      disabled={unavailable}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}. ${money(product.discountPrice ?? product.price)}${!product.isAvailable ? '. Agotado' : ''}`}
      accessibilityHint={unavailable ? undefined : 'Abre las opciones del producto'}
      accessibilityState={{ disabled: unavailable }}
      style={[
        styles.product,
        { backgroundColor: c.surface, borderColor: c.border },
        unavailable && styles.productOff,
      ]}
    >
      {/*
        84 pt en pantalla: se pide la variante de 200 px, no la de
        catálogo. En una lista de treinta productos la diferencia es de
        megabytes sobre datos móviles.
      */}
      <View style={[styles.productImage, { backgroundColor: hasProductImage(product) ? accent : c.surfaceLight }]}>
        {hasProductImage(product) ? (
          <Image
            source={{ uri: productImageUri(product, 'thumb')! }}
            placeholder={productImagePlaceholder(product)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            accessible={false}
          />
        ) : (
          <Illustration size={44} />
        )}
        {!product.isAvailable ? (
          <View style={styles.soldOut}>
            <Text v="captionStrong" color="#FFFFFF">AGOTADO</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.productBody}>
        <Text v="titleS" numberOfLines={1}>{product.name}</Text>
        {product.description ? (
          <Text v="bodyS" tone="textMuted" numberOfLines={2}>{product.description}</Text>
        ) : null}

        <View style={styles.priceRow}>
          <Text v="dataM" tone={hasDiscount ? 'limeText' : 'text'}>
            {money(product.discountPrice ?? product.price)}
          </Text>
          {hasDiscount ? (
            <Text v="dataS" tone="textMuted" style={styles.strike}>
              {money(product.price)}
            </Text>
          ) : null}
        </View>
      </View>

      {!unavailable ? (
        <View style={[styles.addBtn, { backgroundColor: c.primary }]}>
          <Icon name="mas" size="md" color={c.textOnPrimary} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Barra de "mi coronita": lo que ya lleva de esta tienda, siempre a la mano. */
function StoreCartBar({
  count, subtotal, bottomInset, onPress,
}: { count: number; subtotal: number; bottomInset: number; onPress: () => void }) {
  const { c } = useTheme();

  return (
    <Animated.View
      entering={FadeInDown.springify().damping(18)}
      exiting={FadeOutDown}
      layout={Layout}
      style={[styles.storeCartWrap, { bottom: bottomInset + Spacing.md }]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={() => { tap('medium'); onPress(); }}
        accessibilityRole="button"
        accessibilityLabel={`Ir a mi coronita. ${count} ${count === 1 ? 'producto' : 'productos'}. Subtotal ${money(subtotal)}`}
        accessibilityHint="Abre tu pedido para revisarlo o pagarlo"
        style={[styles.storeCart, { backgroundColor: c.primary }, Shadow.primaryGlow]}
      >
        <View style={[styles.storeCartCount, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
          <Text v="dataM" color={c.textOnPrimary}>{count}</Text>
        </View>

        <View style={styles.flex}>
          <Text v="buttonMd" color={c.textOnPrimary}>Ir a mi coronita</Text>
          <Text v="caption" color="rgba(255,255,255,0.75)">Puedes seguir agregando más</Text>
        </View>

        <Text v="dataL" color={c.textOnPrimary}>{money(subtotal)}</Text>
      </Pressable>
    </Animated.View>
  );
}

// ──────────────────────────────────────────────────────────────
// Hoja de producto
// ──────────────────────────────────────────────────────────────

function ProductSheet({
  product, allProducts, accent, category, businessId, businessName, onClose,
}: {
  product: Product;
  allProducts: Product[];
  accent: string;
  category: string;
  businessId: string;
  businessName: string;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const addItem = useCartStore((s) => s.addItem);
  const Illustration = categoryIllustration(category);

  const [quantity, setQuantity] = useState(1);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [notes, setNotes] = useState('');
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const unitPrice = product.discountPrice ?? product.price;
  const extrasTotal = extras.reduce((sum, e) => sum + e.price, 0);
  const lineTotal = (unitPrice + extrasTotal) * quantity;

  // Primero lo de otras secciones del menú (la bebida, el postre, el
  // adicional que no es del mismo plato): eso es lo que de verdad "acompaña".
  // Si el negocio no tiene más secciones, se completa con lo que haya.
  const suggestions = useMemo(() => {
    return allProducts
      .filter((p) => p._id !== product._id && p.isAvailable)
      .sort((a, b) => {
        const aPaired = a.categoryId !== product.categoryId ? 0 : 1;
        const bPaired = b.categoryId !== product.categoryId ? 0 : 1;
        return aPaired - bPaired;
      })
      .slice(0, MAX_SUGGESTIONS);
  }, [allProducts, product]);

  const quickAdd = (suggested: Product) => {
    tap('success');
    addItem(businessId, businessName, {
      productId: suggested._id,
      productName: suggested.name,
      quantity: 1,
      unitPrice: suggested.discountPrice ?? suggested.price,
      selectedExtras: [],
      notes: '',
    });
    setJustAdded(suggested._id);
    setTimeout(() => {
      setJustAdded((current) => (current === suggested._id ? null : current));
    }, 1200);
  };

  const toggleExtra = (extra: Extra) => {
    tap('select');
    setExtras((current) =>
      current.some((e) => e.name === extra.name)
        ? current.filter((e) => e.name !== extra.name)
        : [...current, extra]
    );
  };

  const add = () => {
    addItem(businessId, businessName, {
      productId: product._id,
      productName: product.name,
      quantity,
      unitPrice,
      selectedExtras: extras.map((e) => ({ name: e.name, price: e.price, quantity: 1 })),
      notes: notes.trim(),
    });
    onClose();
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      title={product.name}
      height={0.86}
      footer={
        <View style={styles.sheetFooter}>
          <QtyStepper value={quantity} onChange={setQuantity} min={1} itemName={product.name} />
          <Button
            title="Agregar"
            trailing={money(lineTotal)}
            size="lg"
            style={styles.flex}
            onPress={add}
            haptic="medium"
          />
        </View>
      }
    >
      <Animated.View
        entering={FadeIn.duration(220)}
        style={[styles.sheetHero, { backgroundColor: hasProductImage(product) ? accent : c.surfaceLight }]}
      >
        {hasProductImage(product) ? (
          <Image
            source={{ uri: productImageUri(product, 'detail')! }}
            placeholder={productImagePlaceholder(product)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            accessible={false}
          />
        ) : (
          <Illustration size={64} />
        )}
      </Animated.View>

      <View style={styles.sheetHead}>
        <Text v="dataL" tone="primaryText">{money(unitPrice)}</Text>
        {product.description ? (
          <Text v="bodyM" tone="textSecondary">{product.description}</Text>
        ) : null}
      </View>

      {product.extras && product.extras.length > 0 ? (
        <View style={styles.sheetSection}>
          <Text v="label" tone="textMuted">Agrégale algo</Text>
          <View style={[styles.extras, { borderColor: c.border }]}>
            {product.extras.map((extra, i) => {
              const checked = extras.some((e) => e.name === extra.name);
              return (
                <Pressable
                  key={extra.name}
                  onPress={() => toggleExtra(extra)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={`${extra.name}, ${money(extra.price)} adicional`}
                  style={[
                    styles.extra,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                  ]}
                >
                  <View
                    style={[
                      styles.checkbox,
                      {
                        backgroundColor: checked ? c.primary : 'transparent',
                        borderColor: checked ? c.primary : c.borderStrong,
                      },
                    ]}
                  >
                    {checked ? <Icon name="check" size={14} color={c.textOnPrimary} strong /> : null}
                  </View>
                  <Text v="bodyM" style={styles.flex}>{extra.name}</Text>
                  <Text v="dataS" tone="textMuted">+{money(extra.price)}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {suggestions.length > 0 ? (
        <View style={styles.sheetSection}>
          <Text v="label" tone="textMuted">Para acompañar</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.suggestRow}
          >
            {suggestions.map((item) => {
              const added = justAdded === item._id;
              const itemPrice = item.discountPrice ?? item.price;
              return (
                <View
                  key={item._id}
                  style={[styles.suggestCard, { backgroundColor: c.surface, borderColor: c.border }]}
                >
                  <View
                    style={[
                      styles.suggestImage,
                      { backgroundColor: hasProductImage(item) ? accent : c.surfaceLight },
                    ]}
                  >
                    {hasProductImage(item) ? (
                      <Image
                        source={{ uri: productImageUri(item, 'thumb')! }}
                        placeholder={productImagePlaceholder(item)}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        accessible={false}
                      />
                    ) : (
                      <Illustration size={26} />
                    )}
                  </View>

                  <Text v="bodyS" numberOfLines={1}>{item.name}</Text>

                  <View style={styles.suggestFooter}>
                    <Text v="dataS" tone="textMuted">{money(itemPrice)}</Text>
                    <Pressable
                      onPress={() => quickAdd(item)}
                      disabled={added}
                      accessibilityRole="button"
                      accessibilityLabel={added ? `${item.name} agregado` : `Agregar ${item.name}, ${money(itemPrice)} adicional`}
                      style={[styles.suggestAddBtn, { backgroundColor: added ? c.lime : c.primary }]}
                    >
                      <Icon name={added ? 'check' : 'mas'} size="sm" color={c.textOnPrimary} strong />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.sheetSection}>
        <View style={styles.notesLabel}>
          <Text v="label" tone="textMuted">¿Alguna indicación?</Text>
          <Text v="dataXS" tone="textMuted">{notes.length}/140</Text>
        </View>
        <TextInput
          value={notes}
          onChangeText={setNotes}
          multiline
          maxLength={140}
          placeholder="Ej: sin cebolla, bien caliente, salsa aparte…"
          placeholderTextColor={c.textMuted}
          accessibilityLabel="Indicaciones para el negocio"
          style={[
            styles.notes,
            Type.bodyM,
            { backgroundColor: c.surface, borderColor: c.border, color: c.text },
          ]}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  errorAction: { paddingHorizontal: Spacing.xxl, paddingBottom: Spacing.huge },

  navWrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20 },
  nav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
  },
  navRight: { flexDirection: 'row', gap: Spacing.sm },

  hero: { height: 210, alignItems: 'center', justifyContent: 'center' },
  heroBadgeCircle: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  heroFade: {
    position: 'absolute', bottom: -1, left: 0, right: 0, height: 28,
    borderTopLeftRadius: BorderRadius.xxl, borderTopRightRadius: BorderRadius.xxl,
  },
  info: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl, gap: Spacing.md },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  actions: { flexDirection: 'row', gap: Spacing.sm },

  tabs: { borderBottomWidth: StyleSheet.hairlineWidth },
  tabsRow: { paddingHorizontal: Spacing.xl, gap: Spacing.xl },
  tab: { alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.md },
  tabMark: { height: 3, width: 22, borderRadius: 2 },

  products: { padding: Spacing.xl, gap: Spacing.md },
  productSkeletons: { gap: Spacing.md },
  productSkeleton: { flexDirection: 'row', gap: Spacing.md },

  product: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
  },
  productOff: { opacity: 0.55 },
  productImage: {
    width: 84, height: 84, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  soldOut: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,11,20,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  productBody: { flex: 1, gap: 3 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: 2 },
  strike: { textDecorationLine: 'line-through' },
  addBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    ...Shadow.sm,
  },

  sheetHero: {
    height: 168,
    borderRadius: BorderRadius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sheetHead: { gap: Spacing.sm },
  sheetSection: { gap: Spacing.sm },
  extras: { borderRadius: BorderRadius.lg, borderWidth: 1, overflow: 'hidden' },
  extra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
  },
  checkbox: {
    width: 24, height: 24, borderRadius: 7, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  notesLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  notes: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    padding: Spacing.md,
    minHeight: 92,
    textAlignVertical: 'top',
  },
  sheetFooter: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },

  suggestRow: { gap: Spacing.md, paddingRight: Spacing.md },
  suggestCard: {
    width: 128,
    padding: Spacing.sm + 2,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    gap: Spacing.xs + 1,
  },
  suggestImage: {
    width: '100%', height: 64, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  suggestFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  suggestAddBtn: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
  },

  storeCartWrap: { position: 'absolute', left: Spacing.lg, right: Spacing.lg },
  storeCart: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    height: 60,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.lg,
  },
  storeCartCount: {
    minWidth: 34, height: 34, borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center', justifyContent: 'center',
  },
});
