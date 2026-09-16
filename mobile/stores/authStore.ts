import { create } from 'zustand';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureGet, secureSet, secureDelete } from '../lib/secureStorage';
import { API_URL } from '../constants';

export interface User {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  role: string;
  avatar?: string;
  isVerified: boolean;
  phoneVerified?: boolean;
  emailVerified?: boolean;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setAuth: (user: User, accessToken: string, refreshToken: string) => Promise<void>;
  setTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  setUser: (user: User) => void;
  logout: () => Promise<void>;
  loadStoredAuth: () => Promise<void>;
}

const ACCESS_KEY = '@zipp_access_token';
const REFRESH_KEY = '@zipp_refresh_token';
const USER_KEY = '@zipp_user';

/**
 * Los tokens van al almacén cifrado; el perfil, no.
 *
 * El perfil no es un secreto —nombre, rol, avatar— y `SecureStore` tiene un
 * límite de tamaño por valor en algunas plataformas. Meterlo ahí sería
 * arriesgarse a que un nombre largo o un avatar en base64 hicieran fallar el
 * guardado entero, tokens incluidos.
 */
async function persistTokens(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    secureSet(ACCESS_KEY, accessToken),
    secureSet(REFRESH_KEY, refreshToken),
  ]);
}

/**
 * Trae al almacén cifrado los tokens que quedaron en `AsyncStorage`.
 *
 * Sin esto, todo el mundo que ya tenía la app instalada se encontraría con
 * la sesión cerrada al actualizar. Se ejecuta una sola vez: en cuanto se
 * copian, se borran del almacén viejo — dejarlos ahí anularía el motivo de
 * haber migrado.
 */
async function migrateLegacyTokens(): Promise<{ access: string | null; refresh: string | null }> {
  const [[, legacyAccess], [, legacyRefresh]] = await AsyncStorage.multiGet([
    ACCESS_KEY,
    REFRESH_KEY,
  ]);

  if (!legacyAccess || !legacyRefresh) return { access: null, refresh: null };

  await persistTokens(legacyAccess, legacyRefresh);
  await AsyncStorage.multiRemove([ACCESS_KEY, REFRESH_KEY]);

  return { access: legacyAccess, refresh: legacyRefresh };
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: true,

  setAuth: async (user, accessToken, refreshToken) => {
    await persistTokens(accessToken, refreshToken);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user, accessToken, refreshToken, isAuthenticated: true });
  },

  setTokens: async (accessToken, refreshToken) => {
    await persistTokens(accessToken, refreshToken);
    set({ accessToken, refreshToken });
  },

  setUser: (user) => {
    void AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user });
  },

  /**
   * Cierra la sesión aquí y en el servidor.
   *
   * Antes solo se borraba el teléfono: el refresh token seguía **vivo y
   * válido** en el backend después de que el usuario pulsara "cerrar
   * sesión", que es justo lo contrario de lo que esa acción promete.
   *
   * El aviso al servidor va primero y no bloquea: si la red falla, la sesión
   * local se cierra igual. Dejar a alguien dentro de la app porque no había
   * cobertura sería el peor de los dos fallos posibles.
   */
  logout: async () => {
    const token = useAuthStore.getState().accessToken;

    if (token) {
      try {
        /**
         * Se usa `axios` pelado y **no** el cliente `api` a propósito.
         *
         * `api` tiene un interceptor que, ante un 401, intenta refrescar y
         * si el refresco falla llama a `logout()`. Como aquí se sale
         * precisamente cuando la sesión ya puede estar muerta, pasar por
         * ese interceptor sería llamarse a sí mismo en bucle. Sin
         * interceptor, un 401 aquí es simplemente un no-op.
         */
        await axios.post(
          `${API_URL}/auth/logout`,
          {},
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
        );
      } catch {
        // Sin red, o sesión ya inválida. Se sigue: lo local manda. Dejar a
        // alguien dentro de la app porque no había cobertura sería peor
        // fallo que no invalidar el token en el servidor.
      }
    }

    await Promise.all([
      secureDelete(ACCESS_KEY),
      secureDelete(REFRESH_KEY),
      AsyncStorage.removeItem(USER_KEY),
      // Por si quedaba algo del almacén viejo en un dispositivo que nunca
      // llegó a migrar.
      AsyncStorage.multiRemove([ACCESS_KEY, REFRESH_KEY]),
    ]);

    set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
  },

  loadStoredAuth: async () => {
    try {
      let [accessToken, refreshToken] = await Promise.all([
        secureGet(ACCESS_KEY),
        secureGet(REFRESH_KEY),
      ]);

      if (!accessToken || !refreshToken) {
        const migrated = await migrateLegacyTokens();
        accessToken = migrated.access;
        refreshToken = migrated.refresh;
      }

      const userStr = await AsyncStorage.getItem(USER_KEY);

      if (accessToken && refreshToken && userStr) {
        set({
          accessToken,
          refreshToken,
          user: JSON.parse(userStr),
          isAuthenticated: true,
          isLoading: false,
        });
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },
}));
