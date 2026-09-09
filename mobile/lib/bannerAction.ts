import { Linking } from 'react-native';
import type { Router } from 'expo-router';
import type { PromoBanner, BannerActionType } from '../services/endpoints';

/**
 * Qué hace un banner promocional al tocarlo.
 *
 * El backend guarda la *intención* (`actionType` + `actionValue`); aquí se
 * traduce a la navegación real de la app. La traducción vive del lado del
 * cliente a propósito: las rutas de Expo Router son estructura de esta app,
 * no contenido editable, y meterlas en la base de datos significaría que un
 * cambio de ruta rompe banners ya publicados.
 *
 * Las claves sí las manda el servidor: `BANNER_SCREENS` en el backend es la
 * lista blanca que el panel ofrece, y este mapa la refleja. Si llega una
 * clave desconocida, el toque no hace nada — nunca navega a ciegas.
 */
const SCREEN_ROUTES: Record<string, string> = {
  search: '/(client)/(tabs)/search',
  rewards: '/(client)/rewards',
  favorites: '/(client)/favorites',
  // Pedidos se movió a la pila cuando Descuentos ocupó su lugar en la
  // barra. Si esto siguiera apuntando a la pestaña vieja, un banner ya
  // publicado navegaría a una ruta que dejó de existir.
  orders: '/(client)/orders',
  offers: '/(client)/(tabs)/offers',
  help: '/(client)/help',
};

/** Un banner sin destino utilizable no debe parecer tocable. */
export function hasAction(banner: Pick<PromoBanner, 'actionType' | 'actionValue'>): boolean {
  const type = banner.actionType as BannerActionType;
  if (type === 'none') return false;
  if (!banner.actionValue) return false;
  if (type === 'screen') return banner.actionValue in SCREEN_ROUTES;
  if (type === 'url') return /^https?:\/\//i.test(banner.actionValue);
  if (type === 'search') return banner.actionValue.trim().length >= 2;
  return true;
}

/**
 * Ejecuta la acción del banner.
 *
 * El esquema de la URL se vuelve a comprobar aquí aunque el backend ya lo
 * validó: `Linking.openURL` acepta cualquier esquema que el sistema
 * conozca, así que una URL que no sea http/https no debería llegar nunca a
 * esa llamada, venga de donde venga.
 */
export function runBannerAction(
  banner: Pick<PromoBanner, 'actionType' | 'actionValue'>,
  router: Router
): void {
  if (!hasAction(banner)) return;

  switch (banner.actionType as BannerActionType) {
    case 'url':
      // Si el sistema no puede abrirla, no pasa nada: mejor un toque sin
      // efecto que una pantalla de error por un enlace mal escrito.
      Linking.openURL(banner.actionValue).catch(() => {});
      return;

    case 'business':
      router.push(`/(client)/business/${banner.actionValue}`);
      return;

    case 'category':
      router.push({
        pathname: '/(client)/(tabs)/search',
        params: { category: banner.actionValue },
      });
      return;

    // Abre la búsqueda con el término ya escrito, en vez de la pantalla
    // vacía: un banner de "Antójate de una pizza" que deja al usuario
    // delante de una caja en blanco le hace escribir lo que acaba de leer.
    case 'search':
      router.push({
        pathname: '/(client)/(tabs)/search',
        params: { q: banner.actionValue },
      });
      return;

    case 'screen':
      router.push(SCREEN_ROUTES[banner.actionValue] as never);
      return;

    default:
      return;
  }
}
