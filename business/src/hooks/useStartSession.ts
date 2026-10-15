import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { apiErrorCode } from '../lib/apiError';
import { markCounterSession } from '../lib/counter';

export interface SessionPayload {
  user: { _id: string; name: string; phone: string; role: string; twoFactorEnabled?: boolean };
  accessToken: string;
  refreshToken: string;
}

/**
 * Abre la sesión del panel y carga los locales.
 *
 * Una sola implementación para el login y para la recuperación de
 * contraseña: ambos terminan con la misma sesión de mostrador. Devuelve
 * false si la cuenta no es de comercio.
 */
export function useStartSession() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setBusinesses = useAuthStore((s) => s.setBusinesses);

  return async ({ user, accessToken, refreshToken }: SessionPayload): Promise<boolean> => {
    if (user.role !== 'business') return false;
    markCounterSession();
    setAuth(user, accessToken, refreshToken);

    try {
      const resBus = await api.get('/businesses/my/businesses');
      setBusinesses(resBus.data.data);
    } catch (busErr) {
      // Sin 2FA y con `TOTP_REQUIRED_BUSINESS` encendido: el interceptor ya
      // está llevando a /setup-2fa; navegar a / aquí pelearía con él.
      if (apiErrorCode(busErr) === 'TWO_FACTOR_SETUP_REQUIRED') return true;
      console.error('No se pudieron cargar los establecimientos:', busErr);
    }

    navigate('/');
    return true;
  };
}
