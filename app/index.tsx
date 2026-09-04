import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Image as ExpoImage } from 'expo-image';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
import { AdSplash } from '../components/domain/AdSplash';
import { useAuthStore } from '../stores/authStore';
import { usePrefsStore } from '../stores/prefsStore';
import { adsApi, type ActiveAd } from '../services/endpoints';
import { withTimeout } from '../lib/withTimeout';

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
  try {
    const ad = await withTimeout(adsApi.getActive(), AD_FETCH_TIMEOUT_MS);
    if (!ad) return null;

    const loaded = await withTimeout(ExpoImage.prefetch(ad.flyerUrl), AD_PREFETCH_TIMEOUT_MS);
    return loaded ? ad : null;
  } catch {
    return null;
  }
}

export default function SplashScreen() {
  const router = useRouter();
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

    // Las cuentas de administrador y comercio no operan desde el móvil.
    if (isAuthenticated && user) {
      if (user.role === 'admin' || user.role === 'business') {
        useAuthStore.getState().logout();
        router.replace('/(auth)/login');
      } else if (!user.isVerified) {
        router.replace('/(auth)/otp');
      } else if (user.role === 'driver') {
        router.replace('/(driver)/(tabs)/dashboard');
      } else {
        router.replace('/(client)/(tabs)/home');
      }
      return;
    }

    router.replace(onboardingSeen ? '/(auth)/login' : '/(auth)/welcome');
  };

  useEffect(() => {
    let cancelled = false;
    let brandHoldDone = false;
    let adCheckDone = false;

    const maybeReady = () => {
      if (brandHoldDone && adCheckDone && !cancelled) setReady(true);
    };

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
