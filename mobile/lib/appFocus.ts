import { AppState, Platform } from 'react-native';
import { focusManager } from '@tanstack/react-query';

/**
 * Le enseña a React Query cuándo la app está en primer plano.
 *
 * En la web lo sabe solo (eventos de visibilidad del navegador); en el
 * teléfono no. Sin esto, `refetchOnWindowFocus` nunca se disparaba al
 * volver a la app, y —peor— los `refetchInterval` de los pedidos seguían
 * sondeando con la app en segundo plano, gastando batería, datos y
 * peticiones del límite por usuario sin que nadie mirara la pantalla.
 *
 * Se instala una vez, fuera de React, igual que `installOnlineManager`.
 */
export function installAppFocusManager(): void {
  if (Platform.OS === 'web') return;
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (state) => {
      handleFocus(state === 'active');
    });
    return () => subscription.remove();
  });
}
