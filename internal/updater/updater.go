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
	Phase   Phase    `json:"phase"`
	Message string   `json:"message,omitempty"`
	Error   string   `json:"error,omitempty"`
	Log     []string `json:"log,omitempty"`
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

const maxLogEntries = 500

func (u *Updater) appendLog(msg string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.status.Log) >= maxLogEntries {
		// Keep the last half of entries to avoid losing recent context
		u.status.Log = u.status.Log[maxLogEntries/2:]
	}
	u.status.Log = append(u.status.Log, msg)
	log.Printf("[updater] %s", msg)
}

func (u *Updater) setStatus(phase Phase, message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status.Phase = phase
	u.status.Message = message
	u.status.Error = ""
	u.status.Log = append(u.status.Log, fmt.Sprintf("[%s] %s", phase, message))
	log.Printf("[updater] %s: %s", phase, message)
}

func (u *Updater) setError(err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status.Phase = PhaseError
	u.status.Error = err.Error()
	u.status.Log = append(u.status.Log, fmt.Sprintf("[error] %s", err))
	log.Printf("[updater] error: %s", err)
}

func (u *Updater) fetchCurrentVersion() (string, error) {
	url := u.telemtURL + "/v1/system/info"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	if u.authHeader != "" {
		req.Header.Set("Authorization", u.authHeader)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("query telemt version at %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("telemt %s returned status %d: %s", url, resp.StatusCode, string(body))
	}

	// Telemt API wraps responses: {"ok": true, "data": {"version": "3.3.10", ...}}
	// Try envelope first, fall back to flat structure.
	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			Version string `json:"version"`
		} `json:"data"`
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response body: %w", err)
	}

	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("decode system info: %w (body: %s)", err, truncate(body, 200))
	}

	if envelope.Data.Version != "" {
		return envelope.Data.Version, nil
	}

	// Fallback: try flat {"version": "..."}
	var flat struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &flat); err == nil && flat.Version != "" {
		return flat.Version, nil
	}

	return "", fmt.Errorf("version field not found in response: %s", truncate(body, 200))
}

func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "..."
}

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

func (u *Updater) Apply() error {
	u.mu.Lock()
	if u.status.Phase != PhaseIdle && u.status.Phase != PhaseDone && u.status.Phase != PhaseError {
		u.mu.Unlock()
		return fmt.Errorf("update already in progress: %s", u.status.Phase)
	}
	// Reset log for new run
	u.status = Status{Phase: PhaseIdle}
	u.mu.Unlock()

	go u.applyAsync()
	return nil
}

