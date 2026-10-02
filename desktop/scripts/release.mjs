#!/usr/bin/env node
// ZIPP · Publica una versión nueva de Zipp Negocios en el VPS.
//
//   node scripts/release.mjs
//
// Requiere (variables de entorno):
//   ZIPP_UPDATE_SIGNING_KEY_PATH  ruta al .pem de la llave PRIVADA (keygen.mjs; nunca en el repo)
//   ZIPP_PANEL_URL                https://comercios.<dominio>
//   ZIPP_API_URL                  https://api.<dominio>/api/v1 (solo para GET /app/version)
//   ZIPP_UPDATE_FEED_URL          https://descargas.<dominio>/negocios
//   ZIPP_UPDATE_PUBLIC_KEY_PEM    la llave pública, para incrustarla en el build
//   ZIPP_VPS_HOST                por defecto root@<ip>, como en publish-from-local.sh
//   ZIPP_SSH_KEY                 por defecto ~/.ssh/zipp_vps
//   ZIPP_DOWNLOADS_REMOTE_DIR    por defecto /var/www/zipp-downloads/negocios
//
// NO se ejecuta como parte de ningún deploy automático: publicar un
// instalador nuevo es una decisión consciente, igual que una migración de
// base de datos. Mientras no exista `descargas.<dominio>` (Fase 0.1 del
// plan), esto se queda en "falta ZIPP_UPDATE_FEED_URL" y no publica nada.

import { execFileSync } from 'node:child_process';
import { createHash, sign as signEd25519 } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP_DIR = path.join(ROOT, '.release-tmp');

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function shCapture(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT }).toString().trim();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ Falta ${name}. Ver la cabecera de este script.`);
    process.exit(1);
  }
  return value;
}

function sign(message, privateKeyPem) {
  // Ed25519 no usa un digest previo: firma el mensaje entero, igual que la
  // verificación en `src/shared/manifest.ts`.
  return signEd25519(null, Buffer.from(message, 'utf8'), privateKeyPem).toString('base64');
}

function main() {
  const dirtyDesktop = shCapture('git', ['status', '--porcelain', '--', 'desktop']);
  if (dirtyDesktop) {
    console.error('✗ desktop/ tiene cambios sin confirmar. Confirma o descarta antes de publicar.');
    process.exit(1);
  }

  const signingKeyPath = requireEnv('ZIPP_UPDATE_SIGNING_KEY_PATH');
  const panelUrl = requireEnv('ZIPP_PANEL_URL');
  const apiUrl = requireEnv('ZIPP_API_URL');
  const updateFeedUrl = requireEnv('ZIPP_UPDATE_FEED_URL');
  const updatePublicKeyPem = requireEnv('ZIPP_UPDATE_PUBLIC_KEY_PEM');
  const vpsHost = process.env.ZIPP_VPS_HOST || 'root@45.93.100.122';
  const sshKey = process.env.ZIPP_SSH_KEY || path.join(process.env.HOME || process.env.USERPROFILE, '.ssh', 'zipp_vps');
  const remoteDir = process.env.ZIPP_DOWNLOADS_REMOTE_DIR || '/var/www/zipp-downloads/negocios';

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  console.log(`── Publicando Zipp Negocios ${pkg.version} ──`);

  // 2 — build + empaquetado. Las variables llegan a `src/main/config.ts` vía `process.env`.
  sh('npx', ['tsc', '-p', 'tsconfig.json'], {
    env: {
      ...process.env,
      ZIPP_PANEL_URL: panelUrl,
      ZIPP_API_URL: apiUrl,
      ZIPP_UPDATE_FEED_URL: updateFeedUrl,
      ZIPP_UPDATE_PUBLIC_KEY_PEM: updatePublicKeyPem,
    },
  });
  sh('npx', ['electron-builder', '--win', '--x64', '--publish', 'never']);

  const releaseDir = path.join(ROOT, 'release');
  const files = readdirSync(releaseDir);
  const installer = files.find((f) => f.endsWith('.exe'));
  const blockmap = files.find((f) => f.endsWith('.exe.blockmap'));
  const latestYml = files.find((f) => f === 'latest.yml');
  if (!installer || !latestYml) {
    console.error('✗ electron-builder no dejó el instalador o latest.yml en release/. Revisa electron-builder.yml.');
    process.exit(1);
  }

  // 3 — manifiesto firmado, aparte del latest.yml que ya firma electron-updater internamente.
  const installerPath = path.join(releaseDir, installer);
  const sha512 = createHash('sha512').update(readFileSync(installerPath)).digest('base64');
  const manifestJson = JSON.stringify({ version: pkg.version, file: installer, sha512 });
  const signatureBase64 = sign(manifestJson, readFileSync(signingKeyPath, 'utf8'));

  console.log(`── Instalador: ${installer} (${(statSync(installerPath).size / 1e6).toFixed(1)} MB) ──`);

  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path.join(TMP_DIR, 'release.json'), manifestJson, 'utf8');
  writeFileSync(path.join(TMP_DIR, 'release.json.sig'), signatureBase64, 'utf8');

  // 4-6 — subir a un directorio de paso y mover de forma atómica, con
  // `latest.yml` al final (el mismo orden que `swap-spa.sh` usa para el
  // panel, y por la misma razón: electron-updater no debe ver `latest.yml`
  // apuntando a un `.exe` que aún no terminó de llegar).
  const sshv = (cmd) => sh('ssh', ['-i', sshKey, '-o', 'StrictHostKeyChecking=accept-new', vpsHost, cmd]);
  const scp = (local, remote) => sh('scp', ['-i', sshKey, '-o', 'StrictHostKeyChecking=accept-new', local, `${vpsHost}:${remote}`]);

  const staging = `${remoteDir}/.staging-${pkg.version}`;
  sshv(`mkdir -p '${staging}'`);
  scp(installerPath, `${staging}/${installer}`);
  if (blockmap) scp(path.join(releaseDir, blockmap), `${staging}/${blockmap}`);
  scp(path.join(TMP_DIR, 'release.json'), `${staging}/release.json`);
  scp(path.join(TMP_DIR, 'release.json.sig'), `${staging}/release.json.sig`);

  sshv(
    [
      `mv '${staging}/${installer}' '${remoteDir}/${installer}'`,
      blockmap ? `mv '${staging}/${blockmap}' '${remoteDir}/${blockmap}'` : null,
      `mv '${staging}/release.json' '${remoteDir}/release.json'`,
      `mv '${staging}/release.json.sig' '${remoteDir}/release.json.sig'`,
      // El alias estable es para la guía de instalación inicial (Fase 7):
      // un enlace que no cambia de nombre con cada versión.
      `cp '${remoteDir}/${installer}' '${remoteDir}/Zipp-Negocios-Setup.exe'`,
      `rmdir '${staging}'`,
    ]
      .filter(Boolean)
      .join(' && ')
  );

  // `latest.yml` va al final: hasta aquí, electron-updater de los clientes
  // instalados no ve ninguna versión nueva todavía.
  scp(path.join(releaseDir, latestYml), `${remoteDir}/latest.yml`);

  // 7 — conservar solo las 3 últimas versiones.
  sshv(`cd '${remoteDir}' && ls -1t *.exe 2>/dev/null | grep -v Zipp-Negocios-Setup.exe | tail -n +4 | xargs -r rm -f`);

  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`✓ Publicado: ${installer}`);
}

main();
