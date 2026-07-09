import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const requestLimit = process.env.ORCHESTRATOR_REQUEST_LIMIT ?? '25mb';
  app.use(json({ limit: requestLimit }));
  app.use(urlencoded({ extended: true, limit: requestLimit }));
  app.enableCors({
    origin: true,
    credentials: true,
  });
  const server = await app.listen(process.env.PORT ?? 3000);
  const serverTimeoutMs = Number(
    process.env.ORCHESTRATOR_SERVER_TIMEOUT_MS ?? 1860000,
  );
  server.setTimeout(serverTimeoutMs);
  server.requestTimeout = serverTimeoutMs;
  server.headersTimeout = serverTimeoutMs + 5000;
}
bootstrap();
