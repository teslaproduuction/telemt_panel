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

func DownloadFile(url string) (string, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}

	resp, err := httpClient.Do(req)
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

func BackupBinary(binaryPath string) error {
	src, err := os.Open(binaryPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
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

	info, err := os.Stat(binaryPath)
	if err != nil {
		return err
	}
	return os.Chmod(binaryPath+".bak", info.Mode())
}

func RestoreBackup(binaryPath string) error {
	return os.Rename(binaryPath+".bak", binaryPath)
}

func RestartService(serviceName string) error {
	if !isValidServiceName(serviceName) {
		return fmt.Errorf("invalid service name: %q", serviceName)
	}
	cmd := exec.Command("systemctl", "restart", serviceName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart failed: %s: %w", string(output), err)
	}
	return nil
}

// isValidServiceName checks that the name contains only safe characters for systemd.
func isValidServiceName(name string) bool {
	if name == "" || len(name) > 256 {
		return false
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

// WaitForHealthy polls telemt health endpoint. logFn is called on each attempt for debug visibility.
func WaitForHealthy(telemtURL, authHeader string, timeout time.Duration, logFn func(string)) error {
	url := telemtURL + "/v1/health"
	deadline := time.Now().Add(timeout)
	attempt := 0
	var lastErr string

	for time.Now().Before(deadline) {
		attempt++
		req, _ := http.NewRequest("GET", url, nil)
		if authHeader != "" {
			req.Header.Set("Authorization", authHeader)
		}

		resp, err := httpClient.Do(req)
		if err != nil {
			msg := err.Error()
			if msg != lastErr {
				if logFn != nil {
					logFn(fmt.Sprintf("attempt %d: %s", attempt, msg))
				}
				lastErr = msg
			}
		} else {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				elapsed := timeout - time.Until(deadline)
				if logFn != nil {
					logFn(fmt.Sprintf("healthy after %d attempts (%.1fs)", attempt, elapsed.Seconds()))
				}
				return nil
			}
			msg := fmt.Sprintf("status %d", resp.StatusCode)
			if msg != lastErr {
				if logFn != nil {
					logFn(fmt.Sprintf("attempt %d: %s", attempt, msg))
				}
				lastErr = msg
			}
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("telemt did not become healthy within %s (%d attempts, last: %s)", timeout, attempt, lastErr)
}
