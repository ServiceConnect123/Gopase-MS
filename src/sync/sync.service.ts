import { Injectable, Logger } from '@nestjs/common';
import { SheetsService } from '../sheets/sheets.service';
import { FirebaseService } from '../firebase/firebase.service';

/**
 * Sincronización unidireccional Google Sheets -> Realtime Database.
 *
 * Google Sheets sigue siendo la fuente de verdad; este servicio LEE de Sheets
 * y ESPEJA los datos en el RTDB bajo el namespace `mirror/`. Sirve para migrar
 * paulatinamente sin cambiar el comportamiento actual de la app.
 *
 * Cubre por ahora: conjuntos (propiedades), pagos y usuarios.
 *
 * - Unidireccional: nunca escribe en Sheets.
 * - Idempotente: reescribe la colección completa en cada corrida.
 * - No lanza si falta Firebase: registra y devuelve un resultado.
 */
export type SyncCollection =
  | 'conjuntos'
  | 'pagos'
  | 'usuarios'
  | 'roles'
  | 'invitados'
  | 'eventos'
  | 'citofonia'
  | 'acuerdos'
  | 'zonas_comunes'
  | 'reservas';

const ALL_COLLECTIONS: SyncCollection[] = [
  'conjuntos',
  'usuarios',
  'pagos',
  'roles',
  'invitados',
  'eventos',
  'citofonia',
  'acuerdos',
  'zonas_comunes',
  'reservas',
];

export interface SyncResult {
  collection: SyncCollection;
  success: boolean;
  count: number;
  message?: string;
}

