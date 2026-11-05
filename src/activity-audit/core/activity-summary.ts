// ==========================================
// activity-audit · core · resumen de actividad
// ==========================================
// Función pura: convierte logs crudos en un resumen por módulo/día/usuario.
// Sin dependencias de framework ni de Firebase (fácil de probar).
import type { ActivityLog, ActivitySummary, ModuleUsage, OpeningsSummary, ScreenViewsSummary } from './types';

/** Verbo (primera palabra de `vista`) -> tipo de acción. */
const VERBOS: Record<string, 'crear' | 'editar' | 'eliminar' | 'otra'> = {
  'creó': 'crear',
  'importó': 'crear',
  'generó': 'crear',
  'editó': 'editar',
  'revisó': 'editar',
  'validó': 'editar',
  'eliminó': 'eliminar',
  'analizó': 'otra',
  'consultó': 'otra',
};

/** Recurso (como lo etiqueta el interceptor o el frontend) -> nombre de módulo. */
const MODULOS: Record<string, string> = {
  pago: 'Pagos',
  'pago duplicado': 'Pagos',
  'link de pago': 'Pagos',
  comprobante: 'Pagos',
  usuario: 'Usuarios',
  propietario: 'Usuarios',
  conjunto: 'Conjuntos',
  'zona común': 'Zonas comunes',
  reserva: 'Reservas',
  rol: 'Roles',
  reporte: 'Reportes',
  evento: 'Eventos',
  acuerdo: 'Acuerdos',
  invitado: 'Invitados',
  perfil: 'Perfil',
  archivo: 'Archivos',
  notificación: 'Notificaciones',
  autenticación: 'Autenticación',
  'por carga masiva': 'Carga masiva',
  'ia financiera': 'IA financiera',
};

const VISTA_APERTURA = 'abrió la app';
/**
 * Vista con la que la app registra una navegación a pantalla (equivalente al
 * screen_view de Analytics). El nombre de la pantalla va en `detalle.pantalla`.
 * No empieza por un verbo conocido, así que `clasificar()` la ignora y no
 * contamina el resumen de módulos (igual que 'abrió la app').
 */
export const VISTA_SCREEN_VIEW = 'vio pantalla';

function normaliza(s: string): string {
  return s.trim().toLowerCase();
}

/** Extrae { modulo, tipo } de un log, o null si no es una acción sobre un módulo. */
export function clasificar(log: ActivityLog): { modulo: string; tipo: 'crear' | 'editar' | 'eliminar' | 'otra' } | null {
  const vista = String(log.vista || '').trim();
  if (!vista) return null;
  const palabras = vista.split(/\s+/);
  const verbo = normaliza(palabras[0]);
  const tipo = VERBOS[verbo];
  if (!tipo) return null;

  // Prioriza el recurso que fijó el interceptor; si no, lo que sigue al verbo
  // (sin el sufijo entre paréntesis, p. ej. "Revisó Pago (Confirmado)").
  const deDetalle = typeof log.detalle?.recurso === 'string' ? (log.detalle.recurso as string) : '';
  const deVista = palabras.slice(1).join(' ').replace(/\s*\(.*\)\s*$/, '');
  const recurso = (deDetalle || deVista).trim();
  if (!recurso) return null;

  const modulo = MODULOS[normaliza(recurso)] || recurso.charAt(0).toUpperCase() + recurso.slice(1);
  return { modulo, tipo };
}

function esError(log: ActivityLog): boolean {
  const status = Number(log.meta?.statusCode ?? 0);
  return normaliza(String(log.vista || '')) === 'error de servicio' || status >= 500;
}

