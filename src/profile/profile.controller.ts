import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { FirebaseService } from '../firebase/firebase.service';
import { assertPuedeGestionar } from '../auth/user-admin.guard-helper';

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
  constructor(
    private readonly profile: ProfileService,
    private readonly firebase: FirebaseService,
  ) {}

  @ApiOperation({ summary: 'Obtiene el perfil del usuario (desde Firebase RTDB)' })
  @ApiQuery({ name: 'username', required: true })
  @Get()
  async get(@Req() req: any, @Query('username') username: string) {
    // Solo el propio usuario, la administración de su conjunto o el superAdmin.
    await assertPuedeGestionar(req, this.firebase, username || '', { permitirPropio: true });
    const profile = await this.profile.getProfile(username || '');
    return { success: !!profile, profile };
  }

  @ApiOperation({
    summary: 'Actualiza el perfil (RTDB + Auth)',
    description: 'Guarda los campos editables en el RTDB, sincroniza el nombre en Auth y, si se envía newPassword, cambia la contraseña.',
  })
  @Post('update')
  async update(@Req() req: any, @Body() body: UpdateProfileDto) {
    const { username, newPassword, ...changes } = body || ({} as UpdateProfileDto);
    // Antes se aceptaba cualquier username: un usuario podía cambiarle la
    // contraseña a otro (incluido el superAdmin).
    await assertPuedeGestionar(req, this.firebase, username || '', { permitirPropio: true });
    return this.profile.updateProfile(username, changes, newPassword);
  }
}
