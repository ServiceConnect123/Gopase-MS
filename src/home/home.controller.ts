import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { HomeService } from './home.service';

/**
 * Dashboard de la pantalla Home. El frontend solo pinta lo que devuelve.
 */
@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @ApiOperation({
    summary: 'Dashboard de Home (usuarios + estados de pago + vigilante en turno)',
    description:
      'Devuelve la data ya calculada según el rol: admin recibe la lista de ' +
      'usuarios con su estado de pago; propietario recibe su estado por mes.',
  })
  @ApiQuery({ name: 'role', required: true })
  @ApiQuery({ name: 'complex', required: false })
  @ApiQuery({ name: 'username', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'month', required: false })
  @ApiQuery({
    name: 'superAdmin',
    required: false,
    description:
      "Solo aplica a role=superAdmin. 'true' (o ausente) = vista global de todos " +
      "los conjuntos; 'false' con 'complex' = opera como admin de ese conjunto.",
  })
  @Get('dashboard')
  async dashboard(
    @Query('role') role: string,
    @Query('complex') complex?: string,
    @Query('username') username?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('superAdmin') superAdmin?: string,
  ) {
    return this.home.getDashboard({
      role: role || '',
      complex: complex || '',
      username: username || '',
      year: year ? parseInt(year, 10) : new Date().getFullYear(),
      month,
      // Compat: si no viene el parámetro, un superAdmin ve "Todos" (como antes).
      verTodos: superAdmin === undefined ? undefined : superAdmin === 'true',
    });
  }
}
