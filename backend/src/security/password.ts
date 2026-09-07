import argon2 from 'argon2';

// ── Argon2id Configuration (OWASP recommended) ──
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,     // 64 MB
  timeCost: 3,            // 3 iterations
  parallelism: 4,         // 4 threads
  hashLength: 32,         // 32 bytes
};

/**
 * Hash password using Argon2id with unique salt (auto-generated)
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, ARGON2_OPTIONS);
}

/**
 * Verify password against Argon2id hash
 */
export async function verifyPassword(
  hash: string,
  plainPassword: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainPassword);
  } catch {
    return false;
  }
}

// ── Password Complexity Policy ──

export interface PasswordPolicyResult {
  valid: boolean;
  errors: string[];
}

export function validatePasswordComplexity(password: string): PasswordPolicyResult {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('La contraseña debe tener al menos 8 caracteres');
  }
  if (password.length > 128) {
    errors.push('La contraseña no puede exceder 128 caracteres');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('La contraseña debe contener al menos una letra mayúscula');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('La contraseña debe contener al menos una letra minúscula');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('La contraseña debe contener al menos un número');
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('La contraseña debe contener al menos un carácter especial');
  }

  // Check common passwords
  const commonPasswords = [
    'password', '12345678', '123456789', 'qwerty', 'abc12345',
    'password1', 'iloveyou', '1234567890', 'admin123',
  ];
  if (commonPasswords.includes(password.toLowerCase())) {
    errors.push('La contraseña es demasiado común');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
