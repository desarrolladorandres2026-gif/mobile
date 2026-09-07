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

// ──────────────────────────────────────────────────────────────
// Fila de lista
// ──────────────────────────────────────────────────────────────

export const BusinessRow = memo(function BusinessRow({
  business, onPress, showStatus = true,
}: { business: Business; onPress: () => void; showStatus?: boolean }) {
  const { c } = useTheme();
  const status = openState(business.schedule);
  const closed = showStatus && !status.open;

  return (
    <Card
      onPress={onPress}
      padded={false}
      accessibilityLabel={`${business.name}. Calificación ${business.rating.toFixed(1)}. ${minutes(business.deliveryTime)}.${closed ? ` ${status.label}.` : ''}`}
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
            ...(business.minOrder
              ? [{ text: `Mín. $${business.minOrder / 1000}k` }]
              : []),
          ]}
        />

        {closed ? (
          <Badge label={status.label} tone="neutral" icon="reloj" />
        ) : status.label.startsWith('Cierra') ? (
          <Badge label={status.label} tone="warning" icon="reloj" />
        ) : null}
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
}: { business: Business; onPress: () => void; width?: number }) {
  const { c } = useTheme();
  const accent = businessAccent(business._id);
  const status = openState(business.schedule);
  const Illustration = categoryIllustration(business.category);

  return (
    <Card
      onPress={onPress}
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
