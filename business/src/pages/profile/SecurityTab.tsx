import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import AuthenticatorMark from '../../components/AuthenticatorMark';
import ActiveSessions from '../../components/ActiveSessions';
import CounterPin from '../../components/CounterPin';
import { sessionKind } from '../../lib/counter';

/**
 * Pestaña "Seguridad" del perfil: es de la persona que entró, no del local,
 * así que no depende de que haya un negocio seleccionado ni de cargar nada
 * suyo.
 */
export default function SecurityTab() {
  const twoFactorEnabled = useAuthStore((s) => !!s.user?.twoFactorEnabled);

  // El backend rechaza desde el mostrador todo lo de esta pestaña (2FA, PIN,
  // sesiones): es de la cuenta, y el mostrador es un equipo compartido.
  // La entrada con PIN tampoco (revisión 2026-10-10): son 6 dígitos en un
  // equipo compartido. Para esto se entra con la contraseña.
  const kind = sessionKind();
  if (kind === 'counter' || kind === 'elevated-pin') {
    return (
      <p className="text-sm text-[var(--color-text-main)] max-w-prose leading-relaxed">
        {kind === 'counter'
          ? <>Estás en el mostrador. Para la verificación en dos pasos, el PIN y las sesiones usa el
              botón <strong>Administrador o representante legal</strong>, abajo a la derecha, y entra
              con tu contraseña.</>
          : <>Entraste con PIN. La verificación en dos pasos, el PIN y las sesiones solo se cambian
              entrando con tu contraseña: pulsa <strong>Volver al mostrador</strong> y elige
              «Entrar con contraseña».</>}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <AuthenticatorMark className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Verificación en dos pasos</h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {twoFactorEnabled
                ? 'Activa. Al entrar te pedimos el código de Google Authenticator.'
                : 'Sin activar. Con ella, tu contraseña sola ya no basta para entrar a tu panel.'}
            </p>
          </div>
        </div>
        {!twoFactorEnabled && (
          <Link
            to="/setup-2fa"
            className="self-start sm:self-auto inline-flex items-center h-8 px-4 rounded-md bg-[var(--color-primary)] text-[var(--zipp-obsidian)] font-semibold text-xs hover:bg-[var(--color-primary-light)]"
          >
            Activar
          </Link>
        )}
      </section>

      <CounterPin />

      <div className="pt-2">
        <ActiveSessions />
      </div>
    </div>
  );
}
