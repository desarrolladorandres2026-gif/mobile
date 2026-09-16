import mongoose, { Schema, Document } from 'mongoose';

/**
 * Defensas contra la reutilización de credenciales de Google y Apple.
 *
 * Un `id_token` firmado por el proveedor es válido hasta que caduca (una hora
 * en Google, diez minutos en Apple): quien lo interceptara podía presentarlo
 * de nuevo en `POST /auth/google` o `/auth/apple` y entrar. Estos dos
 * registros cierran esa puerta.
 */

// ── Tokens de identidad ya usados ─────────────────────────────────────

export interface IUsedIdentityToken extends Document {
  provider: 'google' | 'apple';
  /** SHA-256 del token: nunca se guarda el token. */
  tokenHash: string;
  /** Caducidad del propio token; pasada esa fecha ya no hay nada que proteger. */
  expiresAt: Date;
}

const usedIdentityTokenSchema = new Schema<IUsedIdentityToken>(
  {
    provider: { type: String, enum: ['google', 'apple'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const UsedIdentityToken = mongoose.model<IUsedIdentityToken>('UsedIdentityToken', usedIdentityTokenSchema);

// ── Código de intercambio del callback de Apple ───────────────────────

/**
 * Apple solo acepta un `redirect_uri` HTTPS, así que su `form_post` llega al
 * backend y de ahí hay que volver a la app por el deep link `zipp://`.
 * Antes el `id_token` viajaba en la query de ese deep link, y cualquier app
 * que registrara el mismo esquema podía quedárselo.
 *
 * Ahora el deep link solo lleva un código de un solo uso que vive dos
 * minutos. Canjearlo exige además el `nonce` en claro que generó la app, y
 * cuyo hash va firmado dentro del `id_token`: una app que intercepte el deep
 * link tiene el código pero no el nonce, así que no puede canjearlo.
 *
 * El `id_token` se guarda aquí por esos dos minutos. No es una credencial
 * utilizable por quien lea la base: sin el nonce en claro, que nunca llega al
 * servidor hasta el canje, `POST /auth/apple` lo rechaza.
 */
export interface IAppleAuthCode extends Document {
  codeHash: string;
  idToken: string;
  fullName?: string;
  expiresAt: Date;
}

const appleAuthCodeSchema = new Schema<IAppleAuthCode>(
  {
    codeHash: { type: String, required: true, unique: true },
    idToken: { type: String, required: true },
    fullName: { type: String, maxlength: 100 },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const AppleAuthCode = mongoose.model<IAppleAuthCode>('AppleAuthCode', appleAuthCodeSchema);
