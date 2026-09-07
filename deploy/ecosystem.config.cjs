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

module.exports = {
  apps: [
    {
      name: 'zipp-api',
      cwd: '/var/www/zipp/backend',
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

      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // Logs: PM2 los rota si instalas pm2-logrotate (ver runbook).
      out_file: '/var/log/zipp/api.out.log',
      error_file: '/var/log/zipp/api.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
