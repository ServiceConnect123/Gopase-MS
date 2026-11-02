import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { NoticiasService } from './noticias.service';

/** CRUD de noticias del conjunto (RTDB mirror/noticias). */
@ApiTags('noticias')
@Controller('noticias')
export class NoticiasController {
  constructor(private readonly noticias: NoticiasService) {}

  @ApiOperation({ summary: 'Lista de noticias (opcionalmente por conjunto)' })
  @ApiQuery({ name: 'conjunto', required: false })
  @Get()
  async list(@Query('conjunto') conjunto?: string) {
    const data = await this.noticias.list(conjunto || '');
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Crear noticia' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        conjunto: { type: 'string', description: 'nombre del conjunto' },
        autor: { type: 'string' },
        autorNombre: { type: 'string' },
        titulo: { type: 'string' },
        subtitulo: { type: 'string' },
        descripcion: { type: 'string' },
        atributos: { type: 'array', items: { type: 'string' }, description: 'etiquetas' },
        imagenes: { type: 'array', items: { type: 'string' }, description: 'URLs de imágenes (Drive)' },
      },
      required: ['titulo'],
    },
  })
  @Post()
  async create(@Body() body: any) {
    return this.noticias.create(body);
  }

  @ApiOperation({ summary: 'Editar noticia' })
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.noticias.update(id, body);
  }

  @ApiOperation({ summary: 'Marcar noticia como enviada por WhatsApp' })
  @Post(':id/enviada-wsp')
  async marcarEnviadaWsp(@Param('id') id: string) {
    return this.noticias.marcarEnviadaWsp(id);
  }

  @ApiOperation({ summary: 'Eliminar noticia' })
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.noticias.remove(id);
  }
}
