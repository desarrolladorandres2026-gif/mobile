/**
 * Nivel de batería, si el dispositivo lo cuenta.
 *
 * `expo-battery` es opcional a propósito. El nivel de batería alimenta el
 * muestreo adaptativo —un teléfono al 8% no debería reportar cada cinco
 * segundos— pero es una mejora, no un requisito: sin el módulo instalado
 * el seguimiento funciona igual, solo que sin ese ajuste.
 *
 * Por eso se carga en tiempo de ejecución y no con un `import` normal: un
 * import estático de un paquete ausente rompe el bundle entero de Metro al
 * arrancar, y una app que no abre es mucho peor que una app que ahorra un
 * poco menos de batería.
 */

type BatteryModule = {
  getBatteryLevelAsync: () => Promise<number>;
  getPowerStateAsync?: () => Promise<{ batteryState?: number }>;
};

let module: BatteryModule | null | undefined;

function load(): BatteryModule | null {
  if (module !== undefined) return module;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    module = require('expo-battery') as BatteryModule;
  } catch {
    module = null;
  }
  return module;
}

/** Batería de 0 a 100, o null si no se puede saber. */
export async function batteryLevelPercent(): Promise<number | null> {
  const battery = load();
  if (!battery) return null;

  try {
    const level = await battery.getBatteryLevelAsync();
    // El simulador devuelve -1. Reportarlo haría que el muestreo
    // adaptativo creyera estar ante un teléfono agonizante y bajara la
    // frecuencia justo mientras se está probando la función.
    if (level == null || level < 0) return null;
    return Math.round(level * 100);
  } catch {
    return null;
  }
}

/** Si el dispositivo está cargando. Null cuando no se puede saber. */
export async function isCharging(): Promise<boolean | null> {
  const battery = load();
  if (!battery?.getPowerStateAsync) return null;

  try {
    const state = await battery.getPowerStateAsync();
    // 2 = CHARGING, 3 = FULL en el enum de expo-battery. Un repartidor con
    // el teléfono en el soporte de la moto y cargando puede permitirse la
    // máxima precisión sin que a nadie le importe el consumo.
    return state.batteryState === 2 || state.batteryState === 3;
  } catch {
    return null;
  }
}
