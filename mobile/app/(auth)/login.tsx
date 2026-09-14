import { useState, useEffect } from 'react';
import { View, Image, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  FadeInDown, SlideInRight, SlideInLeft, SlideOutLeft, SlideOutRight,
} from 'react-native-reanimated';
import {
  Text, Input, Button, GoogleButton, FacebookButton, Notice, OtpInput, Screen, Header,
} from '../../components/ui';
import { useBottomInset } from '../../hooks/useBottomSpace';
import { useAuthStore } from '../../stores/authStore';
import { authApi } from '../../services/endpoints';
import { useTheme } from '../../hooks/useTheme';
import { BorderRadius, Spacing } from '../../theme/tokens';
import { apiMessage, validateName, validatePhone, validatePassword } from '../../lib/errors';
import { scorePasswordStrength, PASSWORD_STRENGTH_LABEL } from '../../lib/passwordStrength';
import { tap } from '../../lib/haptics';
import { useGoogleAuth } from '../../lib/googleAuth';

type Step = 'chooser' | 'phone-input' | 'login-password' | 'otp' | 'name' | 'create-password';
type Errors = Partial<Record<'phone' | 'password' | 'name' | 'newPassword' | 'confirmPassword', string>>;

const RESEND_SECONDS = 60;
const REGISTER_STEPS: Step[] = ['otp', 'name', 'create-password'];
const PREVIOUS_STEP: Partial<Record<Step, Step>> = {
  'phone-input': 'chooser',
  'login-password': 'phone-input',
  otp: 'phone-input',
  name: 'otp',
  'create-password': 'name',
};

/**
 * Entrada única al estilo Rappi: la primera pantalla solo ofrece formas de
 * empezar (celular, Google, Facebook, correo) — el número se escribe recién
 * en el siguiente paso. Ya no hay una elección explícita entre "iniciar
 * sesión" y "crear cuenta": el celular decide el camino solo.
 *
 * `checkPhone` (endpoint de solo lectura) mira si el número ya tiene cuenta
 * y bifurca: existe → pide la contraseña; es nuevo → manda el OTP real y
 * sigue el registro.
 */
