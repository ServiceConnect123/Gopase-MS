# Videollamadas de goPase — LiveKit self-hosted

Las videollamadas de eventos usan **LiveKit** (SFU open source) alojado en tu
propio VPS. El microservicio `wspsend-ms` firma los tokens de acceso (con roles
ponente/espectador) y la app (nativa y web) se conecta con ese token.

El servidor **no decide quién entra**: eso lo decide el token que emite goPase,
que solo se genera para usuarios autenticados que pertenecen a la audiencia del
evento. Sin token válido, LiveKit rechaza la conexión aunque se conozca el
nombre de la sala. Por eso no hay "link compartible".

## 1. Requisitos del VPS

- Linux con Docker + Docker Compose.
- **Ancho de banda de salida generoso** (lo crítico para 200-500 espectadores).
  Proveedores con tráfico amplio (Hetzner, OVH, etc.) encajan bien.
- Un **dominio/subdominio** apuntando al VPS (ej. `meet.gopasehome.site`) con TLS
  (WSS es obligatorio para navegadores y la app).
- Puertos abiertos en el firewall:
  - `7880/tcp` (señalización / WebSocket)
  - `7881/tcp` (WebRTC sobre TCP, respaldo)
  - `5349/tcp` (TURN sobre TLS)
  - `50000-60000/udp` (media; es el rango de `rtc.port_range_*`)

## 2. Generar las API keys

```bash
docker run --rm livekit/livekit-server generate-keys
```

Copia el par `key: secret` resultante en:
- `livekit.yaml` → sección `keys`.
- El entorno del microservicio: `LIVEKIT_API_KEY` y `LIVEKIT_API_SECRET`.
Deben coincidir EXACTAMENTE.

## 3. Configurar y levantar

1. Edita `livekit.yaml`: pon tus `keys`, tu `turn.domain` y, si usas certificados
   propios, las rutas de `cert_file`/`key_file`.
2. Levanta el servidor:
   ```bash
   docker compose up -d
   docker compose logs -f livekit
   ```
3. Pon un reverse proxy con HTTPS/WSS delante del `7880` apuntando tu dominio.
   Ejemplo con Caddy (`Caddyfile`):
   ```
   meet.gopasehome.site {
       reverse_proxy 127.0.0.1:7880
   }
   ```

## 4. Variables en el microservicio (Render)

En el servicio `wspsend-ms` define:

```
LIVEKIT_URL=wss://meet.gopasehome.site
LIVEKIT_API_KEY=<la key del paso 2>
LIVEKIT_API_SECRET=<el secret del paso 2>
```

Sin estas variables, el endpoint `GET /events/:id/meet-token` responde que la
videollamada no está configurada (y el botón en la app avisa).

## 5. Capacidad (200-500 participantes)

- Diseña los eventos grandes en **modo streaming**: solo el admin y los ponentes
  publican; el resto entra como espectador (subscribe-only). Esto es lo que hace
  viable cientos de asistentes y reuniones largas.
- Un solo nodo aguanta bastante, pero para picos grandes considera escalar con
  varios nodos LiveKit + el mismo Redis (ver docs de LiveKit sobre multi-nodo).
- Monitorea CPU y, sobre todo, **ancho de banda de salida** del VPS.

## 6. App nativa

El SDK de WebRTC requiere un **development build de EAS** (no funciona en Expo
Go). Tras instalar las dependencias, genera un build nuevo:

```bash
eas build --profile development --platform android   # o ios
```

El plugin `@config-plugins/react-native-webrtc` (ya en `app.json`) agrega los
permisos de cámara y micrófono.

## Referencias

- Self-hosting: https://docs.livekit.io/home/self-hosting/deployment/
- Tokens de acceso: https://docs.livekit.io/home/get-started/authentication/

> Contenido basado en la documentación oficial de LiveKit; parafraseado para esta guía.

## 7. Grabación (acta en video) y transmisión HLS — Egress

Las funciones de **grabar la reunión** y **transmitir en HLS** usan el *Egress*
de LiveKit, que necesita un **almacenamiento de objetos** (S3 o GCP) donde
dejar los archivos. Sin storage configurado, esos botones avisan "no
configurado" y el resto del meet funciona igual.

### Variables (en el microservicio `wspsend-ms`)

Elige proveedor con `LIVEKIT_EGRESS_PROVIDER` = `s3` o `gcp`:

```
LIVEKIT_EGRESS_PROVIDER=s3
LIVEKIT_S3_ACCESS_KEY=...
LIVEKIT_S3_SECRET=...
LIVEKIT_S3_REGION=us-east-1
LIVEKIT_S3_BUCKET=gopase-grabaciones
LIVEKIT_S3_ENDPOINT=        # opcional (S3-compatible: R2, MinIO, etc.)
```
o
```
LIVEKIT_EGRESS_PROVIDER=gcp
LIVEKIT_GCP_CREDENTIALS={...json de service account en una línea...}
LIVEKIT_GCP_BUCKET=gopase-grabaciones
```

> Nota: con **LiveKit Cloud**, el Egress corre del lado de LiveKit y entrega
> los archivos a TU bucket (las credenciales de S3/GCP son tuyas). Con
> self-hosted, además debes habilitar el servicio de Egress en el servidor.

### ⚠️ Costo

**Egress (grabación y HLS) consume cuota/costo ADICIONAL** en LiveKit (aparte de
los minutos de participantes), más el almacenamiento del bucket. Úsalo con
criterio: típicamente grabar la asamblea completa y detenerla al terminar.

### Qué guarda la app

- Al iniciar grabación/HLS, el backend guarda `grabacionEgressId` / `hlsEgressId`
  en el evento (para poder detenerlos). El archivo final queda en tu bucket con
  prefijo `grabaciones/` o `hls/`. (El enlace público depende de la config de tu
  bucket; si quieres el enlace guardado automáticamente en el evento, se puede
  agregar un webhook de Egress más adelante.)
