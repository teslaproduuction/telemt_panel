package telemt_config

import (
	"os"
	"syscall"
)

func preserveFileOwnership(path string, origStat os.FileInfo) {
	os.Chmod(path, origStat.Mode().Perm())
	if sys, ok := origStat.Sys().(*syscall.Stat_t); ok {
		os.Chown(path, int(sys.Uid), int(sys.Gid))
	}
}
