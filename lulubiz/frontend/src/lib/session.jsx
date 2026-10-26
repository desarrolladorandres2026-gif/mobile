import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

const SessionContext = createContext(null);
const TENANT_KEY = 'lulubiz.tenant';

const readTenant = () => {
  try {
    return window.localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};
const writeTenant = (id) => {
  try {
    if (id) window.localStorage.setItem(TENANT_KEY, id);
    else window.localStorage.removeItem(TENANT_KEY);
  } catch {
    // Sin almacenamiento disponible (modo privado): se pierde la preferencia, nada más.
  }
};

const ANONYMOUS = { status: 'anonymous', account: null, memberships: [] };

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', account: null, memberships: [] });
  const [tenantId, setTenantId] = useState(readTenant);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/v1/me');
      setState({ status: 'authenticated', account: me.account, memberships: me.memberships });
    } catch (error) {
      setState(error.status === 401 ? ANONYMOUS : { ...ANONYMOUS, status: 'error', error });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setState(ANONYMOUS));
    refresh();
  }, [refresh]);

  const login = useCallback(
    async (email, password) => {
      const result = await api.post('/v1/auth/login', { email, password });
      if (!result.mfaRequired) await refresh();
      return result;
    },
    [refresh],
  );

  const verifyMfa = useCallback(
    async (challenge, code) => {
      const result = await api.post('/v1/auth/mfa/verify', { challenge, code });
      await refresh();
      return result;
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/v1/auth/logout');
    } finally {
      setState(ANONYMOUS);
    }
  }, []);

  const selectTenant = useCallback((id) => {
    writeTenant(id);
    setTenantId(id);
  }, []);

  const value = useMemo(() => {
    const current = state.memberships.find((m) => m.tenantId === tenantId) ?? state.memberships[0] ?? null;
    return {
      ...state,
      tenant: current,
      can: (permission) => Boolean(current?.permissions?.includes(permission)),
      login,
      verifyMfa,
      logout,
      refresh,
      selectTenant,
    };
  }, [state, tenantId, login, verifyMfa, logout, refresh, selectTenant]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession va dentro de SessionProvider');
  return value;
}

/** La sesión, o `null` fuera de `SessionProvider`: para componentes de uso general que también viven sin ella. */
export function useOptionalSession() {
  return useContext(SessionContext);
}

/** Ruta base de la API para la empresa actual: `/v1/tenants/:id`. */
export function useTenantApi() {
  const { tenant } = useSession();
  return tenant ? `/v1/tenants/${tenant.tenantId}` : null;
}
