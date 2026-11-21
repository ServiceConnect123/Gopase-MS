import { runFinanceChat, type ChatTurn, type OwnerRow } from './finance-chat.ai';
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { PropertiesService } from '../properties/properties.service';
import { ReportsService } from '../reports/reports.service';
import { FundsService, DEFAULT_FUND_NAME } from '../funds/funds.service';
import { ReceiptData } from '../notifications/receipt-image.generator';

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
  /** Marca de "duplicado validado por el admin" (no vuelve al reporte). */
  dupOk?: boolean;
  /** Fecha/hora de creación del registro (ISO). Vacía en pagos antiguos. */
  createdAt?: string;
}

interface Usuario {
  usuario: string;
  nombre: string;
  rol: string;
  phone: string;
  conjunto: string;
  parcela?: string;
  fechaIngreso?: string;
}

export interface AdminListItem {
  username: string;
  name: string;
  paidCount: number;
  totalApplicable: number;
  isAlDia: boolean;
  /** Unidad (casa/apto) del propietario. */
  unit: string;
  phone: string;
  /**
   * Estado de los 12 meses del año, un carácter por mes (Ene..Dic):
   * p = pagado, c = por confirmar, m = pendiente vencido (mora),
   * d = disponible (aún no vence), n = no aplica (antes del ingreso).
   * Misma regla que getUserMonths, para la tira de meses de la lista.
   */
  months: string;
  /** Meses con pago esperando confirmación. */
  pendingCount: number;
  /** Total confirmado en el año. */
  paidTotal: number;
}

export interface MonthStatus {
  month: string;
  status: string;
  color: string;
  icon: string;
  payment: Pago | null;
  /** Nº de pagos registrados en ese mes (>1 indica duplicado). */
  count: number;
  /** Todos los pagos del mes (para auditar/eliminar duplicados). */
  payments: Pago[];
}

export interface Debtor {
  name: string;
  phone: string;
  username: string;
}

/** Grupo de pagos repetidos (mismo usuario + mes + año). */
export interface DuplicateGroup {
  usuario: string;
  nombre: string;
  mes: string;
  anio: string;
  count: number;
  /** Suma de los pagos "de más" (todos menos uno). */
  montoExtra: number;
  pagos: Pago[];
}

/** Fila mensual del resumen financiero (igual que kpi.tsx). */
export interface FinanceMonth {
  month: string;      // abreviado (Ene, Feb...)
  monthFull: string;  // completo (Enero...)
  income: number;     // cuotas confirmadas del mes + ingresos extra del mes
  expenses: number;   // gastos del mes
  ajuste: number;     // ajustes de cuadre del mes (+/-)
  balance: number;    // income - expenses + ajuste
  recaudoPercent: number;
  saldoCaja: number;  // acumulado, arrancando desde el saldo inicial (arrastre)
}

/**
 * Dinero que ENTRÓ en caja en un mes, según la FECHA del pago/registro (no el
 * mes al que corresponde la cuota). Incluye cuotas confirmadas + ingresos extra.
 */
export interface RecaudoMes {
  month: string;      // abreviado (Ene, Feb...)
  monthFull: string;  // completo (Enero...)
  cuotas: number;     // suma de cuotas confirmadas cuya fecha cae en el mes
  extra: number;      // suma de ingresos extra cuya fecha cae en el mes
  total: number;      // cuotas + extra
  count: number;      // nº de pagos de cuota con fecha en el mes
}

export interface FinanceSummary {
  monthlyData: FinanceMonth[];
  /** Dinero realmente ingresado por mes (según fecha del pago), 12 meses del año. */
  recaudoPorMes: RecaudoMes[];
  totals: {
    totalIncome: number;
    totalExpenses: number;
    totalAjuste: number;
    totalBalance: number;
    saldoCaja: number;
  };
  /** Saldo acumulado de años anteriores (arrastre). */
  saldoInicial: number;
  totalUsers: number;
  /** Desglose del año por tipo de recaudo (fondo). */
  porFondo: Array<{
    id: string;
    nombre: string;
    esDefault: boolean;
    visibleParaPropietario: boolean;
    /** true si el fondo es una caja separada (saldo propio). */
    cajaPropia: boolean;
    metaMensual: number;
    metaAnual: number;
    recaudado: number;
    gastado: number;
    neto: number;
  }>;
  /**
   * Cajas separadas (una por fondo con cajaPropia). Cada una con su saldo propio
   * y arrastre, EXCLUIDA del saldoCaja general. Permite cuadre independiente.
   */
  cajas: Array<{
    id: string;
    nombre: string;
    saldoInicial: number;
    ingresos: number;
    gastos: number;
    ajuste: number;
    saldoCaja: number;
  }>;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly properties: PropertiesService,
    private readonly reports: ReportsService,
    private readonly funds: FundsService,
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

  /**
   * Lee una colección "mirror/x" y la devuelve como array de valores.
   *
   * Se sirve desde la caché en vivo de FirebaseService (listener RTDB): no
   * descarga el árbol en cada petición. Los elementos son COMPARTIDOS entre
   * peticiones: no mutarlos (copiar con spread si hace falta).
   */
  async readCollection<T>(name: string): Promise<T[]> {
    if (!this.firebase.isEnabled()) throw new Error('Servicio no disponible.');
    return this.firebase.liveValues<T>(`mirror/${name}`);
  }

  /** Pagos del año (filtra por que el concepto incluya el año). */
  private filterPagosByYear(pagos: Pago[], year: number): Pago[] {
    const y = String(year);
    return pagos.filter((p) => (p.concepto || '').includes(y));
  }

  /** Índice usuario -> pagos, memoizado por array (vive lo que vive la petición). */
  private readonly byUserIndex = new WeakMap<Pago[], Map<string, Pago[]>>();

  /**
   * Pagos de un usuario dentro de `pagos`, vía un índice construido una sola vez
   * por array. Evita recorrer TODOS los pagos por cada usuario y mes (costo
   * usuarios x meses x pagos, que bloqueaba el event loop con conjuntos grandes).
   */
  pagosDeUsuario(pagos: Pago[], username: string): Pago[] {
    let index = this.byUserIndex.get(pagos);
    if (!index) {
      index = new Map<string, Pago[]>();
      for (const p of pagos) {
        const arr = index.get(p.usuario);
        if (arr) arr.push(p);
        else index.set(p.usuario, [p]);
      }
      this.byUserIndex.set(pagos, index);
    }
    return index.get(username) || [];
  }

