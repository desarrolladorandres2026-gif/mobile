import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlainButton } from '../components/Button';
import { FormStatus, OtpField, TextField } from '../components/Form';
import { authApi } from '../lib/authApi';
import { ApiError } from '../lib/http';
import { setPageMeta } from '../lib/meta';
import { PASSWORD_RULES, meetsPasswordRules } from '../lib/passwordRules';
import { isValidPhone } from '../lib/validate';
import { ME_KEY, useAuth } from '../lib/useAuth';
import { clearSession } from '../lib/session';

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-8">
      <h2 className="text-xl font-semibold text-text-main">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Nombre y correo. */
function ProfileSection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (name.trim().length < 2) { setError('Escribe tu nombre.'); return; }
    setBusy(true);
    try {
      await authApi.updateProfile({ name: name.trim(), email: email.trim() || undefined });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      setOk('Datos guardados.');
    } catch (err) {
      setError(errorText(err, 'No pudimos guardar tus datos.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Mis datos">
      <form onSubmit={submit} noValidate className="flex max-w-md flex-col gap-6">
        <TextField label="Nombre" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Correo (para tus comprobantes)" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        <FormStatus error={error} success={ok} />
        <div><PlainButton type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</PlainButton></div>
      </form>
    </Section>
  );
}

/** Celular: lo que falta si se entró con Google, o el cambio de número con su código. */
function PhoneSection({ highlight }: { highlight: boolean }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(Boolean(user?.pendingPhone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestChange = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidPhone(phone)) { setError('Escribe un celular de 10 dígitos que empiece por 3.'); return; }
    setBusy(true);
    try {
      await authApi.updateProfile({ phone });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      setAwaitingCode(true);
    } catch (err) {
      setError(errorText(err, 'No pudimos cambiar el celular.'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(otp)) { setError('Escribe los 6 dígitos.'); return; }
    setBusy(true);
    try {
      await authApi.verifyPhone(otp);
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      setAwaitingCode(false);
      setOtp('');
      setPhone('');
    } catch (err) {
      setError(errorText(err, 'Código incorrecto.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Celular">
      {user?.phone ? (
        <p className="text-base text-text-main">
          {user.phone}{user.phoneVerified ? '' : ' (sin verificar)'}
        </p>
      ) : (
        <p className="text-base text-text-main">
          {highlight ? 'Entraste con Google. Para pedir necesitamos un celular de contacto.' : 'Todavía no tienes un celular en tu cuenta.'}
        </p>
      )}

      {awaitingCode ? (
        <form onSubmit={confirm} noValidate className="mt-4 flex max-w-md flex-col gap-6">
          <p className="text-base text-text-secondary">Te enviamos un código por WhatsApp al {user?.pendingPhone ?? 'nuevo número'}.</p>
          <OtpField
            code={otp}
            onCodeChange={setOtp}
            onSend={async () => { await authApi.resendPhoneOtp(); }}
          />
          <FormStatus error={error} />
          <div><PlainButton type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Confirmar celular'}</PlainButton></div>
        </form>
      ) : (
        <form onSubmit={requestChange} noValidate className="mt-4 flex max-w-md flex-col gap-6">
          <TextField
            label={user?.phone ? 'Cambiar celular' : 'Tu celular'}
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          />
          <FormStatus error={error} />
          <div><PlainButton type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar código'}</PlainButton></div>
        </form>
      )}
    </Section>
  );
}

function PasswordSection() {
  const { hasPassword } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasPassword) {
    return (
      <Section title="Contraseña">
        <p className="text-base text-text-secondary">
          Tu cuenta entra con Google y no tiene contraseña. Puedes crear una desde «Olvidé mi contraseña» en el ingreso.
        </p>
      </Section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current) { setError('Escribe tu contraseña actual.'); return; }
    if (!meetsPasswordRules(next)) { setError('La contraseña nueva no cumple todas las reglas.'); return; }
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      // El servidor cierra todas las sesiones, la de este navegador incluida, y no entrega tokens nuevos.
      clearSession();
      navigate('/ingresar', { replace: true, state: { passwordChanged: true } });
    } catch (err) {
      setError(errorText(err, 'No pudimos cambiar la contraseña.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Contraseña">
      <form onSubmit={submit} noValidate className="flex max-w-md flex-col gap-6">
        <TextField label="Contraseña actual" type="password" autoComplete="current-password" maxLength={128} value={current} onChange={(e) => setCurrent(e.target.value)} />
        <div>
          <TextField label="Contraseña nueva" type="password" autoComplete="new-password" maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} />
          <ul className="mt-2 text-sm">
            {PASSWORD_RULES.map((r) => (
              <li key={r.label} className={r.test(next) ? 'text-ok' : 'text-text-secondary'}>
                {r.test(next) ? 'Listo: ' : 'Falta: '}{r.label}
              </li>
            ))}
          </ul>
        </div>
        <FormStatus error={error} />
        <div><PlainButton type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Cambiar contraseña'}</PlainButton></div>
      </form>
    </Section>
  );
}

function SessionsSection() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: authApi.sessions });
  const [error, setError] = useState<string | null>(null);

  const revoke = async (id: string) => {
    setError(null);
    try {
      await authApi.revokeSession(id);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      setError(errorText(err, 'No pudimos cerrar esa sesión.'));
    }
  };

  const revokeOthers = async () => {
    setError(null);
    try {
      await authApi.revokeOthers();
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      setError(errorText(err, 'No pudimos cerrar las otras sesiones.'));
    }
  };

  const rows = sessions.data?.sessions ?? [];

  return (
    <Section title="Sesiones abiertas">
      {sessions.isPending ? (
        <p className="text-base text-text-secondary">Cargando…</p>
      ) : sessions.isError ? (
        <p className="text-base text-text-secondary">No pudimos cargar tus sesiones.</p>
      ) : (
        <>
          <ul>
            {rows.map((s) => (
              <li key={s._id} className="flex flex-wrap items-center justify-between gap-x-6 border-b border-border py-2">
                <span className="text-base text-text-main">
                  {s.deviceName || 'Dispositivo'}{s.isCurrent ? ' (este)' : ''}
                  {s.lastActivity ? ` · ${new Date(s.lastActivity).toLocaleDateString('es-CO')}` : ''}
                </span>
                {!s.isCurrent && (
                  <button type="button" onClick={() => revoke(s._id)} className="min-h-11 text-base font-semibold text-primary-text underline underline-offset-4">
                    Cerrar
                  </button>
                )}
              </li>
            ))}
          </ul>
          {rows.length > 1 && (
            <div className="mt-4"><PlainButton type="button" variant="secondary" onClick={revokeOthers}>Cerrar las demás sesiones</PlainButton></div>
          )}
        </>
      )}
      <div className="mt-2"><FormStatus error={error} /></div>
    </Section>
  );
}

/** Eliminación desde la cuenta: contraseña, o código por WhatsApp si no tiene contraseña. */
function DeleteSection() {
  const { hasPassword, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (hasPassword && !password) { setError('Escribe tu contraseña para confirmar.'); return; }
    if (!hasPassword && !/^\d{6}$/.test(otp)) { setError('Pide el código y escribe los 6 dígitos.'); return; }
    setBusy(true);
    try {
      await authApi.deleteAccount(hasPassword ? { password } : { otpCode: otp });
      await logout();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorText(err, 'No pudimos eliminar la cuenta.'));
      setBusy(false);
    }
  };

  return (
    <Section title="Eliminar mi cuenta">
      <p className="max-w-md text-base text-text-secondary">
        Se borran tus datos personales, direcciones, favoritos y tarjetas guardadas, y se cancela tu membresía. Los pedidos
        y pagos se conservan sin tu nombre por obligación legal. No se puede deshacer.
      </p>
      {!open ? (
        <div className="mt-4"><PlainButton type="button" variant="secondary" onClick={() => setOpen(true)}>Quiero eliminar mi cuenta</PlainButton></div>
      ) : (
        <form onSubmit={submit} noValidate className="mt-4 flex max-w-md flex-col gap-6">
          {hasPassword ? (
            <TextField label="Tu contraseña" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          ) : (
            <OtpField code={otp} onCodeChange={setOtp} onSend={async () => { await authApi.requestDeletionOtp(); }} />
          )}
          <FormStatus error={error} />
          <div className="flex flex-wrap gap-3">
            <PlainButton type="submit" disabled={busy}>{busy ? 'Eliminando…' : 'Eliminar definitivamente'}</PlainButton>
            <PlainButton type="button" variant="tertiary" onClick={() => setOpen(false)}>Cancelar</PlainButton>
          </div>
        </form>
      )}
    </Section>
  );
}

export default function Cuenta() {
  const { user, logout } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    setPageMeta({ title: 'Mi cuenta | ZIPP' });
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-10 sm:px-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6">
        <h1 className="text-2xl font-semibold text-text-main">Mi cuenta</h1>
        <button
          type="button"
          onClick={async () => { await logout(); navigate('/', { replace: true }); }}
          className="min-h-11 text-base font-semibold text-primary-text underline underline-offset-4"
        >
          Cerrar sesión
        </button>
      </div>
      <p className="mt-1 text-base text-text-secondary">{user?.name}</p>

      <div className="mt-6">
        <ProfileSection key={user?._id} />
        <PhoneSection highlight={params.get('completar') === '1'} />
        <PasswordSection />
        <SessionsSection />
        <DeleteSection />
      </div>
    </div>
  );
}
