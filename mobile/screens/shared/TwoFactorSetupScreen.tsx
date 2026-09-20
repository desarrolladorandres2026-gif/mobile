import { useState } from 'react';
import { View, ScrollView, StyleSheet, Image, Linking, Share, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, Icon, Input, Button, Notice, OtpInput, Screen, Header } from '../../components/ui';
import { useAuthStore } from '../../stores/authStore';
import { useTheme } from '../../hooks/useTheme';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { authApi, type TwoFactorSetup } from '../../services/endpoints';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';
import { ROUTES } from '../../lib/routing';

type Stage = 'intro' | 'setup' | 'codes';

/** `ABCD EFGH IJKL…`: una clave de 52 letras no se copia a mano de un tirón. */
const groupKey = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * Verificación en dos pasos (TOTP).
 *
 * En un teléfono el QR no sirve —no se escanea la pantalla del mismo
 * aparato—, así que lo primero es el enlace `otpauth://`, que abre la app
 * autenticadora con la cuenta ya cargada; luego la clave para escribirla; y
 * el QR queda al final, para quien la configure desde otro dispositivo.
 *
 * El login ya sabe pedir el segundo código (`app/(auth)/two-factor.tsx`):
 * sin eso, activar esto dejaba la cuenta sin forma de entrar.
 */
