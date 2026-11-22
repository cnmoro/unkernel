// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 cnmoro

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Persist the server key and the CA certificate; discard the CA signing key.
func localCertificate() (tls.Certificate, string, error) {
	var cert tls.Certificate
	dir, err := os.UserConfigDir()
	if err != nil {
		return cert, "", err
	}
	dir = filepath.Join(dir, "Unkernel Local Wisp")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return cert, "", err
	}
	bundlePath := filepath.Join(dir, "server.pem")
	caPath := filepath.Join(dir, "local-ca.crt")
	bundle, err := os.ReadFile(bundlePath)
	if errors.Is(err, os.ErrNotExist) {
		bundle, err = generateCertificate()
		if err == nil {
			err = writePEM(bundlePath, bundle)
		}
	}
	if err != nil {
		return cert, "", err
	}
	cert, err = tls.X509KeyPair(bundle, bundle)
	if err != nil {
		return cert, "", err
	}
	if len(cert.Certificate) != 2 || time.Now().After(cert.Leaf.NotAfter) {
		return cert, "", errors.New("invalid or expired local certificate: remove server.pem from " + dir + " and restart with -tls")
	}
	if err := writePEM(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[1]})); err != nil {
		return cert, "", err
	}
	return cert, caPath, nil
}

func writePEM(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".wisp-cert-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, writeErr := temp.Write(data)
	if err := errors.Join(writeErr, temp.Close()); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

func generateCertificate() ([]byte, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ca := &x509.Certificate{
		Subject:   pkix.Name{CommonName: "Unkernel Local Wisp CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(1, 0, 0),
		IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true,
		KeyUsage:                    x509.KeyUsageCertSign,
		PermittedDNSDomainsCritical: true, PermittedDNSDomains: []string{"localhost"},
		PermittedIPRanges: []*net.IPNet{{IP: net.IPv4(127, 0, 0, 1).To4(), Mask: net.CIDRMask(32, 32)}},
	}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	leaf := &x509.Certificate{
		Subject:   pkix.Name{CommonName: "localhost"},
		NotBefore: ca.NotBefore, NotAfter: ca.NotAfter,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	bundle := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	bundle = append(bundle, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	return append(bundle, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})...), nil
}
