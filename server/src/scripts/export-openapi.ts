/**
 * Dumps the OpenAPI document to <repo>/openapi.json without starting a
 * listener. Run: npm run openapi
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../app.module';

async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('kryptto API')
    .setDescription(
      'Market data + paper trading backend for a TradingView-class terminal frontend. ' +
        'Auth with `POST /api/auth/demo` for instant access; open the WebSocket at /ws ' +
        'and subscribe to channels like `ticks`, `candles:BTCUSDT:1m`, `orderbook:BTCUSDT`, `account`.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const target = resolve(__dirname, '..', '..', '..', 'openapi.json');
  writeFileSync(target, JSON.stringify(document, null, 2));
  process.stdout.write(`openapi.json written to ${target}\n`);
  await app.close();
}

void exportOpenApi();
