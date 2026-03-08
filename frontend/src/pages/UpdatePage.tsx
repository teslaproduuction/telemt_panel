import { useState, useEffect, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { MetricCard } from '@/components/MetricCard';
import { ErrorAlert } from '@/components/ErrorAlert';
import { panelApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { RefreshCw, Download, CheckCircle2, XCircle, Loader2, ArrowRight } from 'lucide-react';

interface CheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_name: string;
  release_url: string;
  published_at: string;
  changelog: string;
}

interface UpdateStatus {
  phase: string;
  message?: string;
  error?: string;
  log?: string[];
}

const PHASE_STEPS = ['checking', 'downloading', 'verifying', 'replacing', 'restarting'];

export function UpdatePage() {
  // Telemt update state
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Panel update state
  const [panelCheckResult, setPanelCheckResult] = useState<CheckResult | null>(null);
  const [panelStatus, setPanelStatus] = useState<UpdateStatus | null>(null);
  const [panelChecking, setPanelChecking] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const panelPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isUpdating = status && !['idle', 'done', 'error'].includes(status.phase);
  const isPanelUpdating = panelStatus && !['idle', 'done', 'error'].includes(panelStatus.phase);

  // Telemt update functions
  async function handleCheck() {
    setChecking(true);
    setError(null);
    try {
      const result = await panelApi.get<CheckResult>('/update/check');
      setCheckResult(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  }

  async function handleApply() {
    setError(null);
    try {
      const s = await panelApi.post<UpdateStatus>('/update/apply');
      setStatus(s);
      startPolling();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start update');
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await panelApi.get<UpdateStatus>('/update/status');
        setStatus(s);
        if (s.phase === 'done' || s.phase === 'error') {
          stopPolling();
          if (s.phase === 'done') {
            try {
              const result = await panelApi.get<CheckResult>('/update/check');
              setCheckResult(result);
            } catch { /* ignore */ }
          }
        }
      } catch {
        // Panel might be restarting, keep polling
      }
    }, 1000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Panel update functions
  async function handlePanelCheck() {
    setPanelChecking(true);
    setPanelError(null);
    try {
      const result = await panelApi.get<CheckResult>('/panel/update/check');
      setPanelCheckResult(result);
    } catch (e: unknown) {
      setPanelError(e instanceof Error ? e.message : 'Failed to check for panel updates');
    } finally {
      setPanelChecking(false);
    }
  }

  async function handlePanelApply() {
    setPanelError(null);
    try {
      const s = await panelApi.post<UpdateStatus>('/panel/update/apply');
      setPanelStatus(s);
      startPanelPolling();
    } catch (e: unknown) {
      setPanelError(e instanceof Error ? e.message : 'Failed to start panel update');
    }
  }

  function startPanelPolling() {
    stopPanelPolling();
    panelPollRef.current = setInterval(async () => {
      try {
        const s = await panelApi.get<UpdateStatus>('/panel/update/status');
        setPanelStatus(s);
        if (s.phase === 'done' || s.phase === 'error') {
          stopPanelPolling();
          if (s.phase === 'done') {
            try {
              const result = await panelApi.get<CheckResult>('/panel/update/check');
              setPanelCheckResult(result);
            } catch { /* ignore */ }
          }
        }
      } catch {
        // Panel might be restarting, keep polling
      }
    }, 1000);
  }

  function stopPanelPolling() {
    if (panelPollRef.current) {
      clearInterval(panelPollRef.current);
      panelPollRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      stopPolling();
      stopPanelPolling();
    };
  }, []);

  const currentStep = status ? PHASE_STEPS.indexOf(status.phase) : -1;
  const panelCurrentStep = panelStatus ? PHASE_STEPS.indexOf(panelStatus.phase) : -1;

  return (
    <div className="min-h-screen">
      <Header title="Update" onRefresh={() => { handleCheck(); handlePanelCheck(); }} />
      <div className="p-6 space-y-6 max-w-3xl">

        {/* Panel Update Section */}
        <div className="bg-surface rounded-lg p-5 border border-border">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-text-primary">Panel Version</h2>
            <button
              onClick={handlePanelCheck}
              disabled={panelChecking || !!isPanelUpdating}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                'bg-accent/15 text-accent hover:bg-accent/25',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={14} className={cn(panelChecking && 'animate-spin')} />
              Check for updates
            </button>
          </div>

          {panelError && <ErrorAlert message={panelError} />}

          {panelCheckResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label="Current Version" value={panelCheckResult.current_version} />
                <MetricCard label="Latest Version" value={panelCheckResult.latest_version} />
              </div>

              {panelCheckResult.update_available ? (
                <div className="bg-accent/10 border border-accent/30 rounded-md p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-accent">
                        Update available: {panelCheckResult.release_name}
                      </p>
                      <p className="text-xs text-text-secondary mt-1">
                        Published {new Date(panelCheckResult.published_at).toLocaleDateString()}
                        {' · '}
                        <a
                          href={panelCheckResult.release_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          Release notes
                        </a>
                      </p>
                    </div>
                    <button
                      onClick={handlePanelApply}
                      disabled={!!isPanelUpdating}
                      className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                        'bg-accent text-white hover:bg-accent/90',
                        'disabled:opacity-50 disabled:cursor-not-allowed'
                      )}
                    >
                      <Download size={16} />
                      Update
                    </button>
                  </div>

                  {panelCheckResult.changelog && (
                    <details className="mt-3">
                      <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                        Changelog
                      </summary>
                      <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap bg-background rounded p-3 max-h-48 overflow-y-auto">
                        {panelCheckResult.changelog}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 size={16} />
                  You are running the latest version
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              Click "Check for updates" to see if a new version is available.
            </p>
          )}
        </div>

        {/* Panel Update Progress */}
        {panelStatus && panelStatus.phase !== 'idle' && (
          <div className="bg-surface rounded-lg p-5 border border-border">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Panel Update Progress</h2>

            {/* Step indicators */}
            <div className="flex items-center gap-1 mb-4">
              {PHASE_STEPS.map((step, i) => {
                const isActive = step === panelStatus.phase;
                const isCompleted = panelCurrentStep > i;
                const isFailed = panelStatus.phase === 'error' && panelCurrentStep === i;

                return (
                  <div key={step} className="flex items-center gap-1 flex-1">
                    <div className="flex flex-col items-center flex-1">
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center text-xs border-2 transition-colors',
                          isCompleted && 'bg-success/15 border-success text-success',
                          isActive && !isFailed && 'bg-accent/15 border-accent text-accent',
                          isFailed && 'bg-danger/15 border-danger text-danger',
                          !isCompleted && !isActive && !isFailed && 'border-border text-text-secondary'
                        )}
                      >
                        {isCompleted ? (
                          <CheckCircle2 size={16} />
                        ) : isActive && !isFailed ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : isFailed ? (
                          <XCircle size={16} />
                        ) : (
                          i + 1
                        )}
                      </div>
                      <span className="text-[10px] text-text-secondary mt-1 capitalize">{step}</span>
                    </div>
                    {i < PHASE_STEPS.length - 1 && (
                      <ArrowRight size={12} className="text-border mb-4 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Status message */}
            {panelStatus.message && (
              <p className="text-xs text-text-secondary bg-background rounded p-2">
                {panelStatus.message}
              </p>
            )}

            {/* Error */}
            {panelStatus.phase === 'error' && panelStatus.error && (
              <div className="mt-2">
                <ErrorAlert message={panelStatus.error} />
              </div>
            )}

            {/* Done */}
            {panelStatus.phase === 'done' && (
              <div className="flex items-center gap-2 text-sm text-success mt-2">
                <CheckCircle2 size={16} />
                {panelStatus.message}
              </div>
            )}

            {/* Debug Log */}
            {panelStatus.log && panelStatus.log.length > 0 && (
              <details className="mt-3" open={panelStatus.phase === 'error'}>
                <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                  Log ({panelStatus.log.length} entries)
                </summary>
                <div className="mt-2 max-h-48 overflow-y-auto bg-background rounded p-2 font-mono text-[11px] text-text-secondary space-y-0.5">
                  {panelStatus.log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Telemt Update Section */}
        {error && <ErrorAlert message={error} />}

        <div className="bg-surface rounded-lg p-5 border border-border">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-text-primary">Telemt Version</h2>
            <button
              onClick={handleCheck}
              disabled={checking || !!isUpdating}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                'bg-accent/15 text-accent hover:bg-accent/25',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={14} className={cn(checking && 'animate-spin')} />
              Check for updates
            </button>
          </div>

          {checkResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label="Current Version" value={checkResult.current_version} />
                <MetricCard label="Latest Version" value={checkResult.latest_version} />
              </div>

              {checkResult.update_available ? (
                <div className="bg-accent/10 border border-accent/30 rounded-md p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-accent">
                        Update available: {checkResult.release_name}
                      </p>
                      <p className="text-xs text-text-secondary mt-1">
                        Published {new Date(checkResult.published_at).toLocaleDateString()}
                        {' · '}
                        <a
                          href={checkResult.release_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                        >
                          Release notes
                        </a>
                      </p>
                    </div>
                    <button
                      onClick={handleApply}
                      disabled={!!isUpdating}
                      className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                        'bg-accent text-white hover:bg-accent/90',
                        'disabled:opacity-50 disabled:cursor-not-allowed'
                      )}
                    >
                      <Download size={16} />
                      Update
                    </button>
                  </div>

                  {checkResult.changelog && (
                    <details className="mt-3">
                      <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                        Changelog
                      </summary>
                      <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap bg-background rounded p-3 max-h-48 overflow-y-auto">
                        {checkResult.changelog}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 size={16} />
                  You are running the latest version
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              Click "Check for updates" to see if a new version is available.
            </p>
          )}
        </div>

        {/* Update Progress */}
        {status && status.phase !== 'idle' && (
          <div className="bg-surface rounded-lg p-5 border border-border">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Update Progress</h2>

            {/* Step indicators */}
            <div className="flex items-center gap-1 mb-4">
              {PHASE_STEPS.map((step, i) => {
                const isActive = step === status.phase;
                const isCompleted = currentStep > i;
                const isFailed = status.phase === 'error' && currentStep === i;

                return (
                  <div key={step} className="flex items-center gap-1 flex-1">
                    <div className="flex flex-col items-center flex-1">
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center text-xs border-2 transition-colors',
                          isCompleted && 'bg-success/15 border-success text-success',
                          isActive && !isFailed && 'bg-accent/15 border-accent text-accent',
                          isFailed && 'bg-danger/15 border-danger text-danger',
                          !isCompleted && !isActive && !isFailed && 'border-border text-text-secondary'
                        )}
                      >
                        {isCompleted ? (
                          <CheckCircle2 size={16} />
                        ) : isActive && !isFailed ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : isFailed ? (
                          <XCircle size={16} />
                        ) : (
                          i + 1
                        )}
                      </div>
                      <span className="text-[10px] text-text-secondary mt-1 capitalize">{step}</span>
                    </div>
                    {i < PHASE_STEPS.length - 1 && (
                      <ArrowRight size={12} className="text-border mb-4 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Status message */}
            {status.message && (
              <p className="text-xs text-text-secondary bg-background rounded p-2">
                {status.message}
              </p>
            )}

            {/* Error */}
            {status.phase === 'error' && status.error && (
              <div className="mt-2">
                <ErrorAlert message={status.error} />
              </div>
            )}

            {/* Done */}
            {status.phase === 'done' && (
              <div className="flex items-center gap-2 text-sm text-success mt-2">
                <CheckCircle2 size={16} />
                {status.message}
              </div>
            )}

            {/* Debug Log */}
            {status.log && status.log.length > 0 && (
              <details className="mt-3" open={status.phase === 'error'}>
                <summary className="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
                  Log ({status.log.length} entries)
                </summary>
                <div className="mt-2 max-h-48 overflow-y-auto bg-background rounded p-2 font-mono text-[11px] text-text-secondary space-y-0.5">
                  {status.log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
