<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  Bell,
  Check,
  ChevronLeft,
  Code2,
  Download,
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
  lastRunId?: string
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

interface PendingAttachment {
  name: string
  content: string
  mimeType: string
  kind: 'text' | 'image' | 'file'
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

type ProjectAgentOutput = Partial<Record<AgentKey, string>>
type ProjectAgentLogs = Partial<Record<AgentKey, string[]>>

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
const runningRun = ref<{ projectId: string; agentKey: AgentKey } | null>(null)
const bootingApp = ref(true)
const loadingProjects = ref(false)
const creatingProject = ref(false)
const notificationsOpen = ref(false)
const approvingNotificationId = ref('')
const errorMessage = ref('')
const outputByProjectAgent = reactive<Record<string, ProjectAgentOutput>>({})
const promptByAgent = reactive<Record<AgentKey, string>>({ ...defaultTextByAgent })
const analysisOptions = reactive({
  deepAnalysis: false,
})
const liveLogsByProjectAgent = reactive<Record<string, ProjectAgentLogs>>({})
const pendingDocuments = ref<PendingAttachment[]>([])
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

const canRunAgent = computed(() => Boolean(selectedProject.value && !runningRun.value))

const openNotifications = computed(() => selectedProject.value?.notifications ?? [])

const currentOutput = computed(() => {
  const projectId = selectedProjectId.value
  return projectId ? outputByProjectAgent[projectId]?.[activeAgent.value] ?? '' : ''
})

const activeLogs = computed(() => {
  const projectId = selectedProjectId.value
  return projectId ? liveLogsByProjectAgent[projectId]?.[activeAgent.value] ?? [] : []
})

const isActiveAgentRunning = computed(() => {
  const running = runningRun.value
  return Boolean(
    running &&
      running.projectId === selectedProjectId.value &&
      running.agentKey === activeAgent.value,
  )
})

const canDownloadReport = computed(() => {
  const project = selectedProject.value
  if (!project) {
    return false
  }
  const state = agentState(activeAgent.value)
  const finishedStatus = state.status !== 'Inicializado' && state.status !== 'Procesando'
  return Boolean(
    currentOutput.value.trim() ||
      (state.lastRunId && finishedStatus) ||
      (activeAgent.value === 'tester' && project.hasTestingReport),
  )
})

const outputText = computed(() => {
  if (isActiveAgentRunning.value && !currentOutput.value) {
    return 'Pensando...'
  }
  return currentOutput.value || agentState(activeAgent.value).summary || 'Sin ejecuciones todavia.'
})

const renderedOutput = computed(() => renderMarkdown(outputText.value))

onMounted(() => {
  void loadProjects()
})

watch(selectedProjectId, () => {
  errorMessage.value = ''
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
    if (bootingApp.value) {
      window.setTimeout(() => {
        bootingApp.value = false
      }, 450)
    }
  }
}

async function createProject() {
  const name = createForm.name.trim() || inferNameFromPath(createForm.path)
  if (createForm.mode === 'new' && !name) {
    errorMessage.value = 'Asigna un nombre al proyecto.'
    return
  }
  if (createForm.mode === 'existing' && !createForm.path.trim()) {
    errorMessage.value = 'Selecciona la carpeta donde esta el proyecto existente.'
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
        path: createForm.mode === 'existing' ? createForm.path.trim() : undefined,
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
  const project = selectedProject.value
  if (!project || runningRun.value) {
    return
  }
  const agentKey = activeAgent.value
  const projectId = project.id
  runningRun.value = { projectId, agentKey }
  setProjectOutput(projectId, agentKey, '')
  errorMessage.value = ''
  startLiveLogs(projectId, agentKey, project.name)
  try {
    const payload = {
      prompt: promptByAgent[agentKey],
      documents: pendingDocuments.value,
      deepAnalysis: agentKey === 'analysis' ? analysisOptions.deepAnalysis : undefined,
    }
    const result = await api<RunAgentResult>(
      `/projects/${projectId}/agents/${agentKey}/run`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
    upsertProject(result.project)
    setProjectOutput(result.project.id, agentKey, result.output)
    appendLiveLog(
      result.project.id,
      agentKey,
      'Finalizado. Resultado guardado en la memoria del proyecto.',
    )
    pendingDocuments.value = []
  } catch (error) {
    appendLiveLog(
      projectId,
      agentKey,
      'Se detuvo la ejecucion. Revisa la notificacion o el error mostrado.',
    )
    errorMessage.value = getErrorMessage(error)
  } finally {
    clearLiveLogTimer()
    runningRun.value = null
  }
}

async function handleDocumentUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  const documents = await Promise.all(
    files.map(async (file): Promise<PendingAttachment> => {
      if (isImageFile(file)) {
        return {
          name: file.name,
          content: await readFileAsDataUrl(file),
          mimeType: file.type || inferImageMimeType(file.name),
          kind: 'image',
        }
      }

      return {
        name: file.name,
        content: isTextLikeFile(file) ? await file.text() : unsupportedDocumentContent(file),
        mimeType: file.type || 'text/plain',
        kind: isTextLikeFile(file) ? 'text' : 'file',
      }
    }),
  )
  pendingDocuments.value = [...pendingDocuments.value, ...documents]
  input.value = ''
}

function isImageFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)
}

