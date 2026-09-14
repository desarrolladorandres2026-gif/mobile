export type PasswordStrength = 0 | 1 | 2 | 3;

/**
 * TODO(usuario): define qué hace fuerte a una contraseña en Zipp.
 *
 * El mínimo del sistema sigue siendo 6 caracteres (ver `validatePassword` en
 * `lib/errors.ts`); esta función solo alimenta la barra visual que ve el
 * usuario mientras escribe, para animarlo a ir más allá del mínimo.
 *
 * De momento solo mira la longitud. Vale la pena sumar: mezcla de mayúsculas/
 * números/símbolos, o rechazar contraseñas obvias ("123456", "contraseña").
 */
export function scorePasswordStrength(password: string): PasswordStrength {
  if (password.length < 6) return 0;
  if (password.length < 8) return 1;
  return 2;
}

export const PASSWORD_STRENGTH_LABEL: Record<PasswordStrength, string> = {
  0: 'Muy corta',
  1: 'Aceptable',
  2: 'Buena',
  3: 'Fuerte',
};
