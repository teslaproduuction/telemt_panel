import { useState } from 'react';
import { Header } from '@/components/layout/Header';
import { StatusBadge } from '@/components/StatusBadge';
import { MetricCard } from '@/components/MetricCard';
import { ErrorAlert } from '@/components/ErrorAlert';
import { useWsSubscription, useEndpoint } from '@/hooks/useWebSocket';
import { formatNumber, formatBytes, cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';

interface EventEntry {
  seq: number;
  ts_epoch_secs: number;
  event_type: string;
  context: string;
}

interface EventsData {
  capacity: number;
  dropped_total: number;
  events: EventEntry[];
}

interface DcRttEntry {
  dc: number;
  rtt_ema_ms: number | null;
  alive_writers: number;
  required_writers: number;
  coverage_pct: number;
}

interface MeQualityData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  data?: {
    counters: Record<string, number>;
    route_drops: Record<string, number>;
    dc_rtt: DcRttEntry[];
  };
}

interface UpstreamDc {
  dc: number;
  latency_ema_ms: number | null;
  ip_preference: string;
}

interface Upstream {
  upstream_id: number;
  route_kind: string;
  address: string;
  weight: number;
  scopes: string;
  healthy: boolean;
  fails: number;
  last_check_age_secs: number;
  effective_latency_ms: number | null;
  dc: UpstreamDc[];
}

interface ConnectionsTopUser {
  username: string;
  current_connections: number;
  total_octets: number;
}

interface ConnectionsData {
  cache: {
    ttl_ms: number;
    served_from_cache: boolean;
    stale_cache_used: boolean;
  };
  totals: {
    current_connections: number;
    current_connections_me: number;
    current_connections_direct: number;
    active_users: number;
  };
  top: {
    limit: number;
    by_connections: ConnectionsTopUser[];
    by_throughput: ConnectionsTopUser[];
  };
  telemetry: {
    user_enabled: boolean;
    throughput_is_cumulative: boolean;
  };
}

interface UpstreamQualityData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  policy?: {
    connect_retry_attempts: number;
    connect_retry_backoff_ms: number;
    connect_budget_ms: number;
    unhealthy_fail_threshold: number;
    connect_failfast_hard_errors: boolean;
  };
  counters?: {
    connect_attempt_total: number;
    connect_success_total: number;
    connect_fail_total: number;
    connect_failfast_hard_error_total: number;
  };
  summary?: Record<string, number>;
  upstreams?: Upstream[];
}

interface PoolStateData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  data?: {
    generations: {
      active_generation: number;
      warm_generation: number;
      pending_hardswap_generation: number | null;
      pending_hardswap_age_secs: number | null;
      draining_generations: number[];
    };
    hardswap: {
      enabled: boolean;
      pending: boolean;
    };
    writers: {
      total: number;
      alive_non_draining: number;
      draining: number;
      degraded: number;
      contour: { active: number; warm: number; draining: number };
      health: { healthy: number; degraded: number; draining: number };
    };
    refill: {
      inflight_endpoints_total: number;
      inflight_dc_total: number;
      by_dc: Array<{ dc: number; family: string; inflight: number }>;
    };
  };
}

interface MeSelftestKdfData {
  state: string;
  ewma_errors_per_min: number;
  threshold_errors_per_min: number;
  errors_total: number;
}

interface MeSelftestTimeskewData {
  state: string;
  max_skew_secs_15m: number | null;
  samples_15m: number;
  last_skew_secs: number | null;
  last_source: string | null;
  last_seen_age_secs: number | null;
}

interface MeSelftestIpFamilyData {
  addr: string;
  state: string;
}

interface MeSelftestIpData {
  v4?: MeSelftestIpFamilyData;
  v6?: MeSelftestIpFamilyData;
}

interface MeSelftestPidData {
  pid: number;
  state: string;
}

