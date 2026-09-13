import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { PropertiesService } from '../properties/properties.service';

/**
 * Lecturas y cálculos de la pantalla de Pagos, movidos del frontend al backend.
 * Lee de Firebase RTDB (mirror/pagos, mirror/usuarios). El frontend solo pinta.
 *
 * Replica la lógica de payments.tsx:
 *   - getUserOverallStatus  -> estado global (isAlDia, paidCount, totalApplicable)
 *   - getUserMonthlyStatus  -> estado mes a mes de un usuario
 *   - getDebtors            -> deudores de un mes (con teléfono)
 */
const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export interface Pago {
  id: string;
  usuario: string;
  concepto: string;
  valor: any;
  fecha: string;
  estado: string;
  referencia: string;
}

interface Usuario {
  usuario: string;
  nombre: string;
  rol: string;
  phone: string;
  conjunto: string;
  fechaIngreso?: string;
}

export interface AdminListItem {
  username: string;
  name: string;
  paidCount: number;
  totalApplicable: number;
  isAlDia: boolean;
}

export interface MonthStatus {
  month: string;
  status: string;
  color: string;
  icon: string;
  payment: Pago | null;
}

export interface Debtor {
  name: string;
  phone: string;
  username: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly properties: PropertiesService,
  ) {}

  private parseFechaIngreso(raw: any): { year: number; monthIndex: number } | null {
    const s = String(raw || '').trim();
    if (!s) return null;
    const datePart = s.split('T')[0].split(' ')[0];
    let m = datePart.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) return { year: parseInt(m[1], 10), monthIndex: parseInt(m[2], 10) - 1 };
    m = datePart.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return { year: parseInt(m[3], 10), monthIndex: parseInt(m[2], 10) - 1 };
    const d = new Date(s);
    if (!isNaN(d.getTime())) return { year: d.getFullYear(), monthIndex: d.getMonth() };
    return null;
  }

  /** Lee una colección "mirror/x" y la devuelve como array de valores. */
  private async readCollection<T>(name: string): Promise<T[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    const snap = await this.firebase.db().ref(`mirror/${name}`).get();
    if (!snap.exists()) return [];
    const val = snap.val() || {};
    return Object.values(val) as T[];
  }

  /** Pagos del año (filtra por que el concepto incluya el año). */
  private filterPagosByYear(pagos: Pago[], year: number): Pago[] {
    const y = String(year);
    return pagos.filter((p) => (p.concepto || '').includes(y));
  }

  /** ¿El usuario tiene pago Confirmado en ese mes+año? */
  private isPaidMonth(pagos: Pago[], username: string, idx: number, year: number): boolean {
    const month = MONTHS[idx];
    return pagos.some((p) => {
      const isMatch = p.usuario === username;
      const conceptLower = (p.concepto || '').toLowerCase();
      return (
        isMatch &&
        conceptLower.includes(month.toLowerCase()) &&
        (p.concepto || '').includes(String(year)) &&
        (p.estado || '').toLowerCase() === 'confirmado'
      );
    });
  }

  /** Estado global de un usuario (isAlDia + conteo), como getUserOverallStatus. */
  private overallStatus(pagos: Pago[], u: Usuario, year: number) {
    const todayMonthIndex = new Date().getMonth();
    const isCurrentYear = year === new Date().getFullYear();
    const maxMonth = isCurrentYear ? todayMonthIndex : 11;

    const ingreso = this.parseFechaIngreso(u.fechaIngreso);
    const ingresoYear = ingreso?.year ?? 0;
    const ingresoMonthIndex = ingreso?.monthIndex ?? 0;

    let startMonth = 0;
    if (ingreso && ingresoYear === year) startMonth = ingresoMonthIndex;
    else if (ingreso && ingresoYear > year) return { paidCount: 0, totalApplicable: 0, isAlDia: true };

    let paidCount = 0;
    let totalApplicable = 0;
    for (let idx = startMonth; idx <= maxMonth; idx++) {
      totalApplicable++;
      if (this.isPaidMonth(pagos, u.usuario, idx, year)) paidCount++;
    }

    const lastDueMonth = isCurrentYear ? todayMonthIndex - 1 : 11;
    let ultimoMesPagado = -1;
    for (let idx = 11; idx >= 0; idx--) {
      if (this.isPaidMonth(pagos, u.usuario, idx, year)) { ultimoMesPagado = idx; break; }
    }

    const isAlDia = lastDueMonth < startMonth ? true : ultimoMesPagado >= lastDueMonth;
    return { paidCount, totalApplicable, isAlDia };
  }

  // -------------------- API pública --------------------

  /** Lista de propietarios del conjunto con su estado de pago (vista admin). */
  async getAdminList(conjunto: string, year: number, isSuperAdmin = false): Promise<AdminListItem[]> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);
    const pagos = this.filterPagosByYear(pagosAll, year);

    let users = usuarios.filter((u) => u.rol !== 'superAdmin' && u.rol !== 'vigilante');
    if (!isSuperAdmin && conjunto) {
      users = users.filter((u) => (u.conjunto || '') === conjunto);
    }

    const list: AdminListItem[] = users.map((u) => {
      const { paidCount, totalApplicable, isAlDia } = this.overallStatus(pagos, u, year);
      return { username: u.usuario, name: u.nombre || u.usuario, paidCount, totalApplicable, isAlDia };
    });

    list.sort((a, b) => (a.isAlDia === b.isAlDia ? a.name.localeCompare(b.name) : a.isAlDia ? 1 : -1));
    return list;
  }

  /** Estado mes a mes de un usuario (para el detalle). */
  async getUserMonths(username: string, year: number): Promise<MonthStatus[]> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);
    const pagos = this.filterPagosByYear(pagosAll, year);
    const u = usuarios.find((x) => x.usuario === username);
    const ingreso = this.parseFechaIngreso(u?.fechaIngreso);
    const ingresoYear = ingreso?.year ?? 0;
    const ingresoMonthIndex = ingreso?.monthIndex ?? -1;
    const todayMonthIndex = new Date().getMonth();
    const isCurrentYear = year === new Date().getFullYear();

    return MONTHS.map((month, idx) => {
      const userPayments = pagos.filter((p) => {
        const isMatch = p.usuario === username;
        const conceptLower = (p.concepto || '').toLowerCase();
        return isMatch && conceptLower.includes(month.toLowerCase());
      });

      let status = 'Pendiente';
      let color = '#F44336';
      let icon = 'close-circle';
      const payment = userPayments.find((p) => p.estado === 'Confirmado') || userPayments[0] || null;

      if (ingresoYear > 0 && (year < ingresoYear || (year === ingresoYear && idx < ingresoMonthIndex))) {
        return { month, status: 'No aplica', color: '#757575', icon: 'remove-circle-outline', payment: null };
      }

      if (userPayments.length > 0) {
        const hasConfirmed = userPayments.some((p) => p.estado === 'Confirmado');
        const hasPending = userPayments.some((p) => p.estado === 'Pendiente');
        if (hasConfirmed) { status = 'Pagado'; color = '#4CAF50'; icon = 'checkmark-circle'; }
        else if (hasPending) { status = 'Por confirmar'; color = '#FF9800'; icon = 'time'; }
      } else if ((isCurrentYear && idx >= todayMonthIndex) || year > new Date().getFullYear()) {
        status = 'Disponible'; color = '#2196F3'; icon = 'add-circle-outline';
      }

      return { month, status, color, icon, payment };
    });
  }

  /** Pagos de un propietario en el año (su propia vista). */
  async getOwnerPayments(username: string, year: number): Promise<Pago[]> {
    const pagosAll = await this.readCollection<Pago>('pagos');
    return this.filterPagosByYear(pagosAll, year).filter((p) => p.usuario === username);
  }

  /**
   * Pagos crudos del conjunto en el año (vista admin, lista de pagos). Filtra a
   * los pagos de usuarios del conjunto (salvo superAdmin, que ve todos). Se lee
   * de mirror/pagos, por lo que refleja de inmediato las escrituras del backend.
   */
  async getPaymentsList(conjunto: string, year: number, isSuperAdmin = false): Promise<Pago[]> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);
    const pagos = this.filterPagosByYear(pagosAll, year);
    if (isSuperAdmin || !conjunto) return pagos;

    const usuariosDelConjunto = new Set(
      usuarios.filter((u) => (u.conjunto || '') === conjunto).map((u) => u.usuario),
    );
    return pagos.filter((p) => usuariosDelConjunto.has(p.usuario));
  }

  /** Deudores de un mes (sin pago confirmado) con teléfono, para recordatorios. */
  async getDebtors(conjunto: string, month: string, year: number, onlyWithPhone = true): Promise<Debtor[]> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);
    const pagos = this.filterPagosByYear(pagosAll, year);
    let users = usuarios.filter((u) => u.rol !== 'superAdmin' && u.rol !== 'vigilante');
    if (conjunto) users = users.filter((u) => (u.conjunto || '') === conjunto);

    const debtors = users
      .filter((u) => {
        const userPayments = pagos.filter((p) => {
          const isMatch = p.usuario === u.usuario;
          const conceptLower = (p.concepto || '').toLowerCase();
          return isMatch && conceptLower.includes(month.toLowerCase());
        });
        return !userPayments.some((p) => p.estado === 'Confirmado');
      })
      .map((u) => ({ name: u.nombre || '', phone: u.phone || '', username: u.usuario || '' }));

    if (onlyWithPhone) {
      return debtors.filter((d) => (d.phone || '').replace(/\D/g, '').length >= 10);
    }
    return debtors;
  }

  // ==================== ESCRITURAS (Fase 2, a RTDB) ====================

  private safeKey(raw: unknown, fallbackIndex = 0): string {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s) return `row_${fallbackIndex}`;
    return s.replace(/[.#$/\[\]]/g, '_');
  }

  /** Crea uno o varios pagos (uno por mes) en mirror/pagos. Devuelve los ids creados. */
  async createPayments(input: {
    usuario: string;
    montoPerMonth: string | number;
    meses: string[];
    year: number;
    estado: string;
    referencia: string;
    conjunto?: string;
    conjuntoId?: string;
  }): Promise<{ success: boolean; ids: string[]; pagos: Pago[] }> {
    const db = this.firebase.db();
    const hoy = new Date().toISOString().split('T')[0];
    const ids: string[] = [];
    const pagos: Pago[] = [];
    const updates: Record<string, any> = {};

    for (const mes of input.meses) {
      const id = Date.now().toString() + Math.random().toString().slice(2, 5);
      const pago: any = {
        id,
        usuario: input.usuario,
        usuarioId: input.usuario,
        concepto: `Administración ${mes} ${input.year}`,
        valor: String(input.montoPerMonth),
        fecha: hoy,
        estado: input.estado,
        referencia: input.referencia,
        conjunto: input.conjunto || '',
        conjuntoId: input.conjuntoId || '',
        // Marca de escritura por Firebase: la sync Sheets->RTDB no debe pisarlo.
        _fbWrite: true,
      };
      updates[`mirror/pagos/${this.safeKey(id)}`] = pago;
      ids.push(id);
      pagos.push(pago);
    }

    await db.ref().update(updates);
    return { success: true, ids, pagos };
  }

  /** Actualiza un pago existente (merge de campos) en mirror/pagos. */
  async updatePayment(id: string, changes: Partial<Pago>): Promise<{ success: boolean; message?: string }> {
    if (!id) return { success: false, message: 'ID de pago requerido' };
    const db = this.firebase.db();
    const ref = db.ref(`mirror/pagos/${this.safeKey(id)}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El pago no existe.' };
    const patch: Record<string, any> = { _fbWrite: true };
    ['usuario', 'concepto', 'valor', 'fecha', 'estado', 'referencia'].forEach((f) => {
      if ((changes as any)[f] !== undefined) patch[f] = String((changes as any)[f]);
    });
    await ref.update(patch);
    return { success: true };
  }

  /** Elimina un pago de mirror/pagos. */
  async deletePayment(id: string): Promise<{ success: boolean; message?: string }> {
    if (!id) return { success: false, message: 'ID de pago requerido' };
    await this.firebase.db().ref(`mirror/pagos/${this.safeKey(id)}`).remove();
    return { success: true };
  }

  /**
   * Aprueba/rechaza un pago. Actualiza su estado y, si su referencia contiene
   * "RESERVA:<id>", pone la reserva vinculada en Activa (Confirmado) o Cancelada
   * (Rechazado).
   */
  async reviewPayment(input: {
    id: string;
    estado: 'Confirmado' | 'Rechazado';
    valor?: string | number;
    referencia?: string;
  }): Promise<{ success: boolean; message?: string; reservaMsg?: string }> {
    const db = this.firebase.db();
    const ref = db.ref(`mirror/pagos/${this.safeKey(input.id)}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El pago no existe.' };
    const pago = snap.val();

    const patch: Record<string, any> = { estado: input.estado, _fbWrite: true };
    if (input.valor !== undefined) patch.valor = String(input.valor);
    await ref.update(patch);

    // Vínculo con reserva.
    const referencia = String(input.referencia ?? pago.referencia ?? '');
    const match = referencia.match(/RESERVA:\s*([^\s|]+)/);
    let reservaMsg = '';
    if (match) {
      const reservaId = match[1].trim();
      try {
        const rRef = db.ref(`mirror/reservas/${this.safeKey(reservaId)}`);
        const rSnap = await rRef.get();
        if (rSnap.exists()) {
          await rRef.update({ estado: input.estado === 'Confirmado' ? 'Activa' : 'Cancelada', _fbWrite: true });
          reservaMsg = input.estado === 'Confirmado' ? ' La reserva quedó activa.' : ' La reserva fue cancelada.';
        } else {
          reservaMsg = ` (No se encontró la reserva ${reservaId}.)`;
        }
      } catch {
        reservaMsg = ' (Error actualizando la reserva vinculada.)';
      }
    }
    return { success: true, reservaMsg };
  }

  // ==================== OCR / Mercado Pago (claves en el backend) ====================

  /**
   * Analiza un comprobante con Gemini. La geminiKey se lee de Sheets (por
   * conjunto) y NUNCA se expone al cliente.
   * - soloExtraerMonto=true: devuelve { monto }.
   * - soloExtraerMonto=false: devuelve el análisis forense completo.
   */
  async analyzeReceipt(input: {
    conjunto: string;
    imageBase64: string;
    soloExtraerMonto?: boolean;
  }): Promise<{ success: boolean; message?: string; monto?: number; analysis?: any }> {
    if (!input.imageBase64) return { success: false, message: 'Imagen vacía.' };
    const secrets = await this.properties.getSecretsByConjunto(input.conjunto);
    const geminiKey = secrets?.geminiKey || '';
    if (!geminiKey) return { success: false, message: 'El conjunto no tiene Gemini configurado.' };
    const llaveBreB = secrets?.llaveBreB || '';
    const image = input.imageBase64.includes(',') ? input.imageBase64.split(',').pop()! : input.imageBase64;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${geminiKey}`;

    // Modo admin: solo extraer el monto.
    if (input.soloExtraerMonto) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: `Extrae SOLO el monto total pagado de este comprobante colombiano y responde únicamente con el número entero en pesos, sin puntos ni comas ni símbolos. En Colombia el punto separa miles y la coma decimales (ej: "60.000,00"=60000, "$120.000"=120000). Si no lo identificas, responde 0.` },
                { inlineData: { mimeType: 'image/jpeg', data: image } },
              ],
            }],
          }),
        });
        const r: any = await resp.json();
        const t = (r?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        const monto = parseInt(String(t).replace(/\D/g, ''), 10) || 0;
        return { success: true, monto };
      } catch (e: any) {
        return { success: false, message: e?.message || 'Error en OCR' };
      }
    }

    // Modo propietario: análisis forense completo.
    try {
      const prompt = `Eres un perito forense digital especializado en detectar fraude en comprobantes de pago bancarios (Nequi, Daviplata, Bancolombia, transferencias Bre-B en Colombia). Analiza esta imagen con rigor y responde SOLO en JSON exacto (sin markdown, sin backticks):
{"esComprobante": true/false, "esAutentico": true/false, "tipoAlteracion": "ninguna|edicion|generada_ia|sospechosa", "nivelRiesgo": "bajo|medio|alto", "destinatarioCorrecto": true/false, "monto": numero, "motivo": "texto"}

Definiciones:
1. esComprobante: true si la imagen es un comprobante/recibo de pago, transferencia bancaria o captura de transacción. false si es una foto normal, selfie, paisaje o documento no financiero.

2. esAutentico: true SOLO si la imagen parece una captura de pantalla ORIGINAL, no editada ni generada. false si detectas CUALQUIER señal de manipulación.

3. tipoAlteracion (clasifica el tipo de alteración detectada):
   - "ninguna": captura original sin señales de manipulación.
   - "edicion": la imagen fue EDITADA (Photoshop/apps de edición). Señales: números o texto con tipografía, tamaño, grosor o alineación distinta al resto; montos/fechas/nombres que se ven "pegados" o con fondo ligeramente diferente; halos, bordes borrosos o pixeles irregulares alrededor de cifras clave (monto, fecha, destinatario, referencia); compresión JPEG desigual por zonas; interlineado o kerning inconsistente en una sola línea.
   - "generada_ia": la imagen fue CREADA/SINTETIZADA por IA generativa. Señales: texto que parece correcto de lejos pero tiene letras deformes, caracteres inventados o "borrosos" al detalle; logos de banco con proporciones o detalles incorrectos; QR con patrón irregular o no cuadrado; iconos deformados; texturas de fondo demasiado "limpias" o repetitivas; sombras y ruido antinaturales; datos incoherentes (fecha imposible, referencia con formato raro).
   - "sospechosa": hay indicios que no puedes clasificar con certeza pero que restan credibilidad.

4. nivelRiesgo: "alto" si estás bastante seguro de edición o generación por IA; "medio" si hay indicios claros pero no concluyentes; "bajo" si parece auténtico.

5. destinatarioCorrecto: ${llaveBreB ? `true si el destinatario/llave/número del comprobante contiene o coincide con "${llaveBreB}". false si es diferente o no se puede verificar.` : 'true (no hay llave configurada para verificar).'}

6. monto: valor entero total pagado en pesos colombianos. En Colombia el punto es separador de miles y la coma decimales. Ej: "60.000,00"=60000, "$120.000"=120000, "1.200.000"=1200000. Solo el número entero sin puntos ni comas. Si no lo identificas, 0.

7. motivo: explica en 1-2 frases concretas QUÉ señales viste (dónde y por qué). Si es auténtico, di "Sin señales de alteración".

Sé conservador: si NO hay evidencia real de manipulación, marca esAutentico=true y tipoAlteracion="ninguna". No inventes fraude donde no lo hay. Responde SOLO el JSON.`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: image } }] }],
        }),
      });
      const result: any = await response.json();
      const text = (result?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      let analysis: any = null;
      try {
        const cleanJson = String(text).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        analysis = JSON.parse(cleanJson);
      } catch {
        // Fallback: al menos intentar el monto.
        const monto = parseInt(String(text).replace(/\D/g, ''), 10) || 0;
        return { success: true, monto, analysis: null };
      }
      return {
        success: true,
        monto: analysis?.monto || 0,
        analysis: {
          esComprobante: !!analysis.esComprobante,
          esAutentico: !!analysis.esAutentico,
          tipoAlteracion: analysis.tipoAlteracion || (analysis.esAutentico ? 'ninguna' : 'sospechosa'),
          nivelRiesgo: analysis.nivelRiesgo || (analysis.esAutentico ? 'bajo' : 'medio'),
          destinatarioCorrecto: !!analysis.destinatarioCorrecto,
          motivo: analysis.motivo || '',
          checkedDestinatario: !!llaveBreB,
        },
      };
    } catch (e: any) {
      return { success: false, message: e?.message || 'Error analizando el comprobante' };
    }
  }

  /**
   * Crea una preferencia de Mercado Pago. La mercadoPagoKey se lee de Sheets
   * (por conjunto) y NUNCA se expone al cliente. Registra los pagos como
   * "Procesando" en mirror/pagos (con _fbWrite) con el external_reference.
   */
  async createPreference(input: {
    conjunto: string;
    usuario: string;
    nombre?: string;
    meses?: string[];
    monto?: number;
    concepto?: string;
    preferredMethod?: string;
    successUrl?: string;
    failureUrl?: string;
    pendingUrl?: string;
  }): Promise<{ success: boolean; message?: string; init_point?: string; preference_id?: string; external_reference?: string }> {
    const secrets = await this.properties.getSecretsByConjunto(input.conjunto);
    const accessToken = secrets?.mercadoPagoKey || '';
    if (!accessToken) return { success: false, message: 'El conjunto no tiene Mercado Pago configurado.' };

    const monto = Number(input.monto ?? secrets?.cuotaMonto ?? 0);
    if (!monto || monto <= 0) return { success: false, message: 'Monto inválido.' };

    const nombreMostrar = input.nombre || input.usuario;
    const meses = input.meses || [];
    const year = new Date().getFullYear();

    const items = meses.length > 0
      ? meses.map((m) => ({
          title: `Administración ${m} ${year}`,
          description: `Pago administración ${input.conjunto} - ${nombreMostrar}`,
          quantity: 1,
          currency_id: 'COP',
          unit_price: monto,
        }))
      : [{
          title: input.concepto || 'Pago Administración',
          description: `Pago ${input.conjunto} - ${nombreMostrar}`,
          quantity: 1,
          currency_id: 'COP',
          unit_price: monto,
        }];

    const externalReference = `GOPASE-${input.usuario}-${Date.now()}`;
    const paymentMethods =
      input.preferredMethod === 'nequi' || input.preferredMethod === 'daviplata'
        ? { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }] }
        : {};

    const payload = {
      items,
      payer: { name: nombreMostrar },
      external_reference: externalReference,
      payment_methods: paymentMethods,
      back_urls: {
        success: input.successUrl || 'https://gopase.vercel.app/app/payments?status=success',
        failure: input.failureUrl || 'https://gopase.vercel.app/app/payments?status=failure',
        pending: input.pendingUrl || 'https://gopase.vercel.app/app/payments?status=pending',
      },
      auto_return: 'approved',
      statement_descriptor: 'GOPASE ADM',
    };

    try {
      const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });
      const mpResult: any = await mpResp.json();
      if (mpResp.status !== 201) {
        return { success: false, message: `Error de Mercado Pago: ${mpResult?.message || 'desconocido'}` };
      }

      // Registrar los pagos como "Procesando" en mirror/pagos (no en Sheets).
      const db = this.firebase.db();
      const updates: Record<string, any> = {};
      const hoy = new Date().toISOString().split('T')[0];
      const base = Date.now().toString();
      const registrar = (id: string, concepto: string) => {
        updates[`mirror/pagos/${this.safeKey(id)}`] = {
          id, usuario: input.usuario, usuarioId: input.usuario, concepto,
          valor: String(monto), fecha: hoy, estado: 'Procesando',
          referencia: externalReference, conjunto: input.conjunto || '', _fbWrite: true,
        };
      };
      if (meses.length > 0) {
        meses.forEach((m, j) => registrar(`${base}-${j}`, `Administración ${m} ${year}`));
      } else {
        registrar(base, input.concepto || 'Pago Administración');
      }
      await db.ref().update(updates);

      return {
        success: true,
        init_point: mpResult.init_point,
        preference_id: mpResult.id,
        external_reference: externalReference,
      };
    } catch (e: any) {
      this.logger.error(`createPreference falló: ${e?.message}`);
      return { success: false, message: e?.message || 'Error creando la preferencia de pago' };
    }
  }
}
