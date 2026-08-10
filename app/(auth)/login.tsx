import { useState } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Text, Input, Button, Notice } from '../../components/ui';
import { ZippMark } from '../../components/brand/ZippLogo';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';
import { apiMessage, validatePhone, validatePassword } from '../../lib/errors';
import { tap } from '../../lib/haptics';

export default function LoginScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ phone?: string; password?: string }>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    const phoneError = validatePhone(phone);
    const passwordError = validatePassword(password);

    // Los errores viven bajo su campo, no en un diálogo: así el usuario ve
    // cuál corregir sin tener que cerrar nada primero.
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
            ? 'Las cuentas de administrador entran por el panel web.'
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
      setFormError(apiMessage(error, 'No pudimos iniciar tu sesión.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View entering={FadeInDown.duration(400)} style={styles.brand}>
            <ZippMark size={52} />
            <View style={styles.greeting}>
              <Text v="displayL">Hola de nuevo</Text>
              <Text v="bodyL" tone="textSecondary">
                Entra y sigue pidiendo donde quedaste.
              </Text>
            </View>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(90).duration(400)} style={styles.form}>
            <Input
              label="Celular"
              icon="celular"
              prefix="+57"
              placeholder="300 000 0000"
              keyboardType="phone-pad"
              maxLength={10}
              value={phone}
              onChangeText={(t) => { setPhone(t); setErrors((e) => ({ ...e, phone: undefined })); }}
              error={errors.phone}
              numeric
              autoComplete="tel"
              textContentType="telephoneNumber"
            />

            <Input
              label="Contraseña"
              icon="candado"
              placeholder="Tu contraseña"
              password
              value={password}
              onChangeText={(t) => { setPassword(t); setErrors((e) => ({ ...e, password: undefined })); }}
              error={errors.password}
              autoComplete="current-password"
              onSubmitEditing={handleLogin}
              returnKeyType="go"
            />

            <Pressable
              onPress={() => { tap('light'); router.push('/(auth)/forgot-password'); }}
              style={styles.forgot}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text v="strongS" tone="primaryText">¿Olvidaste tu contraseña?</Text>
            </Pressable>

            {formError ? <Notice tone="error">{formError}</Notice> : null}

            <Button
              title="Entrar"
              size="lg"
              full
              loading={loading}
              onPress={handleLogin}
              haptic="medium"
            />
          </Animated.View>
        </ScrollView>

        <View style={[styles.footer, { borderTopColor: c.border }]}>
          <Text v="bodyM" tone="textSecondary">¿Primera vez en Zipp?</Text>
          <Pressable
            onPress={() => { tap('light'); router.push('/(auth)/register'); }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text v="strongM" tone="primaryText">Crea tu cuenta</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.huge,
    gap: Spacing.huge,
  },
  brand: { gap: Spacing.xl },
  greeting: { gap: Spacing.sm },
  form: { gap: Spacing.lg },
  forgot: { alignSelf: 'flex-end', marginTop: -Spacing.xs },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingVertical: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
