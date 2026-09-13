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

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE ${PORT}

CMD ["node", "dist/main"]
