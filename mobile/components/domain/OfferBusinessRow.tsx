import { memo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Text, Icon } from '../ui';
import { categoryIllustration } from '../illustrations';
import { BorderRadius, Spacing, palette } from '../../theme/tokens';
import { useTheme } from '../../hooks/useTheme';
import { tap } from '../../lib/haptics';
import { businessAccent, openState } from '../../lib/business';
import { sizedImageUri } from '../../lib/cloudinaryImage';
import { minutes } from '../../lib/format';
import type { OfferBusiness } from '../../services/endpoints';

/**
 * Un negocio en oferta, sin tarjeta.
 *
 * `BusinessRow` —la de Inicio y Explorar— es una tarjeta con portada ancha,
 * anillo de logo y cintillo. Aquí abajo, después de dos rieles de tiquetes
 * y baldosas, repetir esa caja convertía la pantalla en seis versiones del
 * mismo rectángulo. Quitarle el marco es lo que deja que el cupón y el
 * plato se lean como objetos y el negocio como una lista.
 *
 * No sustituye a `BusinessRow`: esta fila no tiene portada ni favoritos ni
 * tira de productos, y fuera de Descuentos diría de menos.
 */
export const OfferBusinessRow = memo(function OfferBusinessRow({
  business, onPress,
}: {
  business: OfferBusiness;
  onPress: (id: string) => void;
}) {
  const { c } = useTheme();
  const status = openState(business.schedule);
  const closed = !status.open;
  const Illustration = categoryIllustration(business.category);
  const accent = businessAccent(business._id, undefined);

  const freeDelivery = business.offer.kind === 'free_delivery';
  const percent = business.bestDiscountPercent ?? 0;

  return (
    <Pressable
      onPress={() => { tap('light'); onPress(business._id); }}
      accessibilityRole="button"
      accessibilityLabel={`${business.name}. ${business.offer.label}.${closed ? ` ${status.label}.` : ''}`}
      accessibilityHint="Abre el menú del negocio"
      style={[styles.row, closed && styles.closed]}
    >
      <View style={[styles.logo, { backgroundColor: accent }]}>
        {business.logo ? (
          <Image
            source={{ uri: sizedImageUri(business.logo, 120) }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            accessible={false}
            cachePolicy="memory-disk"
            recyclingKey={business._id}
          />
        ) : (
          <Illustration size={26} />
        )}
      </View>

      <View style={styles.flex}>
        <Text v="strongM" numberOfLines={1}>{business.name}</Text>

        {/* Sin puntos medios entre los datos: separan igual que el espacio
            y llenan la línea de tipografía que nadie lee. */}
        <View style={styles.meta}>
          <Icon name="calificacion" size={11} color={c.warning} />
          <Text v="caption" tone="textMuted">{(business.rating ?? 0).toFixed(1)}</Text>
          <Text v="caption" tone="textMuted" style={styles.gap}>
            {minutes(business.deliveryTime)}
          </Text>
          {typeof business.distanceMeters === 'number' ? (
            <Text v="caption" tone="textMuted" style={styles.gap}>
              {(business.distanceMeters / 1000).toFixed(1)} km
            </Text>
          ) : null}
          {closed ? (
            <Text v="caption" tone="errorText" style={styles.gap}>{status.label}</Text>
          ) : null}
        </View>
      </View>

      {/* La promesa, a la derecha y en grande cuando es un número. "Hasta
          -40%" cabía entero en una insignia, pero entonces el porcentaje
          pesaba lo mismo que la palabra "hasta". */}
      {freeDelivery ? (
        <View style={[styles.tag, { backgroundColor: c.surfaceLight }]}>
          <Text v="strongS" tone="text">Envío $0</Text>
        </View>
      ) : percent > 0 ? (
        <View style={styles.discount}>
          <Text v="caption" tone="textMuted">hasta</Text>
          <Text v="dataL" color={palette.gold600}>−{percent}%</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  closed: { opacity: 0.5 },

  logo: {
    width: 52,
    height: 52,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  meta: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  gap: { marginLeft: Spacing.sm },

  tag: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.full,
  },
  discount: { alignItems: 'flex-end' },
});