  /** ¿El usuario tiene pago Confirmado en ese mes+año? */
  private isPaidMonth(pagos: Pago[], username: string, idx: number, year: number): boolean {
    const month = MONTHS[idx];
    return this.pagosDeUsuario(pagos, username).some((p) => {
      const conceptLower = (p.concepto || '').toLowerCase();
      return (
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

  /**
   * Estado compacto de los 12 meses de un usuario (ver AdminListItem.months).
   * Misma regla que getUserMonths, pero en una sola pasada por los pagos del
   * usuario (la lista admin lo calcula para todos los propietarios).
   */
  private monthCodes(pagos: Pago[], u: Usuario, year: number): { months: string; pendingCount: number; paidTotal: number } {
    const now = new Date();
    const isCurrentYear = year === now.getFullYear();
    const todayMonthIndex = now.getMonth();
    const ingreso = this.parseFechaIngreso(u.fechaIngreso);
    const ingresoYear = ingreso?.year ?? 0;
    const ingresoMonthIndex = ingreso?.monthIndex ?? -1;

    const delUsuario = this.pagosDeUsuario(pagos, u.usuario);
    const conceptos = delUsuario.map((p) => (p.concepto || '').toLowerCase());
    let pendingCount = 0;
    let paidTotal = 0;
    let months = '';
    for (let idx = 0; idx < 12; idx++) {
      if (ingresoYear > 0 && (year < ingresoYear || (year === ingresoYear && idx < ingresoMonthIndex))) {
        months += 'n';
        continue;
      }
      const name = MONTHS[idx].toLowerCase();
      let confirmed = false;
      let pending = false;
      let any = false;
      for (let i = 0; i < delUsuario.length; i++) {
        if (!conceptos[i].includes(name)) continue;
        any = true;
        const estado = delUsuario[i].estado;
        if (estado === 'Confirmado') {
          confirmed = true;
          paidTotal += parseFloat(String(delUsuario[i].valor)) || 0;
        } else if (estado === 'Pendiente') {
          pending = true;
        }
      }
      if (confirmed) months += 'p';
      else if (pending) { months += 'c'; pendingCount++; }
      else if (!any && ((isCurrentYear && idx >= todayMonthIndex) || year > now.getFullYear())) months += 'd';
      else months += 'm';
    }
    return { months, pendingCount, paidTotal };
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
      const { months, pendingCount, paidTotal } = this.monthCodes(pagos, u, year);
      return {
        username: u.usuario,
        name: u.nombre || u.usuario,
        paidCount,
        totalApplicable,
        isAlDia,
        unit: u.parcela || '',
        phone: u.phone || '',
        months,
        pendingCount,
        paidTotal,
      };
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
      const userPayments = this.pagosDeUsuario(pagos, username).filter((p) =>
        (p.concepto || '').toLowerCase().includes(month.toLowerCase()),
      );

      let status = 'Pendiente';
      let color = '#F44336';
      let icon = 'close-circle';
      const payment = userPayments.find((p) => p.estado === 'Confirmado') || userPayments[0] || null;

      if (ingresoYear > 0 && (year < ingresoYear || (year === ingresoYear && idx < ingresoMonthIndex))) {
        return { month, status: 'No aplica', color: '#757575', icon: 'remove-circle-outline', payment: null, count: 0, payments: [] };
      }

      if (userPayments.length > 0) {
        const hasConfirmed = userPayments.some((p) => p.estado === 'Confirmado');
        const hasPending = userPayments.some((p) => p.estado === 'Pendiente');
        if (hasConfirmed) { status = 'Pagado'; color = '#4CAF50'; icon = 'checkmark-circle'; }
        else if (hasPending) { status = 'Por confirmar'; color = '#FF9800'; icon = 'time'; }
      } else if ((isCurrentYear && idx >= todayMonthIndex) || year > new Date().getFullYear()) {
        status = 'Disponible'; color = '#2196F3'; icon = 'add-circle-outline';
      }

      // Se exponen el pago y sus alias con tipoRecaudo normalizado (para que la
      // UI pueda mostrar el fondo de cada mes).
      return {
        month,
        status,
        color,
        icon,
        payment: payment ? this.withPositionalAliases(payment) : null,
        count: userPayments.length,
        payments: userPayments.map((p) => this.withPositionalAliases(p)),
      };
    });
  }

  /**
   * Desglose de lo pagado (confirmado) por un propietario en el año, agrupado por
   * TIPO DE RECAUDO (fondo). Para mini-gráficas del usuario. Normaliza el fondo
   * (pagos antiguos sin tipo => 'Administración').
   */
  async getOwnerFundBreakdown(username: string, year: number): Promise<{
    username: string;
    year: number;
    fondos: { fondo: string; total: number; count: number }[];
    total: number;
  }> {
    const pagosAll = await this.readCollection<Pago>('pagos');
    const pagos = this.filterPagosByYear(pagosAll, year).filter(
      (p) => p.usuario === username && String(p.estado || '').toLowerCase() === 'confirmado',
    );
    const porFondo = new Map<string, { total: number; count: number }>();
    let total = 0;
    for (const p of pagos) {
      const fondo = String((p as any).tipoRecaudo || 'Administración').trim() || 'Administración';
      const valor = parseFloat(String(p.valor)) || 0;
      const prev = porFondo.get(fondo) || { total: 0, count: 0 };
      porFondo.set(fondo, { total: prev.total + valor, count: prev.count + 1 });
      total += valor;
    }
    const fondos = Array.from(porFondo.entries())
      .map(([fondo, v]) => ({ fondo, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);
    return { username, year, fondos, total };
  }

  /**
   * Estadística de pago de un propietario en un año: estado mes a mes (pagado o
   * no, monto, estado), total pagado y cuántos meses aplicables ya pagó. Reutiliza
   * getUserMonths (misma lógica que la pantalla de Pagos).
   */
  async getOwnerStats(username: string, year: number): Promise<{
    username: string;
    nombre: string;
    year: number;
    meses: { month: string; pagado: boolean; monto: number; estado: string }[];
    totalPagado: number;
    mesesPagados: number;
    totalAplicable: number;
  }> {
    const [months, usuarios] = await Promise.all([
      this.getUserMonths(username, year),
      this.readCollection<Usuario>('usuarios'),
    ]);
    const u = usuarios.find((x) => x.usuario === username);

    let totalPagado = 0;
    let mesesPagados = 0;
    let totalAplicable = 0;
    const meses = months.map((m) => {
      const pagado = m.status === 'Pagado';
      // "No aplica" (antes del ingreso del propietario) no cuenta como aplicable.
      if (m.status !== 'No aplica') totalAplicable++;
      const monto = pagado && m.payment ? parseFloat(String(m.payment.valor)) || 0 : 0;
      if (pagado) { mesesPagados++; totalPagado += monto; }
      return { month: m.month, pagado, monto, estado: m.status };
    });

    return {
      username,
      nombre: u?.nombre || username,
      year,
      meses,
      totalPagado,
      mesesPagados,
      totalAplicable,
    };
  }

  /**
   * Reporte "al día" de TODOS los propietarios. Muestra 3 columnas de contexto
   * (M-2, M-1, mes actual) y calcula "al día / en mora" así:
   *
   *   - Se exige tener pagados los DOS meses anteriores al actual: M-1 y M-2.
   *     Si falta alguno (y es exigible según su ingreso) => EN MORA inmediata.
   *   - El mes ACTUAL no se exige todavía: hay una GRACIA de N días CORRIDOS
   *     contados desde el 1° del MES ACTUAL (N = diasGraciaPropietario, default
   *     10, tope 180). Mientras hoy <= (1° del mes actual + N días) y tenga M-1
   *     y M-2 cubiertos, está al día aunque no haya pagado el mes actual.
   *   - Pasada esa gracia, si tampoco pagó el mes actual => en mora.
   *   - Meses anteriores al ingreso del propietario = "N/A" (no exigibles).
   *
   * Así N puede ser 10, 45, 60, ... hasta 180 días desde el 1° del mes actual.
   */
  async getAlDiaReport(conjunto: string, isSuperAdmin = false): Promise<{
    conjunto: string;
    generadoEl: string;
    diaDelMes: number;
    graciaActiva: boolean;
    diasGracia: number;
    meses: { idx: number; anio: number; label: string }[];
    propietarios: {
      nombre: string;
      parcela: string;
      usuario: string;
      m2: string;
      m1: string;
      actual: string;
      alDia: boolean;
    }[];
    totalAlDia: number;
    totalMora: number;
  }> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);

    const now = new Date();
    const diaDelMes = now.getDate();
    // Días de gracia CORRIDOS configurables por conjunto (default 10). En vista
    // global de superAdmin (sin conjunto) se usa el default.
    const diasGracia = conjunto
      ? await this.properties.getDiasGraciaPropietario(conjunto, 10)
      : 10;

    // Gracia del MES ACTUAL: vigente mientras hoy <= (1° del mes actual + N días).
    const hoyMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const inicioMesActual = new Date(now.getFullYear(), now.getMonth(), 1);
    const finGracia = new Date(inicioMesActual.getFullYear(), inicioMesActual.getMonth(), 1 + diasGracia);
    const graciaActiva = hoyMs <= finGracia.getTime();

    // Los 3 meses relevantes (del más antiguo al actual), con su año propio.
    const relMonth = (offset: number) => {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      return { idx: d.getMonth(), anio: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
    };
    const mesM2 = relMonth(2);
    const mesM1 = relMonth(1);
    const mesM = relMonth(0);
    const meses = [mesM2, mesM1, mesM];

    // Pagos cacheados por año (isPaidMonth filtra sobre pagos ya de ese año).
    const pagosPorAnio = new Map<number, Pago[]>();
    const getPagosAnio = (anio: number) => {
      if (!pagosPorAnio.has(anio)) pagosPorAnio.set(anio, this.filterPagosByYear(pagosAll, anio));
      return pagosPorAnio.get(anio)!;
    };

    let users = usuarios.filter((u) => u.rol !== 'superAdmin' && u.rol !== 'vigilante');
    if (!isSuperAdmin && conjunto) {
      users = users.filter((u) => (u.conjunto || '') === conjunto);
    }

    // Estado de un mes para un usuario: 'Pagado' | 'Pendiente' | 'N/A'.
    const estadoMes = (u: Usuario, mes: { idx: number; anio: number }): string => {
      const ingreso = this.parseFechaIngreso(u.fechaIngreso);
      if (ingreso) {
        const antesDeIngreso =
          mes.anio < ingreso.year || (mes.anio === ingreso.year && mes.idx < ingreso.monthIndex);
        if (antesDeIngreso) return 'N/A';
      }
      return this.isPaidMonth(getPagosAnio(mes.anio), u.usuario, mes.idx, mes.anio)
        ? 'Pagado'
        : 'Pendiente';
    };

    const propietarios = users.map((u) => {
      const m2 = estadoMes(u, mesM2);
      const m1 = estadoMes(u, mesM1);
      const actual = estadoMes(u, mesM);

      // Al día:
      //  - M-2 y M-1 cubiertos (Pagado o N/A). Si falta alguno => mora inmediata.
      //  - El mes actual solo se exige pasada la gracia: si no pagó el actual y
      //    ya venció la gracia del mes en curso => mora.
      const m2Ok = m2 === 'Pagado' || m2 === 'N/A';
      const m1Ok = m1 === 'Pagado' || m1 === 'N/A';
      const actualOk = actual === 'Pagado' || actual === 'N/A' || graciaActiva;
      const alDia = m2Ok && m1Ok && actualOk;

      return {
        nombre: u.nombre || u.usuario,
        parcela: u.parcela || '',
        usuario: u.usuario,
        m2,
        m1,
        actual,
        alDia,
      };
    });

    // Orden: primero en mora, luego al día; dentro, por nombre.
    propietarios.sort((a, b) =>
      a.alDia === b.alDia ? a.nombre.localeCompare(b.nombre) : a.alDia ? 1 : -1,
    );

    return {
      conjunto: conjunto || (isSuperAdmin ? 'Todos los conjuntos' : ''),
      generadoEl: now.toISOString().split('T')[0],
      diaDelMes,
      graciaActiva,
      diasGracia,
      meses,
      propietarios,
      totalAlDia: propietarios.filter((p) => p.alDia).length,
      totalMora: propietarios.filter((p) => !p.alDia).length,
    };
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
    // year <= 0 => TODOS los años (usado por el cuadre de caja global). En otro
    // caso, filtra por el año indicado (vía el texto del concepto).
    const pagos = year > 0 ? this.filterPagosByYear(pagosAll, year) : pagosAll;
    let filtered = pagos;
    if (!isSuperAdmin && conjunto) {
      const usuariosDelConjunto = new Set(
        usuarios.filter((u) => (u.conjunto || '') === conjunto).map((u) => u.usuario),
      );
      filtered = pagos.filter((p) => usuariosDelConjunto.has(p.usuario));
    }
    return filtered.map((p) => this.withPositionalAliases(p));
  }

  /** Agrega alias posicionales dato_n a un pago para pantallas que leen por posición. */
  private withPositionalAliases(p: Pago): any {
    return {
      ...p,
      // Fondo del pago (compat: pagos antiguos sin tipo => Administración).
      tipoRecaudo: (p as any).tipoRecaudo || 'Administración',
      dato_1: p.id ?? '',
      dato_2: p.usuario ?? '',
      dato_3: p.concepto ?? '',
      dato_4: p.valor ?? '',
      dato_5: p.fecha ?? '',
      dato_6: p.estado ?? '',
      dato_7: p.referencia ?? '',
      dato_8: (p as any).tipoRecaudo || 'Administración',
    };
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
        const userPayments = this.pagosDeUsuario(pagos, u.usuario).filter((p) =>
          (p.concepto || '').toLowerCase().includes(month.toLowerCase()),
        );
        return !userPayments.some((p) => p.estado === 'Confirmado');
      })
      // phone puede venir como número desde RTDB: se normaliza a string.
      .map((u) => ({ name: u.nombre || '', phone: String(u.phone ?? ''), username: u.usuario || '' }));

    if (onlyWithPhone) {
      return debtors.filter((d) => String(d.phone ?? '').replace(/\D/g, '').length >= 10);
    }
    return debtors;
  }

  /**
   * Detecta pagos repetidos: agrupa por (usuario + mes detectado en el concepto
   * + año) y devuelve los grupos con más de un pago. Útil para auditar y limpiar
   * duplicados (p. ej. doble registro accidental). year<=0 => todos los años.
   */
  async getDuplicatePayments(conjunto: string, year: number, isSuperAdmin = false): Promise<DuplicateGroup[]> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);
    let pagos = year > 0 ? this.filterPagosByYear(pagosAll, year) : pagosAll;
    if (!isSuperAdmin && conjunto) {
      const delConjunto = new Set(
        usuarios.filter((u) => (u.conjunto || '') === conjunto).map((u) => u.usuario),
      );
      pagos = pagos.filter((p) => delConjunto.has(p.usuario));
    }

