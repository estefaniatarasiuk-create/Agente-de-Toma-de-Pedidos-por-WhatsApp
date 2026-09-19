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
- **Jobs/timers**: BullMQ + Redis (worker propio desde Fase 3: recordatorio/cancelación de comprobante, vencimiento de conversación).
- **WhatsApp**: Meta WhatsApp Cloud API (Embedded Signup + webhooks desde Fase 2; conversación real, envío de mensajes y transcripción de audio con Whisper desde Fase 3).
- **IA conversacional**: OpenAI o Anthropic, configurable por variable de entorno (carga asistida desde Fase 1; motor de pedidos real desde Fase 3).
- **Mapas/geocodificación**: Google Maps Geocoding API + Maps JavaScript API.
- **Auth**: email + contraseña con sesiones JWT (Auth.js / NextAuth v5).
- **Deploy local/dev**: docker-compose (app + Postgres + Redis).

## Estado del proyecto

- [x] **Fase 0** — Esqueleto: repo, docker-compose, schema Prisma completo, auth, layout base.
- [x] **Fase 1** — Configuración del negocio (catálogo, horarios, zona, IA, medios de pago).
- [x] **Fase 2** — Vinculación de WhatsApp (Embedded Signup, webhooks).
- [x] **Fase 3** — Motor de pedidos (máquina de estados, IA, comprobante, worker de BullMQ).
- [x] **Fase 4** — Operación (tablero de pedidos, conversaciones en vivo).
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
- Para vincular WhatsApp (Fase 2) necesitás una app en
  [Meta for Developers](https://developers.facebook.com/) con el producto
  **WhatsApp** agregado y el **Embedded Signup** configurado (Meta App
  Dashboard → WhatsApp → Embedded Signup → creás una "Configuration"). De ahí
  sacás: `NEXT_PUBLIC_META_APP_ID`, `META_APP_SECRET` y
  `NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID`. `WHATSAPP_WEBHOOK_VERIFY_TOKEN` lo
  elegís vos (cualquier string) y lo cargás igual en Meta al configurar la
  URL del webhook (`https://tu-dominio/api/webhooks/whatsapp`). También
  necesitás `TOKEN_ENCRYPTION_KEY` (`openssl rand -hex 32`) para cifrar en
  reposo el access token de la línea. En desarrollo local, como Meta necesita
  una URL pública para mandarte los webhooks, usá un túnel (ej.
  [ngrok](https://ngrok.com/): `ngrok http 3000`) y cargá esa URL en Meta.
  Igual que con Google Maps, `NEXT_PUBLIC_META_APP_ID` y
  `NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID` se hornean en build time: cambiarlas
  requiere `docker compose up --build`.

### Levantar todo con Docker Compose

```bash
docker compose up --build
```

Esto levanta Postgres, Redis, la app (corre `prisma migrate deploy` al
iniciar) y el **worker** de BullMQ (Fase 3: recordatorio/cancelación de
comprobante, vencimiento de conversación) — mismo build, corriendo
`src/worker/index.ts` como proceso aparte. La app queda disponible en
`http://localhost:3000`.

### Desarrollo local (sin dockerizar la app)

```bash
docker compose up -d postgres redis
npm install
npm run db:migrate   # aplica las migraciones (crea una nueva si el schema cambió)
npm run dev
```

En otra terminal, si vas a probar pedidos por transferencia o el
vencimiento de conversación (Fase 3), levantá también el worker:

```bash
npm run worker        # una vez
npm run worker:dev    # o con reinicio automático al editar código
```

La app queda en `http://localhost:3000`. Sin el worker corriendo, los
pedidos y conversaciones se arman igual — lo único que no dispara son los
recordatorios/cancelaciones/vencimientos por tiempo, que quedan encolados
en Redis hasta que el worker esté levantado.

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

### Verificación de la Fase 2

**Requiere una app de Meta real configurada** (ver "Variables de entorno"
más arriba) para probar la vinculación de punta a punta. Lo que sí se puede
verificar sin eso:

1. `/whatsapp` sin ninguna línea vinculada → muestra "Todavía no vinculaste
   ninguna línea" y el botón "Conectar línea de WhatsApp".
2. Si faltan `NEXT_PUBLIC_META_APP_ID` / `NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID`,
   se ve un aviso amarillo explicándolo en vez de romper la página.

**Con una app de Meta configurada:**

3. Clic en "Conectar línea de WhatsApp" → se abre el popup de Facebook
   (Embedded Signup) → completás el alta/selección del número → al cerrar el
   popup, la pantalla pasa a "Vinculando..." y después muestra estado
   **Activa**, el número y el nombre verificado.
4. Mandale un mensaje de WhatsApp a ese número desde tu celular → tiene que
   aparecer en la base: `webhook_events` (el payload crudo, status
   `PROCESSED`), `conversations` (una fila por número de cliente) y
   `messages` (el texto, `whatsappMessageId` único). Todavía no hay
   respuesta automática — eso es la Fase 3.
5. Volvé a mandar el mismo webhook (o que Meta reintente) → no se duplica
   ni la conversación ni el mensaje (`whatsappMessageId` es único, se
   ignora el evento repetido).
6. Sacale la firma o mandala mal → `POST /api/webhooks/whatsapp` devuelve
   401 sin procesar nada.

**Sin app de Meta**, igual se puede probar la lógica de verificación y
firma del webhook a mano — con `WHATSAPP_WEBHOOK_VERIFY_TOKEN` y
`META_APP_SECRET` cargados en el `.env` (podés inventar valores para
desarrollo local):

```bash
# Handshake de verificación (lo que hace Meta al configurar la URL)
curl "http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=TU_TOKEN&hub.challenge=12345"
# Tiene que devolver: 12345
```

### Verificación de la Fase 3

**Tests automáticos** (rutas críticas, contra una base Postgres real —
requiere `docker compose up -d postgres redis` y `DATABASE_URL` migrada):

```bash
npm test
```

Cubren: pedido feliz en efectivo (recalcula precios desde el catálogo,
ignora lo que traiga el borrador), domicilio fuera de zona (corta el
armado del pedido y avisa), fuera de horario (no invoca a la IA), no
sustitución silenciosa de productos que no están en el catálogo (el bug de
"Fanta → Coca-Cola" de la Fase 1), y la regla de seguridad del comprobante
(un pedido con comprobante adjunto **nunca** se cancela automáticamente,
sin importar cuánto tiempo pasó).

**De punta a punta, con WhatsApp real** (con una línea ya vinculada en
Fase 2):

1. Mandale un mensaje de texto pidiendo algo del catálogo → la IA responde
   por WhatsApp confirmando el ítem; pedile algo que no está → te ofrece
   alternativas del catálogo real en vez de inventar o sustituir en
   silencio.
2. Dale tu nombre y una dirección lejos de la zona configurada → corta el
   pedido en curso y te avisa que está fuera de zona (no lo toma igual).
3. Completá un pedido y elegí "efectivo" → queda en estado `PENDING` con
   demora estimada según `Branch.currentDelayMinutes`; elegí
   "transferencia" → te manda los datos bancarios reales configurados y
   queda `WAITING_RECEIPT`.
4. Para un pedido `WAITING_RECEIPT`: mandale una foto (de lo que sea) →
   se adjunta como comprobante sin pasar por la IA y el pedido queda
   esperando validación manual (Fase 4). Con el worker corriendo y
   `Branch.receiptReminderMinutes`/`receiptCancelMinutes` bajados a un
   valor chico para probar, verificá que llega el recordatorio y, si nunca
   mandás el comprobante, que se cancela solo — pero si lo mandás antes
   (aunque sea después del recordatorio), nunca se cancela.
5. Mandale un audio → se transcribe con Whisper (necesita
   `OPENAI_API_KEY`, sea cual sea el `AI_PROVIDER`) y la IA responde como
   si hubieras escrito el mismo texto.
6. Escribí fuera del horario configurado → responde el horario de
   atención sin invocar a la IA.
7. Escribí "quiero hablar con una persona" → la conversación pasa a
   `REQUIRES_ATTENTION` y deja de responder automáticamente (Fase 4 le
   devuelve el control a un humano).

### Verificación de la Fase 4

**Pedidos** (`/pedidos`): tablero con una columna por estado (esperando
comprobante, pendiente, en preparación, en camino, entregado, cancelado).
Al llegar un pedido real por WhatsApp (Fase 3), tiene que aparecer solo en
la columna que corresponda.

1. Hacé clic en un pedido → se abre el detalle: productos, total, domicilio,
   medio de pago, y el historial de cambios de estado.
2. Pedido en efectivo (`PENDING`) → botón "Pasar a preparación" → "Marcar
   en camino" → "Marcar entregado". En cada paso a "en camino" o
   "entregado" el cliente recibe un WhatsApp avisándole (podés confirmarlo
   viendo la conversación en `/conversaciones` o en su celular si es una
   prueba real).
3. Pedido por transferencia (`WAITING_RECEIPT`) sin comprobante todavía →
   no hay botón de avanzar, solo un aviso de que se está esperando. Una vez
   que el cliente manda la foto del comprobante (se adjunta solo, Fase 3),
   aparece la imagen en el detalle y el botón "Validar comprobante y pasar
   a preparación" — al usarlo, queda registrado quién lo validó
   (`paymentValidatedByUserId`) y el cliente recibe el aviso.
4. Botón "Cancelar pedido" (disponible en cualquier estado no terminal) →
   pide un motivo → el pedido pasa a `CANCELLED` con `cancelledBy: COMPANY`
   y el cliente recibe el motivo por WhatsApp. A diferencia de la
   cancelación automática del circuito de comprobante (que nunca cancela
   si ya hay `receiptUrl`), esta cancelación manual sí puede hacerse en
   cualquier momento — es una decisión de una persona, no una regla dura.

**Conversaciones** (`/conversaciones`): lista de conversaciones a la
izquierda (las que están en `REQUIRES_ATTENTION` aparecen primero), chat
completo a la derecha.

1. Una conversación en `REQUIRES_ATTENTION` (por ejemplo, después de que un
   cliente pidió hablar con una persona, o de que falló algo técnico) se
   puede responder escribiendo en el cuadro de texto — el mensaje se manda
   de verdad por WhatsApp y queda marcado en el chat con tu nombre (no
   "IA"). El botón **"Marcar resuelta (devolver a la IA)"** la vuelve a
   `ACTIVE` para que el motor de pedidos retome el control automático.
2. Botón **"Pausar IA"** en cualquier conversación activa → la IA deja de
   responder sola (igual que `REQUIRES_ATTENTION`, pero elegido a
   propósito por el local, no por una falla) hasta que se la reactive con
   **"Reactivar IA"**.
3. Mandar un mensaje manual no cambia el estado de la conversación por su
   cuenta — es una decisión aparte, para no perder el control accidental
   por escribir una vez.

**Notificaciones y actualización en vivo** (ajuste agregado después de probar
la Fase 4): con el panel abierto, hacé clic en "Activar notificaciones" en
la barra lateral (el navegador va a pedir el permiso). A partir de ahí:

1. El número junto a "Conversaciones" en el menú muestra cuántas necesitan
   atención humana en este momento, en vivo.
2. Cuando una conversación pasa a necesitar atención, o llega un pedido
   nuevo, suena un beep corto y aparece una notificación del navegador —
   sin bloquear nada de lo que estés haciendo en el panel. Solo avisa de
   lo que aparece **después** de abrir el panel, no de lo que ya estaba
   ahí (para no repetir alertas viejas cada vez que recargás la página).
3. El tablero de pedidos, la lista de conversaciones y el chat abierto se
   actualizan solos cada pocos segundos (sondeo periódico) — no hace falta
   recargar la página para ver un mensaje o pedido nuevo.

## Pendientes de pulido (para el cierre, Fase 5)

Detectados probando la Fase 1, decidimos no resolverlos todavía porque no
bloquean funcionalidad — quedan anotados para no perderlos:

- **Avisar cuando el chequeo de contradicciones de IA no se pudo ejecutar**
  (`POST /api/ia/config`, función `checkContradictions`). Hoy, si la
  llamada al LLM falla (sin `AI_PROVIDER` configurado, error de red, etc.),
  se traga el error y devuelve `warnings: []` — el usuario ve "guardado
  correctamente" como si no hubiera contradicciones, en vez de un aviso de
  que no se pudo verificar.
- **Revisar contraste de colores** en textos que quedan muy parecidos al
  fondo en algunas pantallas (reportado en `/catalogo` y alrededores).

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
- **Fase 2 recibe y persiste, no responde.** `POST /api/webhooks/whatsapp`
  guarda el payload crudo (idempotencia vía `WebhookEvent.externalId`) y
  vuelca los mensajes entrantes a `Conversation`/`Message`, pero no envía
  ninguna respuesta automática: la conversación con el cliente (motor de
  pedidos, IA, reglas duras) es explícitamente el alcance de la Fase 3. Acá
  solo se deja la línea operativa y los mensajes ya guardados esperando ese
  motor.
- **`phoneNumberId` único en `WhatsAppLine`.** Es la clave con la que el
  webhook resuelve a qué sucursal pertenece un mensaje entrante (Meta manda
  el `phone_number_id` en cada payload, nunca el id de nuestra sucursal).
  De paso, evita que dos sucursales terminen compartiendo sin querer la
  misma línea.
- **Access token y PIN de la línea cifrados en reposo.** `WhatsAppLine`
  guarda `accessTokenEncrypted`/`twoStepPinEncrypted` con AES-256-GCM
  (`src/lib/crypto.ts`, clave en `TOKEN_ENCRYPTION_KEY`) en vez de texto
  plano — son credenciales de larga vida que permiten enviar mensajes en
  nombre del comercio. Ninguna respuesta de API los expone (`toSafeLine`
  los excluye siempre).
- **Verificación de firma en el webhook, no autenticación de sesión.**
  `/api/webhooks/whatsapp` está fuera del `proxy.ts` (Meta no manda
  cookies): su seguridad es la verificación HMAC-SHA256 del header
  `X-Hub-Signature-256` contra `META_APP_SECRET`, más el `hub.verify_token`
  en el handshake GET inicial.
- **Descarga de medios en Fase 2, transcripción en Fase 3.** Las imágenes,
  audios y documentos que llegan por WhatsApp ya se descargan y guardan
  (vía la Graph API) al persistir el mensaje, pero `Message.transcription`
  queda vacío — la transcripción de audio con Whisper es tarea del motor de
  pedidos (Fase 3), que es quien necesita el texto para conversar.
- **La IA nunca escribe el pedido directamente: propone acciones, el
  código las valida y ejecuta.** Cada turno, el modelo devuelve un JSON con
  un texto conversacional y una lista de "acciones" tipadas (`add_item`,
  `set_customer_info`, `confirm_order`, etc. — `src/lib/validations/order-engine.ts`).
  `src/lib/orders/apply-actions.ts` es el único lugar que las ejecuta contra
  la base: valida cada producto contra el catálogo real
  (`findProductMatch`), cada domicilio contra la zona configurada
  (`validateDeliveryAddress`), y recalcula precios desde cero al confirmar
  (`createOrderFromDraft`). Esto es lo que corrige los dos bugs que
  encontró el usuario probando el preview de la Fase 1: ya no se sustituye
  un producto inexistente en silencio (se avisa y se ofrecen alternativas)
  ni se acepta un domicilio fuera de zona (corta el pedido en curso).
- **Horario y comprobante se resuelven en código, nunca le preguntan a la
  IA.** `isWithinBusinessHours` y el auto-adjuntado de comprobante
  (`processInboundMessage`, pasos 1 y 2) cortan el turno antes de invocar
  al modelo — spec §3.3/§3.4. Evita que un horario mal interpretado por la
  IA le diga a un cliente que está abierto cuando no lo está, o que un
  comprobante real dependa de que el modelo "entienda" que eso es lo que
  se mandó.
- **Circuito de comprobante con jobs idempotentes, no cancelables.**
  `scheduleReceiptJobs`/`scheduleConversationExpiry` (BullMQ) no se
  cancelan explícitamente cuando el estado cambia antes de tiempo (por
  ejemplo, llega el comprobante antes del recordatorio): cada job relee el
  pedido/conversación al dispararse y no hace nada si el estado ya no es
  el que esperaba (`src/worker/handlers.ts`). Es más simple y más seguro
  que mantener sincronizado un mapa de "jobs pendientes por cancelar", y
  hace que la regla de seguridad del comprobante (nunca cancelar si ya hay
  `receiptUrl`) sea imposible de saltear por una carrera entre jobs.
- **Worker como proceso aparte, corriendo el código fuente con `tsx`.** El
  build "standalone" de Next solo empaqueta lo necesario para las rutas
  HTTP; el worker de BullMQ no es una ruta HTTP, así que la imagen de
  Docker copia además `src/` y corre `npx tsx src/worker/index.ts`
  reutilizando la misma imagen que la app (ver `docker-compose.yml`,
  servicio `worker`).
- **Transcripción de audio: Whisper de OpenAI, independiente de
  `AI_PROVIDER`.** El encargo fija Whisper para transcribir audios sea cual
  sea el proveedor elegido para conversar — `transcribeAudio()`
  (`src/lib/ai/transcribe-audio.ts`) siempre usa `OPENAI_API_KEY`, incluso
  con `AI_PROVIDER=anthropic`. Cada llamada se loguea en `AIUsageLog` igual
  que las conversacionales (con costo, purpose `AUDIO_TRANSCRIPTION`).
- **Tests de integración contra Postgres real, no contra mocks de
  Prisma.** Las rutas críticas del motor de pedidos hacen muchas consultas
  encadenadas (catálogo, zona, horarios, pagos) — mockear el cliente de
  Prisma hubiera significado re-implementar esa lógica en los mocks. En
  cambio, cada test crea su propia `Company`/`Branch` con datos únicos y
  la borra al final (el borrado cascadea, ver schema); lo único que se
  mockea es `geocodeAddress` (llamaría a la API real de Google Maps y
  necesitaría una key en cada corrida de tests).
- **Cancelación manual sin restricción, automática con regla dura.** El
  circuito de comprobante (Fase 3) nunca cancela solo si ya hay
  `receiptUrl` — esa es una garantía del sistema. Cancelar a mano desde el
  tablero (Fase 4) es una decisión de una persona, no del sistema: puede
  hacerse en cualquier estado no terminal, comprobante adjunto o no. Son
  reglas distintas a propósito, en `src/lib/orders/order-transitions.ts`.
- **Pausar la IA es una acción explícita, separada de mandar un mensaje.**
  Un operador puede escribirle a un cliente sin que eso pause la IA por su
  cuenta — si lo hiciera automáticamente, sería fácil perder el control
  del bot sin querer con un solo mensaje suelto. Pausar/reactivar y
  "marcar resuelta" son botones aparte en `/conversaciones`.
- **Notificaciones de estado del pedido: solo en las transiciones que le
  importan al cliente.** Al avanzar un pedido manualmente, se le avisa por
  WhatsApp cuando pasa a "en camino" o "entregado" (y al validarle el pago
  o cancelarle el pedido) — no en cada paso interno (ej. pasar a
  "en preparación" no genera un mensaje, es información de uso interno).
- **Actualización del panel por sondeo (polling), no WebSockets.** El panel
  se refresca solo cada pocos segundos (`/api/notificaciones` liviano cada
  8s para las alertas, el tablero y la lista de conversaciones cada 8s, el
  chat abierto cada 4s) en vez de una conexión en tiempo real. Para el
  volumen de uso de un solo local (un puñado de operadores viendo el panel
  a la vez) es una diferencia de segundos, no de experiencia — y evita
  meter infraestructura nueva (un server de WebSockets, o Redis pub/sub
  atado al ciclo de vida de cada conexión) para un panel de administración
  interno. El beep se genera con Web Audio API (sin archivo de audio que
  versionar) y las notificaciones usan la Notification API del navegador,
  ambas nativas, sin dependencias nuevas.

## Estructura del repo

```
prisma/schema.prisma       Schema completo (todas las entidades E1–E11)
prisma.config.ts           Config de Prisma Migrate (Prisma 7)
src/lib/ai/                 Abstracción de LLM (OpenAI/Anthropic), log de uso, prompt de sucursal, Whisper
src/lib/whatsapp/           Graph API de Meta, verificación de firma, procesamiento de webhooks, envío de mensajes
src/lib/orders/              Motor de pedidos (Fase 3): horarios, matching de catálogo, zona, prompt,
                             aplicación de acciones, creación de pedido, mensajes deterministas, orquestador (engine.ts);
                             transiciones de estado manuales del tablero (Fase 4, order-transitions.ts)
src/lib/jobs/                 Colas de BullMQ (recordatorio/cancelación de comprobante, vencimiento de conversación)
src/worker/                   Proceso del worker (index.ts conecta BullMQ, handlers.ts tiene la lógica de cada job)
src/lib/validations/        Schemas de zod por dominio (producto, horarios, zona, pagos, IA, auth, pedido)
src/lib/geocoding.ts        Normalización de direcciones + cache + Google Geocoding API
src/lib/uploads.ts          Guardado/lectura de archivos subidos (disco + volumen)
src/lib/catalog-image.tsx   Render determinístico de la imagen de catálogo (next/og)
src/lib/crypto.ts           Cifrado en reposo de tokens/secretos (AES-256-GCM)
src/lib/                    Prisma client, auth, helpers
src/app/(auth)/              Login y registro
src/app/(dashboard)/         Panel autenticado (layout + una carpeta por sección/épica);
                             pedidos/ y conversaciones/ son el tablero y la bandeja en vivo (Fase 4)
src/app/api/                 Rutas de API (auth, registro, catálogo, horarios, zona, pagos, IA, WhatsApp, uploads,
                             pedidos, conversaciones, notificaciones)
src/components/operations-alerts-provider.tsx  Sondeo de alertas en vivo (Fase 4): badge, sonido, notificación del navegador
src/app/api/webhooks/        Endpoints públicos que llama Meta directamente (sin sesión)
src/proxy.ts                 Protección de rutas (login requerido / redirect)
tests/                       Tests de Vitest de las rutas críticas del motor de pedidos (Fase 3)
docker-compose.yml           app + worker + postgres + redis, volumen de uploads
Dockerfile                   Build multi-stage de la app (standalone output) + fuente para el worker
```
