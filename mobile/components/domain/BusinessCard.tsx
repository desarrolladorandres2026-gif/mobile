import { memo, useMemo } from 'react';
import { View, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../ui/Text';
import { IconButton } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Card } from '../ui/Surface';
import { Badge, CatalogBadge, MetaRow } from '../ui/Badge';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { useBusinessProducts } from '../../hooks/useApi';
import { businessAccent, openState } from '../../lib/business';
import { minutes, money } from '../../lib/format';
import { tap } from '../../lib/haptics';
import { discountPercent } from '../../lib/catalog';
import {
  productImageUri, productImagePlaceholder, hasProductImage, type WithProductImage,
} from '../../lib/productImage';

/** Lo mínimo que necesita la tira de productos de la tarjeta de negocio. */
interface PreviewProduct extends WithProductImage {
  _id: string;
  name: string;
  price: number;
  discountPrice?: number;
  isAvailable?: boolean;
}

/** Cuántos platos como máximo entran en la tira, bajo la tarjeta. */
const MAX_MENU_PREVIEW = 10;

export interface Business {
  _id: string;
  name: string;
  category: string;
  rating: number;
  totalReviews?: number;
  deliveryTime: number;
  description?: string;
  logo?: string | null;
  coverImage?: string | null;
  minOrder?: number;
  isFeatured?: boolean;
  schedule?: Record<string, { open?: string; close?: string; isOpen?: boolean }>;
  /**
   * Distancia en línea recta hasta el cliente, en metros.
   *
   * Solo llega cuando la consulta se hizo con coordenadas. Se muestra
   * porque entre dos sitios parecidos la distancia es lo que decide, y
   * hasta ahora la lista enseñaba minutos estimados sin decir de dónde
   * salían.
   */
  distanceMeters?: number;
  /** Ya viaja en cualquier listado de negocios, lo pida o no `/offers`. */
  freeDeliveryThreshold?: number;
  /**
   * Por qué este negocio está en oferta.
   *
   * Solo la rellena `/offers`: el motivo se decide en el servidor y no en
   * cada pantalla, para que "envío gratis" signifique lo mismo aquí que en
   * la ficha del negocio.
   */
  offer?: { kind: 'discount' | 'free_delivery'; label: string };
}

/** La distancia como la diría una persona, no como la calcula un mapa. */
export function formatDistance(meters: number | undefined): string | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return null;

  // Por debajo de un kilómetro, los metros son más útiles y más honestos:
  // "0,4 km" se lee peor que "400 m" y aparenta una precisión que el GPS
  // de un teléfono no tiene.
  if (meters < 1000) return `${Math.round(meters / 50) * 50} m`;

  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/**
 * Distintivo del negocio.
 *
 * Si hay logo cargado, se muestra. Si no, un cuadro del color propio del
 * negocio con el icono de su categoría, que es mucho mejor que un recuadro
 * gris vacío y hace la lista reconocible de un vistazo.
 */
export const BusinessTile = memo(function BusinessTile({
  business, size = 60, radius = BorderRadius.md,
}: { business: Business; size?: number; radius?: number }) {
  const { c } = useTheme();

  if (business.logo) {
    return (
      <Image
        source={{ uri: business.logo }}
        style={{ width: size, height: size, borderRadius: radius }}
        contentFit="cover"
        transition={200}
        accessible={false}
        /**
         * `memory-disk` y no el disco a secas.
         *
         * Sin caché en memoria, expo-image vuelve a **decodificar** el logo
         * cada vez que la fila entra en pantalla. En un listado de sesenta
         * negocios eso es decodificar sesenta imágenes en cada pasada de
         * scroll, y es el coste que más se nota en Android de gama baja.
         */
        cachePolicy="memory-disk"
        /**
         * Sin esto, al reciclar una celda de `FlatList` la imagen **anterior**
         * se queda visible mientras carga la nueva: el usuario ve el logo de
         * otro negocio sobre el nombre correcto durante un instante.
         */
        recyclingKey={business._id}
      />
    );
  }

  const Illustration = categoryIllustration(business.category);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: c.surfaceLight,
        borderWidth: 1,
        borderColor: c.border,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Illustration size={size * 0.62} />
    </View>
  );
});

