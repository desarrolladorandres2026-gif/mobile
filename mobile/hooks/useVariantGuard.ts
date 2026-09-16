import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { useAuthStore } from '../stores/authStore';
import { decideAtStart, hrefFor } from '../lib/routing';

/**
 * Red de seguridad: una sesión que no es de esta app nunca se queda dentro.
 *
 * El arranque normal pasa por `app/index.tsx`, que ya decide con la misma
 * regla. Pero hay entradas que se saltan el splash —un deep link
 * `zippdriver://…`, una push tocada con la app cerrada— y en ellas la
 * sesión guardada de la otra app llegaría directa a una pantalla que no le
 * corresponde. Este hook vive en el layout raíz, mira el rol cada vez que
 * cambia la sesión, y manda a `wrong-app` si no es de aquí.
 *
 * Comparte `decideAtStart` con el splash para que los dos digan siempre lo
 * mismo: no hay una segunda copia de la regla que pueda desincronizarse.
 */
export function useVariantGuard(): void {
  const router = useRouter();
  const segments = useSegments();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const role = useAuthStore((s) => s.user?.role);
  const isVerified = useAuthStore((s) => s.user?.isVerified ?? false);

  useEffect(() => {
    if (!isAuthenticated || !role) return;

    const decision = decideAtStart({
      isAuthenticated,
      user: { role, isVerified },
      onboardingSeen: true,
    });
    if (decision.kind !== 'wrong-app' && decision.kind !== 'web-only') return;

    // Ya está en la pantalla que explica el problema (o llegando a ella).
    const [zone, screen] = segments as string[];
    if (zone === '(auth)' && screen === 'wrong-app') return;

    router.replace(hrefFor(decision) as never);
  }, [isAuthenticated, role, isVerified, segments, router]);
}
