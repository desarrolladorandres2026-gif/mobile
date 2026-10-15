import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { AlertCircle, Activity, Eye, EyeOff } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { deviceHeaders, getDeviceId } from '../lib/deviceId';
import { useStartSession } from '../hooks/useStartSession';

const fieldClass =
  'w-full h-12 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-sm text-[var(--color-text-main)] placeholder:text-[var(--color-text-main)]/45 focus:border-[var(--color-primary)] outline-none transition-colors';
const buttonClass =
  'w-full h-12 rounded-md bg-[var(--color-text-main)] text-[var(--color-surface)] font-semibold text-sm tracking-wide transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2';
const linkClass =
  'text-xs font-semibold text-[var(--color-text-main)]/70 hover:text-[var(--color-primary)] transition-colors cursor-pointer';

type Step = 'phone' | 'reset' | 'totp';

/**
 * Recuperar la contraseña con el código que llega por WhatsApp.
 *
 * Mismo contrato que la app: `/auth/send-otp` y `/auth/reset-password`. El
 * servidor contesta igual exista o no el número, así que aquí tampoco se
 * insinúa si la cuenta existe: el aviso dice «si el número tiene cuenta».
 * Si la cuenta tiene 2FA, el restablecimiento pide además el código de
 * Google Authenticator.
 */
export default function ForgotPassword() {
  const startSession = useStartSession();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Sin interceptor, igual que el login: un 401 aquí no es una sesión vencida.
  const authUrl = (path: string) => `${api.defaults.baseURL}${path}`;

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!phone.trim()) {
      setError('Escribe el celular de tu cuenta.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await axios.post(authUrl('/auth/send-otp'), { phone: phone.trim() }, { headers: deviceHeaders() });
      setStep('reset');
    } catch (err) {
      setError(apiMessage(err, 'No pudimos enviar el código. Inténtalo de nuevo.'));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(otpCode.trim())) {
      setError('El código tiene 6 dígitos.');
      return;
    }
    if (step === 'totp' && !totp.trim()) {
      setError('Escribe el código de Google Authenticator.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data } = await axios.post(
        authUrl('/auth/reset-password'),
        {
          phone: phone.trim(),
          otpCode: otpCode.trim(),
          password,
          deviceId: getDeviceId(),
          ...(step === 'totp' ? { totpToken: totp.trim() } : {}),
        },
        { headers: deviceHeaders() }
      );
      if (data.data.requiresTOTP) {
        // La contraseña y el código ya son válidos: falta el segundo factor.
        setStep('totp');
        return;
      }
      if (!(await startSession(data.data))) {
        setError('Esta cuenta no está registrada como comercio.');
      }
    } catch (err) {
      setError(apiMessage(err, 'No pudimos restablecer la contraseña. Revisa el código.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text-main)] flex flex-col items-center px-6 select-none">
      <header className="w-full max-w-sm pt-14 flex items-baseline gap-3">
        <span className="text-xl font-black tracking-tight">zipp</span>
        <span className="text-[10px] font-semibold tracking-[0.3em] text-[var(--color-primary)]">COMERCIOS</span>
      </header>

      <main className="w-full max-w-sm flex-1 flex flex-col justify-center py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Recuperar contraseña</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-main)]/70">
          {step === 'phone'
            ? 'Escribe el celular de tu cuenta. Si tiene cuenta, te enviamos un código por WhatsApp.'
            : step === 'reset'
              ? 'Escribe el código que te llegó por WhatsApp y elige una contraseña nueva.'
              : 'Tu cuenta está protegida: escribe también el código de Google Authenticator.'}
        </p>
        <div className="mt-6 h-px bg-[var(--color-border)]" />

        {error && (
          <p role="alert" className="mt-6 flex items-start gap-2 text-xs font-medium leading-relaxed text-[var(--color-danger)]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </p>
        )}

        {step === 'phone' ? (
          <form onSubmit={sendCode} className="mt-8 space-y-6">
            <label className="block">
              <span className="text-[11px] font-semibold text-[var(--color-text-main)]/60">Celular</span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => { setPhone(e.target.value); setError(''); }}
                placeholder="3101234567"
                className={fieldClass}
                autoFocus
                required
              />
            </label>
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? <><Activity className="w-4 h-4 animate-spin" /><span>Enviando...</span></> : <span>Enviar código</span>}
            </button>
          </form>
        ) : (
          <form onSubmit={reset} className="mt-8 space-y-6">
            <label className="block">
              <span className="text-[11px] font-semibold text-[var(--color-text-main)]/60">Código de WhatsApp</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otpCode}
                onChange={(e) => { setOtpCode(e.target.value); setError(''); }}
                placeholder="000000"
                className={fieldClass + ' tracking-[0.3em] font-semibold'}
                disabled={step === 'totp'}
                autoFocus
                required
              />
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold text-[var(--color-text-main)]/60">Contraseña nueva</span>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  className={fieldClass + ' pr-8'}
                  autoComplete="new-password"
                  disabled={step === 'totp'}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-0 top-1/2 -translate-y-1/2 text-[var(--color-text-main)]/60 hover:text-[var(--color-text-main)] transition-colors cursor-pointer"
                  title={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </label>

            {step === 'totp' ? (
              <label className="block">
                <span className="text-[11px] font-semibold text-[var(--color-text-main)]/60">Google Authenticator</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={20}
                  value={totp}
                  onChange={(e) => { setTotp(e.target.value); setError(''); }}
                  placeholder="Código de 6 dígitos o de recuperación"
                  className={fieldClass + ' tracking-[0.2em] font-semibold placeholder:text-xs placeholder:tracking-normal placeholder:font-normal'}
                  autoFocus
                />
              </label>
            ) : null}

            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? <><Activity className="w-4 h-4 animate-spin" /><span>Verificando...</span></> : <span>Cambiar contraseña</span>}
            </button>

            {step === 'reset' ? (
              <button type="button" onClick={() => { setStep('phone'); setOtpCode(''); setError(''); }} className={linkClass}>
                Usar otro celular o pedir otro código
              </button>
            ) : null}
          </form>
        )}

        <Link to="/login" className={linkClass + ' mt-8 inline-block'}>
          Volver a iniciar sesión
        </Link>
      </main>
    </div>
  );
}
