import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PlainButton } from '../components/Button';
import { FormStatus, OtpField, TextField } from '../components/Form';
import { GoogleButton } from '../components/GoogleButton';
import { BUSINESS_URL } from '../lib/config';
import {
  acceptSession, authApi, needsSecondFactor, WrongRoleError,
  type AuthResponse, type SessionResult,
} from '../lib/authApi';
import { ApiError } from '../lib/http';
import { setPageMeta } from '../lib/meta';
import { PASSWORD_RULES, meetsPasswordRules } from '../lib/passwordRules';
import { safeNext } from '../lib/redirect';
import { isValidPhone } from '../lib/validate';
import { ME_KEY, useAuth } from '../lib/useAuth';

type Step = 'phone' | 'password' | 'mfa' | 'register-otp' | 'register-profile';

const PHONE_ERROR = 'Escribe un celular de 10 dígitos que empiece por 3.';

function message(error: unknown, fallback: string): string {
  if (error instanceof WrongRoleError) return error.message;
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * Entrada única: el celular decide entre iniciar sesión y registrarse, igual
 * que en la app. El registro confirma el celular con un código antes de pedir
 * nombre y contraseña.
 */
export default function Ingresar() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('volver'));
  const navigate = useNavigate();
  const passwordChanged = Boolean((useLocation().state as { passwordChanged?: boolean } | null)?.passwordChanged);
  const queryClient = useQueryClient();
  const { status } = useAuth();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPageMeta({ title: 'Ingresar | ZIPP', description: 'Entra o crea tu cuenta de ZIPP con tu celular.' });
  }, []);

  // Ya hay sesión (por ejemplo, otra pestaña la abrió): no hay nada que hacer aquí.
  useEffect(() => {
    if (status === 'authenticated') navigate(next, { replace: true });
  }, [status, next, navigate]);

  const finish = useCallback(async (result: AuthResponse) => {
    if (needsSecondFactor(result)) {
      if (!result.challengeToken) {
        setError('No pudimos iniciar la verificación en dos pasos. Intenta de nuevo.');
        return;
      }
      setChallenge(result.challengeToken);
      setStep('mfa');
      return;
    }
    const session: SessionResult = result;
    await acceptSession(session);
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    // Google no da celular: la cuenta queda a medias hasta que lo escriba (se completa en Mi cuenta).
    navigate(session.needsPhone ? '/cuenta?completar=1' : next, { replace: true });
  }, [navigate, next, queryClient]);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = useCallback((idToken: string, nonce: string) => {
    setBusy(true);
    setError(null);
    authApi.google(idToken, nonce)
      .then(finish)
      .catch((e) => setError(message(e, 'No pudimos entrar con Google. Intenta de nuevo.')))
      .finally(() => setBusy(false));
  }, [finish]);

  const submitPhone = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidPhone(phone)) { setError(PHONE_ERROR); return; }
    void run(async () => {
      const { exists } = await authApi.checkPhone(phone);
      if (exists) {
        setStep('password');
      } else {
        await authApi.registerSendOtp(phone);
        setStep('register-otp');
      }
    }, 'No pudimos continuar. Revisa tu conexión e inténtalo de nuevo.');
  };

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    if (!password) { setError('Escribe tu contraseña.'); return; }
    void run(async () => finish(await authApi.login(phone, password)), 'No pudimos iniciar sesión.');
  };

  const submitMfa = (e: FormEvent) => {
    e.preventDefault();
    if (mfaCode.trim().length < 6) { setError('Escribe el código de tu aplicación de verificación.'); return; }
    void run(async () => finish(await authApi.mfaChallenge(challenge, mfaCode.trim())), 'Código incorrecto.');
  };

  const submitRegisterOtp = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) { setError('Escribe los 6 dígitos del código.'); return; }
    void run(async () => {
      await authApi.registerVerifyOtp(phone, otp);
      setStep('register-profile');
    }, 'Código incorrecto.');
  };

  const submitRegister = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) { setError('Escribe tu nombre.'); return; }
    if (!meetsPasswordRules(password)) { setError('La contraseña no cumple todas las reglas de abajo.'); return; }
    void run(async () => {
      const session = await authApi.registerComplete({ phone, name: name.trim(), password });
      await finish(session);
    }, 'No pudimos crear tu cuenta.');
  };

  const back = () => { setStep('phone'); setError(null); setPassword(''); setOtp(''); };

  return (
    <div className="mx-auto max-w-md px-6 py-10 sm:px-10">
      <h1 className="text-2xl font-semibold text-text-main">
        {step === 'register-otp' || step === 'register-profile' ? 'Crea tu cuenta' : 'Ingresa a ZIPP'}
      </h1>

      {passwordChanged && step === 'phone' && (
        <p role="status" className="mt-4 text-base font-semibold text-text-main">
          Cambiaste tu contraseña. Por seguridad cerramos todas tus sesiones: entra de nuevo.
        </p>
      )}

      {step === 'phone' && (
        <form onSubmit={submitPhone} noValidate className="mt-6 flex flex-col gap-6">
          <p className="text-base text-text-secondary">
            Escribe tu celular. Si ya tienes cuenta, entras; si no, la creamos en un minuto.
          </p>
          <TextField
            label="Celular"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
          <FormStatus error={error} />
          <div><PlainButton type="submit" disabled={busy}>{busy ? 'Un momento…' : 'Continuar'}</PlainButton></div>
          <div className="border-t border-border pt-6">
            <p className="mb-3 text-sm text-text-secondary">O entra con</p>
            <GoogleButton onToken={onGoogle} />
          </div>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={submitLogin} noValidate className="mt-6 flex flex-col gap-6">
          <p className="text-base text-text-secondary">Celular {phone}</p>
          <TextField label="Contraseña" name="password" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <FormStatus error={error} />
          <div className="flex flex-wrap items-center gap-x-6">
            <PlainButton type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</PlainButton>
            <Link to={`/recuperar?celular=${phone}`} className="inline-flex min-h-11 items-center text-base font-semibold text-primary-text underline underline-offset-4">
              Olvidé mi contraseña
            </Link>
          </div>
          <button type="button" onClick={back} className="min-h-11 self-start text-base text-text-secondary underline underline-offset-4">Usar otro celular</button>
        </form>
      )}

      {step === 'mfa' && (
        <form onSubmit={submitMfa} noValidate className="mt-6 flex flex-col gap-6">
          <p className="text-base text-text-secondary">
            Tu cuenta tiene verificación en dos pasos. Escribe el código de tu aplicación o un código de recuperación.
          </p>
          <TextField label="Código" name="code" inputMode="text" autoComplete="one-time-code" maxLength={20} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoFocus />
          <FormStatus error={error} />
          <div><PlainButton type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Verificar'}</PlainButton></div>
        </form>
      )}

      {step === 'register-otp' && (
        <form onSubmit={submitRegisterOtp} noValidate className="mt-6 flex flex-col gap-6">
          <p className="text-base text-text-secondary">
            Te enviamos un código por WhatsApp al {phone}. Escríbelo para confirmar que el número es tuyo.
          </p>
          <OtpField
            code={otp}
            onCodeChange={setOtp}
            onSend={async () => { await authApi.registerSendOtp(phone); }}
          />
          <FormStatus error={error} />
          <div><PlainButton type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Confirmar'}</PlainButton></div>
          <button type="button" onClick={back} className="min-h-11 self-start text-base text-text-secondary underline underline-offset-4">Usar otro celular</button>
        </form>
      )}

      {step === 'register-profile' && (
        <form onSubmit={submitRegister} noValidate className="mt-6 flex flex-col gap-6">
          <TextField label="Tu nombre" name="name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <div>
            <TextField label="Crea una contraseña" name="new-password" type="password" autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            <ul className="mt-2 text-sm">
              {PASSWORD_RULES.map((r) => (
                <li key={r.label} className={r.test(password) ? 'text-ok' : 'text-text-secondary'}>
                  {r.test(password) ? 'Listo: ' : 'Falta: '}{r.label}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-text-secondary">
            Al crear tu cuenta aceptas los{' '}
            <Link to="/legal/terms" className="underline underline-offset-4">términos</Link> y la{' '}
            <Link to="/legal/privacy" className="underline underline-offset-4">política de privacidad</Link>.
          </p>
          <FormStatus error={error} />
          <div><PlainButton type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear cuenta'}</PlainButton></div>
        </form>
      )}

      <p className="mt-10 border-t border-border pt-6 text-sm text-text-secondary">
        ¿Tienes un comercio?{' '}
        <a href={BUSINESS_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Entra al portal de comercios</a>.
      </p>
    </div>
  );
}
