#!/usr/bin/env node
// ZIPP · Genera el par de llaves Ed25519 de las actualizaciones firmadas.
//
// Se ejecuta UNA SOLA VEZ, en el equipo donde se van a firmar las
// versiones — nunca en el VPS. La llave privada sale impresa por
// consola para guardarla en dos sitios (ver abajo) y nunca queda en un
// archivo que un commit distraído pueda subir por error.
//
//   node scripts/keygen.mjs
//
// Qué hacer con lo que imprime:
//   1. La llave PRIVADA va a un archivo fuera del repo, p. ej.
//      %USERPROFILE%\.zipp\update-signing-key.pem, y una copia offline
//      (USB, gestor de contraseñas) — es lo único que permite publicar una
//      versión nueva; perderla significa no poder actualizar la app nunca
//      más sin reinstalar a mano en cada comercio.
//   2. La llave PÚBLICA se incrusta en el build
//      (`ZIPP_UPDATE_PUBLIC_KEY_PEM`, ver `scripts/release.mjs` y
//      `src/main/config.ts`) y no es secreta: puede vivir en el repo o en
//      el pipeline de build sin problema.

import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

console.log('── Llave PRIVADA (guárdala fuera del repo; NUNCA al VPS) ──\n');
console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

console.log('── Llave PÚBLICA (esta sí va al build, ZIPP_UPDATE_PUBLIC_KEY_PEM) ──\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
