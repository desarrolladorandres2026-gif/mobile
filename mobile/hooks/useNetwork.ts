import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

/**
 * Estado real de la red.
 *
 * Hasta ahora la banda de "sin conexión" se alimentaba de `!connected` del
 * **socket**, que es otra cosa. Mentía en los dos sentidos: decía "sin
 * conexión" mientras el socket negociaba con wifi perfecto, y se callaba
 * cuando de verdad no había red pero el socket todavía no se había enterado.
 *
 * `isInternetReachable` importa más que `isConnected`: estar enganchado al
 * wifi de un centro comercial que exige aceptar un portal cautivo es
 * exactamente el caso en que la app parece rota sin motivo. Puede llegar
 * `null` mientras se comprueba, y eso **no** es estar sin red — tratarlo
 * como caída haría parpadear el aviso en cada cambio de antena.
 */
export function useNetworkStatus(): { online: boolean } {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    return NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    });
  }, []);

  return { online };
}

/**
 * Le enseña a React Query cuándo hay red.
 *
 * Sin esto, React Query asume que siempre la hay: reintenta contra un
 * teléfono en modo avión, gasta los tres intentos de 15 segundos y tarda
 * 45 s en decir que algo falló. Con el `onlineManager` enterado, las
 * consultas se pausan al perder la red y **se reanudan solas** al volver,
 * que es justo lo que el usuario espera al salir del ascensor.
 *
 * Se instala una sola vez, fuera de React, porque es estado global del
 * cliente de consultas y no de ningún componente.
 */
export function installOnlineManager(): void {
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    })
  );
}
