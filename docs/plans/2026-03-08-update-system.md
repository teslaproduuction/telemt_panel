# Telemt Update System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add version checking and self-update for telemt binary via GitHub Releases API, with extensible design for future panel updates.

**Architecture:** Go backend module `internal/updater/` handles GitHub API, download, sha256 verification, binary replacement, and systemd restart. Three new API endpoints (`/api/update/*`) exposed via `server.go`. Frontend gets a new `UpdatePage` with check/apply UI. Config extended with `binary_path`, `service_name`, `github_repo`.

**Tech Stack:** Go stdlib (`net/http`, `crypto/sha256`, `os/exec`, `archive/tar`, `compress/gzip`), React/TypeScript frontend, Tailwind CSS.

---

### Task 1: Extend Config

**Files:**
- Modify: `internal/config/config.go`
- Modify: `config.example.toml`

**Step 1: Add fields to TelemtConfig struct**

In `internal/config/config.go`, add three new fields to `TelemtConfig`:

```go
type TelemtConfig struct {
	URL         string `toml:"url"`
	AuthHeader  string `toml:"auth_header"`
	BinaryPath  string `toml:"binary_path"`
	ServiceName string `toml:"service_name"`
	GithubRepo  string `toml:"github_repo"`
}
```

Set defaults in `Load()` function — after `toml.Unmarshal`, add:

```go
if cfg.Telemt.BinaryPath == "" {
    cfg.Telemt.BinaryPath = "/bin/telemt"
}
if cfg.Telemt.ServiceName == "" {
    cfg.Telemt.ServiceName = "telemt"
}
if cfg.Telemt.GithubRepo == "" {
    cfg.Telemt.GithubRepo = "telemt/telemt"
}
```

**Step 2: Update config.example.toml**

Add under `[telemt]` section:

```toml
# Path to telemt binary (default: /bin/telemt)
# binary_path = "/bin/telemt"
# Systemd service name (default: telemt)
# service_name = "telemt"
# GitHub repository for update checks (default: telemt/telemt)
# github_repo = "telemt/telemt"
```

**Step 3: Build and verify**

Run: `go build ./...`
Expected: success, no errors.

**Step 4: Commit**

```
feat: add update-related config fields (binary_path, service_name, github_repo)
```

---

### Task 2: Create `internal/updater/github.go`

**Files:**
- Create: `internal/updater/github.go`

**Step 1: Write github.go**

```go
package updater

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"time"
)

type GitHubRelease struct {
	TagName     string        `json:"tag_name"`
	Name        string        `json:"name"`
	Body        string        `json:"body"`
	HTMLURL     string        `json:"html_url"`
	PublishedAt time.Time     `json:"published_at"`
	Prerelease  bool          `json:"prerelease"`
	Draft       bool          `json:"draft"`
	Assets      []GitHubAsset `json:"assets"`
}

type GitHubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func FetchLatestRelease(repo string) (*GitHubRelease, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("github returned status %d", resp.StatusCode)
	}

	var release GitHubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}

	return &release, nil
}

// archString maps GOARCH to the naming used in telemt release assets.
func archString() string {
	switch runtime.GOARCH {
	case "arm64":
		return "aarch64"
	default:
		return "x86_64"
	}
}

// AssetName returns the expected tarball asset name for the current architecture.
func AssetName() string {
	return fmt.Sprintf("telemt-%s-linux-gnu.tar.gz", archString())
}

// Sha256AssetName returns the expected sha256 checksum asset name.
func Sha256AssetName() string {
	return fmt.Sprintf("telemt-%s-linux-gnu.sha256", archString())
}

// FindAsset finds an asset by name in a release.
func FindAsset(release *GitHubRelease, name string) (*GitHubAsset, bool) {
	for i := range release.Assets {
		if release.Assets[i].Name == name {
			return &release.Assets[i], true
		}
	}
	return nil, false
}
```

**Step 2: Build and verify**

Run: `go build ./...`
Expected: success.

**Step 3: Commit**

```
feat: add GitHub Releases API client for update checks
```

---

### Task 3: Create `internal/updater/system.go`

**Files:**
- Create: `internal/updater/system.go`

**Step 1: Write system.go**

