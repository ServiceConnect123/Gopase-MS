import {
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthMigrationService } from './auth-migration.service';
import { AuthLoginService } from './auth-login.service';

class LoginDto {
  @ApiProperty({ example: 'wilmerhernandez', description: 'Nombre de usuario.' })
  username: string;

  @ApiPropertyOptional({ description: 'Contraseña cifrada con el esquema XOR del frontend (encriptarAES).' })
  passwordEnc?: string;

  @ApiPropertyOptional({ description: 'Contraseña en claro (solo pruebas; preferir passwordEnc).' })
  password?: string;
}

class SetPasswordDto {
  @ApiProperty({ example: 'root', description: 'Nombre de usuario (uid).' })
  username: string;

  @ApiProperty({ description: 'Nueva contraseña (mínimo 6 caracteres).' })
  newPassword: string;
}

/**
 * Endpoints para migrar usuarios de Sheets a Firebase Auth (estrategia A1).
 * Protección opcional por header `x-sync-token` (reusa SYNC_TOKEN).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthMigrationController {
  constructor(
    private readonly migration: AuthMigrationService,
    private readonly loginService: AuthLoginService,
    private readonly config: ConfigService,
  ) {}

  private assertAuthorized(token?: string): void {
    const expected = this.config.get<string>('SYNC_TOKEN', '');
    if (expected && token !== expected) {
      throw new UnauthorizedException('Token inválido.');
    }
  }

  @ApiOperation({ summary: 'Estado del subsistema de migración de Auth' })
  @Get('status')
  status() {
    return { ok: true };
  }

  @ApiOperation({
    summary: 'Login contra Firebase Auth',
    description:
      'Valida usuario + contraseña (cifrada XOR en passwordEnc) contra Firebase ' +
      'Auth y devuelve el usuario con sus claims (rol, conjuntoId, mustChangePassword), sin la contraseña.',
  })
  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.loginService.login(body?.username, body?.passwordEnc, body?.password);
  }

  @ApiOperation({
    summary: 'Cambia la contraseña de un usuario (sin correo)',
    description:
      'Actualiza la contraseña directamente vía firebase-admin (los emails son ' +
      'sintéticos, no hay recuperación por correo). Limpia el claim mustChangePassword. ' +
      'Protegido por x-sync-token.',
  })
  @ApiSecurity('sync-token')
  @Post('set-password')
  async setPassword(@Headers('x-sync-token') token: string | undefined, @Body() body: SetPasswordDto) {
    this.assertAuthorized(token);
    return this.loginService.setPassword(body?.username, body?.newPassword);
  }

  @ApiOperation({
    summary: 'Migra usuarios de Sheets a Firebase Auth (A1)',
    description:
      'Crea/actualiza en Firebase Auth cada usuario con uid=username, email ' +
      'sintético y su contraseña actual descifrada, más custom claims rol/conjuntoId. ' +
      'Usa ?dryRun=true para simular sin escribir.',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiSecurity('sync-token')
  @Post('migrate')
  async migrate(
    @Headers('x-sync-token') token?: string,
    @Query('dryRun') dryRun?: string,
  ) {
    this.assertAuthorized(token);
    return this.migration.migrateAll(dryRun === 'true');
  }
}
