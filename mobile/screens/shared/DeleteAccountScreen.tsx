import { useState } from 'react';
import { View, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Text, Icon, Input, Button, Notice, OtpInput, Screen, Header, ConfirmDialog, SuccessCheck, Skeleton,
} from '../../components/ui';
import { useAuthStore } from '../../stores/authStore';
import { useCartStore } from '../../stores/cartStore';
import { useAccount } from '../../hooks/useApi';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { authApi } from '../../services/endpoints';
import { socketService } from '../../services/socket';
import { Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';
import { IS_DRIVER_APP } from '../../constants/variant';

/** Lo que de verdad hace `anonymizeAccount` en el backend; ni más ni menos. */
const WHAT_HAPPENS = [
  'Borramos tu nombre, celular, correo, foto, documento y fecha de nacimiento.',
  'Borramos tus direcciones y tus negocios favoritos.',
  'Pierdes tus cupones y códigos de invitación.',
  'Se cierra tu sesión en todos tus dispositivos y no podrás volver a entrar con esta cuenta.',
  'Tus pedidos pasados se conservan sin tus datos ni tu dirección exacta: la ley nos obliga a guardar el registro contable.',
];

/**
 * Eliminar la propia cuenta (App Store 5.1.1(v) y Google Play la exigen
 * dentro de la app).
 *
 * El backend pide reautenticarse: la contraseña si la cuenta tiene una, o un
 * código por WhatsApp si entró con Google o Apple. Y se niega mientras haya
 * un pedido en curso o, para un domiciliario, efectivo sin liquidar: ese
 * motivo se muestra tal cual, porque dice exactamente qué hacer.
 */
export default function DeleteAccountScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomInset = useBottomInset();
  const logout = useAuthStore((s) => s.logout);
  const clearCart = useCartStore((s) => s.clearCart);
  const { data: account, isPending } = useAccount();
  const hasPassword = account?.hasPassword;

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const readError = (err: unknown, fallback: string) => {
    if ((err as any)?.response?.data?.code === 'ACCOUNT_DELETION_BLOCKED') {
      setBlocked(apiMessage(err, fallback));
    } else {
      setError(apiMessage(err, fallback));
    }
    tap('error');
  };

  const sendCode = async () => {
    setBusy(true);
    setError('');
    setBlocked('');
    try {
      await authApi.requestDeletionOtp();
      setCodeSent(true);
      tap('light');
    } catch (err) {
      readError(err, 'No pudimos enviarte el código.');
    } finally {
      setBusy(false);
    }
  };

  const ask = () => {
    if (hasPassword && !password) { setError('Escribe tu contraseña para confirmar.'); tap('error'); return; }
    if (!hasPassword && code.length !== 6) { setError('Escribe el código de 6 dígitos.'); tap('error'); return; }
    setError('');
    tap('warning');
    setConfirming(true);
  };

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    setError('');
    setBlocked('');
    try {
      await authApi.deleteAccount(hasPassword ? { password } : { otpCode: code });
      tap('success');
      setDone(true);
      // La cuenta ya no existe en el servidor: solo queda limpiar este teléfono.
      socketService.disconnect();
      clearCart();
      await logout();
      setTimeout(() => router.replace('/(auth)/login'), 1800);
    } catch (err) {
      readError(err, 'No pudimos eliminar tu cuenta.');
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <View style={styles.done}>
          <SuccessCheck size={88} />
          <Text v="displayM" center>Tu cuenta fue eliminada</Text>
          <Text v="bodyL" tone="textSecondary" center>Gracias por haber usado Zipp.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Eliminar mi cuenta" fallback={ROUTES.account} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text v="titleL">Esto no se puede deshacer</Text>

          <View style={styles.list}>
            {WHAT_HAPPENS.map((line) => (
              <View key={line} style={styles.item}>
                <Icon name="info" size={16} color={c.textMuted} />
                <Text v="bodyM" tone="textSecondary" style={styles.flex}>{line}</Text>
              </View>
            ))}
            {IS_DRIVER_APP ? (
              <View style={styles.item}>
                <Icon name="info" size={16} color={c.textMuted} />
                <Text v="bodyM" tone="textSecondary" style={styles.flex}>
                  Dejas de recibir pedidos. Si tienes efectivo sin liquidar, primero hay que liquidarlo.
                </Text>
              </View>
            ) : null}
          </View>

          {blocked ? <Notice tone="warning">{blocked}</Notice> : null}

          {isPending ? (
            <Skeleton height={56} />
          ) : hasPassword ? (
            <Input
              label="Tu contraseña"
              icon="clave"
              password
              value={password}
              onChangeText={(t) => { setPassword(t); setError(''); }}
              autoComplete="current-password"
            />
          ) : codeSent ? (
            <>
              <Text v="bodyM" tone="textSecondary">
                Te mandamos un código por WhatsApp al celular de tu cuenta.
              </Text>
              <OtpInput value={code} onChange={(next) => { setCode(next); setError(''); }} error={!!error} />
            </>
          ) : (
            <Text v="bodyM" tone="textSecondary">
              Como entras con Google o Apple, confirmamos con un código por WhatsApp.
            </Text>
          )}

          {error ? <Notice tone="error">{error}</Notice> : null}

          {!isPending && !hasPassword && !codeSent ? (
            <Button title="Enviar código" size="lg" full loading={busy} onPress={sendCode} haptic="medium" />
          ) : (
            <Button
              title="Eliminar mi cuenta"
              variant="danger"
              size="lg"
              full
              loading={busy}
              onPress={ask}
              haptic="medium"
            />
          )}

          <Button title="Mejor no" variant="ghost" size="lg" full onPress={() => router.back()} />
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={remove}
        icon="eliminar"
        title="¿Eliminar tu cuenta?"
        message="Borramos tus datos ahora mismo y no hay forma de recuperarlos."
        confirmText="Eliminar"
        cancelText="Cancelar"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.lg },
  list: { gap: Spacing.sm },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.xxl },
});
