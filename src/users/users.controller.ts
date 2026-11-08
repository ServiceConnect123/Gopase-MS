import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UsersService, UserDTO } from './users.service';
import { UsersImportService } from './users-import.service';
import { UsersInviteService } from './users-invite.service';
import { Public } from '../auth/public.decorator';

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
    private readonly usersInvite: UsersInviteService,
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

  // ==========================================================================
  // Invitación por QR y envío de credenciales
  // ==========================================================================

  @ApiOperation({
    summary: 'Genera el link/token de invitación QR del conjunto (admin).',
    description: 'El token es un JWT de 30 días. El link apunta a la pantalla de autoregistro del frontend.',
  })
  @ApiQuery({ name: 'conjunto', required: true })
  @Get('invite-link')
  async getInviteLink(@Query('conjunto') conjunto: string) {
    return this.usersInvite.getInviteLink(conjunto || '');
  }

  @ApiOperation({
    summary: 'Valida un token de invitación QR y devuelve el nombre del conjunto. Público.',
  })
  @Public()
  @Get('invite-validate')
  async validateInviteToken(@Query('token') token: string) {
    return this.usersInvite.validateInviteToken(token || '');
  }

  @ApiOperation({
    summary: 'Autoregistro del propietario usando el token del QR. Público.',
    description: 'Crea la cuenta del propietario con contraseña temporal y devuelve sus credenciales.',
  })
  @Public()
  @Post('self-register')
  async selfRegister(@Body() body: {
    token: string;
    nombre: string;
    email?: string;
    phone?: string;
    documentType?: string;
    documentNumber?: string;
    parcela?: string;
  }) {
    const { token, ...data } = body || {};
    return this.usersInvite.selfRegister(token || '', data);
  }

  @ApiOperation({
    summary: 'Lista usuarios del conjunto que nunca han iniciado sesión.',
  })
  @ApiQuery({ name: 'conjunto', required: true })
  @Get('never-logged')
  async neverLoggedIn(@Query('conjunto') conjunto: string) {
    return this.usersInvite.neverLoggedIn(conjunto || '');
  }

  @ApiOperation({
    summary: 'Envía las credenciales de un usuario por WhatsApp.',
    description: 'Envía usuario + contraseña temporal al número registrado del propietario.',
  })
  @Post(':username/send-credentials')
  async sendCredentials(
    @Param('username') username: string,
    @Query('conjunto') conjunto: string,
  ) {
    return this.usersInvite.sendCredentials(username || '', conjunto || '');
  }
}
