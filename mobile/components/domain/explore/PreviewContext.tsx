import { createContext, useContext, type ReactNode } from 'react';

/**
 * Si lo que se está pintando es la vista previa del constructor (dentro de
 * un iframe del panel) y no la app de verdad.
 *
 * En vista previa nada navega —la pantalla vive sola dentro del marco del
 * teléfono, sin sesión ni pila de navegación— y, sobre todo, **no se
 * registran impresiones ni clics de anuncios**: cada vez que un admin mira
 * la vista previa le estaría cobrando a un anunciante.
 */
const PreviewContext = createContext(false);

export function PreviewProvider({ children }: { children: ReactNode }) {
  return <PreviewContext.Provider value>{children}</PreviewContext.Provider>;
}

export function usePreviewMode(): boolean {
  return useContext(PreviewContext);
}
