import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { ZippSplashLoader } from '../components/brand/ZippSplashLoader';
import { useAuthStore } from '../stores/authStore';
import { usePrefsStore } from '../stores/prefsStore';

/** Tiempo de bienvenida para apreciar la marca y el efecto de reflejo metálico */
const HOLD_MS = 2200;

export default function SplashScreen() {
  const router = useRouter();
  const { isAuthenticated, user } = useAuthStore();
  const onboardingSeen = usePrefsStore((s) => s.onboardingSeen);

  useEffect(() => {
    const timer = setTimeout(() => {
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
    }, HOLD_MS);

    return () => clearTimeout(timer);
  }, [isAuthenticated, user, onboardingSeen]);

  return <ZippSplashLoader />;
}
