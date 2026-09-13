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
- **IA conversacional**: OpenAI o Anthropic, configurable por variable de entorno (carga asistida desde Fase 1; motor de pedidos en Fase 3).
- **Mapas/geocodificación**: Google Maps Geocoding API + Maps JavaScript API.
- **Auth**: email + contraseña con sesiones JWT (Auth.js / NextAuth v5).
- **Deploy local/dev**: docker-compose (app + Postgres + Redis).

## Estado del proyecto

- [x] **Fase 0** — Esqueleto: repo, docker-compose, schema Prisma completo, auth, layout base.
- [x] **Fase 1** — Configuración del negocio (catálogo, horarios, zona, IA, medios de pago).
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
- `AI_PROVIDER` (`openai` o `anthropic`) + la API key y el modelo del
  proveedor elegido (`OPENAI_API_KEY`/`OPENAI_MODEL` o
  `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`). Sin esto, todo lo que use IA
  (catálogo asistido, horarios/zona en lenguaje natural, chequeo de
  contradicciones, modo "probar conversación") devuelve error al usarlo,
  pero el resto de la plataforma funciona igual.
- `GOOGLE_MAPS_API_KEY` y `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` para geocodificar
  direcciones y mostrar el mapa de la zona de entrega. **Importante:** la
  variable `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` se hornea en el bundle del
  cliente durante el build de Docker, no en runtime — si la cambiás después
  de un primer `docker compose up --build`, tenés que volver a buildear
  (`docker compose up --build`, no solo `up -d`) para que tome efecto.

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

### Verificación de la Fase 1

**Catálogo** (`/catalogo`):
1. "Nuevo producto" → cargar nombre, precio, categoría, descripción → aparece
   en la tabla. Editarlo y pausarlo/reactivarlo desde la tabla.
