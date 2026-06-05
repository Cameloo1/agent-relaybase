//go:build !windows

package preferences

import "os"

func replaceFile(source string, destination string) error {
	return os.Rename(source, destination)
}
