const fs = require('fs');
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withDangerousMod } = require('expo/config-plugins');

/**
 * Deja escrita la variante de la app para las fases de build de Xcode.
 *
 * En Android la variante llega al bundle por el ejecutable de Node que
 * `build.gradle` fija en cada tarea. En iOS el equivalente es
 * `ios/.xcode.env.local`: el script "Bundle React Native code and images"
 * hace `source` de ese archivo antes de empaquetar, igual que los de
 * expo-constants y expo-updates. Sin esto, compilar desde Xcode (o un
 * Archive, que no pasa por la terminal) usaría la variante por defecto y
 * el IPA de domiciliarios llevaría dentro el JavaScript de clientes.
 *
 * `ios/` está gitignoreado y se regenera con `npm run prebuild:ios:client`
 * o `:driver`, así que el archivo siempre corresponde al último prebuild.
 */
module.exports = function withXcodeEnvVariant(config, { variant } = {}) {
  const value = variant ?? 'client';

  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, '.xcode.env.local');
      const header =
        '# Generado por plugins/withXcodeEnvVariant.js en cada prebuild.\n' +
        '# No editar a mano: se reescribe. Ver package.json > prebuild:ios:*\n';
      const body = `export APP_VARIANT=${value}\nexport EXPO_PUBLIC_APP_VARIANT=${value}\n`;

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, header + body, 'utf8');
      return cfg;
    },
  ]);
};
