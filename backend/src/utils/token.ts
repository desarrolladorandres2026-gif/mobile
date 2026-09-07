import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { UserRole } from '../types';

interface TokenPayload {
  id: string;
  role: UserRole;
}

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
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign({ ...payload, jti: uniqueTokenId() }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, config.jwt.secret) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, config.jwt.refreshSecret) as TokenPayload;
};

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
