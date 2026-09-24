import { Module, type OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CONFIG } from '../config/configuration';
import { configProvider } from '../config/config.module';
import { AuthStore } from './auth.store';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [
    TradingModule,
    JwtModule.registerAsync({
      useFactory: (config: unknown) => ({
        secret: (config as { jwt: { accessSecret: string } }).jwt.accessSecret,
      }),
      inject: [CONFIG],
    }),
  ],
  controllers: [AuthController],
  providers: [configProvider, AuthStore, AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule implements OnModuleInit {
  constructor(private readonly auth: AuthService) {}

  onModuleInit(): void {
    this.auth.cleanup();
  }
}
