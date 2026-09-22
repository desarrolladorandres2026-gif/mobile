import { useState, useMemo, useCallback, useRef, useEffect, memo } from 'react';
import {
  View, ScrollView, Pressable, StyleSheet, Share, TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import { Lightbox } from '../../../components/domain/Lightbox';
import { ReviewsSheet } from '../../../components/domain/ReviewsSheet';
import { BusinessHeader, BusinessPromoBanner } from '../../../components/domain/BusinessHeader';
import { formatDistance } from '../../../components/domain/BusinessCard';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown, FadeOutDown, Layout } from 'react-native-reanimated';
import {
  Text, Icon, IconButton, Button, Badge, CatalogBadge, MetaRow, Notice, Sheet,
  QtyStepper, EmptyState, ErrorState, Skeleton, LoadingScreen, SearchField,
} from '../../../components/ui';
import {
  useBusiness, useBusinessCategories, useBusinessProducts, useTopSellers, useProductSentiment, useStorefront,
} from '../../../hooks/useApi';
import { useCartStore } from '../../../stores/cartStore';
import { useProgressiveLimit } from '../../../hooks/useProgressiveLimit';
import { useFavorites } from '../../../hooks/useFavorites';
import { useTheme } from '../../../hooks/useTheme';
import { useBottomInset } from '../../../hooks/useBottomSpace';
import { categoryIllustration } from '../../../components/illustrations';
import { Type } from '../../../theme/typography';
import { BorderRadius, Shadow, Spacing } from '../../../theme/tokens';
import { businessAccent, openState } from '../../../lib/business';
import { API_ORIGIN } from '../../../constants/config';
import { money } from '../../../lib/format';
import { tap } from '../../../lib/haptics';
import {
  freeDeliveryGap, likeRatio, catalogBadges, discountPercent, pickSuggestions,
} from '../../../lib/catalog';
import { SuggestionRow } from '../../../components/domain/SuggestionRow';
import { normalize, matches } from '../../../lib/text';
import {
  productImageUri, productImagePlaceholder, productImageStepDown, hasProductImage, productGallery,
  type ProductImages,
} from '../../../lib/productImage';
import {
  hasModifierUI, needsChoices, sortedGroups, toggleChoice, selectionTotal,
  firstUnmetGroup, groupHint, isRequired, isSingle, countIn,
  type ModifierGroup, type ModifierChoice,
} from '../../../lib/modifiers';

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
  /** Fotos adicionales para el visor. La principal no está aquí. */
  galleryImages?: ProductImages[] | null;
  isAvailable: boolean;
  extras?: Extra[];
  /** Grupos con reglas (obligatorio, mínimo, máximo). Ver `lib/modifiers.ts`. */
  modifierGroups?: ModifierGroup[];
  categoryId?: string;
  /** Alimentan los distintivos de catálogo. Ver `lib/catalog.ts`. */
  isFeatured?: boolean;
  createdAt?: string;
  /** Minutos de cocina propios de este plato. Null hereda el del negocio. */
  prepTimeMinutes?: number | null;
}

/** Referencias estables para "todavía no hay datos": un `[]` nuevo en cada render rompe los `useMemo`. */
const EMPTY_LIST: any[] = [];
const EMPTY_SENTIMENT: Record<string, { likes: number; total: number }> = {};

/** Filas de la carta que se montan con la pantalla; el resto, tras la animación. */
const INITIAL_PRODUCT_ROWS = 10;

/** Espacio que reserva el scroll cuando la barra de "mi coronita" está a la vista. */
const STORE_CART_CLEARANCE = 92;

/** Cartas a partir de las cuales se ofrece buscar dentro del negocio. */
const MENU_SEARCH_MIN = 8;

