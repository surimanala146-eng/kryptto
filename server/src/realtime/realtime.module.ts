import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CONFIG } from '../config/configuration';
import { configProvider } from '../config/config.module';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: (config: unknown) => ({
        secret: (config as { jwt: { accessSecret: string } }).jwt.accessSecret,
      }),
      inject: [CONFIG],
    }),
  ],
  providers: [RealtimeService, configProvider],
  exports: [RealtimeService],
})
export class RealtimeModule {}
