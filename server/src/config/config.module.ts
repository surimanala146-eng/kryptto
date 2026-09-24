import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './configuration';

export const configProvider = {
  provide: CONFIG,
  useFactory: (): ReturnType<typeof loadConfig> => loadConfig(),
};

@Global()
@Module({
  providers: [configProvider],
  exports: [configProvider],
})
export class AppConfigModule {}
