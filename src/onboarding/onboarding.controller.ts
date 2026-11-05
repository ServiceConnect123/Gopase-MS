import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { OnboardingService } from './onboarding.service';

/**
 * Autoregistro de conjuntos desde la landing. PÚBLICO (sin JWT): quien se
 * registra aún no tiene cuenta. Por eso todo el alta ocurre aquí, en el backend,
 * con el rol fijado por el servidor y sin exponer POST /properties ni /users.
 */
@Public()
@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /**
   * IP del cliente para el límite de registros. Se toma la ÚLTIMA entrada de
   * X-Forwarded-For (la que añade el proxy de confianza); las anteriores las
   * puede falsificar el cliente.
   */
  private ipOf(req: any): string {
    const xff = String(req?.headers?.['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return xff.length > 0 ? xff[xff.length - 1] : String(req?.ip ?? '');
  }

  @ApiOperation({
    summary: 'Registra un conjunto (estado pendiente) y a su administrador',
    description:
      'Crea el conjunto y el administrador (rol admin) y devuelve un registroToken para elegir el plan. ' +
      'La prueba gratis arranca al registrarse.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        nombreConjunto: { type: 'string' },
        ciudad: { type: 'string' },
        tipo: { type: 'string', enum: ['Campestre', 'Urbano'] },
        nombreAdmin: { type: 'string' },
        email: { type: 'string' },
        telefono: { type: 'string' },
        mensaje: { type: 'string' },
        password: { type: 'string', description: 'Cifrada con encriptarAES (igual que POST /users).' },
      },
      required: ['nombreConjunto', 'nombreAdmin', 'email', 'telefono', 'password'],
    },
  })
  @Post('register')
  async register(@Body() body: any, @Req() req: any) {
    return this.onboarding.register(body || {}, this.ipOf(req));
  }

  @ApiOperation({
    summary: 'Verifica, sin registrar, qué usuario se le asignaría a un nombre y si ya está tomado',
    description: 'Lo usa la landing para avisar en vivo bajo el campo del nombre del administrador.',
  })
  @ApiQuery({ name: 'nombre', required: true })
  @Get('check-usuario')
  async checkUsuario(@Query('nombre') nombre?: string) {
    return this.onboarding.checkUsuario(nombre || '');
  }

  @ApiOperation({
    summary: 'Elige plan y ciclo (mensual/anual) del conjunto recién registrado',
    description:
      'Mensual: 15 días de prueba. Anual: 30 días (15 + 15 de regalo). Requiere el registroToken del registro.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjuntoId: { type: 'string' },
        registroToken: { type: 'string' },
        planId: { type: 'string', example: 'basico' },
        ciclo: { type: 'string', enum: ['mensual', 'anual'] },
      },
      required: ['conjuntoId', 'registroToken', 'planId', 'ciclo'],
    },
  })
  @Post('plan')
  async selectPlan(@Body() body: any) {
    return this.onboarding.selectPlan(body || {});
  }
}
