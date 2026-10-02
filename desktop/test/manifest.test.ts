import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as signMessage, createHash } from 'node:crypto';
import { verifySignedManifest, isNewerVersion, verifyFileHash, compareVersions } from '../src/shared/manifest';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signManifest(manifestJson: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  return signMessage(null, Buffer.from(manifestJson, 'utf8'), privateKey).toString('base64');
}

/**
 * La segunda firma de las actualizaciones (ver `shared/manifest.ts`): estos
 * son justo los cuatro casos que un VPS comprometido, o un instalador
 * interceptado, pondrían a prueba.
 */
describe('Verificación del manifiesto de actualización', () => {
  it('un manifiesto válido, más nuevo, firmado con la llave correcta, se acepta', () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const manifestJson = JSON.stringify({ version: '1.2.0', file: 'Zipp-Negocios-Setup-1.2.0.exe', sha512: 'abc123==' });
    const signatureBase64 = signManifest(manifestJson, privateKey);

    const result = verifySignedManifest({ manifestJson, signatureBase64, publicKeyPem, currentVersion: '1.1.0' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.version).toBe('1.2.0');
  });

  it('un manifiesto alterado tras firmarse (un solo byte) se rechaza', () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const manifestJson = JSON.stringify({ version: '1.2.0', file: 'setup.exe', sha512: 'abc==' });
    const signatureBase64 = signManifest(manifestJson, privateKey);
    const tampered = manifestJson.replace('1.2.0', '9.9.9');

    const result = verifySignedManifest({ manifestJson: tampered, signatureBase64, publicKeyPem, currentVersion: '1.1.0' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('firma') });
  });

  it('una versión igual o más vieja se rechaza aunque la firma sea válida (anti-degradación)', () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const manifestJson = JSON.stringify({ version: '1.0.0', file: 'setup.exe', sha512: 'abc==' });
    const signatureBase64 = signManifest(manifestJson, privateKey);

    expect(verifySignedManifest({ manifestJson, signatureBase64, publicKeyPem, currentVersion: '1.1.0' }).ok).toBe(false);
    expect(verifySignedManifest({ manifestJson, signatureBase64, publicKeyPem, currentVersion: '1.0.0' }).ok).toBe(false);
  });

  it('una firma hecha con otra llave (VPS comprometido sin la llave privada) se rechaza', () => {
    const { privateKey } = makeKeyPair();
    const { publicKeyPem: otherPublicKeyPem } = makeKeyPair();
    const manifestJson = JSON.stringify({ version: '1.2.0', file: 'setup.exe', sha512: 'abc==' });
    const signatureBase64 = signManifest(manifestJson, privateKey);

    const result = verifySignedManifest({
      manifestJson,
      signatureBase64,
      publicKeyPem: otherPublicKeyPem,
      currentVersion: '1.1.0',
    });
    expect(result.ok).toBe(false);
  });

  it('un manifiesto con forma inválida, aunque la firma sea técnicamente válida sobre ese texto, se rechaza', () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const manifestJson = JSON.stringify({ version: '1.2.0' }); // sin file ni sha512
    const signatureBase64 = signManifest(manifestJson, privateKey);

    const result = verifySignedManifest({ manifestJson, signatureBase64, publicKeyPem, currentVersion: '1.1.0' });
    expect(result.ok).toBe(false);
  });

  it('rotación de llave: firmado con la vieja o la nueva, ambas se aceptan mientras dura la transición', () => {
    const oldKey = makeKeyPair();
    const newKey = makeKeyPair();
    const manifestJson = JSON.stringify({ version: '2.0.0', file: 'setup.exe', sha512: 'abc==' });
    const signedWithOld = signManifest(manifestJson, oldKey.privateKey);
    const signedWithNew = signManifest(manifestJson, newKey.privateKey);
    const bothKeys = [oldKey.publicKeyPem, newKey.publicKeyPem];

    expect(verifySignedManifest({ manifestJson, signatureBase64: signedWithOld, publicKeyPem: bothKeys, currentVersion: '1.0.0' }).ok).toBe(true);
    expect(verifySignedManifest({ manifestJson, signatureBase64: signedWithNew, publicKeyPem: bothKeys, currentVersion: '1.0.0' }).ok).toBe(true);

    // Terminada la rotación, solo la nueva queda activa.
    expect(verifySignedManifest({ manifestJson, signatureBase64: signedWithOld, publicKeyPem: [newKey.publicKeyPem], currentVersion: '1.0.0' }).ok).toBe(false);
  });

  it('compareVersions e isNewerVersion ordenan semver simple', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(isNewerVersion('1.2.1', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false);
  });

  it('verifyFileHash distingue el archivo correcto de uno alterado', () => {
    const file = Buffer.from('contenido del instalador');
    const correctHash = createHash('sha512').update(file).digest('base64');

    expect(verifyFileHash(file, correctHash)).toBe(true);
    expect(verifyFileHash(Buffer.concat([file, Buffer.from('x')]), correctHash)).toBe(false);
  });
});
