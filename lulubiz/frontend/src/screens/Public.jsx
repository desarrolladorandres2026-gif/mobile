import { useEffect, useRef, useState } from 'react';
import { Button, Notice, SelectField, TextField, errorMessage, useSubmit } from '../components/ui.jsx';
import { api, takeFragmentToken } from '../lib/api.js';
import { Link, useRouter } from '../lib/router.jsx';
import { useSession } from '../lib/session.jsx';

const INVITATION_KEY = 'lulubiz.invitationToken';

/** Estructura de las pantallas sin sesión: una columna de formulario sobre la superficie de trabajo. */
export function PublicLayout({ title, children }) {
  return (
    <div className="min-h-screen bg-papel-fondo">
      <header className="border-b border-borde bg-papel px-6 py-3">
        <span className="text-lg font-semibold tracking-tight text-azul">Lulubiz</span>
      </header>
      <main className="mx-auto max-w-md px-6 py-10">
        <h1 className="mb-6 text-2xl font-semibold text-tinta">{title}</h1>
        {children}
      </main>
    </div>
  );
}

const NOTICES = {
  'clave-cambiada': 'Tu contraseña cambió y se cerraron tus sesiones. Inicia sesión con la nueva.',
  'cuenta-creada': 'Tu cuenta quedó creada. Inicia sesión para entrar a la empresa.',
};

export function LoginScreen() {
  const { login, verifyMfa } = useSession();
  const { navigate, search } = useRouter();
  const params = new URLSearchParams(search);
  // Solo rutas internas: `siguiente=//sitio-malo.com` o una URL completa no deben sacar al usuario de la aplicación.
  const requested = params.get('siguiente');
  const next = requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');

  const credentials = useSubmit(async () => {
    const result = await login(email, password);
    if (result.mfaRequired) setChallenge(result.challenge);
    else navigate(next ?? '/app', { replace: true });
  });
  const second = useSubmit(async () => {
    await verifyMfa(challenge, code);
    navigate(next ?? '/app', { replace: true });
  });

  if (challenge) {
    return (
      <PublicLayout title="Verificación en dos pasos">
        <p className="mb-4 text-sm text-tinta">
          Escribe el código de 6 dígitos de tu aplicación de autenticación, o uno de tus códigos de recuperación.
        </p>
        {second.error ? <Notice kind="error">{errorMessage(second.error)}</Notice> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            second.run();
          }}
        >
          <TextField label="Código" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" autoFocus required />
          <Button type="submit" variant="primary" busy={second.busy}>
            Verificar
          </Button>
          <Button className="ml-2" onClick={() => { setChallenge(null); setCode(''); second.clearError(); }}>
            Volver
          </Button>
        </form>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout title="Iniciar sesión">
      {params.get('aviso') && NOTICES[params.get('aviso')] ? <Notice kind="success">{NOTICES[params.get('aviso')]}</Notice> : null}
      {credentials.error ? <Notice kind="error">{errorMessage(credentials.error)}</Notice> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          credentials.run();
        }}
      >
        <TextField label="Correo electrónico" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        <TextField label="Contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <Button type="submit" variant="primary" busy={credentials.busy}>
          Iniciar sesión
        </Button>
      </form>
      <p className="mt-6 text-sm text-tinta">
        <Link href="/recuperar">Olvidé mi contraseña</Link>
      </p>
      <p className="mt-2 text-sm text-tinta">
        ¿Primera vez? <Link href="/registro">Crear una empresa</Link>
      </p>
    </PublicLayout>
  );
}

const COUNTRIES = [
  { value: 'CO', label: 'Colombia', currency: 'COP' },
  { value: 'MX', label: 'México', currency: 'MXN' },
  { value: 'PE', label: 'Perú', currency: 'PEN' },
  { value: 'CL', label: 'Chile', currency: 'CLP' },
  { value: 'US', label: 'Estados Unidos', currency: 'USD' },
  { value: 'ES', label: 'España', currency: 'EUR' },
];

