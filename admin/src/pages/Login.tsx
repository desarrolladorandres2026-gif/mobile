import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, ArrowRight, Activity } from 'lucide-react';
import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

// Marca aproximada de Google Authenticator: anillo abierto con el punto de
// verificación. No es el asset oficial; sustituir por el SVG de Google si hay uno.
function AuthenticatorMark({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2a10 10 0 0 1 8.66 5L12 12z" fill="#EA4335" />
      <path d="M20.66 7A10 10 0 0 1 20.66 17L12 12z" fill="#FBBC04" />
      <path d="M20.66 17A10 10 0 0 1 3.34 17L12 12z" fill="#34A853" />
      <path d="M3.34 17A10 10 0 0 1 12 2v10z" fill="#4285F4" />
      <circle cx="12" cy="12" r="4.2" fill="var(--color-surface)" />
    </svg>
  );
}

const fieldClass =
  'w-full h-12 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-sm text-[var(--color-text-main)] placeholder:text-[var(--color-text-main)]/45 focus:border-[var(--color-primary)] outline-none transition-colors';
const buttonClass =
  'w-full h-12 rounded-md bg-[var(--color-text-main)] text-[var(--color-surface)] font-semibold text-sm tracking-wide transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2';

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
 <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text-main)] flex flex-col items-center px-6 select-none">
 <header className="w-full max-w-sm pt-14 flex items-baseline gap-3">
 <span className="text-xl font-black tracking-tight">zipp</span>
 <span className="text-[10px] font-semibold tracking-[0.3em] text-[var(--color-primary)]">ADMINISTRACIÓN</span>
 </header>

 <main className="w-full max-w-sm flex-1 flex flex-col justify-center py-12">
 <h1 className="text-2xl font-semibold tracking-tight">
 {challengeToken ? 'Verificación en dos pasos' : 'Acceso restringido'}
 </h1>
 <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-main)]/70">
 {challengeToken
 ? `${mfaName ? `${mfaName.split(' ')[0]}, tu` : 'Tu'} cuenta está protegida, por eso te pediremos el código de Google Authenticator.`
 : 'Solo personal autorizado. Toda actividad queda registrada.'}
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
 onClick={() => { setChallengeToken(''); setMfaCode(''); setMfaError(''); setPassword(''); }}
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
 <span className="text-[11px] font-semibold tracking-widest uppercase text-[var(--color-text-main)]/60">Correo</span>
 <input
 type="email"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 placeholder="nombre@zipp.co"
 className={fieldClass}
 autoComplete="email"
 required
 />
 </label>

 <label className="block">
 <span className="text-[11px] font-semibold tracking-widest uppercase text-[var(--color-text-main)]/60">Contraseña</span>
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
 <span>Autenticando...</span>
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
