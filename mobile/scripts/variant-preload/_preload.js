/**
 * Fija la variante a la del flavor de Gradle que está empaquetando el JS.
 *
 * Gradle no permite pasar variables de entorno a `createBundle<Flavor>...`
 * (no es una tarea `Exec`), pero sí cambiar el ejecutable de Node por
 * tarea. `build.gradle` usa `node -r scripts/variant-preload/<flavor>.cjs`,
 * y este módulo corre antes que el CLI de Expo dentro de ese proceso.
 *
 * Si el entorno ya traía la OTRA variante se aborta: significaría que
 * alguien lanzó `expo run:android --variant driverRelease` con
 * `APP_VARIANT=client` en el shell, y el bundle "eager" que el CLI genera
 * por su cuenta iría dentro del APK equivocado.
 */
module.exports = function preload(flavor) {
  const previous = process.env.APP_VARIANT || process.env.EXPO_PUBLIC_APP_VARIANT;
  if (previous && previous !== flavor) {
    throw new Error(
      `El flavor de Gradle es "${flavor}" pero el entorno trae APP_VARIANT="${previous}". ` +
        'Usa los scripts de package.json (android:client / android:driver) o limpia la variable.',
    );
  }
  process.env.APP_VARIANT = flavor;
  process.env.EXPO_PUBLIC_APP_VARIANT = flavor;
};
