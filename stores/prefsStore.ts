import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface PrefsState {
  /** El onboarding se muestra una sola vez, en la primera apertura. */
  onboardingSeen: boolean;
  completeOnboarding: () => void;

  /** Última dirección usada, para no volver a preguntarla en cada pedido. */
  lastAddressId: string | null;
  setLastAddress: (id: string | null) => void;

  /** Se guarda para poder restaurar el estado en pruebas y soporte. */
  reset: () => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      onboardingSeen: false,
      completeOnboarding: () => set({ onboardingSeen: true }),

      lastAddressId: null,
      setLastAddress: (id) => set({ lastAddressId: id }),

      reset: () => set({ onboardingSeen: false, lastAddressId: null }),
    }),
    {
      name: 'zipp-prefs',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
