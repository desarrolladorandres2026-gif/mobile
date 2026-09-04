import { useState } from 'react';
import { StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Text, Input, Button, Notice, Screen } from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';
import { apiMessage, validatePhone } from '../../lib/errors';
import { tap } from '../../lib/haptics';

/**
 * Paso obligatorio tras entrar con Google por primera vez: Google no entrega
 * celular, y el resto de la app (entregas, OTP, soporte) asume que todo
 * usuario lo tiene. Se captura aquí y `otp.tsx` lo verifica a continuación.
 */
export default function CompleteProfileScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const { user, setUser, logout } = useAuthStore();

  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    const phoneError = validatePhone(phone);
    if (phoneError) {
      setError(phoneError);
      tap('error');
      return;
    }

    setError(undefined);
    setFormError('');
    setLoading(true);

    try {
      const updated = await authApi.updateProfile({ phone: phone.replace(/\D/g, '') });
      setUser(updated);
      tap('success');
      router.replace('/(auth)/otp');
    } catch (err) {
      setFormError(apiMessage(err, 'No pudimos guardar tu celular.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeInDown.duration(400)} style={styles.intro}>
            <Text v="displayL">¡Hola, {user?.name?.split(' ')[0] || ''}!</Text>
            <Text v="bodyL" tone="textSecondary">
              Nos falta tu celular para confirmar entregas y avisarte del pedido.
            </Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(90).duration(400)} style={styles.form}>
            <Input
              label="Número de Celular"
              icon="celular"
              prefix="+57"
              placeholder="300 000 0000"
              keyboardType="phone-pad"
              maxLength={10}
              value={phone}
              onChangeText={(t) => { setPhone(t); setError(undefined); }}
              error={error}
              hint="Te enviamos un código para confirmarlo."
              numeric
              autoComplete="tel"
              autoFocus
              onSubmitEditing={handleContinue}
              returnKeyType="go"
            />

            {formError ? <Notice tone="error">{formError}</Notice> : null}

            <Button
              title="Continuar"
              iconRight="adelante"
              size="lg"
              full
              loading={loading}
              onPress={handleContinue}
              haptic="medium"
            />

            <Text
              v="strongS"
              tone="textMuted"
              center
              onPress={() => { logout(); router.replace('/(auth)/login'); }}
            >
              Cancelar y salir
            </Text>
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
  form: { gap: Spacing.lg },
});
