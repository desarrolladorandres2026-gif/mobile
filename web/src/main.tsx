import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

// Segoe UI Variable no se empaqueta: es propietaria de Microsoft y solo
// viene instalada de fábrica en Windows 11. El stack de `--font-sans` (ver
// colores.css) cae a la fuente nativa del sistema visitante si no está, sin
// pedir nada a un CDN.

import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
