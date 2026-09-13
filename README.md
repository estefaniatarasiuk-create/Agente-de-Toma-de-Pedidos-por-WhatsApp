# Pedidos WhatsApp

Plataforma web de toma de pedidos por WhatsApp para empresas de delivery de
comida (Argentina). Una IA conversa con el consumidor final por WhatsApp,
arma el pedido, valida domicilio/zona/horarios/pagos contra reglas duras
configuradas por la empresa, y lo deja listo para preparación en un tablero
de gestión.

Especificación funcional de referencia: `Especificación de Pedidos por
WhatsApp` (ver historias de usuario E1–E11).

## Stack

- **Frontend + Backend**: Next.js 16 (App Router) + TypeScript.
- **Base de datos**: PostgreSQL + Prisma ORM (driver adapter `@prisma/adapter-pg`).
- **Jobs/timers**: BullMQ + Redis (se incorpora en Fase 3).
- **WhatsApp**: Meta WhatsApp Cloud API (se incorpora en Fase 2).
- **IA conversacional**: OpenAI o Anthropic, configurable por variable de entorno (se incorpora en Fase 3).
- **Mapas/geocodificación**: Google Maps Geocoding API (se incorpora en Fase 1).
- **Auth**: email + contraseña con sesiones JWT (Auth.js / NextAuth v5).
- **Deploy local/dev**: docker-compose (app + Postgres + Redis).

## Estado del proyecto

- [x] **Fase 0** — Esqueleto: repo, docker-compose, schema Prisma completo, auth, layout base.
- [ ] Fase 1 — Configuración del negocio (catálogo, horarios, zona, IA, medios de pago).
- [ ] Fase 2 — Vinculación de WhatsApp (Embedded Signup, webhooks).
- [ ] Fase 3 — Motor de pedidos (máquina de estados, IA, comprobante).
- [ ] Fase 4 — Operación (tablero, conversaciones en vivo).
- [ ] Fase 5 — Métricas y cierre.

## Setup

### Requisitos

- Node.js 22+
- Docker y Docker Compose (para levantar Postgres y Redis localmente)

### Variables de entorno

```bash
cp .env.example .env
```

Completá al menos:

- `AUTH_SECRET`: `openssl rand -base64 32`
- Las credenciales de Postgres si querés cambiar las de ejemplo.

### Levantar todo con Docker Compose

```bash
docker compose up --build
```

Esto levanta Postgres, Redis y la app (corre `prisma migrate deploy` al
iniciar). La app queda disponible en `http://localhost:3000`.

### Desarrollo local (sin dockerizar la app)

```bash
docker compose up -d postgres redis
npm install
npm run db:migrate   # aplica las migraciones (crea una nueva si el schema cambió)
npm run dev
```

La app queda en `http://localhost:3000`.

### Verificación de la Fase 0

1. `docker compose up --build` levanta los 3 servicios sin errores.
2. Entrar a `http://localhost:3000` sin sesión → redirige a `/login`.
3. Ir a `/registro`, crear una cuenta con nombre de empresa, email y
   contraseña → se crea `Company` + `Branch` (única, con el nombre de la
   empresa) + `User` (rol `ADMIN`), inicia sesión automáticamente y entra al
   home del panel.
4. El home muestra el nombre de la empresa, la sucursal, y un checklist de
   pasos de configuración pendientes (todos sin marcar en un alta nueva).
5. La navegación lateral expone las secciones de todas las épicas
   (Catálogo, Horarios, Zona de entrega, Medios de pago, IA, WhatsApp,
   Pedidos, Conversaciones, Métricas); las que todavía no se construyeron
   muestran "Esta sección se construye en la Fase X".
6. Cerrar sesión desde el botón del panel → vuelve a `/login`; intentar
   entrar a una URL protegida sin sesión redirige a `/login`.
7. `npm run lint` y `npm run build` corren sin errores.

## Decisiones tomadas

- **Multi-sucursal en el modelo, no en la UI**: el schema de Prisma modela
  `Company` → `Branch[]` y toda tabla de negocio lleva `companyId` y
  `branchId` (arquitectura multi-tenant desde el día 1), pero por indicación
  explícita del encargo el producto opera con **una sola sucursal por
  cuenta**: al registrarse se crea automáticamente una única `Branch` (con
  el nombre de la empresa) y no hay UI para administrar varias sucursales.
  Esto deja la puerta abierta a multi-sucursal a futuro sin migrar datos,
  aunque el alcance actual de E8 (roles por sucursal, copiar configuración
  entre sucursales, alta de sucursales adicionales) no se construye.
- **Circuito del comprobante: 45/60 minutos por defecto.** La
  especificación funcional (§3.4) menciona 15 minutos para el recordatorio
  y 30 para la cancelación automática; el encargo indicó explícitamente
  45/60 minutos como default configurable por sucursal. Ante ese conflicto
  explícito se usó 45/60 (`Branch.receiptReminderMinutes` /
  `receiptCancelMinutes`), siguiendo la regla de resolución de conflictos:
  el docx manda salvo que el encargo diga explícitamente lo contrario.
- **Prisma 7**: la versión estable actual requiere mover la connection
  string fuera de `schema.prisma`. Se usa `prisma.config.ts` (leído por
  Prisma Migrate) más el driver adapter `@prisma/adapter-pg` en
  `src/lib/prisma.ts` (leído por `PrismaClient` en tiempo de ejecución).
  Ambos toman la misma `DATABASE_URL`.
- **Dinero en centavos**: todos los montos (`priceCents`, `totalCents`,
  etc.) se guardan como enteros en centavos para evitar errores de
  redondeo de punto flotante. El formato de visualización (`$ 1.234,56`)
  se resuelve con `Intl.NumberFormat("es-AR", { style: "currency",
  currency: "ARS" })` (helper en `src/lib/money.ts`).
- **Sesión de alta creada de una**: la sucursal única se crea en la misma
  transacción que la empresa y el usuario admin al registrarse (no hay un
  paso separado de "creá tu primera sucursal"), ya que US1.1 solo pide
  nombre de empresa, email y contraseña.
- **Sin adapter de base de datos para NextAuth**: se usa `CredentialsProvider`
  con estrategia de sesión JWT y una tabla `User` propia (con
  `passwordHash` vía `bcryptjs`), sin el adapter de Prisma para Auth.js.
  Es el patrón estándar para credenciales email/contraseña y evita tablas
  de sesión/cuenta innecesarias para OAuth que no se usa.
- **Middleware → Proxy**: Next.js 16 renombró la convención de
  `middleware.ts` a `proxy.ts`; se usa `src/proxy.ts` para evitar el warning
  de deprecación, con la misma función (proteger rutas del panel y
  redirigir usuarios ya logueados fuera de `/login` y `/registro`).
- **Roles**: por ahora el único rol es `ADMIN` (dueño de la cuenta). El rol
  "sucursal" de US8.3 no aplica sin UI multi-sucursal; si más adelante se
  necesita un rol operativo sin permisos de configuración, se agrega sin
  romper el modelo actual.

## Estructura del repo

```
prisma/schema.prisma       Schema completo (todas las entidades E1–E11)
prisma.config.ts           Config de Prisma Migrate (Prisma 7)
src/lib/                   Prisma client, auth, validaciones, helpers
src/app/(auth)/            Login y registro
src/app/(dashboard)/       Panel autenticado (layout + secciones por épica)
src/app/api/               Rutas de API (auth, registro)
src/proxy.ts               Protección de rutas (login requerido / redirect)
docker-compose.yml         app + postgres + redis
Dockerfile                 Build multi-stage de la app (standalone output)
```
