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
    const requestDir = join(project.projectPath, '.agents-ai', 'change-requests');
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

    return {
      summary:
        'Se genero un brief de cambio para el proyecto existente sin sobrescribir archivos del usuario.',
      files: [filePath],
      commands: [],
    };
  }

  private createWebWorkspace(
    project: ProjectRecord,
    prompt: string,
    rules: string,
  ): ScaffoldResult {
    const files: string[] = [];
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
      this.writeIfMissing(
        join(project.projectPath, 'README.md'),
        `# ${project.name}

Proyecto web generado por el orquestador de agentes IA.

## Solicitud inicial

${prompt || 'Sin prompt adicional.'}

## Reglas iniciales

${rules || 'Pendiente de confirmar reglas de negocio.'}
`,
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
      this.writeIfMissing(
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
      this.writeIfMissing(
        join(project.projectPath, 'apps/api/src/app.module.ts'),
        `import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
})
export class AppModule {}
`,
      ),
    );

    files.push(
      this.writeIfMissing(
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
              '@vitejs/plugin-vue': '^6.0.7',
              vite: '^8.1.1',
              vue: '^3.5.39',
            },
            devDependencies: {
              typescript: '~6.0.2',
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
        join(project.projectPath, 'apps/web/src/main.ts'),
        `import { createApp } from 'vue';
import './style.css';
import App from './App.vue';

createApp(App).mount('#app');
`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'apps/web/src/App.vue'),
        `<script setup lang="ts">
import { ref } from 'vue';

const username = ref('admin');
const password = ref('Admin123!');
const authenticated = ref(false);
const message = ref('');

async function login() {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.value, password: password.value }),
  });
  const result = await response.json();
  authenticated.value = Boolean(result.authenticated);
  message.value = authenticated.value ? 'Acceso concedido' : 'Credenciales invalidas';
}
</script>

<template>
  <main class="shell">
    <section class="panel">
      <p class="eyebrow">${project.name}</p>
      <h1>Panel operativo</h1>
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
      <div v-else class="status">
        <strong>Sesion activa</strong>
        <span>admin puede cambiar sus datos desde el modulo de usuarios.</span>
      </div>
      <p class="message">{{ message }}</p>
    </section>
  </main>
</template>
`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'apps/web/src/style.css'),
        `:root {
  color: #17202a;
  background: #f6f7f9;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

body {
  margin: 0;
}

.shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.panel {
  width: min(460px, 100%);
  border: 1px solid #d7dce2;
  border-radius: 8px;
  padding: 28px;
  background: #fff;
  box-shadow: 0 18px 45px rgba(23, 32, 42, 0.08);
}

.eyebrow {
  margin: 0 0 8px;
  color: #3d6f8f;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 22px;
  font-size: 28px;
}

.login {
  display: grid;
  gap: 14px;
}

label {
  display: grid;
  gap: 6px;
  font-size: 14px;
  font-weight: 700;
}

input {
  min-height: 40px;
  border: 1px solid #c9d1da;
  border-radius: 6px;
  padding: 0 12px;
}

button {
  min-height: 42px;
  border: 0;
  border-radius: 6px;
  background: #1f6f5b;
  color: white;
  font-weight: 700;
}

.status {
  display: grid;
  gap: 6px;
  color: #1f6f5b;
}

.message {
  min-height: 20px;
  margin-top: 14px;
}
`,
      ),
    );

    return {
      summary:
        'Se genero una base web con API NestJS, app Vue y login inicial admin/Admin123!.',
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
      this.writeIfMissing(
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
      this.writeIfMissing(
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
      this.writeIfMissing(
        join(project.projectPath, 'src/main/resources/application.properties'),
        `spring.application.name=${project.slug}
server.port=\${PORT:8080}
`,
      ),
    );

    files.push(
      this.writeIfMissing(
        join(project.projectPath, 'README.md'),
        `# ${project.name}

Proyecto ejecutable Java generado por el orquestador de agentes IA.

## Solicitud inicial

${prompt || 'Sin prompt adicional.'}

## Reglas iniciales

${rules || 'Pendiente de confirmar reglas de negocio.'}

## Comandos

\`\`\`bash
mvn -DskipTests package
java -jar target/${project.slug}-0.1.0.jar
\`\`\`
`,
      ),
    );

    return {
      summary:
        'Se genero una base Java Spring Boot empaquetable como jar con endpoints de salud y login.',
      files,
      commands: ['mvn -DskipTests package', `java -jar target/${project.slug}-0.1.0.jar`],
    };
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
}
