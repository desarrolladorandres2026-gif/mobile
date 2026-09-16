import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { UserRole } from '../types';

export interface TokenPayload {
  id: string;
  role: UserRole;
  /**
   * Sesión a la que pertenece el token (`Session._id`). `authenticate` y el
   * handshake de sockets comprueban en cada uso que esa sesión siga activa,
   * así que cerrar sesión o revocarla corta también el access token vigente.
   */
  sid?: string;
}

export interface DecodedToken extends TokenPayload {
  iat?: number;
  exp?: number;
  jti?: string;
}

/**
 * Solo HS256. `jsonwebtoken` 9 ya rechaza `none` con un secreto de texto,
 * pero fijarlo explícitamente evita depender de ese detalle de la librería.
 */
const ALGORITHMS: jwt.Algorithm[] = ['HS256'];

/**
 * Momento (en segundos) en que arrancó este proceso.
 *
 * Los access tokens emitidos antes de que existiera `sid` siguen valiendo
 * hasta que caduquen solos (15 min por defecto), para no expulsar a todo el
 * mundo en el despliegue. Pero un token sin `sid` firmado *después* de
 * arrancar no puede haberlo emitido este código, así que se rechaza.
 */
export const LEGACY_ACCESS_TOKEN_CUTOFF = Math.floor(Date.now() / 1000);

/**
 * A JWT is a pure function of its payload, secret and `iat` — and `iat` has
 * only one-second resolution. Without a unique claim, two tokens minted for
 * the same user within the same second are byte-identical.
 *
 * That matters because sessions are keyed by the SHA-256 of the refresh
 * token under a unique index: identical tokens collided, so registering and
 * then logging in within the same second failed with a duplicate-key error,
 * and two devices signing in simultaneously could not both hold a session.
 *
 * `jti` makes every issued token unique.
 */
const uniqueTokenId = (): string => crypto.randomUUID();

export const generateAccessToken = (payload: TokenPayload): string => {
  return jwt.sign({ ...payload, jti: uniqueTokenId() }, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign({ ...payload, jti: uniqueTokenId() }, config.jwt.refreshSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): DecodedToken => {
  return jwt.verify(token, config.jwt.secret, { algorithms: ALGORITHMS }) as DecodedToken;
};

export const verifyRefreshToken = (token: string): DecodedToken => {
  return jwt.verify(token, config.jwt.refreshSecret, { algorithms: ALGORITHMS }) as DecodedToken;
};

/**
 * ¿Se acepta un access token sin `sid`? Solo si es anterior al arranque del
 * proceso (ver `LEGACY_ACCESS_TOKEN_CUTOFF`).
 */
export const isLegacyTokenAcceptable = (decoded: DecodedToken): boolean =>
  !decoded.sid && typeof decoded.iat === 'number' && decoded.iat < LEGACY_ACCESS_TOKEN_CUTOFF;

export const generateOTP = (): string => {
  // Cryptographically secure: Math.random() is predictable, and this code
  // guards password resets and phone verification.
  return String(crypto.randomInt(100000, 1000000));
};

export const getOTPExpiry = (): Date => {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + config.otp.expiryMinutes);
  return expiry;
};
