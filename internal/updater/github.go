package updater

import (
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/telemt/telemt-panel/internal/github"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

func archString() string {
	if runtime.GOARCH == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

// AssetName returns the expected binary asset filename for this architecture.
func AssetName() string {
	return "telemt-" + archString() + "-linux-gnu.tar.gz"
}

// NewAssetMatcher returns an AssetMatcher that finds Telemt binary and checksum assets.
// Checksum matching is flexible: it matches any asset ending in .sha256 whose name
// starts with the binary asset name prefix (without extension), covering both
// "telemt-x86_64-linux-gnu.sha256" and "telemt-x86_64-linux-gnu.tar.gz.sha256".
func NewAssetMatcher() github.AssetMatcher {
	binaryName := AssetName()
	prefix := strings.TrimSuffix(binaryName, ".tar.gz")
	return func(assets []github.GitHubAsset) (*github.GitHubAsset, *github.GitHubAsset) {
		var bin, sum *github.GitHubAsset
		for i := range assets {
			if assets[i].Name == binaryName {
				bin = &assets[i]
			}
			if sum == nil && strings.HasPrefix(assets[i].Name, prefix) && strings.HasSuffix(assets[i].Name, ".sha256") {
				sum = &assets[i]
			}
		}
		return bin, sum
	}
}

// splitOwnerRepo splits "owner/repo" into owner and repo parts.
func splitOwnerRepo(repo string) (string, string) {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return "", repo
	}
	return parts[0], parts[1]
}
