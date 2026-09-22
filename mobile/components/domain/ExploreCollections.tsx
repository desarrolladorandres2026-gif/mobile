import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { ProductCollectionRow } from './ProductCollectionRow';
import { PromoCarousel } from './PromoCarousel';
import { useExplore } from '../../hooks/useApi';
import { useProgressiveLimit } from '../../hooks/useProgressiveLimit';
import { alternateWeights } from '../../lib/exploreWeights';

/**
 * Las colecciones de descubrimiento de Explorar.
 *
 * Es lo que convierte esta pantalla de un índice en un feed. Antes, sin
 * búsqueda escrita, Explorar enseñaba atajos y categorías: útil para quien
 * ya sabe qué quiere, inútil para quien entró sin saberlo. Esto es lo que
 * responde a ese segundo caso — colecciones que el servidor arma solo, rotan
 * por día y por franja horaria, y cambian de una visita a la siguiente.
 *
 * Todo llega en **una sola petición**. Una consulta por sección sería la
 * forma más rápida de que el limitador devuelva un 429, y desde el teléfono
 * un 429 se lee exactamente igual que "no hay nada que mostrar".
 *
 * Devuelve `null` mientras no haya nada: el esqueleto de la pantalla ya lo
 * pinta quien la monta, y un hueco vacío entre las categorías y la tarjeta
 * de mandados se ve como un error de maquetación.
 */

/** Cuántas colecciones se montan antes de ceder el hilo a la animación de entrada. */
const INITIAL_SECTIONS = 3;

export const ExploreCollections = memo(function ExploreCollections({
  coords,
  ready = true,
}: {
  coords?: { lat: number; lng: number } | null;
  ready?: boolean;
}) {
  const { data: feed } = useExplore(coords, ready);
  const sectionLimit = useProgressiveLimit(INITIAL_SECTIONS);

  // El servidor ordena por franja, rotación y presupuesto de exposición —
  // no por peso visual de tarjeta. `alternateWeights` es lo que hace
  // cumplir la regla dura de docs/EXPLORAR.md §5: nunca dos carruseles del
  // mismo peso ("protagonista" / "secundario") seguidos.
  const rawEntries = feed?.entries ?? [];
  const entries = useMemo(() => alternateWeights(rawEntries), [rawEntries]);
  if (entries.length === 0) return null;

  return (
    <View style={styles.root}>
      {entries.slice(0, sectionLimit).map((entry) =>
        entry.kind === 'promo' ? (
          <PromoCarousel key={`promo-${entry.order}`} banners={entry.banners} />
        ) : (
          <ProductCollectionRow key={entry.key} section={entry} allowGrid />
        )
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  // Los carruseles traen su propio margen superior (`ProductCollectionRow`
  // usa `Spacing.xxxl`), así que aquí solo hace falta cerrar por abajo para
  // que la tarjeta de mandados no quede pegada al último.
  root: { marginBottom: 8 },
});
