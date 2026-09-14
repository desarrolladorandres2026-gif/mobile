import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

// Inter, única familia tipográfica de "El Trazo". Se empaqueta con la app en
// vez de pedirla a un CDN: el sitio abre igual de rápido sin internet de por
// medio y no se filtra a un tercero quién lo está usando.
import '@fontsource-variable/inter'

import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
