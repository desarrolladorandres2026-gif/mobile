import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowLeft, KeyRound, LogIn, Undo2, X } from 'lucide-react';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiMessage } from '../lib/apiError';
import { endSession } from '../lib/session';
import { qk } from '../lib/queryKeys';
import { ROLE_LABELS, type BusinessRole } from '../lib/permissions';
import {
  elevatedIdle, enterElevated, isElevated, restoreCounter, sessionKind, touchElevated,
} from '../lib/counter';

/**
 * Botón de la esquina inferior derecha (decisión 2026-10-13).
 *
 * En el mostrador abre la entrada del administrador o del representante
 * legal: se elige la persona y se escribe su PIN. Quien aún no tiene PIN
 * entra con su contraseña (y su 2FA) para poder crearlo: sin esa salida, un
 * dueño recién llegado quedaría encerrado en el mostrador, porque crear el
 * PIN exige una sesión completa.
 *
 * Ya dentro como responsable, el mismo sitio dice "Volver al mostrador".
 * Tras 15 min sin tocar teclado ni puntero se vuelve solo: el equipo es
 * compartido y el siguiente que lo use no debe heredar el dinero.
 */

interface CounterPerson {
  userId: string;
  name: string;
  role: BusinessRole;
}

interface SessionPayload {
  user: { _id: string; name: string; role: string };
  accessToken: string;
  refreshToken: string;
}

const fieldClass =
  'w-full h-11 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-sm text-[var(--color-text-main)] focus:border-[var(--color-primary)] outline-none transition-colors';
const primaryClass =
  'w-full h-10 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] disabled:opacity-50 disabled:cursor-wait cursor-pointer flex items-center justify-center gap-2';
const linkClass =
  'text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] cursor-pointer';

/** Cambia de identidad con una recarga: nada en caché ni en el socket sobrevive. */
function reloadHome() {
  window.location.href = '/';
}

export default function CounterSwitch() {
  const kind = sessionKind();
  if (kind === 'counter') return <ElevateButton />;
  if (kind === 'elevated-pin' || kind === 'elevated-password') return <BackToCounter />;
  return null;
}

// ── Ya dentro como responsable ─────────────────────────────────────────

function BackToCounter() {
  const user = useAuthStore((s) => s.user);
  const [leaving, setLeaving] = useState(false);

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      // Las dos entradas (PIN y contraseña) nacen con `elevatedFrom`, así
      // que `drop` cierra cualquiera. Si falla (sin red) igual se baja aquí:
      // el servidor la cierra sola a los 15 min sin uso.
      await api.post('/auth/counter/drop', {});
    } catch {
      /* se baja igual */
    }
    if (restoreCounter()) reloadHome();
    else endSession();
  };

  useEffect(() => {
    // Se abrió el panel tras un rato sin nadie (PC que pasó la noche con la
    // entrada abierta): se baja en cuanto monta, fuera del render del efecto.
    if (elevatedIdle()) {
      const t = setTimeout(() => void leave(), 0);
      return () => clearTimeout(t);
    }
    const onUse = () => touchElevated();
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, onUse, { passive: true }));
    const timer = setInterval(() => {
      if (isElevated() && elevatedIdle()) void leave();
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onUse));
      clearInterval(timer);
    };
    // `leave` cambia en cada render; el temporizador solo necesita montarse una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      type="button"
      onClick={leave}
      disabled={leaving}
      title="Cerrar tu entrada y dejar el equipo en el mostrador"
      className="fixed bottom-4 right-4 z-40 h-10 px-4 rounded-full border border-[var(--color-primary)] bg-[var(--color-surface)] text-[var(--color-text-main)] text-xs font-semibold shadow-md hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:cursor-wait flex items-center gap-2"
    >
      {leaving ? <Activity className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4 text-[var(--color-primary)]" />}
      <span>Volver al mostrador</span>
      {user?.name && <span className="hidden sm:inline font-normal text-[var(--color-text-secondary)]">· {user.name.split(' ')[0]}</span>}
    </button>
  );
}

// ── En el mostrador ────────────────────────────────────────────────────

type Step =
  | { name: 'people' }
  | { name: 'pin'; person: CounterPerson }
  | { name: 'password' }
  | { name: 'totp'; challengeToken: string };

function ElevateButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Entrar como administrador o representante legal"
        aria-label="Entrar como administrador o representante legal"
        className="fixed bottom-4 right-4 z-40 h-10 w-10 rounded-full bg-[var(--color-text-main)] text-[var(--color-surface)] shadow-md hover:opacity-90 cursor-pointer flex items-center justify-center"
      >
        <KeyRound className="w-4 h-4 text-[var(--color-primary)]" />
      </button>
      {open && <ElevateDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ElevateDialog({ onClose }: { onClose: () => void }) {
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const [step, setStep] = useState<Step>({ name: 'people' });
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const people = useQuery({
    queryKey: qk.counterPeople(businessId),
    enabled: !!businessId,
    staleTime: 0,
    queryFn: async () =>
      ((await api.get('/auth/counter/people', { params: { businessId } })).data.data ?? []) as CounterPerson[],
  });

  const go = (next: Step) => {
    setError('');
    setPin('');
    setCode('');
    setStep(next);
  };

  const finish = (via: 'elevated-pin' | 'elevated-password', session: SessionPayload) => {
    if (session.user?.role !== 'business') {
      setError('Esa cuenta no es de un comercio.');
      return;
    }
    enterElevated(via, session);
    reloadHome();
  };

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.name !== 'pin' || busy || !businessId || !/^\d{6}$/.test(pin)) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/auth/counter/elevate', { businessId, userId: step.person.userId, pin });
      finish('elevated-pin', data.data);
    } catch (err) {
      setPin('');
      setError(apiMessage(err, 'No se pudo comprobar el PIN.'));
    } finally {
      setBusy(false);
    }
  };

  // `/auth/counter/elevate-password` (no `/auth/login`, 2026-10-13): sobre la
  // sesión del mostrador, nunca abre una sesión completa de 7 días — ver
  // `lib/counter.ts`.
  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !businessId || !email || !password) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/auth/counter/elevate-password', {
        businessId, email: email.trim().toLowerCase(), password,
      });
      setPassword('');
      if (data.data.requiresTOTP) go({ name: 'totp', challengeToken: data.data.challengeToken });
      else finish('elevated-password', data.data);
    } catch (err) {
      setPassword('');
      setError(apiMessage(err, 'Correo o contraseña incorrectos.'));
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.name !== 'totp' || busy || !businessId || !code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/auth/counter/elevate-password/totp', {
        businessId, challengeToken: step.challengeToken, code: code.trim(),
      });
      finish('elevated-password', data.data);
    } catch (err) {
      setCode('');
      setError(apiMessage(err, 'Ese código no es correcto.'));
    } finally {
      setBusy(false);
    }
  };

  const title =
    step.name === 'pin' ? step.person.name
      : step.name === 'password' ? 'Entrar con contraseña'
        : step.name === 'totp' ? 'Verificación en dos pasos'
          : '¿Quién entra?';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="Cerrar" onClick={onClose} className="absolute inset-0 bg-black/50 cursor-default" />
      <div role="dialog" aria-label={title} className="relative w-full max-w-sm zipp-modal">
        <div className="p-5 space-y-5">
          <div className="flex items-start gap-3">
            {step.name !== 'people' && (
              <button
                type="button"
                aria-label="Atrás"
                onClick={() => go(step.name === 'totp' ? { name: 'password' } : { name: 'people' })}
                className="p-1 -ml-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--color-text-main)] truncate">{title}</h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                {step.name === 'pin'
                  ? `${ROLE_LABELS[step.person.role]}. Escribe tu PIN de 6 dígitos.`
                  : step.name === 'password'
                    ? 'Para crear tu PIN o cambiar la seguridad de tu cuenta, que con PIN no se puede.'
                    : step.name === 'totp'
                      ? 'Escribe el código de Google Authenticator.'
                      : 'Administrador o representante legal. Lo que hagas queda a tu nombre.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)] hover:bg-[var(--color-surface-hover)] cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {step.name === 'people' && (
            <div className="space-y-4">
              {people.isLoading ? (
                <p className="text-xs text-[var(--color-text-secondary)]">Cargando…</p>
              ) : people.isError ? (
                <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">
                  {apiMessage(people.error, 'No pudimos cargar quién puede entrar.')}
                </p>
              ) : people.data && people.data.length > 0 ? (
                <ul className="divide-y divide-[var(--color-border)]">
                  {people.data.map((person) => (
                    <li key={person.userId}>
                      <button
                        type="button"
                        onClick={() => go({ name: 'pin', person })}
                        className="w-full flex items-center justify-between gap-3 py-3 text-left hover:text-[var(--color-primary)] cursor-pointer"
                      >
                        <span className="text-sm font-medium text-[var(--color-text-main)] truncate">{person.name}</span>
                        <span className="text-xs text-[var(--color-text-secondary)] shrink-0">{ROLE_LABELS[person.role]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[var(--color-text-main)] leading-relaxed">
                  Nadie de este negocio tiene PIN todavía. Entra con tu contraseña y créalo en Seguridad.
                </p>
              )}
              <button type="button" onClick={() => go({ name: 'password' })} className={`${linkClass} flex items-center gap-1.5`}>
                <LogIn className="w-3.5 h-3.5" /> Entrar con contraseña
              </button>
            </div>
          )}

          {step.name === 'pin' && (
            <form onSubmit={submitPin} className="space-y-5">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                placeholder="••••••"
                autoFocus
                aria-label="PIN de 6 dígitos"
                className={`${fieldClass} text-center text-lg font-semibold tracking-[0.5em]`}
              />
              {error && <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
              {/* No se deshabilita por PIN incompleto: el envío lo ignora y el
                  campo ya dice cuántos faltan. Solo espera mientras comprueba. */}
              <button type="submit" disabled={busy} className={primaryClass}>
                {busy ? <><Activity className="w-4 h-4 animate-spin" /> Comprobando…</> : 'Entrar'}
              </button>
            </form>
          )}

          {step.name === 'password' && (
            <form onSubmit={submitPassword} className="space-y-5">
              <label className="block">
                <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">Correo</span>
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus className={fieldClass} required />
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">Contraseña</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldClass} required />
              </label>
              {error && <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
              <button type="submit" disabled={busy} className={primaryClass}>
                {busy ? <><Activity className="w-4 h-4 animate-spin" /> Entrando…</> : 'Entrar'}
              </button>
            </form>
          )}

          {step.name === 'totp' && (
            <form onSubmit={submitTotp} className="space-y-5">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={20}
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(''); }}
                placeholder="Código de 6 dígitos o de recuperación"
                autoFocus
                className={`${fieldClass} font-semibold tracking-[0.2em] placeholder:tracking-normal placeholder:font-normal placeholder:text-xs`}
              />
              {error && <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
              <button type="submit" disabled={busy} className={primaryClass}>
                {busy ? <><Activity className="w-4 h-4 animate-spin" /> Verificando…</> : 'Verificar'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
