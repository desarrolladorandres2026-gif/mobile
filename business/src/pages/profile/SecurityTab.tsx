import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import AuthenticatorMark from '../../components/AuthenticatorMark';
import ActiveSessions from '../../components/ActiveSessions';

/**
 * Pestaña "Seguridad" del perfil: es de la persona que entró, no del local,
 * así que no depende de que haya un negocio seleccionado ni de cargar nada
 * suyo.
 */
export default function SecurityTab() {
  const twoFactorEnabled = useAuthStore((s) => !!s.user?.twoFactorEnabled);

  return (
    <div className="space-y-6">
      <section className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <AuthenticatorMark className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-bold text-[var(--color-text-main)]">Verificación en dos pasos</h2>
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
            className="self-start sm:self-auto px-4 py-2 rounded-lg bg-[var(--color-text-main)] text-[var(--color-surface)] font-bold text-xs uppercase tracking-wider hover:opacity-90 transition-opacity"
          >
            Activar
          </Link>
        )}
      </section>

      <div className="border-t border-[var(--color-border-light)] pt-6">
        <ActiveSessions />
      </div>
    </div>
  );
}
