import { useState, useEffect } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { Text, Input, Button, Notice, OtpInput, Screen, Header } from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';
import { apiMessage, validateEmail } from '../../lib/errors';
import { tap } from '../../lib/haptics';

const RESEND_SECONDS = 60;

/**
 * Login sin contraseña para cuentas con correo ya verificado: pedir el
 * código reusa el mismo circuito de dos pasos que "Olvidé mi contraseña"
 * (email.service.ts en vez de whatsapp.service.ts del lado del backend).
 */
export default function EmailLoginScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  const [fieldError, setFieldError] = useState<{ email?: string }>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setInterval(() => setCountdown((n) => n - 1), 1000);
    return () => clearInterval(id);
  }, [countdown]);

  const sendCode = async () => {
    const error = validateEmail(email);
    if (error) {
      setFieldError({ email: error });
      tap('error');
      return;
    }

    setFieldError({});
    setFormError('');
    setLoading(true);

    try {
      await authApi.sendEmailOtp(email.trim().toLowerCase());
      setStep(2);
      setCountdown(RESEND_SECONDS);
      tap('light');
    } catch (err) {
      setFormError(apiMessage(err, 'No pudimos enviar el código a ese correo.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  const verify = async (value: string) => {
    if (value.length !== 6 || verifying) return;

    setVerifying(true);
    setFormError('');

    try {
      const data = await authApi.verifyEmailOtp(email.trim().toLowerCase(), value);
      const { user, accessToken, refreshToken } = data;

      if (user.role === 'admin' || user.role === 'business') {
        setFormError(
          user.role === 'admin'
            ? 'Las cuentas de administrador entran por la consola web.'
            : 'Las cuentas de comercio entran por el portal de negocios.'
        );
        setVerifying(false);
        tap('warning');
        return;
      }

      await setAuth(user, accessToken, refreshToken);
      tap('success');

      router.replace(
        user.role === 'driver' ? '/(driver)/(tabs)/dashboard' : '/(client)/(tabs)/home'
      );
    } catch (err) {
      setFormError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
      tap('error');
      setVerifying(false);
    }
  };

  return (
    <Screen>
      <Header
        title={`Paso ${step} de 2`}
        fallback="/(auth)/login"
        onBack={step === 2 ? () => setStep(1) : undefined}
        bare
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          {step === 1 ? (
            <Animated.View entering={FadeIn.duration(300)} style={styles.section}>
              <View style={styles.intro}>
                <Text v="displayL">Entra con tu correo</Text>
                <Text v="bodyL" tone="textSecondary">
                  Escribe el correo verificado de tu cuenta y te mandamos un código de acceso.
                </Text>
              </View>

              <Input
                label="Correo electrónico"
                icon="correo"
                placeholder="tucorreo@ejemplo.com"
                value={email}
                onChangeText={(t) => { setEmail(t); setFieldError({}); }}
                error={fieldError.email}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                onSubmitEditing={sendCode}
                returnKeyType="go"
              />

              {formError ? <Notice tone="error">{formError}</Notice> : null}

              <Button
                title="Enviar código"
                size="lg"
                full
                loading={loading}
                onPress={sendCode}
                haptic="medium"
              />
            </Animated.View>
          ) : (
            <Animated.View entering={FadeInDown.duration(320)} style={styles.section}>
              <View style={styles.intro}>
                <Text v="displayL">Revisa tu correo</Text>
                <Text v="bodyL" tone="textSecondary">
                  Escribe el código de 6 dígitos que llegó a {email.trim()}.
                </Text>
              </View>

              <View style={styles.otpGroup}>
                <Text v="strongS" tone="textSecondary">Código de 6 dígitos</Text>
                <OtpInput
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    setFormError('');
                    if (v.length === 6) verify(v);
                  }}
                  error={!!formError}
                  autoFocus
                />
              </View>

              {formError ? <Notice tone="error">{formError}</Notice> : null}

              <Button
                title="Entrar"
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
                  <Pressable onPress={sendCode} hitSlop={10} accessibilityRole="button">
                    <Text v="strongM" tone="primaryText">Reenviar código</Text>
                  </Pressable>
                )}
              </View>
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.xxl, paddingBottom: Spacing.huge },
  section: { gap: Spacing.lg },
  intro: { gap: Spacing.sm, marginBottom: Spacing.md },
  otpGroup: { gap: Spacing.sm },
  resend: { alignItems: 'center', marginTop: Spacing.xs },
});
