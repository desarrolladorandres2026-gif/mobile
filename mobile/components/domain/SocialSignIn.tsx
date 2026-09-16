import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { GoogleButton, FacebookButton, AppleButton } from '../ui';
import { authApi } from '../../services/endpoints';
import { apiMessage } from '../../lib/errors';
import { useGoogleAuth } from '../../lib/googleAuth';
import { useAppleAuth } from '../../lib/appleAuth';
import { Spacing } from '../../theme/tokens';
import type { User } from '../../stores/authStore';

/** Lo que devuelven `/auth/google` y `/auth/apple` (y también el login normal). */
export interface SocialAuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  /** Google/Apple no dan celular: la cuenta queda a medias hasta que lo escriba. */
  needsPhone?: boolean;
}

interface Props {
  /** Se llama con la sesión ya emitida por el backend; quien lo recibe decide si la guarda. */
  onAuth: (result: SocialAuthResult) => Promise<unknown>;
  onError: (message: string) => void;
}

/**
 * Botones de Google, Facebook y Apple del login.
 *
 * Viven en su propio componente, y no en `login.tsx`, porque solo existen
 * en la app de clientes: los domiciliarios los da de alta admin y entran
 * con celular. `lib/googleAuth.ts` hace `require` del módulo nativo al
 * cargarse; si `login.tsx` lo importara directamente, la app de
 * domiciliarios lo cargaría y configuraría sin usarlo nunca.
 */
export function SocialSignIn({ onAuth, onError }: Props) {
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const { signIn: googleSignIn, isConfigured: googleConfigured } = useGoogleAuth();
  const { signIn: appleSignIn, isConfigured: appleConfigured } = useAppleAuth();

  const handleGoogle = async () => {
    setGoogleLoading(true);
    onError('');
    try {
      const idToken = await googleSignIn();
      if (!idToken) return; // el usuario cerró el selector
      await onAuth(await authApi.google(idToken));
    } catch (error) {
      onError(apiMessage(error, 'No pudimos iniciar sesión con Google.'));
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleApple = async () => {
    setAppleLoading(true);
    onError('');
    try {
      const result = await appleSignIn();
      if (!result) return; // el usuario cerró el navegador
      await onAuth(await authApi.apple(result.idToken, result.fullName));
    } catch (error) {
      onError(apiMessage(error, 'No pudimos iniciar sesión con Apple.'));
    } finally {
      setAppleLoading(false);
    }
  };

  return (
    <View style={styles.buttons}>
      <GoogleButton
        full
        pill
        loading={googleLoading}
        disabled={!googleConfigured}
        onPress={handleGoogle}
      />
      <FacebookButton full pill />
      <AppleButton
        full
        pill
        loading={appleLoading}
        disabled={!appleConfigured}
        onPress={handleApple}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { gap: Spacing.md },
});
