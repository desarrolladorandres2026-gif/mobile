import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { apiErrorCode, apiMessage } from '../lib/apiError';
import { qk } from '../lib/queryKeys';
import { useAuthStore } from '../stores/authStore';
import { usePermissions } from '../hooks/usePermissions';
import ConfirmDialog from './ConfirmDialog';

/**
 * PIN de 6 dígitos para entrar desde el mostrador (decisión 2026-10-10).
 *
 * Cada persona crea el suyo desde su cuenta completa y con su contraseña:
 * nadie conoce el PIN de otro, y así lo que se haga queda a nombre de quien
 * lo hizo. Solo lo usan el propietario y los administradores; al empleado no
 * se le ofrece. Las reglas de fuerza (repetidos, escaleras, celular, fecha
 * de nacimiento) las decide el servidor y su mensaje se muestra tal cual.
 *
 * Todo PIN exige 2FA activo (propietario o administrador): quitar el 2FA borra
 * el PIN. Sin 2FA, la acción principal no se deshabilita: "Crear PIN" pasa a
 * ser el paso que falta, activar la verificación en dos pasos. Si aun así el
 * servidor rechaza con `TWO_FACTOR_SETUP_REQUIRED` (sesión desactualizada), el
 * mensaje lleva el mismo enlace en vez de un callejón sin salida.
 */

const fieldClass =
  'w-full h-10 bg-transparent border-0 border-b border-[var(--color-border-strong)] px-0 text-sm text-[var(--color-text-main)] focus:border-[var(--color-primary)] outline-none transition-colors';

export default function CounterPin() {
  const queryClient = useQueryClient();
  const businessId = useAuthStore((s) => s.selectedBusiness?._id);
  const { access } = usePermissions(businessId);
  const twoFactorEnabled = useAuthStore((s) => !!s.user?.twoFactorEnabled);

  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [password, setPassword] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string; needs2fa?: boolean } | null>(null);

  const { data: setAt, isLoading } = useQuery({
    queryKey: qk.accountMe(),
    queryFn: async () => ((await api.get('/auth/me')).data.data.user?.counterPinSetAt ?? null) as string | null,
    staleTime: 30_000,
  });

  const done = (text: string) => {
    setFeedback({ tone: 'ok', text });
    setEditing(false);
    setPin('');
    setAgain('');
    setPassword('');
    void queryClient.invalidateQueries({ queryKey: qk.accountMe() });
  };

  const save = useMutation({
    mutationFn: () => api.put('/auth/counter/pin', { pin, currentPassword: password }),
    onSuccess: () => done(setAt ? 'PIN cambiado. Las sesiones abiertas con el anterior se cerraron.' : 'PIN creado.'),
    onError: (err) => {
      setPassword('');
      setFeedback({
        tone: 'error',
        text: apiMessage(err, 'No se pudo guardar el PIN. Intenta de nuevo.'),
        needs2fa: apiErrorCode(err) === 'TWO_FACTOR_SETUP_REQUIRED',
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete('/auth/counter/pin'),
    onSuccess: () => done('PIN eliminado. Ya no puedes entrar al mostrador con él.'),
    onError: (err) => setFeedback({ tone: 'error', text: apiMessage(err, 'No se pudo eliminar el PIN.') }),
  });

  // Solo propietario y administrador entran con PIN. Mientras no se sabe el
  // papel no se muestra: es un extra, no vale un parpadeo.
  if (access?.role !== 'owner' && access?.role !== 'manager') return null;

  const mismatch = again.length === 6 && pin !== again;
  const ready = /^\d{6}$/.test(pin) && pin === again && password.length > 0 && !save.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setFeedback(null);
    save.mutate();
  };

  const cancel = () => {
    setEditing(false);
    setPin('');
    setAgain('');
    setPassword('');
    setFeedback(null);
  };

  return (
    <section id="pin" className="border-t border-[var(--color-border)] pt-6 space-y-4 scroll-mt-24">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text-main)]">PIN del mostrador</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 max-w-prose">
            {isLoading
              ? 'Cargando…'
              : setAt
                ? `Creado el ${new Date(setAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}. Con él entras a tu panel desde el mostrador, sin escribir tu contraseña.`
                : twoFactorEnabled
                  ? 'Sin crear. Con un PIN de 6 dígitos entras a tu panel desde el mostrador sin escribir tu contraseña.'
                  : 'Sin crear. Para crear tu PIN primero activa la verificación en dos pasos: el PIN reemplaza tu contraseña en el mostrador y necesita ese respaldo.'}
          </p>
        </div>
        {!editing && !isLoading && (
          <div className="flex items-center gap-2 self-start">
            {twoFactorEnabled ? (
              <button
                type="button"
                onClick={() => { setFeedback(null); setEditing(true); }}
                className="inline-flex items-center h-8 px-4 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)]"
              >
                {setAt ? 'Cambiar PIN' : 'Crear PIN'}
              </button>
            ) : (
              <Link
                to="/setup-2fa"
                className="inline-flex items-center h-8 px-4 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)]"
              >
                Activar 2FA para crear el PIN
              </Link>
            )}
            {setAt && (
              <button
                type="button"
                onClick={() => { setFeedback(null); setConfirmRemove(true); }}
                disabled={remove.isPending}
                className="inline-flex items-center h-8 px-3 rounded-md text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors"
              >
                Quitar
              </button>
            )}
          </div>
        )}
      </div>

      {feedback && (
        <p role="status" className={`text-xs font-semibold ${feedback.tone === 'ok' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
          {feedback.text}
          {feedback.needs2fa && (
            <> <Link to="/setup-2fa" className="underline text-[var(--color-primary)]">Activar verificación en dos pasos</Link></>
          )}
        </p>
      )}

      {editing && (
        <form onSubmit={submit} className="grid gap-5 sm:grid-cols-3 max-w-2xl">
          <label className="block">
            <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">PIN nuevo</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="6 dígitos"
              autoFocus
              className={fieldClass + ' tracking-[0.3em] font-semibold'}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">Repite el PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={again}
              onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
              placeholder="6 dígitos"
              className={fieldClass + ' tracking-[0.3em] font-semibold'}
            />
            {mismatch && <span className="text-[11px] font-semibold text-[var(--color-danger)]">No coinciden.</span>}
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">Tu contraseña actual</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={fieldClass}
            />
          </label>
          <p className="sm:col-span-3 text-xs text-[var(--color-text-secondary)]">
            Sin dígitos repetidos ni escaleras (123456), y que no salga de tu celular ni de tu fecha de nacimiento.
            Cambiarlo cierra las sesiones de mostrador abiertas con el anterior.
          </p>
          <div className="sm:col-span-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={!ready}
              className="inline-flex items-center h-9 px-5 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {save.isPending ? 'Guardando…' : 'Guardar PIN'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Quitar el PIN"
          message="Ya no podrás entrar al mostrador con PIN y se cerrarán las sesiones abiertas con él. Podrás crear otro cuando quieras."
          confirmLabel="Quitar PIN"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => { setConfirmRemove(false); remove.mutate(); }}
        />
      )}
    </section>
  );
}
