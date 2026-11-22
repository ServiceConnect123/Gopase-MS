import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FirebaseService } from '../firebase/firebase.service';
import { conjuntoPropioDelRequest } from '../auth/conjunto-scope';
import { RolesService, RolDto } from './roles.service';

const rolDe = (req: any) => String(req?.user?.rol || '').toLowerCase();
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Roles y permisos.
 *   - Leer: cualquier usuario con sesión ve los roles del sistema, los globales y
 *     los de su conjunto (el menú los necesita). El superAdmin ve todos.
 *   - Roles del sistema (admin, vigilante, propietario, inquilino, superAdmin):
 *     solo el superAdmin los edita; nadie los elimina.
 *   - Roles personalizados: el superAdmin (de cualquier conjunto o globales) y el
 *     admin del conjunto (solo los de su conjunto).
 * Si el guard JWT está apagado (sin req.user) no se restringe, como en el resto del rollout.
 */
@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly firebase: FirebaseService,
  ) {}

  private async conjuntoPropio(req: any): Promise<string> {
    return String((await conjuntoPropioDelRequest(req, this.firebase)) || '');
  }

  /** ¿Puede crear/editar/eliminar este rol? */
  private async puedeGestionar(req: any, rol: RolDto | null, conjuntoNuevo?: string): Promise<void> {
    if (!req?.user) return;
    const r = rolDe(req);
    if (r === 'superadmin') return;
    if (r !== 'admin') throw new ForbiddenException('Solo la administración gestiona roles.');
    if (rol?.sistema) throw new ForbiddenException('Los roles del sistema solo los edita el superAdmin.');
    const propio = await this.conjuntoPropio(req);
    if (!propio) throw new ForbiddenException('Tu usuario no tiene conjunto.');
    const objetivo = rol ? rol.conjunto : conjuntoNuevo;
    if (!objetivo || norm(objetivo) !== norm(propio)) throw new ForbiddenException('Solo puedes gestionar los roles de tu conjunto.');
  }

  @ApiOperation({ summary: 'Roles visibles: del sistema, globales y del conjunto del usuario (superAdmin: todos)' })
  @Get()
  async list(@Req() req: any) {
    let data = await this.roles.list();
    if (req?.user && rolDe(req) !== 'superadmin') {
      const propio = norm(await this.conjuntoPropio(req));
      data = data.filter((r) => r.sistema || !r.conjunto || (propio && norm(r.conjunto) === propio));
    }
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear rol personalizado (admin: de su conjunto)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        permissions: { description: 'Lista de permisos [{ path, name, status }]' },
        conjunto: { type: 'string', description: 'Solo superAdmin ("" = global)' },
      },
      required: ['name'],
    },
  })
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    let conjunto = String(body?.conjunto ?? '');
    if (req?.user && rolDe(req) !== 'superadmin') conjunto = await this.conjuntoPropio(req);
    await this.puedeGestionar(req, null, conjunto);
    return this.roles.create({ ...body, conjunto }, { permitirSistema: !req?.user || rolDe(req) === 'superadmin' });
  }

  @ApiOperation({ summary: 'Editar rol (los del sistema: solo superAdmin; conservan su nombre)' })
  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const rol = await this.roles.getById(id);
    if (!rol) throw new NotFoundException('El rol no existe.');
    await this.puedeGestionar(req, rol);
    return this.roles.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar rol personalizado' })
  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const rol = await this.roles.getById(id);
    if (!rol) throw new NotFoundException('El rol no existe.');
    await this.puedeGestionar(req, rol);
    return this.roles.remove(id);
  }
}
