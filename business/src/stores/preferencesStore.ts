import { create } from 'zustand';

/**
 * Preferencias del panel que viven en este navegador.
 *
 * Solo entra aquí lo que de verdad es de este dispositivo. El estado
 * "abierto / cerrado" del local **no** está en esta lista: eso decide si
 * ZIPP le manda pedidos al comercio, así que vive en el servidor. Un
 * interruptor que apagara el local solo en esta pestaña dejaría al
 * comercio creyendo que cerró mientras siguen entrando comandas.
 */

const SOUND_KEY = 'business_sound_enabled';

/** `localStorage` puede lanzar en modo privado o con las cookies bloqueadas. */
function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'false';
  } catch {
    return true;
  }
}

interface PreferencesState {
  /** Si suenan los avisos en vivo de pedidos y seguridad. */
  soundEnabled: boolean;
  toggleSound: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  soundEnabled: readSound(),

  toggleSound: () => {
    const next = !get().soundEnabled;
    try {
      localStorage.setItem(SOUND_KEY, String(next));
    } catch {
      // Sin almacenamiento la preferencia dura lo que la sesión; el panel
      // sigue funcionando, que es lo que importa.
    }
    set({ soundEnabled: next });
  },
}));
