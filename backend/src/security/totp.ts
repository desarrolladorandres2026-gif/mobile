import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'crypto';

const APP_NAME = 'ZIPP';

/**
 * Generate TOTP secret and QR code for 2FA setup
 */
export async function generateTOTPSecret(
  userIdentifier: string
): Promise<{
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}> {
  const secret = speakeasy.generateSecret({
    name: `${APP_NAME} (${userIdentifier})`,
    issuer: APP_NAME,
    length: 32,
  });

  const otpauthUrl = secret.otpauth_url || '';
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  // Generate 10 recovery codes
  const recoveryCodes = generateRecoveryCodes(10);

  return {
    secret: secret.base32,
    otpauthUrl,
    qrCodeDataUrl,
    recoveryCodes,
  };
}

/**
 * Verify a TOTP token
 */
export function verifyTOTP(secret: string, token: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1, // Allow 1 step in each direction (30 seconds tolerance)
  });
}

/**
 * Generate one-time recovery codes
 */
function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    // Format: XXXX-XXXX
    codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}`);
  }
  return codes;
}

/**
 * Hash recovery codes for storage
 */
export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((code) =>
    crypto.createHash('sha256').update(code.replace('-', '').toUpperCase()).digest('hex')
  );
}

/**
 * Verify a recovery code
 */
export function verifyRecoveryCode(
  code: string,
  hashedCodes: string[]
): { valid: boolean; index: number } {
  const hash = crypto
    .createHash('sha256')
    .update(code.replace('-', '').toUpperCase())
    .digest('hex');

  const index = hashedCodes.indexOf(hash);
  return {
    valid: index !== -1,
    index,
  };
}
