import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Copy, Check, AlertCircle, LogOut } from 'lucide-react';
import api from '../services/api';
import { apiMessage } from '../lib/apiError';
import { useAuthStore } from '../stores/authStore';

interface SetupData {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

/**
 * Activación obligatoria de 2FA para cuentas admin.
 *
 * `TOTP_REQUIRED_ADMINS` bloquea con 403 cualquier ruta del panel —salvo
 * `/auth/me`, logout y estas dos de aquí— hasta que la cuenta tenga 2FA. El
 * interceptor de `api.ts` manda a cualquier admin sin activar directo a esta
 * pantalla la primera vez que lo detecta, así que llega aquí sin haber
 * podido ver ninguna otra página.
 */
export default function TwoFactorSetup() {
  const navigate = useNavigate();
  const { clear } = useAuthStore();
  const [data, setData] = useState<SetupData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  // `/2fa/setup` regenera el secreto en cada llamada e invalida el QR
  // anterior, y comparte un límite de 5 por hora con el resto de
  // operaciones sensibles. El StrictMode de main.tsx invoca los efectos dos
  // veces en desarrollo: sin esta guarda, cargar esta pantalla una sola vez
  // ya gastaba 2 de esos 5 antes de que el admin hiciera nada.
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    const run = async () => {
      try {
        const { data: res } = await api.post('/auth/2fa/setup');
        setData(res.data);
      } catch (err) {
        // Ya estaba activado (otra pestaña, o segunda visita): no hay nada
        // que configurar, así que no tiene sentido dejar al admin varado
        // aquí. Cualquier otro error sí se muestra.
        if (apiMessage(err).includes('ya está habilitado')) {
          navigate('/');
          return;
        }
        setLoadError(apiMessage(err, 'No se pudo generar la configuración de 2FA.'));
      }
    };
    run();
  }, [navigate]);

  const handleCopy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin acceso al portapapeles: el secreto sigue visible en pantalla.
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length !== 6 || verifying) return;
    setVerifying(true);
    setVerifyError('');
    try {
      await api.post('/auth/2fa/verify', { token: code.trim() });
      navigate('/');
    } catch (err) {
      setVerifyError(apiMessage(err, 'Ese código no es correcto.'));
      setCode('');
    } finally {
      setVerifying(false);
    }
  };

  const handleLogout = () => {
    clear();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Activa la verificación en dos pasos
          </h1>
          <p className="text-sm text-slate-900 mt-1">
            Es obligatoria para las cuentas de administrador. Tu sesión no avanza hasta activarla.
          </p>
        </div>

        {loadError && (
          <div className="flex items-start gap-2.5 mb-6">
            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <p className="flex-1 text-xs font-medium text-rose-600 leading-relaxed">{loadError}</p>
          </div>
        )}

        {data && (
          <div className="space-y-6">
            <div className="flex flex-col items-center gap-3">
              <img
                src={data.qrCodeDataUrl}
                alt="Código QR para configurar 2FA"
                className="w-40 h-40"
              />
              <p className="text-xs text-slate-900 text-center">
                Escanéalo con tu app autenticadora (Google Authenticator, Authy, 1Password…).
              </p>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1.5 text-xs font-mono font-semibold text-[var(--color-primary)] hover:underline cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copiado' : data.secret}
              </button>
            </div>

            <div className="border-t border-slate-200 pt-5">
              <p className="text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-2">
                Códigos de recuperación
              </p>
              <p className="text-xs text-slate-900 mb-3">
                Guárdalos en un lugar seguro. Cada uno sirve una sola vez, si pierdes el celular.
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs text-slate-900">
                {data.recoveryCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            </div>

            <form onSubmit={handleVerify} className="border-t border-slate-200 pt-5 space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1.5">
                  Código de 6 dígitos
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setVerifyError(''); }}
                  placeholder="000000"
                  autoFocus
                  className="w-full h-12 rounded-xl bg-slate-50 border border-slate-200 px-4 text-center text-lg font-bold tracking-[0.3em] text-slate-900 placeholder-slate-300 focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 outline-none transition-all"
                />
              </div>

              {verifyError && (
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                  <p className="flex-1 text-xs font-medium text-rose-600 leading-relaxed">{verifyError}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={code.length !== 6 || verifying}
                className="w-full h-12 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-chart-purple)] text-white font-bold text-sm transition-all duration-200 shadow-lg shadow-[var(--color-primary)]/25 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
              >
                <ShieldCheck className="w-4 h-4" />
                {verifying ? 'Verificando...' : 'Activar y continuar'}
              </button>
            </form>
          </div>
        )}

        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-1.5 mt-8 text-xs font-semibold text-slate-900 hover:text-rose-600 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
