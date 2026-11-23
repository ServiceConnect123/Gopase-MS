// ==========================================
// Solicitudes de registro por QR — reglas puras (sin Firebase)
// ==========================================
// Cuando el conjunto pide aprobar los registros por QR, el formulario público ya
// no crea la cuenta: guarda una solicitud que la administración aprueba,
// edita o rechaza. Aquí van las reglas que no tocan la base de datos.

export type EstadoSolicitud = 'pendiente' | 'aprobada' | 'rechazada';

export interface DatosSolicitud {
  nombre: string;
  email: string;
  phone: string;
  documentType: string;
  documentNumber: string;
  parcela: string;
}

export interface SolicitudRegistro extends DatosSolicitud {
  id: string;
  conjunto: string;
  estado: EstadoSolicitud;
  creadaEn: string;
  resueltaEn?: string;
  resueltaPor?: string;
  usuario?: string;
  motivo?: string;
}

export interface Advertencia {
  tipo: 'unidad' | 'documento' | 'telefono' | 'correo';
  mensaje: string;
}

/** Máximo de solicitudes pendientes por conjunto (evita abuso del link público). */
export const MAX_PENDIENTES = 300;

const sinTildes = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Unidad comparable: "Torre 3 Apto 402", "T3-402", "torre 3 - 402" y "3 402"
 * quedan iguales ("3 402"). Se quitan palabras como torre/apto/casa/bloque.
 */
export function normUnidad(s: unknown): string {
  return sinTildes(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\b(torre|tr|t|apartamento|apto|apt|ap|casa|cs|bloque|blq|bl|interior|int|manzana|mz|lote|lt|piso|no|num|numero)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const soloDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Últimos 10 dígitos: "+57 300 123 4567" y "3001234567" son el mismo celular. */
export const normTelefono = (s: unknown) => soloDigitos(s).slice(-10);

/** Nombre con mayúscula inicial en cada palabra ("JUAN pérez" → "Juan Pérez"). */
export function capitalizarNombre(s: unknown): string {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (_m, sp, l) => sp + l.toUpperCase());
}

/** Limpia y recorta lo que llega del formulario público. */
export function limpiarDatos(d: Partial<DatosSolicitud> | null | undefined): DatosSolicitud {
  const t = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  return {
    nombre: capitalizarNombre(t(d?.nombre, 120)),
    email: t(d?.email, 120).toLowerCase(),
    phone: soloDigitos(d?.phone).slice(0, 15),
    documentType: t(d?.documentType, 10).toUpperCase(),
    documentNumber: soloDigitos(d?.documentNumber).slice(0, 15) || t(d?.documentNumber, 15),
    parcela: t(d?.parcela, 60),
  };
}

/**
 * Avisos para el administrador antes de aprobar: la unidad ya tiene
 * propietario, o el documento / teléfono / correo ya está en el conjunto.
 * `usuarios` son los del conjunto (como los devuelve UsersService.list).
 */
export function advertencias(s: DatosSolicitud, usuarios: any[]): Advertencia[] {
  const out: Advertencia[] = [];
  const activos = (usuarios || []).filter((u) => sinTildes(u?.rol) !== 'desactivado');
  const nombreDe = (u: any) => String(u?.nombre || u?.usuario || '').trim();
  const lista = (us: any[]) => us.slice(0, 3).map(nombreDe).join(', ') + (us.length > 3 ? ` y ${us.length - 3} más` : '');

  const unidad = normUnidad(s.parcela);
  if (unidad) {
    const mismos = activos.filter((u) => sinTildes(u?.rol) === 'propietario' && normUnidad(u?.parcela ?? u?.dato_10) === unidad);
    if (mismos.length) out.push({ tipo: 'unidad', mensaje: `La unidad ${s.parcela} ya tiene propietario: ${lista(mismos)}.` });
  }

  const doc = soloDigitos(s.documentNumber);
  if (doc.length >= 5) {
    const mismos = activos.filter((u) => soloDigitos(u?.docNum ?? u?.documentNumber ?? u?.dato_7) === doc);
    if (mismos.length) out.push({ tipo: 'documento', mensaje: `El documento ${s.documentNumber} ya está registrado: ${lista(mismos)}.` });
  }

  const tel = normTelefono(s.phone);
  if (tel.length >= 7) {
    const mismos = activos.filter((u) => normTelefono(u?.phone ?? u?.dato_8) === tel);
    if (mismos.length) out.push({ tipo: 'telefono', mensaje: `El teléfono ya lo usa: ${lista(mismos)}.` });
  }

  const email = sinTildes(s.email);
  if (email) {
    const mismos = activos.filter((u) => sinTildes(u?.email ?? u?.dato_2) === email);
    if (mismos.length) out.push({ tipo: 'correo', mensaje: `El correo ya lo usa: ${lista(mismos)}.` });
  }
  return out;
}

/**
 * ¿La persona ya tiene una solicitud pendiente? (mismo documento o celular).
 * Evita que quien reenvía el formulario llene la lista de duplicados.
 */
export function solicitudRepetida(s: DatosSolicitud, pendientes: SolicitudRegistro[]): SolicitudRegistro | null {
  const doc = soloDigitos(s.documentNumber);
  const tel = normTelefono(s.phone);
  return (
    (pendientes || []).find(
      (p) =>
        p.estado === 'pendiente' &&
        ((doc.length >= 5 && soloDigitos(p.documentNumber) === doc) || (tel.length >= 7 && normTelefono(p.phone) === tel)),
    ) || null
  );
}

/** Configuración del conjunto: por defecto se exige aprobación. */
export function requiereAprobacion(conjuntoRecord: any): boolean {
  const v = conjuntoRecord?.registroQr?.requiereAprobacion;
  return v === undefined || v === null ? true : !!v;
}
