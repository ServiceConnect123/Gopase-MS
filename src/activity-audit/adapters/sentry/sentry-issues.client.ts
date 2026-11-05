// ==========================================
// activity-audit · adapter Sentry · ErrorIssueSource (solo lectura)
// ==========================================
// Consulta la API REST de Sentry para listar los errores ya agrupados y
// resolver el id de un evento a su URL. Requiere un token con scope
// `event:read` (Internal Integration o token personal; un "Organization Auth
// Token" NO sirve para leer issues).
//
// Seguridad:
//  - El token solo vive en memoria del servidor; nunca se loguea ni se devuelve.
//  - Los parámetros del cliente se validan contra listas blancas (no se reenvía
//    texto libre a la búsqueda de Sentry).
//  - Solo se devuelven campos técnicos del issue: nada de asignados, emails,
//    IP ni payload del evento.

import type { ErrorIssueSource } from '../../core/ports';
import type { ErrorIssue, ErrorIssueQuery, ErrorIssueResult } from '../../core/types';

export interface SentryIssuesConfig {
  /** Token de la API de Sentry (scope event:read). */
  token: string;
  /** Slug de la organización (p. ej. sconnectgroup). */
  org: string;
  /** Slugs de los proyectos a consultar (p. ej. gopase-backend, gopase-app). */
  projects: string[];
  /** Base de la API según la región (default https://us.sentry.io). */
  apiUrl?: string;
  /** Base web para armar enlaces (default https://{org}.sentry.io). */
  webUrl?: string;
  timeoutMs?: number;
  /** Vida de la caché en ms para no gastar cuota de la API (default 30 s). */
  cacheTtlMs?: number;
}

const PERIODOS = new Set(['24h', '7d', '14d', '30d', '90d']);
const ESTADOS: Record<string, string> = { unresolved: 'is:unresolved', resolved: 'is:resolved', all: '' };
const EVENT_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Nombres de entorno a consultar en Sentry para un ambiente lógico. Devuelve
 * TODAS las variantes porque los distintos servicios no etiquetan igual: el
 * backend usa 'prod'/'qa' (AUDIT_ENV) y la app 'production'/'qa'
 * (SENTRY_ENVIRONMENT). Si no se filtra por todas, los issues de un servicio
 * quedan ocultos aunque existan. Vacío = sin filtro (todos los entornos).
 */
function toSentryEnvironments(ambiente?: string): string[] {
  const v = String(ambiente ?? '').trim().toLowerCase();
  if (v === 'qa') return ['qa'];
  if (v === 'prod' || v === 'production') return ['production', 'prod'];
  return [];
}

export class SentryIssuesClient implements ErrorIssueSource {
  private readonly apiUrl: string;
  private readonly webUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(private readonly cfg: SentryIssuesConfig) {
    this.apiUrl = (cfg.apiUrl || 'https://us.sentry.io').replace(/\/+$/, '');
    this.webUrl = (cfg.webUrl || `https://${cfg.org}.sentry.io`).replace(/\/+$/, '');
    this.timeoutMs = cfg.timeoutMs ?? 8000;
    this.cacheTtlMs = cfg.cacheTtlMs ?? 30_000;
  }

  async list(query: ErrorIssueQuery): Promise<ErrorIssueResult> {
    const periodo = PERIODOS.has(String(query.periodo)) ? String(query.periodo) : '14d';
    const estado = Object.prototype.hasOwnProperty.call(ESTADOS, String(query.estado))
      ? String(query.estado)
      : 'unresolved';
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit)) || 25));
    const environments = toSentryEnvironments(query.ambiente);

    const key = JSON.stringify(['list', periodo, estado, limit, environments.join(',')]);
    const hit = this.fromCache<ErrorIssueResult>(key);
    if (hit) return hit;

    // Una llamada por proyecto: si uno falla (p. ej. aún no existe) los demás siguen.
    const settled = await Promise.allSettled(
      this.cfg.projects.map((project) =>
        this.listProject(project, { periodo, estado, limit, environments }),
      ),
    );

    const issues: ErrorIssue[] = [];
    const warnings: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') issues.push(...r.value);
      else warnings.push(`No se pudo consultar el proyecto "${this.cfg.projects[i]}" (${errMsg(r.reason)}).`);
    });

    issues.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    const result: ErrorIssueResult = { issues: issues.slice(0, limit), warnings };
    // Si TODO falló no se cachea: así un arreglo de token se nota de inmediato.
    if (issues.length > 0 || warnings.length === 0) this.toCache(key, result);
    return result;
  }

  async resolveEventUrl(eventId: string): Promise<string | undefined> {
    if (!EVENT_ID_RE.test(String(eventId))) return undefined;
    const id = eventId.toLowerCase();
    const key = JSON.stringify(['event', id]);
    const hit = this.fromCache<string | null>(key);
    if (hit !== undefined) return hit ?? undefined;

    try {
      const data = await this.getJson(
        `/api/0/organizations/${encodeURIComponent(this.cfg.org)}/eventids/${id}/`,
      );
      // El payload trae el evento completo (con datos del usuario): solo se leen
      // estos dos campos y el resto se descarta.
      const groupId = data?.groupId ? String(data.groupId) : '';
      const url = groupId ? `${this.webUrl}/issues/${encodeURIComponent(groupId)}/events/${id}/` : null;
      this.toCache(key, url, 10 * 60_000);
      return url ?? undefined;
    } catch {
      return undefined;
    }
  }

  // ---- internos ----

  private async listProject(
    project: string,
    p: { periodo: string; estado: string; limit: number; environments: string[] },
  ): Promise<ErrorIssue[]> {
    const qs = new URLSearchParams();
    qs.append('project', project);
    qs.set('query', ESTADOS[p.estado]);
    qs.set('statsPeriod', p.periodo);
    qs.set('sort', 'date');
    qs.set('limit', String(p.limit));
    // Sin series de estadísticas: la respuesta es mucho más liviana.
    qs.append('collapse', 'stats');
    qs.append('collapse', 'unhandled');
    // Filtro por entorno: se agregan TODAS las variantes (la API de Sentry acepta
    // el parámetro `environment` repetido y hace OR entre ellas).
    for (const env of p.environments) qs.append('environment', env);

    const raw = await this.getJson(`/api/0/organizations/${encodeURIComponent(this.cfg.org)}/issues/?${qs}`);
    if (!Array.isArray(raw)) return [];
    return raw.map((r: any): ErrorIssue => ({
      id: String(r?.id ?? ''),
      shortId: String(r?.shortId ?? ''),
      title: String(r?.title ?? ''),
      culprit: String(r?.culprit ?? ''),
      level: String(r?.level ?? 'error'),
      status: String(r?.status ?? 'unresolved'),
      count: Number(r?.count) || 0,
      userCount: Number(r?.userCount) || 0,
      firstSeen: String(r?.firstSeen ?? ''),
      lastSeen: String(r?.lastSeen ?? ''),
      project: String(r?.project?.slug ?? project),
      permalink: String(r?.permalink ?? ''),
    }));
  }

  private async getJson(path: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      // Solo el código HTTP: el cuerpo de error no se propaga ni se loguea.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private fromCache<T>(key: string): T | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  private toCache(key: string, value: unknown, ttlMs: number = this.cacheTtlMs): void {
    if (this.cache.size >= 100) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  }
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /abort/i.test(m) ? 'tiempo de espera agotado' : m;
}
