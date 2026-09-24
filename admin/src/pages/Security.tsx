import { useEffect, useState } from 'react';
import {
  ShieldAlert, Lock, Smartphone, CheckCircle2, X, Activity, ScrollText, MonitorSmartphone, LogOut,
} from 'lucide-react';
import api from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { apiMessage } from '../lib/apiError';

interface AuditLogEntry {
  _id: string;
  userId?: string;
  role?: string;
  action: string;
  entity: string;
  entityId?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  ip: string;
  userAgent: string;
  timestamp: string;
}

interface SessionEntry {
  _id: string;
  userId: string;
  deviceInfo: { platform: string; os: string; browser: string };
  ip: string;
  isActive: boolean;
  lastActivity: string;
  createdAt: string;
}

interface OverviewStats {
  totalActiveSessions: number;
  loginSuccessLast24h: number;
  loginFailedLast24h: number;
  openFraudAlerts: number;
  criticalFraudAlerts: number;
  blockedUsers: number;
  newDevicesLast24h: number;
  bruteForceAttemptsLast24h: number;
  totalUsersWithTOTP: number;
}

interface SecurityEvent {
  _id: string;
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
}

interface FraudAlert {
  _id: string;
  userId: string;
  type: string;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'resolved';
  details: {
    reason?: string;
    ipAddress?: string;
    userAgent?: string;
    distanceKm?: number;
    timeSeconds?: number;
    velocityKmh?: number;
    previousIp?: string;
    currentIp?: string;
    previousDevice?: string;
    currentDevice?: string;
    deviceCount?: number;
    orderCount?: number;
    periodMinutes?: number;
    spoofedKeys?: string[];
    // El backend añade claves propias de cada tipo de alerta. `unknown` y
    // no `any`: nada en esta pantalla las lee todavía, y si algún día lo
    // hace tendrá que comprobar antes qué recibió, que es lo correcto.
    [key: string]: unknown;
  };
  resolvedBy?: string;
  resolvedAt?: string;
  actionTaken?: string;
  createdAt: string;
}

