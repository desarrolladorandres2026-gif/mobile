import { Button, Notice, errorMessage } from './components/ui.jsx';
import { Redirect, RouterProvider, useRouter } from './lib/router.jsx';
import { SessionProvider, useSession } from './lib/session.jsx';
import {
  ForgotScreen,
  InvitationScreen,
  LoginScreen,
  PublicLayout,
  RegisterScreen,
  ResetScreen,
  VerifyEmailScreen,
} from './screens/Public.jsx';
import { Shell } from './screens/Shell.jsx';

/** Pantallas que se pueden abrir con o sin sesión: el enlace llega por correo y trae su propio token. */
const OPEN = {
  '/verificar-correo': VerifyEmailScreen,
  '/invitacion': InvitationScreen,
};
/** Pantallas solo para quien no ha iniciado sesión. */
const ANONYMOUS_ONLY = {
  '/iniciar-sesion': LoginScreen,
  '/registro': RegisterScreen,
  '/recuperar': ForgotScreen,
  '/restablecer-contrasena': ResetScreen,
};

function Routes() {
  const { pathname, search } = useRouter();
  const session = useSession();
  const { status } = session;

  if (status === 'loading') {
    return (
      <PublicLayout title="Lulubiz">
        <p className="text-sm text-tinta">Cargando…</p>
      </PublicLayout>
    );
  }

  if (status === 'error') {
    return (
      <PublicLayout title="Sin conexión">
        <Notice kind="error">{errorMessage(session.error)}</Notice>
        <Button variant="primary" onClick={session.refresh}>
          Reintentar
        </Button>
      </PublicLayout>
    );
  }

  const Open = OPEN[pathname];
  if (Open) return <Open />;

  const authenticated = status === 'authenticated';

  if (pathname === '/app' || pathname.startsWith('/app/')) {
    if (!authenticated) return <Redirect to="/iniciar-sesion" />;
    if (session.memberships.length === 0) {
      return (
        <PublicLayout title="Sin empresas">
          <Notice>Tu cuenta no pertenece a ninguna empresa. Pide que te inviten, o crea una nueva.</Notice>
          <Button onClick={session.logout}>Cerrar sesión</Button>
        </PublicLayout>
      );
    }
    return <Shell />;
  }

  const Anonymous = ANONYMOUS_ONLY[pathname];
  if (Anonymous) {
    if (!authenticated) return <Anonymous />;
    // Quien ya tiene sesión no necesita estas pantallas; si venía de un enlace (p. ej. una invitación), vuelve a él.
    const next = new URLSearchParams(search).get('siguiente');
    return <Redirect to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/app'} />;
  }

  if (pathname === '/') return <Redirect to={authenticated ? '/app' : '/iniciar-sesion'} />;

  return (
    <PublicLayout title="Página no encontrada">
      <p className="text-sm text-tinta">La dirección que abriste no existe.</p>
      <Redirect to={authenticated ? '/app' : '/iniciar-sesion'} />
    </PublicLayout>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <SessionProvider>
        <Routes />
      </SessionProvider>
    </RouterProvider>
  );
}
