// ZIPP · PM2 · proceso de la API en producción
//
//   pm2 start deploy/ecosystem.config.cjs --env production
//   pm2 save                       # persiste la lista de procesos
//   pm2 startup systemd            # genera el unit que la resucita al reiniciar
//
// Por qué fork y no cluster:
//   Socket.IO con varias instancias necesita sticky sessions y un adapter
//   compartido (Redis) para que dos sockets del mismo cliente no acaben en
//   workers distintos. Nada de eso está montado, así que una sola instancia
//   en modo fork es lo correcto hasta que el tráfico lo justifique.
//
// El .env lo lee la propia app con dotenv desde `cwd`, no PM2. Aquí solo
// forzamos NODE_ENV por si el .env se quedara sin él.

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'zipp-api',
      // Derivada de dónde vive este archivo, no escrita a mano: el mismo
      // config sirve en /var/www/zipp y en un árbol de staging como
      // /var/www/zipp-next. Una ruta fija obligaría a editar el archivo
      // justo durante el cambio, que es el peor momento para tocarlo.
      cwd: path.join(__dirname, '..', 'backend'),
      script: 'dist/app.js',
      exec_mode: 'fork',
      instances: 1,

      // Reinicio por fuga de memoria. El proceso ronda 80-150 MB sano;
      // 500 MB es "algo va mal, recíclalo" sin cortar peticiones a mano.
      max_memory_restart: '500M',

      // Backoff ante crashes en bucle (p. ej. Atlas caído): no martillear.
      exp_backoff_restart_delay: 200,
      max_restarts: 10,
      min_uptime: '20s',

      // app.ts atiende SIGINT y cierra el HTTP server + Mongo antes de salir.
      // Estos márgenes le dan tiempo a drenar peticiones en curso.
      kill_timeout: 12000,
      shutdown_with_message: false,

      // UV_THREADPOOL_SIZE: Argon2 (login), gzip y parte de crypto corren en
      // el pool de hilos de libuv, que por defecto tiene 4. Con cuatro
      // inicios de sesión a la vez (64 MB y ~0,5 s cada uno) el pool se
      // llena y la compresión de todas las demás respuestas espera en cola.
      // Tiene que fijarse antes de arrancar el proceso: por eso va aquí y
      // no en el .env.
      env: {
        NODE_ENV: 'development',
        UV_THREADPOOL_SIZE: '16',
      },
      env_production: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '16',
      },

      // Logs: PM2 los rota si instalas pm2-logrotate (ver runbook).
      out_file: '/var/log/zipp/api.out.log',
      error_file: '/var/log/zipp/api.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