func (u *Updater) applyAsync() {
	u.appendLog(fmt.Sprintf("config: binary_path=%s, service=%s, repo=%s", u.binaryPath, u.serviceName, u.githubRepo))
	u.appendLog(fmt.Sprintf("arch: asset=%s", AssetName()))

	u.setStatus(PhaseChecking, "fetching latest release")

	release, err := FetchLatestRelease(u.githubRepo)
	if err != nil {
		u.setError(fmt.Errorf("fetch release: %w", err))
		return
	}
	u.appendLog(fmt.Sprintf("latest release: %s (%s)", release.TagName, release.Name))

	tarAsset, ok := FindAsset(release, AssetName())
	if !ok {
		available := make([]string, len(release.Assets))
		for i, a := range release.Assets {
			available[i] = a.Name
		}
		u.setError(fmt.Errorf("asset %s not found in release %s (available: %v)", AssetName(), release.TagName, available))
		return
	}
	u.appendLog(fmt.Sprintf("tarball: %s (%d bytes)", tarAsset.Name, tarAsset.Size))

	shaAsset, ok := FindAsset(release, Sha256AssetName())
	if !ok {
		u.setError(fmt.Errorf("checksum asset %s not found", Sha256AssetName()))
		return
	}

	// Download sha256
	u.setStatus(PhaseDownloading, "downloading checksum")
	u.appendLog(fmt.Sprintf("downloading sha256 from %s", shaAsset.BrowserDownloadURL))
	shaPath, err := DownloadFile(shaAsset.BrowserDownloadURL)
	if err != nil {
		u.setError(fmt.Errorf("download checksum: %w", err))
		return
	}
	defer os.Remove(shaPath)
	u.appendLog(fmt.Sprintf("sha256 saved to %s", shaPath))

	shaBytes, err := os.ReadFile(shaPath)
	if err != nil {
		u.setError(fmt.Errorf("read checksum: %w", err))
		return
	}
	u.appendLog(fmt.Sprintf("expected sha256: %s", strings.TrimSpace(string(shaBytes))))

	// Download tarball
	u.setStatus(PhaseDownloading, fmt.Sprintf("downloading %s (%d MB)", tarAsset.Name, tarAsset.Size/1024/1024))
	u.appendLog(fmt.Sprintf("downloading tarball from %s", tarAsset.BrowserDownloadURL))
	tarPath, err := DownloadFile(tarAsset.BrowserDownloadURL)
	if err != nil {
		u.setError(fmt.Errorf("download tarball: %w", err))
		return
	}
	defer os.Remove(tarPath)

	tarInfo, _ := os.Stat(tarPath)
	if tarInfo != nil {
		u.appendLog(fmt.Sprintf("tarball saved to %s (%d bytes)", tarPath, tarInfo.Size()))
	}

	// Verify sha256
	u.setStatus(PhaseVerifying, "verifying sha256 checksum")
	if err := VerifySha256(tarPath, string(shaBytes)); err != nil {
		u.setError(fmt.Errorf("checksum verification: %w", err))
		return
	}
	u.appendLog("sha256 checksum verified OK")

	// Backup current binary
	u.setStatus(PhaseReplacing, fmt.Sprintf("backing up %s to %s.bak", u.binaryPath, u.binaryPath))
	if err := BackupBinary(u.binaryPath); err != nil {
		u.setError(fmt.Errorf("backup %s: %w", u.binaryPath, err))
		return
	}
	u.appendLog(fmt.Sprintf("backup created: %s.bak", u.binaryPath))

	// Extract new binary
	u.setStatus(PhaseReplacing, fmt.Sprintf("extracting to %s", u.binaryPath))
	if err := ExtractBinary(tarPath, u.binaryPath); err != nil {
		u.setError(fmt.Errorf("extract to %s: %w", u.binaryPath, err))
		return
	}

	newInfo, _ := os.Stat(u.binaryPath)
	if newInfo != nil {
		u.appendLog(fmt.Sprintf("new binary written: %s (%d bytes, mode %s)", u.binaryPath, newInfo.Size(), newInfo.Mode()))
	}

	// Restart service
	u.setStatus(PhaseRestarting, fmt.Sprintf("running: systemctl restart %s", u.serviceName))
	if err := RestartService(u.serviceName); err != nil {
		u.appendLog(fmt.Sprintf("restart failed: %s, rolling back", err))
		if rbErr := RestoreBackup(u.binaryPath); rbErr != nil {
			u.setError(fmt.Errorf("restart failed (%w) AND rollback failed (%s)", err, rbErr))
			return
		}
		u.appendLog("rollback complete, restarting with old binary")
		RestartService(u.serviceName)
		u.setError(fmt.Errorf("restart failed, rolled back: %w", err))
		return
	}
	u.appendLog("systemctl restart succeeded")

	// Wait for healthy
	u.setStatus(PhaseRestarting, fmt.Sprintf("waiting for %s/v1/health (max 90s)", u.telemtURL))
	if err := WaitForHealthy(u.telemtURL, u.authHeader, 90*time.Second, func(msg string) {
		u.appendLog(fmt.Sprintf("healthcheck: %s", msg))
	}); err != nil {
		u.appendLog(fmt.Sprintf("healthcheck failed: %s, rolling back", err))
		if rbErr := RestoreBackup(u.binaryPath); rbErr != nil {
			u.setError(fmt.Errorf("healthcheck failed (%w) AND rollback failed (%s)", err, rbErr))
			return
		}
		u.appendLog("rollback complete, restarting with old binary")
		RestartService(u.serviceName)
		u.setError(fmt.Errorf("healthcheck failed, rolled back: %w", err))
		return
	}
	u.appendLog("healthcheck passed")

	// Verify version
	newVersion, err := u.fetchCurrentVersion()
	if err != nil {
		u.appendLog(fmt.Sprintf("version check after update failed: %s", err))
		u.setStatus(PhaseDone, fmt.Sprintf("binary replaced with %s (version verification failed: %s)", release.TagName, err))
		return
	}

	u.appendLog(fmt.Sprintf("running version after update: %s", newVersion))
	u.setStatus(PhaseDone, fmt.Sprintf("updated to %s", newVersion))
}
