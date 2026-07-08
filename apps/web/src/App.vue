<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Bell,
  Check,
  ChevronLeft,
  Code2,
  Database,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  ShieldCheck,
  Upload,
  X,
} from '@lucide/vue'

type AgentKey = 'analysis' | 'developer' | 'tester' | 'deployment'
type AgentStatus = 'Inicializado' | 'Procesando' | 'Sugiriendo' | 'Finalizado' | 'Levantado'
type ProjectMode = 'new' | 'existing'
type ProjectTarget = 'web' | 'executable' | 'unknown'

interface AgentState {
  key: AgentKey
  status: AgentStatus
  summary: string
  updatedAt: string
}

interface ProjectNotification {
  id: string
  agentKey: AgentKey
  level: 'info' | 'warning' | 'approval'
  message: string
  status: 'open' | 'resolved'
  createdAt: string
}

interface DevelopmentTicket {
  id: string
  title: string
  status: string
  prompt: string
  summary: string
  filePath?: string
  createdAt: string
}

interface DeploymentInfo {
  id: string
  port: number
  url: string
  username: string
  password: string
  status: string
  command: string
  logs: string
  createdAt: string
}

interface ProjectSnapshot {
  id: string
  name: string
  slug: string
  mode: ProjectMode
  targetType: ProjectTarget
  projectPath: string
  sqlitePath: string
  rulesPath: string
  agents: AgentState[]
  notifications: ProjectNotification[]
  latestTicket?: DevelopmentTicket
  latestDeployment?: DeploymentInfo
  hasTestingReport: boolean
  documentCount: number
  createdAt: string
  updatedAt: string
}

interface RunAgentResult {
  project: ProjectSnapshot
  output: string
  reportPath?: string
  ticket?: DevelopmentTicket
  deployment?: DeploymentInfo
}

interface DirectoryEntry {
  name: string
  path: string
}

interface DirectoryBrowserResult {
  current: string
  parent?: string
  roots: string[]
  directories: DirectoryEntry[]
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3100/api'

const agents = [
  { key: 'analysis', order: '01', name: 'Agente 1', title: 'Levantamiento', icon: Search },
  { key: 'developer', order: '02', name: 'Agente 2', title: 'Desarrollo', icon: Code2 },
  { key: 'tester', order: '03', name: 'Agente 3', title: 'Testing', icon: ShieldCheck },
  { key: 'deployment', order: '04', name: 'Agente 4', title: 'Despliegue', icon: Rocket },
] as const

const defaultTextByAgent: Record<AgentKey, string> = {
  analysis: '',
  developer: '',
  tester: '',
  deployment: '',
}

const agentLogSteps: Record<AgentKey, (projectName: string) => string[]> = {
  analysis: (projectName) => [
    `Analizando archivos del proyecto ${projectName}.`,
    'Verificando reglas iniciales para levantamiento de informacion.',
    'Leyendo documentos cargados para enriquecer el contexto.',
    'Identificando variantes de negocio y flujos detectados.',
    'Actualizando business-rules.md y memoria SQLite del proyecto.',
    'Pensando con el modelo configurado.',
  ],
  developer: (projectName) => [
    `Leyendo reglas de negocio de ${projectName}.`,
    'Interpretando el prompt del usuario y alcance del cambio.',
    'Infiriendo si el proyecto requiere salida web o ejecutable.',
    'Creando ticket de ejecucion para trazabilidad.',
    'Preparando archivos o instrucciones de cambio.',
    'Pensando con el modelo configurado.',
  ],
  tester: (projectName) => [
    `Revisando estructura del proyecto ${projectName}.`,
    'Verificando seguridad, escalabilidad y arquitectura.',
    'Contrastando reglas de negocio contra el ultimo ticket.',
    'Preparando checklist de mejoras para el Agente 2.',
    'Generando reporte descargable de testing.',
    'Pensando con el modelo configurado.',
  ],
  deployment: (projectName) => [
    `Preparando despliegue del proyecto ${projectName}.`,
    'Buscando un puerto disponible para evitar choques.',
    'Detectando comandos y dependencias necesarias.',
    'Configurando usuario y contrasena default.',
    'Levantando ambiente local.',
    'Pensando con el modelo configurado.',
  ],
}

const projects = ref<ProjectSnapshot[]>([])
const selectedProjectId = ref('')
const activeAgent = ref<AgentKey>('analysis')
const runningAgent = ref<AgentKey | null>(null)
const loadingProjects = ref(false)
const creatingProject = ref(false)
const errorMessage = ref('')
const outputByAgent = reactive<Record<AgentKey, string>>({ ...defaultTextByAgent })
const promptByAgent = reactive<Record<AgentKey, string>>({ ...defaultTextByAgent })
const liveLogs = reactive<Record<AgentKey, string[]>>({
  analysis: [],
  developer: [],
  tester: [],
  deployment: [],
})
const pendingDocuments = ref<Array<{ name: string; content: string }>>([])
let liveLogTimer: number | undefined

const createForm = reactive<{
  name: string
  mode: ProjectMode
  path: string
  businessRules: string
}>({
  name: '',
  mode: 'new',
  path: '',
  businessRules: '',
})

const directoryPicker = reactive<{
  open: boolean
  loading: boolean
  current: string
  parent?: string
  roots: string[]
  directories: DirectoryEntry[]
  error: string
}>({
  open: false,
  loading: false,
  current: '',
  parent: undefined,
  roots: [],
  directories: [],
  error: '',
})

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value),
)