function inferImageMimeType(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg'
  }
  if (extension === 'webp') {
    return 'image/webp'
  }
  if (extension === 'gif') {
    return 'image/gif'
  }
  return 'image/png'
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer la imagen.'))
    reader.readAsDataURL(file)
  })
}

function isTextLikeFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const textExtensions = new Set([
    'txt',
    'md',
    'markdown',
    'csv',
    'tsv',
    'json',
    'xml',
    'yaml',
    'yml',
    'html',
    'css',
    'scss',
    'js',
    'jsx',
    'ts',
    'tsx',
    'vue',
    'java',
    'kt',
    'py',
    'go',
    'cs',
    'php',
    'rb',
    'sql',
    'prisma',
  ])

  return (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/xml' ||
    textExtensions.has(extension)
  )
}

function unsupportedDocumentContent(file: File) {
  const extension = file.name.split('.').pop()?.toUpperCase() || 'binario'
  return `[Documento ${extension} omitido]
El archivo se cargo como referencia, pero no se envio su contenido binario al analisis. Exporta el contenido a TXT/MD o copia el texto en el prompt para que el agente lo interprete.`
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

async function approveNotification(notification: ProjectNotification) {
  const project = selectedProject.value
  if (!project || runningRun.value) {
    return
  }
  approvingNotificationId.value = notification.id
  runningRun.value = { projectId: project.id, agentKey: notification.agentKey }
  activeAgent.value = notification.agentKey
  setProjectOutput(project.id, notification.agentKey, '')
  errorMessage.value = ''
  startLiveLogs(project.id, notification.agentKey, project.name)
  appendLiveLog(
    project.id,
    notification.agentKey,
    `Aprobacion recibida. Ejecutando: ${notification.message}`,
  )
  try {
    const result = await api<RunAgentResult>(
      `/projects/${project.id}/notifications/${notification.id}/approve`,
      { method: 'POST' },
    )
    upsertProject(result.project)
    setProjectOutput(result.project.id, notification.agentKey, result.output)
    appendLiveLog(
      result.project.id,
      notification.agentKey,
      'Aprobacion ejecutada y resultado guardado.',
    )
  } catch (error) {
    appendLiveLog(project.id, notification.agentKey, 'No se pudo ejecutar la aprobacion.')
    errorMessage.value = getErrorMessage(error)
  } finally {
    clearLiveLogTimer()
    runningRun.value = null
    approvingNotificationId.value = ''
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

function setProjectOutput(projectId: string, agentKey: AgentKey, output: string) {
  outputByProjectAgent[projectId] = {
    ...(outputByProjectAgent[projectId] ?? {}),
    [agentKey]: output,
  }
}

function setProjectLogs(projectId: string, agentKey: AgentKey, logs: string[]) {
  liveLogsByProjectAgent[projectId] = {
    ...(liveLogsByProjectAgent[projectId] ?? {}),
    [agentKey]: logs,
  }
}

async function downloadReport() {
  if (!selectedProject.value) {
    return
  }
  try {
    const response = await fetch(
      `${API_BASE}/projects/${selectedProject.value.id}/agents/${activeAgent.value}/report/download`,
    )
    if (!response.ok) {
      throw new Error(response.statusText || 'No se pudo descargar el reporte.')
    }

    const blob = await response.blob()
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download =
      getFileNameFromDisposition(response.headers.get('Content-Disposition')) ??
      `${selectedProject.value.slug}-${activeAgent.value}-report.pdf`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  }
}

function getFileNameFromDisposition(disposition: string | null) {
  if (!disposition) {
    return undefined
  }
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (encoded?.[1]) {
    return decodeURIComponent(encoded[1])
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i)
  return plain?.[1]
}

function startLiveLogs(projectId: string, agentKey: AgentKey, projectName: string) {
  clearLiveLogTimer()
  const steps = agentLogSteps[agentKey](projectName)
  if (agentKey === 'analysis' && analysisOptions.deepAnalysis) {
    steps.splice(1, 0, 'Ejecutando analisis profundo sobre la estructura completa del proyecto.')
  }
  setProjectLogs(projectId, agentKey, [])
  appendLiveLog(projectId, agentKey, steps[0])
  let index = 1
  liveLogTimer = window.setInterval(() => {
    if (index >= steps.length) {
      clearLiveLogTimer()
      return
    }
    appendLiveLog(projectId, agentKey, steps[index])
    index += 1
  }, 950)
}

function appendLiveLog(projectId: string, agentKey: AgentKey, message: string) {
  const currentLogs = liveLogsByProjectAgent[projectId]?.[agentKey] ?? []
  setProjectLogs(projectId, agentKey, [...currentLogs, message])
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
  const running = runningRun.value
  return running?.projectId === selectedProjectId.value && running.agentKey === agentKey
    ? 'Procesando'
    : agentState(agentKey).status
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
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

function renderMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let inCode = false
  let codeLines: string[] = []

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  const ensureList = (type: 'ul' | 'ol') => {
    if (listType === type) {
      return
    }
    closeList()
    listType = type
    html.push(`<${type}>`)
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCode) {
        html.push(renderCodeBlock(codeLines.join('\n')))
        codeLines = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }

    if (inCode) {
      codeLines.push(rawLine)
      continue
    }

    if (!trimmed) {
      closeList()
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      closeList()
      const level = Math.min(heading[1].length + 1, 4)
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      ensureList('ul')
      html.push(`<li>${renderInline(bullet[1])}</li>`)
      continue
    }

    const numbered = trimmed.match(/^\d+\.\s+(.+)$/)
    if (numbered) {
      ensureList('ol')
      html.push(`<li>${renderInline(numbered[1])}</li>`)
      continue
    }

    const quote = trimmed.match(/^>\s+(.+)$/)
    if (quote) {
      closeList()
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`)
      continue
    }

    closeList()
    html.push(`<p>${renderInline(trimmed)}</p>`)
  }

  closeList()
  if (inCode) {
    html.push(renderCodeBlock(codeLines.join('\n')))
  }
  return html.join('')
}

function renderCodeBlock(value: string) {
  return `<div class="code-block"><button class="copy-code" type="button" data-copy="${escapeHtml(
    encodeURIComponent(value),
  )}">Copiar</button><pre><code>${escapeHtml(value)}</code></pre></div>`
}

async function handleMarkdownClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : undefined
  const button = target?.closest<HTMLButtonElement>('[data-copy]')
  if (!button) {
    return
  }

  const text = decodeURIComponent(button.dataset.copy ?? '')
  try {
    await navigator.clipboard.writeText(text)
    const previous = button.textContent || 'Copiar'
    button.textContent = 'Copiado'
    window.setTimeout(() => {
      button.textContent = previous
    }, 1200)
  } catch {
    button.textContent = 'Error'
    window.setTimeout(() => {
      button.textContent = 'Copiar'
    }, 1200)
  }
}

function renderInline(value: string) {
  return value
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      }
      return escapeHtml(part).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    })
    .join('')
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
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
    <div v-if="bootingApp" class="app-loader" role="status" aria-live="polite">
      <section class="loader-content" aria-label="Cargando Nexus Agents">
        <span class="brand-mark loader-mark" aria-hidden="true">
          <span>NA</span>
        </span>
        <p class="eyebrow">Orquestador IA</p>
        <h1>Nexus Agents</h1>
        <p class="loader-copy">Cargando</p>
        <div class="loader-progress" aria-hidden="true">
          <span></span>
        </div>
      </section>
    </div>

    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <span>NA</span>
        </span>
        <div>
          <strong>Nexus Agents</strong>
          <span>AI Delivery Console</span>
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

        <label v-if="createForm.mode === 'new'">
          Nombre
          <input v-model="createForm.name" placeholder="Proyecto CRM" />
        </label>

        <label v-if="createForm.mode === 'existing'">
          Carpeta del proyecto
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
          <span>{{ formatDate(project.createdAt) }}</span>
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
          <span>{{ formatDate(selectedProject.createdAt) }}</span>
        </div>
      </header>

      <p v-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

      <section v-if="selectedProject" class="notification-center">
        <button
          type="button"
          class="notification-toggle"
          :class="{ active: notificationsOpen }"
          @click="notificationsOpen = !notificationsOpen"
        >
          <Bell :size="17" />
          <span>Notificaciones</span>
          <strong>{{ openNotifications.length }}</strong>
        </button>

        <div v-if="notificationsOpen" class="notifications">
          <div v-if="!openNotifications.length" class="notification empty">
            <Check :size="17" />
            <span>No hay notificaciones pendientes.</span>
          </div>
          <article
            v-for="notification in openNotifications"
            :key="notification.id"
            class="notification"
            :class="`level-${notification.level}`"
          >
            <Bell :size="17" />
            <div>
              <strong>{{ agents.find((agent) => agent.key === notification.agentKey)?.title }}</strong>
              <span>{{ notification.message }}</span>
            </div>
            <div class="notification-actions">
              <button
                type="button"
                class="approve-action"
                :disabled="Boolean(runningRun)"
                @click="approveNotification(notification)"
              >
                <Loader2
                  v-if="approvingNotificationId === notification.id"
                  class="spin"
                  :size="15"
                />
                <Check v-else :size="15" />
                Aprobar
              </button>
              <button
                type="button"
                class="icon-action"
                title="Descartar"
                @click="resolveNotification(notification.id)"
              >
                <X :size="15" />
              </button>
            </div>
          </article>
        </div>
      </section>

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

          <label class="prompt-box">
            Prompt adicional
            <textarea v-model="promptByAgent[activeAgent]" rows="7" />
          </label>

          <label v-if="activeAgent === 'analysis'" class="check-option">
            <input v-model="analysisOptions.deepAnalysis" type="checkbox" />
            <span>Analisis profundo</span>
          </label>

          <div class="document-upload">
            <label class="file-button">
              <Upload :size="17" />
              Adjuntos / imagenes
              <input multiple type="file" accept="image/*,.txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.vue,.java,.sql,.prisma" @change="handleDocumentUpload" />
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
              <Loader2 v-if="isActiveAgentRunning" class="spin" :size="17" />
              <Play v-else :size="17" />
              Ejecutar
            </button>
            <button
              type="button"
              class="secondary-action"
              :disabled="!canDownloadReport"
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
            <Loader2 v-if="isActiveAgentRunning" class="spin" :size="18" />
            <Send v-else :size="18" />
          </div>

          <div v-if="activeLogs.length" class="live-log">
            <div v-for="(log, index) in activeLogs" :key="`${log}-${index}`">
              <Loader2
                v-if="isActiveAgentRunning && index === activeLogs.length - 1"
                class="spin"
                :size="14"
              />
              <Check v-else :size="14" />
              <span>{{ log }}</span>
            </div>
          </div>

          <div class="markdown-view" v-html="renderedOutput" @click="handleMarkdownClick"></div>
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
