import { genkit, z, type Genkit, type MessageData } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';

/**
 * Chat de finanzas con Genkit + Gemini (Google AI).
 *
 * - La API key es la del conjunto (`geminiKey`), resuelta en el backend y
 *   enviada por petición (`config.apiKey`): el plugin se inicia con
 *   `apiKey: false`, así un solo proceso atiende conjuntos con claves distintas.
 * - Conversación multi-turno: el cliente manda el historial y la pregunta.
 * - Herramienta `estadoPropietarios`: consulta en vivo la lista de propietarios
 *   del conjunto con su estado de pago (la misma de la vista Pagos), para
 *   responder con nombres reales ("¿quiénes están en mora?").
 */

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface OwnerRow {
  nombre: string;
  unidad: string;
  estado: 'al día' | 'por confirmar' | 'en mora';
  mesesPagados: number;
  mesesAplicables: number;
  /** Ene..Dic: p pagado, c por confirmar, m mora, d disponible, n no aplica. */
  meses: string;
  pagadoEnElAnio: number;
}

/** Contexto por petición que reciben las herramientas. */
interface ChatContext {
  conjunto: string;
  year: number;
  loadOwners: (conjunto: string, year: number) => Promise<OwnerRow[]>;
}

/** Modelos en orden de preferencia (alias estable primero). */
const MODELS = ['gemini-flash-latest', 'gemini-3.5-flash-lite'];
const MAX_HISTORY = 20;

let instance: { ai: Genkit; ownersTool: any } | null = null;

function getAi() {
  if (instance) return instance;
  const ai = genkit({ plugins: [googleAI({ apiKey: false })] });

  const ownersTool = ai.defineTool(
    {
      name: 'estadoPropietarios',
      description:
        'Lista los propietarios del conjunto con su estado de pago del año: nombre, unidad, ' +
        'estado (al día, por confirmar, en mora), meses pagados, la tira de 12 meses ' +
        '(p pagado, c por confirmar, m mora, d disponible, n no aplica) y lo pagado en el año. ' +
        'Úsala para preguntas sobre morosos, quién debe, quién está al día o un propietario concreto.',
      inputSchema: z.object({
        estado: z
          .enum(['todos', 'en mora', 'por confirmar', 'al día'])
          .optional()
          .describe('Filtra por estado. Por defecto todos.'),
      }),
      outputSchema: z.array(
        z.object({
          nombre: z.string(),
          unidad: z.string(),
          estado: z.string(),
          mesesPagados: z.number(),
          mesesAplicables: z.number(),
          meses: z.string(),
          pagadoEnElAnio: z.number(),
        }),
      ),
    },
    async (input, { context }) => {
      const ctx = context as unknown as ChatContext;
      const rows = await ctx.loadOwners(ctx.conjunto, ctx.year);
      const filtro = input.estado && input.estado !== 'todos' ? input.estado : null;
      return (filtro ? rows.filter((r) => r.estado === filtro) : rows).slice(0, 300);
    },
  );

  instance = { ai, ownersTool };
  return instance;
}

const SYSTEM = (contexto: string, year: number) =>
  `Eres el chat de finanzas de goPase, una app para administrar conjuntos residenciales en Colombia.
Respondes al administrador sobre ingresos, gastos, recaudo, saldo de caja y propietarios del año ${year}.

DATOS FINANCIEROS DEL CONJUNTO (resumen calculado por la app):
${contexto || 'Sin datos financieros disponibles.'}

SOBRE LA APP (orienta las acciones hacia ella): Inicio, Pagos (registrar/confirmar pagos, ver morosos,
recordar deudores por WhatsApp), Gastos e Ingresos, Finanzas (indicadores, cuadre de caja y este chat),
Reportes, Propietarios, Conjuntos (cuota, medios de pago, API key de Gemini), Configuración.

REGLAS:
- Usa la herramienta estadoPropietarios cuando la pregunta sea sobre propietarios concretos (morosos, quién debe, quién está al día).
- Responde solo con los datos disponibles; si algo no está en los datos, dilo. No inventes cifras ni nombres.
- Si la pregunta no es de finanzas o administración del conjunto, indícalo con amabilidad.
- Si recomiendas una acción, di en qué sección de goPase hacerla.
- Español, directo y profesional. Máximo 200 palabras. Usa **negritas** para lo clave.`;

export async function runFinanceChat(params: {
  apiKey: string;
  conjunto: string;
  year: number;
  question: string;
  history: ChatTurn[];
  context: string;
  loadOwners: ChatContext['loadOwners'];
}): Promise<{ success: boolean; text?: string; message?: string }> {
  const { ai, ownersTool } = getAi();

  const messages: MessageData[] = params.history
    .filter((t) => t && (t.role === 'user' || t.role === 'model') && String(t.text || '').trim())
    .slice(-MAX_HISTORY)
    .map((t) => ({ role: t.role, content: [{ text: String(t.text).slice(0, 4000) }] }));

  const question =
    params.question.trim() ||
    'Haz un resumen del estado financiero del conjunto: si está sano o en riesgo, tendencia de recaudo, ' +
      'gastos a revisar y máximo 4 recomendaciones.';

  let lastError: any = null;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.generate({
          model: googleAI.model(model),
          system: SYSTEM(params.context, params.year),
          messages,
          prompt: question,
          tools: [ownersTool],
          maxTurns: 3,
          config: { apiKey: params.apiKey, temperature: 0.3 } as any,
          context: { conjunto: params.conjunto, year: params.year, loadOwners: params.loadOwners } as any,
        });
        const text = (res.text || '').trim();
        if (text) return { success: true, text };
        lastError = new Error('Respuesta vacía');
        break;
      } catch (e: any) {
        lastError = e;
        const status = e?.status ?? e?.code ?? e?.detail?.status;
        const msg = String(e?.message || '').toLowerCase();
        const saturado = status === 429 || status === 503 || /resource_exhausted|unavailable|overloaded|429|503/.test(msg);
        if (saturado && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (/api key|permission|unauthenticated|invalid_argument.*key/.test(msg)) {
          return { success: false, message: 'La API key de Gemini del conjunto no es válida. Revísala en Conjuntos.' };
        }
        break; // probar el siguiente modelo
      }
    }
  }

  const msg = String(lastError?.message || '').toLowerCase();
  if (/429|503|resource_exhausted|unavailable|overloaded/.test(msg)) {
    return { success: false, message: 'El servicio de IA está saturado. Inténtalo de nuevo en unos segundos.' };
  }
  return { success: false, message: 'No se pudo obtener respuesta de la IA.' };
}
