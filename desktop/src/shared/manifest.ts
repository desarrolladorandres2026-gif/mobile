/**
 * La cadena de confianza de las actualizaciones del contenedor (.exe).
 *
 * `electron-updater` ya comprueba que el `.exe` descargado coincide con su
 * propio `latest.yml`, pero ese archivo lo escribe el mismo VPS que sirve
 * el archivo: un VPS comprometido podría publicar los dos a la vez. Por eso
 * hay una segunda firma, con una llave que **nunca toca el VPS**
 * (`scripts/keygen.mjs`, guardada en `%USERPROFILE%\.zipp\`): sin ella, un
 * atacante con las llaves del servidor todavía no puede firmar una versión.
 *
 * Todo esto es criptografía pura —sin `electron`— para poder probar los
 * cuatro casos que de verdad importan (válido, archivo alterado, versión
 * vieja, llave equivocada) con `vitest`, sin red ni ventana.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export interface UpdateManifest {
  version: string;
  /** Nombre del instalador, p. ej. `Zipp-Negocios-Setup-1.2.0.exe`. */
  file: string;
  /** SHA-512 del instalador, en base64. */
  sha512: string;
}

export type ManifestVerification =
  | { ok: true; manifest: UpdateManifest }
  | { ok: false; reason: string };

function parseManifest(json: string): UpdateManifest | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.version !== 'string' || !m.version) return null;
  if (typeof m.file !== 'string' || !m.file) return null;
  if (typeof m.sha512 !== 'string' || !m.sha512) return null;
  return { version: m.version, file: m.file, sha512: m.sha512 };
}

/** Compara `a` contra `b`: -1 si `a` es más vieja, 0 igual, 1 si es más nueva. Semver simple (sin pre-release). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/**
 * Verifica la firma Ed25519 del manifiesto contra la llave pública
 * incrustada en el contenedor. `manifestJson` son los bytes exactos que se
 * firmaron — no se vuelve a serializar el objeto, porque dos JSON
 * "equivalentes" pueden no ser los mismos bytes y una verificación que
 * reserializara estaría comprobando otra cosa de la que se firmó.
 */
export function verifySignedManifest(input: {
  manifestJson: string;
  signatureBase64: string;
  /**
   * Una llave, o varias durante una rotación: basta con que UNA verifique.
   * Publicar primero una versión que acepte la llave vieja y la nueva deja
   * sin varar a ninguna instalación mientras se cambia de llave.
   */
  publicKeyPem: string | readonly string[];
  currentVersion: string;
}): ManifestVerification {
  const { manifestJson, signatureBase64, publicKeyPem, currentVersion } = input;
  const publicKeys = Array.isArray(publicKeyPem) ? publicKeyPem : [publicKeyPem];
  if (publicKeys.length === 0) {
    return { ok: false, reason: 'No hay ninguna llave pública configurada' };
  }

  let signatureValid = false;
  try {
    const signatureBuffer = Buffer.from(signatureBase64, 'base64');
    const messageBuffer = Buffer.from(manifestJson, 'utf8');
    for (const pem of publicKeys) {
      const publicKey = createPublicKey(pem);
      // Ed25519 no usa un digest previo: firma el mensaje entero.
      if (verifySignature(null, messageBuffer, publicKey, signatureBuffer)) {
        signatureValid = true;
        break;
      }
    }
  } catch {
    return { ok: false, reason: 'Firma o llave pública con formato inválido' };
  }
  if (!signatureValid) {
    return { ok: false, reason: 'La firma no corresponde a este manifiesto' };
  }

  const manifest = parseManifest(manifestJson);
  if (!manifest) {
    return { ok: false, reason: 'El manifiesto firmado no tiene la forma esperada' };
  }

  // Firmado correctamente, pero por una versión vieja: bloquea que un
  // manifiesto antiguo (válido en su momento) se reproduzca para forzar
  // una degradación.
  if (!isNewerVersion(manifest.version, currentVersion)) {
    return { ok: false, reason: `El manifiesto no es más nuevo que la versión actual (${currentVersion})` };
  }

  return { ok: true, manifest };
}

/** El SHA-512 del instalador descargado coincide con el que prometió el manifiesto. */
export function verifyFileHash(fileBuffer: Buffer, expectedSha512Base64: string): boolean {
  const actual = createHash('sha512').update(fileBuffer).digest('base64');
  // Longitud fija y conocida (sha512 en base64): comparar con `===` no abre
  // un canal de tiempo útil aquí, a diferencia de comparar secretos.
  return actual === expectedSha512Base64;
}
