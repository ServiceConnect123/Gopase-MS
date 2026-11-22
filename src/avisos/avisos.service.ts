import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { DriveService } from '../drive/drive.service';
import { NoticiasService } from '../noticias/noticias.service';
import {
  AvisoDatos,
  MarcaConjunto,
  PLANTILLAS,
  colorValido,
  filasAviso,
  normalizarLogo,
  plantillaPorId,
  renderAvisoPng,
} from './aviso-render';

/**
 * Avisos del conjunto con su marca.
 *
 *   mirror/marcas/{conjuntoKey}  -> logo del conjunto, administradora (nombre y logo),
 *                                   colores. Aparte de mirror/conjuntos para no cargar
 *                                   imágenes en la caché de conjuntos.
 *   mirror/avisos/{id}           -> { id, conjunto, plantilla, campos, formato, diseno,
 *                                   color, estado: borrador|publicado, noticiaId,
 *                                   imagenUrl, autor, autorNombre, creadoEn,
 *                                   actualizadoEn, publicadoEn }
 *
 * Publicar = dibujar la imagen, subirla a la carpeta de Drive del conjunto y
 * crear (o actualizar) la noticia con esa imagen. El envío por WhatsApp se hace
 * desde Noticias, como cualquier otra noticia.
 */
const MIRROR_MARCAS = 'mirror/marcas';
const MIRROR_AVISOS = 'mirror/avisos';
const MIRROR_CONJUNTOS = 'mirror/conjuntos';

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

export interface ConjuntoInfo {
  key: string;
  nombre: string;
  driveFolderId: string;
}

@Injectable()
export class AvisosService {
  private readonly logger = new Logger(AvisosService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly drive: DriveService,
    private readonly noticias: NoticiasService,
  ) {}

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Conjunto por nombre o id (caché en vivo de mirror/conjuntos). */
  async conjunto(raw: string): Promise<ConjuntoInfo | null> {
    const objetivo = norm(raw);
    if (!objetivo || !this.firebase.isEnabled()) return null;
    const all = (await this.firebase.liveVal<Record<string, any>>(MIRROR_CONJUNTOS)) || {};
    for (const key of Object.keys(all)) {
      const v = all[key] || {};
      if (norm(v.id) === objetivo || norm(v.nombre) === objetivo || norm(key) === objetivo) {
        return { key, nombre: String(v.nombre || raw), driveFolderId: String(v.driveFolderId || '') };
      }
    }
    return null;
  }

  plantillas() {
    return PLANTILLAS.map((p) => ({ ...p }));
  }

  // ---------------- Marca ----------------