```go
package updater

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DownloadFile downloads a URL to a temporary file, returning its path.
func DownloadFile(url string) (string, error) {
	resp, err := httpClient.Do(mustNewRequest(url))
	if err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp("", "telemt-update-*")
	if err != nil {
		return "", err
	}
	defer tmp.Close()

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}

	return tmp.Name(), nil
}

// VerifySha256 checks that the file at path matches the expected sha256 hash string.
// expectedLine is the content of the .sha256 file ("hash  filename\n").
func VerifySha256(path string, expectedLine string) error {
	expectedHash := strings.Fields(expectedLine)[0]

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}

	actual := hex.EncodeToString(h.Sum(nil))
	if actual != expectedHash {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", expectedHash, actual)
	}
	return nil
}

// ExtractBinary extracts the first regular file from a .tar.gz archive to destPath.
func ExtractBinary(tarGzPath, destPath string) error {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("no files found in archive")
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}

		// Write to temp file next to destination, then atomic rename.
		dir := filepath.Dir(destPath)
		tmp, err := os.CreateTemp(dir, ".telemt-update-*")
		if err != nil {
			return err
		}
		tmpName := tmp.Name()

		if _, err := io.Copy(tmp, tr); err != nil {
			tmp.Close()
			os.Remove(tmpName)
			return err
		}
		tmp.Close()

		if err := os.Chmod(tmpName, 0755); err != nil {
			os.Remove(tmpName)
			return err
		}

		if err := os.Rename(tmpName, destPath); err != nil {
			os.Remove(tmpName)
			return err
		}
		return nil
	}
}

// BackupBinary copies binaryPath to binaryPath + ".bak".
func BackupBinary(binaryPath string) error {
	src, err := os.Open(binaryPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // nothing to backup
		}
		return err
	}
	defer src.Close()

	dst, err := os.Create(binaryPath + ".bak")
	if err != nil {
		return err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return err
	}

	// Preserve permissions.
	info, err := os.Stat(binaryPath)
	if err != nil {
		return err
	}
	return os.Chmod(binaryPath+".bak", info.Mode())
}

// RestoreBackup restores the .bak file back to binaryPath.
func RestoreBackup(binaryPath string) error {
	return os.Rename(binaryPath+".bak", binaryPath)
}

// RestartService runs systemctl restart for the given service.
func RestartService(serviceName string) error {
	cmd := exec.Command("systemctl", "restart", serviceName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart failed: %s: %w", string(output), err)
	}
	return nil
}

// WaitForHealthy polls the telemt API healthcheck until it responds or timeout.
func WaitForHealthy(telemtURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := httpClient.Get(telemtURL + "/v1/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("telemt did not become healthy within %s", timeout)
}

func mustNewRequest(url string) *http.Request {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		panic(err)
	}
	return req
}
```

**Step 2: Build and verify**

Run: `go build ./...`
Expected: success.

**Step 3: Commit**

```
feat: add system helpers for update (download, sha256, extract, systemctl)
```

---

### Task 4: Create `internal/updater/updater.go`

**Files:**
- Create: `internal/updater/updater.go`

**Step 1: Write updater.go**

This is the main orchestrator that ties github.go and system.go together, with status tracking.

```go
package updater

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type Phase string

const (
	PhaseIdle        Phase = "idle"
	PhaseChecking    Phase = "checking"
	PhaseDownloading Phase = "downloading"
	PhaseVerifying   Phase = "verifying"
	PhaseReplacing   Phase = "replacing"
	PhaseRestarting  Phase = "restarting"
	PhaseDone        Phase = "done"
	PhaseError       Phase = "error"
)

type Status struct {
	Phase   Phase  `json:"phase"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

type CheckResult struct {
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	ReleaseName     string `json:"release_name"`
	ReleaseURL      string `json:"release_url"`
	PublishedAt     string `json:"published_at,omitempty"`
	Changelog       string `json:"changelog,omitempty"`
}

type Updater struct {
	mu          sync.Mutex
	status      Status
	telemtURL   string
	binaryPath  string
	serviceName string
	githubRepo  string
	authHeader  string
}

