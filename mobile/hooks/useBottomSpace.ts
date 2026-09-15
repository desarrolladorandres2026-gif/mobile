import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spacing } from '../theme/tokens';
import { useDockHeight } from './useDockHeight';

/**
 * Relleno inferior para un scroll que vive bajo la barra de pestañas.
 *
 * `@react-navigation/bottom-tabs` ya reserva la barra como hermano flex
 * (`styles.screens = { flex: 1 }` en `BottomTabView`): el área de la pantalla
 * termina donde empieza la barra, no se le monta encima. El scroll solo
 * necesita un respiro visual, más el alto real del dock flotante —publicado
 * por contexto— cuando lo hay; `extra` es el mínimo mientras el dock aún no
 * se ha medido.
 *
 * @param extra Reserva mínima adicional mientras el dock no reporta su alto real.
 */
export function useTabContentPadding(extra = 0) {
  const dock = useDockHeight();
  return Spacing.xl + Math.max(extra, dock);
}

/**
 * Espacio que ocupa el dock flotante del cliente (bolsa + pedido en curso)
 * por encima de la barra de pestañas. Se suma al relleno de los scrolls de
 * las pestañas del cliente para que la última fila nunca quede debajo.
 */
export const CLIENT_DOCK_CLEARANCE = 88;

/**
 * Relleno inferior para pantallas sin barra de pestañas (pila): deja libre el
 * home indicator de iPhone o la barra de navegación de Android, con un mínimo
 * por si el dispositivo no reporta inset.
 */
export function useBottomInset(min = Spacing.md) {
  const { bottom } = useSafeAreaInsets();
  return Math.max(bottom, min);
}