export default function BusinessScreen() {
  const { id, productId } = useLocalSearchParams<{ id: string; productId?: string }>();
  const router = useRouter();
  const { c } = useTheme();

  // Una petición para toda la tienda (ver `useStorefront`). Los hooks de
  // cada parte leen lo que ella siembra; solo piden por su cuenta si el
  // servidor no tiene todavía ese endpoint. Con caché guardada de otra
  // visita, todo se pinta al instante mientras se refresca.
  const storefront = useStorefront(id);
  const fallback = storefront.isError;
  const waitingStorefront = storefront.isPending;

  const { data: business, isLoading: loadingBusiness, isError: businessError, refetch: refetchBusiness } =
    useBusiness(id, fallback);
  const { data: sectionsData } = useBusinessCategories(id, fallback);
  const sections: any[] = sectionsData ?? EMPTY_LIST;

  // Lo que la gente pide de verdad, no lo que el negocio marcó como
  // destacado. Solo se muestra sin filtro de sección activo: dentro de
  // "Bebidas", una lista de los más pedidos del local entero desorienta.
  const { data: topSellersData } = useTopSellers(id, fallback);
  const topSellers: Product[] = topSellersData ?? EMPTY_LIST;
  const { data: sentimentData } = useProductSentiment(id, fallback);
  const sentiment: Record<string, { likes: number; total: number }> = sentimentData ?? EMPTY_SENTIMENT;
  const { data: productsData, isLoading: loadingProductsFallback } =
    useBusinessProducts(id, undefined, fallback) as { data: Product[] | undefined; isLoading: boolean };
  const products: Product[] = productsData ?? EMPTY_LIST;

  const isLoading = (waitingStorefront && !business) || loadingBusiness;
  const loadingProducts = (waitingStorefront && !productsData) || loadingProductsFallback;
  const isError = fallback && businessError;
  const refetch = () => (fallback ? refetchBusiness() : storefront.refetch());

  // La carta se monta en dos tiempos: las primeras filas ya, el resto
  // cuando termina la animación de entrada. Montar cuarenta filas con foto
  // en el mismo instante competía con el deslizamiento de la pantalla.
  const renderLimit = useProgressiveLimit(INITIAL_PRODUCT_ROWS);

  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [reviewsOpen, setReviewsOpen] = useState(false);

  /**
   * `stickyHeaderIndices` pega la barra de búsqueda contra el borde real
   * de la pantalla (y=0 del ScrollView), tape o no el notch: mientras
   * todavía va bajando junto con la portada no necesita el hueco del
   * notch, y solo hace falta apenas queda enganchada arriba del todo.
   * Por eso el padding del notch solo se activa después de ese punto,
   * medido con el alto real de la portada+info (`headerHeight`).
   */
  const [headerHeight, setHeaderHeight] = useState(0);
  const [menuStuck, setMenuStuck] = useState(false);

  /**
   * Llegar con `?productId=` —desde la tira de platos de Inicio— abre esa
   * ficha sola, en cuanto la carta termine de cargar.
   *
   * El ref y no `selected` en las dependencias: si dependiera de `selected`,
   * cerrar la hoja lo pondría en `null` otra vez, el efecto se repetiría con
   * el mismo `productId` en la URL, y la ficha se reabriría sola sin dejar
   * cerrarla nunca.
   */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!productId || autoOpened.current) return;
    const found = products.find((p) => p._id === productId);
    if (!found) return;
    autoOpened.current = true;
    setSelected(found);
  }, [productId, products]);

  // Estable, para que el `memo` de `ProductRow` sirva: con una funcion nueva
  // en cada render, las cuarenta filas se volvian a renderizar igual.
  const selectProduct = useCallback((product: Product) => {
    tap('light');
    setSelected(product);
  }, []);

  const bottomInset = useBottomInset();
  const { top: topInset } = useSafeAreaInsets();

  const cartItemCount = useCartStore((s) => s.getItemCount(business?._id));
  const cartSubtotal = useCartStore((s) => s.getSubtotal(business?._id ?? ''));

  const status = openState(business?.schedule);
  const accent = businessAccent(id);
  // Es un dato del pedido —cuánto falta para alcanzarlo— y no del negocio
  // como tal, así que se enseña sobre cada plato en vez de una sola vez
  // arriba: es justo donde el cliente decide si le suma algo más al carrito.
  const freeDelivery = !!business?.freeDeliveryThreshold && business.freeDeliveryThreshold > 0;

  /**
   * La carta filtrada por sección y por lo que el usuario esté buscando.
   *
   * El filtro es local y no cuesta una petición: los productos ya están
   * todos cargados para pintar el menú.
   *
   * Con término escrito se ignoran las secciones. Quien busca "gaseosa" no
   * quiere saber en qué apartado la metió el dueño, y respetar la pestaña
   * activa haría que buscar desde "Hamburguesas" no encontrara la bebida
   * que está ahí mismo en la carta.
   */
  const visibleProducts = useMemo(() => {
    const needle = normalize(productQuery.trim());

    if (needle.length >= 2) {
      return products.filter(
        (p) => matches(p.name, needle) || matches(p.description, needle)
      );
    }

    if (!activeSection) return products;
    return products.filter((p) => p.categoryId === activeSection);
  }, [products, activeSection, productQuery]);

  const searchingMenu = normalize(productQuery.trim()).length >= 2;

  // Por debajo de esto, recorrer la carta con el dedo es más rápido que
  // escribir, y una caja de búsqueda sobre seis platos solo estorba.
  const showMenuTools = sections.length > 0 || products.length >= MENU_SEARCH_MIN;

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


  // Cada negocio tiene su propia bolsa, así que basta con mirar la de este.
  const showCartBar = cartItemCount > 0;

  /**
   * Comparte un enlace de verdad, no un mensaje de texto.
   *
   * No apunta directo a la página de `web/` (esa es una SPA de React: el
   * rastreador de vista previa de WhatsApp no ejecuta JavaScript, así que
   * vería el HTML vacío de antes de que React pinte nada). Apunta a
   * `/negocio/:slug` del **backend**, que arma esas etiquetas del lado del
   * servidor con los datos reales del negocio — nombre, descripción, foto
   * — y solo después manda a un humano de verdad a la página interactiva.
   * Ver `businessShare.controller.ts` para el porqué completo.
   *
   * `url` es lo que iOS usa para compartirlo como enlace real —con vista
   * previa, no como texto suelto—; Android no distingue el campo `url` de
   * `message`, así que el mismo valor va en los dos y WhatsApp/SMS
   * reconocen la URL dentro del texto igual.
   */
  const share = async () => {
    const link = `${API_ORIGIN}/negocio/${business.slug}`;
    try {
      await Share.share({ message: link, url: link, title: business.name });
    } catch {
      // El usuario canceló la hoja de compartir. No hay nada que reportar.
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={showMenuTools ? [1] : undefined}
        onScroll={(e) => {
          if (!headerHeight) return;
          const stuck = e.nativeEvent.contentOffset.y >= headerHeight;
          setMenuStuck((prev) => (prev === stuck ? prev : stuck));
        }}
        scrollEventThrottle={32}
        contentContainerStyle={{
          paddingBottom: bottomInset + Spacing.huge + (showCartBar ? STORE_CART_CLEARANCE : 0),
        }}
      >
        {/* ── Portada e identidad ── */}
        <View onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}>
          <BusinessHeader
            business={business}
            fallbackAccent={accent}
            distanceLabel={formatDistance(business.distanceMeters)}
            statusBadge={
              <View style={styles.statusRow}>
                <Icon name="reloj" size="sm" color={status.open ? c.limeText : c.textMuted} />
                <Text v="strongS" color={status.open ? c.limeText : c.textMuted}>
                  {status.label || (status.open ? 'Abierto' : 'Cerrado')}
                </Text>
              </View>
            }
          />

          {/* Volver/compartir van sobre la portada y se van con ella al
              desplazar: fijarlos habría tapado el notch (la sticky de abajo
              ya resuelve la necesidad de tener algo siempre a mano). */}
          <SafeAreaView edges={['top']} style={styles.navWrap} pointerEvents="box-none">
            <View style={styles.nav}>
              <IconButton
                icon="atras"
                label="Volver"
                onPress={() => {
                  if (router.canGoBack()) router.back();
                  else router.replace('/(client)/(tabs)/home');
                }}
              />
              <IconButton icon="compartir" label="Compartir este negocio" onPress={share} />
            </View>
          </SafeAreaView>

          <View style={styles.info}>
            <Pressable
              onPress={() => { tap('light'); setReviewsOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel={`Calificación ${business.rating.toFixed(1)} de 5, ${business.totalReviews ?? 0} reseñas`}
              accessibilityHint="Ver las reseñas de este negocio"
              style={styles.ratingRow}
            >
              {/* Solo la calificación: el tiempo de entrega y la distancia
                  ya los dice la tarjeta de arriba, y repetir el mismo
                  número dos veces en la misma pantalla es ruido. */}
              <MetaRow
                items={[
                  { icon: 'calificacion', text: business.rating.toFixed(1), strong: true, tone: 'text' },
                  { text: `${business.totalReviews ?? 0} reseñas` },
                ]}
              />
              <Icon name="siguiente" size="sm" color={c.textMuted} />
            </Pressable>


            <BusinessPromoBanner business={business} />

            {!status.open ? (
              <Notice tone="warning">
                Este negocio está cerrado ahora. Puedes mirar el menú, pero no recibir pedidos hasta que abra.
              </Notice>
            ) : null}
          </View>
        </View>

        {/* ── Buscar en la carta y secciones (fijos al desplazar) ── */}
        {showMenuTools ? (
          <View style={[styles.tabs, { backgroundColor: c.background, borderBottomColor: c.border, paddingTop: menuStuck ? topInset : 0 }]}>
            {/* Queda fijo al desplazar a propósito: en una carta larga, el
                momento en que hace falta buscar es justo cuando ya se lleva
                medio menú recorrido y la cabecera quedó arriba del todo. */}
            {products.length >= MENU_SEARCH_MIN ? (
              <View style={styles.menuSearch}>
                <SearchField
                  value={productQuery}
                  onChange={setProductQuery}
                  placeholder={`Buscar en ${business.name}`}
                />
              </View>
            ) : null}

            {sections.length > 0 && !searchingMenu ? (
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
            ) : null}
          </View>
        ) : null}

        {/* ── Productos ── */}
        <View style={styles.products}>
          {loadingProducts ? (
            <View style={styles.productSkeletons}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={styles.productSkeleton}>
                  <Skeleton width={136} height={136} radius={BorderRadius.lg} />
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
              title={searchingMenu ? 'Nada con ese nombre' : 'Sin productos aquí'}
              message={
                searchingMenu
                  ? 'Este negocio no tiene nada que se llame así. Prueba con otra palabra.'
                  : 'Esta sección todavía no tiene nada. Prueba con otra.'
              }
              actionLabel={searchingMenu ? 'Ver toda la carta' : undefined}
              onAction={searchingMenu ? () => setProductQuery('') : undefined}
              compact
            />
          ) : (
            <>
            {!activeSection && topSellers.length > 1 ? (
              <View style={styles.topBlock}>
                <View style={styles.topTitle}>
                  <Icon name="racha" size="sm" color={c.primary} />
                  <Text v="strongS">Los más pedidos</Text>
                </View>
                {topSellers.slice(0, 3).map((product: Product) => (
                  <ProductRow
                    key={`top-${product._id}`}
                    product={product}
                    accent={accent}
                    category={business.category}
                    disabled={!status.open}
                    likePercent={likeRatio(sentiment[product._id])}
                    freeDelivery={freeDelivery}
                    fallbackPrepMinutes={business.deliveryTime}
                    onPress={selectProduct}
                  />
                ))}
              </View>
            ) : null}

            {visibleProducts.slice(0, renderLimit).map((product) => (
              <ProductRow
                key={product._id}
                product={product}
                accent={accent}
                category={business.category}
                disabled={!status.open}
                likePercent={likeRatio(sentiment[product._id])}
                freeDelivery={freeDelivery}
                fallbackPrepMinutes={business.deliveryTime}
                onPress={selectProduct}
              />
            ))}
            </>
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
          businessLogo={business.logo}
          fallbackPrepMinutes={business.deliveryTime}
          onClose={() => setSelected(null)}
          onOpenProduct={setSelected}
        />
      ) : null}

      <ReviewsSheet
        visible={reviewsOpen}
        onClose={() => setReviewsOpen(false)}
        businessId={business._id}
        businessName={business.name}
        rating={business.rating}
        totalReviews={business.totalReviews ?? 0}
      />

      {/*
        Resumen fijo de la bolsa mientras se sigue viendo la misma tienda.
        Vive en esta pantalla (no en el Dock de las pestañas) porque solo
        tiene sentido dentro del negocio donde se está agregando: al salir,
        el Dock retoma el aviso y el cliente puede seguir sumando cosas
        desde el inicio o la búsqueda.
      */}
      {showCartBar ? (
        <StoreCartBar
          freeDeliveryThreshold={business.freeDeliveryThreshold}
          count={cartItemCount}
          subtotal={cartSubtotal}
          bottomInset={bottomInset}
          onPress={() => router.push({ pathname: '/(client)/cart', params: { businessId: business._id } })}
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

/**
 * Una fila de la carta.
 *
 * Va memoizada, y `onPress` recibe el producto en vez de venir ya cerrada
 * sobre él. Las dos cosas hacen falta juntas: con la función inline que
 * había antes, la prop cambiaba en cada render del padre y el `memo` no
 * habría servido de nada.
 *
 * Importa más de lo que parece porque la carta se pinta entera —cuarenta
 * platos son cuarenta filas montadas de golpe— y cada tecla del buscador de
 * la carta re-renderizaba las cuarenta.
 */
const ProductRow = memo(function ProductRow({
  product, accent, category, disabled, onPress, likePercent, freeDelivery, fallbackPrepMinutes,
}: {
  product: Product;
  accent: string;
  category: string;
  disabled: boolean;
  onPress: (product: Product) => void;
  /** Pulgares arriba en porcentaje. Null si aún no hay votos suficientes. */
  likePercent?: number | null;
  /** Si el negocio regala el domicilio a partir de cierto monto. */
  freeDelivery?: boolean;
  /** `business.deliveryTime`, para cuando el plato no declaró un tiempo propio. */
  fallbackPrepMinutes: number;
}) {
  const { c } = useTheme();
  const unavailable = !product.isAvailable || disabled;
  const hasDiscount = product.discountPrice != null;
  const Illustration = categoryIllustration(category);

  // El descuento se cuenta dos veces: como cintillo sobre la foto —lo
  // primero que se ve al pasar el dedo, como en Rappi— y como precio
  // tachado en el cuerpo. Repetirlo además como chip de texto (lo que hacía
  // `CatalogBadges` completo) era la misma cifra tres veces en una fila de
  // 84 pt de alto.
  const pct = product.isAvailable ? discountPercent(product) : null;
  // "Nuevo" no aporta a la decisión de compra en la carta —solo asegura
  // que todo recién creado luzca igual de recién creado, sin distinguir
  // nada real— así que aquí solo queda "Destacado" como distintivo de texto.
  const otherBadges = product.isAvailable
    ? catalogBadges(product).filter((b) => b.kind !== 'descuento' && b.kind !== 'nuevo')
    : [];

  return (
    <Pressable
      onPress={unavailable ? undefined : () => onPress(product)}
      disabled={unavailable}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}. ${money(product.discountPrice ?? product.price)}${!product.isAvailable ? '. Agotado' : ''}`}
      accessibilityHint={unavailable ? undefined : 'Abre las opciones del producto'}
      accessibilityState={{ disabled: unavailable }}
      style={[styles.product, unavailable && styles.productOff]}
    >
      {/*
        136 pt en pantalla, a 3x eso son ~408 px: la variante de catálogo
        (400 px) ya alcanza sin subir a `detail`, que pesa el doble.
      */}
      <View style={[styles.productImage, { backgroundColor: hasProductImage(product) ? accent : c.surfaceLight }]}>
        {hasProductImage(product) ? (
          <Image
            source={{ uri: productImageUri(product, 'catalog')! }}
            placeholder={productImagePlaceholder(product)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            accessible={false}
          />
        ) : (
          <Illustration size={64} />
        )}
        {pct ? (
          <View style={styles.discountRibbon}>
            <CatalogBadge kind="descuento" label={`-${pct}%`} />
          </View>
        ) : null}
        {!product.isAvailable ? (
          <View style={styles.soldOut}>
            <Text v="captionStrong" color="#FFFFFF">AGOTADO</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.productBody}>
        <Text v="titleM" numberOfLines={1}>{product.name}</Text>

        {/* El velo de "AGOTADO" ya cubre la foto, así que aquí solo entran
            los distintivos que hablan de por qué merece la pena mirarlo,
            sin repetir el descuento que ya va en la foto. */}
        {otherBadges.length > 0 || (freeDelivery && product.isAvailable) ? (
          <View style={styles.badgeRow}>
            {/* Es información del pedido —cuánto falta para alcanzar el
                envío gratis, no del negocio como tal— así que va sobre cada
                plato, donde el cliente decide si suma algo más. */}
            {freeDelivery && product.isAvailable ? (
              <Badge label="Envío gratis" tone="lime" icon="domiciliario" />
            ) : null}
            {otherBadges.map((badge) => (
              <CatalogBadge key={badge.kind} kind={badge.kind} label={badge.label} />
            ))}
          </View>
        ) : null}

        <View style={styles.metaLine}>
          {/* Solo se enseña cuando la mayoría lo aprueba. Un "40% le gustó"
              junto al plato no informa: hunde la venta sin darle al negocio
              ninguna oportunidad de arreglarlo. */}
          {likePercent != null && likePercent >= 70 ? (
            <View style={styles.likeRow}>
              <Icon name="check" size={12} color={c.lime} strong />
              <Text v="caption" tone="textMuted">A {likePercent}% le gustó</Text>
            </View>
          ) : null}
          {/* Propio del plato si el negocio lo declaró; si no, el general
              del negocio (el mismo que usa el checkout para el estimado). */}
          <View style={styles.likeRow}>
            <Icon name="minutos" size={12} color={c.textMuted} />
            <Text v="caption" tone="textMuted">~{product.prepTimeMinutes ?? fallbackPrepMinutes} min</Text>
          </View>
        </View>
        {product.description ? (
          <Text v="bodyS" tone="textMuted" numberOfLines={2}>{product.description}</Text>
        ) : null}

        <View style={styles.priceRow}>
          <Text v="dataM" tone="primaryText">
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
});

/** Barra de "mi coronita": lo que ya lleva de esta tienda, siempre a la mano. */
function StoreCartBar({
  count, subtotal, bottomInset, onPress, freeDeliveryThreshold,
}: {
  count: number;
  subtotal: number;
  bottomInset: number;
  onPress: () => void;
  freeDeliveryThreshold?: number;
}) {
  const { c } = useTheme();

  // Cuánto falta para que el negocio le regale el domicilio. Es el único
  // mensaje de esta barra que le pide algo al cliente, así que sustituye al
  // texto de relleno en vez de sumarse: dos líneas compitiendo no las lee
  // nadie.
  const gap = freeDeliveryGap(subtotal, freeDeliveryThreshold);

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
          <Text v="caption" color="rgba(255,255,255,0.75)">
            {gap
              ? `Te faltan ${money(gap)} para el envío gratis`
              : freeDeliveryThreshold && subtotal >= freeDeliveryThreshold
                ? '¡Tienes envío gratis!'
                : 'Puedes seguir agregando más'}
          </Text>
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
  product, allProducts, accent, category, businessId, businessName, businessLogo, fallbackPrepMinutes, onClose, onOpenProduct,
}: {
  product: Product;
  allProducts: Product[];
  accent: string;
  category: string;
  businessId: string;
  businessName: string;
  /** Logo del negocio, para pintarlo en la bolsa en vez de un ícono genérico. */
  businessLogo?: string;
  /** `business.deliveryTime`, para cuando el plato no declaró un tiempo propio. */
  fallbackPrepMinutes: number;
  onClose: () => void;
  /** Abre la hoja de otro producto (una sugerencia que exige elegir algo). */
  onOpenProduct: (product: Product) => void;
}) {
  const { c } = useTheme();
  const addItem = useCartStore((s) => s.addItem);
  const Illustration = categoryIllustration(category);

  const [quantity, setQuantity] = useState(1);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [choices, setChoices] = useState<ModifierChoice[]>([]);
  /** El grupo que se resaltó por faltar, para que el cliente lo vea. */
  const [attention, setAttention] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const scrollRef = useRef<ScrollView | null>(null);
  const groupOffsets = useRef<Record<string, number>>({});
  const groups = useMemo(() => sortedGroups(product.modifierGroups), [product.modifierGroups]);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  /**
   * `favoritesApi` ya soportaba `kind: 'product'` desde siempre —el mismo
   * verbo que el corazón del negocio, mismo endpoint— y ninguna pantalla
   * lo usaba: solo se podían guardar negocios enteros, nunca un plato
   * concreto.
   */
  const { toggle: toggleProductFavorite, isFavorite: isProductFavorite } = useFavorites();
  const productFavorite = isProductFavorite(product._id, 'product');

  /** La principal primero: es la que se tocó para abrir el visor. */
  const gallery = useMemo(() => productGallery(product), [product]);

  const unitPrice = product.discountPrice ?? product.price;
  const extrasTotal = extras.reduce((sum, e) => sum + e.price, 0) + selectionTotal(choices);
  const lineTotal = (unitPrice + extrasTotal) * quantity;

  const suggestions = useMemo(
    () => pickSuggestions(allProducts, { exclude: [product._id], covered: [product.categoryId] }),
    [allProducts, product]
  );

  const quickAdd = (suggested: Product) => {
    // Una sugerencia que exige elegir algo (la carne, el tamaño) no se
    // puede meter a ciegas: el servidor la rechazaría en el checkout. Se
    // abre su hoja en lugar de esta.
    if (needsChoices(suggested)) {
      tap('light');
      onOpenProduct(suggested);
      return;
    }
    tap('success');
    addItem(businessId, businessName, {
      productId: suggested._id,
      productName: suggested.name,
      quantity: 1,
      unitPrice: suggested.discountPrice ?? suggested.price,
      originalUnitPrice: suggested.discountPrice != null ? suggested.price : undefined,
      image: productImageUri(suggested, 'thumb') ?? undefined,
      selectedExtras: [],
      notes: '',
    }, businessLogo);
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
    // Nunca se deshabilita el botón: si falta un grupo, se lleva la vista
    // hasta él y se resalta. Un botón gris no dice qué hay que hacer.
    const unmet = firstUnmetGroup(groups, choices);
    if (unmet) {
      tap('warning');
      setAttention(unmet._id);
      const y = groupOffsets.current[unmet._id];
      if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - Spacing.lg), animated: true });
      return;
    }
    addItem(businessId, businessName, {
      productId: product._id,
      productName: product.name,
      quantity,
      unitPrice,
      originalUnitPrice: product.discountPrice != null ? product.price : undefined,
      image: productImageUri(product, 'thumb') ?? undefined,
      selectedExtras: [
        ...choices.map((ch) => ({
          name: ch.name, price: ch.price, quantity: 1,
          groupId: ch.groupId, groupName: ch.groupName, optionId: ch.optionId,
        })),
        ...extras.map((e) => ({ name: e.name, price: e.price, quantity: 1 })),
      ],
      notes: notes.trim(),
    }, businessLogo);
    onClose();
  };

  const pickOption = (group: ModifierGroup, option: ModifierGroup['options'][number]) => {
    if (option.isAvailable === false) return;
    tap('select');
    setChoices((current) => toggleChoice(current, group, option));
    if (attention === group._id) setAttention(null);
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      title={product.name}
      height={0.86}
      scrollRef={scrollRef}
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
          /*
            La foto se puede abrir. Una imagen de 300 pt dentro de una hoja
            no permite decidir si la hamburguesa trae el pan que uno espera,
            y ese es justo el momento en que se abandona el pedido.
          */
          <Pressable
            onPress={() => { tap('light'); setViewerOpen(true); }}
            style={StyleSheet.absoluteFill}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Ver fotos de ${product.name}`}
          >
            <Image
              source={{ uri: productImageUri(product, 'detail')! }}
              // La de catálogo que acaba de verse en la fila, no la borrosa.
              placeholder={productImageStepDown(product, 'detail')}
              placeholderContentFit="cover"
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={200}
              accessible={false}
            />
            {gallery.length > 1 ? (
              <View style={styles.galleryHint}>
                <Icon name="foto" size="sm" color="#FFFFFF" />
                <Text v="caption" style={styles.galleryHintText}>{gallery.length}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : (
          <Illustration size={64} />
        )}
      </Animated.View>

      <Lightbox
        images={gallery}
        visible={viewerOpen}
        onClose={() => setViewerOpen(false)}
      />

      <View style={styles.sheetHead}>
        <View style={styles.sheetHeadRow}>
          <Text v="dataL" tone="primaryText">{money(unitPrice)}</Text>
          <IconButton
            icon="favorito"
            label={productFavorite ? 'Quitar este plato de favoritos' : 'Guardar este plato en favoritos'}
            tone={productFavorite ? 'danger' : 'neutral'}
            filled={productFavorite}
            onPress={() => {
              tap(productFavorite ? 'light' : 'success');
              toggleProductFavorite(product._id, 'product');
            }}
          />
        </View>
        <View style={styles.likeRow}>
          <Icon name="minutos" size={12} color={c.textMuted} />
          <Text v="caption" tone="textMuted">Tarda ~{product.prepTimeMinutes ?? fallbackPrepMinutes} min en cocina</Text>
        </View>
        {product.description ? (
          <Text v="bodyM" tone="textSecondary">{product.description}</Text>
        ) : null}
      </View>

      {hasModifierUI(product) ? groups.map((group) => {
        const chosen = countIn(choices, group._id);
        const single = isSingle(group);
        const full = !single && chosen >= group.maxSelect;
        const flagged = attention === group._id;
        return (
          <View
            key={group._id}
            style={styles.sheetSection}
            onLayout={(e) => { groupOffsets.current[group._id] = e.nativeEvent.layout.y; }}
          >
            <View style={styles.groupHead}>
              <Text v="label" tone={flagged ? 'errorText' : 'textMuted'}>{group.name}</Text>
              <View style={styles.groupMeta}>
                {isRequired(group) ? (
                  <Badge label="Obligatorio" tone={flagged ? 'error' : 'neutral'} />
                ) : null}
                <Text v="dataXS" tone={flagged ? 'errorText' : 'textMuted'}>
                  {single ? groupHint(group) : `${groupHint(group)} · ${chosen}/${group.maxSelect}`}
                </Text>
              </View>
            </View>
            <View style={[styles.extras, { borderColor: flagged ? c.error : c.border }]}>
              {group.options.map((option, i) => {
                const checked = choices.some((ch) => ch.optionId === option._id);
                const soldOut = option.isAvailable === false;
                const blocked = !checked && !soldOut && full;
                return (
                  <Pressable
                    key={option._id}
                    onPress={() => pickOption(group, option)}
                    disabled={soldOut}
                    accessibilityRole={single ? 'radio' : 'checkbox'}
                    accessibilityState={{ checked, disabled: soldOut }}
                    accessibilityLabel={
                      soldOut
                        ? `${option.name}, agotado`
                        : `${option.name}${option.price > 0 ? `, ${money(option.price)} adicional` : ''}`
                    }
                    style={[
                      styles.extra,
                      i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                      (soldOut || blocked) && styles.optionOff,
                    ]}
                  >
                    <View
                      style={[
                        single ? styles.radio : styles.checkbox,
                        {
                          backgroundColor: checked ? c.primary : 'transparent',
                          borderColor: checked ? c.primary : c.borderStrong,
                        },
                      ]}
                    >
                      {checked ? (
                        single
                          ? <View style={[styles.radioDot, { backgroundColor: c.textOnPrimary }]} />
                          : <Icon name="check" size={14} color={c.textOnPrimary} strong />
                      ) : null}
                    </View>
                    <Text v="bodyM" style={styles.flex}>{option.name}</Text>
                    {soldOut ? (
                      <Text v="dataS" tone="textMuted">Agotado</Text>
                    ) : option.price > 0 ? (
                      <Text v="dataS" tone="textMuted">+{money(option.price)}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      }) : null}

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

      <SuggestionRow
        products={suggestions}
        accent={accent}
        category={category}
        justAddedId={justAdded}
        onAdd={quickAdd}
      />

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
  topBlock: { gap: Spacing.sm, marginBottom: Spacing.lg },
  likeRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  topTitle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

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

  info: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md, paddingBottom: Spacing.xl, gap: Spacing.md },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },

  tabs: { borderBottomWidth: StyleSheet.hairlineWidth },
  menuSearch: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.md },
  tabsRow: { paddingHorizontal: Spacing.xl, gap: Spacing.xl },
  tab: { alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.md },
  tabMark: { height: 3, width: 22, borderRadius: 2 },

  products: { padding: Spacing.xl, gap: Spacing.md },
  productSkeletons: { gap: Spacing.md },
  productSkeleton: { flexDirection: 'row', gap: Spacing.md },

  product: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  productOff: { opacity: 0.55 },
  productImage: {
    width: 136, height: 136, borderRadius: BorderRadius.lg,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  discountRibbon: { position: 'absolute', top: 4, left: 4 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  soldOut: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,11,20,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  productBody: { flex: 1, gap: 4 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: 3 },
  strike: { textDecorationLine: 'line-through' },
  addBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    ...Shadow.sm,
  },

  galleryHint: {
    position: 'absolute',
    right: Spacing.md,
    bottom: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  galleryHintText: { color: '#FFFFFF' },
  sheetHero: {
    height: 168,
    borderRadius: BorderRadius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sheetHead: { gap: Spacing.sm },
  sheetHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  radio: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  optionOff: { opacity: 0.45 },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  groupMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  notesLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  notes: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    padding: Spacing.md,
    minHeight: 92,
    textAlignVertical: 'top',
  },
  sheetFooter: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },

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
