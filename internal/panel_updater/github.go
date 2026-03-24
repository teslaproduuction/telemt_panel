package panel_updater

import (
	"runtime"
	"strings"

	"github.com/telemt/telemt-panel/internal/github"
)

func archString() string {
	if runtime.GOARCH == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

func AssetName() string {
	return "telemt-panel-" + archString() + "-linux-gnu.tar.gz"
}

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

func splitOwnerRepo(repo string) (string, string) {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return "", repo
	}
	return parts[0], parts[1]
}
