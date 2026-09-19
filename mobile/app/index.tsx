import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
import { AdSplash } from '../components/domain/AdSplash';
import { useAuthStore } from '../stores/authStore';
import {
  adsApi, addressApi, bannersApi, homeCategoriesApi, homeSectionsApi, ordersApi, type ActiveAd,
} from '../services/endpoints';
import { ensureFreshAccessToken } from '../services/api';
import { coordsFromAddresses } from '../hooks/useApi';
import { withTimeout } from '../lib/withTimeout';
import { decideAtStart, hrefFor } from '../lib/routing';
import { IS_CLIENT_APP } from '../constants/variant';

/**
 * Tiempo de bienvenida para apreciar la marca y el efecto de reflejo metálico.
 *
 * Eran 2,2 s. Se bajó a 1,2 s (decisión del 2026-09-18): el reflejo se
 * alcanza a ver completo una vez, y el Inicio ya llega lleno porque se
 * precarga durante este mismo tiempo (ver `warmCache`).
 */
const HOLD_MS = 1200;
/** Tope para pedir la campaña activa: publicidad lenta nunca puede demorar el arranque. */
const AD_FETCH_TIMEOUT_MS = 2500;
/** Tope para precargar el flyer antes de decidir si se muestra. */
const AD_PREFETCH_TIMEOUT_MS = 2000;

/**
 * Busca la campaña activa y precarga su flyer, sin dejar que ninguna de las
 * dos cosas se demore más de lo acotado arriba. Cualquier fallo —API caída,
 * sin conexión, timeout, campaña vencida, imagen que no carga— resuelve a
 * `null`: "sin publicidad" es un resultado tan válido como "con publicidad",
 * nunca "esperando publicidad".
 */
async function prepareAd(): Promise<ActiveAd | null> {
  // La publicidad es de comercios para clientes; en Zipp Domiciliarios no
  // hay nada que anunciar y el flyer enlaza a pantallas que no existen.
  if (!IS_CLIENT_APP) return null;
  try {
    const ad = await withTimeout(adsApi.getActive(), AD_FETCH_TIMEOUT_MS);
    if (!ad) return null;

    const loaded = await withTimeout(ExpoImage.prefetch(ad.flyerUrl), AD_PREFETCH_TIMEOUT_MS);
    return loaded ? ad : null;
  } catch {
    return null;
  }
}

/**
 * Calienta la caché mientras se ve la marca.
 *
 * El tiempo de bienvenida era tiempo regalado: no se precargaba nada, así
 * que el Inicio empezaba sus peticiones **después**, con el usuario ya
 * mirando esqueletos. Aquí se solapan con una espera que iba a ocurrir de
 * todos modos.
 *
 * Primero el token: si venció (lo normal tras 15 minutos), se refresca
 * antes de pedir nada, en vez de que cada petición falle con 401 y se
 * repita. Después, en paralelo:
 *
 * - las direcciones, y con ellas las coordenadas → las colecciones del
 *   Inicio (`home-sections`), con **la misma clave** que usará el hook;
 * - las categorías del Inicio;
 * - la primera página de pedidos (la usan el Dock y "lo de siempre");
 * - los banners del Inicio.
 *
 * `prefetchQuery` y no `fetchQuery`: prefetch no lanza si algo falla, que es
 * justo lo que se quiere en el arranque. Un fallo aquí no debe impedir
 * entrar a la app — el Inicio volverá a pedirlo y enseñará su propio error.
 *
 * Las claves tienen que coincidir **exactamente** con las de los hooks o el
 * trabajo se descarta en silencio y se hace dos veces. Por eso **no** se
 * precarga el catálogo `['businesses', …]`, que depende de parámetros de la
 * pantalla.
 */
async function warmCache(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await ensureFreshAccessToken();
  if (!useAuthStore.getState().isAuthenticated) return;

  const homeSections = (async () => {
    const addresses = await queryClient
      .fetchQuery({ queryKey: ['addresses'], queryFn: addressApi.getAll })
      .catch(() => undefined);
    const coords = coordsFromAddresses(addresses);
    await queryClient.prefetchQuery({
      queryKey: ['home-sections', coords],
      queryFn: () => homeSectionsApi.get(coords),
      staleTime: 5 * 60_000,
    });
  })();

  await Promise.all([
    homeSections,
    // La clave es `homeCategories`, no `home-categories`: con la clave mal
    // el prefetch se descarta en silencio y el trabajo se hace dos veces.
    queryClient.prefetchQuery({ queryKey: ['homeCategories'], queryFn: homeCategoriesApi.getAll }),
    queryClient.prefetchQuery({ queryKey: ['orders', 'my', 1], queryFn: () => ordersApi.getMyOrders(1) }),
    queryClient.prefetchQuery({ queryKey: ['banners', 'home'], queryFn: () => bannersApi.getActive('home') }),
  ]);
}

export default function SplashScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const [ad, setAd] = useState<ActiveAd | null>(null);
  // Se cumple cuando TANTO el tiempo de marca COMO la comprobación de
  // publicidad terminaron — lo que tarde más, no la suma de los dos. La
  // publicidad se busca en paralelo al tiempo de marca, nunca después.
  const [ready, setReady] = useState(false);
  const navigated = useRef(false);

  const navigateNow = () => {
    if (navigated.current) return;
    navigated.current = true;

    // Una sesión guardada de la otra app (o de un panel web) cae en
    // `wrong-app`, que explica cuál es su app y cierra la sesión allí.
    // Ver lib/routing.ts para la regla completa.
    router.replace(hrefFor(decideAtStart({ isAuthenticated, user })) as never);
  };

  useEffect(() => {
    let cancelled = false;
    let brandHoldDone = false;
    let adCheckDone = false;

    const maybeReady = () => {
      if (brandHoldDone && adCheckDone && !cancelled) setReady(true);
    };

    // Solo tiene sentido para un cliente con sesión: sin sesión estas
    // peticiones darían 401, y en la app de domiciliarios no hay catálogo.
    if (IS_CLIENT_APP && isAuthenticated && user?.role === 'client') {
      void warmCache(queryClient);
    } else if (isAuthenticated) {
      // El domiciliario no tiene catálogo que precargar, pero su tablero
      // también empieza con peticiones autenticadas: mejor con token vigente.
      void ensureFreshAccessToken();
    }

    const holdTimer = setTimeout(() => {
      brandHoldDone = true;
      maybeReady();
    }, HOLD_MS);

    prepareAd().then((result) => {
      if (cancelled) return;
      setAd(result);
      adCheckDone = true;
      maybeReady();
    });

    return () => {
      cancelled = true;
      clearTimeout(holdTimer);
    };
  }, []);

  useEffect(() => {
    // Sin campaña que mostrar: sigue el flujo normal en cuanto todo esté listo.
    // Con campaña, es AdSplash quien decide cuándo llamar a navigateNow.
    if (ready && !ad) navigateNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ad]);

  if (ready && ad) {
    return <AdSplash ad={ad} onDone={navigateNow} />;
  }

  return <ZippSplashLoader />;
}
