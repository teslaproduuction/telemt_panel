import { useMemo } from 'react';
import { Header } from '@/components/layout/Header';
import { MetricCard } from '@/components/MetricCard';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorAlert } from '@/components/ErrorAlert';
import { DataTable } from '@/components/DataTable';
import { useWsSubscription, useEndpoint } from '@/hooks/useWebSocket';
import { formatUptime, formatNumber } from '@/lib/utils';
import { Activity, Wifi, WifiOff, Clock, Users } from 'lucide-react';

interface HealthData {
  status: string;
  read_only: boolean;
}

interface SummaryData {
  uptime_seconds: number;
  connections_total: number;
  connections_bad_total: number;
  handshake_timeouts_total: number;
  configured_users: number;
}

interface SystemInfoData {
  [key: string]: unknown;
}

interface DcStatus {
  dc_id: number;
  [key: string]: unknown;
}

interface DcStatusData {
  middle_proxy_enabled: boolean;
  reason?: string;
  dcs: DcStatus[];
}

const ENDPOINTS = ['/v1/health', '/v1/stats/summary', '/v1/system/info', '/v1/stats/dcs'];

export function DashboardPage() {
  const { data: wsData, errors, connected, refresh } = useWsSubscription('dashboard', ENDPOINTS, 5);

  const health = useEndpoint<HealthData>(wsData, '/v1/health');
  const summary = useEndpoint<SummaryData>(wsData, '/v1/stats/summary');
  const system = useEndpoint<SystemInfoData>(wsData, '/v1/system/info');
  const dcs = useEndpoint<DcStatusData>(wsData, '/v1/stats/dcs');

  const isHealthy = health?.status === 'ok';
  const firstError = Object.values(errors)[0];

  const dcColumns = useMemo(() => [
    { key: 'dc_id', header: 'DC ID' },
    ...Object.keys(dcs?.dcs?.[0] ?? {})
      .filter((k) => k !== 'dc_id')
      .map((k) => ({
        key: k,
        header: k.replace(/_/g, ' '),
        render: (row: DcStatus) => {
          const v = row[k];
          if (typeof v === 'boolean') return <StatusBadge status={v} />;
          return String(v ?? '-');
        },
      })),
  ], [dcs]);

  return (
    <div>
      <Header title="Dashboard" refreshing={!connected} onRefresh={refresh} />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        {firstError && <ErrorAlert message={firstError} onRetry={refresh} />}

        {/* Health Banner */}
        <div
          className={`rounded-lg border p-3 lg:p-4 flex items-center gap-2 lg:gap-3 text-sm lg:text-base ${
            isHealthy
              ? 'bg-success/10 border-success/30'
              : 'bg-danger/10 border-danger/30'
          }`}
        >
          {isHealthy ? (
            <Wifi size={18} className="text-success shrink-0" />
          ) : (
            <WifiOff size={18} className="text-danger shrink-0" />
          )}
          <span className={`font-medium ${isHealthy ? 'text-success' : 'text-danger'}`}>
            {isHealthy ? 'Telemt is running' : 'Telemt is unreachable'}
          </span>
          {!connected && (
            <span className="ml-auto text-xs text-warning bg-warning/15 px-2 py-1 rounded shrink-0">
              WS reconnecting...
            </span>
          )}
          {health?.read_only && (
            <span className="ml-auto text-xs text-warning bg-warning/15 px-2 py-1 rounded shrink-0">
              READ-ONLY
            </span>
          )}
        </div>

        {/* Metric Cards */}
        {summary && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            <MetricCard
              label="Uptime"
              value={formatUptime(summary.uptime_seconds)}
              icon={<Clock size={14} className="lg:w-4 lg:h-4" />}
            />
            <MetricCard
              label="Total Connections"
              value={formatNumber(summary.connections_total)}
              icon={<Activity size={14} className="lg:w-4 lg:h-4" />}
              variant="success"
            />
            <MetricCard
              label="Bad Connections"
              value={formatNumber(summary.connections_bad_total)}
              variant={summary.connections_bad_total > 0 ? 'warning' : 'default'}
            />
            <MetricCard
              label="Configured Users"
              value={summary.configured_users}
              icon={<Users size={14} className="lg:w-4 lg:h-4" />}
            />
          </div>
        )}

        {/* System Info */}
        {system && (
          <div className="bg-surface border border-border rounded-lg p-3 lg:p-4">
            <h3 className="text-xs lg:text-sm font-medium text-text-secondary mb-2 lg:mb-3">System Info</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 lg:gap-3">
              {Object.entries(system).map(([key, value]) => (
                <div key={key}>
                  <div className="text-xs text-text-secondary">{key.replace(/_/g, ' ')}</div>
                  <div className="text-xs lg:text-sm text-text-primary truncate">
                    {typeof value === 'boolean' ? (
                      <StatusBadge status={value} />
                    ) : (
                      String(value ?? '-')
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DC Status */}
        {dcs?.dcs && dcs.dcs.length > 0 && (
          <div>
            <h3 className="text-xs lg:text-sm font-medium text-text-secondary mb-2 lg:mb-3">DC Status</h3>
            <DataTable
              columns={dcColumns}
              data={dcs.dcs}
              keyField="dc_id"
              emptyMessage="No DCs available"
            />
          </div>
        )}
      </div>
    </div>
  );
}
