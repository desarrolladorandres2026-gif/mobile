import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Check, AlertCircle, LogOut, Activity } from 'lucide-react';
import api from '../services/api';
import { apiErrorCode, apiMessage } from '../lib/apiError';
import { useAuthStore } from '../stores/authStore';
import AuthenticatorMark from '../components/AuthenticatorMark';

interface SetupData {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

/**
 * Activación del 2FA del comercio. Réplica de `admin/src/pages/TwoFactorSetup.tsx`.
 *
 * Se llega de dos formas: sola, porque con `TOTP_REQUIRED_BUSINESS`
 * encendido el backend responde 403 a todo lo demás y el interceptor de
 * `api.ts` trae aquí; o por voluntad propia desde Ajustes, antes de que el
 * flag se encienda.
 *
 * Primero pide la contraseña: el backend la exige para generar el QR en
 * cuentas de panel, porque una sesión olvidada en el PC del local no puede
 * bastar para registrar un autenticador ajeno y expulsar al dueño.
 */
export default function TwoFactorSetup() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const markTwoFactorEnabled = useAuthStore((s) => s.markTwoFactorEnabled);
  const [data, setData] = useState<SetupData | null>(null);
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  // `/2fa/setup` regenera el secreto en cada llamada e invalida el QR
  // anterior: solo se pide al confirmar la contraseña, no al abrir la
  // pantalla, así recargar no gasta intentos (tope de 10 por hora).
  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (unlocking) return;
    setUnlocking(true);
    setLoadError('');
    try {
      const { data: res } = await api.post('/auth/2fa/setup', { currentPassword: password });
      setData(res.data);
      setPassword('');
    } catch (err) {
      // Ya estaba activo (otra pestaña, o segunda visita): no hay nada
      // que configurar.
      if (apiErrorCode(err) === 'TWO_FACTOR_ALREADY_ENABLED') {
        markTwoFactorEnabled();
        navigate('/');
        return;
      }
      setLoadError(
        apiErrorCode(err) === 'REAUTH_INVALID'
          ? 'La contraseña no es correcta.'
          : apiMessage(err, 'No se pudo generar la configuración de la verificación en dos pasos.')
      );
    } finally {
      setUnlocking(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin acceso al portapapeles: la clave sigue visible en pantalla.
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifying) return;
    if (code.length !== 6) {
      setVerifyError('Escribe los 6 dígitos que muestra Google Authenticator.');
      return;
    }
    setVerifying(true);
    setVerifyError('');
    try {
      await api.post('/auth/2fa/verify', { token: code });
      markTwoFactorEnabled();
      // Recarga completa, no `navigate`: el socket de pedidos en vivo fue
      // rechazado mientras faltaba el 2FA y no reintenta solo.
      window.location.href = '/';
    } catch (err) {
      setVerifyError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
      setVerifying(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-text-main)] flex flex-col items-center px-6">
      <header className="w-full max-w-sm pt-14 flex items-baseline gap-3">
        <span className="text-xl font-black tracking-tight">zipp</span>
        <span className="text-[10px] font-semibold tracking-[0.3em] text-[var(--color-primary)]">COMERCIOS</span>
      </header>

      <main className="w-full max-w-sm flex-1 py-12">
        <div className="flex items-center gap-3">
          <AuthenticatorMark className="w-8 h-8 shrink-0" />
          <h1 className="text-2xl font-semibold tracking-tight">Verificación en dos pasos</h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-main)]/70">
          Protege tu panel: aunque alguien tenga tu contraseña, sin tu celular no entra.
          Instala Google Authenticator en tu celular antes de seguir.
        </p>
        <div className="mt-6 h-px bg-[var(--color-border)]" />

        {loadError && (
          <p className="mt-6 flex items-start gap-2 text-xs font-medium leading-relaxed text-rose-600">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {loadError}
          </p>
        )}

        {!data && (
          <form onSubmit={handleUnlock} className="mt-8 space-y-6">
            <label className="block">
              <span className="text-[11px] font-semibold tracking-widest uppercase text-[var(--color-text-main)]/60">
                Confirma tu contraseña
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setLoadError(''); }}
                placeholder="••••••••••"
                autoComplete="current-password"
                autoFocus
                className="w-full h-12 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-sm text-[var(--color-text-main)] placeholder:text-[var(--color-text-main)]/45 focus:border-[var(--color-primary)] outline-none transition-colors"
              />
            </label>
            <button
              type="submit"
              disabled={unlocking}
              className="w-full h-12 rounded-md bg-[var(--color-text-main)] text-[var(--color-surface)] font-semibold text-sm tracking-wide transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
            >
              {unlocking ? (
                <>
                  <Activity className="w-4 h-4 animate-spin" />
                  <span>Generando tu código...</span>
                </>
              ) : (
                <span>Continuar</span>
              )}
            </button>
          </form>
        )}

        {data && (
          <>
            <section className="mt-8">
              <p className="text-[11px] font-semibold tracking-widest uppercase text-[var(--color-text-main)]/60">
                1 · Escanea el código
              </p>
              <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-main)]/70">
                En Google Authenticator toca «+» y luego «Escanear un código QR».
              </p>
              <img src={data.qrCodeDataUrl} alt="Código QR para Google Authenticator" className="mt-4 w-44 h-44" />
              <p className="mt-3 text-xs text-[var(--color-text-main)]/70">¿No puedes escanear? Escribe esta clave:</p>
              <button
                type="button"
                onClick={handleCopy}
                className="mt-1 flex items-center gap-1.5 text-xs font-mono font-semibold text-[var(--color-primary)] hover:underline cursor-pointer break-all text-left"
              >
                {copied ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Copy className="w-3.5 h-3.5 shrink-0" />}
                {copied ? 'Copiada' : data.secret}
              </button>
            </section>

            <div className="mt-8 h-px bg-[var(--color-border)]" />

            <section className="mt-8">
              <p className="text-[11px] font-semibold tracking-widest uppercase text-[var(--color-text-main)]/60">
                2 · Guarda tus códigos de recuperación
              </p>
              <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-main)]/70">
                Anótalos en papel o guárdalos en un lugar seguro. Cada uno sirve una sola vez si pierdes el celular.
                No se vuelven a mostrar.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-sm">
                {data.recoveryCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            </section>

            <div className="mt-8 h-px bg-[var(--color-border)]" />

            <form onSubmit={handleVerify} className="mt-8 space-y-6">
              <label className="block">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-[var(--color-text-main)]/60">
                  3 · Escribe el código de 6 dígitos
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setVerifyError(''); }}
                  placeholder="000000"
                  className="w-full h-12 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-lg font-semibold tracking-[0.3em] text-[var(--color-text-main)] placeholder:text-[var(--color-text-main)]/30 focus:border-[var(--color-primary)] outline-none transition-colors"
                />
              </label>

              {verifyError && (
                <p className="flex items-start gap-2 text-xs font-medium leading-relaxed text-rose-600">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {verifyError}
                </p>
              )}

              <button
                type="submit"
                disabled={verifying}
                className="w-full h-12 rounded-md bg-[var(--color-text-main)] text-[var(--color-surface)] font-semibold text-sm tracking-wide transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
              >
                {verifying ? (
                  <>
                    <Activity className="w-4 h-4 animate-spin" />
                    <span>Verificando...</span>
                  </>
                ) : (
                  <span>Activar y continuar</span>
                )}
              </button>
            </form>
          </>
        )}

        <button
          type="button"
          onClick={handleLogout}
          className="mt-10 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-main)]/70 hover:text-rose-600 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Cerrar sesión
        </button>
      </main>
    </div>
  );
}