func New(telemtURL, binaryPath, serviceName, githubRepo, authHeader string) *Updater {
	return &Updater{
		status:      Status{Phase: PhaseIdle},
		telemtURL:   telemtURL,
		binaryPath:  binaryPath,
		serviceName: serviceName,
		githubRepo:  githubRepo,
		authHeader:  authHeader,
	}
}

func (u *Updater) GetStatus() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.status
}

func (u *Updater) setStatus(phase Phase, message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status = Status{Phase: phase, Message: message}
	log.Printf("[updater] %s: %s", phase, message)
}

func (u *Updater) setError(err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status = Status{Phase: PhaseError, Error: err.Error()}
	log.Printf("[updater] error: %s", err)
}

// fetchCurrentVersion queries the telemt API for the running version.
func (u *Updater) fetchCurrentVersion() (string, error) {
	req, err := http.NewRequest("GET", u.telemtURL+"/v1/system/info", nil)
	if err != nil {
		return "", err
	}
	if u.authHeader != "" {
		req.Header.Set("Authorization", u.authHeader)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("query telemt version: %w", err)
	}
	defer resp.Body.Close()

	var info struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", fmt.Errorf("decode system info: %w", err)
	}
	return info.Version, nil
}

// Check compares the running telemt version with the latest GitHub release.
func (u *Updater) Check() (*CheckResult, error) {
	currentVersion, err := u.fetchCurrentVersion()
	if err != nil {
		return nil, fmt.Errorf("get current version: %w", err)
	}

	release, err := FetchLatestRelease(u.githubRepo)
	if err != nil {
		return nil, fmt.Errorf("fetch latest release: %w", err)
	}

	latestVersion := strings.TrimPrefix(release.TagName, "v")

	return &CheckResult{
		CurrentVersion:  currentVersion,
		LatestVersion:   latestVersion,
		UpdateAvailable: latestVersion != currentVersion,
		ReleaseName:     release.Name,
		ReleaseURL:      release.HTMLURL,
		PublishedAt:     release.PublishedAt.Format(time.RFC3339),
		Changelog:       release.Body,
	}, nil
}

// Apply downloads, verifies, replaces, and restarts. Runs in background.
func (u *Updater) Apply() error {
	u.mu.Lock()
	if u.status.Phase != PhaseIdle && u.status.Phase != PhaseDone && u.status.Phase != PhaseError {
		u.mu.Unlock()
		return fmt.Errorf("update already in progress: %s", u.status.Phase)
	}
	u.mu.Unlock()

	go u.applyAsync()
	return nil
}