const activeAgentMeta = computed(() => agents.find((agent) => agent.key === activeAgent.value))

const canRunAgent = computed(() => Boolean(selectedProject.value && !runningAgent.value))

const currentOutput = computed(() => outputByAgent[activeAgent.value])

const activeLogs = computed(() => liveLogs[activeAgent.value])

const outputText = computed(() => {
  if (runningAgent.value === activeAgent.value && !currentOutput.value) {
    return 'Pensando...'
  }
  return currentOutput.value || agentState(activeAgent.value).summary || 'Sin ejecuciones todavia.'
})

const pathLabel = computed(() =>
  createForm.mode === 'new' ? 'Carpeta base' : 'Carpeta del proyecto',
)

onMounted(() => {
  void loadProjects()
})

async function loadProjects(preferredProjectId?: string) {
  loadingProjects.value = true
  errorMessage.value = ''
  try {
    projects.value = await api<ProjectSnapshot[]>('/projects')
    if (preferredProjectId) {
      selectedProjectId.value = preferredProjectId
    } else if (!selectedProject.value && projects.value.length) {
      selectedProjectId.value = projects.value[0].id
    }
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  } finally {
    loadingProjects.value = false
  }
}

async function createProject() {
  const name = createForm.name.trim() || inferNameFromPath(createForm.path)
  if (createForm.mode === 'new' && !name) {
    errorMessage.value = 'Asigna un nombre al proyecto.'
    return
  }
  if (!createForm.path.trim()) {
    errorMessage.value =
      createForm.mode === 'new'
        ? 'Selecciona la carpeta base donde se creara el proyecto.'
        : 'Selecciona la carpeta donde esta el proyecto existente.'
    return
  }

  creatingProject.value = true
  errorMessage.value = ''
  try {
    const project = await api<ProjectSnapshot>('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name,
        mode: createForm.mode,
        path: createForm.path.trim(),
        targetType: 'unknown',
        businessRules:
          createForm.mode === 'new' ? createForm.businessRules.trim() || undefined : undefined,
      }),
    })
    upsertProject(project)
    selectedProjectId.value = project.id
    createForm.name = ''
    createForm.path = ''
    createForm.businessRules = ''
    activeAgent.value = 'analysis'
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  } finally {
    creatingProject.value = false
  }
}

async function runCurrentAgent() {
  if (!selectedProject.value || runningAgent.value) {
    return
  }
  const agentKey = activeAgent.value
  runningAgent.value = agentKey
  outputByAgent[agentKey] = ''
  errorMessage.value = ''
  startLiveLogs(agentKey)
  try {
    const result = await api<RunAgentResult>(
      `/projects/${selectedProject.value.id}/agents/${agentKey}/run`,
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: promptByAgent[agentKey],
          documents: agentKey === 'analysis' ? pendingDocuments.value : [],
        }),
      },
    )
    upsertProject(result.project)
    outputByAgent[agentKey] = result.output
    appendLiveLog(agentKey, 'Finalizado. Resultado guardado en la memoria del proyecto.')
    if (agentKey === 'analysis') {
      pendingDocuments.value = []
    }
  } catch (error) {
    appendLiveLog(agentKey, 'Se detuvo la ejecucion. Revisa la notificacion o el error mostrado.')
    errorMessage.value = getErrorMessage(error)
  } finally {
    clearLiveLogTimer()
    runningAgent.value = null
  }
}

