import axios from 'axios'

// Local dev: VITE_API_BASE_URL is unset, so this resolves to '/api' —
// the same relative path the Vite dev server proxy has always handled
// (see vite.config.js), unchanged from before.
// Production (e.g. Vercel): set VITE_API_BASE_URL to the deployed
// backend's origin (e.g. https://your-backend.fly.dev) so the built
// frontend calls it directly. That's a cross-origin call, which is why
// the backend's ALLOWED_ORIGINS needs to include the frontend's origin.
const API_BASE = `${import.meta.env.VITE_API_BASE_URL || ''}/api`

// withCredentials: true is required so the httpOnly auth cookies the
// backend sets on login are actually sent back on every request (and so
// Set-Cookie from /auth/login and /auth/refresh is honored in the first
// place) — without it every request is anonymous and gets 401.
const api = axios.create({ baseURL: API_BASE, withCredentials: true })

// Registered by AuthProvider so a 401 from any call (session expired,
// cookie cleared) can clear the in-memory user and bounce to /login.
// Login failures (wrong password) and the initial /auth/me probe are
// expected to 401 sometimes and must not trigger this.
let onUnauthorized = null
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || ''
    if (error.response?.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/me')) {
      onUnauthorized?.()
    }
    return Promise.reject(error)
  },
)

// Auth
export const login = (email, password) => api.post('/auth/login', { email, password }).then((r) => r.data)
export const logout = () => api.post('/auth/logout').then((r) => r.data)
export const getMe = () => api.get('/auth/me').then((r) => r.data)
export const changePassword = (currentPassword, newPassword) =>
  api
    .post('/auth/change-password', { current_password: currentPassword, new_password: newPassword })
    .then((r) => r.data)

// Projects
export const listProjects = (includeArchived = false) =>
  api.get('/projects', { params: { include_archived: includeArchived } }).then((r) => r.data)
export const createProject = (name, projectType = 'simple', projectCategory = null, projectCode = null) =>
  api
    .post('/projects', { name, project_type: projectType, project_category: projectCategory, project_code: projectCode })
    .then((r) => r.data)
export const getProject = (slug) => api.get(`/projects/${slug}`).then((r) => r.data)
export const archiveProject = (slug, archived, password) =>
  api.put(`/projects/${slug}/archive`, { archived, password }).then((r) => r.data)
export const deleteProject = (slug, password) =>
  api.delete(`/projects/${slug}`, { data: { password } }).then((r) => r.data)
// Project Settings — currently just the Running Code Generator's PJ prefix.
export const updateProjectSettings = (slug, payload) =>
  api.put(`/projects/${slug}/settings`, payload).then((r) => r.data)

// Running Code Generator
export const previewNextCode = (slug, entityType) =>
  api.get(`/${slug}/next-code-preview`, { params: { entity_type: entityType } }).then((r) => r.data.code)

// Generic per-entity helpers, entity = 'functions' | 'tasks' | 'gantt'
export const listItems = (slug, entity) => api.get(`/${slug}/${entity}`).then((r) => r.data)
export const createItem = (slug, entity, payload) =>
  api.post(`/${slug}/${entity}`, payload).then((r) => r.data)
export const updateItem = (slug, entity, id, payload) =>
  api.put(`/${slug}/${entity}/${id}`, payload).then((r) => r.data)
export const deleteItem = (slug, entity, id) =>
  api.delete(`/${slug}/${entity}/${id}`).then((r) => r.data)
export const cloneItem = (slug, entity, id) =>
  api.post(`/${slug}/${entity}/${id}/clone`).then((r) => r.data)

export const importTemplateUrl = (slug, entity) => `${API_BASE}/${slug}/${entity}/import-template`
export const exportUrl = (slug, entity) => `${API_BASE}/${slug}/${entity}/export`

export const importItems = (slug, entity, file) => {
  const form = new FormData()
  form.append('file', file)
  // Do not set Content-Type here. The browser must add the multipart boundary;
  // a bare "multipart/form-data" header can make FastAPI reject the upload.
  return api.post(`/${slug}/${entity}/import`, form).then((r) => r.data)
}

// Documents
export const getDocument = (slug, id) => api.get(`/${slug}/documents/${id}`).then((r) => r.data)
export const submitDocumentForReview = (slug, id) =>
  api.post(`/${slug}/documents/${id}/submit-review`).then((r) => r.data)
export const signoffDocument = (slug, id, payload) =>
  api.post(`/${slug}/documents/${id}/signoff`, payload).then((r) => r.data)