func (u *Updater) applyAsync() {
	u.setStatus(PhaseChecking, "fetching latest release")

	release, err := FetchLatestRelease(u.githubRepo)
	if err != nil {
		u.setError(fmt.Errorf("fetch release: %w", err))
		return
	}

	tarAsset, ok := FindAsset(release, AssetName())
	if !ok {
		u.setError(fmt.Errorf("asset %s not found in release %s", AssetName(), release.TagName))
		return
	}

	shaAsset, ok := FindAsset(release, Sha256AssetName())
	if !ok {
		u.setError(fmt.Errorf("checksum asset %s not found", Sha256AssetName()))
		return
	}

	// Download sha256
	u.setStatus(PhaseDownloading, "downloading checksum")
	shaPath, err := DownloadFile(shaAsset.BrowserDownloadURL)
	if err != nil {
		u.setError(fmt.Errorf("download checksum: %w", err))
		return
	}
	defer os.Remove(shaPath)

	shaBytes, err := os.ReadFile(shaPath)
	if err != nil {
		u.setError(fmt.Errorf("read checksum: %w", err))
		return
	}

	// Download tarball
	u.setStatus(PhaseDownloading, fmt.Sprintf("downloading %s (%d MB)", tarAsset.Name, tarAsset.Size/1024/1024))
	tarPath, err := DownloadFile(tarAsset.BrowserDownloadURL)
	if err != nil {
		u.setError(fmt.Errorf("download tarball: %w", err))
		return
	}
	defer os.Remove(tarPath)

	// Verify sha256
	u.setStatus(PhaseVerifying, "verifying sha256 checksum")
	if err := VerifySha256(tarPath, string(shaBytes)); err != nil {
		u.setError(fmt.Errorf("checksum verification: %w", err))
		return
	}

	// Backup current binary
	u.setStatus(PhaseReplacing, "backing up current binary")
	if err := BackupBinary(u.binaryPath); err != nil {
		u.setError(fmt.Errorf("backup: %w", err))
		return
	}

	// Extract new binary
	u.setStatus(PhaseReplacing, "extracting new binary")
	if err := ExtractBinary(tarPath, u.binaryPath); err != nil {
		u.setError(fmt.Errorf("extract: %w", err))
		return
	}

	// Restart service
	u.setStatus(PhaseRestarting, fmt.Sprintf("restarting %s", u.serviceName))
	if err := RestartService(u.serviceName); err != nil {
		// Rollback
		log.Printf("[updater] restart failed, rolling back: %s", err)
		if rbErr := RestoreBackup(u.binaryPath); rbErr != nil {
			u.setError(fmt.Errorf("restart failed (%w) AND rollback failed (%s)", err, rbErr))
			return
		}
		RestartService(u.serviceName) // try restart with old binary
		u.setError(fmt.Errorf("restart failed, rolled back: %w", err))
		return
	}

	// Wait for healthy
	u.setStatus(PhaseRestarting, "waiting for telemt to become healthy")
	if err := WaitForHealthy(u.telemtURL, 15*time.Second); err != nil {
		// Rollback
		log.Printf("[updater] healthcheck failed, rolling back: %s", err)
		if rbErr := RestoreBackup(u.binaryPath); rbErr != nil {
			u.setError(fmt.Errorf("healthcheck failed (%w) AND rollback failed (%s)", err, rbErr))
			return
		}
		RestartService(u.serviceName)
		u.setError(fmt.Errorf("healthcheck failed, rolled back: %w", err))
		return
	}

	// Verify version
	newVersion, err := u.fetchCurrentVersion()
	if err != nil {
		u.setStatus(PhaseDone, fmt.Sprintf("updated to %s (version verification skipped)", release.TagName))
		return
	}

	u.setStatus(PhaseDone, fmt.Sprintf("updated to %s", newVersion))
}