export function RegisterScreen() {
  const [form, setForm] = useState({ companyName: '', country: 'CO', ownerName: '', email: '', password: '' });
  const [done, setDone] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const currency = COUNTRIES.find((c) => c.value === form.country).currency;

  const submit = useSubmit(async () => {
    await api.post('/v1/auth/register', { ...form, currency });
    setDone(true);
  });

  if (done) {
    return (
      <PublicLayout title="Revisa tu correo">
        <Notice kind="success">
          Creamos la empresa. Enviamos un enlace de confirmación a {form.email}. Puedes iniciar sesión desde ya; confirmar el correo es necesario para invitar a otras personas.
        </Notice>
        <Link href="/iniciar-sesion">Ir a iniciar sesión</Link>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout title="Crear una empresa">
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.run();
        }}
      >
        <TextField label="Nombre de la empresa" value={form.companyName} onChange={set('companyName')} autoComplete="organization" required />
        <SelectField label="País" value={form.country} onChange={set('country')} options={COUNTRIES} hint={`Moneda de la empresa: ${currency}.`} />
        <TextField label="Tu nombre" value={form.ownerName} onChange={set('ownerName')} autoComplete="name" required />
        <TextField label="Correo electrónico" type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
        <TextField label="Contraseña" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" hint="Al menos 12 caracteres." required />
        <Button type="submit" variant="primary" busy={submit.busy}>
          Crear empresa
        </Button>
      </form>
      <p className="mt-6 text-sm text-tinta">
        ¿Ya tienes cuenta? <Link href="/iniciar-sesion">Iniciar sesión</Link>
      </p>
    </PublicLayout>
  );
}

export function ForgotScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const submit = useSubmit(async () => {
    await api.post('/v1/auth/password/forgot', { email });
    setSent(true);
  });

  return (
    <PublicLayout title="Recuperar contraseña">
      {sent ? (
        <Notice kind="success">Si ese correo tiene una cuenta, enviamos un enlace para elegir una contraseña nueva. Vence en una hora.</Notice>
      ) : (
        <>
          {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit.run();
            }}
          >
            <TextField label="Correo electrónico" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            <Button type="submit" variant="primary" busy={submit.busy}>
              Enviar enlace
            </Button>
          </form>
        </>
      )}
      <p className="mt-6 text-sm text-tinta">
        <Link href="/iniciar-sesion">Volver a iniciar sesión</Link>
      </p>
    </PublicLayout>
  );
}

/** Lee el token del fragmento una sola vez (React puede montar dos veces en desarrollo) y lo borra de la URL. */
function useFragmentToken() {
  const [token] = useState(() => takeFragmentToken());
  return token;
}

export function ResetScreen() {
  const token = useFragmentToken();
  const { navigate } = useRouter();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const submit = useSubmit(async () => {
    if (password !== again) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    await api.post('/v1/auth/password/reset', { token, password });
    navigate('/iniciar-sesion?aviso=clave-cambiada', { replace: true });
  });

  if (!token) {
    return (
      <PublicLayout title="Restablecer contraseña">
        <Notice kind="error">Este enlace no es válido. Pide uno nuevo desde la pantalla de recuperación.</Notice>
        <Link href="/recuperar">Pedir un enlace nuevo</Link>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout title="Elige una contraseña nueva">
      {submit.error ? <Notice kind="error">{errorMessage(submit.error)}</Notice> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.run();
        }}
      >
        <TextField label="Contraseña nueva" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint="Al menos 12 caracteres." required />
        <TextField label="Repite la contraseña" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" error={mismatch ? 'Las contraseñas no coinciden.' : undefined} required />
        <Button type="submit" variant="primary" busy={submit.busy}>
          Cambiar contraseña
        </Button>
      </form>
    </PublicLayout>
  );
}

