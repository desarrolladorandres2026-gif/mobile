import { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
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

/**
 * Confirma un celular nuevo que quedó en `pendingPhone`.
 *
 * El backend nunca escribe el celular directamente: lo aparta y manda un
 * código a ese número, y solo `POST /auth/phone/verify` lo asocia a la
 * cuenta. Antes esta confirmación se hacía con `otp.tsx`, que es el OTP del
 * login y mira `user.phone`: el número nuevo nunca se confirmaba.
 *
 * `from=account` vuelve a Mi cuenta; sin él (completar perfil tras Google o
 * Apple) sigue a donde corresponda después de identificarse.
 */
export default function VerifyPhoneScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const { from, sent } = useLocalSearchParams<{ from?: string; sent?: string }>();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const phone = user?.pendingPhone ?? '';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(RESEND_SECONDS);

  // Si se llega sin que el backend acabe de mandar el código (p. ej. desde la
  // fila "pendiente" de Mi cuenta), se pide uno. Una sola vez: React 19 monta
  // dos veces en desarrollo.
  const askedOnce = useRef(false);
  useEffect(() => {
    if (sent === '1' || !phone || askedOnce.current) return;
    askedOnce.current = true;
    authApi.resendPhoneOtp().catch((err) => {
      setError(apiMessage(err, 'No pudimos enviar el código. Toca "Reenviar" para intentarlo otra vez.'));
    });
  }, [phone, sent]);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setInterval(() => setCountdown((n) => n - 1), 1000);
    return () => clearInterval(id);
  }, [countdown]);

  // Volver sin confirmar deja el número pendiente: se regresa a donde se
  // escribió (completar perfil o Mi cuenta) para corregirlo si hace falta.
  const leave = () => {
    if (router.canGoBack()) router.back();
    else if (user) router.replace(hrefFor(decideAfterAuth(user)) as never);
  };

  const verify = async (value: string) => {
    if (value.length !== 6 || verifying) return;

    setVerifying(true);
    setError('');
    try {
      const data = await authApi.verifyPhone(value);
      setUser(data.user);
      setVerified(true);
      tap('success');
      // El acuse se ve antes de navegar; saltar en el mismo instante deja
      // al usuario sin saber si funcionó.
      setTimeout(() => {
        if (from === 'account') router.back();
        else router.replace(hrefFor(decideAfterAuth(data.user)) as never);
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
      const { sent: wasSent } = await authApi.resendPhoneOtp();
      setCountdown(RESEND_SECONDS);
      setCode('');
      if (!wasSent) setError('Espera unos segundos antes de pedir otro código.');
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
          <Text v="displayM" center>Celular confirmado</Text>
          <Text v="bodyL" tone="textSecondary" center>Ya es el número de tu cuenta.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header fallback="/(auth)/login" bare onBack={leave} />

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
            {phone ? (
              <>
                <Text v="bodyL" tone="textSecondary">
                  Te mandamos un código de 6 dígitos por WhatsApp al
                </Text>
                <Text v="dataL" tone="primaryText">+57 {phone}</Text>
              </>
            ) : null}
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(90).duration(400)} style={styles.form}>
            {!phone ? (
              <Notice tone="warning">
                No tienes un celular pendiente de confirmar. Escríbelo de nuevo desde tu cuenta.
              </Notice>
            ) : (
              <>
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
              </>
            )}
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
