import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({ origin: corsOrigins });

  const rawPort = config.get<string>('PORT');
  const parsed = rawPort ? Number.parseInt(rawPort, 10) : 3000;
  const port = Number.isNaN(parsed) ? 3000 : parsed;
  await app.listen(port);
}
bootstrap();
