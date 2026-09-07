import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Size, Spacing } from '../theme/tokens';
import { useDockHeight } from './useDockHeight';

/**
 * Relleno inferior para un scroll que vive bajo la barra de pestañas.
 *
 * La barra mide `Size.tabBar + insets.bottom` (ver `components/nav/TabBar`),
 * así que el contenido tiene que dejar libre esa altura más un respiro. En vez
 * de un número fijo —que acierta en un teléfono y tapa la última fila en otro—
 * se calcula con el inset real del dispositivo.
 *
 * Si hay un dock flotante (pestañas del cliente), su altura real —publicada por
 * contexto— se toma en cuenta; `extra` actúa como mínimo mientras el dock aún
 * no se ha medido.
 *
 * @param extra Reserva mínima adicional por encima de la barra de pestañas.
 */
export function useTabContentPadding(extra = 0) {
  const { bottom } = useSafeAreaInsets();
  const dock = useDockHeight();
  return Size.tabBar + bottom + Spacing.xl + Math.max(extra, dock);
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