const MIRROR_ROOT = 'mirror';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly sheets: SheetsService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Sanea una clave para usarla como key de nodo en RTDB. */
  private safeKey(raw: unknown, fallbackIndex: number): string {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s) return `row_${fallbackIndex}`;
    return s.replace(/[.#$/\[\]]/g, '_');
  }

  private toKeyed<T extends { id?: string }>(items: T[]): Record<string, T> {
    const out: Record<string, T> = {};
    items.forEach((item, i) => {
      out[this.safeKey(item.id, i)] = item;
    });
    return out;
  }

  // -------------------- Mapeos dato_n -> objeto --------------------

  // propiedades (Hoja 5): dato_1=id, dato_2=nombre, dato_3=direccion, dato_4=tipo,
  // dato_5=descripcion, dato_6=mercadoPagoKey, dato_7=cuotaMonto, dato_8=moneda,
  // dato_9=llaveBreB, dato_10=geminiKey, dato_11=driveFolderId, ...
  // Se omiten claves sensibles (mercadoPagoKey, geminiKey, llaveBreB) del espejo.
  private mapConjunto(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      nombre: String(row.dato_2 ?? ''),
      direccion: row.dato_3 ?? '',
      tipo: row.dato_4 ?? '',
      descripcion: row.dato_5 ?? '',
      cuotaMonto: row.dato_7 ?? '',
      moneda: row.dato_8 ?? 'COP',
      driveFolderId: row.dato_11 ?? '',
    };
  }

  // pagos (Hoja 2): dato_1=id, dato_2=usuario, dato_3=concepto, dato_4=valor,
  // dato_5=fecha, dato_6=estado, dato_7=referencia
  private mapPago(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      usuario: String(row.dato_2 ?? ''),
      concepto: row.dato_3 ?? '',
      valor: row.dato_4 ?? '',
      fecha: row.dato_5 ?? '',
      estado: row.dato_6 ?? '',
      referencia: row.dato_7 ?? '',
    };
  }

  // usuarios (Hoja 1): dato_1=usuario, dato_2=email, dato_3=password(omitida),
  // dato_4=nombre, dato_5=rol, dato_6=docType, dato_7=docNum, dato_8=phone, dato_9=conjunto
  private mapUsuario(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      usuario: String(row.dato_1 ?? ''),
      email: row.dato_2 ?? '',
      // password (dato_3) NO se copia al espejo.
      nombre: row.dato_4 ?? '',
      rol: row.dato_5 ?? '',
      docType: row.dato_6 ?? '',
      docNum: row.dato_7 ?? '',
      phone: row.dato_8 ?? '',
      // Valor crudo del conjunto en Sheets (puede ser id o nombre).
      conjunto: String(row.dato_9 ?? ''),
      parcela: row.dato_10 ?? '',
      placa1: row.dato_11 ?? '',
      placa2: row.dato_12 ?? '',
    };
  }

  // roles (Hoja 4) GLOBAL: dato_1=id, dato_2=name, dato_3=permissions(JSON string)
  private mapRol(row: any) {
    let permisos: any = row.dato_3 ?? '';
    if (typeof permisos === 'string' && permisos.trim()) {
      try {
        permisos = JSON.parse(permisos);
      } catch {
        // Si no es JSON válido, se deja el string tal cual.
      }
    }
    return {
      id: String(row.dato_1 ?? ''),
      nombre: String(row.dato_2 ?? ''),
      permisos,
    };
  }

  // vigilantes/invitados (Hoja 6): dato_1=id, dato_2=nombre, dato_3=placa,
  // dato_4=fecha, dato_5=propietario(username), dato_6=parcela, dato_7=estado,
  // dato_8=horaIngreso, dato_9=nota. El conjunto se resuelve vía el propietario.
  private mapInvitado(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      nombre: row.dato_2 ?? '',
      placa: row.dato_3 ?? '',
      fecha: row.dato_4 ?? '',
      propietario: String(row.dato_5 ?? ''), // username del anfitrión
      parcela: row.dato_6 ?? '',
      estado: row.dato_7 ?? '',
      horaIngreso: row.dato_8 ?? '',
      nota: row.dato_9 ?? '',
    };
  }

  // eventos (Hoja 7): dato_1=id, dato_2=titulo, dato_3=descripcion, dato_4=fecha,
  // dato_5=hora, dato_6=lugar, dato_7=conjunto(NOMBRE), dato_8=creador
  private mapEvento(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      titulo: row.dato_2 ?? '',
      descripcion: row.dato_3 ?? '',
      fecha: row.dato_4 ?? '',
      hora: row.dato_5 ?? '',
      lugar: row.dato_6 ?? '',
      conjunto: String(row.dato_7 ?? ''), // nombre del conjunto
      creador: String(row.dato_8 ?? ''),
    };
  }

  // citofonia (Hoja 8) multipropósito: dato_1=id, dato_2=usuario(username),
  // dato_3=payload/valor, dato_4=origen/conjunto(según tipo), dato_5=tipo, dato_6=timestamp.
  // NOTA: si tipo='subscription', dato_3 son credenciales Web Push (sensibles) que
  // NO se copian al espejo. Solo se espejan las notificaciones.
  private mapCitofonia(row: any) {
    const tipo = String(row.dato_5 ?? '');
    return {
      id: String(row.dato_1 ?? ''),
      usuario: String(row.dato_2 ?? ''),
      // Para 'subscription' NO copiamos el payload (endpoint/keys push).
      mensaje: tipo === 'subscription' ? '' : (row.dato_3 ?? ''),
      origen: row.dato_4 ?? '',
      tipo,
      timestamp: row.dato_6 ?? '',
    };
  }

  // acuerdos (Hoja 9): dato_1=id, dato_2=usuario(username), dato_3=tipo,
  // dato_4=descripcion, dato_5=monto, dato_6=fechaInicio, dato_7=fechaFin,
  // dato_8=estado, dato_9=aplicaA, dato_10=createdBy, dato_11=createdAt
  private mapAcuerdo(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      usuario: String(row.dato_2 ?? ''),
      tipo: row.dato_3 ?? '',
      descripcion: row.dato_4 ?? '',
      monto: row.dato_5 ?? '',
      fechaInicio: row.dato_6 ?? '',
      fechaFin: row.dato_7 ?? '',
      estado: row.dato_8 ?? '',
      aplicaA: String(row.dato_9 ?? ''),
      createdBy: String(row.dato_10 ?? ''),
      createdAt: row.dato_11 ?? '',
    };
  }

  // zonas_comunes (Hoja 13): dato_1=id, dato_2=conjunto, dato_3=nombre,
  // dato_4=esPago, dato_5=precioHora, dato_6=horaApertura, dato_7=horaCierre, dato_8=activo
  private mapZona(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      conjunto: String(row.dato_2 ?? ''), // id o nombre del conjunto
      nombre: row.dato_3 ?? '',
      esPago: row.dato_4 ?? '',
      precioHora: row.dato_5 ?? '',
      horaApertura: row.dato_6 ?? '',
      horaCierre: row.dato_7 ?? '',
      activo: row.dato_8 ?? '',
    };
  }

  // reservas (Hoja 14): dato_1=id, dato_2=conjunto, dato_3=zonaId, dato_4=zonaNombre,
  // dato_5=usuario, dato_6=fecha, dato_7=horas, dato_8=costo, dato_9=estado,
  // dato_10=pagoId, dato_11=comprobanteUrl, dato_12=fechaAprobacion
  private mapReserva(row: any) {
    return {
      id: String(row.dato_1 ?? ''),
      conjunto: String(row.dato_2 ?? ''), // id o nombre del conjunto
      zonaId: String(row.dato_3 ?? ''),
      zonaNombre: row.dato_4 ?? '',
      usuario: String(row.dato_5 ?? ''),
      fecha: row.dato_6 ?? '',
      horas: row.dato_7 ?? '',
      costo: row.dato_8 ?? '',
      estado: row.dato_9 ?? '',
      pagoId: String(row.dato_10 ?? ''),
      comprobanteUrl: row.dato_11 ?? '',
      fechaAprobacion: row.dato_12 ?? '',
    };
  }

  /**
   * Índice para resolver el conjunto de un usuario a su id, sin importar si en
   * Sheets se guardó por id o por nombre. Mapea id->id y nombre(normalizado)->id.
   */
  private buildConjuntoIndex(conjuntos: Array<{ id: unknown; nombre?: unknown }>) {
    const byKey = new Map<string, string>();
    // Fuerza a string antes de normalizar: los valores de Sheets pueden venir
    // como number (ej. un id numérico) y number.trim() no existe.
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    for (const c of conjuntos) {
      const id = String(c.id ?? '');
      if (id) byKey.set(norm(id), id);
      if (c.nombre != null && String(c.nombre) !== '') byKey.set(norm(c.nombre), id);
    }
    return {
      resolve(raw: unknown): string {
        return byKey.get(norm(raw)) ?? '';
      },
    };
  }

  // -------------------- Escritura del espejo --------------------

  private async writeMirror<T extends { id?: string }>(
    collection: SyncCollection,
    items: T[],
  ): Promise<SyncResult> {
    if (!this.firebase.isEnabled()) {
      const message = 'Firebase no está habilitado (revisa las env de Firebase).';
      this.logger.warn(`[sync] ${collection}: ${message}`);
      return { collection, success: false, count: 0, message };
    }
    try {
      const db = this.firebase.db();
      await db.ref(`${MIRROR_ROOT}/${collection}`).set(this.toKeyed(items));
      await db.ref(`${MIRROR_ROOT}/_meta/${collection}`).set({
        count: items.length,
        syncedAt: Date.now(),
      });
      this.logger.log(`[sync] ${collection}: ${items.length} registros espejados.`);
      return { collection, success: true, count: items.length };
    } catch (err: any) {
      this.logger.error(`[sync] ${collection} falló: ${err?.message || err}`);
      return { collection, success: false, count: 0, message: err?.message || 'Error al escribir en RTDB' };
    }
  }

  // Campos del usuario que el PERFIL edita directamente en Firebase. La sync
  // Sheets->RTDB NO debe pisarlos: son la fuente de verdad en Firebase.
  private static readonly USER_PROFILE_FIELDS = [
    'nombre', 'email', 'phone', 'docType', 'docNum', 'parcela', 'placa1', 'placa2',
  ];

  /**
   * Escribe el espejo de USUARIOS preservando los campos que el perfil edita en
   * Firebase. Para cada usuario ya existente en RTDB, conserva sus valores de
   * USER_PROFILE_FIELDS (los editados por el propio usuario) y solo actualiza el
   * resto desde Sheets (rol, conjunto, conjuntoId...). Usuarios nuevos entran completos.
   */
  private async writeMirrorUsuarios(items: Array<Record<string, any> & { id?: string }>): Promise<SyncResult> {
    if (!this.firebase.isEnabled()) {
      const message = 'Firebase no está habilitado (revisa las env de Firebase).';
      this.logger.warn(`[sync] usuarios: ${message}`);
      return { collection: 'usuarios', success: false, count: 0, message };
    }
    try {
      const db = this.firebase.db();
      // Leer lo que ya existe en RTDB para preservar los campos del perfil.
      const snap = await db.ref(`${MIRROR_ROOT}/usuarios`).get();
      const existing: Record<string, any> = snap.exists() ? snap.val() : {};

      const merged: Record<string, any> = {};
      items.forEach((item, i) => {
        const key = this.safeKey(item.id, i);
        const prev = existing[key];
        const next = { ...item };
        if (prev) {
          // Conservar los campos editables del perfil si ya existían.
          for (const f of SyncService.USER_PROFILE_FIELDS) {
            if (prev[f] !== undefined && prev[f] !== null && prev[f] !== '') {
              next[f] = prev[f];
            }
          }
        }
        merged[key] = next;
      });

      await db.ref(`${MIRROR_ROOT}/usuarios`).set(merged);
      await db.ref(`${MIRROR_ROOT}/_meta/usuarios`).set({ count: items.length, syncedAt: Date.now() });
      this.logger.log(`[sync] usuarios: ${items.length} espejados (campos de perfil preservados).`);
      return { collection: 'usuarios', success: true, count: items.length };
    } catch (err: any) {
      this.logger.error(`[sync] usuarios falló: ${err?.message || err}`);
      return { collection: 'usuarios', success: false, count: 0, message: err?.message || 'Error al escribir en RTDB' };
    }
  }

  // -------------------- API pública --------------------

  async syncConjuntos(): Promise<SyncResult> {
    const rows = await this.sheets.read('propiedades');
    return this.writeMirror('conjuntos', rows.map((r) => this.mapConjunto(r)));
  }

  async syncPagos(): Promise<SyncResult> {
    const rows = await this.sheets.read('pagos');
    return this.writeMirror('pagos', rows.map((r) => this.mapPago(r)));
  }

  async syncUsuarios(): Promise<SyncResult> {
    const rows = await this.sheets.read('usuarios');
    // Nota: sin conjuntoId aquí (syncAll lo enriquece). Preserva campos de perfil.
    return this.writeMirrorUsuarios(rows.map((r) => this.mapUsuario(r)));
  }

  async syncRoles(): Promise<SyncResult> {
    const rows = await this.sheets.read('roles');
    return this.writeMirror('roles', rows.map((r) => this.mapRol(r)));
  }

  async syncInvitados(): Promise<SyncResult> {
    const rows = await this.sheets.read('vigilantes');
    return this.writeMirror('invitados', rows.map((r) => this.mapInvitado(r)));
  }

  async syncEventos(): Promise<SyncResult> {
    const rows = await this.sheets.read('eventos');
    return this.writeMirror('eventos', rows.map((r) => this.mapEvento(r)));
  }

  async syncCitofonia(): Promise<SyncResult> {
    const rows = await this.sheets.read('citofonia');
    return this.writeMirror('citofonia', rows.map((r) => this.mapCitofonia(r)));
  }

  async syncAcuerdos(): Promise<SyncResult> {
    const rows = await this.sheets.read('acuerdos');
    return this.writeMirror('acuerdos', rows.map((r) => this.mapAcuerdo(r)));
  }

  async syncZonas(): Promise<SyncResult> {
    const rows = await this.sheets.read('zonas_comunes');
    return this.writeMirror('zonas_comunes', rows.map((r) => this.mapZona(r)));
  }

  async syncReservas(): Promise<SyncResult> {
    const rows = await this.sheets.read('reservas');
    return this.writeMirror('reservas', rows.map((r) => this.mapReserva(r)));
  }

  /** Ejecuta la sincronización de una colección puntual por nombre. */
  async syncOne(collection: SyncCollection): Promise<SyncResult> {
    switch (collection) {
      case 'conjuntos': return this.syncConjuntos();
      case 'pagos': return this.syncPagos();
      case 'usuarios': return this.syncUsuarios();
      case 'roles': return this.syncRoles();
      case 'invitados': return this.syncInvitados();
      case 'eventos': return this.syncEventos();
      case 'citofonia': return this.syncCitofonia();
      case 'acuerdos': return this.syncAcuerdos();
      case 'zonas_comunes': return this.syncZonas();
      case 'reservas': return this.syncReservas();
    }
  }

  /**
   * Sincroniza TODAS las colecciones RESOLVIENDO las relaciones entre ellas:
   *  - a cada usuario le agrega `conjuntoId` (resuelto desde su conjunto en Sheets).
   *  - a cada pago le agrega `usuarioId` y `conjuntoId` (vía su usuario).
   *  - además escribe un árbol anidado en `mirror/tree`:
   *      conjuntoId -> { ...conjunto, usuarios: { userId -> { ...usuario, pagos: { pagoId -> pago } } } }
   *
   * Lee las tres hojas juntas porque las referencias cruzadas lo requieren.
   * No lanza: devuelve el resultado por colección.
   */
  async syncAll(): Promise<{ success: boolean; results: SyncResult[] }> {
    if (!this.firebase.isEnabled()) {
      const message = 'Firebase no está habilitado (revisa las env de Firebase).';
      this.logger.warn(`[sync] syncAll: ${message}`);
      return {
        success: false,
        results: ALL_COLLECTIONS.map((c) => ({ collection: c, success: false, count: 0, message })),
      };
    }

    try {
      // 1. Leer todas las hojas en paralelo.
      const [
        conjRows, userRows, pagoRows, rolRows, invRows,
        eventoRows, citoRows, acuerdoRows, zonaRows, reservaRows,
      ] = await Promise.all([
        this.sheets.read('propiedades'),
        this.sheets.read('usuarios'),
        this.sheets.read('pagos'),
        this.sheets.read('roles'),
        this.sheets.read('vigilantes'),
        this.sheets.read('eventos'),
        this.sheets.read('citofonia'),
        this.sheets.read('acuerdos'),
        this.sheets.read('zonas_comunes'),
        this.sheets.read('reservas'),
      ]);

      const conjuntos = conjRows.map((r) => this.mapConjunto(r));
      const usuarios = userRows.map((r) => this.mapUsuario(r));
      const pagos = pagoRows.map((r) => this.mapPago(r));
      const roles = rolRows.map((r) => this.mapRol(r));
      const invitados = invRows.map((r) => this.mapInvitado(r));
      const eventos = eventoRows.map((r) => this.mapEvento(r));
      const citofonia = citoRows.map((r) => this.mapCitofonia(r));
      const acuerdos = acuerdoRows.map((r) => this.mapAcuerdo(r));
      const zonas = zonaRows.map((r) => this.mapZona(r));
      const reservas = reservaRows.map((r) => this.mapReserva(r));

      // 2. Índices de resolución.
      const conjIndex = this.buildConjuntoIndex(conjuntos);

      // usuario(username) -> conjuntoId. Necesario para las entidades que solo
      // referencian al usuario (invitados, acuerdos, citofonia, pagos).
      const usuariosEnriched = usuarios.map((u) => ({
        ...u,
        conjuntoId: conjIndex.resolve(u.conjunto),
      }));
      const userToConjunto = new Map<string, string>();
      usuariosEnriched.forEach((u) => userToConjunto.set(u.id, u.conjuntoId));
      const conjuntoDeUsuario = (username: string) => userToConjunto.get(username) ?? '';

      // 3. Enriquecer cada colección con conjuntoId (por usuario, nombre o id).
      const pagosEnriched = pagos.map((p) => ({
        ...p,
        usuarioId: p.usuario,
        conjuntoId: conjuntoDeUsuario(p.usuario),
      }));

      // invitados: el conjunto se resuelve vía el propietario (username).
      const invitadosEnriched = invitados.map((g) => ({
        ...g,
        usuarioId: g.propietario,
        conjuntoId: conjuntoDeUsuario(g.propietario),
      }));

      // eventos: dato_7 guarda el NOMBRE del conjunto -> resolver a id.
      const eventosEnriched = eventos.map((e) => ({
        ...e,
        conjuntoId: conjIndex.resolve(e.conjunto),
      }));

      // citofonia: el conjunto se resuelve vía el usuario destinatario.
      const citofoniaEnriched = citofonia.map((c) => ({
        ...c,
        usuarioId: c.usuario,
        conjuntoId: conjuntoDeUsuario(c.usuario),
      }));

      // acuerdos: conjunto vía el usuario (si aplica a 'todos', queda sin conjunto).
      const acuerdosEnriched = acuerdos.map((a) => ({
        ...a,
        usuarioId: a.usuario,
        conjuntoId: conjuntoDeUsuario(a.usuario),
      }));

      // zonas: dato_2 puede ser id o nombre del conjunto -> resolver a id.
      const zonasEnriched = zonas.map((z) => ({
        ...z,
        conjuntoId: conjIndex.resolve(z.conjunto),
      }));

      // reservas: dato_2 conjunto (id/nombre) + usuario para referencias.
      const reservasEnriched = reservas.map((r) => ({
        ...r,
        usuarioId: r.usuario,
        conjuntoId: conjIndex.resolve(r.conjunto) || conjuntoDeUsuario(r.usuario),
      }));

      // 4. Escribir todas las colecciones planas (roles es global; el resto lleva conjuntoId).
      const results: SyncResult[] = [];
      results.push(await this.writeMirror('conjuntos', conjuntos));
      results.push(await this.writeMirrorUsuarios(usuariosEnriched));
      results.push(await this.writeMirror('pagos', pagosEnriched));
      results.push(await this.writeMirror('roles', roles));
      results.push(await this.writeMirror('invitados', invitadosEnriched));
      results.push(await this.writeMirror('eventos', eventosEnriched));
      results.push(await this.writeMirror('citofonia', citofoniaEnriched));
      results.push(await this.writeMirror('acuerdos', acuerdosEnriched));
      results.push(await this.writeMirror('zonas_comunes', zonasEnriched));
      results.push(await this.writeMirror('reservas', reservasEnriched));

      // 5. Árbol anidado conjunto -> usuarios -> pagos (vista de referencia).
      await this.writeTree(conjuntos, usuariosEnriched, pagosEnriched);

      return { success: results.every((r) => r.success), results };
    } catch (err: any) {
      this.logger.error(`[sync] syncAll falló: ${err?.message || err}`);
      return {
        success: false,
        results: ALL_COLLECTIONS.map((c) => ({
          collection: c,
          success: false,
          count: 0,
          message: err?.message || 'Error en syncAll',
        })),
      };
    }
  }

  /**
   * Escribe el árbol relacional en `mirror/tree`:
   *   conjuntoId -> { ...conjunto, usuarios: { userId -> { ...usuario, pagos: { pagoId -> pago } } } }
   * Los usuarios/pagos sin conjunto resuelto quedan bajo la clave "_sin_conjunto".
   */
  private async writeTree(
    conjuntos: Array<{ id: string; nombre?: string }>,
    usuarios: Array<{ id: string; conjuntoId: string } & Record<string, any>>,
    pagos: Array<{ id: string; usuarioId: string } & Record<string, any>>,
  ): Promise<void> {
    const UNASSIGNED = '_sin_conjunto';

    // Agrupar pagos por usuarioId.
    const pagosPorUsuario = new Map<string, Record<string, any>>();
    pagos.forEach((p, i) => {
      const uid = this.safeKey(p.usuarioId, i);
      if (!pagosPorUsuario.has(uid)) pagosPorUsuario.set(uid, {});
      pagosPorUsuario.get(uid)![this.safeKey(p.id, i)] = p;
    });

    // Base del árbol: cada conjunto con su nodo de usuarios vacío.
    const tree: Record<string, any> = {};
    conjuntos.forEach((c, i) => {
      tree[this.safeKey(c.id, i)] = { ...c, usuarios: {} };
    });
    // Bucket para usuarios sin conjunto resuelto.
    tree[UNASSIGNED] = { id: UNASSIGNED, nombre: 'Sin conjunto', usuarios: {} };

    // Colocar cada usuario (con sus pagos) bajo su conjunto.
    usuarios.forEach((u, i) => {
      const cid = u.conjuntoId ? this.safeKey(u.conjuntoId, i) : UNASSIGNED;
      const bucket = tree[cid] ?? tree[UNASSIGNED];
      const uid = this.safeKey(u.id, i);
      bucket.usuarios[uid] = {
        ...u,
        pagos: pagosPorUsuario.get(uid) ?? {},
      };
    });

    // No dejar el bucket "_sin_conjunto" si quedó vacío.
    if (Object.keys(tree[UNASSIGNED].usuarios).length === 0) {
      delete tree[UNASSIGNED];
    }

    const db = this.firebase.db();
    await db.ref(`${MIRROR_ROOT}/tree`).set(tree);
    this.logger.log('[sync] tree: árbol conjunto->usuarios->pagos escrito.');
  }
}