export default function Security() {
  const [activeTab, setActiveTab] = useState<'overview' | 'alerts' | 'audit' | 'sessions'>('overview');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [recentEvents, setRecentEvents] = useState<SecurityEvent[]>([]);

  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<FraudAlert | null>(null);

  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [manualBlockUserId, setManualBlockUserId] = useState('');
  const [manualBlockReason, setManualBlockReason] = useState('');
  const [blockingUser, setBlockingUser] = useState(false);

  // ── Auditoría ──
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditActions, setAuditActions] = useState<string[]>([]);
  const [auditFilters, setAuditFilters] = useState<{ action: string; severity: string; userId: string }>({ action: '', severity: '', userId: '' });

  // ── Sesiones ──
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [sessionUserFilter, setSessionUserFilter] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fetchOverview = async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/security/dashboard');
      setOverview(data.data.overview);
      setRecentEvents(data.data.recentSecurityEvents);
    } catch (err) {
      console.error(err);
      setToast({ message: 'Error al cargar panel de seguridad', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const fetchFraudAlerts = async () => {
    try {
      setLoading(true);
      const { data } = await api.get('/security/fraud-alerts?page=1');
      setAlerts(data.data.alerts);
    } catch (err) {
      console.error(err);
      setToast({ message: 'Error al obtener alertas de fraude', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page: '1', limit: '50' });
      if (auditFilters.action) params.set('action', auditFilters.action);
      if (auditFilters.severity) params.set('severity', auditFilters.severity);
      if (auditFilters.userId) params.set('userId', auditFilters.userId);
      const [logsRes, actionsRes] = await Promise.all([
        api.get(`/security/audit-logs?${params.toString()}`),
        auditActions.length === 0 ? api.get('/security/audit-actions') : Promise.resolve(null),
      ]);
      setAuditLogs(logsRes.data.data.logs);
      if (actionsRes) setAuditActions(actionsRes.data.data.actions);
    } catch (err) {
      console.error(err);
      setToast({ message: 'Error al cargar auditoría', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page: '1', limit: '50' });
      if (sessionUserFilter.trim()) params.set('userId', sessionUserFilter.trim());
      const { data } = await api.get(`/security/sessions?${params.toString()}`);
      setSessions(data.data.sessions);
    } catch (err) {
      console.error(err);
      setToast({ message: 'Error al cargar sesiones', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'overview') {
      fetchOverview();
    } else if (activeTab === 'alerts') {
      fetchFraudAlerts();
    } else if (activeTab === 'audit') {
      fetchAuditLogs();
    } else if (activeTab === 'sessions') {
      fetchSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleRevokeSession = async (userId: string) => {
    try {
      await api.delete(`/security/sessions/user/${userId}`);
      setToast({ message: 'Sesiones del usuario revocadas', type: 'success' });
      setConfirmRevoke(null);
      fetchSessions();
    } catch (err) {
      setToast({ message: apiMessage(err, 'Error al revocar sesiones'), type: 'error' });
      setConfirmRevoke(null);
    }
  };

  const handleManualBlock = async () => {
    if (!manualBlockUserId.trim() || !manualBlockReason.trim()) return;
    setBlockingUser(true);
    try {
      await api.post(`/security/block-user/${manualBlockUserId.trim()}`, {
        reason: manualBlockReason
      });
      setToast({ message: 'Usuario bloqueado y sesiones cerradas', type: 'success' });
      setBlockModalOpen(false);
      setManualBlockUserId('');
      setManualBlockReason('');
    } catch (err) {
      console.error(err);
      setToast({ message: apiMessage(err, 'Error al bloquear usuario'), type: 'error' });
    } finally {
      setBlockingUser(false);
    }
  };

  const getRiskBadge = (level: string) => {
    const map: Record<string, string> = {
      low: 'text-[var(--color-primary)]',
      medium: 'text-[var(--color-warning)]',
      high: 'text-[var(--color-chart-purple)]',
      critical: 'text-[var(--color-danger)] font-bold'
    };
    return map[level] || 'text-gray-800';
  };

  const getSeverityBadge = (severity: string) => {
    const map: Record<string, string> = {
      low: 'text-[#8A5D08]',
      medium: 'text-[var(--color-warning)]',
      high: 'text-[var(--color-chart-purple)]',
      critical: 'text-[var(--color-danger)] font-bold'
    };
    return map[severity] || 'text-gray-800';
  };

  return (
    <div className="space-y-3 animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Consola de Seguridad y Auditoría</h1>
          <p className="page-subtitle">Detección de fraude, sesiones activas y control de acceso</p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setBlockModalOpen(true)}
            className="px-3.5 py-2 bg-[var(--color-danger-bg)] hover:bg-[var(--color-danger-bg)] text-[var(--color-danger)] border border-[var(--color-danger-bg)] text-xs font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer flex items-center gap-2 shadow-xs"
          >
            <Lock className="w-4 h-4" />
            <span>Bloqueo Manual</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex overflow-x-auto gap-1 pb-3 border-b border-[var(--color-border-light)]">
        {(['overview', 'alerts', 'audit', 'sessions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setLoading(true); }}
            className={`px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap border-b-2 ${
              activeTab === tab
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-main)]'
            }`}
          >
            {tab === 'overview' && 'Vista General'}
            {tab === 'alerts' && 'Alertas de Fraude'}
            {tab === 'audit' && 'Auditoría'}
            {tab === 'sessions' && 'Sesiones'}
          </button>
        ))}
      </div>

      {/* ── 1. VISTA GENERAL ── */}
      {activeTab === 'overview' && !loading && overview && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pb-6 border-b border-[var(--color-border-light)]">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Sesiones Activas</span>
                <Activity className="w-4 h-4 text-[var(--color-primary)] animate-pulse" />
              </div>
              <p className="kpi-value text-2xl text-[var(--color-text-main)]">{overview.totalActiveSessions}</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">Conexiones simultáneas</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Alertas Antifraude</span>
                <ShieldAlert className="w-4 h-4 text-[var(--color-danger)]" />
              </div>
              <p className="kpi-value text-2xl text-[var(--color-text-main)]">{overview.openFraudAlerts}</p>
              <p className="text-xs text-[var(--color-danger)] font-bold mt-1">{overview.criticalFraudAlerts} críticas abiertas</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Baneos Activos</span>
                <Lock className="w-4 h-4 text-[var(--color-warning)]" />
              </div>
              <p className="kpi-value text-2xl text-[var(--color-text-main)]">{overview.blockedUsers}</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">Cuentas restringidas</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Nuevos Dispositivos</span>
                <Smartphone className="w-4 h-4 text-[var(--color-primary)]" />
              </div>
              <p className="kpi-value text-2xl text-[var(--color-text-main)]">{overview.newDevicesLast24h}</p>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">Últimas 24 horas</p>
            </div>
          </div>

          {/* Table Recent Critical */}
          <div className="table-container">
            <div className="px-5 py-3.5 border-b border-[var(--color-border-light)] bg-[var(--color-bg)]">
              <h3 className="text-sm font-bold text-[var(--color-text-main)]">Eventos de Seguridad Recientes</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left">
                    <th className="table-header-cell">Fecha</th>
                    <th className="table-header-cell">Severidad</th>
                    <th className="table-header-cell">Acción</th>
                    <th className="table-header-cell">Descripción</th>
                    <th className="table-header-cell">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-light)]">
                  {recentEvents.map((ev) => (
                    <tr key={ev._id} className="hover:bg-[var(--color-bg)] transition-colors">
                      <td className="table-body-cell text-xs font-mono text-[var(--color-text-muted)]">
                        {new Date(ev.timestamp).toLocaleString('es-CO')}
                      </td>
                      <td className="table-body-cell">
                        <span className={`text-[10px] font-bold uppercase ${getSeverityBadge(ev.severity)}`}>
                          {ev.severity}
                        </span>
                      </td>
                      <td className="table-body-cell font-bold text-[var(--color-text-main)] text-xs">{ev.action}</td>
                      <td className="table-body-cell text-xs text-[var(--color-text-secondary)]">{ev.description}</td>
                      <td className="table-body-cell text-xs font-mono text-[var(--color-primary)]">{ev.ipAddress || 'Interno'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 2. ALERTAS DE FRAUDE ── */}
      {activeTab === 'alerts' && !loading && (
        <div className="table-container">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="table-header-cell">Fecha</th>
                  <th className="table-header-cell">Usuario ID</th>
                  <th className="table-header-cell">Nivel Riesgo</th>
                  <th className="table-header-cell">Puntaje</th>
                  <th className="table-header-cell">Tipo</th>
                  <th className="table-header-cell">Estado</th>
                  <th className="table-header-cell">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-light)]">
                {alerts.map((al) => (
                  <tr key={al._id} className="hover:bg-[var(--color-bg)] transition-colors">
                    <td className="table-body-cell text-xs font-mono text-[var(--color-text-muted)]">
                      {new Date(al.createdAt).toLocaleString('es-CO')}
                    </td>
                    <td className="table-body-cell font-mono text-[var(--color-primary)] text-xs font-bold">{al.userId}</td>
                    <td className="table-body-cell">
                      <span className={`text-[10px] font-bold uppercase ${getRiskBadge(al.riskLevel)}`}>
                        {al.riskLevel}
                      </span>
                    </td>
                    <td className="table-body-cell font-bold text-[var(--color-text-main)]">{al.riskScore} / 100</td>
                    <td className="table-body-cell text-xs font-semibold text-[var(--color-text-main)]">{al.type}</td>
                    <td className="table-body-cell">
                      <span className={`text-[10px] font-bold uppercase ${
                        al.status === 'open' ? 'text-[var(--color-danger)]' : 'text-[var(--color-primary)]'
                      }`}>
                        {al.status === 'open' ? 'Abierta' : 'Resuelta'}
                      </span>
                    </td>
                    <td className="table-body-cell">
                      <button
                        onClick={() => setSelectedAlert(al)}
                        className="px-2.5 py-1 rounded-md bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)] transition-all cursor-pointer"
                      >
                        Gestionar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 3. AUDITORÍA ── */}
      {activeTab === 'audit' && !loading && (
        <div className="space-y-2.5">
          <div className="zipp-card p-4 flex flex-wrap gap-3">
            <select
              value={auditFilters.action}
              onChange={(e) => setAuditFilters((f) => ({ ...f, action: e.target.value }))}
              className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)]"
            >
              <option value="">Todas las acciones</option>
              {auditActions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select
              value={auditFilters.severity}
              onChange={(e) => setAuditFilters((f) => ({ ...f, severity: e.target.value }))}
              className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-main)]"
            >
              <option value="">Toda severidad</option>
              <option value="low">Baja</option>
              <option value="medium">Media</option>
              <option value="high">Alta</option>
              <option value="critical">Crítica</option>
            </select>
            <input
              value={auditFilters.userId}
              onChange={(e) => setAuditFilters((f) => ({ ...f, userId: e.target.value }))}
              placeholder="ID de usuario"
              className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-mono text-[var(--color-text-main)] w-48"
            />
            <button
              onClick={fetchAuditLogs}
              className="px-3.5 py-1.5 bg-[var(--color-primary)] text-white text-xs font-bold rounded-lg cursor-pointer"
            >
              Filtrar
            </button>
          </div>

          <div className="table-container">
            <div className="px-5 py-3.5 border-b border-[var(--color-border-light)] bg-[var(--color-bg)] flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-[var(--color-primary)]" />
              <h3 className="text-sm font-bold text-[var(--color-text-main)]">Registro de Auditoría</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left">
                    <th className="table-header-cell">Fecha</th>
                    <th className="table-header-cell">Usuario</th>
                    <th className="table-header-cell">Severidad</th>
                    <th className="table-header-cell">Acción</th>
                    <th className="table-header-cell">Descripción</th>
                    <th className="table-header-cell">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-light)]">
                  {auditLogs.map((log) => (
                    <tr key={log._id} className="hover:bg-[var(--color-bg)] transition-colors">
                      <td className="table-body-cell text-xs font-mono text-[var(--color-text-muted)]">{new Date(log.timestamp).toLocaleString('es-CO')}</td>
                      <td className="table-body-cell text-xs font-mono text-[var(--color-text-secondary)]">{log.userId ? `${log.userId.slice(-6)} (${log.role || '—'})` : 'Sistema'}</td>
                      <td className="table-body-cell">
                        <span className={`text-[10px] font-bold uppercase ${getSeverityBadge(log.severity)}`}>{log.severity}</span>
                      </td>
                      <td className="table-body-cell font-bold text-[var(--color-text-main)] text-xs">{log.action}</td>
                      <td className="table-body-cell text-xs text-[var(--color-text-secondary)] max-w-xs truncate" title={log.description}>{log.description}</td>
                      <td className="table-body-cell text-xs font-mono text-[var(--color-primary)]">{log.ip}</td>
                    </tr>
                  ))}
                  {auditLogs.length === 0 && (
                    <tr><td colSpan={6} className="px-6 py-12 text-center text-[var(--color-text-muted)] text-xs font-medium">Sin registros para estos filtros.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 4. SESIONES ── */}
      {activeTab === 'sessions' && !loading && (
        <div className="space-y-2.5">
          <div className="zipp-card p-4 flex flex-wrap gap-3">
            <input
              value={sessionUserFilter}
              onChange={(e) => setSessionUserFilter(e.target.value)}
              placeholder="Filtrar por ID de usuario"
              className="h-9 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 text-xs font-mono text-[var(--color-text-main)] w-56"
            />
            <button onClick={fetchSessions} className="px-3.5 py-1.5 bg-[var(--color-primary)] text-white text-xs font-bold rounded-lg cursor-pointer">
              Filtrar
            </button>
          </div>

          <div className="table-container">
            <div className="px-5 py-3.5 border-b border-[var(--color-border-light)] bg-[var(--color-bg)] flex items-center gap-2">
              <MonitorSmartphone className="w-4 h-4 text-[var(--color-primary)]" />
              <h3 className="text-sm font-bold text-[var(--color-text-main)]">Sesiones Activas</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left">
                    <th className="table-header-cell">Usuario</th>
                    <th className="table-header-cell">Dispositivo</th>
                    <th className="table-header-cell">IP</th>
                    <th className="table-header-cell">Última actividad</th>
                    <th className="table-header-cell">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-light)]">
                  {sessions.map((s) => (
                    <tr key={s._id} className="hover:bg-[var(--color-bg)] transition-colors">
                      <td className="table-body-cell text-xs font-mono text-[var(--color-text-secondary)]">{s.userId.slice(-8)}</td>
                      <td className="table-body-cell text-xs text-[var(--color-text-main)]">{s.deviceInfo?.os} · {s.deviceInfo?.browser} ({s.deviceInfo?.platform})</td>
                      <td className="table-body-cell text-xs font-mono text-[var(--color-primary)]">{s.ip}</td>
                      <td className="table-body-cell text-xs font-mono text-[var(--color-text-muted)]">{new Date(s.lastActivity).toLocaleString('es-CO')}</td>
                      <td className="table-body-cell">
                        <button
                          onClick={() => setConfirmRevoke(s.userId)}
                          className="px-2.5 py-1 rounded-md bg-[var(--color-danger-bg)] hover:bg-[var(--color-danger)] hover:text-white border border-[var(--color-danger-bg)] text-xs font-semibold text-[var(--color-danger)] transition-all cursor-pointer flex items-center gap-1.5"
                        >
                          <LogOut className="w-3 h-3" /> Revocar
                        </button>
                      </td>
                    </tr>
                  ))}
                  {sessions.length === 0 && (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-[var(--color-text-muted)] text-xs font-medium">No hay sesiones activas para este filtro.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {confirmRevoke && (
        <ConfirmDialog
          title="Revocar Sesiones"
          message="¿Deseas cerrar todas las sesiones activas de este usuario? Tendrá que iniciar sesión de nuevo en todos sus dispositivos."
          confirmLabel="Revocar"
          onConfirm={() => handleRevokeSession(confirmRevoke)}
          onCancel={() => setConfirmRevoke(null)}
          variant="danger"
        />
      )}

      {/* Manual Block Modal */}
      {blockModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-3">
              <div className="flex items-center gap-2">
                <Lock className="w-5 h-5 text-[var(--color-danger)]" />
                <h3 className="text-base font-bold text-[var(--color-text-main)]">Bloqueo Manual de Usuario</h3>
              </div>
              <button onClick={() => setBlockModalOpen(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">ID de Usuario (MongoDB)</label>
                <input
                  type="text"
                  value={manualBlockUserId}
                  onChange={(e) => setManualBlockUserId(e.target.value)}
                  placeholder="ID del usuario a suspender"
                  className="w-full h-10 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3.5 font-mono font-bold text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">Motivo del Bloqueo</label>
                <textarea
                  value={manualBlockReason}
                  onChange={(e) => setManualBlockReason(e.target.value)}
                  placeholder="Razón de la suspensión de la cuenta..."
                  className="w-full h-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3 text-[var(--color-text-main)] focus:border-[var(--color-primary)] focus:bg-[var(--color-surface)] outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setBlockModalOpen(false)}
                className="flex-1 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-main)]"
              >
                Cancelar
              </button>
              <button
                onClick={handleManualBlock}
                disabled={blockingUser || !manualBlockUserId.trim() || !manualBlockReason.trim()}
                className="flex-1 py-2 rounded-lg bg-[var(--color-danger)] hover:bg-[#DC2626] text-white font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-50 cursor-pointer shadow-xs"
              >
                {blockingUser ? 'Bloqueando...' : 'Confirmar Bloqueo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Selected Alert Modal */}
      {selectedAlert && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="zipp-modal w-full max-w-md rounded-2xl p-6 space-y-2.5">
            <div className="flex justify-between items-center border-b border-[var(--color-border-light)] pb-3">
              <h3 className="text-base font-bold text-[var(--color-text-main)]">Detalle de Alerta #{selectedAlert._id.slice(-6)}</h3>
              <button onClick={() => setSelectedAlert(null)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] p-1 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2 text-xs">
              <p><strong className="text-[var(--color-text-secondary)]">Usuario:</strong> {selectedAlert.userId}</p>
              <p><strong className="text-[var(--color-text-secondary)]">Tipo:</strong> {selectedAlert.type}</p>
              <p><strong className="text-[var(--color-text-secondary)]">Puntaje Riesgo:</strong> {selectedAlert.riskScore}/100 ({selectedAlert.riskLevel})</p>
            </div>
            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedAlert(null)}
                className="px-4 py-2 rounded-lg bg-[var(--color-bg)] hover:bg-[var(--color-bg-alt)] text-xs font-semibold text-[var(--color-text-main)] border border-[var(--color-border)]"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-2 shadow-lg animate-fade-in ${
          toast.type === 'success' ? 'bg-[var(--color-primary-bg)] border-[var(--color-primary-bg)] text-[var(--color-primary)]' : 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)] text-[var(--color-danger)]'
        }`}>
          <CheckCircle2 className="w-4 h-4" />
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}

