import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';

/**
 * Cuántos elementos de una lista larga montar ahora.
 *
 * Arranca en `initial` y pasa a "todos" cuando terminan las interacciones
 * en curso (la animación de entrada de la pantalla). Montar veinte
 * carruseles o cuarenta filas con foto en el mismo instante en que la
 * pantalla se desliza es lo que la hacía llegar a tirones; así se pinta lo
 * visible primero y el resto un momento después, antes de que el dedo
 * alcance a bajar.
 */
export function useProgressiveLimit(initial: number): number {
  const [limit, setLimit] = useState(initial);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setLimit(Number.POSITIVE_INFINITY));
    return () => task.cancel();
  }, []);
  return limit;
}