  async marca(conjuntoRaw: string): Promise<MarcaConjunto | null> {
    const c = await this.conjunto(conjuntoRaw);
    if (!c) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_MARCAS}/${this.safeKey(c.key)}`).get();
    const m = (snap.exists() ? snap.val() : {}) || {};
    return {
      conjunto: c.nombre,
      logoConjunto: String(m.logoConjunto || ''),
      mostrarAdmin: m.mostrarAdmin === true,
      adminNombre: String(m.adminNombre || ''),
      logoAdmin: String(m.logoAdmin || ''),
      colorPrincipal: colorValido(m.colorPrincipal) || '',
      colorAcento: colorValido(m.colorAcento) || '',
    };
  }

  /**
   * Guarda la marca. Logos: data URL o base64 nuevo -> se normaliza a PNG 320 px;
   * '' -> se quita; undefined -> se deja como estaba.
   */
  async guardarMarca(conjuntoRaw: string, dto: any): Promise<{ success: boolean; message?: string; data?: MarcaConjunto }> {
    const c = await this.conjunto(conjuntoRaw);
    if (!c) return { success: false, message: 'El conjunto no existe.' };
    const patch: Record<string, any> = { actualizadoEn: new Date().toISOString() };
    try {
      for (const campo of ['logoConjunto', 'logoAdmin'] as const) {
        if (dto?.[campo] === undefined) continue;
        const v = String(dto[campo] || '');
        patch[campo] = v ? await normalizarLogo(v) : '';
      }
    } catch (e: any) {
      return { success: false, message: `No se pudo leer el logo: ${e?.message || 'formato no válido'}.` };
    }
    if (dto?.mostrarAdmin !== undefined) patch.mostrarAdmin = dto.mostrarAdmin === true;
    if (dto?.adminNombre !== undefined) patch.adminNombre = String(dto.adminNombre || '').trim().slice(0, 60);
    for (const campo of ['colorPrincipal', 'colorAcento'] as const) {
      if (dto?.[campo] === undefined) continue;
      const v = String(dto[campo] || '');
      if (v && !colorValido(v)) return { success: false, message: 'El color debe ser un código como #0F766E.' };
      patch[campo] = colorValido(v) || '';
    }
    await this.firebase.db().ref(`${MIRROR_MARCAS}/${this.safeKey(c.key)}`).update(patch);
    return { success: true, message: 'Marca guardada.', data: (await this.marca(c.key)) || undefined };
  }

  // ---------------- Avisos ----------------

  /** Deja solo los campos de la plantilla, recortados a su máximo. */
  limpiarDatos(dto: any): AvisoDatos {
    const p = plantillaPorId(String(dto?.plantilla || '')) || PLANTILLAS[PLANTILLAS.length - 1];
    const campos: Record<string, string> = {};
    for (const c of p.campos) {
      const v = String(dto?.campos?.[c.key] ?? '').replace(/\s+/g, ' ').trim();
      if (v) campos[c.key] = v.slice(0, c.max);
    }
    return {
      plantilla: p.id,
      campos,
      formato: dto?.formato === 'vertical' ? 'vertical' : 'cuadrado',
      diseno: dto?.diseno === 'B' ? 'B' : 'A',
      color: colorValido(dto?.color) || '',
    };
  }

  /** Falta algún campo obligatorio de la plantilla. */
  faltantes(d: AvisoDatos): string[] {
    const p = plantillaPorId(d.plantilla);
    return (p?.campos || []).filter((c) => c.requerido && !String(d.campos[c.key] || '').trim()).map((c) => c.label);
  }

  async vistaPrevia(conjuntoRaw: string, dto: any): Promise<{ success: boolean; message?: string; imagen?: string }> {
    const marca = await this.marca(conjuntoRaw);
    if (!marca) return { success: false, message: 'El conjunto no existe.' };
    const png = await renderAvisoPng(this.limpiarDatos(dto), marca);
    return { success: true, imagen: `data:image/png;base64,${png.toString('base64')}` };
  }

  async list(conjuntoRaw: string): Promise<any[]> {
    const c = await this.conjunto(conjuntoRaw);
    if (!c) return [];
    const snap = await this.firebase.db().ref(MIRROR_AVISOS).get();
    const items = (snap.exists() ? Object.values(snap.val() || {}) : []) as any[];
    return items
      .filter((a) => norm(a?.conjunto) === norm(c.nombre))
      .map(({ _fbWrite, ...a }) => a)
      .sort((a, b) => String(b.actualizadoEn || '').localeCompare(String(a.actualizadoEn || '')));
  }

  async getById(id: string): Promise<any | null> {
    const key = this.safeKey(id);
    if (!key) return null;
    const snap = await this.firebase.db().ref(`${MIRROR_AVISOS}/${key}`).get();
    return snap.exists() ? snap.val() : null;
  }

  /** Crea o actualiza el borrador (un aviso publicado se puede editar y volver a publicar). */
  async guardar(
    conjuntoRaw: string,
    dto: any,
    autor: { usuario: string; nombre: string },
    id?: string,
  ): Promise<{ success: boolean; message?: string; data?: any }> {
    const c = await this.conjunto(conjuntoRaw);
    if (!c) return { success: false, message: 'El conjunto no existe.' };
    const datos = this.limpiarDatos(dto);
    const ahora = new Date().toISOString();
    let prev: any = null;
    if (id) {
      prev = await this.getById(id);
      if (!prev) return { success: false, message: 'El aviso no existe.' };
      if (norm(prev.conjunto) !== norm(c.nombre)) return { success: false, message: 'El aviso no es de este conjunto.' };
    }
    const avisoId = prev?.id || `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const record = {
      ...(prev || {}),
      id: avisoId,
      conjunto: c.nombre,
      ...datos,
      estado: prev?.estado === 'publicado' ? 'publicado' : 'borrador',
      autor: prev?.autor || autor.usuario,
      autorNombre: prev?.autorNombre || autor.nombre,
      creadoEn: prev?.creadoEn || ahora,
      actualizadoEn: ahora,
      _fbWrite: true,
    };
    await this.firebase.db().ref(`${MIRROR_AVISOS}/${this.safeKey(avisoId)}`).set(record);
    const { _fbWrite, ...data } = record;
    return { success: true, message: 'Aviso guardado.', data };
  }

  /** Texto de la noticia que acompaña la imagen. */
  textoNoticia(d: AvisoDatos): { titulo: string; subtitulo: string; descripcion: string } {
    const p = plantillaPorId(d.plantilla)!;
    const filas = filasAviso(p, d.campos);
    const descripcion = [...filas.map(([k, v]) => `${k}: ${v}`), d.campos.mensaje || ''].filter(Boolean).join('\n');
    return { titulo: d.campos.titulo || p.tituloSugerido, subtitulo: p.nombre, descripcion };
  }

  async publicar(id: string, autor: { usuario: string; nombre: string }): Promise<{ success: boolean; message?: string; data?: any }> {
    const aviso = await this.getById(id);
    if (!aviso) return { success: false, message: 'El aviso no existe.' };
    const c = await this.conjunto(aviso.conjunto);
    if (!c) return { success: false, message: 'El conjunto no existe.' };
    const datos = this.limpiarDatos(aviso);
    const faltan = this.faltantes(datos);
    if (faltan.length) return { success: false, message: `Completa: ${faltan.join(', ')}.` };

    const marca = (await this.marca(c.key))!;
    const png = await renderAvisoPng(datos, marca);
    const up = await this.drive.uploadImage(
      png.toString('base64'),
      `aviso_${this.safeKey(id)}_${Date.now()}.png`,
      c.driveFolderId || undefined,
      'image/png',
      c.driveFolderId ? undefined : `Avisos - ${c.nombre}`,
    );
    const imagenUrl = up.success ? up.directLink || up.fileUrl || '' : '';
    if (!imagenUrl) return { success: false, message: up.message || 'No se pudo guardar la imagen del aviso.' };

    const t = this.textoNoticia(datos);
    const noticia = {
      conjunto: c.nombre,
      autor: autor.usuario,
      autorNombre: autor.nombre,
      titulo: t.titulo,
      subtitulo: t.subtitulo,
      descripcion: t.descripcion,
      atributos: ['Aviso', plantillaPorId(datos.plantilla)!.nombre],
      imagenes: [imagenUrl],
    };
    let noticiaId = String(aviso.noticiaId || '');
    const existe = noticiaId ? (await this.noticias.list(c.nombre)).some((n) => String(n.id) === noticiaId) : false;
    const r = existe ? await this.noticias.update(noticiaId, noticia) : await this.noticias.create(noticia);
    if (!r.success) return { success: false, message: r.message || 'No se pudo publicar en Noticias.' };
    if (!existe) noticiaId = String((r as any).id || '');

    const ahora = new Date().toISOString();
    await this.firebase.db().ref(`${MIRROR_AVISOS}/${this.safeKey(id)}`).update({
      estado: 'publicado',
      noticiaId,
      imagenUrl,
      publicadoEn: ahora,
      actualizadoEn: ahora,
      _fbWrite: true,
    });
    return { success: true, message: existe ? 'Aviso actualizado en Noticias.' : 'Aviso publicado en Noticias.', data: { id, noticiaId, imagenUrl } };
  }

  /** Borra el aviso (la noticia publicada se queda; se borra desde Noticias). */
  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    const key = this.safeKey(id);
    if (!key) return { success: false, message: 'ID requerido.' };
    await this.firebase.db().ref(`${MIRROR_AVISOS}/${key}`).remove();
    return { success: true, message: 'Aviso eliminado.' };
  }
}
