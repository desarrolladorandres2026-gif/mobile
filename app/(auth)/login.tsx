import { useState, useEffect } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown, FadeInUp, FadeIn } from 'react-native-reanimated';
import { Text, Input, Button, GoogleButton, Notice, Card } from '../../components/ui';
import { ZippMarkDrawing } from '../../components/brand/ZippLogo';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { Spacing, BorderRadius, palette, Shadow } from '../../theme/tokens';
import { apiMessage, validatePhone, validatePassword } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { useGoogleAuth } from '../../lib/googleAuth';

export default function LoginScreen() {
  const router = useRouter();
  const { c, isDark } = useTheme();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ phone?: string; password?: string }>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const { request: googleRequest, idToken: googleIdToken, promptAsync: promptGoogle } = useGoogleAuth();

  const routeAfterAuth = (user: { role: string; isVerified: boolean }, needsPhone: boolean) => {
    if (needsPhone) router.replace('/(auth)/complete-profile');
    else if (!user.isVerified) router.replace('/(auth)/otp');
    else if (user.role === 'driver') router.replace('/(driver)/(tabs)/dashboard');
    else router.replace('/(client)/(tabs)/home');
  };

  useEffect(() => {
    if (!googleIdToken) return;

    (async () => {
      setGoogleLoading(true);
      setFormError('');
      try {
        const data = await authApi.google(googleIdToken);
        const { user, accessToken, refreshToken, needsPhone } = data;
        await setAuth(user, accessToken, refreshToken);
        tap('success');
        routeAfterAuth(user, needsPhone);
      } catch (error) {
        setFormError(apiMessage(error, 'No pudimos iniciar sesión con Google.'));
        tap('error');
      } finally {
        setGoogleLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleIdToken]);

  const handleLogin = async () => {
    const phoneError = validatePhone(phone);
    const passwordError = validatePassword(password);

    if (phoneError || passwordError) {
      setErrors({ phone: phoneError ?? undefined, password: passwordError ?? undefined });
      tap('error');
      return;
    }

    setErrors({});
    setFormError('');
    setLoading(true);

    try {
      const data = await authApi.login(phone.replace(/\D/g, ''), password);
      const { user, accessToken, refreshToken } = data;

      if (user.role === 'admin' || user.role === 'business') {
        setFormError(
          user.role === 'admin'
            ? 'Las cuentas de administrador entran por la consola web.'
            : 'Las cuentas de comercio entran por el portal de negocios.'
        );
        setLoading(false);
        tap('warning');
        return;
      }

      await setAuth(user, accessToken, refreshToken);
      tap('success');

      if (!user.isVerified) router.replace('/(auth)/otp');
      else if (user.role === 'driver') router.replace('/(driver)/(tabs)/dashboard');
      else router.replace('/(client)/(tabs)/home');
    } catch (error) {
      setFormError(apiMessage(error, 'No pudimos iniciar tu sesión. Verifica tus datos.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
      {/* Ambient Top Glow Orbs */}
      <View style={styles.glowContainer} pointerEvents="none">
        <View style={[styles.glowOrbPrimary, { backgroundColor: palette.zipp500 }]} />
        <View style={[styles.glowOrbSecondary, { backgroundColor: palette.lima500 }]} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Brand Header with Animated Drawing Logo */}
          <Animated.View entering={FadeInDown.duration(600)} style={styles.brand}>
            <View style={styles.logoWrapper}>
              <View style={[styles.logoBackdrop, { backgroundColor: isDark ? '#1a2234' : '#edf2ff' }]}>
                <ZippMarkDrawing size={64} />
              </View>
            </View>

            <View style={styles.greeting}>
              <Text v="displayXL" style={styles.titleText}>
                ¡Hola de nuevo!
              </Text>
              <Text v="bodyM" tone="textSecondary">
                Entra a tu cuenta y disfruta de tus restaurantes y tiendas favoritas.
              </Text>
            </View>
          </Animated.View>

          {/* Form Section Card */}
          <Animated.View entering={FadeInDown.delay(120).duration(500)} style={styles.formCard}>
            <Card tone={isDark ? 'raised' : 'flat'} style={styles.cardInner}>
              <View style={styles.formFields}>
                <Input
                  label="Número de Celular"
                  icon="celular"
                  prefix="+57"
                  placeholder="300 000 0000"
                  keyboardType="phone-pad"
                  maxLength={10}
                  value={phone}
                  onChangeText={(t) => {
                    setPhone(t);
                    setErrors((e) => ({ ...e, phone: undefined }));
                  }}
                  error={errors.phone}
                  numeric
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                />

                <Input
                  label="Contraseña"
                  icon="candado"
                  placeholder="Ingresa tu contraseña"
                  password
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    setErrors((e) => ({ ...e, password: undefined }));
                  }}
                  error={errors.password}
                  autoComplete="current-password"
                  onSubmitEditing={handleLogin}
                  returnKeyType="go"
                />

                <View style={styles.forgotWrapper}>
                  <Pressable
                    onPress={() => {
                      tap('light');
                      router.push('/(auth)/forgot-password');
                    }}
                    hitSlop={10}
                    accessibilityRole="button"
                  >
                    <Text v="strongS" tone="primaryText">
                      ¿Olvidaste tu contraseña?
                    </Text>
                  </Pressable>
                </View>

                {formError ? (
                  <Animated.View entering={FadeIn.duration(200)}>
                    <Notice tone="error">{formError}</Notice>
                  </Animated.View>
                ) : null}

                <Button
                  title="Iniciar Sesión"
                  iconRight="adelante"
                  size="lg"
                  full
                  loading={loading}
                  onPress={handleLogin}
                  haptic="medium"
                />

                <View style={styles.dividerRow}>
                  <View style={[styles.dividerLine, { backgroundColor: c.border }]} />
                  <Text v="captionStrong" tone="textMuted">O</Text>
                  <View style={[styles.dividerLine, { backgroundColor: c.border }]} />
                </View>

                <GoogleButton
                  full
                  loading={googleLoading}
                  disabled={!googleRequest}
                  onPress={() => promptGoogle()}
                />

                <Pressable
                  onPress={() => {
                    tap('light');
                    router.push('/(auth)/email-login');
                  }}
                  hitSlop={10}
                  accessibilityRole="button"
                  style={styles.emailLoginLink}
                >
                  <Text v="strongS" tone="textSecondary">
                    ¿Prefieres entrar con tu correo?
                  </Text>
                </Pressable>
              </View>
            </Card>
          </Animated.View>
        </ScrollView>

        {/* High-Contrast Bottom Footer */}
        <Animated.View 
          entering={FadeInUp.delay(200).duration(400)} 
          style={[styles.footer, { borderTopColor: c.border, backgroundColor: c.background }]}
        >
          <Text v="bodyM" tone="textSecondary">¿Primera vez en Zipp?</Text>
          <Pressable
            onPress={() => {
              tap('light');
              router.push('/(auth)/register');
            }}
            hitSlop={12}
            accessibilityRole="button"
          >
            <Text v="strongM" tone="primaryText" style={styles.registerLink}>
              Crea tu cuenta
            </Text>
          </Pressable>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  glowContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glowOrbPrimary: {
    position: 'absolute',
    top: -80,
    right: -40,
    width: 220,
    height: 220,
    borderRadius: 110,
    opacity: 0.12,
  },
  glowOrbSecondary: {
    position: 'absolute',
    top: 40,
    left: -70,
    width: 200,
    height: 200,
    borderRadius: 100,
    opacity: 0.08,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xl,
    gap: Spacing.xl,
  },
  brand: {
    gap: Spacing.md,
    alignItems: 'flex-start',
  },
  logoWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  logoBackdrop: {
    padding: Spacing.xs,
    borderRadius: BorderRadius.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  greeting: {
    gap: Spacing.xs,
  },
  titleText: {
    letterSpacing: -0.8,
  },
  formCard: {
    width: '100%',
  },
  cardInner: {
    borderRadius: BorderRadius.xxl,
  },
  formFields: {
    gap: Spacing.lg,
  },
  forgotWrapper: {
    alignSelf: 'flex-end',
    marginTop: -Spacing.xs,
  },
  emailLoginLink: {
    alignSelf: 'center',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingVertical: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  registerLink: {
    textDecorationLine: 'underline',
  },
});
