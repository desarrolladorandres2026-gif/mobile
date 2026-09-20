/**
 * Las reglas que el servidor exige a una contraseña nueva
 * (`validatePasswordComplexity` en backend/src/security/password.ts).
 *
 * `validatePassword` de `lib/errors.ts` solo pide 6 caracteres porque sirve
 * también para el login, donde hay cuentas con contraseñas anteriores a la
 * regla. Para *crear* una contraseña se muestran estas, en vivo, en vez de
 * enterarse al final por un error del servidor.
 */
export const PASSWORD_RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: 'Al menos 8 caracteres', test: (p) => p.length >= 8 },
  { label: 'Una mayúscula', test: (p) => /[A-Z]/.test(p) },
  { label: 'Una minúscula', test: (p) => /[a-z]/.test(p) },
  { label: 'Un número', test: (p) => /[0-9]/.test(p) },
  { label: 'Un símbolo (!@#$…)', test: (p) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(p) },
];

export const meetsPasswordRules = (password: string) => PASSWORD_RULES.every((r) => r.test(password));
