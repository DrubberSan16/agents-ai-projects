"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const express_1 = require("express");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { bodyParser: false });
    const requestLimit = process.env.ORCHESTRATOR_REQUEST_LIMIT ?? '25mb';
    app.use((0, express_1.json)({ limit: requestLimit }));
    app.use((0, express_1.urlencoded)({ extended: true, limit: requestLimit }));
    app.enableCors({
        origin: true,
        credentials: true,
    });
    const server = await app.listen(process.env.PORT ?? 3000);
    const serverTimeoutMs = Number(process.env.ORCHESTRATOR_SERVER_TIMEOUT_MS ?? 1860000);
    server.setTimeout(serverTimeoutMs);
    server.requestTimeout = serverTimeoutMs;
    server.headersTimeout = serverTimeoutMs + 5000;
}
bootstrap();
//# sourceMappingURL=main.js.map