    const nombrePorUsuario = new Map(usuarios.map((u) => [u.usuario, u.nombre || u.usuario]));

    // Agrupa por usuario + mes (del concepto) + año (del concepto).
    const grupos = new Map<string, Pago[]>();
    for (const p of pagos) {
      const concepto = String(p.concepto || '').toLowerCase();
      const anio = (concepto.match(/\b(20\d{2})\b/) || [])[1] || '?';
      const mesIdx = MONTHS.findIndex((m) => concepto.includes(m.toLowerCase()));
      const mes = mesIdx >= 0 ? MONTHS[mesIdx] : '(sin mes)';
      const key = `${p.usuario}||${mes}||${anio}`;
      const arr = grupos.get(key) || [];
      arr.push(p);
      grupos.set(key, arr);
    }

    const result: DuplicateGroup[] = [];
    for (const [key, arr] of grupos) {
      // Solo cuentan como "duplicado activo" los pagos NO validados por el admin.
      const noValidados = arr.filter((p) => (p as any).dupOk !== true);
      if (noValidados.length < 2) continue;
      const [usuario, mes, anio] = key.split('||');
      const valores = arr.map((x) => parseFloat(String(x.valor)) || 0);
      const montoExtra = valores.reduce((s, v) => s + v, 0) - Math.max(...valores);
      result.push({
        usuario,
        nombre: nombrePorUsuario.get(usuario) || usuario,
        mes,
        anio,
        count: arr.length,
        montoExtra,
        pagos: arr,
      });
    }
    // Mayor cantidad primero.
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  /** Abreviaturas de meses, en el mismo orden que MONTHS. */
  private static readonly MONTHS_SHORT = [
    'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
    'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
  ];