export default function LoginScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [step, setStep] = useState<Step>('chooser');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState('');
  const [countdown, setCountdown] = useState(RESEND_SECONDS);
  const [name, setName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const { signIn: googleSignIn, isConfigured: googleConfigured } = useGoogleAuth();

  const clear = (field: keyof Errors) => setErrors((e) => ({ ...e, [field]: undefined }));
  const cleanPhone = phone.replace(/\D/g, '');
  const passwordsMatch = confirmPassword.length > 0 && confirmPassword === newPassword;

  useEffect(() => {
    if (step !== 'otp' || countdown <= 0) return;
    const id = setInterval(() => setCountdown((n) => n - 1), 1000);
    return () => clearInterval(id);
  }, [step, countdown]);

  const goToStep = (next: Step, dir: 'forward' | 'back') => {
    tap('light');
    setDirection(dir);
    setFormError('');
    setStep(next);
  };

  const goBack = () => {
    const prev = PREVIOUS_STEP[step];
    if (prev) goToStep(prev, 'back');
  };

  const routeAfterAuth = (user: { role: string; isVerified: boolean }, needsPhone: boolean) => {
    if (needsPhone) router.replace('/(auth)/complete-profile');
    else if (!user.isVerified) router.replace('/(auth)/otp');
    else if (user.role === 'driver') router.replace('/(driver)/(tabs)/dashboard');
    else router.replace('/(client)/(tabs)/home');
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setFormError('');

    try {
      const idToken = await googleSignIn();
      if (!idToken) { setGoogleLoading(false); return; } // el usuario cerró el selector

      const data = await authApi.google(idToken);
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
  };

  /** Paso 1: el celular decide si esto es un login o un registro nuevo. */
  const checkPhone = async () => {
    const error = validatePhone(phone);
    if (error) { setErrors((e) => ({ ...e, phone: error })); tap('error'); return; }

    clear('phone');
    setLoading(true);

    try {
      const { exists } = await authApi.checkPhone(cleanPhone);

      if (exists) {
        setPassword('');
        goToStep('login-password', 'forward');
        return;
      }

      // Celular nuevo: manda el OTP real y sigue con la verificación.
      await authApi.registerSendOtp(cleanPhone);
      setOtpCode('');
      setOtpError('');
      setCountdown(RESEND_SECONDS);
      goToStep('otp', 'forward');
    } catch (error) {
      setErrors((e) => ({ ...e, phone: apiMessage(error, 'No pudimos continuar.') }));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    const error = validatePassword(password);
    if (error) { setErrors((e) => ({ ...e, password: error })); tap('error'); return; }

    clear('password');
    setFormError('');
    setLoading(true);

    try {
      const data = await authApi.login(cleanPhone, password);
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

  const verifyPhoneOtp = async (value: string) => {
    if (value.length !== 6 || loading) return;

    setOtpError('');
    setLoading(true);

    try {
      await authApi.registerVerifyOtp(cleanPhone, value);
      tap('success');
      goToStep('name', 'forward');
    } catch (error) {
      setOtpError(apiMessage(error, 'Ese código no es correcto.'));
      setOtpCode('');
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  const resendPhoneOtp = async () => {
    if (countdown > 0 || loading) return;

    setLoading(true);
    setOtpError('');

    try {
      await authApi.registerSendOtp(cleanPhone);
      setCountdown(RESEND_SECONDS);
      setOtpCode('');
      tap('light');
    } catch (error) {
      setOtpError(apiMessage(error, 'No pudimos reenviar el código.'));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    const passwordError = validatePassword(newPassword);
    const confirmError = confirmPassword !== newPassword ? 'Las contraseñas no coinciden' : undefined;

    if (passwordError || confirmError) {
      setErrors((e) => ({ ...e, newPassword: passwordError ?? undefined, confirmPassword: confirmError }));
      tap('error');
      return;
    }

    setErrors({});
    setFormError('');
    setLoading(true);

    try {
      const data = await authApi.registerComplete({
        phone: cleanPhone,
        name: name.trim(),
        password: newPassword,
      });
      const { user, accessToken, refreshToken } = data;
      await setAuth(user, accessToken, refreshToken);
      tap('success');

      // El celular ya quedó verificado en el paso anterior: directo a la app.
      router.replace('/(client)/(tabs)/home');
    } catch (error) {
      setFormError(apiMessage(error, 'No pudimos crear tu cuenta.'));
      tap('error');
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    if (step === 'phone-input') { checkPhone(); return; }
    if (step === 'login-password') { handleLogin(); return; }
    if (step === 'otp') { verifyPhoneOtp(otpCode); return; }

    if (step === 'name') {
      const error = validateName(name);
      if (error) { setErrors((e) => ({ ...e, name: error })); tap('error'); return; }
      clear('name');
      goToStep('create-password', 'forward');
      return;
    }

    handleRegister();
  };

  const enterAnim = direction === 'forward' ? SlideInRight.duration(260) : SlideInLeft.duration(260);
  const exitAnim = direction === 'forward' ? SlideOutLeft.duration(200) : SlideOutRight.duration(200);
  const progressIndex = REGISTER_STEPS.indexOf(step);

  return (
    <Screen>
      {step === 'chooser' ? (
        <>
          <Image
            source={require('../../assets/auth-map-bg.jpg')}
            style={styles.bgImage}
            resizeMode="cover"
          />
          <View style={styles.bgScrim} pointerEvents="none" />
        </>
      ) : null}

      {step !== 'chooser' ? <Header bare onBack={goBack} /> : null}

      {progressIndex >= 0 ? (
        <View style={styles.progress}>
          {REGISTER_STEPS.map((_, i) => (
            <ProgressBar key={i} filled={i <= progressIndex} />
          ))}
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, step === 'chooser' && styles.contentCentered]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View key={step} entering={enterAnim} exiting={exitAnim} style={styles.step}>
            {step === 'chooser' ? (
              <View style={styles.greeting}>
                <Text v="displayXL" center color="#FFFFFF" style={styles.titleText}>
                  Bienvenido
                </Text>
                <Text v="bodyM" center color="rgba(255,255,255,0.85)">
                  Entra a tu cuenta y disfruta de tus restaurantes y tiendas favoritas.
                </Text>
                {formError ? <Notice tone="error">{formError}</Notice> : null}
              </View>
            ) : null}

            {step === 'phone-input' ? (
              <>
                <View style={styles.intro}>
                  <Text v="displayL">¿Cuál es tu número de celular?</Text>
                  <Text v="bodyL" tone="textSecondary">
                    Te va a servir para entrar a tu cuenta y para que te ubiquemos.
                  </Text>
                </View>

                <Input
                  label="Número de Celular"
                  labelTone="text"
                  icon="celular"
                  prefix="+57"
                  placeholder="300 000 0000"
                  keyboardType="phone-pad"
                  maxLength={10}
                  value={phone}
                  onChangeText={(t) => { setPhone(t); clear('phone'); }}
                  error={errors.phone}
                  numeric
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  autoFocus
                  onSubmitEditing={handleContinue}
                  returnKeyType="next"
                />
              </>
            ) : null}

            {step === 'login-password' ? (
              <>
                <View style={styles.intro}>
                  <Text v="displayL">Ingresa tu contraseña</Text>
                  <Text v="bodyL" tone="textSecondary">
                    Para la cuenta de{' '}
                    <Text v="bodyL" tone="primaryText">+57 {phone}</Text>
                  </Text>
                </View>

                <Input
                  labelTone="text"
                  placeholderTone="text"
                  iconTone="text"
                  icon="candado"
                  placeholder="Ingresa tu contraseña"
                  password
                  value={password}
                  onChangeText={(t) => { setPassword(t); clear('password'); }}
                  error={errors.password}
                  autoComplete="current-password"
                  autoFocus
                  onSubmitEditing={handleContinue}
                  returnKeyType="go"
                />

                <Pressable
                  onPress={() => { tap('light'); router.push('/(auth)/forgot-password'); }}
                  hitSlop={10}
                  accessibilityRole="button"
                  style={styles.forgotWrapper}
                >
                  <Text v="strongS" tone="primaryText">¿Olvidaste tu contraseña?</Text>
                </Pressable>

                {formError ? <Notice tone="error">{formError}</Notice> : null}
              </>
            ) : null}

            {step === 'otp' ? (
              <>
                <View style={styles.intro}>
                  <Text v="displayL">Confirma tu celular</Text>
                  <Text v="bodyL" tone="textSecondary">
                    Te mandamos un código de 6 dígitos por WhatsApp al{' '}
                    <Text v="bodyL" tone="primaryText">+57 {phone}</Text>
                  </Text>
                </View>

                <OtpInput
                  value={otpCode}
                  onChange={(next) => {
                    setOtpCode(next);
                    setOtpError('');
                    if (next.length === 6) verifyPhoneOtp(next);
                  }}
                  error={!!otpError}
                  autoFocus
                />

                {otpError ? <Notice tone="error">{otpError}</Notice> : null}

                <View style={styles.resend}>
                  {countdown > 0 ? (
                    <Text v="bodyM" tone="textMuted">
                      Puedes pedir otro código en{' '}
                      <Text v="dataM" tone="textSecondary">{countdown}s</Text>
                    </Text>
                  ) : (
                    <Pressable onPress={resendPhoneOtp} hitSlop={10} accessibilityRole="button">
                      <Text v="strongM" tone="primaryText">Reenviar código</Text>
                    </Pressable>
                  )}
                </View>
              </>
            ) : null}

            {step === 'name' ? (
              <>
                <View style={styles.intro}>
                  <Text v="displayL">¿Cómo te llamas?</Text>
                  <Text v="bodyL" tone="textSecondary">
                    Así te vamos a saludar en la app.
                  </Text>
                </View>

                <Input
                  labelTone="text"
                  placeholderTone="text"
                  iconTone="text"
                  icon="perfil"
                  placeholder="Nombre y apellido"
                  value={name}
                  onChangeText={(t) => { setName(t); clear('name'); }}
                  error={errors.name}
                  autoCapitalize="words"
                  autoComplete="name"
                  autoFocus
                  onSubmitEditing={handleContinue}
                  returnKeyType="next"
                />
              </>
            ) : null}

            {step === 'create-password' ? (
              <>
                <View style={styles.intro}>
                  <Text v="displayL">Crea una contraseña</Text>
                  <Text v="bodyL" tone="textSecondary">
                    Mínimo 6 caracteres. Guárdala bien.
                  </Text>
                </View>

                <View style={styles.formFields}>
                  <View>
                    <Input
                      labelTone="text"
                      placeholderTone="text"
                      iconTone="text"
                      icon="candado"
                      placeholder="Mínimo 6 caracteres"
                      password
                      value={newPassword}
                      onChangeText={(t) => { setNewPassword(t); clear('newPassword'); }}
                      error={errors.newPassword}
                      autoComplete="new-password"
                      autoFocus
                    />
                    {!errors.newPassword && newPassword.length > 0 ? (
                      <PasswordStrengthMeter password={newPassword} />
                    ) : null}
                  </View>

                  <Input
                    labelTone="text"
                    placeholderTone="text"
                    iconTone="text"
                    icon="clave"
                    placeholder="Repite la contraseña"
                    password
                    value={confirmPassword}
                    onChangeText={(t) => { setConfirmPassword(t); clear('confirmPassword'); }}
                    error={errors.confirmPassword}
                    hint={passwordsMatch ? 'Coinciden' : undefined}
                    hintTone="success"
                    onSubmitEditing={handleContinue}
                    returnKeyType="go"
                  />
                </View>

                {formError ? <Notice tone="error">{formError}</Notice> : null}

                <Text v="caption" tone="textMuted" center style={styles.terms}>
                  Al crear tu cuenta aceptas los términos de servicio y la política de
                  tratamiento de datos de Zipp.
                </Text>
              </>
            ) : null}
          </Animated.View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: bottomInset + Spacing.md }]}>
          {step === 'chooser' ? (
            <View style={styles.choiceButtons}>
              <Button
                title="Continuar con tu número"
                icon="celular"
                size="lg"
                full
                onPress={() => goToStep('phone-input', 'forward')}
                haptic="medium"
              />

              <GoogleButton
                full
                loading={googleLoading}
                disabled={!googleConfigured}
                onPress={handleGoogleSignIn}
              />

              <FacebookButton full />
            </View>
          ) : (
            <Button
              title={
                step === 'phone-input' ? 'Continuar'
                  : step === 'login-password' ? 'Iniciar sesión'
                  : step === 'otp' ? 'Verificar'
                  : step === 'name' ? 'Continuar'
                  : 'Crear cuenta'
              }
              iconRight={step === 'phone-input' || step === 'name' ? 'adelante' : undefined}
              size="lg"
              full
              disabled={step === 'otp' && otpCode.length < 6}
              loading={loading}
              onPress={handleContinue}
              haptic="medium"
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ProgressBar({ filled }: { filled: boolean }) {
  const { c } = useTheme();
  return <View style={[styles.progressBar, { backgroundColor: filled ? c.primary : c.border }]} />;
}

/**
 * Barra de fortaleza de la contraseña.
 *
 * Puramente informativa: el mínimo real sigue siendo el de `validatePassword`
 * (6 caracteres). Esto solo anima a superarlo, con la misma lógica de
 * semáforo que ya usa el resto de la app (error → warning → success).
 */
function PasswordStrengthMeter({ password }: { password: string }) {
  const { c } = useTheme();
  const score = scorePasswordStrength(password);
  const tone = score <= 1 ? c.error : score === 2 ? c.warning : c.success;

  return (
    <View style={styles.strength}>
      <View style={styles.strengthBars}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[
              styles.strengthBar,
              { backgroundColor: i <= score ? tone : c.border },
            ]}
          />
        ))}
      </View>
      <Text v="caption" color={tone}>{PASSWORD_STRENGTH_LABEL[score]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  progress: {
    flexDirection: 'row',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.lg,
  },
  progressBar: { flex: 1, height: 4, borderRadius: BorderRadius.sm },
  bgImage: {
    ...StyleSheet.absoluteFillObject,
    // El pin queda naturalmente donde caen los botones de abajo; esto lo
    // sube al hueco libre entre el saludo y el pie de botones, y lo
    // recentra en horizontal (el recorte de "cover" lo dejaba corrido).
    transform: [{ translateY: -450 }, { translateX: -185 }],
  },
  bgScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8, 11, 17, 0.5)',
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  contentCentered: {
    justifyContent: 'flex-start',
    paddingTop: Spacing.huge,
  },
  step: { gap: Spacing.xxl },
  greeting: { gap: Spacing.lg, alignItems: 'center' },
  titleText: { letterSpacing: -0.8 },
  intro: { gap: Spacing.sm },
  formFields: { gap: Spacing.lg },
  forgotWrapper: {
    alignSelf: 'center',
    marginTop: -Spacing.xs,
  },
  resend: { alignItems: 'center' },
  strength: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  strengthBars: { flex: 1, flexDirection: 'row', gap: Spacing.xs },
  strengthBar: { flex: 1, height: 4, borderRadius: BorderRadius.sm },
  terms: { marginTop: Spacing.xs },
  footer: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
  },
  choiceButtons: { gap: Spacing.md },
});