export function VerifyEmailScreen() {
  const token = useFragmentToken();
  const { refresh, status } = useSession();
  const [result, setResult] = useState(token ? 'working' : 'invalid');
  const [error, setError] = useState(null);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api
      .post('/v1/auth/verify-email', { token })
      .then(() => {
        setResult('done');
        if (status === 'authenticated') refresh();
      })
      .catch((e) => {
        setError(e);
        setResult('invalid');
      });
  }, [token, refresh, status]);

  return (
    <PublicLayout title="Confirmar correo">
      {result === 'working' ? <p className="text-sm text-tinta">Confirmando tu correo…</p> : null}
      {result === 'done' ? <Notice kind="success">Tu correo quedó confirmado.</Notice> : null}
      {result === 'invalid' ? (
        <Notice kind="error">{error ? errorMessage(error) : 'Este enlace no es válido.'} Entra a tu cuenta y pide uno nuevo desde «Mi cuenta».</Notice>
      ) : null}
      <Link href="/app">Ir a la aplicación</Link>
    </PublicLayout>
  );
}

export function InvitationScreen() {
  const fragment = useFragmentToken();
  const { status, account, refresh } = useSession();
  const { navigate } = useRouter();
  const [token] = useState(() => {
    if (fragment) {
      try {
        window.sessionStorage.setItem(INVITATION_KEY, fragment);
      } catch {
        // Sin almacenamiento: la invitación solo se puede aceptar sin pasar por inicio de sesión.
      }
      return fragment;
    }
    try {
      return window.sessionStorage.getItem(INVITATION_KEY);
    } catch {
      return null;
    }
  });
  const [info, setInfo] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!token) return;
    api
      .post('/v1/invitations/lookup', { token })
      .then(setInfo)
      .catch(setLookupError);
  }, [token]);

  const accept = useSubmit(async () => {
    await api.post('/v1/invitations/accept', { token, ...(info.accountExists ? {} : { name, password }) });
    try {
      window.sessionStorage.removeItem(INVITATION_KEY);
    } catch {
      // Nada que limpiar.
    }
    if (info.accountExists) {
      await refresh();
      navigate('/app', { replace: true });
    } else {
      navigate('/iniciar-sesion?aviso=cuenta-creada', { replace: true });
    }
  });

  if (!token || lookupError) {
    return (
      <PublicLayout title="Invitación">
        <Notice kind="error">{lookupError ? errorMessage(lookupError) : 'Este enlace no es válido.'} Pide que te inviten de nuevo.</Notice>
      </PublicLayout>
    );
  }
  if (!info || status === 'loading') {
    return (
      <PublicLayout title="Invitación">
        <p className="text-sm text-tinta">Cargando la invitación…</p>
      </PublicLayout>
    );
  }

  const title = `Te invitaron a ${info.company}`;
  const roles = { owner: 'propietario', admin: 'administrador', accountant: 'contador', cashier: 'cajero', viewer: 'lector' };

  if (info.accountExists) {
    const mine = status === 'authenticated' && account?.email === info.email;
    return (
      <PublicLayout title={title}>
        <p className="mb-4 text-sm text-tinta">
          Entrarás como {roles[info.role] ?? info.role} con la cuenta {info.email}.
        </p>
        {accept.error ? <Notice kind="error">{errorMessage(accept.error)}</Notice> : null}
        {mine ? (
          <Button variant="primary" busy={accept.busy} onClick={accept.run}>
            Aceptar invitación
          </Button>
        ) : (
          <>
            <Notice>Primero inicia sesión con {info.email} y volverás aquí para aceptar.</Notice>
            <Link href="/iniciar-sesion?siguiente=/invitacion">Iniciar sesión</Link>
          </>
        )}
      </PublicLayout>
    );
  }

  return (
    <PublicLayout title={title}>
      <p className="mb-4 text-sm text-tinta">
        Crea tu cuenta con {info.email} para entrar como {roles[info.role] ?? info.role}.
      </p>
      {accept.error ? <Notice kind="error">{errorMessage(accept.error)}</Notice> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          accept.run();
        }}
      >
        <TextField label="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        <TextField label="Contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint="Al menos 12 caracteres." required />
        <Button type="submit" variant="primary" busy={accept.busy}>
          Crear cuenta y aceptar
        </Button>
      </form>
    </PublicLayout>
  );
}
