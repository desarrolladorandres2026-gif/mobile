/**
 * Punto de entrada de la app.
 *
 * Antes este archivo era el de la plantilla de Expo (`registerRootComponent`)
 * y estaba muerto desde la migración a expo-router, que entra por
 * `expo-router/entry`. Ahora vuelve a usarse, por una sola razón: la tarea
 * de ubicación en segundo plano.
 *
 * `expo-task-manager` exige que `defineTask` corra en el scope global del
 * bundle, al cargarlo, porque el sistema operativo puede arrancar la app
 * *directamente en la tarea* —sin abrir ninguna pantalla— para entregarle
 * las posiciones acumuladas. Antes el `defineTask` se hacía importando el
 * módulo desde `app/_layout.tsx`, pero expo-router carga las rutas de forma
 * perezosa en release: el layout no se evalúa hasta que se renderiza, y en
 * un arranque headless no se renderiza nunca. La tarea llegaba "desconocida"
 * y el lote de posiciones se descartaba.
 *
 * Solo la app de domiciliarios la necesita. La comparación va contra
 * `process.env.EXPO_PUBLIC_APP_VARIANT` escrita tal cual —no contra una
 * constante importada— para que Metro, que inlinea la variable y luego
 * pliega constantes, elimine el `require` y el módulo entero del bundle de
 * clientes en release.
 */
import 'expo-router/entry';

if (process.env.EXPO_PUBLIC_APP_VARIANT === 'driver') {
  require('./lib/locationTask');
}
