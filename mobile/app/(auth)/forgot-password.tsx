import { useState, useEffect } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { Text, Input, Button, Notice, OtpInput, Screen, Header } from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';
import { apiMessage, validatePhone, validatePassword } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { decideAfterAuth, hrefFor } from '../../lib/routing';

const RESEND_SECONDS = 60;

/**
 * Recuperar la contraseña en dos pasos.
 *
 * El paso se muestra arriba con un trazo de avance: en un flujo donde llega
 * un SMS de por medio, saber cuánto falta evita que la gente lo abandone a
 * mitad de camino.
 */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [step, setStep] = useState<1 | 2>(1);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [fieldError, setFieldError] = useState<{ phone?: string; password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setInterval(() => setCountdown((n) => n - 1), 1000);
    return () => clearInterval(id);
  }, [countdown]);

  const sendCode = async () => {
    const error = validatePhone(phone);
    if (error) {
      setFieldError({ phone: error });
      tap('error');
      return;
    }

    setFieldError({});
    setFormError('');
    setLoading(true);

    try {
      await authApi.sendOtp(phone.replace(/\D/g, ''));
      setStep(2);
      setCountdown(RESEND_SECONDS);
      tap('light');
    } catch (err) {
      setFormError(apiMessage(err, 'No pudimos enviar el código a ese número.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  const reset = async () => {
    const passwordError = validatePassword(password);
    const confirmError = confirm !== password ? 'Las contraseñas no coinciden' : undefined;

    if (code.length !== 6) {
      setFormError('Escribe los 6 dígitos del código.');
      tap('error');
      return;
    }
    if (passwordError || confirmError) {
      setFieldError({ password: passwordError ?? undefined, confirm: confirmError });
      tap('error');
      return;
    }

    setFieldError({});
    setFormError('');
    setLoading(true);

    try {
      const data = await authApi.resetPassword({
        phone: phone.replace(/\D/g, ''),
        otpCode: code,
        password,
      });
      const { user, accessToken, refreshToken } = data;
      await setAuth(user, accessToken, refreshToken);
      tap('success');

      router.replace(hrefFor(decideAfterAuth(user)) as never);
    } catch (err) {
      setFormError(apiMessage(err, 'No pudimos cambiar tu contraseña.'));
      tap('error');
    } finally {
      setLoading(false);
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
                <Text v="displayL">Recupera tu cuenta</Text>
                <Text v="bodyL" tone="textSecondary">
                  Escribe el celular con el que te registraste y te mandamos un código.
                </Text>
              </View>

              <Input
                label="Celular"
                icon="celular"
                prefix="+57"
                placeholder="300 000 0000"
                keyboardType="phone-pad"
                maxLength={10}
                value={phone}
                onChangeText={(t) => { setPhone(t); setFieldError({}); }}
                error={fieldError.phone}
                numeric
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
                <Text v="displayL">Crea una nueva</Text>
                <Text v="bodyL" tone="textSecondary">
                  Escribe el código que llegó a tu celular y elige tu nueva contraseña.
                </Text>
              </View>

              <View style={styles.otpGroup}>
                <Text v="strongS" tone="textSecondary">Código de 6 dígitos</Text>
                <OtpInput value={code} onChange={(v) => { setCode(v); setFormError(''); }} />
              </View>

              <Input
                label="Nueva contraseña"
                icon="candado"
                placeholder="Mínimo 6 caracteres"
                password
                value={password}
                onChangeText={(t) => { setPassword(t); setFieldError({}); }}
                error={fieldError.password}
                autoComplete="new-password"
              />

              <Input
                label="Repite la contraseña"
                icon="seguridad"
                placeholder="La misma de arriba"
                password
                value={confirm}
                onChangeText={(t) => { setConfirm(t); setFieldError({}); }}
                error={fieldError.confirm}
              />

              {formError ? <Notice tone="error">{formError}</Notice> : null}

              <Button
                title="Guardar y entrar"
                size="lg"
                full
                loading={loading}
                onPress={reset}
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
