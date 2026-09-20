import { useState } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Text, Input, Button, Notice, OtpInput, Screen, Header } from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useFinishAuth, type AuthResponse } from '../../hooks/useFinishAuth';
import { authApi } from '../../services/endpoints';
import { Spacing } from '../../theme/tokens';
import { apiMessage } from '../../lib/errors';
import { tap } from '../../lib/haptics';

/**
 * Segundo paso de cualquier login en una cuenta con verificación en dos
 * pasos: el primer factor (contraseña, WhatsApp, Google, Apple) ya fue
 * correcto y el backend devolvió un reto en vez de la sesión.
 *
 * El reto caduca en minutos y no se guarda en ningún lado: si se vence, se
 * vuelve al login y se empieza de nuevo.
 */
export default function TwoFactorScreen() {
  const bottomInset = useBottomInset();
  const { challengeToken, name } = useLocalSearchParams<{ challengeToken?: string; name?: string }>();

  const [code, setCode] = useState('');
  /** El código de la app son 6 dígitos; uno de recuperación es texto libre. */
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const finishAuth = useFinishAuth(setError);

  const submit = async (value: string) => {
    const clean = value.trim();
    if (!challengeToken || verifying) return;
    if (!useRecovery && clean.length !== 6) return;
    if (useRecovery && clean.length < 6) {
      setError('Escribe el código de recuperación completo.');
      return;
    }

    setVerifying(true);
    setError('');
    try {
      const data: AuthResponse = await authApi.mfaChallenge(challengeToken, clean);
      await finishAuth(data);
    } catch (err) {
      setError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
      tap('error');
    } finally {
      setVerifying(false);
    }
  };

  const firstName = name?.split(' ')[0];

  return (
    <Screen>
      <Header fallback="/(auth)/login" bare />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + Spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View entering={FadeInDown.duration(400)} style={styles.intro}>
            <Text v="displayL">Verificación en dos pasos</Text>
            <Text v="bodyL" tone="textSecondary">
              {useRecovery
                ? 'Escribe uno de los códigos de recuperación que guardaste al activarla. Cada uno sirve una sola vez.'
                : `${firstName ? `${firstName}, abre` : 'Abre'} tu app autenticadora y escribe el código de 6 dígitos de Zipp.`}
            </Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(90).duration(400)} style={styles.form}>
            {!challengeToken ? (
              <Notice tone="error">
                Esta verificación ya no es válida. Vuelve a iniciar sesión.
              </Notice>
            ) : useRecovery ? (
              <Input
                label="Código de recuperación"
                icon="seguridad"
                value={code}
                onChangeText={(t) => { setCode(t); setError(''); }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                returnKeyType="go"
                onSubmitEditing={() => submit(code)}
              />
            ) : (
              <OtpInput
                value={code}
                onChange={(next) => {
                  setCode(next);
                  setError('');
                  if (next.length === 6) submit(next);
                }}
                error={!!error}
                autoFocus
              />
            )}

            {error ? <Notice tone="error">{error}</Notice> : null}

            <Button
              title="Verificar"
              size="lg"
              full
              loading={verifying}
              onPress={() => submit(code)}
              haptic="medium"
            />

            <View style={styles.switch}>
              <Pressable
                onPress={() => {
                  tap('light');
                  setUseRecovery((v) => !v);
                  setCode('');
                  setError('');
                }}
                hitSlop={10}
                accessibilityRole="button"
              >
                <Text v="strongM" tone="primaryText">
                  {useRecovery ? 'Usar el código de la app' : 'No tengo mi app: usar un código de recuperación'}
                </Text>
              </Pressable>
            </View>
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
  switch: { alignItems: 'center' },
});
