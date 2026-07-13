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
  isErp: boolean;
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
    if (targetType === 'executable') {
      return this.createJavaExecutable(project, prompt, rules);
    }

    const result = this.createWebWorkspace(project, prompt, rules);
    if (project.mode === 'existing' && !this.isEffectivelyEmpty(project.projectPath)) {
      const brief = this.createExistingProjectBrief(project, prompt, rules, ticketId);
      return {
        summary: `${result.summary}\n\nTambien se genero un brief de integracion en .agents-ai para trazabilidad del proyecto existente.`,
        files: [...result.files, ...brief.files],
        commands: result.commands,
      };
    }

    return result;
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
    const domainImports = context.featureModules
      .map(
        (module) =>
          `import { ${module.className}Controller } from './domain/${module.slug}/${module.slug}.controller';\nimport { ${module.className}Service } from './domain/${module.slug}/${module.slug}.service';`,
      )
      .join('\n');
    const domainControllers = context.featureModules
      .map((module) => `${module.className}Controller`)
      .join(',\n    ');
    const domainProviders = context.featureModules
      .map((module) => `${module.className}Service`)
      .join(',\n    ');
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
${domainImports}

@Module({
  controllers: [
    AuthController,
    ApplicationModulesController,
    BusinessController,
    MaintainersController,
    ReportsController,
    SecurityController,
    ${domainControllers},
  ],
  providers: [
    ApplicationModulesService,
    BusinessService,
    MaintainersService,
    ReportsService,
    SecurityService,
    ${domainProviders},
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

    for (const module of context.featureModules) {
      files.push(
        this.writeGenerated(
          join(project.projectPath, `apps/api/src/domain/${module.slug}/${module.slug}.types.ts`),
          `export type ${module.className}Status = 'Pendiente' | 'En proceso' | 'Aprobado' | 'Cerrado' | 'Bloqueado';
export type ${module.className}Priority = 'Baja' | 'Media' | 'Alta' | 'Critica';

export interface ${module.className}Record {
  id: string;
  code: string;
  name: string;
  description: string;
  status: ${module.className}Status;
  priority: ${module.className}Priority;
  owner: string;
  businessData: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface Create${module.className}Dto {
  code?: string;
  name?: string;
  description?: string;
  priority?: ${module.className}Priority;
  owner?: string;
  businessData?: Record<string, string | number | boolean>;
}

export interface Update${module.className}Dto extends Partial<Create${module.className}Dto> {
  status?: ${module.className}Status;
}
`,
        ),
      );

      files.push(
        this.writeGenerated(
          join(project.projectPath, `apps/api/src/domain/${module.slug}/${module.slug}.service.ts`),
          `import { Injectable } from '@nestjs/common';
import type {
  Create${module.className}Dto,
  ${module.className}Record,
  ${module.className}Status,
  Update${module.className}Dto,
} from './${module.slug}.types';

@Injectable()
export class ${module.className}Service {
  private records: ${module.className}Record[] = [
    {
      id: '${module.slug}-1',
      code: '${module.slug.toUpperCase()}-001',
      name: '${this.escapeTsString(module.name)} inicial',
      description: '${this.escapeTsString(module.description)}',
      status: 'Pendiente',
      priority: 'Media',
      owner: 'admin',
      businessData: {
        module: '${this.escapeTsString(module.name)}',
        rulesApplied: ${module.rules.length},
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  list(search?: string) {
    const normalized = search?.trim().toLowerCase();
    if (!normalized) {
      return this.records;
    }
    return this.records.filter(
      (record) =>
        record.code.toLowerCase().includes(normalized) ||
        record.name.toLowerCase().includes(normalized) ||
        record.description.toLowerCase().includes(normalized),
    );
  }

  dashboard() {
    return {
      module: '${this.escapeTsString(module.name)}',
      total: this.records.length,
      pending: this.records.filter((record) => record.status === 'Pendiente').length,
      closed: this.records.filter((record) => record.status === 'Cerrado').length,
      rules: ${JSON.stringify(module.rules, null, 6)},
    };
  }

  get(id: string) {
    return this.records.find((record) => record.id === id);
  }

  create(input: Create${module.className}Dto) {
    const now = new Date().toISOString();
    const record: ${module.className}Record = {
      id: \`${module.slug}-\${this.records.length + 1}\`,
      code: input.code?.trim() || \`${module.slug.toUpperCase()}-\${String(this.records.length + 1).padStart(3, '0')}\`,
      name: input.name?.trim() || 'Nuevo ${this.escapeTsString(module.name)}',
      description: input.description?.trim() || '${this.escapeTsString(module.description)}',
      status: 'Pendiente',
      priority: input.priority ?? 'Media',
      owner: input.owner?.trim() || 'admin',
      businessData: input.businessData ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.records.unshift(record);
    return record;
  }

  update(id: string, input: Update${module.className}Dto) {
    const record = this.get(id);
    if (!record) {
      return undefined;
    }
    record.code = input.code?.trim() || record.code;
    record.name = input.name?.trim() || record.name;
    record.description = input.description?.trim() || record.description;
    record.status = input.status ?? record.status;
    record.priority = input.priority ?? record.priority;
    record.owner = input.owner?.trim() || record.owner;
    record.businessData = input.businessData ?? record.businessData;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  updateStatus(id: string, status: ${module.className}Status) {
    return this.update(id, { status });
  }

  remove(id: string) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) {
      return false;
    }
    this.records.splice(index, 1);
    return true;
  }
}
`,
        ),
      );

      files.push(
        this.writeGenerated(
          join(project.projectPath, `apps/api/src/domain/${module.slug}/${module.slug}.controller.ts`),
          `import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ${module.className}Service } from './${module.slug}.service';
import type {
  Create${module.className}Dto,
  ${module.className}Status,
  Update${module.className}Dto,
} from './${module.slug}.types';

@Controller('api/domain/${module.slug}')
export class ${module.className}Controller {
  constructor(private readonly service: ${module.className}Service) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.service.list(search);
  }

  @Get('dashboard')
  dashboard() {
    return this.service.dashboard();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() body: Create${module.className}Dto) {
    return this.service.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: Update${module.className}Dto) {
    return this.service.update(id, body);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status?: ${module.className}Status },
  ) {
    return this.service.updateStatus(id, body.status ?? 'En proceso');
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { deleted: this.service.remove(id) };
  }
}
`,
        ),
      );

      files.push(
        this.writeGenerated(
          join(project.projectPath, `apps/web/src/services/${module.slug}.service.ts`),
          `export type ${module.className}Status = 'Pendiente' | 'En proceso' | 'Aprobado' | 'Cerrado' | 'Bloqueado';
export type ${module.className}Priority = 'Baja' | 'Media' | 'Alta' | 'Critica';

export interface ${module.className}Record {
  id: string;
  code: string;
  name: string;
  description: string;
  status: ${module.className}Status;
  priority: ${module.className}Priority;
  owner: string;
  businessData: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface ${module.className}Input {
  code?: string;
  name?: string;
  description?: string;
  priority?: ${module.className}Priority;
  owner?: string;
  businessData?: Record<string, string | number | boolean>;
}

const BASE_URL = '/api/domain/${module.slug}';

async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(\`\${BASE_URL}\${path}\`, { ...init, headers });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  return response.json() as Promise<T>;
}

export const ${this.toCamelCase(module.className)}Service = {
  list(search = '') {
    const query = search ? \`?search=\${encodeURIComponent(search)}\` : '';
    return request<${module.className}Record[]>(query);
  },
  dashboard() {
    return request<{ module: string; total: number; pending: number; closed: number; rules: string[] }>('/dashboard');
  },
  create(input: ${module.className}Input) {
    return request<${module.className}Record>('', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  update(id: string, input: Partial<${module.className}Input> & { status?: ${module.className}Status }) {
    return request<${module.className}Record>(\`/\${id}\`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  remove(id: string) {
    return request<{ deleted: boolean }>(\`/\${id}\`, { method: 'DELETE' });
  },
};
`,
        ),
      );

      files.push(
        this.writeGenerated(
          join(project.projectPath, `apps/web/src/modules/${module.slug}/${module.slug}.vue`),
          `<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  ${this.toCamelCase(module.className)}Service,
  type ${module.className}Priority,
  type ${module.className}Record,
  type ${module.className}Status,
} from '../../services/${module.slug}.service';

const loading = ref(false);
const error = ref('');
const search = ref('');
const records = ref<${module.className}Record[]>([]);
const dashboard = ref<{ module: string; total: number; pending: number; closed: number; rules: string[] } | null>(null);
const form = reactive({
  code: '',
  name: '',
  description: '',
  priority: 'Media' as ${module.className}Priority,
  owner: 'admin',
});

onMounted(() => {
  void load();
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [items, metrics] = await Promise.all([
      ${this.toCamelCase(module.className)}Service.list(search.value),
      ${this.toCamelCase(module.className)}Service.dashboard(),
    ]);
    records.value = items;
    dashboard.value = metrics;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'No se pudo cargar ${this.escapeTsString(module.name)}';
  } finally {
    loading.value = false;
  }
}

async function createRecord() {
  const created = await ${this.toCamelCase(module.className)}Service.create(form);
  records.value = [created, ...records.value];
  form.code = '';
  form.name = '';
  form.description = '';
  form.priority = 'Media';
  await load();
}

async function updateStatus(record: ${module.className}Record, status: ${module.className}Status) {
  const updated = await ${this.toCamelCase(module.className)}Service.update(record.id, { status });
  records.value = records.value.map((item) => (item.id === updated.id ? updated : item));
  await load();
}

async function removeRecord(record: ${module.className}Record) {
  await ${this.toCamelCase(module.className)}Service.remove(record.id);
  records.value = records.value.filter((item) => item.id !== record.id);
  await load();
}
</script>

<template>
  <section class="module-page">
    <header class="module-head">
      <div>
        <p class="eyebrow">Modulo transaccional</p>
        <h2>${module.name}</h2>
      </div>
      <div class="module-actions">
        <input v-model="search" placeholder="Buscar por codigo, nombre o descripcion" @keyup.enter="load" />
        <button type="button" @click="load">{{ loading ? 'Actualizando...' : 'Actualizar' }}</button>
      </div>
    </header>

    <p v-if="error" class="module-error">{{ error }}</p>

    <section class="module-summary">
      <article><span>Total</span><strong>{{ dashboard?.total ?? records.length }}</strong></article>
      <article><span>Pendientes</span><strong>{{ dashboard?.pending ?? 0 }}</strong></article>
      <article><span>Cerrados</span><strong>{{ dashboard?.closed ?? 0 }}</strong></article>
    </section>

    <section class="module-grid">
      <article class="panel">
        <h3>Nuevo registro</h3>
        <form class="record-form" @submit.prevent="createRecord">
          <label>Codigo<input v-model="form.code" /></label>
          <label>Nombre<input v-model="form.name" required /></label>
          <label>Descripcion<textarea v-model="form.description" rows="4" /></label>
          <label>
            Prioridad
            <select v-model="form.priority">
              <option>Baja</option>
              <option>Media</option>
              <option>Alta</option>
              <option>Critica</option>
            </select>
          </label>
          <label>Responsable<input v-model="form.owner" /></label>
          <button type="submit">Crear ${module.name}</button>
        </form>
      </article>

      <article class="panel">
        <h3>Reglas aplicadas</h3>
        <ul>
          <li v-for="rule in dashboard?.rules" :key="rule">{{ rule }}</li>
        </ul>
      </article>
    </section>

    <section class="wide-panel">
      <h3>Registros transaccionales</h3>
      <table>
        <thead>
          <tr>
            <th>Codigo</th>
            <th>Nombre</th>
            <th>Responsable</th>
            <th>Prioridad</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.id">
            <td>{{ record.code }}</td>
            <td>
              <strong>{{ record.name }}</strong>
              <span>{{ record.description }}</span>
            </td>
            <td>{{ record.owner }}</td>
            <td><small :class="record.priority.toLowerCase()">{{ record.priority }}</small></td>
            <td>
              <select :value="record.status" @change="updateStatus(record, ($event.target as HTMLSelectElement).value as ${module.className}Status)">
                <option>Pendiente</option>
                <option>En proceso</option>
                <option>Aprobado</option>
                <option>Cerrado</option>
                <option>Bloqueado</option>
              </select>
            </td>
            <td>
              <button type="button" @click="removeRecord(record)">Eliminar</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>
`,
        ),
      );
    }

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
      this.writeIfMissing(
        join(project.projectPath, 'apps/web/tsconfig.json'),
        `${JSON.stringify(
          {
            include: ['src/**/*.ts', 'src/**/*.vue'],
            compilerOptions: {
              target: 'ES2022',
              useDefineForClassFields: true,
              module: 'ESNext',
              moduleResolution: 'Bundler',
              strict: true,
              jsx: 'preserve',
              sourceMap: true,
              resolveJsonModule: true,
              isolatedModules: true,
              esModuleInterop: true,
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              skipLibCheck: true,
              types: ['node'],
            },
          },
          null,
          2,
        )}\n`,
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
const activeView = ref<'operacion' | 'modulos' | 'mantenedores' | 'reporteria' | 'seguridad'>('${context.isErp ? 'modulos' : 'operacion'}');
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
          <p class="eyebrow">${context.isErp ? 'ERP operativo' : `{{ summary?.domain ?? '${context.primaryEntity}' }}`}</p>
          <h1>{{ summary?.project ?? '${project.name}' }}</h1>
        </div>
        <button type="button" @click="loadBusiness">
          {{ loading ? 'Actualizando...' : 'Actualizar' }}
        </button>
      </header>

      <nav class="tabs" aria-label="Modulos principales">
        <button type="button" :class="{ active: activeView === 'operacion' }" @click="activeView = 'operacion'">
          ${context.isErp ? 'Dashboard' : 'Operacion'}
        </button>
        <button type="button" :class="{ active: activeView === 'modulos' }" @click="activeView = 'modulos'">
          ${context.isErp ? 'ERP modulos' : 'Modulos'}
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
          <h2>${context.isErp ? 'Modulos ERP operativos' : 'Modulos solicitados'}</h2>
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

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/web/src/App.vue'),
        this.renderTransactionalAppVue(project, context),
      ),
    );

    files.push(
      this.writeGenerated(
        join(project.projectPath, 'apps/web/src/style.css'),
        this.renderTransactionalStyleCss(),
      ),
    );

    return {
      summary:
        `Se genero una plataforma web transaccional con API NestJS, shell Vue tipo panel operativo, CRUD completo para ${context.primaryEntity}, vistas reales por modulo (${context.featureModules.map((module) => module.name).join(', ')}), mantenedores, reporteria, seguridad inicial y documentacion tecnica. La UI final no usa listas demostrativas de modulos: cada modulo abre una pantalla transaccional conectada a su API.`,
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

  private renderTransactionalAppVue(
    project: ProjectRecord,
    context: BusinessContext,
  ): string {
    const firstModule = context.featureModules[0];
    const moduleImports = context.featureModules
      .map(
        (module) =>
          `import ${module.className}ModuleView from './modules/${module.slug}/${module.slug}.vue';`,
      )
      .join('\n');
    const moduleComponentMap = context.featureModules
      .map((module) => `  ${JSON.stringify(module.slug)}: ${module.className}ModuleView`)
      .join(',\n');

    return `<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
${moduleImports}

type ActiveArea = 'dashboard' | 'module' | 'mantenedores' | 'reporteria' | 'seguridad';

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

interface ApplicationModule {
  name: string;
  slug: string;
  description: string;
  rules: string[];
  totalRecords: number;
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

const moduleComponents = {
${moduleComponentMap}
} as const;

const username = ref('admin');
const password = ref('Admin123!');
const authenticated = ref(false);
const authMessage = ref('');
const loading = ref(false);
const activeArea = ref<ActiveArea>('dashboard');
const activeModuleSlug = ref('${firstModule?.slug ?? ''}');
const summary = ref<BusinessSummary | null>(null);
const modules = ref<ApplicationModule[]>(${JSON.stringify(
      context.featureModules.map((module) => ({
        name: module.name,
        slug: module.slug,
        description: module.description,
        rules: module.rules,
        totalRecords: 0,
      })),
      null,
      2,
    )});
const maintainers = ref<MaintainerItem[]>([]);
const report = ref<OperationalReport | null>(null);
const users = ref<UserAccount[]>([]);
const policy = ref<SecurityPolicy | null>(null);

const selectedModule = computed(() =>
  modules.value.find((module) => module.slug === activeModuleSlug.value) ?? modules.value[0],
);
const activeModuleComponent = computed(() => {
  const slug = activeModuleSlug.value as keyof typeof moduleComponents;
  return moduleComponents[slug] ?? moduleComponents[Object.keys(moduleComponents)[0] as keyof typeof moduleComponents];
});

onMounted(() => {
  void loadWorkspace();
});

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw new Error((await response.text()) || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function login() {
  const result = await request<{ authenticated: boolean }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: username.value, password: password.value }),
  });
  authenticated.value = result.authenticated;
  authMessage.value = result.authenticated ? 'Acceso concedido' : 'Credenciales invalidas';
  if (authenticated.value) {
    await loadWorkspace();
  }
}

async function loadWorkspace() {
  loading.value = true;
  try {
    const [
      summaryResult,
      modulesResult,
      maintainersResult,
      reportResult,
      usersResult,
      policyResult,
    ] = await Promise.all([
      request<BusinessSummary>('/api/business/summary'),
      request<ApplicationModule[]>('/api/application-modules'),
      request<MaintainerItem[]>('/api/maintainers'),
      request<OperationalReport>('/api/reports/operational'),
      request<UserAccount[]>('/api/security/users'),
      request<SecurityPolicy>('/api/security/policy'),
    ]);
    summary.value = summaryResult;
    modules.value = modulesResult;
    maintainers.value = maintainersResult;
    report.value = reportResult;
    users.value = usersResult;
    policy.value = policyResult;
    if (!activeModuleSlug.value && modules.value.length) {
      activeModuleSlug.value = modules.value[0].slug;
    }
  } finally {
    loading.value = false;
  }
}

function openDashboard() {
  activeArea.value = 'dashboard';
}

function openModule(moduleSlug: string) {
  activeModuleSlug.value = moduleSlug;
  activeArea.value = 'module';
}

function openArea(area: Exclude<ActiveArea, 'module'>) {
  activeArea.value = area;
}

function downloadReport() {
  window.open('/api/reports/records.csv', '_blank', 'noopener,noreferrer');
}
</script>

<template>
  <main class="erp-shell">
    <section v-if="!authenticated" class="login-screen">
      <article class="login-card">
        <p class="eyebrow">Panel operativo</p>
        <h1>${project.name}</h1>
        <form class="login-form" @submit.prevent="login">
          <label>Usuario<input v-model="username" autocomplete="username" /></label>
          <label>Contrasena<input v-model="password" type="password" autocomplete="current-password" /></label>
          <button type="submit">Ingresar</button>
        </form>
        <p class="auth-message">{{ authMessage }}</p>
      </article>
    </section>

    <section v-else class="erp-layout">
      <aside class="sidebar">
        <header class="brand">
          <span class="brand-logo">${project.name.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>${project.name}</strong>
            <small>{{ summary?.domain ?? '${context.primaryEntity}' }}</small>
          </div>
        </header>

        <section class="account-box">
          <span>Cuenta activa</span>
          <strong>{{ username }}</strong>
        </section>

        <nav class="nav-menu" aria-label="Menu transaccional">
          <button type="button" :class="{ active: activeArea === 'dashboard' }" @click="openDashboard">
            <span>DB</span> Dashboard
          </button>
          <p>Modulos principales</p>
          <button
            v-for="module in modules"
            :key="module.slug"
            type="button"
            :class="{ active: activeArea === 'module' && activeModuleSlug === module.slug }"
            @click="openModule(module.slug)"
          >
            <span>{{ module.name.slice(0, 2).toUpperCase() }}</span>
            {{ module.name }}
          </button>
          <p>Administracion</p>
          <button type="button" :class="{ active: activeArea === 'mantenedores' }" @click="openArea('mantenedores')">
            <span>MT</span> Mantenedores
          </button>
          <button type="button" :class="{ active: activeArea === 'reporteria' }" @click="openArea('reporteria')">
            <span>RP</span> Reporteria
          </button>
          <button type="button" :class="{ active: activeArea === 'seguridad' }" @click="openArea('seguridad')">
            <span>SG</span> Seguridad
          </button>
        </nav>
      </aside>

      <section class="content-shell">
        <header class="topbar">
          <div>
            <p class="eyebrow">Panel operativo</p>
            <h1>{{ activeArea === 'module' ? selectedModule?.name : 'Dashboard' }}</h1>
          </div>
          <div class="top-actions">
            <select aria-label="Sucursal activa">
              <option>Todas mis sucursales</option>
              <option>Matriz</option>
              <option>Bodega principal</option>
            </select>
            <button type="button" @click="loadWorkspace">{{ loading ? 'Actualizando...' : 'Actualizar' }}</button>
          </div>
        </header>

        <section v-if="activeArea === 'dashboard'" class="dashboard-page">
          <article class="hero-panel">
            <header>
              <div>
                <h2>Panel ejecutivo</h2>
                <p>{{ summary?.description }}</p>
              </div>
              <button type="button" @click="downloadReport">Exportar CSV</button>
            </header>
            <section class="kpi-grid">
              <article><span>Registros</span><strong>{{ summary?.metrics.totalRecords ?? 0 }}</strong><small>Total operativo</small></article>
              <article><span>Pendientes</span><strong>{{ summary?.metrics.pendingRecords ?? 0 }}</strong><small>Por ejecutar</small></article>
              <article><span>Bloqueados</span><strong>{{ summary?.metrics.blockedRecords ?? 0 }}</strong><small>Requieren accion</small></article>
              <article><span>Cumplimiento</span><strong>{{ summary?.metrics.rulesCompliance ?? 100 }}%</strong><small>Reglas activas</small></article>
            </section>
          </article>

          <article class="side-panel">
            <h2>Estado operativo</h2>
            <dl>
              <div><dt>Modulos</dt><dd>{{ modules.length }}</dd></div>
              <div><dt>Usuarios</dt><dd>{{ users.length }}</dd></div>
              <div><dt>Mantenedores</dt><dd>{{ maintainers.length }}</dd></div>
              <div><dt>Actualizacion</dt><dd>{{ report?.generatedAt?.slice(0, 19).replace('T', ' ') }}</dd></div>
            </dl>
          </article>

          <article class="wide-panel">
            <h2>Modulos transaccionales</h2>
            <div class="module-table">
              <button v-for="module in modules" :key="module.slug" type="button" @click="openModule(module.slug)">
                <strong>{{ module.name }}</strong>
                <span>{{ module.description }}</span>
                <small>{{ module.totalRecords }} registros</small>
              </button>
            </div>
          </article>

          <article class="wide-panel">
            <h2>Reglas de negocio aplicadas</h2>
            <ul class="rules-list">
              <li v-for="rule in summary?.rules" :key="rule.id">{{ rule.description }}</li>
            </ul>
          </article>
        </section>

        <component v-else-if="activeArea === 'module'" :is="activeModuleComponent" />

        <section v-else-if="activeArea === 'mantenedores'" class="admin-grid">
          <article class="wide-panel">
            <h2>Mantenedores activos</h2>
            <table>
              <thead><tr><th>Tipo</th><th>Etiqueta</th><th>Estado</th></tr></thead>
              <tbody>
                <tr v-for="item in maintainers" :key="item.id">
                  <td>{{ item.type }}</td>
                  <td>{{ item.label }}</td>
                  <td>{{ item.active ? 'Activo' : 'Inactivo' }}</td>
                </tr>
              </tbody>
            </table>
          </article>
        </section>

        <section v-else-if="activeArea === 'reporteria'" class="admin-grid">
          <article class="wide-panel">
            <h2>Reporte operacional</h2>
            <p>Generado: {{ report?.generatedAt }}</p>
            <ul class="rules-list">
              <li v-for="recommendation in report?.recommendations" :key="recommendation">{{ recommendation }}</li>
            </ul>
            <button type="button" @click="downloadReport">Descargar CSV</button>
          </article>
        </section>

        <section v-else class="admin-grid">
          <article class="wide-panel">
            <h2>Usuarios y seguridad</h2>
            <table>
              <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th></tr></thead>
              <tbody>
                <tr v-for="user in users" :key="user.id">
                  <td>{{ user.username }}</td>
                  <td>{{ user.displayName }}</td>
                  <td>{{ user.role }}</td>
                  <td>{{ user.active ? 'Activo' : 'Inactivo' }}</td>
                </tr>
              </tbody>
            </table>
            <p>Politica: minimo {{ policy?.passwordMinLength }} caracteres. Rotacion: {{ policy?.requireRotation ? 'Si' : 'No' }}.</p>
          </article>
        </section>
      </section>
    </section>
  </main>
</template>
`;
  }

  private renderTransactionalStyleCss(): string {
    return `:root {
  color: #243241;
  background: #eef3f7;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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

button {
  cursor: pointer;
}

.erp-shell {
  min-height: 100vh;
}

.login-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.login-card,
.hero-panel,
.side-panel,
.wide-panel,
.panel {
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 18px 38px rgba(31, 45, 61, 0.08);
}

.login-card {
  width: min(420px, 100%);
  padding: 28px;
}

.login-card h1 {
  margin: 0 0 18px;
}

.login-form {
  display: grid;
  gap: 14px;
}

label {
  display: grid;
  gap: 6px;
  color: #34495e;
  font-size: 13px;
  font-weight: 800;
}

input,
textarea,
select {
  width: 100%;
  min-height: 38px;
  border: 1px solid #c9d5df;
  border-radius: 6px;
  padding: 0 11px;
  background: #ffffff;
  color: #203040;
}

textarea {
  min-height: 96px;
  padding-top: 10px;
  resize: vertical;
}

.login-form button,
.top-actions button,
.hero-panel button,
.wide-panel button,
.record-form button,
.module-head button {
  min-height: 38px;
  border: 0;
  border-radius: 6px;
  padding: 0 14px;
  background: #1f7664;
  color: white;
  font-weight: 900;
}

.auth-message {
  min-height: 20px;
  color: #496173;
}

.erp-layout {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
}

.sidebar {
  border-right: 1px solid #d9e1e8;
  background: #fbfdff;
  padding: 16px 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 4px 18px;
}

.brand-logo {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid #c9ddcf;
  border-radius: 50%;
  background: #eff8f0;
  color: #1f7664;
  font-size: 12px;
  font-weight: 900;
}

.brand strong,
.brand small {
  display: block;
}

.brand small,
.account-box span,
.eyebrow,
.hero-panel p,
.side-panel dt,
.module-table span,
.module-table small {
  color: #647486;
}

.account-box {
  display: grid;
  gap: 4px;
  margin-bottom: 18px;
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  padding: 12px;
  background: #f7fafc;
  font-size: 13px;
}

.nav-menu {
  display: grid;
  gap: 5px;
}

.nav-menu p {
  margin: 16px 8px 6px;
  color: #758596;
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}

.nav-menu button {
  min-height: 38px;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: #243241;
  text-align: left;
  font-size: 13px;
  font-weight: 800;
}

.nav-menu button span {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  background: #e8eef4;
  color: #436072;
  font-size: 10px;
}

.nav-menu button.active {
  background: #e8f4ef;
  color: #1f7664;
}

.nav-menu button.active span {
  background: #1f7664;
  color: white;
}

.content-shell {
  min-width: 0;
  padding: 0 30px 36px;
}

.topbar {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-bottom: 1px solid #d9e1e8;
  margin: 0 -30px 30px;
  padding: 0 30px;
  background: rgba(255, 255, 255, 0.72);
}

.topbar h1,
.hero-panel h2,
.side-panel h2,
.wide-panel h2 {
  margin: 0;
}

.eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.top-actions select {
  min-width: 260px;
}

.dashboard-page {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 0.95fr);
  gap: 22px;
}

.hero-panel,
.side-panel,
.wide-panel,
.panel {
  padding: 20px;
}

.hero-panel header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.kpi-grid article {
  min-height: 96px;
  display: grid;
  gap: 6px;
  border-radius: 6px;
  padding: 14px;
  background: #eef5fb;
}

.kpi-grid article:nth-child(2) {
  background: #e8f5f1;
}

.kpi-grid article:nth-child(3) {
  background: #fff0e7;
}

.kpi-grid article:nth-child(4) {
  background: #f3ecfb;
}

.kpi-grid strong {
  font-size: 28px;
}

.kpi-grid span,
.kpi-grid small {
  color: #637487;
}

.side-panel dl {
  display: grid;
  gap: 14px;
  margin: 18px 0 0;
}

.side-panel dl div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  border-bottom: 1px solid #e3e9ef;
  padding-bottom: 10px;
}

.side-panel dd {
  margin: 0;
  border-radius: 5px;
  padding: 4px 8px;
  background: #e8eef4;
  font-weight: 900;
}

.wide-panel {
  grid-column: 1 / -1;
}

.module-table {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.module-table button {
  min-height: 58px;
  display: grid;
  grid-template-columns: minmax(160px, 0.5fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  border: 1px solid #d8e0e8;
  border-radius: 6px;
  padding: 10px 12px;
  background: #fbfdff;
  color: #243241;
  text-align: left;
}

.module-table button:hover {
  border-color: #1f7664;
  background: #f1faf6;
}

.rules-list {
  margin: 14px 0 0;
  padding-left: 20px;
  color: #34495e;
}

.module-page {
  display: grid;
  gap: 18px;
}

.module-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.module-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.module-actions input {
  min-width: 320px;
}

.module-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.module-summary article {
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  padding: 16px;
  background: #ffffff;
}

.module-summary span,
.record-card span,
.module-error {
  color: #647486;
}

.module-summary strong {
  display: block;
  margin-top: 6px;
  font-size: 28px;
}

.module-grid,
.admin-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 16px;
}

.record-form {
  display: grid;
  gap: 12px;
}

.records {
  display: grid;
  gap: 8px;
}

.record-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 160px 100px;
  align-items: center;
  gap: 10px;
  border: 1px solid #d8e0e8;
  border-radius: 7px;
  padding: 12px;
  background: #ffffff;
}

.record-card div {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.record-card small {
  border-radius: 999px;
  padding: 5px 8px;
  background: #e9f0ff;
  color: #2f64d6;
  text-align: center;
  font-weight: 900;
}

.record-card small.alta {
  background: #fde8e4;
  color: #b42318;
}

.record-card small.critica {
  background: #2b1620;
  color: #ffffff;
}

.record-card small.baja {
  background: #e4f4ea;
  color: #237a48;
}

.record-card button {
  min-height: 34px;
  border: 1px solid #e2b8b2;
  border-radius: 6px;
  background: #fff5f3;
  color: #a13b2f;
  font-weight: 900;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 14px;
}

th,
td {
  border-bottom: 1px solid #e3e9ef;
  padding: 10px;
  text-align: left;
}

td span {
  display: block;
  margin-top: 3px;
  color: #647486;
}

th {
  color: #607184;
  font-size: 12px;
  text-transform: uppercase;
}

@media (max-width: 960px) {
  .erp-layout,
  .dashboard-page,
  .module-grid,
  .admin-grid {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: static;
  }

  .content-shell {
    padding: 0 16px 24px;
  }

  .topbar {
    margin: 0 -16px 20px;
    padding: 14px 16px;
    flex-direction: column;
    align-items: stretch;
  }

  .top-actions,
  .hero-panel header,
  .module-actions,
  .record-card,
  .module-table button {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: stretch;
  }

  .module-actions input {
    min-width: 0;
  }

  .kpi-grid,
  .module-summary {
    grid-template-columns: 1fr;
  }
}
`;
  }

  private buildBusinessContext(
    project: ProjectRecord,
    prompt: string,
    rules: string,
  ): BusinessContext {
    const source = `${project.name}\n${prompt}\n${rules}`;
    const isErp = this.isErpRequest(source);
    const extractedRules = this.extractRules(rules, prompt);
    const entities = isErp
      ? [
          'Producto',
          'Categoria de producto',
          'Almacen',
          'Ubicacion de almacen',
          'Movimiento de inventario',
          'Kardex',
          'Cliente',
          'Proveedor',
          'Usuario',
        ]
      : this.extractEntities(rules, project.name);
    const featureModules = this.buildFeatureModules(entities, extractedRules, prompt, rules);
    const primaryEntity =
      (isErp ? 'Movimiento de inventario' : undefined) ??
      featureModules.find((module) => !/^usuario|user|admin|rol|permiso|reporte|auditoria/i.test(module.name))?.name ??
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
      isErp,
    };
  }

  private buildFeatureModules(
    entities: string[],
    rules: string[],
    prompt: string,
    rawRules: string,
  ): ApplicationFeatureModule[] {
    const source = `${prompt}\n${rawRules}`;
    const keywordModules = this.isErpRequest(source)
      ? [
          'Dashboard ERP',
          'Productos',
          'Categorias de producto',
          'Almacenes',
          'Ubicaciones de almacen',
          'Inventario',
          'Movimientos de inventario',
          'Kardex',
          'Compras',
          'Ventas',
          'Clientes',
          'Proveedores',
          'Usuarios',
          'Roles',
          'Reportes',
        ]
      : this.extractKnownModuleNames(source);
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
      new Set(
        [...keywordModules, ...entities, ...moduleHints]
          .map((name) => this.titleCase(name))
          .filter((name) => name && !this.isInvalidEntityName(name)),
      ),
    ).slice(0, this.isErpRequest(source) ? 15 : 8);

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

  private isErpRequest(source: string): boolean {
    const normalized = source
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return /\b(erp|inventario|almacen|almacenes|producto|productos|kardex|compras|ventas|proveedor|cliente|wms|stock|existencias)\b/.test(
      normalized,
    );
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
      .filter(
        (line) =>
          /cliente|orden|pedido|producto|usuario|ticket|tarea|servicio|inventario|almacen|kardex|rol|permiso|reporte|auditoria/i.test(
            line,
          ) && !this.isInvalidEntityName(line),
      );

    const fallback = this.titleCase(projectName.replace(/\b(app|web|sistema|project|proyecto)\b/gi, '').trim()) || 'Registro de negocio';
    return Array.from(new Set([...explicitEntities, ...headingEntities, fallback, 'Usuario']))
      .map((entity) => this.truncateText(entity, 40))
      .filter((entity) => Boolean(entity) && !this.isInvalidEntityName(entity))
      .slice(0, 6);
  }

  private extractKnownModuleNames(source: string): string[] {
    const normalized = source
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const catalog = [
      ['usuarios', 'Usuarios'],
      ['roles', 'Roles'],
      ['permisos', 'Permisos'],
      ['productos', 'Productos'],
      ['categorias', 'Categorias de producto'],
      ['almacenes', 'Almacenes'],
      ['ubicaciones', 'Ubicaciones de almacen'],
      ['inventario', 'Inventario'],
      ['movimientos', 'Movimientos de inventario'],
      ['kardex', 'Kardex'],
      ['auditoria', 'Auditoria'],
      ['reportes', 'Reportes'],
      ['clientes', 'Clientes'],
      ['proveedores', 'Proveedores'],
      ['compras', 'Compras'],
      ['ventas', 'Ventas'],
      ['pedidos', 'Pedidos'],
      ['facturas', 'Facturas'],
      ['notificaciones', 'Notificaciones'],
      ['despliegues', 'Despliegues'],
      ['tickets', 'Tickets de ejecucion'],
    ] as const;

    return catalog
      .filter(([term]) => normalized.includes(term))
      .map(([, name]) => name);
  }

  private isInvalidEntityName(value: string): boolean {
    const normalized = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    return (
      /^\d+(\.\d+)*\s+/.test(normalized) ||
      /^(resumen|logica|reglas|arquitectura|stack|estructura|diagramas|criterios|dudas|objetivo|alcance|resultado|riesgos|pendientes)\b/.test(
        normalized,
      ) ||
      normalized.includes('reglas de negocio recomendadas') ||
      normalized.length > 48
    );
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
- Shell frontend transaccional: sidebar/menu por modulo, dashboard ejecutivo, vista propia por modulo, tabla, buscador, formulario y acciones de estado/eliminacion.
- Prohibido entregar solo cards, contadores, listas genericas o documentacion como interfaz final.
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

  private toCamelCase(value: string): string {
    const className = this.toClassName(value);
    return `${className.charAt(0).toLowerCase()}${className.slice(1)}`;
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