2. "Cargar varios productos a la vez" → pegar texto de un menú (ej. "Pizza
   muzzarella $4500, Empanada de carne $600 c/u") → "Interpretar con IA" →
   revisar/editar la previsualización → "Confirmar e importar" → los
   productos aparecen en la tabla. (Necesita `AI_PROVIDER` configurado.)
3. Mismo flujo pero subiendo una foto de un menú en lugar de texto (necesita
   un modelo con soporte de visión, ej. `gpt-4o-mini`).
4. "Importar desde Excel" → subir un `.xlsx` con columnas Nombre/Precio
   (Descripción/Categoría opcionales) → se ve la previsualización con errores
   por fila (nombre o precio faltante) → "Confirmar e importar" solo carga
   las filas válidas.
5. "Generar automáticamente" en la sección de imagen del catálogo → genera un
   PNG con los productos activos agrupados por categoría (no usa IA: se
   renderiza de forma determinística a partir del catálogo real). También se
   puede subir una imagen propia.

**Horarios** (`/horarios`): escribir algo como "de martes a domingo, de 11 a
14:30 y de 19 a 23" → "Interpretar con IA" → la grilla se completa con esos
días/franjas (turnos partidos incluidos) → ajustar manualmente si hace falta
(agregar/quitar franjas, tildar/destildar) → "Guardar horarios".

**Zona de entrega** (`/zona-de-entrega`): cargar la dirección del local →
"Buscar" (geocodifica con Google Maps y guarda lat/lng en la sucursal) → el
mapa centra ahí; ajustar el radio con el campo numérico o describiéndolo en
lenguaje natural ("entregamos hasta 5 km") → se puede arrastrar el marcador
para afinar el centro → "Guardar zona".

**Medios de pago** (`/medios-de-pago`): habilitar transferencia sin cargar
alias/CBU/titular/CUIT → error de validación; completar los datos → guarda.
El CBU valida 22 dígitos y el CUIT el formato `XX-XXXXXXXX-X`.

**Configuración de IA** (`/ia`): elegir tono y emojis, guardar información
adicional en texto libre → si contradice la config estructurada (ej.
mencionás un horario o radio distinto al configurado), se muestra un aviso
no bloqueante aclarando que la config estructurada prevalece. El widget
"Probar conversación" simula un chat con la config vigente (catálogo,
horarios, zona, pagos, tono) sin registrar ningún pedido real.

**Multi-tenant**: todo lo anterior queda aislado por `companyId`/`branchId`;
las rutas de API validan la sesión con `requireBranchContext()` y devuelven
401 sin sesión válida.

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
- **Imagen de catálogo: renderizada, no generada por IA.** La spec pide
  "imagen del catálogo" y el encargo pide "generación de imagen de
  catálogo"; en vez de pedirle a un modelo generativo que dibuje un menú
  (con riesgo real de inventar o desactualizar precios, violando la regla
  de que la IA nunca decide precios), el botón "Generar automáticamente"
  renderiza un PNG de forma determinística a partir del catálogo
  estructurado vigente (`src/lib/catalog-image.tsx`, con `ImageResponse` de
  `next/og`). La empresa también puede subir su propia imagen si prefiere
  un diseño propio.
- **Almacenamiento de archivos: disco local con volumen dedicado.** El stack
  no incluye un proveedor de blob storage. Los archivos subidos (catálogo,
  y en Fase 3 los comprobantes) se guardan en `UPLOADS_DIR` (volumen
  `uploads_data` en docker-compose) y se sirven autenticados vía
  `/api/uploads/[...path]`, nunca desde `/public` (que se hornea en la
  imagen y no persiste entre builds).
- **`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` como build arg.** Next.js inlinea las
  variables `NEXT_PUBLIC_*` en el bundle del cliente en build time. Como el
  `Dockerfile` compila la imagen antes de que exista el contenedor en
  ejecución, `docker-compose.yml` la pasa como `build.args` (tomada del
  `.env` de la raíz) además de dejarla disponible en runtime.
- **Sin fallback de modelo hardcodeado.** `OPENAI_MODEL`/`ANTHROPIC_MODEL`
  son obligatorios y sin default en el código: la vigencia y el nombre
  exacto de los modelos cambia con el tiempo, así que se lo dejamos elegir
  a quien despliega en vez de arriesgar shippear un id de modelo
  desactualizado o inexistente.
- **Costo de IA aproximado, no exacto.** `src/lib/ai/provider.ts` tiene una
  tabla de precios por modelo (USD por millón de tokens) para estimar el
  costo de cada llamada y cumplir con la regla de loguear costo por pedido
  desde el día 1. Son valores de referencia, no los precios oficiales
  vigentes del proveedor — ajustables editando esa tabla.
- **Interpretación de zona por radio, no por polígono.** La spec ya
  restringe la v1 a radio en km (polígonos quedan fuera de alcance, sección
  7). La IA solo extrae el número de km del texto libre; el círculo se
  dibuja y ajusta en el mapa, nunca se le pide al modelo coordenadas.
- **Reutilización del mismo endpoint de confirmación para IA y Excel.**
  Ambos flujos de carga masiva de catálogo (`ia/interpretar` y
  `excel/interpretar`) devuelven la misma forma de "producto borrador"
  (`DraftProduct`) y comparten `POST /api/catalogo/importar/confirmar` para
  el alta real: la escritura en la base es siempre la misma operación
  determinística, sea cual sea el origen de los datos.

## Estructura del repo

```
prisma/schema.prisma       Schema completo (todas las entidades E1–E11)
prisma.config.ts           Config de Prisma Migrate (Prisma 7)
src/lib/ai/                Abstracción de LLM (OpenAI/Anthropic), log de uso, prompt de sucursal
src/lib/validations/       Schemas de zod por dominio (producto, horarios, zona, pagos, IA, auth)
src/lib/geocoding.ts        Normalización de direcciones + cache + Google Geocoding API
src/lib/uploads.ts          Guardado/lectura de archivos subidos (disco + volumen)
src/lib/catalog-image.tsx   Render determinístico de la imagen de catálogo (next/og)
src/lib/                    Prisma client, auth, helpers
src/app/(auth)/              Login y registro
src/app/(dashboard)/         Panel autenticado (layout + una carpeta por sección/épica)
src/app/api/                 Rutas de API (auth, registro, catálogo, horarios, zona, pagos, IA, uploads)
src/proxy.ts                 Protección de rutas (login requerido / redirect)
docker-compose.yml           app + postgres + redis, volumen de uploads
Dockerfile                   Build multi-stage de la app (standalone output)
```
