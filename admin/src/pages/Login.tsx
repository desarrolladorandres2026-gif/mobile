import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

const fieldClass = 'field field-lg';
const buttonClass = 'btn btn-lg btn-primary w-full';

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
 <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text-main)] flex flex-col items-center justify-center p-4">
 <main className="w-full max-w-[360px] border border-[var(--dialog-border)] bg-[var(--color-surface)] rounded p-6">
 <p className="text-sm font-semibold">ZIPP Admin</p>
 <h1 className="mt-4 text-base font-semibold">
 {challengeToken ? 'Verificación en dos pasos' : 'Acceso restringido'}
 </h1>
 <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
 {challengeToken
 ? `${mfaName ? `${mfaName.split(' ')[0]}, tu` : 'Tu'} cuenta está protegida, por eso te pediremos el código de Google Authenticator.`
 : 'Solo personal autorizado. Toda actividad queda registrada.'}
 </p>

 {challengeToken ? (
 <form onSubmit={handleMfaSubmit} className="mt-4 space-y-3">
 <label className="block">
 <span className="field-label">Código</span>
 <input
 type="text"
 inputMode="numeric"
 autoComplete="one-time-code"
 maxLength={20}
 value={mfaCode}
 onChange={(e) => { setMfaCode(e.target.value); setMfaError(''); }}
 placeholder="Código de 6 dígitos o de recuperación"
 autoFocus
 className={fieldClass}
 />
 </label>

 {mfaError && <p className="field-error-msg">{mfaError}</p>}

 <button type="submit" disabled={mfaVerifying} className={buttonClass}>
 {mfaVerifying ? 'Verificando…' : 'Verificar'}
 </button>

 <button
 type="button"
 onClick={() => { setChallengeToken(''); setMfaCode(''); setMfaError(''); setPassword(''); }}
 className="btn btn-text"
 >
 Volver a intentar con otra cuenta
 </button>
 </form>
 ) : (
 <>
 {error && <p className="field-error-msg mt-3">{error}</p>}

 <form onSubmit={handleLogin} className="mt-4 space-y-3">
 <label className="block">
 <span className="field-label">Correo</span>
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
 <span className="field-label">Contraseña</span>
 <div className="flex gap-2">
 <input
 type={showPassword ? 'text' : 'password'}
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 className={fieldClass}
 autoComplete="current-password"
 required
 />
 <button
 type="button"
 onClick={() => setShowPassword(!showPassword)}
 className="btn btn-lg btn-secondary"
 >
 {showPassword ? 'Ocultar' : 'Mostrar'}
 </button>
 </div>
 </label>

 <button type="submit" disabled={loading} className={buttonClass}>
 {loading ? 'Autenticando…' : 'Continuar'}
 </button>
 </form>
 </>
 )}
 </main>

 <a
 href="https://github.com/twitter/twemoji"
 target="_blank"
 rel="noopener noreferrer"
 className="mt-4 text-xs text-[var(--color-text-secondary)] hover:underline"
 >
 Ilustraciones: Twemoji © Twitter, Inc. y colaboradores — CC-BY 4.0
 </a>
 </div>
 );
}
