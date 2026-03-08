package config

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/BurntSushi/toml"
	"golang.org/x/crypto/bcrypt"
)

type Config struct {
	Listen string       `toml:"listen"`
	Telemt TelemtConfig `toml:"telemt"`
	Panel  PanelConfig  `toml:"panel"`
	Auth   AuthConfig   `toml:"auth"`
	TLS    TLSConfig    `toml:"tls"`
}

type TLSConfig struct {
	CertFile     string `toml:"cert_file"`
	KeyFile      string `toml:"key_file"`
	AcmeDomain   string `toml:"acme_domain"`
	AcmeCacheDir string `toml:"acme_cache_dir"`
}

type TelemtConfig struct {
	URL         string `toml:"url"`
	AuthHeader  string `toml:"auth_header"`
	BinaryPath  string `toml:"binary_path"`
	ServiceName string `toml:"service_name"`
	GithubRepo  string `toml:"github_repo"`
}

type PanelConfig struct {
	BinaryPath  string `toml:"binary_path"`
	ServiceName string `toml:"service_name"`
	GithubRepo  string `toml:"github_repo"`
}

type AuthConfig struct {
	Username     string `toml:"username"`
	PasswordHash string `toml:"password_hash"`
	JWTSecret    string `toml:"jwt_secret"`
	SessionTTL   string `toml:"session_ttl"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		Listen: "0.0.0.0:8080",
		Auth: AuthConfig{
			SessionTTL: "24h",
		},
	}

	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Telemt.BinaryPath == "" {
		cfg.Telemt.BinaryPath = "/bin/telemt"
	}
	if cfg.Telemt.ServiceName == "" {
		cfg.Telemt.ServiceName = "telemt"
	}
	if cfg.Telemt.GithubRepo == "" {
		cfg.Telemt.GithubRepo = "telemt/telemt"
	}

	if cfg.Panel.BinaryPath == "" {
		cfg.Panel.BinaryPath = "/usr/local/bin/telemt-panel"
	}
	if cfg.Panel.ServiceName == "" {
		cfg.Panel.ServiceName = "telemt-panel"
	}
	if cfg.Panel.GithubRepo == "" {
		cfg.Panel.GithubRepo = "amirotin/telemt_panel"
	}

	if cfg.TLS.AcmeCacheDir == "" {
		cfg.TLS.AcmeCacheDir = "/var/lib/telemt-panel/certs"
	}

	if cfg.TLS.CertFile != "" && cfg.TLS.AcmeDomain != "" {
		return nil, fmt.Errorf("tls: cert_file and acme_domain are mutually exclusive")
	}
	if (cfg.TLS.CertFile != "") != (cfg.TLS.KeyFile != "") {
		return nil, fmt.Errorf("tls: both cert_file and key_file must be set")
	}

	if cfg.Telemt.URL == "" {
		return nil, fmt.Errorf("telemt.url is required")
	}
	if cfg.Auth.Username == "" {
		return nil, fmt.Errorf("auth.username is required")
	}
	if cfg.Auth.PasswordHash == "" {
		return nil, fmt.Errorf("auth.password_hash is required")
	}

	// Auto-hash plain text passwords (not starting with $2a$, $2b$, or $2y$)
	if !strings.HasPrefix(cfg.Auth.PasswordHash, "$2a$") &&
		!strings.HasPrefix(cfg.Auth.PasswordHash, "$2b$") &&
		!strings.HasPrefix(cfg.Auth.PasswordHash, "$2y$") {
		hash, err := bcrypt.GenerateFromPassword([]byte(cfg.Auth.PasswordHash), 10)
		if err != nil {
			return nil, fmt.Errorf("hash password: %w", err)
		}
		log.Println("WARNING: password_hash contains plain text password. Replace it with the following bcrypt hash:")
		log.Printf("  password_hash = \"%s\"", string(hash))
		cfg.Auth.PasswordHash = string(hash)
	}
	if cfg.Auth.JWTSecret == "" {
		return nil, fmt.Errorf("auth.jwt_secret is required")
	}

	return cfg, nil
}
