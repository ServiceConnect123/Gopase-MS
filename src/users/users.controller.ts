import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UsersService, UserDTO } from './users.service';
import { UsersImportService } from './users-import.service';

/**
 * CRUD de usuarios contra Firebase (RTDB + Auth). Reemplaza las llamadas del
 * frontend a Google Sheets (getUsuarios/addUser/updateUser/deleteUser).
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly usersImport: UsersImportService,
  ) {}

  // ==========================================================================
  // Carga masiva de propietarios (Excel)
  // ==========================================================================

  @ApiOperation({
    summary: 'Descargar plantilla Excel de propietarios (crear o editar)',
    description:
      'mode=create: plantilla vacía con ejemplo. mode=edit: propietarios actuales del conjunto. ' +
      'Solo propietarios; no incluye superAdmin ni contraseña.',
  })
  @ApiQuery({ name: 'conjunto', required: true })
  @ApiQuery({ name: 'mode', required: false, enum: ['create', 'edit'] })
  @Get('import-template')
  async importTemplate(
    @Query('conjunto') conjunto: string,
    @Query('mode') mode?: 'create' | 'edit',
  ) {
    const buffer = await this.usersImport.generateTemplate({
      conjunto: conjunto || '',
      mode: mode === 'edit' ? 'edit' : 'create',
    });
    return {
      success: true,
      fileName: `gopase_${mode === 'edit' ? 'editar' : 'plantilla'}_propietarios.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: buffer.toString('base64'),
    };
  }

  @ApiOperation({
    summary: 'Importar propietarios desde Excel (crear/actualizar/eliminar en bloque)',
    description:
      'dryRun=true devuelve el resumen sin aplicar (preview). dryRun=false aplica si no hay errores. ' +
      'Solo rol propietario; nunca toca superAdmin; sin contraseña.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        fileBase64: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['conjunto', 'fileBase64'],
    },
  })
  @Post('import')
  async importFile(@Body() body: { conjunto: string; fileBase64: string; dryRun?: boolean }) {
    const summary = await this.usersImport.processImport({
      conjunto: body.conjunto || '',
      fileBase64: body.fileBase64 || '',
      dryRun: body.dryRun !== false, // por defecto dry-run (seguro)
    });
    return { success: summary.errores === 0, summary };
  }

  @ApiOperation({ summary: 'Lista de usuarios (opcionalmente filtrada por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.users.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear usuario (RTDB + Firebase Auth)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        usuario: { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string', description: 'Cifrada (XOR), igual que el frontend' },
        nombre: { type: 'string' },
        rol: { type: 'string' },
        documentType: { type: 'string' },
        documentNumber: { type: 'string' },
        phone: { type: 'string' },
        conjunto: { type: 'string' },
        parcela: { type: 'string' },
        placa1: { type: 'string' },
        placa2: { type: 'string' },
        fechaIngreso: { type: 'string' },
      },
      required: ['usuario'],
    },
  })
  @Post()
  async create(@Body() body: UserDTO) {
    return this.users.create(body);
  }

  @ApiOperation({ summary: 'Editar usuario' })
  @Put(':username')
  async update(@Param('username') username: string, @Body() body: UserDTO) {
    return this.users.update(username, body);
  }

  @ApiOperation({ summary: 'Eliminar usuario (RTDB + Auth)' })
  @Delete(':username')
  async remove(@Param('username') username: string) {
    return this.users.remove(username);
  }
}
