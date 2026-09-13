import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UsersService, UserDTO } from './users.service';

/**
 * CRUD de usuarios contra Firebase (RTDB + Auth). Reemplaza las llamadas del
 * frontend a Google Sheets (getUsuarios/addUser/updateUser/deleteUser).
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

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