export const listSignoffs = (slug, id) => api.get(`/${slug}/documents/${id}/signoffs`).then((r) => r.data)
export const uploadDocumentFile = (slug, id, file) => {
  const form = new FormData()
  form.append('file', file)
  return api
    .post(`/${slug}/documents/upload/${id}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data)
}
export const listSuggestedDocuments = (slug) => api.get(`/${slug}/documents/suggested`).then((r) => r.data)
export const addDocumentFromTemplate = (slug, docCode) =>
  api.post(`/${slug}/documents/from-template/${docCode}`).then((r) => r.data)

// Search
export const search = (slug, q) => api.get(`/${slug}/search`, { params: { q } }).then((r) => r.data)

// Comments
export const listComments = (slug, entityType, entityId) =>
  api.get(`/${slug}/comments`, { params: { entity_type: entityType, entity_id: entityId } }).then((r) => r.data)
export const createComment = (slug, entityType, entityId, content, createdBy) =>
  api
    .post(`/${slug}/comments`, { entity_type: entityType, entity_id: entityId, content, created_by: createdBy })
    .then((r) => r.data)
export const deleteComment = (slug, id) => api.delete(`/${slug}/comments/${id}`).then((r) => r.data)

// Activity log
export const listActivity = (slug, entityType, entityId) =>
  api.get(`/${slug}/activity`, { params: { entity_type: entityType, entity_id: entityId } }).then((r) => r.data)

// Notes
export const listNotes = (slug, status) => api.get(`/${slug}/notes`, { params: { status } }).then((r) => r.data)
export const createNote = (slug, content) => api.post(`/${slug}/notes`, { content }).then((r) => r.data)
export const deleteNote = (slug, id) => api.delete(`/${slug}/notes/${id}`).then((r) => r.data)
export const promoteNoteToTask = (slug, id) => api.post(`/${slug}/notes/${id}/promote-task`).then((r) => r.data)
export const promoteNoteToIssue = (slug, id) => api.post(`/${slug}/notes/${id}/promote-issue`).then((r) => r.data)

// Effort Calculator (Function Point model)
export const getEffortConfig = (slug) => api.get(`/${slug}/effort-config`).then((r) => r.data)
export const updateEffortConfig = (slug, payload) => api.put(`/${slug}/effort-config`, payload).then((r) => r.data)
export const getEffortDrivers = (slug) => api.get(`/${slug}/effort-drivers`).then((r) => r.data)
export const calculateEffort = (slug, payload) =>
  api.post(`/${slug}/effort-estimates/calculate`, payload).then((r) => r.data)
export const listEffortEstimates = (slug, entityType, entityId) =>
  api
    .get(`/${slug}/effort-estimates`, {
      params: { linked_entity_type: entityType, linked_entity_id: entityId },
    })
    .then((r) => r.data)
export const createEffortEstimate = (slug, payload) =>
  api.post(`/${slug}/effort-estimates`, payload).then((r) => r.data)
export const updateEffortEstimate = (slug, id, payload) =>
  api.put(`/${slug}/effort-estimates/${id}`, payload).then((r) => r.data)
export const deleteEffortEstimate = (slug, id) =>
  api.delete(`/${slug}/effort-estimates/${id}`).then((r) => r.data)
export const getEffortSummary = (slug) => api.get(`/${slug}/effort-estimates/summary`).then((r) => r.data)
export const getEffortBudget = (slug) => api.get(`/${slug}/effort-budget`).then((r) => r.data)

// Change Requests
export const listChangeRequests = (slug, status) =>
  api.get(`/${slug}/change-requests`, { params: { status } }).then((r) => r.data)
export const getChangeRequest = (slug, id) => api.get(`/${slug}/change-requests/${id}`).then((r) => r.data)
export const createChangeRequest = (slug, payload) =>
  api.post(`/${slug}/change-requests`, payload).then((r) => r.data)
export const updateChangeRequest = (slug, id, payload) =>
  api.put(`/${slug}/change-requests/${id}`, payload).then((r) => r.data)
export const deleteChangeRequest = (slug, id) => api.delete(`/${slug}/change-requests/${id}`).then((r) => r.data)
export const listCrImpacts = (slug, id) => api.get(`/${slug}/change-requests/${id}/impacts`).then((r) => r.data)
export const addCrImpact = (slug, id, payload) =>
  api.post(`/${slug}/change-requests/${id}/impacts`, payload).then((r) => r.data)
export const deleteCrImpact = (slug, id, impactId) =>
  api.delete(`/${slug}/change-requests/${id}/impacts/${impactId}`).then((r) => r.data)
export const getCrImpact = (slug, id) => api.get(`/${slug}/change-requests/${id}/impact`).then((r) => r.data)
export const submitCrForApproval = (slug, id) =>
  api.post(`/${slug}/change-requests/${id}/submit-for-approval`).then((r) => r.data)
export const crImpactExportUrl = (slug, id) =>
  `${API_BASE}/${slug}/change-requests/${id}/impact-analysis-export`

// Progress Matrix (Yotei-Jisseki plan-vs-actual chart)
export const getProgressMatrix = (slug, { entityTypes, phase, owner, from, to } = {}) =>
  api
    .get(`/${slug}/progress-matrix`, {
      params: {
        entity_type: entityTypes?.length ? entityTypes.join(',') : undefined,
        phase: phase || undefined,
        owner: owner || undefined,
        from: from || undefined,
        to: to || undefined,
      },
    })
    .then((r) => r.data)
export const getProgressMatrixLegend = (slug) => api.get(`/${slug}/progress-matrix/legend`).then((r) => r.data)
export const getProgressMatrixCalendar = (slug, from, to) =>
  api.get(`/${slug}/progress-matrix/calendar`, { params: { from, to } }).then((r) => r.data)
export const getPlanDates = (slug, entityType, entityId) =>
  api.get(`/${slug}/plan-dates/${entityType}/${entityId}`).then((r) => r.data)
export const setPlanDates = (slug, payload) => api.put(`/${slug}/plan-dates`, payload).then((r) => r.data)
export const getActualOverride = (slug, entityType, entityId) =>
  api.get(`/${slug}/actual-overrides/${entityType}/${entityId}`).then((r) => r.data)
export const setActualOverride = (slug, payload) =>
  api.put(`/${slug}/actual-overrides`, payload).then((r) => r.data)
export const clearActualOverride = (slug, entityType, entityId) =>
  api.delete(`/${slug}/actual-overrides/${entityType}/${entityId}`).then((r) => r.data)

// Note System (markdown wiki pages — distinct from the quick notes above)
export const listNotePages = (slug, { tag, q } = {}) =>
  api.get(`/${slug}/note-pages`, { params: { tag, q } }).then((r) => r.data)
export const getNotePage = (slug, id) => api.get(`/${slug}/note-pages/${id}`).then((r) => r.data)
export const createNotePage = (slug, payload) => api.post(`/${slug}/note-pages`, payload).then((r) => r.data)
export const updateNotePage = (slug, id, payload) =>
  api.put(`/${slug}/note-pages/${id}`, payload).then((r) => r.data)
export const deleteNotePage = (slug, id) => api.delete(`/${slug}/note-pages/${id}`).then((r) => r.data)
export const listNoteBacklinks = (slug, id) =>
  api.get(`/${slug}/note-pages/${id}/backlinks`).then((r) => r.data)
export const listTags = (slug) => api.get(`/${slug}/tags`).then((r) => r.data)
export const moveNoteTag = (slug, id, fromTag, toTag) =>
  api.put(`/${slug}/note-pages/${id}/tags/move`, { from_tag: fromTag, to_tag: toTag }).then((r) => r.data)
export const listLinkedNotes = (slug, entityType, entityId) =>
  api.get(`/${slug}/${entityType}/${entityId}/linked-notes`).then((r) => r.data)
export const linkNoteToEntity = (slug, entityType, entityId, payload) =>
  api.post(`/${slug}/${entityType}/${entityId}/link-note`, payload).then((r) => r.data)

// Board Items (Issue / Incident / Backlog)
export const listBoardItems = (slug, type, filters = {}) =>
  api.get(`/${slug}/board-items`, { params: { type, ...filters } }).then((r) => r.data)
export const createBoardItem = (slug, payload) =>
  api.post(`/${slug}/board-items`, payload).then((r) => r.data)
export const updateBoardItem = (slug, id, payload) =>
  api.put(`/${slug}/board-items/${id}`, payload).then((r) => r.data)
export const deleteBoardItem = (slug, id) => api.delete(`/${slug}/board-items/${id}`).then((r) => r.data)
export const promoteBoardItem = (slug, id, targetType) =>
  api.post(`/${slug}/board-items/${id}/promote`, { target_type: targetType }).then((r) => r.data)
export const boardExportUrl = (slug, type) => `${API_BASE}/${slug}/board-items/export?type=${type}`

// Reports
export const reportUrl = (slug, type, params = {}) => {
  const qs = new URLSearchParams(params).toString()
  return `${API_BASE}/${slug}/reports/${type}${qs ? `?${qs}` : ''}`
}

// Whiteboards
export const listWhiteboards = (slug, linkedEntityType, linkedEntityId) =>
  api
    .get(`/${slug}/whiteboards`, {
      params: { linked_entity_type: linkedEntityType, linked_entity_id: linkedEntityId },
    })
    .then((r) => r.data)
export const getWhiteboard = (slug, id) => api.get(`/${slug}/whiteboards/${id}`).then((r) => r.data)
export const createWhiteboard = (slug, payload) =>
  api.post(`/${slug}/whiteboards`, payload).then((r) => r.data)
export const updateWhiteboard = (slug, id, payload) =>
  api.put(`/${slug}/whiteboards/${id}`, payload).then((r) => r.data)
export const deleteWhiteboard = (slug, id) => api.delete(`/${slug}/whiteboards/${id}`).then((r) => r.data)

// Auto-Diagram Generators
export const generateErdDiagram = (slug) => api.get(`/${slug}/diagrams/erd`).then((r) => r.data)
export const generateDocumentWorkflowDiagram = (slug) =>
  api.get(`/${slug}/diagrams/workflow/document-status`).then((r) => r.data)
export const generateBoardItemWorkflowDiagram = (slug) =>
  api.get(`/${slug}/diagrams/workflow/board-item-promote`).then((r) => r.data)

// Gantt Annotations
export const listGanttAnnotations = (slug) => api.get(`/${slug}/gantt-annotations`).then((r) => r.data)
export const createGanttAnnotation = (slug, payload) =>
  api.post(`/${slug}/gantt-annotations`, payload).then((r) => r.data)
export const updateGanttAnnotation = (slug, id, payload) =>
  api.put(`/${slug}/gantt-annotations/${id}`, payload).then((r) => r.data)
export const deleteGanttAnnotation = (slug, id) =>
  api.delete(`/${slug}/gantt-annotations/${id}`).then((r) => r.data)

// Resources (global — not tied to a project slug)
export const listResources = () => api.get('/resources').then((r) => r.data)
export const createResource = (payload) => api.post('/resources', payload).then((r) => r.data)
export const updateResource = (id, payload) => api.put(`/resources/${id}`, payload).then((r) => r.data)
export const deleteResource = (id) => api.delete(`/resources/${id}`).then((r) => r.data)
export const getResourceUtilization = (from, to) =>
  api.get('/resources/utilization', { params: { from, to } }).then((r) => r.data)

// Resource Allocations (per-project, but backed by the global resource pool)
export const listAllocations = (slug) => api.get(`/${slug}/resource-allocations`).then((r) => r.data)
export const createAllocation = (slug, payload) =>
  api.post(`/${slug}/resource-allocations`, payload).then((r) => r.data)
export const updateAllocation = (slug, id, payload) =>
  api.put(`/${slug}/resource-allocations/${id}`, payload).then((r) => r.data)
export const deleteAllocation = (slug, id) => api.delete(`/${slug}/resource-allocations/${id}`).then((r) => r.data)

// Dashboards
export const getProjectDashboard = (slug) => api.get(`/${slug}/dashboard`).then((r) => r.data)
export const getGlobalDashboard = () => api.get('/dashboard/global').then((r) => r.data)

// Slippage Predictor
export const getSlippageSummary = (slug) => api.get(`/${slug}/slippage/summary`).then((r) => r.data)

// Ecosystem integration (PM-E7) — real API-backed, no mock data
export const getPmStatus = (slug) => api.get(`/${slug}/pm-status`).then((r) => r.data)
export const getEcosystemConnectionStatus = () => api.get('/ecosystem/connection-status').then((r) => r.data)
export const getEcosystemSource = (slug) => api.get(`/${slug}/ecosystem-source`).then((r) => r.data)

// Thai Holidays (global, pmo_admin-managed)
export const listHolidays = (year) => api.get('/holidays', { params: { year } }).then((r) => r.data)
export const createHoliday = (payload) => api.post('/holidays', payload).then((r) => r.data)
export const updateHoliday = (id, payload) => api.put(`/holidays/${id}`, payload).then((r) => r.data)
export const deleteHoliday = (id) => api.delete(`/holidays/${id}`).then((r) => r.data)
export const addBusinessDays = (start, days) =>
  api.get('/business-days/add', { params: { start, days } }).then((r) => r.data.result_date)

// Get-or-create: used by "Open/Create Whiteboard" entry points on other
// pages. Returns the id of the (first) whiteboard already linked to this
// entity, or creates a new one if none exists yet.
export const openOrCreateWhiteboard = async (slug, entityType, entityId, title) => {
  const existing = await listWhiteboards(slug, entityType, entityId)
  if (existing.length > 0) return existing[0].id
  const created = await createWhiteboard(slug, {
    title,
    linked_entity_type: entityType,
    linked_entity_id: entityId,
  })
  return created.id
}

export default api
