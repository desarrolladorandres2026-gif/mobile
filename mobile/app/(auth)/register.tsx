import { useState } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Text, Input, Button, Notice, Screen, Header } from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { Spacing } from '../../theme/tokens';
import { apiMessage, validateName, validatePhone, validatePassword } from '../../lib/errors';
import { tap } from '../../lib/haptics';

type Errors = Partial<Record<'name' | 'phone' | 'password' | 'confirm', string>>;

export default function RegisterScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomInset = useBottomInset();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const clear = (field: keyof Errors) => setErrors((e) => ({ ...e, [field]: undefined }));

  const handleRegister = async () => {
    const next: Errors = {
      name: validateName(name) ?? undefined,
      phone: validatePhone(phone) ?? undefined,
      password: validatePassword(password) ?? undefined,
      confirm: confirm !== password ? 'Las contraseñas no coinciden' : undefined,
    };

    if (Object.values(next).some(Boolean)) {
      setErrors(next);
      tap('error');
      return;
    }

    setErrors({});
    setFormError('');
    setLoading(true);

    try {
      const data = await authApi.register({
        name: name.trim(),
        phone: phone.replace(/\D/g, ''),
        password,
        role: 'client',
      });
      const { user, accessToken, refreshToken } = data;
      await setAuth(user, accessToken, refreshToken);
      tap('success');

      router.replace(user.isVerified ? '/(client)/(tabs)/home' : '/(auth)/otp');
    } catch (error) {
      setFormError(apiMessage(error, 'No pudimos crear tu cuenta.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Header fallback="/(auth)/login" bare />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View entering={FadeInDown.duration(400)} style={styles.intro}>
            <Text v="displayL">Crea tu cuenta</Text>
            <Text v="bodyL" tone="textSecondary">
              Un minuto y ya estás pidiendo. Solo necesitamos tu nombre y tu celular.
            </Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(90).duration(400)} style={styles.form}>
            <Input
              label="¿Cómo te llamas?"
              icon="perfil"
              placeholder="Nombre y apellido"
              value={name}
              onChangeText={(t) => { setName(t); clear('name'); }}
              error={errors.name}
              autoCapitalize="words"
              autoComplete="name"
            />

            <Input
              label="Celular"
              icon="celular"
              prefix="+57"
              placeholder="300 000 0000"
              keyboardType="phone-pad"
              maxLength={10}
              value={phone}
              onChangeText={(t) => { setPhone(t); clear('phone'); }}
              error={errors.phone}
              hint="Te enviamos un código para confirmarlo."
              numeric
              autoComplete="tel"
            />

            <Input
              label="Contraseña"
              icon="candado"
              placeholder="Mínimo 6 caracteres"
              password
              value={password}
              onChangeText={(t) => { setPassword(t); clear('password'); }}
              error={errors.password}
              autoComplete="new-password"
            />

            <Input
              label="Repite la contraseña"
              icon="seguridad"
              placeholder="La misma de arriba"
              password
              value={confirm}
              onChangeText={(t) => { setConfirm(t); clear('confirm'); }}
              error={errors.confirm}
              onSubmitEditing={handleRegister}
              returnKeyType="go"
            />

            {formError ? <Notice tone="error">{formError}</Notice> : null}

            <Button
              title="Crear cuenta"
              size="lg"
              full
              loading={loading}
              onPress={handleRegister}
              haptic="medium"
            />

            <Text v="caption" tone="textMuted" center style={styles.terms}>
              Al crear tu cuenta aceptas los términos de servicio y la política de
              tratamiento de datos de Zipp.
            </Text>
          </Animated.View>
        </ScrollView>

        <View style={[styles.footer, { borderTopColor: c.border, paddingBottom: bottomInset + Spacing.sm }]}>
          <Text v="bodyM" tone="textSecondary">¿Ya tienes cuenta?</Text>
          <Pressable
            onPress={() => { tap('light'); router.replace('/(auth)/login'); }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text v="strongM" tone="primaryText">Entra aquí</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.huge,
    gap: Spacing.xxxl,
  },
  intro: { gap: Spacing.sm },
  form: { gap: Spacing.lg },
  terms: { marginTop: Spacing.xs },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    paddingVertical: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
