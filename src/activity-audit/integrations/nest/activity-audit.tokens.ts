// Tokens de inyección del módulo de auditoría (NestJS).
export const ACTIVITY_LOGGER = Symbol('ACTIVITY_LOGGER');
export const SESSION_TRACKER = Symbol('SESSION_TRACKER');
/** Fuente de errores técnicos (opcional; null si no está configurada). */
export const ERROR_ISSUE_SOURCE = Symbol('ERROR_ISSUE_SOURCE');
