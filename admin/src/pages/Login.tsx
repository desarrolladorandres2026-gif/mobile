import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, Mail, Lock, ShieldCheck, ArrowRight, Activity } from 'lucide-react';
import axios from 'axios';
import heroImage from '../assets/hero.webp';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(() =>
    new URLSearchParams(window.location.search).get('motivo') === 'inactividad'
      ? 'Cerramos tu sesión tras 30 minutos sin uso. Vuelve a ingresar.'
      : ''
  );

  // Segundo paso: solo aparece cuando la cuenta ya tiene 2FA activo. El
  // primer factor (contraseña) ya fue correcto; el backend devolvió un reto
  // en vez de la sesión (ver `completeLogin` en auth.service.ts).
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaName, setMfaName] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const [mfaError, setMfaError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    const userStr = localStorage.getItem('admin_user');
    if (token && userStr) {
      try {
        const user = JSON.parse(userStr);
        if (user.role === 'admin') {
          navigate('/');
        }
      } catch {
        localStorage.clear();
      }
    }
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Por favor completa todos los campos para ingresar.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
      const { data } = await axios.post(`${API_URL}/auth/login`, {
        email: email.trim().toLowerCase(),
        password,
      });

      if (data.data.requiresTOTP) {
        setChallengeToken(data.data.challengeToken);
        setMfaName(data.data.user?.name || '');
        setLoading(false);
        return;
      }

      const { user, accessToken, refreshToken, permissions, roleSlugs, authzMode, observedPermissions } = data.data;

      if (user.role !== 'admin') {
        setError('Acceso denegado: Esta cuenta no posee credenciales de administrador general.');
        setLoading(false);
        return;
      }

      localStorage.setItem('admin_token', accessToken);
      localStorage.setItem('admin_refresh_token', refreshToken);
      useAuthStore.getState().setSession(user, permissions || [], roleSlugs || [], { authzMode, observedPermissions });

      setLoading(false);
      navigate('/');
    } catch (err) {
      setLoading(false);
      setError(
        apiMessage(err, 'Credenciales incorrectas. Verifica tu correo y contraseña.')
      );
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mfaVerifying) return;
    if (!mfaCode.trim()) {
      setMfaError('Escribe el código de 6 dígitos de tu app autenticadora.');
      return;
    }

    setMfaVerifying(true);
    setMfaError('');

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
      const { data } = await axios.post(`${API_URL}/auth/2fa/challenge`, {
        challengeToken,
        code: mfaCode.trim(),
      });

      const { user, accessToken, refreshToken, permissions, roleSlugs, authzMode, observedPermissions } = data.data;

      if (user.role !== 'admin') {
        setMfaError('Acceso denegado: Esta cuenta no posee credenciales de administrador general.');
        setMfaVerifying(false);
        return;
      }

      localStorage.setItem('admin_token', accessToken);
      localStorage.setItem('admin_refresh_token', refreshToken);
      useAuthStore.getState().setSession(user, permissions || [], roleSlugs || [], { authzMode, observedPermissions });

      setMfaVerifying(false);
      navigate('/');
    } catch (err) {
      setMfaVerifying(false);
      setMfaError(apiMessage(err, 'Ese código no es correcto.'));
      setMfaCode('');
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] flex items-center justify-center select-none">
      <div className="w-full min-h-screen bg-[var(--color-surface)] overflow-hidden flex flex-col md:flex-row">
        {/* Left: Form panel */}
        <div className="w-full md:w-1/2 flex flex-col justify-center px-8 py-10 sm:px-12">
          <div className="flex flex-col items-center text-center mb-8">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              {challengeToken ? 'Verificación en dos pasos' : 'Bienvenido de nuevo'}
            </h1>
            <p className="text-sm text-slate-900 mt-1">
              {challengeToken
                ? `${mfaName ? `${mfaName.split(' ')[0]}, abre` : 'Abre'} tu app autenticadora y escribe el código de 6 dígitos.`
                : 'Ingresa tus credenciales administrativas.'}
            </p>
          </div>

          {challengeToken ? (
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={20}
                value={mfaCode}
                onChange={(e) => { setMfaCode(e.target.value); setMfaError(''); }}
                placeholder="Código de 6 dígitos o de recuperación"
                autoFocus
                className="w-full h-12 rounded-xl bg-slate-50 border border-slate-200 px-4 text-center text-lg font-bold tracking-[0.2em] text-slate-900 placeholder-slate-300 placeholder:text-xs placeholder:tracking-normal focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 outline-none transition-all"
              />

              {mfaError && (
                <p className="flex items-start gap-2 text-xs font-medium leading-relaxed text-rose-600">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {mfaError}
                </p>
              )}

              <button
                type="submit"
                disabled={mfaVerifying}
                className="w-full h-12 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-white font-bold text-sm transition-all duration-200 shadow-lg shadow-[var(--color-primary)]/25 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
              >
                {mfaVerifying ? (
                  <>
                    <Activity className="w-4 h-4 animate-spin" />
                    <span>Verificando...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Verificar</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => { setChallengeToken(''); setMfaCode(''); setMfaError(''); setPassword(''); }}
                className="w-full text-center text-xs font-semibold text-slate-900 hover:text-[var(--color-primary)] transition-colors cursor-pointer"
              >
                Volver a intentar con otra cuenta
              </button>
            </form>
          ) : (
            <>
              {error && (
                <p className="mb-5 flex items-start gap-2 text-xs font-medium leading-relaxed text-rose-600">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
                </p>
              )}

              <form onSubmit={handleLogin} className="space-y-4">
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-900 absolute left-4 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Correo del administrador"
                    className="w-full h-12 rounded-xl bg-slate-50 border border-slate-200 pl-11 pr-4 text-sm text-slate-900 placeholder-slate-400 focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 outline-none transition-all"
                    autoComplete="email"
                    required
                  />
                </div>

                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-900 absolute left-4 top-1/2 -translate-y-1/2" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Contraseña"
                    className="w-full h-12 rounded-xl bg-slate-50 border border-slate-200 pl-11 pr-11 text-sm text-slate-900 placeholder-slate-400 focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 outline-none transition-all"
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-900 hover:text-slate-900 transition-colors cursor-pointer"
                    title={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                <p className="flex items-center justify-between pt-1 text-xs text-slate-900">
                  <span>La sesión dura una jornada y se cierra tras 30 min sin uso.</span>
                  <span className="font-semibold text-[var(--color-primary)]">Requiere 2FA</span>
                </p>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-white font-bold text-sm transition-all duration-200 shadow-lg shadow-[var(--color-primary)]/25 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2 mt-2"
                >
                  {loading ? (
                    <>
                      <Activity className="w-4 h-4 animate-spin" />
                      <span>Autenticando...</span>
                    </>
                  ) : (
                    <>
                      <span>Ingresar a la Consola</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            </>
          )}

          <a
            href="https://github.com/twitter/twemoji"
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-3 text-center text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            Ilustraciones: Twemoji © Twitter, Inc. y colaboradores — CC-BY 4.0
          </a>
        </div>

        {/* Right: Brand image panel */}
        <div className="hidden md:block md:w-1/2 relative p-3">
          <div className="relative w-full h-full rounded-[24px] overflow-hidden">
            <img
              src={heroImage}
              alt="ZIPP"
              width={1024}
              height={1024}
              decoding="async"
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
            <div className="absolute bottom-6 left-6 right-6 text-white">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg font-black tracking-tight">zipp</span>
                <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-[var(--color-surface)]/15 border border-white/20 tracking-wider">
                  ADMIN
                </span>
              </div>
              <p className="text-xs text-white/80 max-w-xs">
                Consola central de operaciones y despachos en tiempo real.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
