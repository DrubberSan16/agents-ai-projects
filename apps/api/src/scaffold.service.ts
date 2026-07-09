import { Injectable } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ProjectRecord,
  ProjectTarget,
} from './orchestrator.types';

interface ScaffoldResult {
  summary: string;
  files: string[];
  commands: string[];
}

interface BusinessContext {
  title: string;
  description: string;
  rules: string[];
  entities: string[];
  featureModules: ApplicationFeatureModule[];
  primaryEntity: string;
  primaryEntitySlug: string;
  primaryEntityClass: string;
}

interface ApplicationFeatureModule {
  name: string;
  slug: string;
  className: string;
  description: string;
  rules: string[];
}

@Injectable()
export class ScaffoldService {
  applyDevelopmentRequest(
    project: ProjectRecord,
    targetType: ProjectTarget,
    prompt: string,
    rules: string,
    ticketId: string,
  ): ScaffoldResult {
    if (project.mode === 'existing' && !this.isEffectivelyEmpty(project.projectPath)) {
      return this.createExistingProjectBrief(project, prompt, rules, ticketId);
    }

    if (targetType === 'executable') {
      return this.createJavaExecutable(project, prompt, rules);
    }

    return this.createWebWorkspace(project, prompt, rules);
  }

  private createExistingProjectBrief(
    project: ProjectRecord,
    prompt: string,
    rules: string,
    ticketId: string,
  ): ScaffoldResult {
    const context = this.buildBusinessContext(project, prompt, rules);
    const files: string[] = [];
    const requestDir = join(project.projectPath, '.agents-ai', 'change-requests');
    const implementationDir = join(
      project.projectPath,
      '.agents-ai',
      'generated-implementation',
      ticketId,
    );
    this.ensureDirectory(requestDir);
    const filePath = join(requestDir, `${ticketId}.md`);
    const content = `# Solicitud de cambio

Proyecto: ${project.name}

Ticket: ${ticketId}

## Pedido del usuario

${prompt || 'Sin prompt adicional.'}

## Contexto de negocio vigente

${rules || 'No hay reglas de negocio levantadas todavia.'}

## Criterios de ejecucion sugeridos

- Confirmar archivos a modificar antes de tocar codigo productivo.
- Mantener cambios pequenos y verificables.
- Actualizar pruebas o agregar casos minimos cuando cambie comportamiento.
- Registrar decisiones abiertas como notificaciones para aprobacion del usuario.
`;
    writeFileSync(filePath, content, 'utf8');
    files.push(filePath);

    files.push(
      this.writeGenerated(
        join(implementationDir, 'architecture.md'),
        this.renderArchitectureDoc(project, project.targetType, context),
      ),
    );

    files.push(
      this.writeGenerated(
        join(implementationDir, 'api/business.types.ts'),
        `export interface GeneratedBusinessRule {
  id: string;
  description: string;
  required: boolean;
}

export interface GeneratedBusinessRecord {
  id: string;
  title: string;
  description: string;
  status: 'Pendiente' | 'En progreso' | 'Completado' | 'Bloqueado';
  priority: 'Baja' | 'Media' | 'Alta' | 'Critica';
  createdAt: string;
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(implementationDir, 'api/business.service.ts'),
        `import type { GeneratedBusinessRecord, GeneratedBusinessRule } from './business.types';

export class GeneratedBusinessService {
  private readonly rules: GeneratedBusinessRule[] = ${JSON.stringify(
    context.rules.map((rule, index) => ({
      id: `rule-${index + 1}`,
      description: rule,
      required: true,
    })),
    null,
    2,
  )};

  private readonly records: GeneratedBusinessRecord[] = [];

  getSummary() {
    return {
      domain: '${this.escapeTsString(context.primaryEntity)}',
      description: '${this.escapeTsString(context.description)}',
      rules: this.rules,
      totalRecords: this.records.length,
    };
  }

  createRecord(input: Partial<GeneratedBusinessRecord>) {
    const record: GeneratedBusinessRecord = {
      id: \`record-\${this.records.length + 1}\`,
      title: input.title ?? 'Nuevo ${this.escapeTsString(context.primaryEntity)}',
      description: input.description ?? 'Creado desde implementacion generada.',
      status: input.status ?? 'Pendiente',
      priority: input.priority ?? 'Media',
      createdAt: new Date().toISOString(),
    };
    this.records.unshift(record);
    return record;
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(implementationDir, 'api/application-modules.service.ts'),
        `export const generatedApplicationModules = ${JSON.stringify(
          context.featureModules.map((module) => ({
            name: module.name,
            slug: module.slug,
            description: module.description,
            rules: module.rules,
          })),
          null,
          2,
        )};

export class GeneratedApplicationModulesService {
  private readonly records = generatedApplicationModules.map((module, index) => ({
    id: \`\${module.slug}-record-\${index + 1}\`,
    moduleSlug: module.slug,
    title: \`\${module.name} inicial\`,
    description: module.description,
    status: 'Pendiente',
    priority: 'Media',
    owner: 'admin',
    createdAt: new Date().toISOString(),
  }));

  listModules() {
    return generatedApplicationModules;
  }

  listRecords(moduleSlug: string) {
    return this.records.filter((record) => record.moduleSlug === moduleSlug);
  }

  createRecord(moduleSlug: string, input: Partial<(typeof this.records)[number]>) {
    const module = generatedApplicationModules.find((item) => item.slug === moduleSlug);
    if (!module) {
      return undefined;
    }
    const record = {
      id: \`\${module.slug}-record-\${this.records.length + 1}\`,
      moduleSlug: module.slug,
      title: input.title ?? \`Nuevo \${module.name}\`,
      description: input.description ?? module.description,
      status: input.status ?? 'Pendiente',
      priority: input.priority ?? 'Media',
      owner: input.owner ?? 'admin',
      createdAt: new Date().toISOString(),
    };
    this.records.unshift(record);
    return record;
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(implementationDir, 'web/BusinessPanel.vue'),
        `<script setup lang="ts">
const rules = ${JSON.stringify(context.rules, null, 2)};
</script>

<template>
  <section class="generated-business-panel">
    <p>${context.primaryEntity}</p>
    <h2>${context.description}</h2>
    <ul>
      <li v-for="rule in rules" :key="rule">{{ rule }}</li>
    </ul>
  </section>
</template>
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(implementationDir, 'README.md'),
        `# Paquete de implementacion generado

Este paquete contiene archivos listos para adaptar al proyecto existente sin sobrescribir codigo productivo.

## Dominio

${context.primaryEntity}

## Modulos solicitados detectados

${context.featureModules.map((module) => `- ${module.name}: ${module.description}`).join('\n')}

## Como integrarlo

1. Revisa architecture.md.
2. Copia los archivos de api/ al modulo backend equivalente, incluyendo application-modules.service.ts.
3. Registra el servicio/controlador en el modulo correspondiente.
4. Copia web/BusinessPanel.vue en la carpeta de componentes o vistas.
5. Ajusta nombres/rutas al framework real del proyecto.
6. Ejecuta pruebas antes de mezclarlo con codigo productivo.
`,
      ),
    );

    return {
      summary:
        `Se genero un brief y un paquete de implementacion para ${context.primaryEntity} sin sobrescribir archivos existentes.`,
      files,
      commands: [],
    };
  }

  private createWebWorkspace(
    project: ProjectRecord,
    prompt: string,
    rules: string,
  ): ScaffoldResult {
    const files: string[] = [];
    const context = this.buildBusinessContext(project, prompt, rules);
    const rootPackage = {
      name: project.slug,
      private: true,
      version: '0.1.0',
      workspaces: ['apps/*'],
      scripts: {
        dev: 'concurrently "npm run start:dev -w apps/api" "npm run dev -w apps/web -- --host 127.0.0.1"',
        build: 'npm run build -w apps/api && npm run build -w apps/web',
        'start:api': 'npm run start:dev -w apps/api',
        'start:web': 'npm run dev -w apps/web',
      },
      devDependencies: {
        concurrently: 'latest',
      },
    };

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'package.json'),
        `${JSON.stringify(rootPackage, null, 2)}\n`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'README.md'),
        `# ${project.name}

Proyecto web generado por el orquestador de agentes IA.

## Objetivo

${context.description}

## Modulos generados

- Modulos solicitados por el usuario: ${context.featureModules.map((module) => module.name).join(', ')}.
- Autenticacion inicial con usuario administrador configurable por ambiente.
- API de negocio para ${context.primaryEntity} con CRUD, filtros, estados, validaciones y exportacion CSV.
- Mantenedores para estados, prioridades, categorias y roles.
- Reporteria operacional con dashboard, cumplimiento de reglas y descarga CSV.
- Seguridad inicial con usuarios, roles y politica de contrasenas.
- Interfaz Vue para login, operacion, mantenedores, reporteria y seguridad.
- Documentacion tecnica con diagramas Mermaid en docs/architecture.md.

## Reglas consideradas

${context.rules.map((rule) => `- ${rule}`).join('\n')}

## Modulos de aplicacion detectados

${context.featureModules.map((module) => `- ${module.name}: ${module.description}`).join('\n')}

## Comandos

\`\`\`bash
npm install
npm run dev
\`\`\`
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'docs/architecture.md'),
        this.renderArchitectureDoc(project, 'web', context),
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'apps/api/package.json'),
        `${JSON.stringify(
          {
            name: 'api',
            version: '0.1.0',
            private: true,
            scripts: {
              build: 'nest build',
              start: 'nest start',
              'start:dev': 'nest start --watch',
              'start:prod': 'node dist/main',
            },
            dependencies: {
              '@nestjs/common': '^11.0.1',
              '@nestjs/core': '^11.0.1',
              '@nestjs/platform-express': '^11.0.1',
              'reflect-metadata': '^0.2.2',
              rxjs: '^7.8.1',
            },
            devDependencies: {
              '@nestjs/cli': '^11.0.0',
              '@types/node': '^24.0.0',
              typescript: '^5.7.3',
            },
          },
          null,
          2,
        )}\n`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'apps/api/tsconfig.json'),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: 'commonjs',
              declaration: true,
              removeComments: true,
              emitDecoratorMetadata: true,
              experimentalDecorators: true,
              allowSyntheticDefaultImports: true,
              target: 'ES2021',
              sourceMap: true,
              outDir: './dist',
              baseUrl: './',
              incremental: true,
              skipLibCheck: true,
            },
          },
          null,
          2,
        )}\n`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/main.ts'),
        `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(\`API lista en http://localhost:\${port}\`);
}

void bootstrap();
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/app.module.ts'),
        `import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { ApplicationModulesController } from './application-modules.controller';
import { ApplicationModulesService } from './application-modules.service';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';
import { MaintainersController } from './maintainers.controller';
import { MaintainersService } from './maintainers.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

@Module({
  controllers: [
    AuthController,
    ApplicationModulesController,
    BusinessController,
    MaintainersController,
    ReportsController,
    SecurityController,
  ],
  providers: [
    ApplicationModulesService,
    BusinessService,
    MaintainersService,
    ReportsService,
    SecurityService,
  ],
})
export class AppModule {}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/auth.controller.ts'),
        `import { Body, Controller, Get, Post } from '@nestjs/common';

const defaultUser = {
  username: process.env.DEFAULT_ADMIN_USER ?? 'admin',
  password: process.env.DEFAULT_ADMIN_PASSWORD ?? 'Admin123!',
  displayName: 'Administrador',
};

@Controller('api')
export class AuthController {
  @Get('health')
  health() {
    return { status: 'ok', service: '${project.slug}' };
  }

  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    const valid =
      body.username === defaultUser.username && body.password === defaultUser.password;
    return {
      authenticated: valid,
      user: valid
        ? { username: defaultUser.username, displayName: defaultUser.displayName }
        : null,
    };
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/application-modules.types.ts'),
        `export interface ApplicationModuleDefinition {
  name: string;
  slug: string;
  description: string;
  rules: string[];
}

export interface ApplicationModuleRecord {
  id: string;
  moduleSlug: string;
  title: string;
  description: string;
  status: 'Pendiente' | 'En progreso' | 'Completado' | 'Bloqueado';
  priority: 'Baja' | 'Media' | 'Alta' | 'Critica';
  owner: string;
  data: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApplicationModuleRecordDto {
  title?: string;
  description?: string;
  priority?: ApplicationModuleRecord['priority'];
  owner?: string;
  data?: Record<string, string | number | boolean>;
}

export interface UpdateApplicationModuleRecordDto
  extends Partial<CreateApplicationModuleRecordDto> {
  status?: ApplicationModuleRecord['status'];
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/application-modules.service.ts'),
        `import { Injectable } from '@nestjs/common';
import type {
  ApplicationModuleDefinition,
  ApplicationModuleRecord,
  CreateApplicationModuleRecordDto,
  UpdateApplicationModuleRecordDto,
} from './application-modules.types';

@Injectable()
export class ApplicationModulesService {
  private readonly modules: ApplicationModuleDefinition[] = ${JSON.stringify(
    context.featureModules.map((module) => ({
      name: module.name,
      slug: module.slug,
      description: module.description,
      rules: module.rules,
    })),
    null,
    2,
  )};

  private records: ApplicationModuleRecord[] = this.modules.map((module, index) => ({
    id: \`\${module.slug}-record-\${index + 1}\`,
    moduleSlug: module.slug,
    title: \`\${module.name} inicial\`,
    description: module.description,
    status: 'Pendiente',
    priority: 'Media',
    owner: 'admin',
    data: {
      source: 'analisis-previo',
      rulesApplied: module.rules.length,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  listModules() {
    return this.modules.map((module) => ({
      ...module,
      totalRecords: this.records.filter((record) => record.moduleSlug === module.slug).length,
    }));
  }

  getModule(moduleSlug: string) {
    return this.modules.find((module) => module.slug === moduleSlug);
  }

  listRecords(moduleSlug: string) {
    return this.records.filter((record) => record.moduleSlug === moduleSlug);
  }

  getRecord(moduleSlug: string, id: string) {
    return this.records.find((record) => record.moduleSlug === moduleSlug && record.id === id);
  }

  createRecord(moduleSlug: string, input: CreateApplicationModuleRecordDto) {
    const module = this.getModule(moduleSlug) ?? this.modules[0];
    const now = new Date().toISOString();
    const record: ApplicationModuleRecord = {
      id: \`\${module.slug}-record-\${this.records.length + 1}\`,
      moduleSlug: module.slug,
      title: input.title?.trim() || \`Nuevo \${module.name}\`,
      description: input.description?.trim() || module.description,
      priority: input.priority ?? 'Media',
      status: 'Pendiente',
      owner: input.owner?.trim() || 'admin',
      data: input.data ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.records.unshift(record);
    return record;
  }

  updateRecord(moduleSlug: string, id: string, input: UpdateApplicationModuleRecordDto) {
    const record = this.getRecord(moduleSlug, id);
    if (!record) {
      return undefined;
    }
    record.title = input.title?.trim() || record.title;
    record.description = input.description?.trim() || record.description;
    record.priority = input.priority ?? record.priority;
    record.status = input.status ?? record.status;
    record.owner = input.owner?.trim() || record.owner;
    record.data = input.data ?? record.data;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  deleteRecord(moduleSlug: string, id: string) {
    const index = this.records.findIndex(
      (record) => record.moduleSlug === moduleSlug && record.id === id,
    );
    if (index < 0) {
      return false;
    }
    this.records.splice(index, 1);
    return true;
  }

  dashboard() {
    return this.modules.map((module) => {
      const records = this.listRecords(module.slug);
      return {
        module: module.name,
        slug: module.slug,
        total: records.length,
        pending: records.filter((record) => record.status !== 'Completado').length,
        completed: records.filter((record) => record.status === 'Completado').length,
      };
    });
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/application-modules.controller.ts'),
        `import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApplicationModulesService } from './application-modules.service';
import type {
  CreateApplicationModuleRecordDto,
  UpdateApplicationModuleRecordDto,
} from './application-modules.types';

@Controller('api/application-modules')
export class ApplicationModulesController {
  constructor(private readonly modules: ApplicationModulesService) {}

  @Get()
  listModules() {
    return this.modules.listModules();
  }

  @Get('dashboard')
  dashboard() {
    return this.modules.dashboard();
  }

  @Get(':moduleSlug')
  detail(@Param('moduleSlug') moduleSlug: string) {
    return this.modules.getModule(moduleSlug);
  }

  @Get(':moduleSlug/records')
  listRecords(@Param('moduleSlug') moduleSlug: string) {
    return this.modules.listRecords(moduleSlug);
  }

  @Post(':moduleSlug/records')
  createRecord(
    @Param('moduleSlug') moduleSlug: string,
    @Body() body: CreateApplicationModuleRecordDto,
  ) {
    return this.modules.createRecord(moduleSlug, body);
  }

  @Put(':moduleSlug/records/:id')
  updateRecord(
    @Param('moduleSlug') moduleSlug: string,
    @Param('id') id: string,
    @Body() body: UpdateApplicationModuleRecordDto,
  ) {
    return this.modules.updateRecord(moduleSlug, id, body);
  }

  @Delete(':moduleSlug/records/:id')
  deleteRecord(
    @Param('moduleSlug') moduleSlug: string,
    @Param('id') id: string,
  ) {
    return { deleted: this.modules.deleteRecord(moduleSlug, id) };
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/business.types.ts'),
        `export type RecordStatus = 'Pendiente' | 'En progreso' | 'Completado' | 'Bloqueado';
export type RecordPriority = 'Baja' | 'Media' | 'Alta' | 'Critica';

export interface BusinessRule {
  id: string;
  description: string;
  required: boolean;
  category: 'negocio' | 'seguridad' | 'operacion' | 'calidad';
  severity: 'info' | 'warning' | 'critical';
}

export interface RuleValidation {
  ruleId: string;
  passed: boolean;
  message: string;
}

export interface ${context.primaryEntityClass} {
  id: string;
  title: string;
  description: string;
  status: RecordStatus;
  priority: RecordPriority;
  category: string;
  owner: string;
  tags: string[];
  validations: RuleValidation[];
  createdAt: string;
  updatedAt: string;
}

export interface Create${context.primaryEntityClass}Dto {
  title?: string;
  description?: string;
  priority?: RecordPriority;
  category?: string;
  owner?: string;
  tags?: string[];
}

export interface Update${context.primaryEntityClass}Dto extends Partial<Create${context.primaryEntityClass}Dto> {
  status?: RecordStatus;
}

export interface ${context.primaryEntityClass}Query {
  status?: RecordStatus;
  priority?: RecordPriority;
  owner?: string;
  search?: string;
}

export interface BusinessDashboard {
  totalRecords: number;
  completedRecords: number;
  pendingRecords: number;
  blockedRecords: number;
  byStatus: Record<RecordStatus, number>;
  byPriority: Record<RecordPriority, number>;
  rulesCompliance: number;
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/business.service.ts'),
        `import { Injectable } from '@nestjs/common';
import type {
  BusinessDashboard,
  BusinessRule,
  Create${context.primaryEntityClass}Dto,
  ${context.primaryEntityClass},
  ${context.primaryEntityClass}Query,
  RecordPriority,
  RecordStatus,
  RuleValidation,
  Update${context.primaryEntityClass}Dto,
} from './business.types';

@Injectable()
export class BusinessService {
  private readonly rules: BusinessRule[] = ${JSON.stringify(
    context.rules.map((rule, index) => ({
      id: `rule-${index + 1}`,
      description: rule,
      required: true,
      category: index % 3 === 0 ? 'negocio' : index % 3 === 1 ? 'operacion' : 'calidad',
      severity: index === 0 ? 'critical' : 'warning',
    })),
    null,
    2,
  )};

  private records: ${context.primaryEntityClass}[] = [
    {
      id: 'record-1',
      title: '${this.escapeTsString(context.primaryEntity)} inicial',
      description: '${this.escapeTsString(context.description)}',
      status: 'Pendiente',
      priority: 'Media',
      category: 'General',
      owner: 'admin',
      tags: ['inicial'],
      validations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  constructor() {
    this.records = this.records.map((record) => ({
      ...record,
      validations: this.validateRules(record),
    }));
  }

  getSummary() {
    return {
      project: '${this.escapeTsString(project.name)}',
      domain: '${this.escapeTsString(context.primaryEntity)}',
      description: '${this.escapeTsString(context.description)}',
      entities: ${JSON.stringify(context.entities)},
      rules: this.rules,
      metrics: this.getDashboard(),
    };
  }

  listRecords(query: ${context.primaryEntityClass}Query = {}) {
    return this.records.filter((record) => {
      const matchesStatus = !query.status || record.status === query.status;
      const matchesPriority = !query.priority || record.priority === query.priority;
      const matchesOwner = !query.owner || record.owner.toLowerCase().includes(query.owner.toLowerCase());
      const search = query.search?.toLowerCase();
      const matchesSearch =
        !search ||
        record.title.toLowerCase().includes(search) ||
        record.description.toLowerCase().includes(search) ||
        record.category.toLowerCase().includes(search) ||
        record.tags.some((tag) => tag.toLowerCase().includes(search));
      return matchesStatus && matchesPriority && matchesOwner && matchesSearch;
    });
  }

  getRecord(id: string) {
    return this.records.find((record) => record.id === id);
  }

  createRecord(input: Create${context.primaryEntityClass}Dto) {
    const now = new Date().toISOString();
    const record: ${context.primaryEntityClass} = {
      id: \`record-\${this.records.length + 1}\`,
      title: input.title?.trim() || 'Nuevo ${this.escapeTsString(context.primaryEntity)}',
      description: input.description?.trim() || 'Creado desde la interfaz operativa.',
      priority: input.priority ?? 'Media',
      status: 'Pendiente',
      category: input.category?.trim() || 'General',
      owner: input.owner?.trim() || 'admin',
      tags: input.tags?.length ? input.tags : ['operacion'],
      validations: [],
      createdAt: now,
      updatedAt: now,
    };
    record.validations = this.validateRules(record);
    this.records.unshift(record);
    return record;
  }

  updateRecord(id: string, input: Update${context.primaryEntityClass}Dto) {
    const record = this.records.find((item) => item.id === id);
    if (!record) {
      return undefined;
    }
    record.title = input.title?.trim() || record.title;
    record.description = input.description?.trim() || record.description;
    record.priority = input.priority ?? record.priority;
    record.status = input.status ?? record.status;
    record.category = input.category?.trim() || record.category;
    record.owner = input.owner?.trim() || record.owner;
    record.tags = input.tags?.length ? input.tags : record.tags;
    record.validations = this.validateRules(record);
    record.updatedAt = new Date().toISOString();
    return record;
  }

  updateStatus(id: string, status: RecordStatus) {
    return this.updateRecord(id, { status });
  }

  deleteRecord(id: string) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) {
      return false;
    }
    this.records.splice(index, 1);
    return true;
  }

  getDashboard(): BusinessDashboard {
    const byStatus = this.countBy<RecordStatus>(['Pendiente', 'En progreso', 'Completado', 'Bloqueado'], 'status');
    const byPriority = this.countBy<RecordPriority>(['Baja', 'Media', 'Alta', 'Critica'], 'priority');
    const validations = this.records.flatMap((record) => record.validations);
    const passed = validations.filter((validation) => validation.passed).length;
    return {
      totalRecords: this.records.length,
      completedRecords: byStatus.Completado,
      pendingRecords: byStatus.Pendiente + byStatus['En progreso'],
      blockedRecords: byStatus.Bloqueado,
      byStatus,
      byPriority,
      rulesCompliance: validations.length ? Math.round((passed / validations.length) * 100) : 100,
    };
  }

  exportCsv() {
    const header = 'id,title,status,priority,category,owner,createdAt';
    const rows = this.records.map((record) =>
      [
        record.id,
        record.title,
        record.status,
        record.priority,
        record.category,
        record.owner,
        record.createdAt,
      ]
        .map((value) => \`"\${String(value).replace(/"/g, '""')}"\`)
        .join(','),
    );
    return [header, ...rows].join('\\n');
  }

  private validateRules(record: ${context.primaryEntityClass}): RuleValidation[] {
    return this.rules.map((rule) => {
      const hasCoreData = Boolean(record.title.trim() && record.description.trim());
      const highRiskRequiresOwner = record.priority !== 'Critica' || Boolean(record.owner.trim());
      const passed = rule.severity === 'critical' ? hasCoreData && highRiskRequiresOwner : hasCoreData;
      return {
        ruleId: rule.id,
        passed,
        message: passed
          ? \`Cumple: \${rule.description}\`
          : \`Revisar regla: \${rule.description}\`,
      };
    });
  }

  private countBy<T extends string>(keys: T[], field: 'status' | 'priority'): Record<T, number> {
    return keys.reduce(
      (accumulator, key) => ({
        ...accumulator,
        [key]: this.records.filter((record) => record[field] === key).length,
      }),
      {} as Record<T, number>,
    );
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/business.controller.ts'),
        `import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { BusinessService } from './business.service';
import type {
  Create${context.primaryEntityClass}Dto,
  ${context.primaryEntityClass}Query,
  RecordStatus,
  Update${context.primaryEntityClass}Dto,
} from './business.types';

@Controller('api/business')
export class BusinessController {
  constructor(private readonly business: BusinessService) {}

  @Get('summary')
  summary() {
    return this.business.getSummary();
  }

  @Get('${context.primaryEntitySlug}')
  list(@Query() query: ${context.primaryEntityClass}Query) {
    return this.business.listRecords(query);
  }

  @Get('${context.primaryEntitySlug}/report')
  report() {
    return this.business.getDashboard();
  }

  @Get('${context.primaryEntitySlug}/export.csv')
  @Header('Content-Type', 'text/csv')
  exportCsv() {
    return this.business.exportCsv();
  }

  @Get('${context.primaryEntitySlug}/:id')
  detail(@Param('id') id: string) {
    return this.business.getRecord(id);
  }

  @Post('${context.primaryEntitySlug}')
  create(@Body() body: Create${context.primaryEntityClass}Dto) {
    return this.business.createRecord(body);
  }

  @Put('${context.primaryEntitySlug}/:id')
  update(
    @Param('id') id: string,
    @Body() body: Update${context.primaryEntityClass}Dto,
  ) {
    return this.business.updateRecord(id, body);
  }

  @Patch('${context.primaryEntitySlug}/:id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status?: RecordStatus },
  ) {
    return this.business.updateStatus(id, body.status ?? 'En progreso');
  }

  @Delete('${context.primaryEntitySlug}/:id')
  remove(@Param('id') id: string) {
    return { deleted: this.business.deleteRecord(id) };
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/maintainers.service.ts'),
        `import { Injectable } from '@nestjs/common';

export interface MaintainerItem {
  id: string;
  type: 'estado' | 'prioridad' | 'categoria' | 'rol';
  label: string;
  active: boolean;
}

@Injectable()
export class MaintainersService {
  private readonly items: MaintainerItem[] = [
    { id: 'status-pending', type: 'estado', label: 'Pendiente', active: true },
    { id: 'status-progress', type: 'estado', label: 'En progreso', active: true },
    { id: 'status-done', type: 'estado', label: 'Completado', active: true },
    { id: 'priority-low', type: 'prioridad', label: 'Baja', active: true },
    { id: 'priority-medium', type: 'prioridad', label: 'Media', active: true },
    { id: 'priority-high', type: 'prioridad', label: 'Alta', active: true },
    { id: 'category-general', type: 'categoria', label: 'General', active: true },
    { id: 'role-admin', type: 'rol', label: 'Administrador', active: true },
  ];

  list(type?: MaintainerItem['type']) {
    return type ? this.items.filter((item) => item.type === type) : this.items;
  }

  create(input: Partial<MaintainerItem>) {
    const item: MaintainerItem = {
      id: input.id || \`\${input.type ?? 'categoria'}-\${this.items.length + 1}\`,
      type: input.type ?? 'categoria',
      label: input.label?.trim() || 'Nuevo mantenedor',
      active: input.active ?? true,
    };
    this.items.push(item);
    return item;
  }

  update(id: string, input: Partial<MaintainerItem>) {
    const item = this.items.find((current) => current.id === id);
    if (!item) {
      return undefined;
    }
    item.label = input.label?.trim() || item.label;
    item.active = input.active ?? item.active;
    return item;
  }

  remove(id: string) {
    const item = this.items.find((current) => current.id === id);
    if (!item) {
      return false;
    }
    item.active = false;
    return true;
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/maintainers.controller.ts'),
        `import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { MaintainersService } from './maintainers.service';

@Controller('api/maintainers')
export class MaintainersController {
  constructor(private readonly maintainers: MaintainersService) {}

  @Get()
  list(@Query('type') type?: 'estado' | 'prioridad' | 'categoria' | 'rol') {
    return this.maintainers.list(type);
  }

  @Post()
  create(@Body() body: Parameters<MaintainersService['create']>[0]) {
    return this.maintainers.create(body);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: Parameters<MaintainersService['update']>[1],
  ) {
    return this.maintainers.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { deleted: this.maintainers.remove(id) };
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/reports.service.ts'),
        `import { Injectable } from '@nestjs/common';
import { BusinessService } from './business.service';
import { MaintainersService } from './maintainers.service';

@Injectable()
export class ReportsService {
  constructor(
    private readonly business: BusinessService,
    private readonly maintainers: MaintainersService,
  ) {}

  operational() {
    return {
      generatedAt: new Date().toISOString(),
      dashboard: this.business.getDashboard(),
      activeMaintainers: this.maintainers.list().filter((item) => item.active).length,
      recommendations: [
        'Revisar registros bloqueados diariamente.',
        'Auditar reglas criticas antes de cerrar registros.',
        'Mantener catalogos activos alineados con operacion real.',
      ],
    };
  }

  csv() {
    return this.business.exportCsv();
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/reports.controller.ts'),
        `import { Controller, Get, Header } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('api/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('operational')
  operational() {
    return this.reports.operational();
  }

  @Get('records.csv')
  @Header('Content-Type', 'text/csv')
  csv() {
    return this.reports.csv();
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/security.service.ts'),
        `import { Injectable } from '@nestjs/common';

export interface UserAccount {
  id: string;
  username: string;
  displayName: string;
  role: 'Administrador' | 'Operador' | 'Auditor';
  active: boolean;
}

@Injectable()
export class SecurityService {
  private readonly users: UserAccount[] = [
    {
      id: 'user-admin',
      username: process.env.DEFAULT_ADMIN_USER ?? 'admin',
      displayName: 'Administrador',
      role: 'Administrador',
      active: true,
    },
  ];

  listUsers() {
    return this.users;
  }

  createUser(input: Partial<UserAccount>) {
    const user: UserAccount = {
      id: \`user-\${this.users.length + 1}\`,
      username: input.username?.trim() || \`user\${this.users.length + 1}\`,
      displayName: input.displayName?.trim() || 'Usuario operativo',
      role: input.role ?? 'Operador',
      active: input.active ?? true,
    };
    this.users.push(user);
    return user;
  }

  getPolicy() {
    return {
      passwordMinLength: 8,
      requireRotation: true,
      roles: ['Administrador', 'Operador', 'Auditor'],
      notes: [
        'Cambiar la contrasena inicial despues del primer acceso.',
        'Asignar permisos por rol antes de exponer el sistema.',
        'No guardar secretos en el repositorio.',
      ],
    };
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/api/src/security.controller.ts'),
        `import { Body, Controller, Get, Post } from '@nestjs/common';
import { SecurityService } from './security.service';

@Controller('api/security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('users')
  users() {
    return this.security.listUsers();
  }

  @Post('users')
  createUser(@Body() body: Parameters<SecurityService['createUser']>[0]) {
    return this.security.createUser(body);
  }

  @Get('policy')
  policy() {
    return this.security.getPolicy();
  }
}
`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'apps/web/package.json'),
        `${JSON.stringify(
          {
            name: 'web',
            version: '0.1.0',
            private: true,
            type: 'module',
            scripts: {
              dev: 'vite',
              build: 'vue-tsc -b && vite build',
              preview: 'vite preview',
            },
            dependencies: {
              vue: '^3.5.39',
            },
            devDependencies: {
              '@vitejs/plugin-vue': '^6.0.7',
              typescript: '~6.0.2',
              vite: '^8.1.1',
              'vue-tsc': '^3.3.5',
            },
          },
          null,
          2,
        )}\n`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'apps/web/index.html'),
        `<div id="app"></div><script type="module" src="/src/main.ts"></script>
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/web/vite.config.ts'),
        `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000',
    },
  },
});
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/web/src/main.ts'),
        `import { createApp } from 'vue';
import './style.css';
import App from './App.vue';

createApp(App).mount('#app');
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/web/src/App.vue'),
        `<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';

interface BusinessRule {
  id: string;
  description: string;
  required: boolean;
}

interface BusinessSummary {
  project: string;
  domain: string;
  description: string;
  entities: string[];
  rules: BusinessRule[];
  metrics: {
    totalRecords: number;
    completedRecords: number;
    pendingRecords: number;
    blockedRecords: number;
    rulesCompliance: number;
  };
}

interface BusinessRecord {
  id: string;
  title: string;
  description: string;
  status: 'Pendiente' | 'En progreso' | 'Completado';
  priority: 'Baja' | 'Media' | 'Alta';
  createdAt: string;
}

interface MaintainerItem {
  id: string;
  type: 'estado' | 'prioridad' | 'categoria' | 'rol';
  label: string;
  active: boolean;
}

interface OperationalReport {
  generatedAt: string;
  dashboard: BusinessSummary['metrics'];
  activeMaintainers: number;
  recommendations: string[];
}

interface UserAccount {
  id: string;
  username: string;
  displayName: string;
  role: 'Administrador' | 'Operador' | 'Auditor';
  active: boolean;
}

interface SecurityPolicy {
  passwordMinLength: number;
  requireRotation: boolean;
  roles: string[];
  notes: string[];
}

interface ApplicationModule {
  name: string;
  slug: string;
  description: string;
  rules: string[];
  totalRecords: number;
}

interface ApplicationModuleRecord {
  id: string;
  moduleSlug: string;
  title: string;
  description: string;
  status: 'Pendiente' | 'En progreso' | 'Completado' | 'Bloqueado';
  priority: 'Baja' | 'Media' | 'Alta' | 'Critica';
  owner: string;
}

const username = ref('admin');
const password = ref('Admin123!');
const authenticated = ref(false);
const message = ref('');
const loading = ref(false);
const activeView = ref<'operacion' | 'modulos' | 'mantenedores' | 'reporteria' | 'seguridad'>('operacion');
const summary = ref<BusinessSummary | null>(null);
const records = ref<BusinessRecord[]>([]);
const applicationModules = ref<ApplicationModule[]>([]);
const selectedModuleSlug = ref('');
const moduleRecords = ref<ApplicationModuleRecord[]>([]);
const maintainers = ref<MaintainerItem[]>([]);
const report = ref<OperationalReport | null>(null);
const users = ref<UserAccount[]>([]);
const policy = ref<SecurityPolicy | null>(null);
const form = reactive({
  title: '',
  description: '',
  priority: 'Media' as BusinessRecord['priority'],
});
const maintainerForm = reactive({
  type: 'categoria' as MaintainerItem['type'],
  label: '',
});
const userForm = reactive({
  username: '',
  displayName: '',
  role: 'Operador' as UserAccount['role'],
});
const moduleForm = reactive({
  title: '',
  description: '',
  priority: 'Media' as ApplicationModuleRecord['priority'],
});

onMounted(() => {
  void loadBusiness();
});

async function login() {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.value, password: password.value }),
  });
  const result = await response.json();
  authenticated.value = Boolean(result.authenticated);
  message.value = authenticated.value ? 'Acceso concedido' : 'Credenciales invalidas';
  if (authenticated.value) {
    await loadBusiness();
  }
}

async function loadBusiness() {
  loading.value = true;
  try {
    const [
      summaryResponse,
      recordsResponse,
      maintainersResponse,
      reportResponse,
      usersResponse,
      policyResponse,
      modulesResponse,
    ] = await Promise.all([
      fetch('/api/business/summary'),
      fetch('/api/business/${context.primaryEntitySlug}'),
      fetch('/api/maintainers'),
      fetch('/api/reports/operational'),
      fetch('/api/security/users'),
      fetch('/api/security/policy'),
      fetch('/api/application-modules'),
    ]);
    summary.value = await summaryResponse.json();
    records.value = await recordsResponse.json();
    maintainers.value = await maintainersResponse.json();
    report.value = await reportResponse.json();
    users.value = await usersResponse.json();
    policy.value = await policyResponse.json();
    applicationModules.value = await modulesResponse.json();
    if (!selectedModuleSlug.value && applicationModules.value.length) {
      selectedModuleSlug.value = applicationModules.value[0].slug;
    }
    await loadModuleRecords();
  } finally {
    loading.value = false;
  }
}

async function createRecord() {
  const response = await fetch('/api/business/${context.primaryEntitySlug}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(form),
  });
  const record = await response.json();
  records.value = [record, ...records.value];
  form.title = '';
  form.description = '';
  form.priority = 'Media';
  await loadBusiness();
}

async function moveStatus(record: BusinessRecord, status: BusinessRecord['status']) {
  const response = await fetch(\`/api/business/${context.primaryEntitySlug}/\${record.id}/status\`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const updated = await response.json();
  records.value = records.value.map((item) => (item.id === updated.id ? updated : item));
  await loadBusiness();
}

function handleStatusChange(record: BusinessRecord, event: Event) {
  const target = event.target as HTMLSelectElement;
  void moveStatus(record, target.value as BusinessRecord['status']);
}

async function createMaintainer() {
  const response = await fetch('/api/maintainers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(maintainerForm),
  });
  const item = await response.json();
  maintainers.value = [...maintainers.value, item];
  maintainerForm.label = '';
}

async function createUser() {
  const response = await fetch('/api/security/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userForm),
  });
  const user = await response.json();
  users.value = [...users.value, user];
  userForm.username = '';
  userForm.displayName = '';
}

function downloadReport() {
  window.open('/api/reports/records.csv', '_blank', 'noopener,noreferrer');
}

async function loadModuleRecords() {
  if (!selectedModuleSlug.value) {
    moduleRecords.value = [];
    return;
  }
  const response = await fetch(\`/api/application-modules/\${selectedModuleSlug.value}/records\`);
  moduleRecords.value = await response.json();
}

async function selectApplicationModule(moduleSlug: string) {
  selectedModuleSlug.value = moduleSlug;
  await loadModuleRecords();
}

async function createModuleRecord() {
  if (!selectedModuleSlug.value) {
    return;
  }
  const response = await fetch(\`/api/application-modules/\${selectedModuleSlug.value}/records\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moduleForm),
  });
  const record = await response.json();
  moduleRecords.value = [record, ...moduleRecords.value];
  moduleForm.title = '';
  moduleForm.description = '';
  moduleForm.priority = 'Media';
}
</script>

<template>
  <main class="shell">
    <section v-if="!authenticated" class="login-panel">
      <p class="eyebrow">${project.name}</p>
      <h1>Acceso operativo</h1>
      <form v-if="!authenticated" class="login" @submit.prevent="login">
        <label>
          Usuario
          <input v-model="username" autocomplete="username" />
        </label>
        <label>
          Contrasena
          <input v-model="password" type="password" autocomplete="current-password" />
        </label>
        <button type="submit">Ingresar</button>
      </form>
      <p class="message">{{ message }}</p>
    </section>

    <section v-else class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ summary?.domain ?? '${context.primaryEntity}' }}</p>
          <h1>{{ summary?.project ?? '${project.name}' }}</h1>
        </div>
        <button type="button" @click="loadBusiness">
          {{ loading ? 'Actualizando...' : 'Actualizar' }}
        </button>
      </header>

      <nav class="tabs" aria-label="Modulos principales">
        <button type="button" :class="{ active: activeView === 'operacion' }" @click="activeView = 'operacion'">
          Operacion
        </button>
        <button type="button" :class="{ active: activeView === 'modulos' }" @click="activeView = 'modulos'">
          Modulos
        </button>
        <button type="button" :class="{ active: activeView === 'mantenedores' }" @click="activeView = 'mantenedores'">
          Mantenedores
        </button>
        <button type="button" :class="{ active: activeView === 'reporteria' }" @click="activeView = 'reporteria'">
          Reporteria
        </button>
        <button type="button" :class="{ active: activeView === 'seguridad' }" @click="activeView = 'seguridad'">
          Seguridad
        </button>
      </nav>

      <section v-if="activeView === 'operacion'" class="summary">
        <article>
          <span>Total</span>
          <strong>{{ summary?.metrics.totalRecords ?? records.length }}</strong>
        </article>
        <article>
          <span>Pendientes</span>
          <strong>{{ summary?.metrics.pendingRecords ?? 0 }}</strong>
        </article>
        <article>
          <span>Completados</span>
          <strong>{{ summary?.metrics.completedRecords ?? 0 }}</strong>
        </article>
      </section>

      <section v-if="activeView === 'operacion'" class="grid">
        <article class="panel">
          <h2>Reglas de negocio</h2>
          <p>{{ summary?.description }}</p>
          <ul>
            <li v-for="rule in summary?.rules" :key="rule.id">{{ rule.description }}</li>
          </ul>
        </article>

        <article class="panel">
          <h2>Nuevo ${context.primaryEntity}</h2>
          <form class="record-form" @submit.prevent="createRecord">
            <label>
              Titulo
              <input v-model="form.title" required />
            </label>
            <label>
              Descripcion
              <textarea v-model="form.description" rows="4" />
            </label>
            <label>
              Prioridad
              <select v-model="form.priority">
                <option>Baja</option>
                <option>Media</option>
                <option>Alta</option>
                <option>Critica</option>
              </select>
            </label>
            <button type="submit">Crear registro</button>
          </form>
        </article>
      </section>

      <section v-if="activeView === 'operacion'" class="records">
        <article v-for="record in records" :key="record.id" class="record-card">
          <div>
            <strong>{{ record.title }}</strong>
            <span>{{ record.description }}</span>
          </div>
          <small :class="record.priority.toLowerCase()">{{ record.priority }}</small>
          <select
            :value="record.status"
            @change="handleStatusChange(record, $event)"
          >
            <option>Pendiente</option>
            <option>En progreso</option>
            <option>Completado</option>
            <option>Bloqueado</option>
          </select>
        </article>
      </section>

      <section v-if="activeView === 'modulos'" class="grid">
        <article class="panel">
          <h2>Modulos solicitados</h2>
          <div class="maintainer-list">
            <button
              v-for="module in applicationModules"
              :key="module.slug"
              type="button"
              :class="{ active: selectedModuleSlug === module.slug }"
              @click="selectApplicationModule(module.slug)"
            >
              {{ module.name }} - {{ module.totalRecords }} registros
            </button>
          </div>
        </article>
        <article class="panel">
          <h2>Nuevo registro del modulo</h2>
          <form class="record-form" @submit.prevent="createModuleRecord">
            <label>
              Titulo
              <input v-model="moduleForm.title" required />
            </label>
            <label>
              Descripcion
              <textarea v-model="moduleForm.description" rows="4" />
            </label>
            <label>
              Prioridad
              <select v-model="moduleForm.priority">
                <option>Baja</option>
                <option>Media</option>
                <option>Alta</option>
                <option>Critica</option>
              </select>
            </label>
            <button type="submit">Crear en modulo</button>
          </form>
        </article>
      </section>

      <section v-if="activeView === 'modulos'" class="records">
        <article v-for="record in moduleRecords" :key="record.id" class="record-card">
          <div>
            <strong>{{ record.title }}</strong>
            <span>{{ record.description }}</span>
          </div>
          <small :class="record.priority.toLowerCase()">{{ record.priority }}</small>
          <span>{{ record.status }}</span>
        </article>
      </section>

      <section v-if="activeView === 'mantenedores'" class="grid">
        <article class="panel">
          <h2>Mantenedores</h2>
          <div class="maintainer-list">
            <span v-for="item in maintainers" :key="item.id" :class="{ inactive: !item.active }">
              {{ item.type }} - {{ item.label }}
            </span>
          </div>
        </article>
        <article class="panel">
          <h2>Nuevo mantenedor</h2>
          <form class="record-form" @submit.prevent="createMaintainer">
            <label>
              Tipo
              <select v-model="maintainerForm.type">
                <option>estado</option>
                <option>prioridad</option>
                <option>categoria</option>
                <option>rol</option>
              </select>
            </label>
            <label>
              Etiqueta
              <input v-model="maintainerForm.label" required />
            </label>
            <button type="submit">Crear mantenedor</button>
          </form>
        </article>
      </section>

      <section v-if="activeView === 'reporteria'" class="grid">
        <article class="panel">
          <h2>Reporte operacional</h2>
          <p>Generado: {{ report?.generatedAt }}</p>
          <ul>
            <li v-for="recommendation in report?.recommendations" :key="recommendation">
              {{ recommendation }}
            </li>
          </ul>
          <button type="button" @click="downloadReport">Descargar CSV</button>
        </article>
        <article class="panel">
          <h2>Cumplimiento</h2>
          <strong class="large-number">{{ report?.dashboard.rulesCompliance ?? 100 }}%</strong>
          <p>Mantenedores activos: {{ report?.activeMaintainers ?? maintainers.length }}</p>
        </article>
      </section>

      <section v-if="activeView === 'seguridad'" class="grid">
        <article class="panel">
          <h2>Usuarios</h2>
          <div class="maintainer-list">
            <span v-for="user in users" :key="user.id">
              {{ user.displayName }} - {{ user.role }}
            </span>
          </div>
          <p>Minimo de contrasena: {{ policy?.passwordMinLength }} caracteres</p>
        </article>
        <article class="panel">
          <h2>Nuevo usuario</h2>
          <form class="record-form" @submit.prevent="createUser">
            <label>
              Usuario
              <input v-model="userForm.username" required />
            </label>
            <label>
              Nombre
              <input v-model="userForm.displayName" required />
            </label>
            <label>
              Rol
              <select v-model="userForm.role">
                <option>Administrador</option>
                <option>Operador</option>
                <option>Auditor</option>
              </select>
            </label>
            <button type="submit">Crear usuario</button>
          </form>
        </article>
      </section>
    </section>
  </main>
</template>
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/web/src/style.css'),
        `:root {
  color: #17202a;
  background: #eef2f4;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

button,
input,
textarea,
select {
  font: inherit;
}

.shell {
  min-height: 100vh;
  display: grid;
  padding: 24px;
}

.login-panel,
.panel,
.record-card,
.summary article {
  border: 1px solid #d7dce2;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(23, 32, 42, 0.07);
}

.login-panel {
  place-self: center;
  width: min(460px, 100%);
  padding: 28px;
}

.workspace {
  width: min(1180px, 100%);
  margin: 0 auto;
  display: grid;
  gap: 18px;
}

.topbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid #d7dce2;
  padding-bottom: 10px;
}

.tabs button {
  min-height: 36px;
  border: 1px solid #c9d1da;
  background: #fff;
  color: #17202a;
}

.tabs button.active {
  border-color: #1f6f5b;
  background: #1f6f5b;
  color: #fff;
}

.eyebrow {
  margin: 0 0 8px;
  color: #3d6f8f;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: 30px;
}

h2 {
  margin: 0 0 12px;
  font-size: 20px;
}

.login,
.record-form {
  display: grid;
  gap: 14px;
}

.summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.summary article {
  display: grid;
  gap: 5px;
  padding: 16px;
}

.summary span,
.record-card span {
  color: #66717f;
}

.summary strong {
  font-size: 30px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
  gap: 16px;
  align-items: start;
}

.panel {
  padding: 18px;
}

label {
  display: grid;
  gap: 6px;
  font-size: 14px;
  font-weight: 700;
}

input,
textarea,
select {
  width: 100%;
  min-height: 40px;
  border: 1px solid #c9d1da;
  border-radius: 6px;
  padding: 0 12px;
  background: #fff;
}

textarea {
  padding-top: 10px;
  resize: vertical;
}

button {
  min-height: 42px;
  border: 0;
  border-radius: 6px;
  background: #1f6f5b;
  color: white;
  font-weight: 700;
  cursor: pointer;
}

.records {
  display: grid;
  gap: 10px;
}

.record-card {
  min-height: 72px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 180px;
  align-items: center;
  gap: 12px;
  padding: 14px;
}

.record-card div {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.record-card small {
  border-radius: 999px;
  padding: 6px 10px;
  background: #e8efff;
  color: #2f64d6;
  font-weight: 800;
}

.record-card small.alta {
  background: #fde8e4;
  color: #b42318;
}

.record-card small.critica {
  background: #2b1620;
  color: #fff;
}

.record-card small.baja {
  background: #e4f4ea;
  color: #237a48;
}

.maintainer-list {
  display: grid;
  gap: 8px;
}

.maintainer-list span,
.maintainer-list button {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  border: 1px solid #d7dce2;
  border-radius: 6px;
  padding: 7px 10px;
  background: #f8fafc;
  color: #17202a;
  text-align: left;
}

.maintainer-list span.inactive {
  opacity: 0.52;
  text-decoration: line-through;
}

.maintainer-list button.active {
  border-color: #1f6f5b;
  background: #e4f4ea;
  color: #1f6f5b;
}

.large-number {
  display: block;
  font-size: 42px;
  color: #1f6f5b;
}

.message {
  min-height: 20px;
  margin-top: 14px;
}

@media (max-width: 780px) {
  .shell {
    padding: 16px;
  }

  .topbar,
  .grid,
  .record-card {
    grid-template-columns: 1fr;
  }

  .summary {
    grid-template-columns: 1fr;
  }
}
`,
      ),
    );

    return {
      summary:
        `Se genero una aplicacion web funcional con API NestJS, UI Vue, CRUD completo para ${context.primaryEntity}, mantenedores, reporteria, seguridad inicial y documentacion tecnica.`,
      files,
      commands: ['npm install', 'npm run dev'],
    };
  }

  private createJavaExecutable(
    project: ProjectRecord,
    prompt: string,
    rules: string,
  ): ScaffoldResult {
    const files: string[] = [];
    const context = this.buildBusinessContext(project, prompt, rules);
    const packagePath = join(
      project.projectPath,
      'src/main/java/com/agents/generated',
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'pom.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.agents</groupId>
  <artifactId>${project.slug}</artifactId>
  <version>0.1.0</version>
  <packaging>jar</packaging>
  <properties>
    <java.version>17</java.version>
    <spring-boot.version>3.3.5</spring-boot.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>\${spring-boot.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
        <version>\${spring-boot.version}</version>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
        <configuration>
          <source>\${java.version}</source>
          <target>\${java.version}</target>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(packagePath, 'Application.java'),
        `package com.agents.generated;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
  public static void main(String[] args) {
    SpringApplication.run(Application.class, args);
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(packagePath, 'AuthController.java'),
        `package com.agents.generated;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class AuthController {
  private final String username = System.getenv().getOrDefault("DEFAULT_ADMIN_USER", "admin");
  private final String password = System.getenv().getOrDefault("DEFAULT_ADMIN_PASSWORD", "Admin123!");

  @GetMapping("/health")
  public Map<String, String> health() {
    return Map.of("status", "ok", "service", "${project.slug}");
  }

  @PostMapping("/login")
  public Map<String, Object> login(@RequestBody Map<String, String> body) {
    boolean authenticated =
        username.equals(body.get("username")) && password.equals(body.get("password"));
    return Map.of("authenticated", authenticated, "username", authenticated ? username : "");
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(packagePath, `${context.primaryEntityClass}Record.java`),
        `package com.agents.generated;

public class ${context.primaryEntityClass}Record {
  public String id;
  public String title;
  public String description;
  public String status;
  public String priority;
  public String createdAt;

  public ${context.primaryEntityClass}Record(
      String id,
      String title,
      String description,
      String status,
      String priority,
      String createdAt) {
    this.id = id;
    this.title = title;
    this.description = description;
    this.status = status;
    this.priority = priority;
    this.createdAt = createdAt;
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(packagePath, 'BusinessService.java'),
        `package com.agents.generated;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class BusinessService {
  private final List<String> rules = new ArrayList<>(List.of(
${context.rules.map((rule) => `      "${this.escapeJavaString(rule)}"`).join(',\n')}
  ));

  private final List<${context.primaryEntityClass}Record> records = new ArrayList<>(
      List.of(new ${context.primaryEntityClass}Record(
          "record-1",
          "${this.escapeJavaString(context.primaryEntity)} inicial",
          "${this.escapeJavaString(context.description)}",
          "Pendiente",
          "Media",
          Instant.now().toString())));

  public Map<String, Object> summary() {
    long completed = records.stream().filter(record -> "Completado".equals(record.status)).count();
    return Map.of(
        "project", "${this.escapeJavaString(project.name)}",
        "domain", "${this.escapeJavaString(context.primaryEntity)}",
        "description", "${this.escapeJavaString(context.description)}",
        "entities", List.of(${context.entities.map((entity) => `"${this.escapeJavaString(entity)}"`).join(', ')}),
        "rules", rules,
        "metrics", Map.of(
            "totalRecords", records.size(),
            "completedRecords", completed,
            "pendingRecords", records.size() - completed));
  }

  public List<${context.primaryEntityClass}Record> list() {
    return records;
  }

  public ${context.primaryEntityClass}Record create(Map<String, String> input) {
    ${context.primaryEntityClass}Record record = new ${context.primaryEntityClass}Record(
        "record-" + (records.size() + 1),
        input.getOrDefault("title", "Nuevo ${this.escapeJavaString(context.primaryEntity)}"),
        input.getOrDefault("description", "Creado desde API"),
        "Pendiente",
        input.getOrDefault("priority", "Media"),
        Instant.now().toString());
    records.add(0, record);
    return record;
  }
}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(packagePath, 'BusinessController.java'),
        `package com.agents.generated;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/business")
public class BusinessController {
  private final BusinessService business;

  public BusinessController(BusinessService business) {
    this.business = business;
  }

  @GetMapping("/summary")
  public Map<String, Object> summary() {
    return business.summary();
  }

  @GetMapping("/${context.primaryEntitySlug}")
  public List<${context.primaryEntityClass}Record> list() {
    return business.list();
  }

  @PostMapping("/${context.primaryEntitySlug}")
  public ${context.primaryEntityClass}Record create(@RequestBody Map<String, String> body) {
    return business.create(body);
  }
}
`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'src/main/resources/application.properties'),
        `spring.application.name=${project.slug}
server.port=\${PORT:8080}
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'README.md'),
        `# ${project.name}

Proyecto ejecutable Java generado por el orquestador de agentes IA.

## Objetivo

${context.description}

## Modulos generados

- Autenticacion inicial.
- Endpoints de negocio para ${context.primaryEntity}.
- Health check operativo.
- Documentacion tecnica en docs/architecture.md.

## Reglas consideradas

${context.rules.map((rule) => `- ${rule}`).join('\n')}

## Comandos

\`\`\`bash
mvn -DskipTests package
java -jar target/${project.slug}-0.1.0.jar
\`\`\`
`,
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'docs/architecture.md'),
        this.renderArchitectureDoc(project, 'executable', context),
      ),
    );

    return {
      summary:
        `Se genero una aplicacion Java Spring Boot empaquetable como JAR con autenticacion inicial y modulo de negocio para ${context.primaryEntity}.`,
      files,
      commands: ['mvn -DskipTests package', `java -jar target/${project.slug}-0.1.0.jar`],
    };
  }

  private buildBusinessContext(
    project: ProjectRecord,
    prompt: string,
    rules: string,
  ): BusinessContext {
    const extractedRules = this.extractRules(rules, prompt);
    const entities = this.extractEntities(rules, project.name);
    const featureModules = this.buildFeatureModules(entities, extractedRules, prompt, rules);
    const primaryEntity =
      featureModules.find((module) => !/^usuario|user|admin/i.test(module.name))?.name ??
      featureModules[0]?.name ??
      'Registro de negocio';
    const description =
      this.firstMeaningfulLine(prompt) ??
      this.firstMeaningfulLine(rules) ??
      `Sistema operativo para gestionar ${primaryEntity.toLowerCase()}.`;

    return {
      title: project.name,
      description: this.truncateText(description, 260),
      rules: extractedRules,
      entities,
      featureModules,
      primaryEntity,
      primaryEntitySlug: this.slugify(primaryEntity),
      primaryEntityClass: this.toClassName(primaryEntity),
    };
  }

  private buildFeatureModules(
    entities: string[],
    rules: string[],
    prompt: string,
    rawRules: string,
  ): ApplicationFeatureModule[] {
    const moduleHints = `${prompt}\n${rawRules}`
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/modulos?[^:]*:\s*(.+)$/i);
        if (!match) {
          return [];
        }
        return match[1].split(/[,;|]/).map((item) => item.trim());
      });

    const names = Array.from(
      new Set([...entities, ...moduleHints].map((name) => this.titleCase(name)).filter(Boolean)),
    ).slice(0, 8);

    const safeNames = names.length ? names : ['Operacion principal'];
    return safeNames.map((name) => {
      const relatedRules = rules
        .filter((rule) =>
          rule
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .includes(
              name
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .split(/\s+/)[0],
            ),
        )
        .slice(0, 5);
      return {
        name,
        slug: this.slugify(name),
        className: this.toClassName(name),
        description: `Modulo funcional para gestionar ${name.toLowerCase()} segun las reglas del analisis previo.`,
        rules: relatedRules.length ? relatedRules : rules.slice(0, 5),
      };
    });
  }

  private extractRules(rules: string, prompt: string): string[] {
    const candidates = `${prompt}\n${rules}`
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+\.\s+/, '')
          .trim(),
      )
      .filter((line) => {
        if (!line || line.startsWith('#') || line.startsWith('```')) {
          return false;
        }
        if (/^(flowchart|sequenceDiagram|erDiagram|classDiagram)\b/i.test(line)) {
          return false;
        }
        return line.length >= 18 && line.length <= 260;
      });

    const unique = Array.from(new Set(candidates)).slice(0, 10);
    return unique.length
      ? unique
      : [
          'Validar datos de entrada antes de ejecutar reglas de negocio.',
          'Registrar cada cambio con fecha, estado y responsable operativo.',
          'Permitir consulta de registros y actualizacion de estado.',
        ];
  }

  private extractEntities(rules: string, projectName: string): string[] {
    const explicitEntities = rules
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/entidades[^:]*:\s*(.+)$/i);
        if (!match || /pendiente/i.test(match[1])) {
          return [];
        }
        return match[1].split(/[,;|]/).map((item) => item.trim());
      })
      .filter(Boolean);

    const headingEntities = rules
      .split(/\r?\n/)
      .filter((line) => /^#{2,4}\s+/.test(line))
      .map((line) => line.replace(/^#{2,4}\s+/, '').trim())
      .filter((line) => /cliente|orden|pedido|producto|usuario|ticket|tarea|proyecto|servicio|registro/i.test(line));

    const fallback = this.titleCase(projectName.replace(/\b(app|web|sistema|project|proyecto)\b/gi, '').trim()) || 'Registro de negocio';
    return Array.from(new Set([...explicitEntities, ...headingEntities, fallback, 'Usuario']))
      .map((entity) => this.truncateText(entity, 40))
      .filter(Boolean)
      .slice(0, 6);
  }

  private renderArchitectureDoc(
    project: ProjectRecord,
    targetType: ProjectTarget,
    context: BusinessContext,
  ): string {
    return `# Arquitectura tecnica - ${project.name}

## Objetivo

${context.description}

## Entidades iniciales

${context.entities.map((entity) => `- ${entity}`).join('\n')}

## Modulos solicitados implementados

${context.featureModules.map((module) => `- ${module.name}: CRUD operativo en /api/application-modules/${module.slug}/records`).join('\n')}

## Reglas implementadas como base

${context.rules.map((rule) => `- ${rule}`).join('\n')}

## Arquitectura

${targetType === 'executable' ? 'Aplicacion Java Spring Boot empaquetable como JAR con controladores REST y servicio de negocio en memoria preparado para persistencia.' : 'Aplicacion web con API NestJS modular y frontend Vue 3. La API expone autenticacion, CRUD de negocio, mantenedores, reporteria y seguridad inicial.'}

## Capacidades base

- CRUD completo para ${context.primaryEntity}: crear, consultar, actualizar, cambiar estado, eliminar, filtrar y exportar CSV.
- CRUD independiente para cada modulo solicitado por el usuario mediante /api/application-modules.
- Validacion de reglas de negocio sobre cada registro.
- Reporteria operacional con metricas por estado, prioridad y cumplimiento.
- Mantenedores para catalogos de operacion: estados, prioridades, categorias y roles.
- Seguridad inicial con usuarios, roles, politica de contrasenas y recomendacion de rotacion.

\`\`\`mermaid
flowchart LR
  User[Usuario] --> UI[Interfaz Vue]
  UI --> Auth[Auth API]
  UI --> Business[Business API]
  UI --> FeatureModules[Modulos solicitados API]
  UI --> Reports[Reports API]
  UI --> Maintainers[Maintainers API]
  UI --> Security[Security API]
  Business --> Service[Servicio de negocio]
  Service --> Store[(Persistencia futura)]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant U as Usuario
  participant UI as Vue
  participant API as API
  participant S as BusinessService
  U->>UI: Crea ${context.primaryEntity}
  UI->>API: POST /api/business/${context.primaryEntitySlug}
  API->>S: Valida y registra
  S-->>API: Registro creado
  API-->>UI: JSON normalizado
  UI-->>U: Lista actualizada
\`\`\`

\`\`\`mermaid
erDiagram
  USER ||--o{ ${context.primaryEntityClass.toUpperCase()} : manages
  ${context.primaryEntityClass.toUpperCase()} {
    string id
    string title
    string description
    string status
    string priority
    datetime createdAt
  }
  USER {
    string username
    string displayName
  }
\`\`\`
`;
  }

  private writeGenerated(path: string, content: string): string {
    this.ensureDirectory(dirname(path));
    writeFileSync(path, content, 'utf8');
    return path;
  }

  private writeIfMissing(path: string, content: string): string {
    this.ensureDirectory(dirname(path));
    if (!existsSync(path)) {
      writeFileSync(path, content, 'utf8');
    }
    return path;
  }

  private ensureDirectory(path: string): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  private isEffectivelyEmpty(path: string): boolean {
    if (!existsSync(path)) {
      return true;
    }
    return readdirSync(path).every((entry) => entry === '.agents-ai');
  }

  private firstMeaningfulLine(value: string): string | undefined {
    return value
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+\.\s+/, '')
          .trim(),
      )
      .find(
        (line) =>
          line.length >= 20 &&
          !line.startsWith('#') &&
          !line.startsWith('```') &&
          !/^(flowchart|sequenceDiagram|erDiagram)\b/i.test(line),
      );
  }

  private toClassName(value: string): string {
    const className = this.titleCase(value)
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    return /^[A-Za-z]/.test(className) ? className : 'BusinessRecord';
  }

  private titleCase(value: string): string {
    return value
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  private slugify(value: string): string {
    const slug = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return slug || 'business-records';
  }

  private truncateText(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
  }

  private escapeTsString(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r?\n/g, ' ');
  }

  private escapeJavaString(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ');
  }
}
