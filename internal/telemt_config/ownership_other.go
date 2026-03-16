//go:build !linux

package telemt_config

import "os"

func preserveFileOwnership(path string, origStat os.FileInfo) {
	os.Chmod(path, origStat.Mode().Perm())
}
