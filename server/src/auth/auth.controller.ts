import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService, type AuthResponse } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto } from './dto/auth.dto';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Create an account (auto-creates a paper trading account)' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponse> {
    return this.auth.register(dto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Sign in with email + password' })
  async login(@Body() dto: LoginDto): Promise<AuthResponse> {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('demo')
  @ApiOperation({ summary: 'Instant demo access — provisions a throwaway paper account' })
  async demoLogin(): Promise<AuthResponse & { isDemo: boolean }> {
    const response = await this.auth.demoLogin();
    return { ...response, isDemo: true };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  async refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body() dto: LogoutDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Current user' })
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.me(user.sub);
  }
}