/** YYYY-MM-DD (UTC), igual que la partición de día del store. */
function diaUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function summarizeActivity(
  logs: ActivityLog[],
  opts: { conjunto: string; dias: number; ahora: Date; truncado: boolean },
): ActivitySummary {
  const { conjunto, dias, ahora, truncado } = opts;

  const modulos = new Map<string, ModuleUsage>();
  const usuarios = new Map<string, number>();
  const porDia = new Map<string, { acciones: number }>();
  // Ventana completa (días sin actividad quedan en 0).
  for (let i = dias - 1; i >= 0; i--) {
    porDia.set(diaUtc(ahora.getTime() - i * 86400000), { acciones: 0 });
  }

  let totalAcciones = 0;
  let errores = 0;
  let ultima = 0;

  for (const log of logs) {
    const ts = log.timestamp.getTime();
    if (ts > ultima) ultima = ts;
    const punto = porDia.get(diaUtc(ts));

    if (esError(log)) errores++;

    // Las aperturas de la app y las vistas de pantalla NO son actividad de
    // módulos: se miden aparte (summarizeOpenings / summarizeScreenViews) y se
    // muestran en Monitoreo > Sesiones / Pantallas.
    const vistaNorm = normaliza(String(log.vista || ''));
    if (vistaNorm === VISTA_APERTURA || vistaNorm === VISTA_SCREEN_VIEW) continue;

    const c = clasificar(log);
    if (!c) continue;

    totalAcciones++;
    if (punto) punto.acciones++;
    usuarios.set(log.usuario, (usuarios.get(log.usuario) ?? 0) + 1);

    const m =
      modulos.get(c.modulo) ??
      { modulo: c.modulo, total: 0, creaciones: 0, ediciones: 0, eliminaciones: 0, otras: 0, porcentaje: 0 };
    m.total++;
    if (c.tipo === 'crear') m.creaciones++;
    else if (c.tipo === 'editar') m.ediciones++;
    else if (c.tipo === 'eliminar') m.eliminaciones++;
    else m.otras++;
    modulos.set(c.modulo, m);
  }

  const listaModulos = [...modulos.values()]
    .map((m) => ({ ...m, porcentaje: totalAcciones ? Math.round((m.total / totalAcciones) * 1000) / 10 : 0 }))
    .sort((a, b) => b.total - a.total);

  const topUsuarios = [...usuarios.entries()]
    .filter(([, total]) => total > 0)
    .map(([usuario, total]) => ({ usuario, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return {
    conjunto,
    dias,
    desde: diaUtc(ahora.getTime() - (dias - 1) * 86400000),
    hasta: diaUtc(ahora.getTime()),
    totalEventos: logs.length,
    totalAcciones,
    errores,
    usuariosActivos: usuarios.size,
    ultimaActividad: ultima ? new Date(ultima).toISOString() : null,
    modulos: listaModulos,
    porDia: [...porDia.entries()].map(([dia, v]) => ({ dia, ...v })),
    topUsuarios,
    truncado,
  };
}

/**
 * Aperturas de la app ('Abrió la app') por usuario y por día en la ventana.
 * `conjunto` es opcional: sin él agrega todos los conjuntos.
 */
export function summarizeOpenings(
  logs: ActivityLog[],
  opts: { conjunto?: string; dias: number; ahora: Date; truncado: boolean },
): OpeningsSummary {
  const { conjunto, dias, ahora, truncado } = opts;
  const porUsuario = new Map<string, { total: number; ultima: number }>();
  const porDia = new Map<string, number>();
  for (let i = dias - 1; i >= 0; i--) porDia.set(diaUtc(ahora.getTime() - i * 86400000), 0);

  let total = 0;
  for (const log of logs) {
    if (normaliza(String(log.vista || '')) !== VISTA_APERTURA) continue;
    const usuario = String(log.usuario || '');
    if (!usuario || usuario === 'anonimo') continue;
    const ts = log.timestamp.getTime();
    total++;
    const dia = diaUtc(ts);
    if (porDia.has(dia)) porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
    const prev = porUsuario.get(usuario) ?? { total: 0, ultima: 0 };
    porUsuario.set(usuario, { total: prev.total + 1, ultima: Math.max(prev.ultima, ts) });
  }

  return {
    conjunto: conjunto || '',
    dias,
    total,
    porUsuario: [...porUsuario.entries()]
      .map(([usuario, v]) => ({ usuario, total: v.total, ultima: new Date(v.ultima).toISOString() }))
      .sort((a, b) => b.total - a.total),
    porDia: [...porDia.entries()].map(([dia, aperturas]) => ({ dia, aperturas })),
    truncado,
  };
}

/**
 * Vistas de pantalla ('Vio pantalla') por pantalla y por día en la ventana.
 * El nombre de la pantalla sale de `detalle.pantalla`. `conjunto` es opcional:
 * sin él agrega todos los conjuntos. Es el ranking de "pantallas más usadas".
 */
export function summarizeScreenViews(
  logs: ActivityLog[],
  opts: { conjunto?: string; dias: number; ahora: Date; truncado: boolean },
): ScreenViewsSummary {
  const { conjunto, dias, ahora, truncado } = opts;
  // Por pantalla: total de vistas y usuarios distintos que la vieron.
  const porPantalla = new Map<string, { total: number; usuarios: Set<string> }>();
  const porDia = new Map<string, number>();
  for (let i = dias - 1; i >= 0; i--) porDia.set(diaUtc(ahora.getTime() - i * 86400000), 0);

  let total = 0;
  for (const log of logs) {
    if (normaliza(String(log.vista || '')) !== VISTA_SCREEN_VIEW) continue;
    const pantalla = String(log.detalle?.pantalla || '').trim();
    if (!pantalla) continue;
    const ts = log.timestamp.getTime();
    total++;
    const dia = diaUtc(ts);
    if (porDia.has(dia)) porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
    const prev = porPantalla.get(pantalla) ?? { total: 0, usuarios: new Set<string>() };
    prev.total++;
    const usuario = String(log.usuario || '');
    if (usuario && usuario !== 'anonimo') prev.usuarios.add(usuario);
    porPantalla.set(pantalla, prev);
  }

  return {
    conjunto: conjunto || '',
    dias,
    total,
    porPantalla: [...porPantalla.entries()]
      .map(([pantalla, v]) => ({ pantalla, total: v.total, usuarios: v.usuarios.size }))
      .sort((a, b) => b.total - a.total),
    porDia: [...porDia.entries()].map(([dia, vistas]) => ({ dia, vistas })),
    truncado,
  };
}
