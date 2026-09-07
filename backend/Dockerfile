# ZIPP — API REST + WebSockets
#
# Imagen multi-etapa. La compilación necesita TypeScript y todo el
# `devDependencies`; la ejecución no necesita nada de eso, y arrastrarlo a
# la imagen final solo aumenta la superficie de ataque y el tamaño de lo
# que hay que descargar en cada despliegue.

# ── Etapa 1: dependencias de compilación ─────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Los manifiestos van antes que el código a propósito: mientras no cambien,
# Docker reutiliza la capa de `npm ci` y una edición de código no vuelve a
# descargar el árbol de dependencias entero.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Etapa 2: solo lo que hace falta para ejecutar ────────────────────
FROM node:22-alpine AS runtime

# `dumb-init` es PID 1. Node como PID 1 no reenvía las señales a sus hijos
# ni recoge procesos zombis, y sin eso el `SIGTERM` que manda el orquestador
# nunca llega al apagado ordenado de `app.ts` — el contenedor se mata a los
# 10 segundos con las conexiones abiertas a media petición.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# La PWA se sirve como estático desde `../public/pwa` relativo a `dist/`
# (ver app.ts). Es opcional —solo existe tras `npm run build:pwa` en el
# monorepo— y por eso el patrón lleva comodín: sin él, un repo sin PWA
# compilada rompería la construcción de la imagen.
COPY public* ./public/

# El proceso no corre como root. La imagen de Node ya trae el usuario
# `node`, así que no hay que crearlo; lo que sí hace falta es que sea el
# dueño de lo que va a leer.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# El mismo endpoint que ya comprueba la conexión con Mongo y devuelve 503
# cuando está caída: un contenedor que responde pero no puede leer la base
# de datos no está sano, y sin esto el balanceador le seguiría mandando
# tráfico.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/app.js"]
