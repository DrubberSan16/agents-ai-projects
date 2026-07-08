"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const agents_service_1 = require("./agents.service");
const ai_orchestrator_service_1 = require("./ai-orchestrator.service");
const app_controller_1 = require("./app.controller");
const app_service_1 = require("./app.service");
const deployment_service_1 = require("./deployment.service");
const orchestrator_controller_1 = require("./orchestrator.controller");
const project_store_service_1 = require("./project-store.service");
const scaffold_service_1 = require("./scaffold.service");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                envFilePath: ['.env', 'apps/api/.env'],
                isGlobal: true,
            }),
        ],
        controllers: [app_controller_1.AppController, orchestrator_controller_1.OrchestratorController],
        providers: [
            agents_service_1.AgentsService,
            ai_orchestrator_service_1.AiOrchestratorService,
            app_service_1.AppService,
            deployment_service_1.DeploymentService,
            project_store_service_1.ProjectStoreService,
            scaffold_service_1.ScaffoldService,
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map