interface MeSelftestBndData {
  addr_state: string;
  port_state: string;
  last_addr: string | null;
  last_seen_age_secs: number | null;
}

interface MeSelftestData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  data?: {
    kdf: MeSelftestKdfData;
    timeskew: MeSelftestTimeskewData;
    ip: MeSelftestIpData;
    pid: MeSelftestPidData;
    bnd: MeSelftestBndData;
  };
}

interface NatStunData {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
  data?: {
    flags: {
      nat_probe_enabled: boolean;
      nat_probe_disabled_runtime: boolean;
      nat_probe_attempts: number;
    };
    servers: {
      configured: string[];
      live: string[];
      live_total: number;
    };
    reflection?: {
      v4?: { addr: string; age_secs: number };
      v6?: { addr: string; age_secs: number };
    };
    backoff?: {
      stun_backoff_remaining_ms: number;
    };
  };
}

function CollapsibleSection({ title, defaultOpen = true, children }: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 hover:bg-surface-hover transition-colors text-left"
      >
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        <ChevronDown size={16} className={cn('text-text-secondary transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

const ENDPOINTS = [
  '/v1/runtime/gates',
  '/v1/runtime/me_pool_state',
  '/v1/runtime/me_quality',
  '/v1/runtime/upstream_quality',
  '/v1/runtime/nat_stun',
  '/v1/runtime/me-selftest',
  '/v1/runtime/connections/summary',
  '/v1/runtime/events/recent',
];

export function RuntimePage() {
  const { data: wsData, errors, connected, refresh } = useWsSubscription('runtime', ENDPOINTS, 5);

  const gates = useEndpoint<Record<string, unknown>>(wsData, '/v1/runtime/gates');
  const pool = useEndpoint<PoolStateData>(wsData, '/v1/runtime/me_pool_state');
  const meQuality = useEndpoint<MeQualityData>(wsData, '/v1/runtime/me_quality');
  const upstreamQuality = useEndpoint<UpstreamQualityData>(wsData, '/v1/runtime/upstream_quality');
  const natStun = useEndpoint<NatStunData>(wsData, '/v1/runtime/nat_stun');
  const meSelftest = useEndpoint<MeSelftestData>(wsData, '/v1/runtime/me-selftest');
  const connections = useEndpoint<ConnectionsData>(wsData, '/v1/runtime/connections/summary');
  const events = useEndpoint<EventsData>(wsData, '/v1/runtime/events/recent');

  const firstError = Object.values(errors)[0];

  // Filter out startup fields from gates (they're shown on Dashboard)
  const filteredGates = gates ? Object.fromEntries(
    Object.entries(gates).filter(([key]) =>
      !key.startsWith('startup_')
    )
  ) : null;

  return (
    <div>
      <Header title="Runtime" refreshing={!connected} onRefresh={refresh} />

      <div className="p-6 space-y-4">
        {firstError && <ErrorAlert message={firstError} onRetry={refresh} />}

        {/* Gates */}
        {filteredGates && Object.keys(filteredGates).length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.entries(filteredGates).map(([key, value]) => (
              <div key={key} className="bg-surface border border-border rounded-lg p-3 flex flex-col items-center gap-2">
                <span className="text-xs text-text-secondary text-center leading-tight">{key.replace(/_/g, ' ')}</span>
                {typeof value === 'boolean' ? (
                  <StatusBadge status={value} />
                ) : (
                  <span className="text-sm text-text-primary font-medium">{String(value)}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Connections */}
        {connections?.totals && (
          <CollapsibleSection title="Connections">
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <MetricCard label="Total Connections" value={formatNumber(connections.totals.current_connections)} />
                <MetricCard label="ME Connections" value={formatNumber(connections.totals.current_connections_me)} />
                <MetricCard label="Direct Connections" value={formatNumber(connections.totals.current_connections_direct)} />
                <MetricCard label="Active Users" value={formatNumber(connections.totals.active_users)} />
              </div>
              {connections.top && (connections.top.by_connections.length > 0 || connections.top.by_throughput.length > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {connections.top.by_connections.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Top by Connections</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left py-2 px-2 text-text-secondary font-medium">User</th>
                              <th className="text-right py-2 px-2 text-text-secondary font-medium">Connections</th>
                              <th className="text-right py-2 px-2 text-text-secondary font-medium">Traffic</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connections.top.by_connections.map((user, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-2 text-text-primary font-medium">{user.username}</td>
                                <td className="py-2 px-2 text-right text-text-primary">{formatNumber(user.current_connections)}</td>
                                <td className="py-2 px-2 text-right text-text-primary">{formatBytes(user.total_octets)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {connections.top.by_throughput.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Top by Throughput</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border">
                              <th className="text-left py-2 px-2 text-text-secondary font-medium">User</th>
                              <th className="text-right py-2 px-2 text-text-secondary font-medium">Connections</th>
                              <th className="text-right py-2 px-2 text-text-secondary font-medium">Traffic</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connections.top.by_throughput.map((user, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-2 px-2 text-text-primary font-medium">{user.username}</td>
                                <td className="py-2 px-2 text-right text-text-primary">{formatNumber(user.current_connections)}</td>
                                <td className="py-2 px-2 text-right text-text-primary">{formatBytes(user.total_octets)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* ME Pool State */}
        {pool?.data && (
          <CollapsibleSection title="ME Pool State">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-background rounded p-3 border border-border/50">
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Generations</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Active</span>
                    <span className="text-text-primary font-medium">{pool.data.generations.active_generation}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Warm</span>
                    <span className="text-text-primary font-medium">{pool.data.generations.warm_generation}</span>
                  </div>
                  {pool.data.generations.pending_hardswap_generation != null && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Pending Hardswap</span>
                      <span className="text-text-primary font-medium">{pool.data.generations.pending_hardswap_generation}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="bg-background rounded p-3 border border-border/50">
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Contour</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Active</span>
                    <span className="text-text-primary font-medium">{pool.data.writers.contour.active}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Warm</span>
                    <span className="text-text-primary font-medium">{pool.data.writers.contour.warm}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Draining</span>
                    <span className="text-text-primary font-medium">{pool.data.writers.contour.draining}</span>
                  </div>
                </div>
              </div>
              <div className="bg-background rounded p-3 border border-border/50">
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Writers Health</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Healthy</span>
                    <span className="text-text-primary font-medium">{pool.data.writers.health.healthy}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Degraded</span>
                    <span className="text-text-primary font-medium">{pool.data.writers.health.degraded}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Draining</span>
                    <span className="text-text-primary font-medium">{pool.data.writers.health.draining}</span>
                  </div>
                </div>
              </div>
            </div>
            {pool.data.refill.inflight_endpoints_total > 0 && (
              <div className="bg-background rounded p-3 border border-border/50 mt-4">
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Refill</h4>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <MetricCard label="Inflight Endpoints" value={formatNumber(pool.data.refill.inflight_endpoints_total)} />
                  <MetricCard label="Inflight DC" value={formatNumber(pool.data.refill.inflight_dc_total)} />
                </div>
                {pool.data.refill.by_dc.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {pool.data.refill.by_dc.map((dc, i) => (
                      <span key={i} className="bg-surface px-2 py-0.5 rounded text-[10px] border border-border/30">
                        <span className="text-text-secondary">DC {dc.dc} ({dc.family}):</span>{' '}
                        <span className="text-text-primary">{dc.inflight}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* ME Quality */}
        {meQuality?.data && (
          <CollapsibleSection title="ME Quality">
            <div className="space-y-4">
              {/* DC RTT Table */}
              {meQuality.data.dc_rtt.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Datacenter Status</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 px-2 text-text-secondary font-medium">DC</th>
                          <th className="text-right py-2 px-2 text-text-secondary font-medium">RTT</th>
                          <th className="text-right py-2 px-2 text-text-secondary font-medium">Writers</th>
                          <th className="text-right py-2 px-2 text-text-secondary font-medium">Coverage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {meQuality.data.dc_rtt.map((dc) => (
                          <tr key={dc.dc} className="border-b border-border/50">
                            <td className="py-2 px-2 text-text-primary font-medium">DC {dc.dc}</td>
                            <td className="py-2 px-2 text-right text-text-primary">
                              {dc.rtt_ema_ms != null ? `${dc.rtt_ema_ms.toFixed(1)}ms` : '-'}
                            </td>
                            <td className="py-2 px-2 text-right text-text-primary">
                              {dc.alive_writers} / {dc.required_writers}
                            </td>
                            <td className="py-2 px-2 text-right">
                              <span className={cn(
                                'font-medium',
                                dc.coverage_pct >= 90 ? 'text-success' : dc.coverage_pct >= 50 ? 'text-warning' : 'text-danger'
                              )}>
                                {dc.coverage_pct.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Counters & Route Drops */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {meQuality.data.counters && (
                  <div className="bg-background rounded p-3 border border-border/50">
                    <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Counters</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(meQuality.data.counters).map(([key, value]) => (
                        <MetricCard
                          key={key}
                          label={key.replace(/_total$/, '').replace(/_/g, ' ')}
                          value={formatNumber(value)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {meQuality.data.route_drops && (
                  <div className="bg-background rounded p-3 border border-border/50">
                    <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Route Drops</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(meQuality.data.route_drops).map(([key, value]) => (
                        <MetricCard
                          key={key}
                          label={key.replace(/_total$/, '').replace(/_/g, ' ')}
                          value={formatNumber(value)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Upstream Quality */}
        {upstreamQuality?.upstreams && upstreamQuality.upstreams.length > 0 && (
          <CollapsibleSection title="Upstream Quality">
            <div className="space-y-3">
              {upstreamQuality.summary && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {Object.entries(upstreamQuality.summary).map(([key, value]) => (
                    <MetricCard
                      key={key}
                      label={key.replace(/_total$/, '').replace(/_/g, ' ')}
                      value={formatNumber(value)}
                    />
                  ))}
                </div>
              )}
              <div className="grid grid-cols-1 gap-2">
                {upstreamQuality.upstreams.map((upstream) => (
                  <div key={upstream.upstream_id} className="bg-background rounded p-3 border border-border/50">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                      <div>
                        <span className="text-text-secondary">Address: </span>
                        <span className="text-text-primary font-medium">{upstream.address}</span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Route: </span>
                        <span className="text-text-primary font-medium">{upstream.route_kind}</span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Health: </span>
                        <StatusBadge status={upstream.healthy} />
                      </div>
                      <div>
                        <span className="text-text-secondary">Latency: </span>
                        <span className="text-text-primary font-medium">
                          {upstream.effective_latency_ms != null ? `${upstream.effective_latency_ms.toFixed(1)}ms` : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Weight: </span>
                        <span className="text-text-primary font-medium">{upstream.weight}</span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Fails: </span>
                        <span className="text-text-primary font-medium">{upstream.fails}</span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Scopes: </span>
                        <span className="text-text-primary font-medium">{upstream.scopes}</span>
                      </div>
                      <div>
                        <span className="text-text-secondary">Last Check: </span>
                        <span className="text-text-primary font-medium">{upstream.last_check_age_secs}s ago</span>
                      </div>
                    </div>
                    {upstream.dc.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {upstream.dc.map((dc, i) => (
                          <span key={i} className="bg-surface px-2 py-0.5 rounded text-[10px] border border-border/30">
                            <span className="text-text-secondary">DC {dc.dc}:</span>{' '}
                            <span className="text-text-primary">{dc.latency_ema_ms != null ? `${dc.latency_ema_ms.toFixed(1)}ms` : '-'}</span>
                            <span className="text-text-secondary ml-1">({dc.ip_preference})</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* NAT / STUN */}
        {natStun?.data && (
          <CollapsibleSection title="NAT / STUN">
            <div className="space-y-3">
              <div>
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Configured Servers</h4>
                <div className="flex flex-wrap gap-2">
                  {natStun.data.servers.configured.map((server: string, i: number) => (
                    <span key={i} className="bg-background px-3 py-1.5 rounded text-sm text-text-primary font-mono border border-border/50">
                      {server}
                    </span>
                  ))}
                </div>
              </div>
              {natStun.data.reflection && (natStun.data.reflection.v4 || natStun.data.reflection.v6) && (
                <div>
                  <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">Detected IPs</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    {natStun.data.reflection.v4 && (
                      <div className="flex justify-between bg-background rounded p-2 border border-border/50">
                        <span className="text-text-secondary">IPv4</span>
                        <div className="text-right">
                          <div className="text-text-primary font-mono">{natStun.data.reflection.v4.addr}</div>
                          <div className="text-text-secondary text-[10px]">{natStun.data.reflection.v4.age_secs}s ago</div>
                        </div>
                      </div>
                    )}
                    {natStun.data.reflection.v6 && (
                      <div className="flex justify-between bg-background rounded p-2 border border-border/50">
                        <span className="text-text-secondary">IPv6</span>
                        <div className="text-right">
                          <div className="text-text-primary font-mono">{natStun.data.reflection.v6.addr}</div>
                          <div className="text-text-secondary text-[10px]">{natStun.data.reflection.v6.age_secs}s ago</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* ME Self-Test */}
        {meSelftest?.data && (
          <CollapsibleSection title="ME Self-Test">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* KDF */}
              <div className="bg-background rounded p-3 border border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-accent uppercase tracking-wide">KDF</h4>
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded',
                    meSelftest.data.kdf.state === 'ok'
                      ? 'bg-success/10 text-success'
                      : 'bg-danger/10 text-danger'
                  )}>
                    {meSelftest.data.kdf.state}
                  </span>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">EWMA errors/min</span>
                    <span className="text-text-primary font-medium">{meSelftest.data.kdf.ewma_errors_per_min.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Threshold</span>
                    <span className="text-text-primary font-medium">{meSelftest.data.kdf.threshold_errors_per_min.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Total errors</span>
                    <span className="text-text-primary font-medium">{formatNumber(meSelftest.data.kdf.errors_total)}</span>
                  </div>
                </div>
              </div>

              {/* Timeskew */}
              <div className="bg-background rounded p-3 border border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-accent uppercase tracking-wide">Time Skew</h4>
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded',
                    meSelftest.data.timeskew.state === 'ok'
                      ? 'bg-success/10 text-success'
                      : 'bg-danger/10 text-danger'
                  )}>
                    {meSelftest.data.timeskew.state}
                  </span>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Max skew (15m)</span>
                    <span className="text-text-primary font-medium">
                      {meSelftest.data.timeskew.max_skew_secs_15m != null ? `${meSelftest.data.timeskew.max_skew_secs_15m}s` : '-'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Samples (15m)</span>
                    <span className="text-text-primary font-medium">{meSelftest.data.timeskew.samples_15m}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Last skew</span>
                    <span className="text-text-primary font-medium">
                      {meSelftest.data.timeskew.last_skew_secs != null ? `${meSelftest.data.timeskew.last_skew_secs}s` : '-'}
                    </span>
                  </div>
                  {meSelftest.data.timeskew.last_source && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Source</span>
                      <span className="text-text-primary font-medium">{meSelftest.data.timeskew.last_source}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* BND */}
              <div className="bg-background rounded p-3 border border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-accent uppercase tracking-wide">BND</h4>
                  <div className="flex gap-1">
                    <span className={cn(
                      'text-xs font-medium px-2 py-0.5 rounded',
                      meSelftest.data.bnd.addr_state === 'ok'
                        ? 'bg-success/10 text-success'
                        : 'bg-danger/10 text-danger'
                    )}>
                      addr: {meSelftest.data.bnd.addr_state}
                    </span>
                    <span className={cn(
                      'text-xs font-medium px-2 py-0.5 rounded',
                      meSelftest.data.bnd.port_state === 'ok'
                        ? 'bg-success/10 text-success'
                        : 'bg-danger/10 text-danger'
                    )}>
                      port: {meSelftest.data.bnd.port_state}
                    </span>
                  </div>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Last addr</span>
                    <span className="text-text-primary font-medium font-mono">
                      {meSelftest.data.bnd.last_addr ?? '-'}
                    </span>
                  </div>
                  {meSelftest.data.bnd.last_seen_age_secs != null && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Last seen</span>
                      <span className="text-text-primary font-medium">{meSelftest.data.bnd.last_seen_age_secs}s ago</span>
                    </div>
                  )}
                </div>
              </div>

              {/* IP */}
              <div className="bg-background rounded p-3 border border-border/50">
                <h4 className="text-xs font-semibold text-accent uppercase tracking-wide mb-2">IP Interfaces</h4>
                <div className="space-y-2 text-xs">
                  {meSelftest.data.ip.v4 && (
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-text-secondary">IPv4: </span>
                        <span className="text-text-primary font-mono">{meSelftest.data.ip.v4.addr}</span>
                      </div>
                      <span className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded',
                        meSelftest.data.ip.v4.state === 'good'
                          ? 'bg-success/10 text-success'
                          : 'bg-danger/10 text-danger'
                      )}>
                        {meSelftest.data.ip.v4.state}
                      </span>
                    </div>
                  )}
                  {meSelftest.data.ip.v6 && (
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-text-secondary">IPv6: </span>
                        <span className="text-text-primary font-mono">{meSelftest.data.ip.v6.addr}</span>
                      </div>
                      <span className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded',
                        meSelftest.data.ip.v6.state === 'good'
                          ? 'bg-success/10 text-success'
                          : 'bg-danger/10 text-danger'
                      )}>
                        {meSelftest.data.ip.v6.state}
                      </span>
                    </div>
                  )}
                  {!meSelftest.data.ip.v4 && !meSelftest.data.ip.v6 && (
                    <span className="text-text-secondary">No interface data</span>
                  )}
                </div>
              </div>

              {/* PID */}
              <div className="bg-background rounded p-3 border border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-accent uppercase tracking-wide">PID</h4>
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded',
                    meSelftest.data.pid.state === 'non-one'
                      ? 'bg-success/10 text-success'
                      : 'bg-warning/10 text-warning'
                  )}>
                    {meSelftest.data.pid.state}
                  </span>
                </div>
                <div className="text-xs flex justify-between">
                  <span className="text-text-secondary">PID</span>
                  <span className="text-text-primary font-medium font-mono">{meSelftest.data.pid.pid}</span>
                </div>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Events */}
        {events?.events && (
          <CollapsibleSection title="Recent Events">
            <div className="max-h-72 overflow-y-auto space-y-0.5 font-mono text-xs">
              {events.events.length === 0 ? (
                <p className="text-text-secondary py-4 text-center font-sans">No recent events</p>
              ) : (
                events.events.map((evt: EventEntry, i: number) => (
                  <div key={i} className="flex gap-3 py-1 px-2 rounded hover:bg-surface-hover">
                    <span className="text-text-secondary shrink-0 tabular-nums">
                      {new Date(evt.ts_epoch_secs * 1000).toLocaleTimeString()}
                    </span>
                    <span className="text-accent shrink-0">{evt.event_type}</span>
                    <span className="text-text-primary break-all">{evt.context}</span>
                  </div>
                ))
              )}
            </div>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}
