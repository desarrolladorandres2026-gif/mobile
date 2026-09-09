import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { Card } from '../ui/Surface';
import { Badge, MetaRow } from '../ui/Badge';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Shadow, Spacing } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { businessAccent, openState } from '../../lib/business';
import { minutes } from '../../lib/format';

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
 * El motivo de oferta de un negocio, con o sin `/offers`.
 *
 * Si el servidor ya lo resolvió (viene de la pestaña de Descuentos), se usa
 * ese. Si no —el listado normal de Inicio o Explorar— se deriva de
 * `freeDeliveryThreshold`, que viaja en cualquier negocio: así el badge
 * aparece en toda la app sin depender de qué pantalla lo pidió.
 */
function rowOffer(business: Business): Business['offer'] {
  if (business.offer) return business.offer;
  if (business.freeDeliveryThreshold && business.freeDeliveryThreshold > 0) {
    return { kind: 'free_delivery', label: 'Envío gratis' };
  }
  return undefined;
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
  business, onPress, showStatus = true,
}: { business: Business; onPress: (id: string) => void; showStatus?: boolean }) {
  const { c } = useTheme();
  const status = openState(business.schedule);
  const closed = showStatus && !status.open;
  const offer = rowOffer(business);

  return (
    <Card
      onPress={() => onPress(business._id)}
      padded={false}
      accessibilityLabel={`${business.name}. Calificación ${business.rating.toFixed(1)}. ${minutes(business.deliveryTime)}.${offer ? ` ${offer.label}.` : ''}${closed ? ` ${status.label}.` : ''}`}
      accessibilityHint="Abre el menú del negocio"
      style={styles.row}
    >
      <View style={closed ? styles.dimmed : undefined}>
        <BusinessTile business={business} size={62} />
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

        <View style={styles.badges}>
          {offer ? (
            <Badge label={offer.label} tone="lime" icon="descuento" />
          ) : null}
          {closed ? (
            <Badge label={status.label} tone="neutral" icon="reloj" />
          ) : status.label.startsWith('Cierra') ? (
            <Badge label={status.label} tone="warning" icon="reloj" />
          ) : null}
        </View>
      </View>

      <View style={[styles.chevron, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
        <Icon name="siguiente" size="sm" color={c.textMuted} />
      </View>
    </Card>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
  },
  rowBody: { flex: 1, gap: Spacing.xs + 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  dimmed: { opacity: 0.45 },
  chevron: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },

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
