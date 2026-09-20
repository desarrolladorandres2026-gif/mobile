import { useState } from 'react';
import { View, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, Icon, Input, Button, Notice, Screen, Header } from '../../components/ui';
import { useAuthStore } from '../../stores/authStore';
import { useCartStore } from '../../stores/cartStore';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { authApi } from '../../services/endpoints';
import { socketService } from '../../services/socket';
import { unregisterPush } from '../../hooks/usePushNotifications';
import { Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { PASSWORD_RULES, meetsPasswordRules } from '../../lib/passwordRules';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';

/**
 * Cambiar la contraseña desde dentro de la cuenta.
 *
 * El backend cierra **todas** las sesiones al cambiarla, esta incluida: es la
 * reacción de quien cree que le robaron la cuenta. Por eso se avisa antes y,
 * al terminar, se sale limpio al login en vez de dejar una sesión muerta que
 * fallaría en la siguiente petición.
 */
export default function ChangePasswordScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomInset = useBottomInset();
  const logout = useAuthStore((s) => s.logout);
  const clearCart = useCartStore((s) => s.clearCart);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const problems = {
      current: current ? undefined : 'Escribe tu contraseña actual',
      next: !meetsPasswordRules(next)
        ? 'Tu contraseña nueva aún no cumple todo lo de abajo'
        : next === current ? 'Tiene que ser distinta de la actual' : undefined,
      confirm: confirm !== next ? 'Las contraseñas no coinciden' : undefined,
    };
    if (problems.current || problems.next || problems.confirm) {
      setErrors(problems);
      tap('error');
      return;
    }

    setErrors({});
    setFormError('');
    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      tap('success');
      // El servidor ya revocó esta sesión: se limpia lo local y se vuelve a entrar.
      await unregisterPush().catch(() => {});
      socketService.disconnect();
      clearCart();
      await logout();
      router.replace('/(auth)/login');
    } catch (err) {
      setFormError(apiMessage(err, 'No pudimos cambiar tu contraseña.'));
      tap('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Header title="Cambiar contraseña" fallback={ROUTES.account} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Notice tone="info">
            Al cambiarla cerramos tu sesión en todos tus dispositivos, también en este. Vuelves a entrar con la nueva.
          </Notice>

          <Input
            label="Contraseña actual"
            icon="clave"
            password
            value={current}
            onChangeText={(t) => { setCurrent(t); setErrors((e) => ({ ...e, current: undefined })); }}
            error={errors.current}
            autoComplete="current-password"
          />

          <Input
            label="Contraseña nueva"
            icon="candado"
            password
            value={next}
            onChangeText={(t) => { setNext(t); setErrors((e) => ({ ...e, next: undefined })); }}
            error={errors.next}
            autoComplete="new-password"
          />

          <View style={styles.rules}>
            {PASSWORD_RULES.map((rule) => {
              const ok = rule.test(next);
              return (
                <View key={rule.label} style={styles.rule}>
                  <Icon name={ok ? 'checkCirculo' : 'info'} size={16} color={ok ? c.success : c.textMuted} />
                  <Text v="bodyS" color={ok ? c.text : c.textMuted}>{rule.label}</Text>
                </View>
              );
            })}
          </View>

          <Input
            label="Repite la contraseña nueva"
            icon="candado"
            password
            value={confirm}
            onChangeText={(t) => { setConfirm(t); setErrors((e) => ({ ...e, confirm: undefined })); }}
            error={errors.confirm}
            hint={confirm && confirm === next ? 'Coinciden' : undefined}
            hintTone="success"
            autoComplete="new-password"
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          {formError ? <Notice tone="error">{formError}</Notice> : null}

          <Button title="Cambiar contraseña" size="lg" full loading={saving} onPress={submit} haptic="medium" />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.lg },
  rules: { gap: 6, marginTop: -Spacing.xs },
  rule: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
});
