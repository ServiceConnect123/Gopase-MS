import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { FirebaseService } from '../firebase/firebase.service';
import { UsersService } from '../users/users.service';
import { PlansService } from '../plans/plans.service';
import { recoverPassword } from '../auth/password.util';
import { ActivityLogger } from '../activity-audit/core/activity-logger';
import { ACTIVITY_LOGGER } from '../activity-audit/integrations/nest/activity-audit.tokens';

/**
 * Autoregistro de conjuntos (landing pública).
 *
 * Flujo:
 *   1. register  -> crea el conjunto en estado 'pendiente' + su administrador
 *                   (rol 'admin', SIEMPRE: el rol nunca viene del cliente) y
 *                   devuelve un token de un solo propósito para el paso 2.
 *   2. selectPlan -> el administrador elige plan y ciclo (mensual/anual). El
 *                   conjunto pasa a 'prueba' y se fija cuándo vence la prueba:
 *                     mensual -> TRIAL_DIAS_MENSUAL (15)
 *                     anual   -> TRIAL_DIAS_ANUAL   (30 = 15 + 15 de regalo)
 *   3. En ese plazo debe pagar (billing). Un pago confirmado lo pasa a 'activo'
 *      (BillingService.extenderSuscripcion). Si no paga, BillingService lo
 *      suspende al vencer la prueba (login bloqueado; el admin solo ve Facturación).
 *
 * La prueba arranca al REGISTRARSE (con los días del plan mensual) para que un
 * conjunto que abandona el paso 2 nunca quede sin fecha de corte.
 *
 * Datos en mirror/conjuntos/{id}:
 *   estado, trial, trialInicio, trialHasta, pagadoHasta, bloqueado, planId,
 *   ciclo, creadoEn, origen, _secrets/onboardingTokenHash (sha-256 del token).
 */

export type Ciclo = 'mensual' | 'anual';

export interface RegisterInput {
  nombreConjunto?: string;
  ciudad?: string;
  tipo?: string;
  nombreAdmin?: string;
  email?: string;
  telefono?: string;
  mensaje?: string;
  /** Contraseña del administrador, cifrada igual que en POST /users (encriptarAES). */
  password?: string;
  /** Honeypot anti-bots: un humano nunca lo llena. */
  website?: string;
}

export interface SelectPlanInput {
  conjuntoId?: string;
  registroToken?: string;
  planId?: string;
  ciclo?: string;
}

