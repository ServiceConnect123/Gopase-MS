# wspsend-ms

Microservicio en NestJS que notifica por WhatsApp (Baileys) los pagos pendientes
por conjunto, leyendo y escribiendo en las hojas de Google Sheets de goPase a
través del Google Apps Script existente.

## Qué hace

- Un cron corre **cada 5 minutos** (configurable) y **también al arrancar**.
- Lee la hoja `conjuntos` para saber a qué número de WhatsApp notificar.
- Lee los pagos con estado `Pendiente` (hoja `pagos`, `dato_6`) y los agrupa por
  conjunto cruzando `pagos.usuario` -> `usuarios.conjunto`.
- Envía al admin configurado un mensaje: "tienes X pagos pendientes por aprobar"
  más la ruta de la app para aprobarlos.
- Registra el envío en la hoja `wsp_envios`. Si ya se notificó ese conjunto hoy,
  espera al día siguiente (máximo un envío por conjunto por día).

## Configuración

1. Copia `.env.example` a `.env` y ajusta valores (sobre todo `SCRIPT_URL`).
2. En el Google Apps Script, agrega las hojas nuevas al `SHEET_MAP`
   (ya incluidas en `goPase/google_apps_script.js`):
   - `wsp_envios` -> `"Hoja 11"`
   - `wsp_session` -> `"Hoja 12"`
3. El admin que recibe las notificaciones se configura **desde la app**, en la
   pantalla de Conjuntos (editar conjunto > sección "Notificaciones WhatsApp").
   Esos datos se guardan en la hoja `propiedades` (Hoja 5) en columnas nuevas:

   | dato_12 | dato_13 | dato_14 | dato_15 |
   |---------|---------|---------|---------|
   | adminUsuario | adminNombre | adminWhatsapp | notifActivo |

   > Al seleccionar un administrador en la app, `adminNombre` y `adminWhatsapp`
   > se autocompletan desde los datos del usuario (nombre y teléfono).
   > `notifActivo`: `true`/`false`. Si viene vacío se asume activo.
   > El teléfono de 10 dígitos (celular CO) recibe el prefijo `57` automáticamente.

   **Hoja 11 (wsp_envios):** el servicio escribe aquí, pero deja los encabezados
   (fila 1) creados:
   | dato_1 | dato_2 | dato_3 | dato_4 | dato_5 | fecha_creacion | fecha_modificacion | ultimo_usuario |
   |--------|--------|--------|--------|--------|----------------|--------------------|----------------|
   | conjunto | fecha | cantidad_pagos | estado | timestamp | | | |

   **Hoja 12 (wsp_session):** guarda la sesión de WhatsApp (Baileys). Solo crea
   los encabezados (fila 1); el servicio la llena solo:
   | dato_1 | dato_2 | fecha_creacion | fecha_modificacion | ultimo_usuario |
   |--------|--------|----------------|--------------------|----------------|
   | clave | valor | | | |

   > Las columnas `fecha_creacion`, `fecha_modificacion` y `ultimo_usuario` son
   > las de auditoría que el Apps Script agrega automáticamente en cada
   > `create`/`update`. Deben existir como las **últimas 3 columnas** de la hoja.

## Ejecutar

```bash
npm install
npm run start:dev
```

La **primera vez** aparecerá un **QR en la consola**: escanéalo con el WhatsApp
del número emisor (WhatsApp > Dispositivos vinculados). La sesión queda guardada
en la hoja `wsp_session` de Google Sheets, así que **no hay que volver a escanear**
aunque el servicio se reinicie o se redespliegue.

## Endpoints útiles

- `GET /notifications/status` — indica si WhatsApp está conectado.
- `POST /notifications/run` — dispara el chequeo manualmente (para pruebas).
- `GET|POST /notifications/wake` — "despierta" el servicio (Render Free) y agenda
  el chequeo. Responde de inmediato sin esperar a WhatsApp; el chequeo corre en
  cuanto la conexión esté lista (reintenta hasta ~1 min cubriendo el cold start).
  Lo llama el Google Apps Script automáticamente al registrar un pago.
- `GET /whatsapp/status` — estado de la conexión de WhatsApp.
- `GET /whatsapp/qr` — QR actual en JSON (string crudo + PNG base64).
- `GET /whatsapp/qr/view` — página HTML con el QR para escanear desde el navegador.
- `POST /whatsapp/relogin` — cierra la sesión, borra credenciales y genera un QR
  nuevo para vincular OTRO número de WhatsApp.

