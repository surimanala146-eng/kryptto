import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig } from './config/configuration';
import { CONFIG } from './config/configuration';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { RealtimeService } from './realtime/realtime.service';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('kryptto');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get<AppConfig>(CONFIG as never);

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  const adapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new GlobalExceptionFilter(adapterHost));

  // Built-in terminal preview (proves the API + WS contract end-to-end).
  if (config.servePreview) {
    const previewDir = join(__dirname, '..', 'public');
    if (existsSync(previewDir)) {
      app.useStaticAssets(previewDir, { prefix: '/' });
    }
  }

  // OpenAPI spec + Swagger UI at /api/docs.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('kryptto API')
    .setDescription(
      'Market data + paper trading backend for a TradingView-class terminal frontend. ' +
        'Auth with `POST /api/auth/demo` for instant access; open the WebSocket at /ws ' +
        'and subscribe to channels like `ticks`, `candles:BTCUSDT:1m`, `orderbook:BTCUSDT`, `account`.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.init();

  // Own the HTTP server so the realtime hub can handle /ws upgrades.
  const httpServer = createServer(app.getHttpAdapter().getInstance());
  app.get(RealtimeService).attach(httpServer);

  httpServer.listen(config.port, config.host, () => {
    logger.log(`kryptto API listening on http://${config.host}:${config.port}`);
    logger.log(`  REST      → http://${config.host}:${config.port}/api`);
    logger.log(`  Swagger   → http://${config.host}:${config.port}/api/docs`);
    logger.log(`  WebSocket → ws://${config.host}:${config.port}/ws`);
    if (config.servePreview) {
      logger.log(`  Preview   → http://${config.host}:${config.port}/`);
    }
  });

  const shutdown = (signal: string) => {
    logger.log(`${signal} received — shutting down`);
    httpServer.close(() => {
      void app.close();
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap();