export default function TwoFactorSetupScreen() {
  const router = useRouter();
  const { c } = useTheme();
  const bottomInset = useBottomInset();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const enabled = !!user?.twoFactorEnabled;

  const [stage, setStage] = useState<Stage>('intro');
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setSetup(await authApi.setup2FA());
      setStage('setup');
      tap('light');
    } catch (err) {
      setError(apiMessage(err, 'No pudimos empezar la configuración.'));
      tap('error');
    } finally {
      setBusy(false);
    }
  };

  const openAuthenticator = () => {
    if (!setup?.otpauthUrl) return;
    Linking.openURL(setup.otpauthUrl).catch(() => {
      setInfo(
        'No encontramos una app autenticadora. Instala Google Authenticator o Microsoft Authenticator y vuelve aquí, o copia la clave.'
      );
    });
  };

  const shareText = (text: string) => {
    Share.share({ message: text }).catch(() => {});
  };

  const confirm = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    try {
      await authApi.verify2FA(value);
      if (user) setUser({ ...user, twoFactorEnabled: true });
      setStage('codes');
      setCode('');
      tap('success');
    } catch (err) {
      setError(apiMessage(err, 'Ese código no es correcto. Revisa que sea el de Zipp y que no haya cambiado.'));
      setCode('');
      tap('error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const clean = code.trim();
    if (clean.length < 6 || busy) {
      setError('Escribe el código de tu app o uno de recuperación.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await authApi.disable2FA(clean);
      if (user) setUser({ ...user, twoFactorEnabled: false });
      tap('success');
      router.back();
    } catch (err) {
      setError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
      tap('error');
    } finally {
      setBusy(false);
    }
  };

  // ── Ya activada: solo desactivar ──
  if (enabled && stage !== 'codes') {
    return (
      <Screen>
        <Header title="Verificación en dos pasos" fallback={ROUTES.account} />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
            keyboardShouldPersistTaps="handled"
          >
            <Notice tone="lime">Está activada. Cada vez que entres te pediremos el código de tu app autenticadora.</Notice>
            <Text v="bodyM" tone="textSecondary">
              Para desactivarla, escribe el código de 6 dígitos que muestra tu app ahora, o uno de tus códigos de
              recuperación.
            </Text>
            <Input
              label="Código"
              icon="candado"
              value={code}
              onChangeText={(t) => { setCode(t); setError(''); }}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            {error ? <Notice tone="error">{error}</Notice> : null}
            <Button title="Desactivar" variant="danger" size="lg" full loading={busy} onPress={disable} haptic="medium" />
          </ScrollView>
        </KeyboardAvoidingView>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Verificación en dos pasos" fallback={ROUTES.account} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          {stage === 'intro' ? (
            <>
              <Text v="titleL">Protege tu cuenta con un segundo código</Text>
              <Text v="bodyM" tone="textSecondary">
                Además de tu contraseña o del código de WhatsApp, te pediremos un código que cambia cada 30 segundos en
                una app autenticadora (Google Authenticator, Microsoft Authenticator u otra). Así, aunque alguien
                tenga tu contraseña o tu chip, no puede entrar.
              </Text>
              <Notice tone="info">
                Al activarla cerramos tu sesión en los demás dispositivos. Este sigue abierto.
              </Notice>
              {error ? <Notice tone="error">{error}</Notice> : null}
              <Button title="Activar" size="lg" full loading={busy} onPress={start} haptic="medium" />
            </>
          ) : null}

          {stage === 'setup' && setup ? (
            <>
              <Step n={1} title="Agrega Zipp a tu app autenticadora">
                {setup.otpauthUrl ? (
                  <Button title="Abrir app autenticadora" size="lg" full onPress={openAuthenticator} />
                ) : null}
                {info ? <Notice tone="warning">{info}</Notice> : null}

                <Text v="caption" tone="textMuted">O escribe esta clave a mano:</Text>
                <Pressable
                  onPress={() => shareText(setup.secret)}
                  accessibilityRole="button"
                  accessibilityLabel="Compartir la clave"
                  style={[styles.keyBox, { backgroundColor: c.surfaceLight, borderColor: c.border }]}
                >
                  <Text v="dataM" selectable style={styles.flex}>{groupKey(setup.secret)}</Text>
                  <Icon name="compartir" size="sm" color={c.primaryText} />
                </Pressable>

                <Text v="caption" tone="textMuted">¿La configuras en otro teléfono? Escanea este código:</Text>
                <View style={[styles.qr, { backgroundColor: '#FFFFFF' }]}>
                  <Image source={{ uri: setup.qrCodeDataUrl }} style={styles.qrImage} resizeMode="contain" />
                </View>
              </Step>

              <Step n={2} title="Escribe el código que te muestra">
                <OtpInput
                  value={code}
                  onChange={(next) => { setCode(next); setError(''); if (next.length === 6) confirm(next); }}
                  error={!!error}
                />
                {error ? <Notice tone="error">{error}</Notice> : null}
                <Button title="Activar" size="lg" full loading={busy} onPress={() => confirm(code)} haptic="medium" />
              </Step>
            </>
          ) : null}

          {stage === 'codes' && setup ? (
            <>
              <Notice tone="lime">Listo, la verificación en dos pasos quedó activada.</Notice>
              <Text v="titleM">Guarda tus códigos de recuperación</Text>
              <Text v="bodyM" tone="textSecondary">
                Si pierdes el teléfono o borras la app autenticadora, cada uno de estos códigos te deja entrar una
                vez. No los volveremos a mostrar.
              </Text>
              <View style={[styles.codes, { backgroundColor: c.surfaceLight, borderColor: c.border }]}>
                {setup.recoveryCodes.map((rc) => (
                  <Text key={rc} v="dataM" selectable style={styles.code}>{rc}</Text>
                ))}
              </View>
              <Button
                title="Guardar códigos"
                icon="compartir"
                variant="secondary"
                size="lg"
                full
                onPress={() => shareText(`Códigos de recuperación de Zipp:\n\n${setup.recoveryCodes.join('\n')}`)}
              />
              <Button title="Ya los guardé" size="lg" full onPress={() => router.back()} haptic="medium" />
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={styles.step}>
      <View style={styles.stepHead}>
        <View style={[styles.stepDot, { backgroundColor: c.primarySoft }]}>
          <Text v="captionStrong" tone="primaryText">{n}</Text>
        </View>
        <Text v="strongM" style={styles.flex}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.lg },
  step: { gap: Spacing.md },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  stepDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  keyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  qr: { alignSelf: 'center', padding: Spacing.sm, borderRadius: BorderRadius.md },
  qrImage: { width: 168, height: 168 },
  codes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    rowGap: Spacing.sm,
  },
  code: { width: '50%' },
});
