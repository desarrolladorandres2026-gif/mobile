import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Source Sans 3 (OFL) se empaqueta con @fontsource: sale del mismo origen, sin
// pedir nada a un CDN. Solo los pesos 400 y 600 que fija el sistema de diseño.
import '@fontsource/source-sans-3/400.css'
import '@fontsource/source-sans-3/600.css'

import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
 <StrictMode>
 <App />
 </StrictMode>,
)

