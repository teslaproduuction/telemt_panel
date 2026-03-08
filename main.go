package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"golang.org/x/term"

	"github.com/telemt/telemt-panel/internal/auth"
	"github.com/telemt/telemt-panel/internal/config"
	"github.com/telemt/telemt-panel/internal/server"
)

var version = "0.1.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println("telemt-panel " + version)
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		fmt.Print("Enter password: ")
		passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println() // newline after hidden input
		if err != nil {
			log.Fatalf("Failed to read password: %v", err)
		}
		hash, err := auth.HashPassword(string(passwordBytes))
		if err != nil {
			log.Fatalf("Failed to hash password: %v", err)
		}
		fmt.Println(hash)
		return
	}

	configPath := flag.String("config", "config.toml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	srv := server.New(cfg)
	log.Fatal(srv.Run(distFS))
}
