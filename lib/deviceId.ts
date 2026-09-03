import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@zipp_device_id';
let cached: string | null = null;

function generate(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Identificador anónimo de instalación, para analítica de publicidad
 * (impresiones/clics) sin pedir permisos ni instalar expo-device. Se genera
 * una sola vez y se persiste en AsyncStorage; no identifica a la persona.
 */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;

  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (stored) {
    cached = stored;
    return stored;
  }

  const id = generate();
  await AsyncStorage.setItem(STORAGE_KEY, id);
  cached = id;
  return id;
}
