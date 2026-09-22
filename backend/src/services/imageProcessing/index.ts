import { config } from '../../config';
import { BackgroundRemovalProvider } from './backgroundRemoval.types';
import { photoroomProvider } from './photoroom.provider';

export * from './backgroundRemoval.types';
export { PhotoroomProvider, photoroomProvider, parseRetryAfter } from './photoroom.provider';

/**
 * Los proveedores que ZIPP sabe usar, por el nombre de
 * `BACKGROUND_REMOVAL_PROVIDER`. Añadir otro es escribir su archivo y
 * sumarlo aquí.
 */
const PROVIDERS: Record<string, BackgroundRemovalProvider> = {
  photoroom: photoroomProvider,
};

let testOverride: BackgroundRemovalProvider | null = null;

/** El proveedor configurado, o `null` si el nombre no corresponde a ninguno. */
export function getBackgroundRemovalProvider(): BackgroundRemovalProvider | null {
  if (testOverride) return testOverride;
  return PROVIDERS[config.backgroundRemoval.provider] ?? null;
}

/**
 * Sustituye el proveedor en las pruebas, que no pueden llamar a la red.
 * `null` vuelve al configurado.
 */
export function setBackgroundRemovalProviderForTests(provider: BackgroundRemovalProvider | null): void {
  testOverride = provider;
}