  /** Año embebido en un texto (concepto o fecha), o null. */
  private extractYear(text: string): number | null {
    const m = String(text || '').match(/\b(20\d{2})\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Mes (0-11) de una fecha YYYY-MM-DD o DD/MM/YYYY, o -1. */
  private monthOfFecha(fecha: string): number {
    const f = String(fecha || '');
    if (f.includes('-')) {
      const parts = f.split('T')[0].split('-');
      if (parts.length >= 2) return parseInt(parts[1], 10) - 1;
    } else if (f.includes('/')) {
      const parts = f.split('/');
      if (parts.length >= 2) return parseInt(parts[1], 10) - 1;
    }
    return -1;
  }

  /**
   * Resumen financiero del conjunto para un año: desglose mensual + totales +
   * saldo de caja CON ARRASTRE del saldo acumulado de años anteriores.
   * Replica exactamente los cálculos que hacía kpi.tsx en el cliente.
   */
  async getFinanceSummary(conjunto: string, year: number, isSuperAdmin = false): Promise<FinanceSummary> {
    const [pagosAll, usuarios] = await Promise.all([
      this.readCollection<Pago>('pagos'),
      this.readCollection<Usuario>('usuarios'),
    ]);

    // Pagos del conjunto (todos los años), solo Confirmado.
    let pagosConjunto = pagosAll;
    if (!isSuperAdmin && conjunto) {
      const delConjunto = new Set(
        usuarios.filter((u) => (u.conjunto || '') === conjunto).map((u) => u.usuario),
      );
      pagosConjunto = pagosAll.filter((p) => delConjunto.has(p.usuario));
    }
    const pagosConfirmados = pagosConjunto.filter(
      (p) => String(p.estado || '').toLowerCase() === 'confirmado',
    );

    // Reportes del conjunto (gastos/ingresos extra/ajustes). Monto en dato_8.
    const reportes = await this.reports.list({ conjunto });
    const gastos = reportes.filter((r) => (r.tipo || r.dato_7) === 'Gasto');
    const extra = reportes.filter((r) => (r.tipo || r.dato_7) === 'Ingreso Extra');
    const ajustes = reportes.filter((r) => (r.tipo || r.dato_7) === 'Ajuste Caja');
    const montoReporte = (r: any) => parseFloat(String(r.ubicacion ?? r.dato_8 ?? 0)) || 0;
    const fechaReporte = (r: any) => String(r.fecha ?? r.dato_3 ?? '');

    // --- Fondos / cajas separadas ---
    // Catálogo de fondos del conjunto (incluye el flag cajaPropia). Con esto se
    // separa la caja GENERAL (fondos normales) de cada CAJA PROPIA (fondo con
    // saldo independiente). El fondo por defecto (Administración) es siempre la
    // caja general.
    let catalogoFondos: any[] = [];
    try {
      catalogoFondos = await this.funds.list(conjunto || '');
    } catch {
      catalogoFondos = [];
    }
    const normFondo = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const fondoDef = normFondo(DEFAULT_FUND_NAME);
    // Nombres (lowercase) de fondos marcados como caja propia.
    const cajaPropiaNames = new Set<string>(
      catalogoFondos
        .filter((f) => f.cajaPropia === true && normFondo(f.nombre) !== fondoDef)
        .map((f) => normFondo(f.nombre)),
    );
    // Fondo de un pago / reporte (default Administración = caja general).
    const fondoDePago = (p: any) => normFondo((p as any).tipoRecaudo) || fondoDef;
    const fondoDeReporte = (r: any) => normFondo((r as any).fondo ?? r.dato_10) || fondoDef;
    const esCajaPropiaFondo = (name: string) => cajaPropiaNames.has(name);
    // Un movimiento cuenta para la caja GENERAL si su fondo NO es caja propia.
    const pagoEsGeneral = (p: any) => !esCajaPropiaFondo(fondoDePago(p));
    const reporteEsGeneral = (r: any) => !esCajaPropiaFondo(fondoDeReporte(r));

    // totalUsers = propietarios (criterio del cliente), del conjunto si aplica.
    const totalUsers = usuarios.filter((u) => {
      if ((u.rol || '') !== 'propietario') return false;
      if (!isSuperAdmin && conjunto) return (u.conjunto || '') === conjunto;
      return true;
    }).length;

    // La caja GENERAL excluye los movimientos de fondos con caja propia.
    const pagosGeneral = pagosConfirmados.filter(pagoEsGeneral);
    const gastosGeneral = gastos.filter(reporteEsGeneral);
    const extraGeneral = extra.filter(reporteEsGeneral);
    const ajustesGeneral = ajustes.filter(reporteEsGeneral);

    // --- Saldo inicial (arrastre de años anteriores a `year`) — solo general ---
    const pagosPrev = pagosGeneral.filter((p) => {
      const y = this.extractYear(p.concepto || '');
      return y != null && y < year;
    });
    const sumPrevPagos = pagosPrev.reduce((s, p) => s + (parseFloat(String(p.valor)) || 0), 0);
    const sumPrev = (arr: any[]) =>
      arr
        .filter((r) => {
          const y = this.extractYear(fechaReporte(r));
          return y != null && y < year;
        })
        .reduce((s, r) => s + montoReporte(r), 0);
    const saldoInicial = sumPrevPagos + sumPrev(extraGeneral) + sumPrev(ajustesGeneral) - sumPrev(gastosGeneral);

    // --- Pagos/reportes del año seleccionado (caja general) ---
    const pagosYear = pagosGeneral.filter((p) => (p.concepto || '').includes(String(year)));
    const inYear = (arr: any[]) =>
      arr.filter((r) => fechaReporte(r).includes(String(year)));
    const gastosYear = inYear(gastosGeneral);
    const extraYear = inYear(extraGeneral);
    const ajustesYear = inYear(ajustesGeneral);

    // --- Desglose mensual ---
    const monthlyData: FinanceMonth[] = MONTHS.map((monthFull, idx) => {
      const monthLower = monthFull.toLowerCase();

      const monthPayments = pagosYear.filter((p) =>
        (p.concepto || '').toLowerCase().includes(monthLower),
      );
      const monthIncomeCuotas = monthPayments.reduce((s, p) => s + (parseFloat(String(p.valor)) || 0), 0);
      const uniquePayers = new Set(monthPayments.map((p) => p.usuario || '')).size;
      const recaudoPercent = totalUsers > 0 ? Math.round((uniquePayers / totalUsers) * 100) : 0;

      const monthExtra = extraYear
        .filter((r) => this.monthOfFecha(fechaReporte(r)) === idx)
        .reduce((s, r) => s + montoReporte(r), 0);
      const monthExpenses = gastosYear
        .filter((r) => this.monthOfFecha(fechaReporte(r)) === idx)
        .reduce((s, r) => s + montoReporte(r), 0);
      const monthAjuste = ajustesYear
        .filter((r) => this.monthOfFecha(fechaReporte(r)) === idx)
        .reduce((s, r) => s + montoReporte(r), 0);

      const income = monthIncomeCuotas + monthExtra;
      const balance = income - monthExpenses + monthAjuste;

      return {
        month: PaymentsService.MONTHS_SHORT[idx],
        monthFull,
        income,
        expenses: monthExpenses,
        ajuste: monthAjuste,
        balance,
        recaudoPercent,
        saldoCaja: 0, // se calcula abajo con arrastre
      };
    });

    // Saldo de caja acumulado, arrancando desde el saldo inicial (arrastre).
    let saldoAcumulado = saldoInicial;
    for (const m of monthlyData) {
      saldoAcumulado += m.balance;
      m.saldoCaja = saldoAcumulado;
    }

    const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0);
    const totalExpenses = monthlyData.reduce((s, m) => s + m.expenses, 0);
    const totalAjuste = monthlyData.reduce((s, m) => s + m.ajuste, 0);
    const totalBalance = totalIncome - totalExpenses + totalAjuste;
    const saldoCaja = monthlyData.length ? monthlyData[monthlyData.length - 1].saldoCaja : saldoInicial;

    // --- Recaudo por mes de INGRESO (según la fecha del pago, no el concepto) ---
    // Cuotas confirmadas cuya FECHA cae en el año seleccionado (independiente del
    // mes que paga el propietario) + ingresos extra por su fecha. Incluye TODO el
    // dinero recibido (general + cajas propias): es una vista de ingresos, no de saldo.
    const cuotasDelAnioPorFecha = pagosConfirmados.filter(
      (p) => this.extractYear(String(p.fecha || '')) === year,
    );
    const extraDelAnio = inYear(extra); // todos los ingresos extra del año (incl. cajas propias)
    const recaudoPorMes: RecaudoMes[] = MONTHS.map((monthFull, idx) => {
      const cuotas = cuotasDelAnioPorFecha
        .filter((p) => this.monthOfFecha(String(p.fecha || '')) === idx)
        .reduce((s, p) => s + (parseFloat(String(p.valor)) || 0), 0);
      const count = cuotasDelAnioPorFecha.filter(
        (p) => this.monthOfFecha(String(p.fecha || '')) === idx,
      ).length;
      const extra = extraDelAnio
        .filter((r) => this.monthOfFecha(fechaReporte(r)) === idx)
        .reduce((s, r) => s + montoReporte(r), 0);
      return {
        month: PaymentsService.MONTHS_SHORT[idx],
        monthFull,
        cuotas,
        extra,
        total: cuotas + extra,
        count,
      };
    });

    // --- Desglose por FONDO (tipo de recaudo) del año seleccionado ---
    // Recaudado = cuotas confirmadas por fecha del año + ingresos extra, por su
    // fondo. Gastado = gastos del año por su fondo. Se cruza con el catálogo de
    // fondos del conjunto (incluye meta y visibilidad). Aquí se consideran TODOS
    // los fondos (general y cajas propias) usando el nombre canónico del fondo.
    const nombreFondoPago = (p: any) => (String((p as any).tipoRecaudo ?? '').trim() || DEFAULT_FUND_NAME);
    const nombreFondoReporte = (r: any) => (String((r as any).fondo ?? r.dato_10 ?? '').trim() || DEFAULT_FUND_NAME);

    // Acumuladores por nombre de fondo (del año seleccionado).
    const recaudadoPorFondo = new Map<string, number>();
    const gastadoPorFondo = new Map<string, number>();
    const extraYearAll = inYear(extra);
    const gastosYearAll = inYear(gastos);

    for (const p of cuotasDelAnioPorFecha) {
      const f = nombreFondoPago(p);
      recaudadoPorFondo.set(f, (recaudadoPorFondo.get(f) || 0) + (parseFloat(String(p.valor)) || 0));
    }
    for (const r of extraYearAll) {
      const f = nombreFondoReporte(r);
      recaudadoPorFondo.set(f, (recaudadoPorFondo.get(f) || 0) + montoReporte(r));
    }
    for (const r of gastosYearAll) {
      const f = nombreFondoReporte(r);
      gastadoPorFondo.set(f, (gastadoPorFondo.get(f) || 0) + montoReporte(r));
    }

    // Une catálogo + fondos que aparezcan en los datos aunque no estén en el catálogo.
    const nombresFondos = new Set<string>([
      ...catalogoFondos.map((f) => String(f.nombre)),
      ...recaudadoPorFondo.keys(),
      ...gastadoPorFondo.keys(),
    ]);

    const porFondo = Array.from(nombresFondos).map((nombre) => {
      const cat = catalogoFondos.find((f) => String(f.nombre).toLowerCase() === nombre.toLowerCase());
      const recaudado = recaudadoPorFondo.get(nombre) || 0;
      const gastado = gastadoPorFondo.get(nombre) || 0;
      const metaMensual = Number(cat?.metaMensual) || 0;
      const esDefault = cat?.esDefault === true || nombre.toLowerCase() === DEFAULT_FUND_NAME.toLowerCase();
      return {
        id: cat?.id || nombre,
        nombre,
        esDefault,
        visibleParaPropietario: cat ? cat.visibleParaPropietario !== false : true,
        cajaPropia: !esDefault && esCajaPropiaFondo(normFondo(nombre)),
        metaMensual,
        // Meta del año = meta mensual x 12 (para comparar contra lo recaudado en el año).
        metaAnual: metaMensual * 12,
        recaudado,
        gastado,
        neto: recaudado - gastado,
      };
    }).sort((a, b) => {
      if (a.esDefault && !b.esDefault) return -1;
      if (!a.esDefault && b.esDefault) return 1;
      return a.nombre.localeCompare(b.nombre);
    });

    // --- Cajas separadas (una por fondo con cajaPropia) con saldo y arrastre ---
    // Cada caja acumula: cuotas confirmadas (por concepto del año) + ingresos
    // extra − gastos + ajustes, de su propio fondo, con arrastre de años previos.
    const cajas = catalogoFondos
      .filter((f) => f.cajaPropia === true && normFondo(f.nombre) !== fondoDef)
      .map((f) => {
        const nombre = String(f.nombre);
        const target = normFondo(nombre);
        const pagosDe = pagosConfirmados.filter((p) => fondoDePago(p) === target);
        const extraDe = extra.filter((r) => fondoDeReporte(r) === target);
        const gastosDe = gastos.filter((r) => fondoDeReporte(r) === target);
        const ajustesDe = ajustes.filter((r) => fondoDeReporte(r) === target);

        // Arrastre (años < year): pagos por concepto; reportes por fecha.
        const prevPagos = pagosDe
          .filter((p) => { const y = this.extractYear(p.concepto || ''); return y != null && y < year; })
          .reduce((s, p) => s + (parseFloat(String(p.valor)) || 0), 0);
        const sumPrevDe = (arr: any[]) =>
          arr.filter((r) => { const y = this.extractYear(fechaReporte(r)); return y != null && y < year; })
             .reduce((s, r) => s + montoReporte(r), 0);
        const saldoInicialCaja = prevPagos + sumPrevDe(extraDe) + sumPrevDe(ajustesDe) - sumPrevDe(gastosDe);

        // Movimiento del año seleccionado.
        const pagosAnio = pagosDe
          .filter((p) => (p.concepto || '').includes(String(year)))
          .reduce((s, p) => s + (parseFloat(String(p.valor)) || 0), 0);
        const inYearSumDe = (arr: any[]) =>
          arr.filter((r) => fechaReporte(r).includes(String(year)))
             .reduce((s, r) => s + montoReporte(r), 0);
        const ingresosAnio = pagosAnio + inYearSumDe(extraDe);
        const gastosAnioCaja = inYearSumDe(gastosDe);
        const ajusteAnioCaja = inYearSumDe(ajustesDe);
        const saldoCajaPropia = saldoInicialCaja + ingresosAnio - gastosAnioCaja + ajusteAnioCaja;

        return {
          id: f.id || nombre,
          nombre,
          saldoInicial: saldoInicialCaja,
          ingresos: ingresosAnio,
          gastos: gastosAnioCaja,
          ajuste: ajusteAnioCaja,
          saldoCaja: saldoCajaPropia,
        };
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre));

    return {
      monthlyData,
      recaudoPorMes,
      totals: { totalIncome, totalExpenses, totalAjuste, totalBalance, saldoCaja },
      saldoInicial,
      totalUsers,
      porFondo,
      cajas,
    };
  }

  // ==================== ESCRITURAS (Fase 2, a RTDB) ====================

  private safeKey(raw: unknown, fallbackIndex = 0): string {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s) return `row_${fallbackIndex}`;
    return s.replace(/[.#$/\[\]]/g, '_');
  }

  /** Crea uno o varios pagos (uno por mes) en mirror/pagos. Devuelve los ids creados. */
  // -------------------- Pago de meses (varios años) --------------------
  //
  // Reglas (definidas con el negocio):
  //  - Se puede pagar hasta DICIEMBRE DEL AÑO SIGUIENTE.
  //  - Los meses se pagan SEGUIDOS, empezando por el más antiguo pendiente
  //    (aplica igual al propietario y al admin).
  //  - Un mes pagado o en revisión no se puede volver a registrar.
  //  - Los meses futuros se cobran con la cuota vigente (si la cuota cambia,
  //    la administración ajusta la diferencia).

  private static readonly MESES_ES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];

  /** Índice absoluto de un mes: año*12 + mes(0..11). */
  private idxDe(anio: number, mes: number): number {
    return anio * 12 + mes;
  }

  private mesIndex(nombre: string): number {
    const n = String(nombre || '').trim().toLowerCase();
    return PaymentsService.MESES_ES.findIndex((m) => m.toLowerCase() === n);
  }

  /**
   * Meses cubiertos por los pagos de un usuario: 'pagado' (Confirmado) o
   * 'revision' (Pendiente / Procesando). El mes y el año salen del concepto.
   */
  private async coberturaDe(usuario: string, fondo?: string): Promise<Map<number, 'pagado' | 'revision'>> {
    const pagos = await this.readCollection<Pago>('pagos');
    const out = new Map<number, 'pagado' | 'revision'>();
    // Cada fondo (tipo de recaudo) tiene su propia cobertura: pagar marzo de
    // Administración no cubre marzo de otro fondo.
    const normF = (f: unknown) => String(f || DEFAULT_FUND_NAME).trim().toLowerCase();
    const objetivo = normF(fondo);
    for (const p of this.pagosDeUsuario(pagos, usuario)) {
      if (normF((p as any).tipoRecaudo) !== objetivo) continue;
      const est = String(p.estado || '').toLowerCase();
      const tipo = est === 'confirmado' ? 'pagado' : est === 'pendiente' || est === 'procesando' ? 'revision' : null;
      if (!tipo) continue;
      const c = String(p.concepto || '').toLowerCase();
      const anios = Array.from(new Set((c.match(/\b20\d{2}\b/g) || []).map(Number)));
      const meses = PaymentsService.MESES_ES.map((m, i) => (c.includes(m.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
      for (const a of anios) {
        for (const m of meses) {
          const k = this.idxDe(a, m);
          if (out.get(k) !== 'pagado') out.set(k, tipo);
        }
      }
    }
    return out;
  }

  /**
   * Meses que un propietario puede pagar, para el selector de la app: desde su
   * ingreso (o enero del año actual) hasta diciembre del año siguiente, con el
   * estado de cada mes, el primero pagable y hasta cuándo está al día.
   */
  async getPayableMonths(usuario: string, fondo?: string): Promise<{
    usuario: string;
    cuota: number;
    meses: Array<{ anio: number; mes: string; idx: number; estado: 'pagado' | 'revision' | 'pendiente' | 'disponible' | 'noAplica' }>;
    primeroPagable: { anio: number; mes: string } | null;
    pagadoHasta: { anio: number; mes: string } | null;
    maxAnio: number;
  }> {
    const hoy = new Date();
    const curY = hoy.getFullYear();
    const curIdx = this.idxDe(curY, hoy.getMonth());
    const usuarios = await this.readCollection<Usuario>('usuarios');
    const u = usuarios.find((x) => x.usuario === usuario);
    const ingreso = this.parseFechaIngreso(u?.fechaIngreso);
    // Inicio: mes de ingreso (si lo hay), sin ir más de 3 años atrás.
    let inicio = ingreso ? this.idxDe(ingreso.year, ingreso.monthIndex) : this.idxDe(curY, 0);
    inicio = Math.max(inicio, this.idxDe(curY - 3, 0));
    const fin = this.idxDe(curY + 1, 11);
    const cob = await this.coberturaDe(usuario, fondo);

    const desde = this.idxDe(Math.floor(Math.min(inicio, this.idxDe(curY, 0)) / 12), 0);
    const meses: Array<{ anio: number; mes: string; idx: number; estado: any }> = [];
    let primero: number | null = null;
    for (let i = desde; i <= fin; i++) {
      let estado: string;
      if (i < inicio) estado = 'noAplica';
      else if (cob.has(i)) estado = cob.get(i)!;
      else estado = i <= curIdx ? 'pendiente' : 'disponible';
      if (primero === null && i >= inicio && !cob.has(i)) primero = i;
      meses.push({ anio: Math.floor(i / 12), mes: PaymentsService.MESES_ES[i % 12], idx: i, estado });
    }
    const aPer = (i: number) => ({ anio: Math.floor(i / 12), mes: PaymentsService.MESES_ES[i % 12] });
    const pagadoHastaIdx = primero === null ? fin : primero - 1;

    let cuota = 0;
    try {
      const conjuntos = await this.firebase.liveValues<any>('mirror/conjuntos');
      const conj = String(u?.conjunto || '').trim().toLowerCase();
      const c = conjuntos.find((x) => String(x?.nombre || '').trim().toLowerCase() === conj || String(x?.id || '').trim().toLowerCase() === conj);
      cuota = Number(String(c?.cuotaMonto ?? 0).replace(/[^\d.]/g, '')) || 0;
    } catch {
      /* sin cuota configurada */
    }

    return {
      usuario,
      cuota,
      meses,
      primeroPagable: primero === null ? null : aPer(primero),
      pagadoHasta: pagadoHastaIdx >= inicio ? aPer(pagadoHastaIdx) : null,
      maxAnio: curY + 1,
    };
  }

  /**
   * Valida y normaliza los periodos a pagar. Devuelve los periodos ordenados o
   * un mensaje de error claro para mostrar en la app.
   */
  async validarPeriodos(
    usuario: string,
    periodos: Array<{ mes: string; anio: number }>,
    fondo?: string,
  ): Promise<{ ok: true; periodos: Array<{ mes: string; anio: number }> } | { ok: false; message: string }> {
    if (!Array.isArray(periodos) || periodos.length === 0) return { ok: false, message: 'Selecciona al menos un mes.' };
    const idxs: number[] = [];
    for (const p of periodos) {
      const m = this.mesIndex(p?.mes);
      const a = Number(p?.anio);
      if (m < 0 || !Number.isInteger(a)) return { ok: false, message: `Mes inválido: ${p?.mes} ${p?.anio}.` };
      idxs.push(this.idxDe(a, m));
    }
    const unicos = Array.from(new Set(idxs)).sort((x, y) => x - y);
    const nombre = (i: number) => `${PaymentsService.MESES_ES[i % 12]} ${Math.floor(i / 12)}`;

    const info = await this.getPayableMonths(usuario, fondo);
    const fin = this.idxDe(info.maxAnio, 11);
    if (unicos[unicos.length - 1] > fin) {
      return { ok: false, message: `Solo se puede pagar hasta diciembre de ${info.maxAnio}.` };
    }
    const porIdx = new Map(info.meses.map((m) => [m.idx, m.estado]));
    for (const i of unicos) {
      const est = porIdx.get(i);
      if (est === 'pagado' || est === 'revision') return { ok: false, message: `${nombre(i)} ya está pagado o en revisión.` };
      if (est === 'noAplica' || est === undefined) return { ok: false, message: `${nombre(i)} no se puede pagar.` };
    }
    for (let k = 1; k < unicos.length; k++) {
      if (unicos[k] !== unicos[k - 1] + 1) return { ok: false, message: 'Los meses deben ser seguidos, sin saltos.' };
    }
    if (info.primeroPagable) {
      const primero = this.idxDe(info.primeroPagable.anio, this.mesIndex(info.primeroPagable.mes));
      if (unicos[0] !== primero) {
        return { ok: false, message: `Primero se debe pagar ${info.primeroPagable.mes} ${info.primeroPagable.anio}.` };
      }
    }
    return { ok: true, periodos: unicos.map((i) => ({ mes: PaymentsService.MESES_ES[i % 12], anio: Math.floor(i / 12) })) };
  }

  /**
   * Datos del recibo de uno o varios pagos (p. ej. los meses registrados juntos),
   * leídos de RTDB. El recibo se arma en el servidor a partir de los pagos
   * reales: el cliente solo indica los ids (no puede inventar montos ni nombres).
   *
   * Devuelve también `usuario` y `conjunto` para que el controller verifique
   * que quien lo pide puede verlo.
   */
  async buildReceiptData(ids: string[]): Promise<
    | { ok: true; data: ReceiptData; usuario: string; conjunto: string }
    | { ok: false; message: string }
  > {
    const unicos = Array.from(new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (unicos.length === 0) return { ok: false, message: 'Indica al menos un pago.' };
    if (unicos.length > 36) return { ok: false, message: 'Demasiados pagos para un recibo.' };

    const todos = (await this.firebase.liveVal<Record<string, any>>('mirror/pagos')) || {};
    const pagos = unicos.map((id) => todos[this.safeKey(id)]).filter(Boolean);
    if (pagos.length !== unicos.length) return { ok: false, message: 'Pago no encontrado.' };

    const usuario = String(pagos[0].usuario || '');
    if (pagos.some((p) => String(p.usuario || '') !== usuario)) {
      return { ok: false, message: 'Los pagos deben ser del mismo propietario.' };
    }

    const usuarios = (await this.firebase.liveVal<Record<string, any>>('mirror/usuarios')) || {};
    const u = usuarios[this.safeKey(usuario)] || {};
    const conjunto = String(u.conjunto || pagos[0].conjunto || '');

    // Orden cronológico por el mes/año del concepto (cae al orden de creación).
    const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const clave = (p: any) => {
      const c = String(p.concepto || '').toLowerCase();
      const anio = Number((c.match(/\b(20\d{2})\b/) || [])[1] || 0);
      const mes = MESES.findIndex((m) => c.includes(m));
      return anio * 100 + (mes >= 0 ? mes : 0);
    };
    pagos.sort((a, b) => clave(a) - clave(b) || String(a.id).localeCompare(String(b.id)));

    const confirmados = pagos.every((p) => String(p.estado || '').toLowerCase() === 'confirmado');
    const fondos = Array.from(new Set(pagos.map((p) => String(p.tipoRecaudo || DEFAULT_FUND_NAME))));
    const fechas = pagos.map((p) => String(p.fecha || '').split('T')[0]).filter(Boolean).sort();
    const fecha = fechas[fechas.length - 1] || '';
    const ultimoId = String(pagos[pagos.length - 1].id || unicos[0]);

    let moneda = 'COP';
    try {
      const conjuntos = await this.firebase.liveValues<any>('mirror/conjuntos');
      const c = conjuntos.find((x) => String(x?.nombre || '').trim().toLowerCase() === conjunto.trim().toLowerCase());
      if (c?.moneda) moneda = String(c.moneda);
    } catch {
      /* COP por defecto */
    }

    const parcela = String(u.parcela || '').trim();
    const data: ReceiptData = {
      conjunto,
      propietario: String(u.nombre || usuario),
      unidad: parcela ? (/^\d+$/.test(parcela) ? `Unidad ${parcela}` : parcela) : undefined,
      fecha,
      estado: confirmados ? 'Confirmado' : 'Pendiente',
      moneda,
      tipoRecaudo: fondos.length === 1 ? fondos[0] : undefined,
      referencia: String(pagos[0].referencia || '') || undefined,
      // Número estable y único: fecha + últimos dígitos del id del pago.
      numeroRecibo: `REC-${fecha.replace(/-/g, '') || 'S-F'}-${ultimoId.replace(/\D/g, '').slice(-5) || ultimoId.slice(-5)}`,
      monto: pagos.reduce((s, p) => s + (Number(String(p.valor ?? 0).replace(/[^\d.-]/g, '')) || 0), 0),
      items: pagos.map((p) => ({ concepto: String(p.concepto || 'Pago'), monto: p.valor ?? 0 })),
    };
    return { ok: true, data, usuario, conjunto };
  }

  async createPayments(input: {
    usuario: string;
    montoPerMonth: string | number;
    meses?: string[];
    year: number;
    estado: string;
    referencia: string;
    conjunto?: string;
    conjuntoId?: string;
    // Concepto libre (p. ej. pago de una reserva). Si viene, se crea UN pago con
    // ese concepto y se ignora `meses`.
    concepto?: string;
    // Tipo de recaudo (fondo) al que se asigna el pago. Por defecto 'Administración'.
    tipoRecaudo?: string;
    // Meses de uno o varios años: [{ mes: 'Noviembre', anio: 2026 }, { mes: 'Enero', anio: 2027 }].
    // Si no viene, se usan `meses` + `year` (clientes anteriores).
    periodos?: Array<{ mes: string; anio: number }>;
  }): Promise<{ success: boolean; ids: string[]; pagos: Pago[]; message?: string }> {
    const db = this.firebase.db();
    const hoy = new Date().toISOString().split('T')[0];
    const ids: string[] = [];
    const pagos: Pago[] = [];
    const updates: Record<string, any> = {};

    // Conceptos a crear: uno por mes (validados: seguidos, desde el más antiguo
    // pendiente, sin repetir, hasta dic. del año siguiente) o uno con el concepto libre.
    let conceptos: string[];
    if (input.concepto) {
      conceptos = [input.concepto];
    } else {
      const pedidos = input.periodos?.length
        ? input.periodos
        : (input.meses || []).map((mes) => ({ mes, anio: Number(input.year) }));
      const v = await this.validarPeriodos(input.usuario, pedidos, input.tipoRecaudo);
      if (!v.ok) return { success: false, ids: [], pagos: [], message: v.message };
      conceptos = v.periodos.map((p) => `Administración ${p.mes} ${p.anio}`);
    }

    for (const concepto of conceptos) {
      const id = Date.now().toString() + Math.random().toString().slice(2, 5);
      const pago: any = {
        id,
        usuario: input.usuario,
        usuarioId: input.usuario,
        concepto,
        valor: String(input.montoPerMonth),
        fecha: hoy,
        estado: input.estado,
        referencia: input.referencia,
        conjunto: input.conjunto || '',
        conjuntoId: input.conjuntoId || '',
        // Tipo de recaudo (fondo). Si no viene, 'Administración' por defecto.
        tipoRecaudo: input.tipoRecaudo || 'Administración',
        createdAt: new Date().toISOString(),
        // Marca de escritura por Firebase: la sync Sheets->RTDB no debe pisarlo.
        _fbWrite: true,
      };
      updates[`mirror/pagos/${this.safeKey(id)}`] = pago;
      ids.push(id);
      pagos.push(pago);
    }

    await db.ref().update(updates);

    // Pago de una cuota de acuerdo (referencia "ACUERDO:<id> | CUOTA:<n>"): la
    // cuota queda "en revisión" (pago pendiente) o pagada (registrado ya
    // confirmado por el admin). Así Pagos y Acuerdos nunca se contradicen.
    const vinculo = this.vinculoCuota(input.referencia);
    if (vinculo && ids.length) {
      const confirmado = String(input.estado).toLowerCase() === 'confirmado';
      await this.aplicarPagoACuota(vinculo.acuerdoId, vinculo.cuota, confirmado ? 'pagado' : 'en_revision', ids[0], hoy)
        .catch((e) => this.logger.warn(`No se pudo vincular el pago ${ids[0]} a la cuota: ${e?.message}`));
    }
    return { success: true, ids, pagos };
  }

  /** Extrae "ACUERDO:<id> | CUOTA:<n>" de la referencia de un pago. */
  private vinculoCuota(referencia: string): { acuerdoId: string; cuota: number } | null {
    const ref = String(referencia || '');
    const a = ref.match(/ACUERDO:\s*([^\s|]+)/);
    const c = ref.match(/CUOTA:\s*(\d+)/);
    if (!a || !c) return null;
    const cuota = Number(c[1]);
    return cuota > 0 ? { acuerdoId: a[1].trim(), cuota } : null;
  }

  /**
   * Actualiza la cuota N de un acuerdo según el estado de su pago:
   *   - 'en_revision': el propietario reportó el pago (pendiente en Pagos).
   *   - 'pagado': pago confirmado. Recalcula el saldo y liquida el acuerdo si
   *     era la última cuota.
   *   - 'pendiente': pago rechazado, la cuota vuelve a estar por pagar.
   */
  async aplicarPagoACuota(
    acuerdoId: string,
    n: number,
    estado: 'en_revision' | 'pagado' | 'pendiente',
    pagoId: string,
    fecha: string,
  ): Promise<string> {
    const aRef = this.firebase.db().ref(`mirror/acuerdos/${this.safeKey(acuerdoId)}`);
    const snap = await aRef.get();
    if (!snap.exists()) return ` (No se encontró el acuerdo ${acuerdoId}.)`;
    const acuerdo = snap.val() || {};
    const cuotas: any[] = Array.isArray(acuerdo.cuotas) ? acuerdo.cuotas.map((c: any) => ({ ...c })) : [];
    let idx = cuotas.findIndex((c) => Number(c?.n) === n);
    if (idx < 0 && n - 1 < cuotas.length) idx = n - 1;
    if (idx < 0) return ` (El acuerdo no tiene la cuota ${n}.)`;
    const c = cuotas[idx];
    // Un rechazo no deshace una cuota ya pagada con OTRO pago.
    if (estado === 'pendiente' && c.estado === 'pagado' && c.pagoId && c.pagoId !== pagoId) return '';
    if (estado === 'pagado') cuotas[idx] = { ...c, estado: 'pagado', pagoId, fechaPago: fecha };
    else if (estado === 'en_revision') cuotas[idx] = { ...c, estado: 'en_revision', pagoId, fechaPago: null };
    else cuotas[idx] = { ...c, estado: 'pendiente', pagoId: null, fechaPago: null };
    const saldoPendiente = cuotas
      .filter((q) => q.estado !== 'pagado')
      .reduce((t, q) => t + (Number(q.monto) || 0), 0);
    const liquidado = cuotas.length > 0 && cuotas.every((q) => q.estado === 'pagado');
    const patch: Record<string, any> = { cuotas, saldoPendiente, _fbWrite: true };
    if (liquidado) patch.estado = 'liquidado';
    else if (acuerdo.estado === 'liquidado') patch.estado = 'activo';
    await aRef.update(patch);
    if (estado === 'pagado') return liquidado ? ` Cuota ${n} pagada: acuerdo liquidado.` : ` Cuota ${n} del acuerdo pagada.`;
    if (estado === 'pendiente') return ` Cuota ${n} del acuerdo vuelve a pendiente.`;
    return '';
  }

  /** Actualiza un pago existente (merge de campos) en mirror/pagos. */
  async updatePayment(id: string, changes: Partial<Pago>): Promise<{ success: boolean; message?: string }> {
    if (!id) return { success: false, message: 'ID de pago requerido' };
    const db = this.firebase.db();
    const ref = db.ref(`mirror/pagos/${this.safeKey(id)}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El pago no existe.' };
    const patch: Record<string, any> = { _fbWrite: true };
    ['usuario', 'concepto', 'valor', 'fecha', 'estado', 'referencia', 'tipoRecaudo'].forEach((f) => {
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
   * Marca (o desmarca) un pago como "duplicado validado": el admin revisó el
   * duplicado y lo considera legítimo, por lo que no debe volver a aparecer en
   * el reporte de duplicados. Guarda la marca en el propio pago (dupOk).
   */
  async setDuplicateOk(id: string, ok = true): Promise<{ success: boolean; message?: string }> {
    if (!id) return { success: false, message: 'ID de pago requerido' };
    const ref = this.firebase.db().ref(`mirror/pagos/${this.safeKey(id)}`);
    const snap = await ref.get();
    if (!snap.exists()) return { success: false, message: 'El pago no existe.' };
    await ref.update({ dupOk: ok, _fbWrite: true });
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

    // Vínculo con acuerdo de pago: ACUERDO:<id> en la referencia.
    const matchAcuerdo = referencia.match(/ACUERDO:\s*([^\s|]+)/);
    const vinculoCuota = this.vinculoCuota(referencia);
    if (vinculoCuota) {
      // Pago de una cuota: marca la cuota (no toca el abono inicial).
      try {
        reservaMsg += await this.aplicarPagoACuota(
          vinculoCuota.acuerdoId,
          vinculoCuota.cuota,
          input.estado === 'Confirmado' ? 'pagado' : 'pendiente',
          input.id,
          String(pago.fecha || new Date().toISOString().split('T')[0]),
        );
      } catch {
        reservaMsg += ' (Error actualizando la cuota del acuerdo.)';
      }
    } else if (matchAcuerdo) {
      const acuerdoId = matchAcuerdo[1].trim();
      try {
        const aRef = db.ref(`mirror/acuerdos/${this.safeKey(acuerdoId)}`);
        const aSnap = await aRef.get();
        if (aSnap.exists()) {
          if (input.estado === 'Confirmado') {
            await aRef.update({ abonoInicialEstado: 'aceptado', estado: 'activo', _fbWrite: true });
            reservaMsg += ' Acuerdo activado.';
          } else {
            await aRef.update({ abonoInicialEstado: 'pendiente', _fbWrite: true });
            reservaMsg += ' Acuerdo pendiente (abono rechazado).';
          }
        }
      } catch {
        reservaMsg += ' (Error actualizando el acuerdo vinculado.)';
      }
    }

    // Vínculo con beneficio: BENEFICIO:<id> en la referencia.
    const matchBeneficio = referencia.match(/BENEFICIO:\s*([^\s|]+)/);
    if (matchBeneficio) {
      const beneficioId = matchBeneficio[1].trim();
      try {
        const bRef = db.ref(`mirror/beneficios/${this.safeKey(beneficioId)}`);
        const bSnap = await bRef.get();
        if (bSnap.exists()) {
          const beneficio = bSnap.val();
          const usuario = String(pago.usuario ?? '');
          const solicitantes: string[] = Array.isArray(beneficio.solicitantes) ? beneficio.solicitantes : [];
          const aprobados: string[] = Array.isArray(beneficio.aprobados) ? beneficio.aprobados : [];
          if (input.estado === 'Confirmado' && !aprobados.includes(usuario)) {
            await bRef.update({ aprobados: [...aprobados, usuario], _fbWrite: true });
            reservaMsg += ' Adhesión al beneficio aprobada.';
          } else if (input.estado === 'Rechazado') {
            await bRef.update({
              solicitantes: solicitantes.filter((u) => u !== usuario),
              _fbWrite: true,
            });
            reservaMsg += ' Solicitud de beneficio rechazada.';
          }
        }
      } catch {
        reservaMsg += ' (Error actualizando el beneficio vinculado.)';
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
    // Fondo (tipo de recaudo) al que se paga. Si tiene cuentaRecaudo propia, esa
    // es la cuenta de destino esperada; si no, la llave Bre-B del conjunto.
    tipoRecaudo?: string;
    // true => valida que el destino del comprobante coincida con la cuenta
    // esperada (corre análisis forense aunque no se pida el forense completo).
    validarDestino?: boolean;
  }): Promise<{ success: boolean; message?: string; monto?: number; analysis?: any }> {
    if (!input.imageBase64) return { success: false, message: 'Imagen vacía.' };
    const secrets = await this.properties.getSecretsByConjunto(input.conjunto);
    const geminiKey = secrets?.geminiKey || '';
    if (!geminiKey) return { success: false, message: 'El conjunto no tiene Gemini configurado.' };
    const llaveBreB = secrets?.llaveBreB || '';

    // Cuenta de destino esperada: la del FONDO (cuentaRecaudo) si tiene una
    // propia; si no, la llave Bre-B del conjunto.
    let cuentaEsperada = llaveBreB;
    if (String(input.tipoRecaudo || '').trim()) {
      try {
        const fondos = await this.funds.list(input.conjunto || '');
        const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
        const fondo = fondos.find((f: any) => norm(f.nombre) === norm(input.tipoRecaudo));
        const cuentaFondo = String(fondo?.cuentaRecaudo || '').trim();
        if (cuentaFondo) cuentaEsperada = cuentaFondo;
      } catch { /* si falla, se usa la llave del conjunto */ }
    }

    const image = input.imageBase64.includes(',') ? input.imageBase64.split(',').pop()! : input.imageBase64;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${geminiKey}`;

    // Modo admin: solo extraer el monto (salvo que se pida validar destino).
    if (input.soloExtraerMonto && !input.validarDestino) {
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

5. destinatarioCorrecto: ${cuentaEsperada ? `true si la cuenta/llave/número de DESTINO del comprobante (a quién se transfirió) contiene o coincide con "${cuentaEsperada}". Compara ignorando espacios y guiones. false si es claramente diferente o no se puede verificar.` : 'true (no hay cuenta configurada para verificar).'}

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
          checkedDestinatario: !!cuentaEsperada,
          cuentaEsperada,
        },
      };
    } catch (e: any) {
      return { success: false, message: e?.message || 'Error analizando el comprobante' };
    }
  }

  /**
   * Chat de finanzas con Genkit + Gemini (ver finance-chat.ai.ts). La geminiKey
   * se resuelve por conjunto y NUNCA se expone al cliente. El cliente envía la
   * pregunta, el historial y un contexto financiero ya resumido; la IA puede
   * además consultar en vivo el estado de pago de los propietarios.
   */
  async financeChat(input: {
    conjunto: string;
    question?: string;
    context?: string;
    history?: ChatTurn[];
    year?: number;
  }): Promise<{ success: boolean; message?: string; text?: string }> {
    const secrets = await this.properties.getSecretsByConjunto(input.conjunto);
    const geminiKey = secrets?.geminiKey || '';
    if (!geminiKey) {
      return { success: false, message: 'El conjunto no tiene Gemini configurado. Agrega la API key en Conjuntos.' };
    }
    const year = Number(input.year) || new Date().getFullYear();
    return runFinanceChat({
      apiKey: geminiKey,
      conjunto: input.conjunto,
      year,
      question: String(input.question || ''),
      history: Array.isArray(input.history) ? input.history : [],
      context: String(input.context || '').slice(0, 20000),
      loadOwners: async (conjunto, y) => {
        const list = await this.getAdminList(conjunto, y);
        return list.map((it) => ({
          nombre: it.name,
          unidad: it.unit || '',
          estado: (it.pendingCount > 0 ? 'por confirmar' : it.isAlDia ? 'al día' : 'en mora') as OwnerRow['estado'],
          mesesPagados: it.paidCount,
          mesesAplicables: it.totalApplicable,
          meses: it.months,
          pagadoEnElAnio: it.paidTotal,
        }));
      },
    });
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
    /** Meses de uno o varios años. Si no viene, `meses` se toman del `anio` indicado (o el actual). */
    periodos?: Array<{ mes: string; anio: number }>;
    anio?: number;
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
    // Antes el año era SIEMPRE el actual: pagar enero del año siguiente quedaba
    // registrado como enero del año en curso.
    const pedidos = input.periodos?.length
      ? input.periodos
      : (input.meses || []).map((mes) => ({ mes, anio: Number(input.anio) || new Date().getFullYear() }));
    let periodos: Array<{ mes: string; anio: number }> = [];
    if (pedidos.length > 0) {
      const v = await this.validarPeriodos(input.usuario, pedidos);
      if (!v.ok) return { success: false, message: v.message };
      periodos = v.periodos;
    }

    const items = periodos.length > 0
      ? periodos.map((p) => ({
          title: `Administración ${p.mes} ${p.anio}`,
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
          referencia: externalReference, conjunto: input.conjunto || '',
          createdAt: new Date().toISOString(), _fbWrite: true,
        };
      };
      if (periodos.length > 0) {
        periodos.forEach((p, j) => registrar(`${base}-${j}`, `Administración ${p.mes} ${p.anio}`));
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
