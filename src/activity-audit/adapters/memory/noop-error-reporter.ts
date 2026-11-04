// ==========================================
// activity-audit · adapter no-op · ErrorReporter
// ==========================================
// Modo deshabilitado / tests: no reporta nada.

import type { ErrorReporter } from '../../core/ports';
import type { ActivityLog, ErrorContext, RequestContext } from '../../core/types';

export class NoopErrorReporter implements ErrorReporter {
  breadcrumb(_log: ActivityLog): void {}
  captureError(_error: unknown, _ctx: ErrorContext): string | undefined {
    return undefined;
  }
  setRequestContext(_ctx: RequestContext): void {}
}