/**
 * El motivo de oferta de un negocio, solo cuando el servidor ya lo resolvió
 * (viene de la pestaña de Descuentos, vía `/offers`).
 *
 * Antes se derivaba también de `freeDeliveryThreshold` para que el listado
 * normal de Inicio o Explorar mostrara el mismo cintillo sin depender de
 * `/offers`. Se quitó: el envío gratis es información del pedido —cuánto
 * falta para alcanzarlo— y ahora vive en la tarjeta de cada producto
 * (`ProductRow`, en la ficha del negocio), no en la tarjeta del negocio.
 */
function rowOffer(business: Business): Business['offer'] {
  return business.offer;
}

// ──────────────────────────────────────────────────────────────
// Fila de lista
// ──────────────────────────────────────────────────────────────

/**
 * `onPress` recibe el id en vez de ser una función ya cerrada sobre él.
 *
 * Parece un detalle y era lo que anulaba el `memo` de este componente: las
 * pantallas escribían `onPress={() => goToBusiness(b._id)}`, que crea una
 * función nueva en cada render del padre, así que la prop siempre cambiaba y
 * las 60 filas se volvían a renderizar aunque los datos fueran idénticos.
 *
 * Con el id como argumento, el padre puede pasar un `useCallback` estable y
 * el `memo` empieza a servir para algo.
 */
export const BusinessRow = memo(function BusinessRow({
  business, onPress, showStatus = true, favorite, onToggleFavorite, menuPreview, onPressProduct,
}: {
  business: Business;
  onPress: (id: string) => void;
  showStatus?: boolean;
  /**
   * Si se pasa, se dibuja el corazón de favorito sobre la foto.
   *
   * Sin `onToggleFavorite` la fila no lleva corazón: en Inicio o Buscar no
   * hay nada que decidir aquí todavía, y meterlo solo para que quede bonito
   * sería el mismo distintivo decorativo que se sacó de admin/business.
   */
  favorite?: boolean;
  onToggleFavorite?: (id: string) => void;
  /**
   * Solo Inicio la pide. Pedir el catálogo de cada negocio de Buscar o
   * Favoritos —listas que pueden traer decenas— multiplicaría las
   * peticiones por nada: ahí la fila ya dice bastante sin la tira.
   */
  menuPreview?: boolean;
  /** A dónde llevar un toque sobre un plato concreto de la tira. */
  onPressProduct?: (businessId: string, productId: string) => void;
}) {
  const { c } = useTheme();
  const accent = businessAccent(business._id);
  const status = openState(business.schedule);
  const closed = showStatus && !status.open;
  const offer = rowOffer(business);
  const Illustration = categoryIllustration(business.category);

  // El hook se pide siempre —las reglas de los hooks no dejan pedirlo solo
  // cuando `menuPreview` es cierto— pero `enabled` frena la petición real
  // en las pantallas que no la necesitan.
  const { data: catalog = [] } = useBusinessProducts(business._id, undefined, !!menuPreview) as {
    data: PreviewProduct[];
  };
  const previewProducts = useMemo(
    () => catalog.filter((p) => p.isAvailable !== false).slice(0, MAX_MENU_PREVIEW),
    [catalog]
  );

  return (
    <Card
      onPress={() => onPress(business._id)}
      padded={false}
      accessibilityLabel={`${business.name}. Calificación ${business.rating.toFixed(1)}. ${minutes(business.deliveryTime)}.${offer ? ` ${offer.label}.` : ''}${closed ? ` ${status.label}.` : ''}`}
      accessibilityHint="Abre el menú del negocio"
    >
      {/* ── Foto de portada: lo primero que se ve, como en la tarjeta destacada ── */}
      <View style={[styles.rowCover, { backgroundColor: accent }]}>
        {business.coverImage ? (
          <Image
            source={{ uri: business.coverImage }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            accessible={false}
            cachePolicy="memory-disk"
            recyclingKey={business._id}
          />
        ) : (
          <View style={styles.coverBadgeCircle}>
            <Illustration size={40} />
          </View>
        )}

        {/* Un negocio cerrado no está tomando pedidos con descuento ahora
            mismo: el cintillo se calla y deja hablar solo al velo. */}
        {offer && !closed ? (
          <View style={styles.rowRibbon}>
            <Badge label={offer.label} tone="lime" icon="descuento" style={{ backgroundColor: c.surface }} />
          </View>
        ) : null}

        {onToggleFavorite ? (
          <View style={styles.rowHeart}>
            <IconButton
              icon="favorito"
              label={favorite ? `Quitar ${business.name} de favoritos` : `Guardar ${business.name} en favoritos`}
              tone={favorite ? 'danger' : 'neutral'}
              filled={favorite}
              size={34}
              onPress={() => onToggleFavorite(business._id)}
            />
          </View>
        ) : null}

        {closed ? (
          <View style={styles.closedVeil}>
            <Text v="captionStrong" color="#FFFFFF">{status.label.toUpperCase()}</Text>
          </View>
        ) : null}
      </View>

      {/*
        La insignia del logo, a medio camino entre la foto y el cuerpo.
        El margen negativo la sube sobre el borde de la portada; lo que
        "roba" de alto se lo devuelve solo al cuerpo, sin necesidad de un
        padding extra calculado a mano.
      */}
      <View style={[styles.rowLogoRing, { backgroundColor: c.surface }]}>
        <BusinessTile business={business} size={44} radius={22} />
      </View>

      <View style={styles.rowBody}>
        <Text v="titleM" numberOfLines={1}>{business.name}</Text>

        <MetaRow
          items={[
            {
              icon: 'calificacion',
              text: business.rating.toFixed(1),
              strong: true,
              tone: 'text',
            },
            { icon: 'minutos', text: minutes(business.deliveryTime) },
            ...(formatDistance(business.distanceMeters)
              ? [{ icon: 'navegar' as const, text: formatDistance(business.distanceMeters)! }]
              : []),
            ...(business.minOrder
              ? [{ text: `Mín. $${business.minOrder / 1000}k` }]
              : []),
          ]}
        />

        {/* El cierre ya lo dijo el velo de la foto; aquí solo queda el
            aviso de que está por cerrar, que es información nueva. */}
        {!closed && status.label.startsWith('Cierra') ? (
          <View style={styles.badges}>
            <Badge label={status.label} tone="warning" icon="reloj" />
          </View>
        ) : null}
      </View>

      {/*
        La tira de platos, al pie de la tarjeta.
        Nada que enseñar —catálogo vacío, todavía sin cargar— y no se
        reserva ni un pixel: la tarjeta se queda con su alto normal en vez
        de dejar un hueco a la espera de algo que puede no llegar.
      */}
      {menuPreview && previewProducts.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.menuStrip, { borderTopColor: c.border }]}
          contentContainerStyle={styles.menuStripRow}
        >
          {previewProducts.map((product) => (
            <MenuPreviewItem
              key={product._id}
              product={product}
              accent={accent}
              onPress={() => {
                tap('light');
                if (onPressProduct) onPressProduct(business._id, product._id);
                else onPress(business._id);
              }}
            />
          ))}
        </ScrollView>
      ) : null}
    </Card>
  );
});

