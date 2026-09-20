import { useRouter } from 'expo-router';
import { useAuthStore, type User } from '../stores/authStore';
import { decideAfterAuth, hrefFor } from '../lib/routing';
import { tap } from '../lib/haptics';

/** Sesión emitida: login, registro, Google/Apple, OTP o el reto de 2FA. */
export interface SessionResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  /** Google/Apple no dan celular: la cuenta queda a medias hasta que lo escriba. */
  needsPhone?: boolean;
}

/**
 * La cuenta tiene verificación en dos pasos: el primer factor fue correcto,
 * pero todavía no hay sesión. Ver `sendAuthOutcome` en el backend.
 */
export interface TwoFactorRequired {
  requiresTOTP: true;
  challengeToken?: string;
  user: { _id: string; name: string };
}

export type AuthResponse = SessionResult | TwoFactorRequired;

export const needsSecondFactor = (result: AuthResponse): result is TwoFactorRequired =>
  (result as TwoFactorRequired).requiresTOTP === true;

/**
 * Cierra cualquier forma de entrar.
 *
 * Antes cada pantalla (login, OTP, recuperar contraseña) desestructuraba los
 * tokens por su cuenta, y ninguna contemplaba el 2FA: una cuenta con 2FA
 * recibía `{ requiresTOTP }` sin tokens y la app guardaba una sesión vacía.
 *
 * Decide a dónde ir ANTES de guardar la sesión: una cuenta de la otra app o
 * de un panel web no debe quedar persistida en este teléfono ni un instante.
 */
export function useFinishAuth(onError: (message: string) => void) {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  return async (result: AuthResponse) => {
    if (needsSecondFactor(result)) {
      if (!result.challengeToken) {
        onError('No pudimos iniciar la verificación en dos pasos. Intenta de nuevo.');
        tap('error');
        return;
      }
      tap('light');
      router.push({
        pathname: '/(auth)/two-factor',
        params: { challengeToken: result.challengeToken, name: result.user.name },
      } as never);
      return;
    }

    const { user, accessToken, refreshToken, needsPhone } = result;
    const decision = decideAfterAuth(user, { needsPhone });

    if (decision.kind === 'web-only') {
      onError(
        decision.role === 'admin'
          ? 'Las cuentas de administrador entran por la consola web.'
          : 'Las cuentas de comercio entran por el portal de negocios.'
      );
      tap('warning');
      return;
    }

    if (decision.kind === 'wrong-app') {
      // La pantalla explica cuál es su app y la enlaza; no hay sesión que cerrar.
      tap('warning');
      router.replace(hrefFor(decision) as never);
      return;
    }

    await setAuth(user, accessToken, refreshToken);
    tap('success');
    router.replace(hrefFor(decision) as never);
  };
}
