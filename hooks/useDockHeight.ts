import { createContext, useContext } from 'react';

/**
 * Altura real que ocupa el dock flotante del cliente (bolsa + pedido en curso)
 * por encima de la barra de pestañas.
 *
 * El dock aparece y desaparece —y crece de una a dos tiras— según el estado
 * del carrito y del pedido. En vez de que cada pantalla reserve un número fijo
 * "por si acaso" (que sobra cuando no hay dock y falta cuando hay dos tiras),
 * el layout de pestañas mide el dock y publica su altura aquí; los scrolls la
 * suman a su relleno inferior. Fuera del layout del cliente el valor es 0.
 */
export const DockHeightContext = createContext<number>(0);

export function useDockHeight(): number {
  return useContext(DockHeightContext);
}