## Cambiar el número de WhatsApp emisor / escanear un QR nuevo

No necesitas tocar Google Sheets a mano ni mirar los logs:

1. Llama a `POST /whatsapp/relogin` (o desde el navegador con cualquier cliente
   HTTP). Esto cierra la sesión actual y limpia la hoja `wsp_session`.
2. Abre `GET /whatsapp/qr/view` en el navegador. Verás el QR (la página se
   recarga sola cada 20s para refrescarlo).
3. En el teléfono con el nuevo número: WhatsApp > Dispositivos vinculados >
   Vincular un dispositivo, y escanea.
4. Al conectar, `GET /whatsapp/status` devolverá `ready: true` y la nueva sesión
   queda guardada en `wsp_session`.

> Alternativa manual: vaciar la hoja `wsp_session` (dejar solo encabezados) y
> reiniciar el servicio.

## Docker

Mismo enfoque que `epayco-api`: imagen propia, servicio propio, puerto 3001.

```bash
# Build y run local con .env
make docker-build
make docker-run          # http://localhost:3001
make docker-logs
make docker-stop

# Push a Docker Hub
make docker-push
```

Levantar wspsend-ms + epayco-api juntos en local:
```bash
docker compose up -d --build
# wspsend-ms -> http://localhost:3001
# epayco-api -> http://localhost:3000
```

### Deploy en Render (Docker)

El `render.yaml` ya está configurado (runtime docker, plan free, puerto 3001).
En el dashboard de Render:
1. New > Blueprint (o Web Service) apuntando al repo de `wspsend-ms`.
2. Configura la variable **`SCRIPT_URL`** (marcada como `sync: false`, es un
   secreto y no viaja en el repo). El resto de variables ya vienen en el yaml.
3. Deploy. Luego abre `https://<tu-servicio>.onrender.com/whatsapp/qr/view` y
   escanea el QR una vez.

## Notas de despliegue

- La sesión de WhatsApp se persiste en Google Sheets (hoja `wsp_session`), por lo
  que **sobrevive a reinicios y redeploys** aunque el filesystem sea efímero
  (Render Free). El QR se escanea una sola vez.
- Estrategia con Render Free: como el servicio se "duerme" por inactividad, el
  cron interno no corre 24/7. El servicio ejecuta el chequeo también **al
  arrancar** (`RUN_ON_STARTUP=true`), así cuando algo lo despierta (una petición
  entrante o un ping externo a `POST /notifications/run`) vuelve a revisar los
  pendientes. El registro diario en `wsp_envios` evita reenvíos el mismo día.
- Si un reinicio ocurre y la sesión se restaura desde `wsp_session`, Baileys
  reconecta sin QR antes de que corra el chequeo de arranque (hay 8s de margen).
- Para forzar un re-login: vacía la hoja `wsp_session` (deja solo los
  encabezados) y reinicia el servicio para escanear un QR nuevo.

## Despliegue continuo (GitHub Actions + Render)

El workflow `.github/workflows/deploy.yml` construye y publica la imagen a
Docker Hub y luego dispara el deploy del servicio de Render correspondiente:

| Rama   | Imagen Docker Hub                | Servicio Render        |
|--------|----------------------------------|------------------------|
| `qa`   | `williams2022/wspsend-ms:qa`     | wspsend-ms-qa          |
| `main` | `williams2022/wspsend-ms:latest` | wspsend-ms (prod)      |

Cada build publica además un tag con el SHA (`<env>-<sha>`) para trazabilidad y
rollback.

### Secrets requeridos

En GitHub: **Settings → Secrets and variables → Actions**:

- `DOCKERHUB_USERNAME` — usuario de Docker Hub (ej. `williams2022`).
- `DOCKERHUB_TOKEN` — access token de Docker Hub (Account → Security → New Access Token).
- `RENDER_API_KEY` — API key de Render (Account Settings → API Keys).
- `RENDER_SERVICE_ID_QA` — `srv-daj1f2h5efls73f8jh40`.
- `RENDER_SERVICE_ID_PROD` — `srv-dacpm40ae00c73deqjhg`.

### Requisito en Render

Cada servicio debe estar configurado para desplegar **desde imagen de registro**
(Docker Hub), no auto-build desde el repo, para que Actions sea la única fuente
de la imagen y no haya doble build.

Las variables de entorno se gestionan **manualmente** en el dashboard de cada
servicio (Environment). El pipeline no crea ni modifica variables: solo publica
la imagen y dispara el deploy. Por eso este repo no usa `render.yaml` (Blueprint).
