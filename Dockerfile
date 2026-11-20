# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Fuentes para que sharp/librsvg pueda renderizar el texto del recibo (SVG->PNG).
# Sin esto, el texto sale como cuadritos (tofu) en Alpine.
RUN apk add --no-cache fontconfig ttf-dejavu ttf-liberation && fc-cache -f

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Entorno de la app (qa, main/prod, ...). Se pasa como build-arg desde el
# Makefile/CI: `docker build --build-arg APP_ENV=qa`. Queda disponible en
# runtime como APP_ENV para diferenciar la imagen y en logs/health.
ARG APP_ENV=production
ENV APP_ENV=${APP_ENV}

ENV PORT=3001
ENV NODE_ENV=production
# Tope del heap de V8 por debajo de los 512 MB del plan Starter de Render: el GC
# trabaja antes y, si aun así se llena, Node escribe "heap out of memory" en
# los logs en vez de que el contenedor muera sin dejar rastro. Si se sube de
# plan, sobreescribir NODE_OPTIONS en las variables de entorno de Render.
ENV NODE_OPTIONS=--max-old-space-size=384

EXPOSE ${PORT}

CMD ["node", "dist/main"]
