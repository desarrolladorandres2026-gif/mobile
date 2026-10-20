/**
 * Paleta y tipografía centralizadas de Lulubiz.
 * Azul: interacción. Verde y rojo: solo resultado positivo y error o atención.
 * El texto secundario conserva contraste suficiente: no hay grises deslavados.
 */
export default {
  theme: {
    extend: {
      colors: {
        azul: { DEFAULT: '#1b4f9c', oscuro: '#143c78', suave: '#e6edf8' },
        verde: { DEFAULT: '#1e7b4a', suave: '#e3f2ea' },
        rojo: { DEFAULT: '#b3261e', oscuro: '#8f1e18', suave: '#fbe9e7' },
        papel: { DEFAULT: '#ffffff', fondo: '#f3f5f8' },
        borde: { DEFAULT: '#c4ccd8', fuerte: '#8f9bad' },
        tinta: { DEFAULT: '#1a2230', segundo: '#3b4658' },
      },
      fontFamily: {
        sans: ['"Segoe UI Variable"', '"Segoe UI"', 'system-ui', '-apple-system', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
    },
  },
};
