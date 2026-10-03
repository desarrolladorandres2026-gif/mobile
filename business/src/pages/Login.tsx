import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { AlertCircle, ArrowRight, Eye, EyeOff, Activity } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiErrorCode, apiMessage } from '../lib/apiError';
import AuthenticatorMark from '../components/AuthenticatorMark';
import { deviceHeaders, getDeviceId } from '../lib/deviceId';

const fieldClass =
  'w-full h-12 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-sm text-[var(--color-text-main)] placeholder:text-[var(--color-text-main)]/45 focus:border-[var(--color-primary)] outline-none transition-colors';
const buttonClass =
  'w-full h-12 rounded-md bg-[var(--color-text-main)] text-[var(--color-surface)] font-semibold text-sm tracking-wide transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2';

const NOT_A_BUSINESS = 'Acceso denegado: Esta cuenta no está registrada como dueño de comercio o negocio.';

interface SessionPayload {
  user: { _id: string; name: string; phone: string; role: string; twoFactorEnabled?: boolean };
  accessToken: string;
  refreshToken: string;
}

export default function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setBusinesses = useAuthStore((s) => s.setBusinesses);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Segundo paso: solo aparece cuando la cuenta ya tiene 2FA activo. La
  // contraseña ya fue correcta; el backend devolvió un reto en vez de la
  // sesión (ver `completeLogin` en auth.service.ts).
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaName, setMfaName] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [mfaError, setMfaError] = useState('');

  // Login y reto van por axios sin interceptor: un 401 de contraseña o de
  // código equivocado no es una sesión vencida, y el interceptor de `api`
  // lo trataba como tal — intentaba refrescar, fallaba y recargaba /login,
  // borrando el mensaje de error (y aquí, el reto a medio contestar).
  const authUrl = (path: string) => `${api.defaults.baseURL}${path}`;

  /** Abre la sesión y carga los locales. Devuelve false si la cuenta no es de comercio. */
  const startSession = async ({ user, accessToken, refreshToken }: SessionPayload): Promise<boolean> => {
    if (user.role !== 'business') return false;
    setAuth(user, accessToken, refreshToken);

    try {
      const resBus = await api.get('/businesses/my/businesses');
      setBusinesses(resBus.data.data);
    } catch (busErr) {
      // Sin 2FA y con `TOTP_REQUIRED_BUSINESS` encendido: el interceptor ya
      // está llevando a /setup-2fa; navegar a / aquí pelearía con él.
      if (apiErrorCode(busErr) === 'TWO_FACTOR_SETUP_REQUIRED') return true;
      console.error('No se pudieron cargar los establecimientos:', busErr);
    }

    navigate('/');
    return true;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Por favor completa todos los campos para continuar.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data } = await axios.post(
        authUrl('/auth/login'),
        { email: email.trim().toLowerCase(), password, deviceId: getDeviceId() },
        { headers: deviceHeaders() }
      );

      if (data.data.requiresTOTP) {
        setChallengeToken(data.data.challengeToken);
        setMfaName(data.data.user?.name || '');
        setLoading(false);
        return;
      }

      if (!(await startSession(data.data))) setError(NOT_A_BUSINESS);
      setLoading(false);
    } catch (err) {
      setLoading(false);
      setError(
        apiMessage(err, 'Error al iniciar sesión. Verifica el correo o la contraseña de tu comercio.')
      );
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mfaVerifying) return;
    if (!mfaCode.trim()) {
      setMfaError('Escribe el código de 6 dígitos de Google Authenticator.');
      return;
    }

    setMfaVerifying(true);
    setMfaError('');

    try {
      // El dispositivo viaja también en el segundo paso: es el que abre la
      // sesión, y sin él quedaba registrada como "no identificada".
      const { data } = await axios.post(
        authUrl('/auth/2fa/challenge'),
        { challengeToken, code: mfaCode.trim(), deviceId: getDeviceId() },
        { headers: deviceHeaders() }
      );
      if (!(await startSession(data.data))) setMfaError(NOT_A_BUSINESS);
      setMfaVerifying(false);
    } catch (err) {
      setMfaVerifying(false);
      setMfaError(apiMessage(err, 'Ese código no es correcto.'));
      setMfaCode('');
    }
  };

  const resetToPassword = () => {
    setChallengeToken('');
    setMfaCode('');
    setMfaError('');
    setPassword('');
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text-main)] flex flex-col items-center px-6 select-none">
      <header className="w-full max-w-sm pt-14 flex items-baseline gap-3">
        <span className="text-xl font-black tracking-tight">zipp</span>
        <span className="text-[10px] font-semibold tracking-[0.3em] text-[var(--color-primary)]">COMERCIOS</span>
      </header>

      <main className="w-full max-w-sm flex-1 flex flex-col justify-center py-12">
        <h1 className="text-2xl font-semibold tracking-tight">
          {challengeToken ? 'Verificación en dos pasos' : 'Acceso para comercios'}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-main)]/70">
          {challengeToken
            ? `${mfaName ? `${mfaName.split(' ')[0]}, tu` : 'Tu'} cuenta está protegida, por eso te pediremos el código de Google Authenticator.`
            : 'Ingresa con la cuenta registrada de tu negocio.'}
        </p>
        <div className="mt-6 h-px bg-[var(--color-border)]" />

        {challengeToken ? (
          <form onSubmit={handleMfaSubmit} className="mt-8 space-y-6">
            <div className="flex items-center gap-3">
              <AuthenticatorMark className="w-7 h-7 shrink-0" />
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={20}
                value={mfaCode}
                onChange={(e) => { setMfaCode(e.target.value); setMfaError(''); }}
                placeholder="Código de 6 dígitos o de recuperación"
                autoFocus
                className={fieldClass + ' text-lg font-semibold tracking-[0.2em] placeholder:text-xs placeholder:tracking-normal placeholder:font-normal'}
              />
            </div>

            {mfaError && (
              <p className="flex items-start gap-2 text-xs font-medium leading-relaxed text-rose-600">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {mfaError}
              </p>
            )}

            <button type="submit" disabled={mfaVerifying} className={buttonClass}>
              {mfaVerifying ? (
                <>
                  <Activity className="w-4 h-4 animate-spin" />
                  <span>Verificando...</span>
                </>
              ) : (
                <span>Verificar</span>
              )}
            </button>

            <button
              type="button"
              onClick={resetToPassword}
              className="text-xs font-semibold text-[var(--color-text-main)]/70 hover:text-[var(--color-primary)] transition-colors cursor-pointer"
            >
              Volver a intentar con otra cuenta
            </button>
          </form>
        ) : (
          <>
            {error && (
              <p className="mt-6 flex items-start gap-2 text-xs font-medium leading-relaxed text-rose-600">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
              </p>
            )}

            <form onSubmit={handleLogin} className="mt-8 space-y-6">
              <label className="block">
                <span className="text-[11px] font-semibold text-[var(--color-text-main)]/60">Correo</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="correo@tucomercio.co"
                  className={fieldClass}
                  autoComplete="email"
                  required
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-semibold text-[var(--color-text-main)]/60">Contraseña</span>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••"
                    className={fieldClass + ' pr-8'}
                    autoComplete="current-password"
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

              <button type="submit" disabled={loading} className={buttonClass}>
                {loading ? (
                  <>
                    <Activity className="w-4 h-4 animate-spin" />
                    <span>Accediendo...</span>
                  </>
                ) : (
                  <>
                    <span>Continuar</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          </>
        )}
      </main>

      <footer className="w-full max-w-sm pb-8">
        <div className="h-px bg-[var(--color-border)] mb-4" />
        <a
          href="https://github.com/twitter/twemoji"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[10px] text-[var(--color-text-main)]/50 hover:text-[var(--color-text-main)]"
        >
          Ilustraciones: Twemoji © Twitter, Inc. y colaboradores — CC-BY 4.0
        </a>
      </footer>
    </div>
  );
}
