import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // El prefijo `_` ya es la forma convencional de decir "este
      // parámetro existe por la firma y no se usa". Sin esta regla, la
      // única salida era borrar el parámetro —cambiando la firma— o
      // silenciar la regla en cada sitio, que es peor.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Aviso, no error — y conviene explicar por qué, porque bajar la
      // severidad de una regla es una decisión que hay que poder defender.
      //
      // Lo que señala es real: `useEffect(() => { cargar(); }, [cargar])`
      // con un `setLoading(true)` síncrono dentro provoca un render de
      // más al montar. Lo que NO es, es un fallo: `loading` ya arranca en
      // `true`, así que React descarta ese render por valor idéntico, y
      // ninguna de estas pantallas hace nada visible con el segundo.
      //
      // La solución que la regla espera no es reescribir el efecto: es
      // dejar de pedir datos a mano y usar una librería de fetching.
      // `@tanstack/react-query` ya está instalada en el panel de admin,
      // así que la migración es el camino de verdad — pero es un refactor
      // de quince pantallas y no se hace de paso en una auditoría.
      //
      // Mientras tanto: en aviso queda a la vista de quien mire el lint y
      // no bloquea la integración continua por una deuda de estilo. Si se
      // sube a 'error' sin migrar, lo único que se consigue es que alguien
      // ponga veinte `eslint-disable-next-line`, que es estrictamente peor
      // porque entonces deja de verse.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
