import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { GoogleButton, FacebookButton, AppleButton } from '../ui';
import { authApi } from '../../services/endpoints';
import { apiMessage } from '../../lib/errors';
import { useGoogleAuth } from '../../lib/googleAuth';
import { useAppleAuth } from '../../lib/appleAuth';
import { useFacebookAuth } from '../../lib/facebookAuth';
import { Spacing } from '../../theme/tokens';
import type { AuthResponse } from '../../hooks/useFinishAuth';

interface Props {
  /**
   * Se llama con lo que respondió el backend: la sesión, o el reto de 2FA si
   * la cuenta lo tiene. Quien lo recibe decide si la guarda.
   */
  onAuth: (result: AuthResponse) => Promise<unknown>;
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
  const [facebookLoading, setFacebookLoading] = useState(false);
  const { signIn: googleSignIn, isConfigured: googleConfigured } = useGoogleAuth();
  const { signIn: appleSignIn, isConfigured: appleConfigured } = useAppleAuth();
  const { signIn: facebookSignIn, isConfigured: facebookConfigured } = useFacebookAuth();

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
      await onAuth(await authApi.apple(result.code, result.nonce));
    } catch (error) {
      onError(apiMessage(error, 'No pudimos iniciar sesión con Apple.'));
    } finally {
      setAppleLoading(false);
    }
  };

  const handleFacebook = async () => {
    setFacebookLoading(true);
    onError('');
    try {
      const result = await facebookSignIn();
      if (!result) return; // cerró el diálogo o negó el permiso
      await onAuth(await authApi.facebook(result.code, result.codeVerifier));
    } catch (error) {
      onError(apiMessage(error, 'No pudimos iniciar sesión con Facebook.'));
    } finally {
      setFacebookLoading(false);
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
      {/* Sin app en Meta no se muestra: ver lib/facebookAuth.ts. */}
      {facebookConfigured ? (
        <FacebookButton full pill loading={facebookLoading} onPress={handleFacebook} />
      ) : null}
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
