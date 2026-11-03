import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TagsService } from './tags.service';

/** Etiquetas (tags) de usuarios por conjunto. RTDB mirror/etiquetas. */
@ApiTags('tags')
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @ApiOperation({ summary: 'Lista de etiquetas (por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.tags.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear etiqueta' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        conjunto: { type: 'string' },
        nombre: { type: 'string' },
        color: { type: 'string', description: 'hex (#RRGGBB)' },
      },
      required: ['conjunto', 'nombre'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.tags.create(body);
  }

  @ApiOperation({ summary: 'Editar etiqueta (nombre/color)' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.tags.update(id, body);
  }

  @ApiOperation({ summary: 'Eliminar etiqueta (y quitarla de los usuarios)' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.tags.remove(id);
  }
}
