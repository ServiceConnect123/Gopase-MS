import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { FirebaseService } from '../firebase/firebase.service';
import { PaymentsService } from '../payments/payments.service';
import { DriveService } from '../drive/drive.service';
import { PropertiesService } from '../properties/properties.service';
import { WhatsappService, MensajeEntrante } from '../whatsapp/whatsapp.service';
import { conPropietario } from '../tenants/tenant-rules';
import { MESES, PagoWspParseado, normTelefono, parsearMensajePago } from './pagos-wsp.parser';
import { MENSAJE_MATCH, identificarPagador, nombreCorto } from './pagos-wsp.matcher';

/**
 * Pagos por WhatsApp: el número vinculado del conjunto lee los mensajes con
 * #pago + foto del comprobante (en el grupo configurado y/o en su chat), y crea
 * el pago "Pendiente" (en revisión) a nombre del propietario identificado.
 * Nunca confirma un pago: el admin lo valida en Pagos, como los de la app.
 *
 * RTDB:
 *   config/pagos_wsp/{conjKey}       configuración del conjunto
 *   wsp_pagos/registros/{conjKey}/{id}  bitácora de mensajes procesados (y duplicados)
 */

export interface ConfigPagosWsp {
  /** Leer pagos del grupo configurado. */
  grupo: boolean;
  /** Leer pagos enviados al chat del número vinculado. */
  chat: boolean;
  grupoEnlace: string;
  grupoJid: string;
  grupoNombre: string;
  /** Fondo por defecto. */
  fondo: string;
  actualizadoPor?: string;
  actualizadoEn?: string;
}

export const CONFIG_VACIA: ConfigPagosWsp = { grupo: false, chat: false, grupoEnlace: '', grupoJid: '', grupoNombre: '', fondo: 'Administración' };

/** Lo que hay que hacer en WhatsApp tras procesar un mensaje. */
export interface Salida {
  estado: 'ignorado' | 'registrado' | 'rechazado' | 'duplicado';
  /** Respuesta privada al remitente. */
  respuesta?: string;
  /** Reacción al mensaje (en el grupo). */
  reaccion?: string;
  /** Aviso al titular cuando el pago lo envió otro número. */
  aviso?: { telefono: string; texto: string };
  ids?: string[];
}

type Periodo = { mes: string; anio: number };

/**
 * Decide qué meses paga el mensaje.
 *  - Con meses escritos: cada uno en el primer año en que está pendiente o disponible.
 *  - Sin meses: desde el primer mes pendiente; tantos meses como cubra el valor (valor / cuota).
 */
