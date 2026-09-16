import { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Text, Button, Notice, OtpInput, Screen, Header, SuccessCheck } from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { decideAfterAuth, hrefFor } from '../../lib/routing';

const RESEND_SECONDS = 60;

export default function OtpScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const { user, setAuth, logout } = useAuthStore();
  const phone = user?.phone ?? '';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(RESEND_SECONDS);

  // Sin esto, el código se dispara dos veces en el arranque doble de React 19.
  const sentOnce = useRef(false);

  useEffect(() => {
    if (!phone || sentOnce.current) return;
    sentOnce.current = true;
    authApi.sendOtp(phone).catch(() => {
      setError('No pudimos enviar el mensaje. Toca "Reenviar" para intentarlo otra vez.');
    });
  }, [phone]);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setInterval(() => setCountdown((n) => n - 1), 1000);
    return () => clearInterval(id);
  }, [countdown]);

  const verify = async (value: string) => {
    if (value.length !== 6 || verifying) return;

    setVerifying(true);
    setError('');

    try {
      const data = await authApi.verifyOtp(phone, value);
      const { user: verifiedUser, accessToken, refreshToken } = data;
      await setAuth(verifiedUser, accessToken, refreshToken);

      // Se muestra el acuse antes de navegar: confirmar y saltar de pantalla
      // en el mismo instante deja al usuario sin saber si funcionó.
      setVerified(true);
      tap('success');

      setTimeout(() => {
        router.replace(hrefFor(decideAfterAuth(verifiedUser)) as never);
      }, 1100);
    } catch (err) {
      setError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
      tap('error');
      setVerifying(false);
    }
  };

  const resend = async () => {
    if (countdown > 0 || resending) return;
    setResending(true);
    setError('');
    try {
      await authApi.sendOtp(phone);
      setCountdown(RESEND_SECONDS);
      setCode('');
      tap('light');
    } catch (err) {
      setError(apiMessage(err, 'No pudimos reenviar el código.'));
    } finally {
      setResending(false);
    }
  };

  if (verified) {
    return (
      <Screen>
        <View style={styles.done}>
          <SuccessCheck size={88} />
          <Text v="displayM" center>Listo, quedaste verificado</Text>
          <Text v="bodyL" tone="textSecondary" center>Te llevamos a la app…</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        fallback="/(auth)/login"
        bare
        // Salir a medias dejaría la sesión sin verificar; se cierra limpio.
        onBack={() => { logout(); router.replace('/(auth)/login'); }}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeInDown.duration(400)} style={styles.intro}>
            <Text v="displayL">Confirma tu celular</Text>
            <Text v="bodyL" tone="textSecondary">
              Te mandamos un código de 6 dígitos por WhatsApp al
            </Text>
            <Text v="dataL" tone="primaryText">+57 {phone}</Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(90).duration(400)} style={styles.form}>
            <OtpInput
              value={code}
              onChange={(next) => {
                setCode(next);
                setError('');
                if (next.length === 6) verify(next);
              }}
              error={!!error}
              autoFocus
            />

            {error ? <Notice tone="error">{error}</Notice> : null}

            <Button
              title="Verificar"
              size="lg"
              full
              disabled={code.length < 6}
              loading={verifying}
              onPress={() => verify(code)}
              haptic="medium"
            />

            <View style={styles.resend}>
              {countdown > 0 ? (
                <Text v="bodyM" tone="textMuted">
                  Puedes pedir otro código en{' '}
                  <Text v="dataM" tone="textSecondary">{countdown}s</Text>
                </Text>
              ) : (
                <Pressable onPress={resend} hitSlop={10} accessibilityRole="button">
                  <Text v="strongM" tone="primaryText">
                    {resending ? 'Enviando…' : 'Reenviar código'}
                  </Text>
                </Pressable>
              )}
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.xxl, paddingBottom: Spacing.huge, gap: Spacing.xxxl },
  intro: { gap: Spacing.sm },
  form: { gap: Spacing.xl },
  resend: { alignItems: 'center' },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.xxl },
});
