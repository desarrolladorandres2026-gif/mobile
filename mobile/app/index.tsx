import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Image as ExpoImage } from 'expo-image';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
import { AdSplash } from '../components/domain/AdSplash';
import { useAuthStore } from '../stores/authStore';
import { usePrefsStore } from '../stores/prefsStore';
import { adsApi, addressApi, homeCategoriesApi, type ActiveAd } from '../services/endpoints';
import { withTimeout } from '../lib/withTimeout';
import { decideAtStart, hrefFor } from '../lib/routing';
import { IS_CLIENT_APP } from '../constants/variant';

/** Tiempo de bienvenida para apreciar la marca y el efecto de reflejo metálico. */
const HOLD_MS = 2200;
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
 * Los 2,2 segundos de bienvenida eran tiempo regalado: no se precargaba
 * absolutamente nada, así que el Inicio empezaba sus siete peticiones
 * **después**, con el usuario ya mirando esqueletos. Aquí se solapan con una
 * espera que iba a ocurrir de todos modos.
 *
 * `prefetchQuery` y no `fetchQuery`: prefetch no lanza si algo falla, que es
 * justo lo que se quiere en el arranque. Un fallo aquí no debe impedir
 * entrar a la app — el Inicio volverá a pedirlo y enseñará su propio error.
 *
 * Las claves tienen que coincidir **exactamente** con las de los hooks o el
 * trabajo se descarta en silencio y se hace dos veces.
 *
 * Por eso **no** se precarga el catálogo: Inicio lo pide como
 * `['businesses', { lng, lat }]`, con unas coordenadas que aquí todavía no
 * se conocen. Pedirlo sin ellas crearía una segunda clave y descargaría el
 * catálogo entero dos veces — exactamente el problema que `useBusinesses`
 * acaba de resolver esperando a las direcciones.
 *
 * Se precargan las direcciones, que son las que traen esas coordenadas y por
 * tanto lo que desbloquea todo lo demás, y las categorías del Inicio, que no
 * dependen de nada.
 */
function warmCache(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.prefetchQuery({
    queryKey: ['addresses'],
    queryFn: addressApi.getAll,
  });
  void queryClient.prefetchQuery({
    // La clave es `homeCategories`, no `home-categories`: con la clave mal
    // el prefetch se descarta en silencio y el trabajo se hace dos veces.
    queryKey: ['homeCategories'],
    queryFn: homeCategoriesApi.getAll,
  });
}

export default function SplashScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuthStore();
  const onboardingSeen = usePrefsStore((s) => s.onboardingSeen);
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
    router.replace(hrefFor(decideAtStart({ isAuthenticated, user, onboardingSeen })) as never);
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
    if (IS_CLIENT_APP && isAuthenticated && user?.role === 'client') warmCache(queryClient);

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
