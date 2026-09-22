import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, Phone, Lock, ShieldCheck, ArrowRight, Activity } from 'lucide-react';
import axios from 'axios';
import { ZippMark } from '../components/ZippMark';
import heroImage from '../assets/hero.webp';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';

export default function Login() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
    if (!phone || !password) {
      setError('Por favor completa todos los campos para ingresar.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
      const { data } = await axios.post(`${API_URL}/auth/login`, {
        phone: phone.replace(/\D/g, ''),
        password,
      });

      const { user, accessToken, refreshToken, permissions, roleSlugs } = data.data;

      if (user.role !== 'admin') {
        setError('Acceso denegado: Esta cuenta no posee credenciales de administrador general.');
        setLoading(false);
        return;
      }

      localStorage.setItem('admin_token', accessToken);
      localStorage.setItem('admin_refresh_token', refreshToken);
      useAuthStore.getState().setSession(user, permissions || [], roleSlugs || []);

      setLoading(false);
      navigate('/');
    } catch (err) {
      setLoading(false);
      setError(
        apiMessage(err, 'Credenciales incorrectas. Verifica tu número de celular y contraseña.')
      );
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] flex items-center justify-center select-none">
      <div className="w-full min-h-screen bg-[var(--color-surface)] overflow-hidden flex flex-col md:flex-row">
        {/* Left: Form panel */}
        <div className="w-full md:w-1/2 flex flex-col justify-center px-8 py-10 sm:px-12">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-12 h-12 rounded-2xl bg-[var(--color-primary)]/10 flex items-center justify-center mb-4">
              <ZippMark size={30} />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              Bienvenido de nuevo
            </h1>
            <p className="text-sm text-slate-900 mt-1">
              Ingresa tus credenciales administrativas.
            </p>
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-600 text-xs p-3.5 rounded-xl flex items-start gap-2.5 mb-5">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <p className="flex-1 font-medium leading-relaxed">{error}</p>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-slate-900">
                <Phone className="w-4 h-4" />
                <span className="text-xs font-semibold text-slate-900 border-r border-slate-200 pr-2">+57</span>
              </div>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Celular del administrador"
                className="w-full h-12 rounded-xl bg-slate-50 border border-slate-200 pl-20 pr-4 text-sm text-slate-900 placeholder-slate-400 focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/15 outline-none transition-all"
                autoComplete="tel"
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

            <div className="flex items-center justify-between text-xs pt-1">
              <label className="flex items-center gap-2 text-slate-900 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-[var(--color-primary)] focus:ring-[var(--color-primary)]/30"
                />
                Recordar por 30 días
              </label>
              <span className="text-[var(--color-primary)] font-semibold hover:underline cursor-pointer">
                Requiere 2FA
              </span>
            </div>

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

          <div className="flex items-center justify-center gap-2 mt-8 text-[11px] text-slate-900">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Cifrado TLS 256-bit</span>
          </div>

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
