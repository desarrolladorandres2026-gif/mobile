import { useEffect, useRef, useState } from 'react';
import { GOOGLE_CLIENT_ID } from '../lib/config';

interface GoogleIdentity {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (response: { credential?: string }) => void;
        nonce?: string;
      }) => void;
      renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.google) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null;
      reject(new Error('No se pudo cargar Google'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/** Nonce aleatorio por render: el backend lo compara con el que firma Google. */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Botón oficial de Google Identity Services. No pinta nada si el sitio no
 * tiene `VITE_GOOGLE_CLIENT_ID`: sin esa llave el botón no podría funcionar,
 * y un botón roto es peor que ninguno.
 */
export function GoogleButton({ onToken }: { onToken: (idToken: string, nonce: string) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    const nonce = newNonce();
    loadScript()
      .then(() => {
        if (cancelled || !holder.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          nonce,
          callback: (response) => {
            if (response.credential) onToken(response.credential, nonce);
          },
        });
        window.google.accounts.id.renderButton(holder.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: 280,
        });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [onToken]);

  if (!GOOGLE_CLIENT_ID) return null;
  if (failed) return <p className="text-sm text-text-secondary">No pudimos cargar el acceso con Google. Usa tu celular.</p>;
  return <div ref={holder} className="min-h-11" />;
}
