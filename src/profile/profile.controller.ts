import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';

class UpdateProfileDto {
  @ApiProperty({ example: 'wilmerhernandez', description: 'Usuario (uid).' })
  username: string;

  @ApiPropertyOptional() nombre?: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() docType?: string;
  @ApiPropertyOptional() docNum?: string;
  @ApiPropertyOptional() parcela?: string;
  @ApiPropertyOptional() placa1?: string;
  @ApiPropertyOptional() placa2?: string;
  @ApiPropertyOptional({ description: 'Nueva contraseña (>=6). Si se envía, se cambia en Firebase Auth.' })
  newPassword?: string;
}

/**
 * Perfil de usuario contra Firebase (RTDB + Auth). No usa Sheets.
 */
@ApiTags('profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @ApiOperation({ summary: 'Obtiene el perfil del usuario (desde Firebase RTDB)' })
  @ApiQuery({ name: 'username', required: true })
  @Get()
  async get(@Query('username') username: string) {
    const profile = await this.profile.getProfile(username || '');
    return { success: !!profile, profile };
  }

  @ApiOperation({
    summary: 'Actualiza el perfil (RTDB + Auth)',
    description: 'Guarda los campos editables en el RTDB, sincroniza el nombre en Auth y, si se envía newPassword, cambia la contraseña.',
  })
  @Post('update')
  async update(@Body() body: UpdateProfileDto) {
    const { username, newPassword, ...changes } = body || ({} as UpdateProfileDto);
    return this.profile.updateProfile(username, changes, newPassword);
  }
}