// DownloadSha256Content downloads the .sha256 file and returns its content as string.
func DownloadSha256Content(url string) (string, error) {
	resp, err := httpClient.Do(mustNewRequest(url))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
```

**Step 2: Build and verify**

Run: `go build ./...`
Expected: success.

**Step 3: Commit**

```
feat: add Updater orchestrator with check/apply/status/rollback
```

---

### Task 5: Wire Update API into Server

**Files:**
- Modify: `internal/server/server.go`

**Step 1: Add updater import and initialization**

Add to imports:
```go
"github.com/telemt/telemt-panel/internal/updater"
```

In `Run()`, after `telemtProxy` initialization, add:

```go
upd := updater.New(
    s.cfg.Telemt.URL,
    s.cfg.Telemt.BinaryPath,
    s.cfg.Telemt.ServiceName,
    s.cfg.Telemt.GithubRepo,
    s.cfg.Telemt.AuthHeader,
)
```

**Step 2: Register three endpoint handlers**

Add before `// SPA` comment:

```go
// Update endpoints
mux.Handle("GET /api/update/check", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    result, err := upd.Check()
    if err != nil {
        writeError(w, http.StatusBadGateway, "update_check_failed", err.Error())
        return
    }
    writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
})))

mux.Handle("POST /api/update/apply", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    if err := upd.Apply(); err != nil {
        writeError(w, http.StatusConflict, "update_in_progress", err.Error())
        return
    }
    writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: upd.GetStatus()})
})))

mux.Handle("GET /api/update/status", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: upd.GetStatus()})
})))
```

**Step 3: Build and verify**

Run: `go build ./...`
Expected: success.

**Step 4: Commit**

```
feat: wire update check/apply/status API endpoints into server
```

---

### Task 6: Add Frontend API Helper

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Step 1: Add panelApi object**

Add after the `authApi` object:

```typescript
const PANEL_BASE = '/api';

export const panelApi = {
  get: <T>(path: string) => request<T>(PANEL_BASE, path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(PANEL_BASE, path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
};
```

**Step 2: Build and verify**

Run: `cd frontend && npm run build`
Expected: success.

**Step 3: Commit**

```
feat: add panelApi client for /api/* endpoints
```

---

### Task 7: Create UpdatePage Frontend

**Files:**
- Create: `frontend/src/pages/UpdatePage.tsx`

**Step 1: Write UpdatePage.tsx**

```tsx
import { useState, useEffect, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { MetricCard } from '@/components/MetricCard';
import { StatusBadge } from '@/components/StatusBadge';
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
}

const PHASE_STEPS = ['checking', 'downloading', 'verifying', 'replacing', 'restarting'];

export function UpdatePage() {
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isUpdating = status && !['idle', 'done', 'error'].includes(status.phase);

  async function handleCheck() {
    setChecking(true);
    setError(null);
    try {
      const result = await panelApi.get<CheckResult>('/update/check');
      setCheckResult(result);
    } catch (e: any) {
      setError(e.message || 'Failed to check for updates');
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
    } catch (e: any) {
      setError(e.message || 'Failed to start update');
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
            // Re-check to refresh version info
            try {
              const result = await panelApi.get<CheckResult>('/update/check');
              setCheckResult(result);
            } catch {}
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

  useEffect(() => {
    return () => stopPolling();
  }, []);

  const currentStep = status ? PHASE_STEPS.indexOf(status.phase) : -1;

  return (
    <div className="min-h-screen">
      <Header title="Update" onRefresh={handleCheck} />
      <div className="p-6 space-y-6 max-w-3xl">

        {error && <ErrorAlert message={error} />}

        {/* Version Info */}
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
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Build and verify**

Run: `cd frontend && npm run build`
Expected: success.

**Step 3: Commit**

```
feat: add UpdatePage with version check and update progress UI
```

---

### Task 8: Wire UpdatePage into Router and Sidebar

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/layout/Sidebar.tsx`

**Step 1: Add route in App.tsx**

Add import:
```tsx
import { UpdatePage } from '@/pages/UpdatePage';
```

Add route inside the `<Route element={<AppLayout />}>` block, after the upstreams route:
```tsx
<Route path="/update" element={<UpdatePage />} />
```

**Step 2: Add nav item in Sidebar.tsx**

Add `ArrowUpCircle` to the lucide-react import:
```tsx
import { LayoutDashboard, Users, Activity, Shield, Network, ArrowUpCircle, LogOut } from 'lucide-react';
```

Add to `navItems` array:
```tsx
{ to: '/update', icon: ArrowUpCircle, label: 'Update' },
```

**Step 3: Build and verify**

Run: `cd frontend && npm run build`
Expected: success.

**Step 4: Commit**

```
feat: add Update page to sidebar navigation and router
```

---

### Task 9: Full Build and Verification

**Step 1: Build Go backend**

Run: `go build ./...`
Expected: success.

**Step 2: Build frontend**

Run: `cd frontend && npm run build`
Expected: success.

**Step 3: Verify config.example.toml has new fields**

Check that `binary_path`, `service_name`, `github_repo` are documented.

**Step 4: Verify all API endpoints registered**

Check `server.go` has `/api/update/check`, `/api/update/apply`, `/api/update/status`.

**Step 5: Commit any remaining fixes**

```
chore: final verification and cleanup
```

---

## File Summary

| File | Action | Purpose |
|---|---|---|
| `internal/config/config.go` | Modify | Add `BinaryPath`, `ServiceName`, `GithubRepo` fields |
| `config.example.toml` | Modify | Document new config fields |
| `internal/updater/github.go` | Create | GitHub Releases API client |
| `internal/updater/system.go` | Create | Download, sha256, extract, systemctl helpers |
| `internal/updater/updater.go` | Create | Orchestrator with check/apply/status |
| `internal/server/server.go` | Modify | Register `/api/update/*` endpoints |
| `frontend/src/lib/api.ts` | Modify | Add `panelApi` for `/api/*` calls |
| `frontend/src/pages/UpdatePage.tsx` | Create | Update UI page |
| `frontend/src/App.tsx` | Modify | Add `/update` route |
| `frontend/src/components/layout/Sidebar.tsx` | Modify | Add Update nav item |
