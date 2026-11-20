import { Injectable, Logger } from '@nestjs/common';
import { SheetsService } from '../sheets/sheets.service';
import { PaymentsService } from '../payments/payments.service';

/**
 * Lógica del dashboard de la pantalla Home, movida del frontend al backend.
 *
 * Lee usuarios y pagos de Firebase RTDB y reportes (vigilante) de Sheets, y
 * devuelve la data YA CALCULADA:
 *   - admin/superAdmin: lista de usuarios con su estado de pago (Al día/Pendiente)
 *     y el monto del mes seleccionado.
 *   - propietario: estado de pago por mes (ownerMonths) del propio usuario.
 *   - vigilanteEnTurno: nombre + teléfono del vigilante actual (de reportes).
 *
 * El frontend solo pinta lo que devuelve este servicio.
 */
export interface DashboardUser {
  username: string;
  name: string;
  role: string;
  complex: string;
  phone: string;
  placa1: string;
  placa2: string;
  fechaIngreso: string;
  paymentStatus?: 'Al día' | 'Pendiente';
  paymentAmount?: number;
}

export interface OwnerMonth {
  month: string;
  status: string;
  color: string;
  icon: string;
  payment: any | null;
}

export interface DashboardResponse {
  role: string;
  vigilanteEnTurno: { nombre: string; phone: string | null };
  usuarios: DashboardUser[];
  ownerMonths: OwnerMonth[];
  counts: { total: number; alDia: number; pendientes: number };
}

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);

  constructor(
    private readonly sheets: SheetsService,
    private readonly payments: PaymentsService,
  ) {}

  /** Parsea la fecha de ingreso (varios formatos) -> { year, monthIndex } o null. */
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

  // Usuarios y pagos se leen de Firebase RTDB (mirror/*), con campos con nombre.
  private mapUsuario(u: any): DashboardUser {
    return {
      username: String(u.usuario ?? ''),
      name: String(u.nombre ?? ''),
      role: String(u.rol ?? ''),
      complex: String(u.conjunto ?? ''),
      phone: String(u.phone ?? ''),
      placa1: String(u.placa1 ?? ''),
      placa2: String(u.placa2 ?? ''),
      fechaIngreso: String(u.fechaIngreso ?? ''),
    };
  }

  private mapPago(p: any) {
    return {
      usuario: String(p.usuario ?? ''),
      estado: String(p.estado ?? ''),
      concepto: String(p.concepto ?? ''),
      valor: p.valor ?? 0,
      fecha: String(p.fecha ?? '').split('T')[0],
      referencia: String(p.referencia ?? ''),
    };
  }

  /**
   * Lee 'reportes' de Sheets (vigilante en turno) con un tope de espera. Apps
   * Script puede tardar decenas de segundos (timeout 40s x reintentos); como el
   * vigilante es un dato secundario, no debe bloquear todo el dashboard.
   */
  private reportesCache: { at: number; rows: any[] } | null = null;
  private reportesInFlight: Promise<any[]> | null = null;
  private static readonly REPORTES_TTL_MS = 60_000;

  /**
   * Lectura de 'reportes' compartida: caché de 60 s y una sola petición en
   * vuelo a Apps Script aunque lleguen muchas cargas del Home a la vez.
   */
  private readReportesCompartido(): Promise<any[]> {
    const hit = this.reportesCache;
    if (hit && Date.now() - hit.at < HomeService.REPORTES_TTL_MS) return Promise.resolve(hit.rows);
    if (!this.reportesInFlight) {
      this.reportesInFlight = this.sheets
        .read('reportes')
        .then((rows) => {
          this.reportesCache = { at: Date.now(), rows };
          return rows;
        })
        .finally(() => {
          this.reportesInFlight = null;
        });
    }
    return this.reportesInFlight;
  }

  private async readReportesConTope(maxMs = 8000): Promise<any[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.readReportesCompartido(),
        new Promise<any[]>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`reportes > ${maxMs}ms`)), maxMs);
        }),
      ]);
    } catch (e: any) {
      this.logger.warn(`Vigilante en turno no disponible: ${e?.message}`);
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Estado de pago por mes de un propietario (para la vista owner).
   *
   * Delega en PaymentsService.getUserMonths, que lee de Firebase RTDB
   * (mirror/pagos) — la MISMA fuente y lógica que la pantalla de Pagos. Así el
   * Home del propietario y Pagos siempre coinciden (antes Home leía de Google
   * Sheets, que podía estar desfasado respecto a RTDB y mostraba meses como
   * "pendientes" aunque ya estuvieran pagados en Pagos).
   *
   * Solo reetiqueta los estados al vocabulario que el frontend del Home espera
   * (p. ej. 'Pendiente' -> 'Pendiente de Pago', 'Por confirmar' -> 'En Revisión').
   */
  private async buildOwnerMonths(username: string, year: number): Promise<OwnerMonth[]> {
    const monthStatuses = await this.payments.getUserMonths(username, year);

    return monthStatuses.map((m) => {
      // Mapea los estados de Pagos al vocabulario/estilo del Home.
      let status = m.status;
      let color = m.color;
      let icon = m.icon;

      switch (m.status) {
        case 'Pagado':
          status = 'Pagado'; color = '#4CAF50'; icon = 'checkmark-circle';
          break;
        case 'Por confirmar':
          status = 'En Revisión'; color = '#FF9800'; icon = 'time';
          break;
        case 'Pendiente':
          status = 'Pendiente de Pago'; color = '#F44336'; icon = 'alert-circle';
          break;
        case 'No aplica':
          status = 'No aplica'; color = '#757575'; icon = 'remove-circle-outline';
          break;
        case 'Disponible':
          status = 'Disponible'; color = '#2196F3'; icon = 'add-circle-outline';
          break;
      }

      // El frontend lee payment.estado como 'Confirmado'/'Pendiente'; los pagos
      // de RTDB ya traen ese campo, así que se pasan tal cual.
      return { month: m.month, status, color, icon, payment: m.payment || null };
    });
  }

  /** Determina el vigilante en turno a partir de la hoja reportes. */
  private resolveVigilanteEnTurno(reportes: any[], usuarios: DashboardUser[]): { nombre: string; phone: string | null } {
    const surveillance = reportes.filter((r) => String(r.dato_7 ?? r[6] ?? '') === 'Reporte Vigilancia');
    surveillance.sort((a, b) => {
      const da = String(a.dato_3 ?? a[2] ?? '');
      const db = String(b.dato_3 ?? b[2] ?? '');
      return db.localeCompare(da);
    });
    if (surveillance.length === 0) return { nombre: 'No asignado', phone: null };

    const last = surveillance[0];
    const titulo = String(last.dato_2 ?? last[1] ?? '');
    const usuario = String(last.dato_4 ?? last[3] ?? '');
    const descripcion = String(last.dato_5 ?? last[4] ?? '');

    const resolveName = (value: string) => {
      if (!value) return value;
      const match = usuarios.find(
        (u) =>
          (u.username && u.username.toLowerCase() === value.toLowerCase()) ||
          (u.name && u.name.toLowerCase() === value.toLowerCase()),
      );
      return match?.name || value;
    };

    let guardName = '';
    if (titulo.toLowerCase().includes('recepción')) {
      guardName = resolveName(usuario);
    } else if (titulo.toLowerCase().includes('entrega')) {
      const targetMatch = descripcion.match(/Compañero:\s*(.*?)(\n|$)/);
      const targetName = targetMatch ? targetMatch[1].trim() : '';
      guardName = targetName && targetName !== 'Sin Nombre' ? resolveName(targetName) : 'En cambio de turno...';
    } else {
      guardName = resolveName(usuario);
    }

    let phone: string | null = null;
    if (guardName && guardName !== 'En cambio de turno...' && guardName !== 'No asignado') {
      const guardUser = usuarios.find(
        (u) =>
          (u.name && u.name.toLowerCase() === guardName.toLowerCase()) ||
          (u.username && u.username.toLowerCase() === guardName.toLowerCase()),
      );
      phone = guardUser?.phone || null;
    }
    return { nombre: guardName, phone };
  }

  /**
   * Devuelve el dashboard de Home según el rol del usuario que consulta.
   */
  async getDashboard(params: {
    role: string;
    complex: string;
    username: string;
    year: number;
    month?: string;
    /**
     * Solo aplica a superAdmin. true/undefined = vista global de todos los
     * conjuntos (comportamiento histórico). false = opera como admin del
     * `complex` indicado (filtra por ese conjunto).
     */
    verTodos?: boolean;
  }): Promise<DashboardResponse> {
    const { role, complex, username, year } = params;
    const month = params.month || MONTHS[new Date().getMonth()];

    // Alcance global efectivo: solo un superAdmin que NO eligió un conjunto
    // concreto ve "Todos". Si eligió conjunto (verTodos=false con complex),
    // se comporta como el admin de ese conjunto.
    const esSuperAdmin = role === 'superAdmin';
    const scopeGlobal = esSuperAdmin && params.verTodos !== false;

    // Todas las lecturas en paralelo. Usuarios, pagos y el estado "al día" salen
    // de Firebase (rápido y consistente con Pagos); solo 'reportes' sigue en
    // Sheets. El propietario no necesita pagos ni el reporte global.
    const esPropietario = role === 'propietario';
    const [userDocs, pagoDocs, reporteRows, reporte] = await Promise.all([
      this.payments.readCollection<any>('usuarios'),
      esPropietario ? Promise.resolve([] as any[]) : this.payments.readCollection<any>('pagos'),
      this.readReportesConTope(),
      esPropietario ? Promise.resolve(null) : this.payments.getAlDiaReport(complex || '', scopeGlobal),
    ]);

    const allUsers = userDocs.map((u) => this.mapUsuario(u));
    const pagos = pagoDocs.map((p) => this.mapPago(p));

    const vigilanteEnTurno = this.resolveVigilanteEnTurno(reporteRows, allUsers);

    // Filtrado por rol/conjunto. Se filtra por conjunto salvo en modo global
    // (superAdmin viendo "Todos"). Un superAdmin con conjunto elegido filtra
    // igual que un admin.
    let filteredUsers = allUsers.filter((u) => u.role !== 'superAdmin' && u.role !== 'vigilante');
    if (!scopeGlobal) {
      filteredUsers = filteredUsers.filter((u) => (u.complex || '') === (complex || ''));
    }
    if (role === 'propietario') {
      filteredUsers = filteredUsers.filter((u) => u.username === username);
    }

    // Vista propietario: estado por mes.
    if (role === 'propietario') {
      const ownerMonths = await this.buildOwnerMonths(username, year);
      return {
        role,
        vigilanteEnTurno,
        usuarios: [],
        ownerMonths,
        counts: { total: 0, alDia: 0, pendientes: 0 },
      };
    }

    // Vista admin: estado "al día" EXACTO, calculado por PaymentsService contra
    // Firebase RTDB (mirror/*), con la MISMA regla que el reporte PDF: pagó los
    // dos meses anteriores (M-2 y M-1), con 10 días de gracia en el mes actual
    // para M-1; meses anteriores al ingreso = N/A (no cuentan). Así la lista de
    // Home y el reporte coinciden siempre y reflejan los pagos reales.
    // En modo global pasa superAdmin=true (ignora conjunto); con conjunto
    // elegido, superAdmin=false para filtrar por ese conjunto (como admin).
    if (!reporte) throw new Error('Reporte al día no disponible');

    // Mapa username(normalizado) -> alDia del reporte.
    const normU = (s: string) => String(s || '').trim().toLowerCase();
    const alDiaByUser = new Map<string, boolean>();
    for (const p of reporte.propietarios) alDiaByUser.set(normU(p.usuario), p.alDia);

    // Monto del mes seleccionado (solo informativo para la tarjeta; no define el estado).
    // Se suma en una sola pasada sobre los pagos (antes era usuarios x pagos).
    const montoPorUsuario = new Map<string, number>();
    const mesLower = month.toLowerCase();
    const anioStr = String(year);
    for (const p of pagos) {
      if (
        p.concepto &&
        p.concepto.toLowerCase().includes(mesLower) &&
        p.concepto.includes(anioStr) &&
        (p.estado || '').toLowerCase() === 'confirmado'
      ) {
        montoPorUsuario.set(
          p.usuario,
          (montoPorUsuario.get(p.usuario) || 0) + (parseFloat(p.valor as any) || 0),
        );
      }
    }
    const montoDelMes = (usuario: string) => montoPorUsuario.get(usuario) || 0;

    const usersWithStatus: DashboardUser[] = filteredUsers.map((u) => {
      const alDia = alDiaByUser.get(normU(u.username)) ?? false;
      const paymentStatus: 'Al día' | 'Pendiente' = alDia ? 'Al día' : 'Pendiente';
      return { ...u, paymentStatus, paymentAmount: montoDelMes(u.username) };
    });

    usersWithStatus.sort((a, b) => {
      const order: Record<string, number> = { Pendiente: 0, 'Sin pagos': 1, 'Al día': 2 };
      return (order[a.paymentStatus || 'Sin pagos'] ?? 1) - (order[b.paymentStatus || 'Sin pagos'] ?? 1);
    });

    const counts = {
      // Total y estados salen del mismo reporte (Firebase RTDB, igual que Pagos).
      total: reporte.propietarios.length,
      // Mismos orígenes para los tres números, así siempre suman el total.
      alDia: reporte.totalAlDia,
      pendientes: reporte.totalMora,
    };

    return { role, vigilanteEnTurno, usuarios: usersWithStatus, ownerMonths: [], counts };
  }
}
