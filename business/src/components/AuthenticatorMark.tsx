/**
 * Marca aproximada de Google Authenticator: anillo de cuatro colores con el
 * centro abierto. No es el asset oficial; es la misma que usa el login del
 * panel admin (`admin/src/pages/Login.tsx`). Si llega el SVG de Google, se
 * cambia en los dos.
 */
export default function AuthenticatorMark({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2a10 10 0 0 1 8.66 5L12 12z" fill="#EA4335" />
      <path d="M20.66 7A10 10 0 0 1 20.66 17L12 12z" fill="#FBBC04" />
      <path d="M20.66 17A10 10 0 0 1 3.34 17L12 12z" fill="#34A853" />
      <path d="M3.34 17A10 10 0 0 1 12 2v10z" fill="#4285F4" />
      <circle cx="12" cy="12" r="4.2" fill="var(--color-surface)" />
    </svg>
  );
}
