import { Injectable, Logger } from '@nestjs/common';
import { SheetsService } from '../sheets/sheets.service';
import { PaymentsService } from '../payments/payments.service';

/**
 * Lógica del dashboard de la pantalla Home, movida del frontend al backend.
 *
 * Lee usuarios, pagos y reportes de Sheets y devuelve la data YA CALCULADA:
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

  private mapUsuario(u: any): DashboardUser {
    return {
      username: String(u.dato_1 ?? ''),
      name: String(u.dato_4 ?? ''),
      role: String(u.dato_5 ?? ''),
      complex: String(u.dato_9 ?? ''),
      phone: String(u.dato_8 ?? ''),
      placa1: String(u.dato_11 ?? ''),
      placa2: String(u.dato_12 ?? ''),
      fechaIngreso: String(u.dato_13 ?? ''),
    };
  }

  private mapPago(p: any) {
    return {
      usuario: String(p.dato_2 ?? ''),
      estado: String(p.dato_6 ?? ''),
      concepto: String(p.dato_3 ?? ''),
      valor: p.dato_4 ?? 0,
      fecha: String(p.dato_5 ?? '').split('T')[0],
      referencia: String(p.dato_7 ?? ''),
    };
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
  }): Promise<DashboardResponse> {
    const { role, complex, username, year } = params;
    const month = params.month || MONTHS[new Date().getMonth()];

    const [userRows, pagoRows, reporteRows] = await Promise.all([
      this.sheets.read('usuarios'),
      this.sheets.read('pagos'),
      this.sheets.read('reportes'),
    ]);

    const allUsers = userRows.map((u) => this.mapUsuario(u));
    const pagos = pagoRows.map((p) => this.mapPago(p));

    const vigilanteEnTurno = this.resolveVigilanteEnTurno(reporteRows, allUsers);

    // Filtrado por rol/conjunto (mismas reglas que home.tsx).
    let filteredUsers = allUsers.filter((u) => u.role !== 'superAdmin' && u.role !== 'vigilante');
    if (role !== 'superAdmin') {
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
    const isSuperAdmin = role === 'superAdmin';
    const reporte = await this.payments.getAlDiaReport(complex || '', isSuperAdmin);

    // Mapa username(normalizado) -> alDia del reporte.
    const normU = (s: string) => String(s || '').trim().toLowerCase();
    const alDiaByUser = new Map<string, boolean>();
    for (const p of reporte.propietarios) alDiaByUser.set(normU(p.usuario), p.alDia);

    // Monto del mes seleccionado (solo informativo para la tarjeta; no define el estado).
    const montoDelMes = (usuario: string) =>
      pagos
        .filter(
          (p) =>
            p.usuario === usuario &&
            p.concepto &&
            p.concepto.toLowerCase().includes(month.toLowerCase()) &&
            p.concepto.includes(String(year)) &&
            (p.estado || '').toLowerCase() === 'confirmado',
        )
        .reduce((sum: number, p: any) => sum + (parseFloat(p.valor) || 0), 0);

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
      total: usersWithStatus.length,
      alDia: usersWithStatus.filter((u) => u.paymentStatus === 'Al día').length,
      pendientes: usersWithStatus.filter((u) => u.paymentStatus === 'Pendiente').length,
    };

    return { role, vigilanteEnTurno, usuarios: usersWithStatus, ownerMonths: [], counts };
  }
}
