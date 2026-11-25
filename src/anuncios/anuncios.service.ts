import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import {
  Anuncio,
  VistaAnuncio,
  anuncioPendiente,
  aplicaA,
  hoyColombia,
  metricas,
  safeKey,
  validarAnuncio,
} from './anuncio-rules';

/**
 * Anuncios de GoPase (publicidad de la plataforma, p. ej. redes sociales).
 *
 * RTDB:
 *   mirror/anuncios/{id}                     → el anuncio
 *   mirror/anuncios_vistas/{id}/{usuario}    → quién lo vio, cuándo y si tocó el botón
 *
 * Cada usuario ve cada anuncio UNA sola vez: en cuanto se registra su vista,
 * deja de ser «pendiente» para él. El superAdmin crea los anuncios y consulta
 * las métricas (vistas, clics y la lista de quién lo vio).
 */
const MIRROR_ANUNCIOS = 'mirror/anuncios';
const MIRROR_VISTAS = 'mirror/anuncios_vistas';
const MIRROR_USUARIOS = 'mirror/usuarios';

type Resultado = { success: boolean; message?: string; id?: string };

@Injectable()
export class AnunciosService {
  private readonly logger = new Logger(AnunciosService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private limpiar(a: any): Anuncio {
    const { _fbWrite, ...rest } = a || {};
    return {
      ...rest,
      roles: Array.isArray(rest.roles) ? rest.roles : [],
      conjuntos: Array.isArray(rest.conjuntos) ? rest.conjuntos : [],
      activo: rest.activo !== false,
      prioridad: Number(rest.prioridad) || 0,
    } as Anuncio;
  }

  private async todos(): Promise<Anuncio[]> {
    const snap = await this.firebase.db().ref(MIRROR_ANUNCIOS).get();
    if (!snap.exists()) return [];
    return (Object.values(snap.val() || {}) as any[]).map((a) => this.limpiar(a));
  }

  private async vistas(): Promise<Record<string, Record<string, VistaAnuncio>>> {
    const snap = await this.firebase.db().ref(MIRROR_VISTAS).get();
    return snap.exists() ? snap.val() || {} : {};
  }

  /** Perfil del usuario desde la caché en vivo (nombre, rol y conjunto). */
  private async perfil(usuario: string): Promise<{ nombre: string; rol: string; conjunto: string } | null> {
    const usuarios = (await this.firebase.liveVal<Record<string, any>>(MIRROR_USUARIOS)) || {};
    const u = usuarios[safeKey(usuario)];
    if (!u) return null;
    return { nombre: String(u.nombre || u.name || usuario), rol: String(u.rol || ''), conjunto: String(u.conjunto || '') };
  }

  // ------------------------------------------------------------ usuario final

  /** El anuncio que le falta ver al usuario (o null). */
  async pendiente(usuario: string, rolHint = '', conjuntoHint = ''): Promise<Anuncio | null> {
    if (!this.firebase.isEnabled() || !usuario) return null;
    const p = await this.perfil(usuario);
    const rol = p?.rol || rolHint;
    const conjunto = p?.conjunto || conjuntoHint;
    const anuncios = await this.todos();
    if (!anuncios.some((a) => aplicaA(a, rol, conjunto, hoyColombia()))) return null;
    const vistos = await this.vistas();
    const a = anuncioPendiente(anuncios, vistos, usuario, rol, conjunto, hoyColombia());
    return a ? (a as Anuncio) : null;
  }

  /**
   * Registra que el usuario vio el anuncio (idempotente: conserva la primera
   * fecha). Con `clic` = true marca además que tocó el botón.
   */
  async registrarVista(id: string, usuario: string, clic = false, hints: { rol?: string; conjunto?: string; nombre?: string } = {}): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const aKey = safeKey(id);
    const uKey = safeKey(usuario);
    if (!aKey || !uKey) return { success: false, message: 'Faltan datos.' };
    const anuncio = await this.firebase.db().ref(`${MIRROR_ANUNCIOS}/${aKey}`).get();
    if (!anuncio.exists()) return { success: false, message: 'El anuncio no existe.' };

    const ref = this.firebase.db().ref(`${MIRROR_VISTAS}/${aKey}/${uKey}`);
    const prev = (await ref.get()).val() as VistaAnuncio | null;
    const ahora = new Date().toISOString();
    const p = await this.perfil(usuario);
    const vista: VistaAnuncio = {
      usuario: String(usuario),
      nombre: prev?.nombre || p?.nombre || String(hints.nombre || usuario),
      rol: prev?.rol || p?.rol || String(hints.rol || ''),
      conjunto: prev?.conjunto || p?.conjunto || String(hints.conjunto || ''),
      vistoEn: prev?.vistoEn || ahora,
      clic: prev?.clic === true || clic,
      clicEn: prev?.clicEn || (clic ? ahora : ''),
    };
    try {
      await ref.set(vista);
      return { success: true };
    } catch (err: any) {
      this.logger.error(`[anuncios] registrarVista falló: ${err?.message}`);
      return { success: false, message: 'No se pudo registrar la vista.' };
    }
  }

