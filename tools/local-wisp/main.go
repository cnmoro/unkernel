// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 cnmoro

package main

import (
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"time"
)

const site = "https://linux.kinetiq.com.br"
const defaultPort = 8765

var statusPage = template.Must(template.New("status").Parse(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unkernel Local Wisp</title>
<style>body{font:1rem/1.55 system-ui;max-width:36rem;margin:10vh auto;padding:1rem;color-scheme:light dark}input{font:inherit;width:100%;box-sizing:border-box;padding:.55rem}button{font:inherit;padding:.4rem .65rem}</style>
<h1>Unkernel Local Wisp</h1>
<p>The relay is running on this computer.</p>
<p><label for="relay">Wisp URL</label><br><input id="relay" value="{{.Relay}}" readonly></p>
<p>In <a href="{{.Site}}">Unkernel</a>, open <b>System → Network → Wisp, custom servers</b>. Paste this URL, choose <b>Test local relay</b> if available, and allow loopback access if the browser asks. Select <b>Reboot to apply</b>.</p>
<form method="post" action="/stop"><input type="hidden" name="token" value="{{.Token}}"><button>Stop relay</button></form>
</html>`))

func main() {
	port := flag.Int("port", defaultPort, "loopback port")
	origin := flag.String("origin", site, "web app origin allowed to connect")
	tlsOn := flag.Bool("tls", false, "enable HTTPS and WSS with a locally generated certificate")
	noOpen := flag.Bool("no-open", false, "do not open the relay status page")
	flag.Parse()
	if err := run(*port, *origin, *tlsOn, *noOpen); err != nil {
		log.Fatal(err)
	}
}

func run(port int, origin string, tlsOn, noOpen bool) error {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || origin != u.Scheme+"://"+u.Host {
		return errors.New("origin must be an http(s) origin without a path, such as " + site)
	}
	if port < 1 || port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return err
	}
	defer listener.Close()

	scheme, wsScheme := "http", "ws"
	if tlsOn {
		cert, path, err := localCertificate()
		if err != nil {
			return err
		}
		log.Printf("Local CA certificate: %s", path)
		listener = tls.NewListener(listener, &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}})
		scheme, wsScheme = "https", "wss"
	}

	statusURL := scheme + "://" + address
	relayURL := wsScheme + "://" + address + "/wisp/"
	token := rand.Text()
	relay := serveRelay(origin)
	mux := http.NewServeMux()
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != address && r.Host != "localhost:"+strconv.Itoa(port) {
				http.Error(w, "Invalid host", http.StatusBadRequest)
				return
			}
			mux.ServeHTTP(w, r)
		}),
	}
	mux.HandleFunc("GET /wisp/{$}", relay)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		statusPage.Execute(w, struct{ Site, Relay, Token string }{origin, relayURL, token})
	})
	mux.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		requestOrigin := scheme + "://" + r.Host
		if r.Header.Get("Origin") != requestOrigin || subtle.ConstantTimeCompare([]byte(r.PostFormValue("token")), []byte(token)) != 1 {
			http.Error(w, "Invalid stop request", http.StatusForbidden)
			return
		}
		fmt.Fprintln(w, "Unkernel Local Wisp has stopped. You can close this tab.")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		go server.Close()
	})

	fmt.Printf("Wisp URL: %s\nStatus:   %s\nAllowed:  %s\n", relayURL, statusURL, origin)
	if !noOpen {
		go openBrowser(statusURL)
	}
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func openBrowser(target string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		command = exec.Command("open", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	if err := command.Run(); err != nil {
		log.Printf("Open the status page at %s", target)
	}
}
