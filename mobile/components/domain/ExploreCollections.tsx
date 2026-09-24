import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { ProductCollectionRow } from './ProductCollectionRow';
import { PromoCarousel } from './PromoCarousel';
import { ExploreSections } from './explore/ExploreSections';
import { useExplore } from '../../hooks/useApi';
import { useProgressiveLimit } from '../../hooks/useProgressiveLimit';
import { alternateWeights } from '../../lib/exploreWeights';
import { exploreContent } from '../../lib/exploreSections';

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
 * Dos caminos: las secciones del constructor del panel (`ExploreSections`),
 * o —si el servidor todavía no lo conoce— la forma de siempre, que se sigue
 * pintando aquí abajo igual que antes.
 *
 * Devuelve `null` mientras no haya nada: un hueco vacío encima de la
 * tarjeta de mandados se ve como un error de maquetación.
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
  const content = useMemo(() => exploreContent(feed), [feed]);

  // Camino de siempre. El servidor ordena por franja, rotación y
  // presupuesto de exposición —no por peso visual de tarjeta—, así que
  // `alternateWeights` hace cumplir la regla dura de docs/EXPLORAR.md §5:
  // nunca dos carruseles del mismo peso ("protagonista" / "secundario") seguidos.
  const entries = useMemo(
    () => (content.mode === 'entries' ? alternateWeights(content.entries) : []),
    [content]
  );

  if (content.mode === 'sections') return <ExploreSections sections={content.sections} />;
  if (entries.length === 0) return null;

  return (
    <View style={styles.root}>
      {entries.slice(0, sectionLimit).map((entry, index) =>
        entry.kind === 'promo' ? (
          <PromoCarousel key={`promo-${entry.order}`} banners={entry.banners} />
        ) : (
          // Cuadrícula en vez del carrusel de Inicio: aquí se viene a
          // comparar, no a pasear, y con las mismas tarjetas horizontales el
          // feed era indistinguible del de Inicio. `displayVariant` se
          // fuerza solo en esta copia — no toca lo que decide el servidor.
          //
          // Una sola cuadrícula fija veinte veces seguidas es tan monótono
          // como el carrusel que reemplazó: una de cada tres secciones es la
          // pared completa (4 filas, sin scroll propio); el resto son dos
          // filas que se desplazan hacia el lado, el mismo gesto que un
          // carrusel de Inicio pero en parejas.
          <ProductCollectionRow
            key={entry.key}
            section={{ ...entry, displayVariant: 'grid' }}
            allowGrid
            gridRows={index % 3 === 2 ? 4 : 2}
          />
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