  // ------------------------------------------------------------ superAdmin

  /** Usuarios que podrían ver el anuncio (alcance potencial). */
  private audiencia(a: Anuncio, usuarios: Record<string, any>): number {
    const hoy = a.desde && a.desde > hoyColombia() ? a.desde : hoyColombia();
    const vigente = { ...a, activo: true, desde: '', hasta: '' };
    return Object.values(usuarios).filter((u: any) => aplicaA(vigente, String(u?.rol || ''), String(u?.conjunto || ''), hoy)).length;
  }

  /** Lista de anuncios con sus métricas. */
  async list(): Promise<any[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const [anuncios, vistos, usuarios] = await Promise.all([
      this.todos(),
      this.vistas(),
      this.firebase.liveVal<Record<string, any>>(MIRROR_USUARIOS).then((u) => u || {}),
    ]);
    return anuncios
      .map((a) => {
        const vs = Object.values(vistos[safeKey(a.id)] || {}) as VistaAnuncio[];
        const m = metricas(vs);
        return { ...a, metricas: { vistas: m.vistas, clics: m.clics, tasaClic: m.tasaClic, ultimaVista: m.ultimaVista, audiencia: this.audiencia(a, usuarios) } };
      })
      .sort((x, y) => String(y.creadoEn).localeCompare(String(x.creadoEn)));
  }

  /** Detalle de un anuncio: métricas completas y quién lo vio (más reciente primero). */
  async detalle(id: string): Promise<{ success: boolean; message?: string; anuncio?: Anuncio; metricas?: any; vistas?: VistaAnuncio[] }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const aKey = safeKey(id);
    const snap = await this.firebase.db().ref(`${MIRROR_ANUNCIOS}/${aKey}`).get();
    if (!snap.exists()) return { success: false, message: 'El anuncio no existe.' };
    const vSnap = await this.firebase.db().ref(`${MIRROR_VISTAS}/${aKey}`).get();
    const vistas = (Object.values(vSnap.exists() ? vSnap.val() || {} : {}) as VistaAnuncio[])
      .sort((x, y) => String(y.vistoEn).localeCompare(String(x.vistoEn)));
    const anuncio = this.limpiar(snap.val());
    const usuarios = (await this.firebase.liveVal<Record<string, any>>(MIRROR_USUARIOS)) || {};
    return { success: true, anuncio, metricas: { ...metricas(vistas), audiencia: this.audiencia(anuncio, usuarios) }, vistas };
  }

  async create(dto: any, autor: string): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const v = validarAnuncio(dto);
    if (!v.ok) return { success: false, message: v.error };
    const id = Date.now().toString();
    const ahora = new Date().toISOString();
    try {
      await this.firebase.db().ref(`${MIRROR_ANUNCIOS}/${id}`).set({
        ...v.anuncio, id, creadoPor: String(autor || ''), creadoEn: ahora, actualizadoEn: ahora, _fbWrite: true,
      });
      return { success: true, id, message: 'Anuncio creado.' };
    } catch (err: any) {
      this.logger.error(`[anuncios] create falló: ${err?.message}`);
      return { success: false, message: 'No se pudo crear el anuncio.' };
    }
  }

  async update(id: string, dto: any): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const ref = this.firebase.db().ref(`${MIRROR_ANUNCIOS}/${safeKey(id)}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El anuncio no existe.' };
    const prev = this.limpiar(snap.val());
    const v = validarAnuncio(dto, prev);
    if (!v.ok) return { success: false, message: v.error };
    try {
      await ref.set({ ...prev, ...v.anuncio, id: prev.id, actualizadoEn: new Date().toISOString(), _fbWrite: true });
      return { success: true, id: prev.id, message: 'Anuncio actualizado.' };
    } catch (err: any) {
      this.logger.error(`[anuncios] update falló: ${err?.message}`);
      return { success: false, message: 'No se pudo actualizar el anuncio.' };
    }
  }

  /** Borra el anuncio y sus vistas. */
  async remove(id: string): Promise<Resultado> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = safeKey(id);
    try {
      await this.firebase.db().ref(`${MIRROR_ANUNCIOS}/${key}`).remove();
      await this.firebase.db().ref(`${MIRROR_VISTAS}/${key}`).remove();
      return { success: true, message: 'Anuncio eliminado.' };
    } catch (err: any) {
      this.logger.error(`[anuncios] remove falló: ${err?.message}`);
      return { success: false, message: 'No se pudo eliminar el anuncio.' };
    }
  }
}

