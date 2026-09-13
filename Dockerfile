# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --legacy-peer-deps

FROM base AS builder
# Se "hornea" en el bundle del cliente en build time, no en runtime.
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_META_APP_ID
ARG NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID
ENV NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ENV NEXT_PUBLIC_META_APP_ID=$NEXT_PUBLIC_META_APP_ID
ENV NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID=$NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
# node_modules completo (incluye el CLI de prisma con todas sus dependencias,
# necesario para correr `prisma migrate deploy` al iniciar el contenedor).
# El paso siguiente pisa encima los archivos ya podados/optimizados que
# Next.js "standalone" traza para el server en sí.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# El worker de BullMQ (Fase 3) corre como proceso aparte del server web, vía
# tsx directo sobre el código fuente (no pasa por el build "standalone" de
# Next, que solo empaqueta lo que usan las rutas HTTP).
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Punto de montaje del volumen de archivos subidos (fotos de catálogo,
# comprobantes): se crea con el dueño correcto para que el proceso
# (corriendo como "nextjs") pueda escribir ahí.
RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