async function handleDocumentUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  const documents = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      content: await file.text(),
    })),
  )
  pendingDocuments.value = [...pendingDocuments.value, ...documents]
  input.value = ''
}

async function resolveNotification(notificationId: string) {
  if (!selectedProject.value) {
    return
  }
  try {
    const project = await api<ProjectSnapshot>(
      `/projects/${selectedProject.value.id}/notifications/${notificationId}/resolve`,
      { method: 'POST' },
    )
    upsertProject(project)
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  }
}

async function openDirectoryPicker() {
  directoryPicker.open = true
  await loadDirectories(createForm.path || undefined)
}

async function loadDirectories(path?: string) {
  directoryPicker.loading = true
  directoryPicker.error = ''
  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    const result = await api<DirectoryBrowserResult>(`/directories${query}`)
    directoryPicker.current = result.current
    directoryPicker.parent = result.parent
    directoryPicker.roots = result.roots
    directoryPicker.directories = result.directories
  } catch (error) {
    directoryPicker.error = getErrorMessage(error)
  } finally {
    directoryPicker.loading = false
  }
}

function selectCurrentDirectory() {
  createForm.path = directoryPicker.current
  directoryPicker.open = false
}

function downloadReport() {
  if (!selectedProject.value) {
    return
  }
  window.open(
    `${API_BASE}/projects/${selectedProject.value.id}/testing-report/download`,
    '_blank',
    'noopener,noreferrer',
  )
}

function startLiveLogs(agentKey: AgentKey) {
  clearLiveLogTimer()
  const steps = agentLogSteps[agentKey](selectedProject.value?.name ?? 'proyecto')
  liveLogs[agentKey] = []
  appendLiveLog(agentKey, steps[0])
  let index = 1
  liveLogTimer = window.setInterval(() => {
    if (index >= steps.length) {
      clearLiveLogTimer()
      return
    }
    appendLiveLog(agentKey, steps[index])
    index += 1
  }, 950)
}

function appendLiveLog(agentKey: AgentKey, message: string) {
  liveLogs[agentKey] = [...liveLogs[agentKey], message]
}

function clearLiveLogTimer() {
  if (liveLogTimer) {
    window.clearInterval(liveLogTimer)
    liveLogTimer = undefined
  }
}

function upsertProject(project: ProjectSnapshot) {
  const index = projects.value.findIndex((item) => item.id === project.id)
  if (index >= 0) {
    projects.value[index] = project
  } else {
    projects.value = [project, ...projects.value]
  }
}

function agentState(agentKey: AgentKey): AgentState {
  const state = selectedProject.value?.agents.find((agent) => agent.key === agentKey)
  return (
    state ?? {
      key: agentKey,
      status: 'Inicializado',
      summary: '',
      updatedAt: '',
    }
  )
}

function displayStatus(agentKey: AgentKey): AgentStatus {
  return runningAgent.value === agentKey ? 'Procesando' : agentState(agentKey).status
}

function statusClass(status: AgentStatus) {
  const map: Record<AgentStatus, string> = {
    Inicializado: 'status-initialized',
    Procesando: 'status-processing',
    Sugiriendo: 'status-suggesting',
    Finalizado: 'status-finished',
    Levantado: 'status-deployed',
  }
  return map[status]
}

function projectModeLabel(mode: ProjectMode) {
  return mode === 'new' ? 'Nuevo' : 'Existente'
}

function inferNameFromPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? ''
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return 'Ocurrio un error inesperado.'
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try {
      const parsed = JSON.parse(text) as { message?: string | string[] }
      message = Array.isArray(parsed.message)
        ? parsed.message.join(', ')
        : (parsed.message ?? text)
    } catch {
      message = text
    }
    throw new Error(message || response.statusText)
  }
  return (text ? JSON.parse(text) : undefined) as T
}
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <Database :size="20" />
        <div>
          <strong>Agents AI</strong>
          <span>Orquestador</span>
        </div>
      </div>

      <form class="project-form" @submit.prevent="createProject">
        <div class="segmented" aria-label="Modo de proyecto">
          <button
            type="button"
            :class="{ active: createForm.mode === 'new' }"
            @click="createForm.mode = 'new'"
          >
            <Plus :size="16" />
            Nuevo
          </button>
          <button
            type="button"
            :class="{ active: createForm.mode === 'existing' }"
            @click="createForm.mode = 'existing'"
          >
            <FolderOpen :size="16" />
            Existente
          </button>
        </div>

        <label>
          Nombre
          <input v-model="createForm.name" placeholder="Proyecto CRM" />
        </label>

        <label>
          {{ pathLabel }}
          <span class="path-picker">
            <input
              v-model="createForm.path"
              readonly
              placeholder="Selecciona una carpeta"
              @click="openDirectoryPicker"
            />
            <button type="button" title="Explorar carpetas" @click="openDirectoryPicker">
              <FolderOpen :size="17" />
            </button>
          </span>
        </label>

        <label v-if="createForm.mode === 'new'">
          Reglas iniciales
          <textarea v-model="createForm.businessRules" rows="4" />
        </label>

        <button class="primary-action" type="submit" :disabled="creatingProject">
          <Loader2 v-if="creatingProject" class="spin" :size="17" />
          <Plus v-else :size="17" />
          Crear
        </button>
      </form>

      <div class="project-list">
        <div class="section-title">
          <span>Proyectos</span>
          <button type="button" title="Actualizar" @click="loadProjects()">
            <RefreshCw :class="{ spin: loadingProjects }" :size="16" />
          </button>
        </div>
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="project-row"
          :class="{ active: project.id === selectedProjectId }"
          @click="selectedProjectId = project.id"
        >
          <strong>{{ project.name }}</strong>
          <span>{{ projectModeLabel(project.mode) }} · {{ project.documentCount }} docs</span>
        </button>
      </div>
    </aside>

    <section class="workspace">
      <header class="workspace-header">
        <div>
          <p class="eyebrow">Proyecto activo</p>
          <h1>{{ selectedProject?.name ?? 'Selecciona un proyecto' }}</h1>
        </div>
        <div v-if="selectedProject" class="header-meta">
          <span>{{ projectModeLabel(selectedProject.mode) }}</span>
          <span>{{ selectedProject.documentCount }} docs</span>
          <span>{{ selectedProject.projectPath }}</span>
        </div>
      </header>

      <p v-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

      <div v-if="selectedProject?.notifications.length" class="notifications">
        <div
          v-for="notification in selectedProject.notifications"
          :key="notification.id"
          class="notification"
        >
          <Bell :size="17" />
          <span>{{ notification.message }}</span>
          <button type="button" title="Resolver" @click="resolveNotification(notification.id)">
            <Check :size="16" />
          </button>
        </div>
      </div>

      <section class="timeline" aria-label="Linea de tiempo de agentes">
        <button
          v-for="agent in agents"
          :key="agent.key"
          type="button"
          class="agent-card"
          :class="[
            { active: activeAgent === agent.key },
            statusClass(displayStatus(agent.key)),
          ]"
          @click="activeAgent = agent.key"
        >
          <span class="agent-order">{{ agent.order }}</span>
          <span class="agent-icon">
            <component :is="agent.icon" :size="20" />
          </span>
          <span class="agent-copy">
            <strong>{{ agent.name }}</strong>
            <span>{{ agent.title }}</span>
          </span>
          <small>{{ displayStatus(agent.key) }}</small>
        </button>
      </section>

      <section v-if="selectedProject" class="details-grid">
        <article class="agent-panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">{{ activeAgentMeta?.name }}</p>
              <h2>{{ activeAgentMeta?.title }}</h2>
            </div>
            <span class="status-pill" :class="statusClass(displayStatus(activeAgent))">
              {{ displayStatus(activeAgent) }}
            </span>
          </div>

          <div class="path-grid">
            <span>
              <FileText :size="15" />
              {{ selectedProject.rulesPath }}
            </span>
            <span>
              <Database :size="15" />
              {{ selectedProject.sqlitePath }}
            </span>
          </div>

          <label class="prompt-box">
            Prompt adicional
            <textarea v-model="promptByAgent[activeAgent]" rows="7" />
          </label>

          <div v-if="activeAgent === 'analysis'" class="document-upload">
            <label class="file-button">
              <Upload :size="17" />
              Documentos
              <input multiple type="file" @change="handleDocumentUpload" />
            </label>
            <span>{{ pendingDocuments.length }} pendientes</span>
          </div>

          <div class="action-row">
            <button
              class="primary-action"
              type="button"
              :disabled="!canRunAgent"
              @click="runCurrentAgent"
            >
              <Loader2 v-if="runningAgent === activeAgent" class="spin" :size="17" />
              <Play v-else :size="17" />
              Ejecutar
            </button>
            <button
              type="button"
              class="secondary-action"
              :disabled="!selectedProject.hasTestingReport"
              @click="downloadReport"
            >
              <Download :size="17" />
              Reporte
            </button>
          </div>

          <div v-if="selectedProject.latestTicket" class="ticket-box">
            <strong>{{ selectedProject.latestTicket.title }}</strong>
            <span>{{ selectedProject.latestTicket.id }} - {{ selectedProject.latestTicket.status }}</span>
          </div>

          <div v-if="selectedProject.latestDeployment" class="deployment-box">
            <Rocket :size="17" />
            <span>{{ selectedProject.latestDeployment.url }}</span>
            <strong>{{ selectedProject.latestDeployment.username }}</strong>
          </div>
        </article>

        <article class="output-panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Salida</p>
              <h2>Resultado del agente</h2>
            </div>
            <Loader2 v-if="runningAgent === activeAgent" class="spin" :size="18" />
            <Send v-else :size="18" />
          </div>

          <div v-if="activeLogs.length" class="live-log">
            <div v-for="(log, index) in activeLogs" :key="`${log}-${index}`">
              <Loader2
                v-if="runningAgent === activeAgent && index === activeLogs.length - 1"
                class="spin"
                :size="14"
              />
              <Check v-else :size="14" />
              <span>{{ log }}</span>
            </div>
          </div>

          <pre>{{ outputText }}</pre>
        </article>
      </section>
    </section>

    <div v-if="directoryPicker.open" class="modal-backdrop">
      <section class="folder-modal" role="dialog" aria-modal="true" aria-label="Explorador de carpetas">
        <header>
          <div>
            <p class="eyebrow">Explorador local</p>
            <h2>Selecciona carpeta</h2>
          </div>
          <button type="button" title="Cerrar" @click="directoryPicker.open = false">
            <X :size="18" />
          </button>
        </header>

        <div class="folder-toolbar">
          <button
            type="button"
            :disabled="!directoryPicker.parent || directoryPicker.loading"
            @click="loadDirectories(directoryPicker.parent)"
          >
            <ChevronLeft :size="16" />
            Subir
          </button>
          <button
            v-for="root in directoryPicker.roots"
            :key="root"
            type="button"
            :disabled="directoryPicker.loading"
            @click="loadDirectories(root)"
          >
            <HardDrive :size="16" />
            {{ root }}
          </button>
        </div>

        <div class="current-path">{{ directoryPicker.current || 'Cargando carpetas...' }}</div>

        <p v-if="directoryPicker.error" class="error-banner">{{ directoryPicker.error }}</p>

        <div class="folder-list">
          <button
            v-for="directory in directoryPicker.directories"
            :key="directory.path"
            type="button"
            :disabled="directoryPicker.loading"
            @click="loadDirectories(directory.path)"
          >
            <FolderOpen :size="17" />
            <span>{{ directory.name }}</span>
          </button>
        </div>

        <footer>
          <button type="button" class="secondary-action" @click="directoryPicker.open = false">
            Cancelar
          </button>
          <button
            type="button"
            class="primary-action"
            :disabled="!directoryPicker.current"
            @click="selectCurrentDirectory"
          >
            Seleccionar
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>
