// ZIPP · electron-builder afterPack — apaga los fuses de Electron.
//
// Sin esto, el propio binario de Electron empaquetado puede ejecutarse como
// un intérprete de Node cualquiera (`Zipp Negocios.exe some-script.js`) — un
// LOLBin: un binario firmado y de aspecto confiable que, en manos de quien
// ya tenga acceso al equipo, sirve para correr código arbitrario sin que el
// antivirus lo marque como sospechoso. Apagar `runAsNode` cierra esa puerta.
//
// `onlyLoadAppFromAsar` + `embeddedAsarIntegrityValidation`: el `.exe` solo
// carga el código empaquetado en su propio `app.asar` firmado al construir
// el instalador, nunca uno sustituido en el disco después de instalar.
//
// Corre DESPUÉS de que electron-builder arma la carpeta sin empaquetar
// (`asar: false` sería otra historia; con el default `asar: true` el fuse
// de integridad sí tiene algo que verificar). electron-builder lo invoca
// como una función Node normal — no un script de CLI — así que exporta la
// función, nunca ejecuta nada por su cuenta.
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EmbeddedAsarIntegrityValidation]: true,
  });
};