export function resolverPeriodos(
  pagables: { meses: Array<{ anio: number; mes: string; idx: number; estado: string }>; primeroPagable: { anio: number; mes: string } | null; cuota: number },
  parseado: PagoWspParseado,
  valor?: number,
): { ok: true; periodos: Periodo[] } | { ok: false; message: string } {
  const libre = (e: string) => e === 'pendiente' || e === 'disponible';
  if (parseado.meses.length) {
    const periodos: Periodo[] = [];
    for (const m of parseado.meses) {
      if (m.anio) {
        periodos.push({ mes: m.mes, anio: m.anio });
        continue;
      }
      const hit = pagables.meses.find((x) => x.mes === m.mes && libre(x.estado));
      if (!hit) return { ok: false, message: `${m.mes} ya está pagado o en revisión.` };
      periodos.push({ mes: m.mes, anio: hit.anio });
    }
    return { ok: true, periodos };
  }
  if (!pagables.primeroPagable) return { ok: false, message: 'Ya estás al día; no hay meses pendientes por pagar.' };
  const cantidad = valor && pagables.cuota > 0 ? Math.max(1, Math.round(valor / pagables.cuota)) : 1;
  const inicio = pagables.meses.findIndex((x) => x.anio === pagables.primeroPagable!.anio && x.mes === pagables.primeroPagable!.mes);
  const periodos: Periodo[] = [];
  for (let i = inicio; i >= 0 && i < pagables.meses.length && periodos.length < cantidad; i++) {
    const x = pagables.meses[i];
    if (libre(x.estado)) periodos.push({ mes: x.mes, anio: x.anio });
    else if (periodos.length) break; // los meses van seguidos
  }
  if (!periodos.length) return { ok: false, message: 'No encontré meses pendientes por pagar.' };
  return { ok: true, periodos };
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const listaMeses = (p: Periodo[]) =>
  p.length === 1 ? `${p[0].mes.toLowerCase()} ${p[0].anio}` : `${p[0].mes.toLowerCase()} a ${p[p.length - 1].mes.toLowerCase()} ${p[p.length - 1].anio}`;

@Injectable()
export class PagosWspService implements OnModuleInit {
  private readonly logger = new Logger(PagosWspService.name);
  /** Cola por conjunto: los mensajes se procesan de a uno (evita duplicados en carrera). */
  private colas = new Map<string, Promise<unknown>>();

  constructor(
    private readonly firebase: FirebaseService,
    private readonly payments: PaymentsService,
    private readonly drive: DriveService,
    private readonly properties: PropertiesService,
    private readonly whatsapp: WhatsappService,
  ) {}

  async onModuleInit() {
    this.whatsapp.alRecibirMensaje((m) => this.atender(m));
    try {
      await this.aplicarConfiguraciones();
    } catch (e: any) {
      this.logger.warn(`No se pudo cargar la configuración de pagos por WhatsApp: ${e?.message}`);
    }
  }

  // ------------------------------------------------------------ configuración
  private claveConj(conjunto: string) {
    return String(conjunto || '').trim().toLowerCase().replace(/[.#$/\[\]]/g, '_') || 'sin_conjunto';
  }

  async getConfig(conjunto: string): Promise<ConfigPagosWsp> {
    if (!this.firebase.isEnabled()) return { ...CONFIG_VACIA };
    const v = await this.firebase.liveVal<any>(`config/pagos_wsp/${this.claveConj(conjunto)}`);
    return { ...CONFIG_VACIA, ...(v || {}) };
  }

  /** Guarda la configuración; si cambió el enlace del grupo, el número vinculado se une a él. */
  async guardarConfig(
    conjunto: string,
    cambios: Partial<ConfigPagosWsp>,
    autor: string,
  ): Promise<{ success: boolean; message?: string; config?: ConfigPagosWsp }> {
    const prev = await this.getConfig(conjunto);
    const next: ConfigPagosWsp = {
      ...prev,
      grupo: cambios.grupo ?? prev.grupo,
      chat: cambios.chat ?? prev.chat,
      fondo: String(cambios.fondo ?? prev.fondo ?? 'Administración').trim() || 'Administración',
      actualizadoPor: autor,
      actualizadoEn: new Date().toISOString(),
    };
    const enlace = cambios.grupoEnlace !== undefined ? String(cambios.grupoEnlace || '').trim() : prev.grupoEnlace;
    if (enlace !== prev.grupoEnlace || (enlace && !prev.grupoJid)) {
      if (!enlace) {
        Object.assign(next, { grupoEnlace: '', grupoJid: '', grupoNombre: '', grupo: false });
      } else {
        const r = await this.whatsapp.unirseAGrupo(conjunto, enlace);
        if (!r.ok) return { success: false, message: r.message };
        Object.assign(next, { grupoEnlace: enlace, grupoJid: r.jid, grupoNombre: r.nombre });
      }
    }
    if (next.grupo && !next.grupoJid) return { success: false, message: 'Pega primero el enlace del grupo de WhatsApp.' };
    await this.firebase.db().ref(`config/pagos_wsp/${this.claveConj(conjunto)}`).set({ ...next, conjunto });
    this.aplicar(conjunto, next);
    return { success: true, config: next };
  }

  private aplicar(conjunto: string, c: ConfigPagosWsp) {
    this.whatsapp.configurarLectura(conjunto, { grupos: c.grupo && c.grupoJid ? [c.grupoJid] : [], chats: !!c.chat });
  }

  private async aplicarConfiguraciones() {
    if (!this.firebase.isEnabled()) return;
    const todas = (await this.firebase.liveVal<Record<string, any>>('config/pagos_wsp')) || {};
    for (const v of Object.values(todas)) {
      if (v?.conjunto && (v.grupo || v.chat)) this.aplicar(v.conjunto, { ...CONFIG_VACIA, ...v });
    }
  }

  async historial(conjunto: string, limite = 50): Promise<any[]> {
    const v = (await this.firebase.liveVal<Record<string, any>>(`wsp_pagos/registros/${this.claveConj(conjunto)}`)) || {};
    return Object.values(v)
      .sort((a: any, b: any) => String(b.fecha).localeCompare(String(a.fecha)))
      .slice(0, limite)
      .map((r: any) => ({ fecha: r.fecha, origen: r.origen, estado: r.estado, usuario: r.usuario || '', meses: r.meses || '', valor: r.valor || 0, motivo: r.motivo || '' }));
  }

  /** Aviso de mensajes sin leer (cola de lectura llena), si lo hay. */
  async alerta(conjunto: string): Promise<{ descartados: number; desde: string; ultimo: string } | null> {
    const v = await this.firebase.liveVal<any>(`wsp_pagos/alertas/${this.claveConj(conjunto)}`).catch(() => null);
    return v && Number(v.descartados) > 0 ? { descartados: Number(v.descartados), desde: String(v.desde || ''), ultimo: String(v.ultimo || '') } : null;
  }

  async borrarAlerta(conjunto: string): Promise<void> {
    await this.firebase.db().ref(`wsp_pagos/alertas/${this.claveConj(conjunto)}`).remove();
  }

  // ------------------------------------------------------------ mensajes
  /** Llamado por WhatsappService por cada mensaje entrante permitido. */
  private async atender(m: MensajeEntrante): Promise<void> {
    if (!m.texto || !/#\s?pago\b/i.test(m.texto)) return; // el resto se ignora sin costo
    const clave = this.claveConj(m.conjunto);
    const previa = this.colas.get(clave) || Promise.resolve();
    const tarea = previa
      .catch(() => undefined)
      .then(async () => {
        const salida = await this.procesar(m);
        if (salida.reaccion && m.esGrupo) await this.whatsapp.reaccionar(m.conjunto, m.clave, salida.reaccion);
        if (salida.respuesta) await this.whatsapp.responder(m.conjunto, m.responderA, salida.respuesta);
        if (salida.aviso) await this.whatsapp.sendMessage(salida.aviso.telefono, salida.aviso.texto, m.conjunto);
      })
      .catch((e) => this.logger.error(`[pagos-wsp] ${m.conjunto}: ${e?.message}`));
    this.colas.set(clave, tarea);
    await tarea;
  }

  /** Lógica completa de un mensaje (sin enviar nada: devuelve qué responder). */
  async procesar(m: MensajeEntrante): Promise<Salida> {
    const parseado = parsearMensajePago(m.texto);
    if (!parseado.esPago) return { estado: 'ignorado' };
    const conj = this.claveConj(m.conjunto);
    const origen = m.esGrupo ? 'grupo' : 'chat';
    const registrar = async (estado: Salida['estado'], extra: Record<string, any>) => {
      await this.firebase
        .db()
        .ref(`wsp_pagos/registros/${conj}/${this.safe(m.id)}`)
        .set({ fecha: new Date().toISOString(), origen, estado, remitente: normTelefono(m.telefono), imagenOrigen: m.imagenOrigen || null, ...extra })
        .catch(() => undefined);
    };

    // Ya procesado (WhatsApp puede reentregar el mismo mensaje).
    const ya = await this.firebase.liveVal<any>(`wsp_pagos/registros/${conj}/${this.safe(m.id)}`).catch(() => null);
    if (ya) return { estado: 'duplicado' };

    if (!m.imagen?.length) {
      const respuesta =
        'Para registrar el pago envía la *foto del comprobante* con el texto #pago en el pie de foto, o *responde a la foto* del comprobante escribiendo #pago.';
      await registrar('rechazado', { motivo: 'sin_imagen' });
      return { estado: 'rechazado', respuesta };
    }

    // Palabras que no se entendieron (p. ej. un mes mal escrito): mejor preguntar que adivinar.
    if (parseado.desconocidos.length) {
      const palabras = parseado.desconocidos.slice(0, 3).map((w) => `«${w}»`).join(', ');
      await registrar('rechazado', { motivo: `no_entendido: ${parseado.desconocidos.join(' ')}` });
      return {
        estado: 'rechazado',
        respuesta: `No entendí ${palabras}. Escribe el mes completo o abreviado (noviembre o nov) y vuelve a enviar la foto, por ejemplo:\n#pago Usuario: tu_usuario nov`,
        reaccion: m.esGrupo ? '❓' : undefined,
      };
    }

    // ¿Quién paga?
    const usuarios = conPropietario(((await this.firebase.liveValues<any>('mirror/usuarios')) || []) as any[]);
    const match = identificarPagador({ usuarios, conjunto: m.conjunto, parseado, telefonoRemitente: m.telefono });
    if (!match.ok) {
      await registrar('rechazado', { motivo: match.motivo });
      return { estado: 'rechazado', respuesta: MENSAJE_MATCH[match.motivo], reaccion: m.esGrupo ? '❓' : undefined };
    }
    const cuenta = match.cuenta.usuario;

    // Mismo comprobante enviado antes (mismo archivo).
    const hash = createHash('sha256').update(m.imagen).digest('hex').slice(0, 32);
    const previos = (await this.firebase.liveVal<Record<string, any>>(`wsp_pagos/registros/${conj}`).catch(() => null)) || {};
    if (await this.comprobanteVigente(previos, hash)) {
      await registrar('duplicado', { motivo: 'imagen_repetida', usuario: cuenta, hash });
      return { estado: 'duplicado', respuesta: 'Este comprobante ya se había registrado. No lo volví a registrar.', reaccion: m.esGrupo ? '🔁' : undefined };
    }

    // Lectura del comprobante con IA (monto, autenticidad, cuenta de destino).
    const fondo = (parseado.fondo || '').trim() || (await this.getConfig(m.conjunto)).fondo || 'Administración';
    const base64 = m.imagen.toString('base64');
    const ia = await this.payments
      .analyzeReceipt({ conjunto: m.conjunto, imageBase64: base64, validarDestino: true, tipoRecaudo: fondo })
      .catch(() => ({ success: false }) as any);
    const detectado = ia?.success ? Number(ia.monto) || 0 : 0;
    const valor = parseado.valor || detectado || undefined;

    // Meses a pagar.
    const pagables = await this.payments.getPayableMonths(cuenta, fondo);
    const per = resolverPeriodos(pagables, parseado, valor);
    if (!per.ok) {
      await registrar('rechazado', { motivo: per.message, usuario: cuenta });
      return { estado: 'rechazado', respuesta: per.message };
    }

    // Marcas para la revisión del admin (mismas que usa la app).
    const flags: string[] = [];
    const an = ia?.analysis;
    if (an && an.esAutentico === false) flags.push('MANIPULACION');
    if (an?.checkedDestinatario && !an.destinatarioCorrecto) flags.push('DESTINATARIO');
    if (parseado.valor && detectado && Math.abs(parseado.valor - detectado) > Math.max(1000, detectado * 0.02)) flags.push('MONTO');

    // Comprobante a Drive (si falla, el pago igual queda con la marca de WhatsApp).
    const secrets = await this.properties.getSecretsByConjunto(m.conjunto).catch(() => null);
    const nombreArchivo = `comprobante_${cuenta}_${per.periodos.map((p) => p.mes).join('-')}_${per.periodos[0].anio}_wsp_${Date.now()}.jpg`;
    const subida = await this.drive.uploadImage(base64, nombreArchivo, secrets?.driveFolderId || '').catch(() => ({ success: false }) as any);
    const viaFoto = m.imagenOrigen === 'citada' ? ' (respuesta a la foto)' : m.imagenOrigen === 'anterior' ? ' (foto enviada antes)' : '';
    const nota = `WhatsApp ${origen} desde +57${normTelefono(m.telefono) || '?'}${viaFoto}`;
    const referencia = `${subida?.success && subida.directLink ? `IMG:${subida.directLink} | ` : ''}${nota}${flags.length ? ` [AI:${flags.join(',')}]` : ''}`;
    const porMes = valor ? Math.round(valor / per.periodos.length) : pagables.cuota || 0;

    const res = await this.payments.createPayments({
      usuario: cuenta,
      montoPerMonth: String(porMes),
      year: per.periodos[0].anio,
      periodos: per.periodos,
      estado: 'Pendiente',
      referencia,
      conjunto: match.cuenta.conjunto || m.conjunto,
      tipoRecaudo: fondo,
      pagadoPor: match.pagadoPor,
    });
    if (!res.success) {
      await registrar('rechazado', { motivo: res.message || 'no_creado', usuario: cuenta });
      return { estado: 'rechazado', respuesta: `No pude registrar el pago: ${res.message || 'inténtalo de nuevo.'}` };
    }

    const total = porMes * per.periodos.length;
    await registrar('registrado', {
      usuario: cuenta,
      ids: res.ids,
      hash,
      meses: listaMeses(per.periodos),
      valor: total,
      flags: flags.join(','),
      via: match.via,
    });

    const quien = `${nombreCorto(match.cuenta.nombre)}${match.cuenta.parcela ? ` · ${match.cuenta.parcela}` : ''}`;
    const avisos = flags.includes('DESTINATARIO')
      ? '\n⚠️ La cuenta de destino no parece ser la del conjunto; la administración lo revisará.'
      : flags.includes('MONTO')
        ? `\n⚠️ El valor escrito no coincide con el del comprobante (${pesos(detectado)}).`
        : '';
    const sugerencia = m.esGrupo && match.via === 'documento' ? '\n\nPor privacidad, en el grupo usa tu usuario o teléfono en vez del documento.' : '';
    const respuesta = `✅ Recibimos tu pago de ${listaMeses(per.periodos)} por ${pesos(total)} (${quien}). Queda en revisión de la administración.${avisos}${sugerencia}`;

    const telTitular = normTelefono(match.cuenta.phone || match.cuenta.telefono);
    const aviso =
      match.enviadoPorOtro && telTitular && telTitular !== normTelefono(m.telefono)
        ? { telefono: telTitular, texto: `ℹ️ Se registró un pago de ${listaMeses(per.periodos)} por ${pesos(total)} a tu nombre, enviado desde otro número. Queda en revisión. Si no lo reconoces, avisa a la administración.` }
        : undefined;
    return { estado: 'registrado', respuesta, reaccion: m.esGrupo ? '✅' : undefined, aviso, ids: res.ids };
  }

  /**
   * ¿Este comprobante ya está en un pago vigente? Si el admin rechazó (o eliminó)
   * todos los pagos que creó, se permite reenviarlo.
   */
  private async comprobanteVigente(previos: Record<string, any>, hash: string): Promise<boolean> {
    for (const r of Object.values(previos)) {
      if (r?.hash !== hash || r?.estado !== 'registrado') continue;
      const ids: string[] = Array.isArray(r.ids) ? r.ids : [];
      if (!ids.length) return true;
      for (const id of ids) {
        const pago = await this.firebase.liveVal<any>(`mirror/pagos/${this.safe(id)}`).catch(() => null);
        if (pago && String(pago.estado || '').toLowerCase() !== 'rechazado') return true;
      }
    }
    return false;
  }

  private safe(s: string) {
    return String(s || '').replace(/[.#$/\[\]]/g, '_');
  }
}