const MIRROR_CONJUNTOS = 'mirror/conjuntos';
const MIRROR_USUARIOS = 'mirror/usuarios';
const TIPOS = ['Campestre', 'Urbano'];
const GENERIC_FAIL = 'No se pudo completar el registro. Intenta de nuevo.';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);
  private readonly trialMensual: number;
  private readonly trialAnual: number;
  private readonly maxPorHora: number;
  private readonly webApiKey: string;
  private readonly emailDomain: string;
  /** ip -> instantes (ms) de los registros recientes. Best-effort, en memoria. */
  private readonly intentos = new Map<string, number[]>();

  constructor(
    private readonly firebase: FirebaseService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly plans: PlansService,
    @Optional() @Inject(ACTIVITY_LOGGER) private readonly activity?: ActivityLogger,
  ) {
    this.trialMensual = this.intEnv('ONBOARDING_TRIAL_DIAS_MENSUAL', 15);
    this.trialAnual = this.intEnv('ONBOARDING_TRIAL_DIAS_ANUAL', 30);
    this.maxPorHora = this.intEnv('ONBOARDING_MAX_POR_HORA', 5);
    // Para validar la contraseña de un correo que ya tiene cuenta (mismo mecanismo
    // que el login: REST de Firebase Auth con el email sintético username@dominio).
    this.webApiKey = this.config.get<string>('FIREBASE_WEB_API_KEY', '');
    this.emailDomain = this.config.get<string>('AUTH_EMAIL_DOMAIN', 'gopase.local');
  }

  /** username -> email sintético (igual que AuthLoginService), para validar login. */
  private usernameToEmail(username: string): string {
    const local = String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    return `${local}@${this.emailDomain}`;
  }

  /**
   * Verifica que `password` sea la contraseña de la cuenta `uid`, usando la REST
   * de Firebase Auth (igual que el login). Evita que alguien registre conjuntos a
   * nombre de un correo ajeno. Fail-closed: si no se puede validar, devuelve false.
   */
  private async validarPassword(uid: string, password: string): Promise<boolean> {
    if (!this.webApiKey || !password) return false;
    try {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.webApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.usernameToEmail(uid), password, returnSecureToken: false }),
        },
      );
      return resp.ok;
    } catch {
      return false;
    }
  }

  private intEnv(name: string, fallback: number): number {
    const n = Number(this.config.get<string>(name, String(fallback)));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  /** Días de prueba según el ciclo elegido. */
  trialDias(ciclo: Ciclo): number {
    return ciclo === 'anual' ? this.trialAnual : this.trialMensual;
  }

  // ---------------------------------------------------------------- helpers

  private safeKey(raw: unknown): string {
    return String(raw ?? '').trim().replace(/[.#$/\[\]]/g, '_');
  }

  /** Texto de una línea: sin caracteres de control, espacios colapsados. */
  private clean(raw: unknown, max: number): string {
    return String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  private norm(raw: unknown): string {
    return String(raw ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Misma regla que la landing: minúsculas, sin tildes ni espacios. */
  private generarUsuario(nombre: string): string {
    return this.norm(nombre).replace(/[^a-z0-9]/g, '').slice(0, 30);
  }

  private toISODate(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  private addDays(d: Date, n: number): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  /** 'YYYY-MM-DD' -> Date a medianoche local (null si no es válida). */
  private parseISODate(raw: unknown): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private tokenMatches(token: string, storedHash: unknown): boolean {
    const stored = String(storedHash ?? '');
    if (!token || !stored) return false;
    const a = Buffer.from(this.hashToken(token), 'hex');
    const b = Buffer.from(stored, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Limita registros por IP y hora. Devuelve true si debe rechazarse. */
  private limitado(ip: string): boolean {
    const ahora = Date.now();
    const ventana = ahora - 60 * 60 * 1000;
    const recientes = (this.intentos.get(ip) ?? []).filter((t) => t > ventana);
    if (recientes.length >= this.maxPorHora) {
      this.intentos.set(ip, recientes);
      return true;
    }
    recientes.push(ahora);
    this.intentos.set(ip, recientes);
    // Evita crecer sin límite con muchas IPs distintas.
    if (this.intentos.size > 5000) {
      for (const [k, v] of this.intentos) {
        if (!v.some((t) => t > ventana)) this.intentos.delete(k);
      }
    }
    return false;
  }

  /** ¿El username ya está tomado en RTDB? (es el uid de Firebase Auth). */
  private async usuarioExiste(usuario: string): Promise<boolean> {
    const key = this.safeKey(usuario);
    if (!key) return false;
    const snap = await this.firebase.db().ref(`${MIRROR_USUARIOS}/${key}`).get();
    return snap.exists();
  }

  /**
   * A partir del `base` (ya normalizado), devuelve el primer username LIBRE:
   * prueba base, base2, base3... hasta 99. Devuelve '' si todos están tomados.
   */
  private async usuarioDisponible(base: string): Promise<string> {
    if (!base) return '';
    if (!(await this.usuarioExiste(base))) return base;
    for (let n = 2; n < 100; n++) {
      const cand = `${base}${n}`;
      if (!(await this.usuarioExiste(cand))) return cand;
    }
    return '';
  }

  /**
   * Comprueba, SIN registrar, qué usuario se le asignaría a un nombre. Lo usa la
   * landing para avisar en vivo si el nombre tal cual ya está tomado (y qué
   * usuario con sufijo quedaría). No revela datos de otros usuarios.
   */
  async checkUsuario(nombre: string): Promise<{
    success: boolean;
    base: string;
    /** Username que quedaría libre (puede llevar sufijo). '' si no hay ninguno. */
    disponible: string;
    /** true si el username tal cual (sin sufijo) ya está tomado. */
    tomado: boolean;
    message?: string;
  }> {
    const base = this.generarUsuario(String(nombre ?? ''));
    if (!base) {
      return { success: false, base: '', disponible: '', tomado: false, message: 'El nombre debe contener letras o números.' };
    }
    if (!this.firebase.isEnabled()) return { success: true, base, disponible: base, tomado: false };
    const tomado = await this.usuarioExiste(base);
    const disponible = tomado ? await this.usuarioDisponible(base) : base;
    return { success: true, base, disponible, tomado };
  }

  // --------------------------------------------------------------- registro

  async register(input: RegisterInput, ip: string): Promise<{
    success: boolean;
    message?: string;
    conjuntoId?: string;
    usuario?: string;
    registroToken?: string;
    trial?: { diasMensual: number; diasAnual: number; hasta: string };
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };

    // Anti-bots: honeypot lleno => se rechaza sin pistas.
    if (this.clean(input?.website, 50)) return { success: false, message: GENERIC_FAIL };
    if (this.limitado(ip || 'desconocida')) {
      return { success: false, message: 'Demasiados registros desde esta conexión. Intenta más tarde.' };
    }

    // ----- Validación -----
    const nombreConjunto = this.clean(input?.nombreConjunto, 80);
    const nombreAdmin = this.clean(input?.nombreAdmin, 80);
    const email = this.clean(input?.email, 120).toLowerCase();
    const telefono = String(input?.telefono ?? '').replace(/\D/g, '');
    const ciudad = this.clean(input?.ciudad, 150);
    const mensaje = this.clean(input?.mensaje, 500);
    const tipo = TIPOS.includes(String(input?.tipo)) ? String(input?.tipo) : 'Campestre';

    if (nombreConjunto.length < 3) return { success: false, message: 'Escribe el nombre del conjunto (mínimo 3 letras).' };
    if (nombreAdmin.length < 3) return { success: false, message: 'Escribe el nombre completo del administrador.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { success: false, message: 'El correo electrónico no es válido.' };
    if (telefono.length < 7 || telefono.length > 15) {
      return { success: false, message: 'El teléfono (WhatsApp) debe tener entre 7 y 15 dígitos.' };
    }
    const password = recoverPassword(String(input?.password ?? ''));
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return { success: false, message: 'La contraseña debe tener mínimo 8 caracteres, con letras y números.' };
    }

    const db = this.firebase.db();

    // ----- Unicidad del conjunto (el nombre es la clave de relación en la app) -----
    const snapConj = await db.ref(MIRROR_CONJUNTOS).get();
    const objetivo = this.norm(nombreConjunto);
    const existentes = snapConj.exists() ? (Object.values(snapConj.val() || {}) as any[]) : [];
    if (existentes.some((c) => this.norm(c?.nombre) === objetivo)) {
      return { success: false, message: 'Ya existe un conjunto con ese nombre. Si es tuyo, ingresa o contáctanos.' };
    }

    // ----- ¿El correo ya tiene cuenta? -----
    // Si existe, NO se crea otra: la misma persona administra un conjunto más con
    // su misma cuenta. Para evitar que alguien registre conjuntos a nombre de un
    // correo ajeno, se exige que la contraseña ingresada sea la de esa cuenta.
    const existente = await this.users.findByEmail(email);
    let usuario: string;
    let usuarioExistente = false;

    if (existente) {
      const passOk = await this.validarPassword(existente.uid, password);
      if (!passOk) {
        return {
          success: false,
          message:
            'Ese correo ya tiene una cuenta. Para registrar otro conjunto con él, escribe la contraseña de esa cuenta (o ingresa y regístralo desde la app).',
        };
      }
      usuario = existente.uid;
      usuarioExistente = true;
    } else {
      // Usuario nuevo: username único (es el uid de Firebase Auth).
      const base = this.generarUsuario(nombreAdmin);
      if (!base) return { success: false, message: 'El nombre del administrador debe contener letras o números.' };
      const libre = await this.usuarioDisponible(base);
      if (!libre) return { success: false, message: GENERIC_FAIL };
      usuario = libre;
    }

    // ----- Conjunto en estado PENDIENTE (con prueba corriendo desde hoy) -----
    const hoy = new Date();
    const hasta = this.toISODate(this.addDays(hoy, this.trialMensual));
    const conjuntoId = `${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
    const key = this.safeKey(conjuntoId);
    const token = randomBytes(24).toString('hex');

    const record: Record<string, any> = {
      id: conjuntoId,
      nombre: nombreConjunto,
      direccion: ciudad,
      tipo,
      descripcion: `Conjunto ${tipo}${mensaje ? ' - ' + mensaje : ''}`,
      cuotaMonto: '',
      moneda: 'COP',
      driveFolderId: '',
      llaveBreB: '',
      adminUsuario: usuario,
      adminNombre: nombreAdmin,
      adminWhatsapp: telefono,
      notifActivo: '',
      // --- suscripción / prueba ---
      estado: 'pendiente',
      trial: true,
      trialInicio: this.toISODate(hoy),
      trialHasta: hasta,
      pagadoHasta: hasta,
      bloqueado: false,
      planId: '',
      ciclo: '',
      creadoEn: hoy.toISOString(),
      origen: 'autoregistro',
      _secrets: { onboardingTokenHash: this.hashToken(token) },
      _fbWrite: true,
    };

    try {
      await db.ref(`${MIRROR_CONJUNTOS}/${key}`).set(record);
    } catch (e: any) {
      this.logger.error(`[onboarding] no se pudo crear el conjunto: ${e?.message}`);
      return { success: false, message: GENERIC_FAIL };
    }

    // ----- Administrador -----
    // Correo nuevo: se crea la cuenta (rol 'admin', FIJO). Correo existente: no se
    // crea nada; solo se le agrega este conjunto a su lista de membresías (su
    // contraseña, rol y conjunto activo no se tocan).
    const userRes = usuarioExistente
      ? await this.users.addConjunto(usuario, nombreConjunto)
      : await this.users.create({
          usuario,
          email,
          password: String(input?.password ?? ''),
          nombre: nombreAdmin,
          rol: 'admin',
          phone: telefono,
          conjunto: nombreConjunto,
        });
    if (!userRes.success) {
      // Rollback: no dejar un conjunto huérfano sin administrador.
      try {
        await db.ref(`${MIRROR_CONJUNTOS}/${key}`).remove();
      } catch (e: any) {
        this.logger.error(`[onboarding] rollback del conjunto ${key} falló: ${e?.message}`);
      }
      this.logger.warn(`[onboarding] asignar admin falló: ${userRes.message || ''}`);
      return { success: false, message: GENERIC_FAIL };
    }

    this.activity?.log({
      vista: 'Registró conjunto',
      usuario,
      conjunto: nombreConjunto,
      detalle: { accion: 'Creó', recurso: 'Conjunto', origen: 'autoregistro', conjuntoId, tipo },
    });

    return {
      success: true,
      conjuntoId,
      usuario,
      registroToken: token,
      trial: { diasMensual: this.trialMensual, diasAnual: this.trialAnual, hasta },
    };
  }

  // ------------------------------------------------------------ elegir plan

  async selectPlan(input: SelectPlanInput): Promise<{
    success: boolean;
    message?: string;
    plan?: { id: string; nombre: string };
    ciclo?: Ciclo;
    trialHasta?: string;
    diasPrueba?: number;
    diasRestantes?: number;
  }> {
    if (!this.firebase.isEnabled()) return { success: false, message: 'Servicio no disponible.' };
    const key = this.safeKey(input?.conjuntoId);
    const ciclo = String(input?.ciclo) as Ciclo;
    if (!key || (ciclo !== 'mensual' && ciclo !== 'anual')) {
      return { success: false, message: 'Elige el plan y si pagarás mensual o anual.' };
    }

    const ref = this.firebase.db().ref(`${MIRROR_CONJUNTOS}/${key}`);
    const snap = await ref.get();
    const v: any = snap.exists() ? snap.val() : null;
    // Mismo mensaje si el conjunto no existe o el token no coincide (no filtra existencia).
    if (!v || !this.tokenMatches(String(input?.registroToken ?? ''), v._secrets?.onboardingTokenHash)) {
      return { success: false, message: 'La solicitud no es válida o expiró.' };
    }
    if (v.trial !== true || v.estado === 'activo') {
      return { success: false, message: 'Este conjunto ya tiene una suscripción activa.' };
    }

    const plan = await this.plans.getBasePlan(String(input?.planId ?? ''));
    if (!plan) return { success: false, message: 'El plan elegido no está disponible.' };

    // La prueba cuenta desde el registro: cambiar de ciclo no la reinicia.
    const hoy = new Date();
    const inicio = this.parseISODate(v.trialInicio) ?? hoy;
    const dias = this.trialDias(ciclo);
    const hastaDate = this.addDays(inicio, dias);
    const hasta = this.toISODate(hastaDate);
    const hoyDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    const vencida = hastaDate.getTime() < hoyDia.getTime();

    try {
      await ref.update({
        planId: plan.id,
        ciclo,
        estado: vencida ? 'suspendido' : 'prueba',
        trialHasta: hasta,
        pagadoHasta: hasta,
        bloqueado: vencida,
        planSeleccionadoEn: hoy.toISOString(),
        _fbWrite: true,
      });
    } catch (e: any) {
      this.logger.error(`[onboarding] selectPlan ${key} falló: ${e?.message}`);
      return { success: false, message: GENERIC_FAIL };
    }

    this.activity?.log({
      vista: 'Eligió plan',
      usuario: String(v.adminUsuario || 'anonimo'),
      conjunto: String(v.nombre || ''),
      detalle: { accion: 'Editó', recurso: 'Conjunto', planId: plan.id, ciclo, trialHasta: hasta },
    });

    return {
      success: true,
      message: vencida ? 'Tu periodo de prueba ya terminó. Ingresa y realiza tu pago desde Facturación.' : undefined,
      plan: { id: plan.id, nombre: plan.nombre },
      ciclo,
      trialHasta: hasta,
      diasPrueba: dias,
      diasRestantes: vencida ? 0 : Math.round((hastaDate.getTime() - hoyDia.getTime()) / 86_400_000),
    };
  }
}