/**
 * Un plato dentro de la tira.
 *
 * Antes era un sello de 68 px con el nombre en `caption`: a ese tamaño solo
 * el precio se leía sin entrecerrar los ojos. Ciento diez px de foto y el
 * mismo tratamiento que la carta completa —cintillo de descuento, precio
 * tachado, botón de agregar flotando sobre la imagen— es lo que hace que
 * esta tira se sienta como un anticipo real de la carta y no como una lista
 * de miniaturas sueltas.
 */
const MenuPreviewItem = memo(function MenuPreviewItem({
  product, accent, onPress,
}: { product: PreviewProduct; accent: string; onPress: () => void }) {
  const { c } = useTheme();
  const pct = discountPercent(product);
  const hasDiscount = product.discountPrice != null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${money(product.discountPrice ?? product.price)}`}
      accessibilityHint="Abre este plato en el negocio"
      style={styles.menuItem}
    >
      <View style={[styles.menuItemImage, { backgroundColor: c.surfaceLight }]}>
        {hasProductImage(product) ? (
          <Image
            source={{ uri: productImageUri(product, 'thumb')! }}
            placeholder={productImagePlaceholder(product)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            recyclingKey={product._id}
            accessible={false}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: accent }]} />
        )}

        {pct ? (
          <View style={styles.menuItemRibbon}>
            <CatalogBadge kind="descuento" label={`-${pct}%`} />
          </View>
        ) : null}

        <View style={[styles.menuItemAdd, { backgroundColor: c.primary }]}>
          <Icon name="mas" size="sm" color={c.textOnPrimary} />
        </View>
      </View>

      <Text v="bodyS" numberOfLines={2} style={styles.menuItemName}>{product.name}</Text>

      <View style={styles.menuItemPriceRow}>
        <Text v="dataS" tone="primaryText" style={{ fontWeight: '700' }}>
          {money(product.discountPrice ?? product.price)}
        </Text>
        {hasDiscount ? (
          <Text v="caption" tone="textMuted" style={styles.menuItemStrike}>
            {money(product.price)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

// ──────────────────────────────────────────────────────────────
// Tarjeta destacada
// ──────────────────────────────────────────────────────────────

/** Tarjeta ancha para los carruseles. El color del negocio ocupa la portada. */
export const BusinessFeatured = memo(function BusinessFeatured({
  business, onPress, width = 220,
}: { business: Business; onPress: (id: string) => void; width?: number }) {
  const { c } = useTheme();
  const accent = businessAccent(business._id);
  const status = openState(business.schedule);
  const Illustration = categoryIllustration(business.category);

  return (
    <Card
      onPress={() => onPress(business._id)}
      padded={false}
      tone="flat"
      style={{ width }}
      accessibilityLabel={`${business.name}. ${minutes(business.deliveryTime)}. Calificación ${business.rating.toFixed(1)}`}
      accessibilityHint="Abre el menú del negocio"
    >
      <View style={[styles.cover, { backgroundColor: accent }]}>
        {business.coverImage ? (
          <Image
            source={{ uri: business.coverImage }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            accessible={false}
            cachePolicy="memory-disk"
            recyclingKey={business._id}
          />
        ) : (
          <View style={styles.coverBadgeCircle}>
            <Illustration size={40} />
          </View>
        )}

        <View style={styles.coverBadge}>
          <Badge
            label={minutes(business.deliveryTime)}
            tone="neutral"
            icon="minutos"
            style={{ backgroundColor: c.surface }}
          />
        </View>

        {!status.open ? (
          <View style={styles.closedVeil}>
            <Text v="captionStrong" color="#FFFFFF">{status.label.toUpperCase()}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.featuredBody}>
        <Text v="titleM" numberOfLines={1}>{business.name}</Text>
        <MetaRow
          items={[
            { icon: 'calificacion', text: business.rating.toFixed(1), strong: true, tone: 'text' },
            { text: `${business.totalReviews ?? 0} reseñas` },
          ]}
        />
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  rowCover: {
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  rowRibbon: { position: 'absolute', top: Spacing.sm, left: Spacing.sm, ...Shadow.sm },
  rowHeart: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, ...Shadow.sm },
  /**
   * El anillo del logo, a caballo entre la foto y el cuerpo.
   *
   * `marginTop` negativo igual a la mitad de su propio alto: sube el
   * círculo justo hasta quedar centrado sobre el borde inferior de la
   * portada, y la otra mitad que "sobra" abajo se convierte sola en el
   * espacio de aire que necesita el nombre del negocio.
   */
  rowLogoRing: {
    width: 50, height: 50, borderRadius: 25,
    marginTop: -25,
    marginLeft: Spacing.md,
    padding: 3,
    alignItems: 'center', justifyContent: 'center',
    ...Shadow.sm,
  },
  rowBody: { padding: Spacing.md, paddingTop: Spacing.sm, gap: Spacing.xs + 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },

  menuStrip: { borderTopWidth: StyleSheet.hairlineWidth },
  menuStripRow: { gap: Spacing.md, padding: Spacing.md },
  menuItem: { width: 110, gap: 4 },
  menuItemImage: {
    width: 110, height: 110, borderRadius: BorderRadius.lg, overflow: 'hidden',
  },
  menuItemRibbon: { position: 'absolute', top: 6, left: 6 },
  /**
   * El botón de agregar flota sobre la esquina de la foto, como en Rappi:
   * invita a sumar el plato sin obligar a abrir la ficha completa primero.
   * Aquí solo lleva al detalle igual que el resto de la tarjeta —el carrito
   * de un plato con modificadores no se resuelve con un toque— pero la
   * promesa visual de "un toque y ya" es la que hace que la tira invite.
   */
  menuItemAdd: {
    position: 'absolute', bottom: 6, right: 6,
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    ...Shadow.sm,
  },
  menuItemName: { marginTop: 2, minHeight: 34 },
  menuItemPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  menuItemStrike: { textDecorationLine: 'line-through' },

  cover: {
    height: 116,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  coverBadge: { position: 'absolute', bottom: Spacing.sm, left: Spacing.sm, ...Shadow.sm },
  coverBadgeCircle: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    ...Shadow.sm,
  },
  closedVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8, 11, 20, 0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featuredBody: { padding: Spacing.md, gap: Spacing.xs },
});
