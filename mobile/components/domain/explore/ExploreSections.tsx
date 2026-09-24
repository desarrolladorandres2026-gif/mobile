import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { ProductCollectionRow } from '../ProductCollectionRow';
import { PromoCarousel } from '../PromoCarousel';
import { BusinessCollectionRow } from '../BusinessCollectionRow';
import { BusinessBannerBlock } from '../BusinessBannerBlock';
import { useProgressiveLimit } from '../../../hooks/useProgressiveLimit';
import {
  toBusinessBannerEntry, toBusinessRowEntry, toHomeSection,
} from '../../../lib/exploreSections';
import type { ExploreSection } from '../../../services/endpoints';

/**
 * Explorar tal como lo publicó el constructor del panel.
 *
 * No pide nada a la red y no decide nada: pinta, en orden, las secciones
 * que ya resolvió el servidor. Por eso sirve igual para la app y para la
 * vista previa del panel (que le pasa las secciones por `postMessage`).
 *
 * Las secciones llegan ya filtradas por `renderableSections`: un tipo o un
 * layout que esta versión no conoce no llega aquí. El `default: null` es la
 * segunda red por si alguien pasa secciones sin filtrar.
 *
 * El orden es el del admin: aquí **no** se aplica `alternateWeights`. El
 * panel avisa de dos secciones grandes seguidas antes de publicar.
 */

/** Cuántas secciones se montan antes de ceder el hilo a la animación de entrada. */
const INITIAL_SECTIONS = 3;

function renderSection(section: ExploreSection) {
  switch (section.type) {
    case 'products':
      return (
        <ProductCollectionRow
          key={section.id}
          section={toHomeSection(section)}
          layout={section.layout}
          headerVariant={section.headerVariant}
          showTitle={section.showTitle}
        />
      );
    case 'businesses':
      return section.layout.kind === 'spotlight'
        ? <BusinessBannerBlock key={section.id} entry={toBusinessBannerEntry(section)} />
        : <BusinessCollectionRow key={section.id} entry={toBusinessRowEntry(section)} />;
    case 'promo':
      return <PromoCarousel key={section.id} banners={section.banners} />;
    default:
      return null;
  }
}

export const ExploreSections = memo(function ExploreSections({ sections }: { sections: ExploreSection[] }) {
  const limit = useProgressiveLimit(INITIAL_SECTIONS);
  if (sections.length === 0) return null;

  return <View style={styles.root}>{sections.slice(0, limit).map(renderSection)}</View>;
});

const styles = StyleSheet.create({
  // Cada sección trae su propio margen superior; aquí solo se cierra por
  // abajo para que lo que venga después no quede pegado a la última.
  root: { marginBottom: 8 },
});
