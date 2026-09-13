import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesService } from './roles.service';

/** CRUD de roles (global) contra Firebase (RTDB). Reemplaza Sheets. */
@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @ApiOperation({ summary: 'Lista global de roles' })
  @Get()
  async list() {
    const data = await this.roles.list();
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear rol' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        permissions: { description: 'Array u objeto de permisos' },
      },
      required: ['name'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.roles.create(body);
  }

  @ApiOperation({ summary: 'Editar rol (reescribe nombre + permisos)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.roles.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar rol' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.roles.remove(id);
  }
}
