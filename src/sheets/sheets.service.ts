import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cliente para el Google Apps Script que expone las hojas de goPase.
 * Todas las peticiones son POST con { action, sheet, ... } y el script
 * devuelve los registros como objetos { dato_1, dato_2, ... }.
 *
 * Incluye timeout configurable y reintentos con backoff para tolerar la
 * lentitud/cold start del Apps Script (evita el error "operation aborted").
 */
@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private readonly scriptUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly config: ConfigService) {
    this.scriptUrl = this.config.get<string>('SCRIPT_URL', '');
    // Timeout por petición (ms). Subido a 40s porque leer la sesión de WhatsApp
    // puede ser pesado si la hoja tiene muchas filas.
    this.timeoutMs = Number(this.config.get<string>('SHEETS_TIMEOUT_MS', '40000'));
    // Reintentos para operaciones idempotentes (read/update/delete).
    this.maxRetries = Number(this.config.get<string>('SHEETS_MAX_RETRIES', '2'));
    if (!this.scriptUrl) {
      this.logger.error('SCRIPT_URL no está configurada. Revisa tu .env');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async postOnce<T = any>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.scriptUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.substring(0, 120)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * POST con reintentos y backoff exponencial.
   * `retryable` debe ser true solo para operaciones idempotentes; un `create`
   * no se reintenta para no duplicar filas.
   */
  private async post<T = any>(
    body: Record<string, unknown>,
    retryable = false,
  ): Promise<T> {
    const attempts = retryable ? this.maxRetries + 1 : 1;
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.postOnce<T>(body);
      } catch (err: any) {
        lastErr = err;
        if (i < attempts - 1) {
          const wait = 1500 * Math.pow(2, i); // 1.5s, 3s, 6s...
          this.logger.warn(
            `Intento ${i + 1}/${attempts} falló (${err?.message}). Reintentando en ${wait}ms...`,
          );
          await this.sleep(wait);
        }
      }
    }
    throw lastErr;
  }

  /** Lee todas las filas de una hoja como array de objetos { dato_n }. */
  async read(sheet: string): Promise<Record<string, any>[]> {
    const data = await this.post<any>({ action: 'read', sheet, noCache: true }, true);
    if (Array.isArray(data)) return data;
    if (data?.data && Array.isArray(data.data)) return data.data;
    if (data?.items && Array.isArray(data.items)) return data.items;
    this.logger.warn(`Respuesta inesperada al leer '${sheet}'`);
    return [];
  }

  /** Crea una fila. data es el array de valores en orden dato_1, dato_2, ... */
  async create(sheet: string, data: any[], usuario = 'wspsend-ms'): Promise<boolean> {
    // No reintentable: un create repetido duplicaría la fila.
    const res = await this.post<any>({ action: 'create', sheet, data, usuario });
    if (res?.status !== 'success') {
      this.logger.warn(`Error al crear en '${sheet}': ${res?.message}`);
      return false;
    }
    return true;
  }

  /**
   * Actualiza la fila cuyo dato_1 (columna A) coincide con `id`.
   * data es el array de valores en orden dato_1, dato_2, ...
   */
  async update(
    sheet: string,
    id: string,
    data: any[],
    usuario = 'wspsend-ms',
  ): Promise<boolean> {
    // Idempotente: reintentable.
    const res = await this.post<any>(
      { action: 'update', sheet, id, data, usuario },
      true,
    );
    if (res?.status !== 'success') {
      this.logger.warn(`Error al actualizar '${id}' en '${sheet}': ${res?.message}`);
      return false;
    }
    return true;
  }

  /** Elimina la fila cuyo dato_1 coincide con `id`. */
  async delete(sheet: string, id: string): Promise<boolean> {
    // Idempotente: reintentable.
    const res = await this.post<any>({ action: 'delete', sheet, id }, true);
    if (res?.status !== 'success') {
      // El Apps Script lanza error si el id no existe; lo tratamos como no-fatal.
      this.logger.debug(`No se eliminó '${id}' en '${sheet}': ${res?.message}`);
      return false;
    }
    return true;
  }
}
