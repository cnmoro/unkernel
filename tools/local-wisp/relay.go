// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 cnmoro

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	packetConnect  = 1
	packetData     = 2
	packetContinue = 3
	packetClose    = 4

	closeNormal      = 0x02
	closeNetwork     = 0x03
	closeInvalid     = 0x41
	closeUnreachable = 0x42
	closeTimeout     = 0x43
	closeBlocked     = 0x48
	closeThrottled   = 0x49

	window     = 8
	maxPacket  = 64 << 10
	maxStreams = 128
)

var sharedIPv4 = netip.MustParsePrefix("100.64.0.0/10")
var benchmarkIPv4 = netip.MustParsePrefix("198.18.0.0/15")
var reservedIPv4 = netip.MustParsePrefix("240.0.0.0/4")

func publicIPv4(ip netip.Addr) bool {
	return ip.Is4() && ip.IsGlobalUnicast() && !ip.IsPrivate() &&
		!sharedIPv4.Contains(ip) && !benchmarkIPv4.Contains(ip) && !reservedIPv4.Contains(ip)
}

type session struct {
	ctx     context.Context
	socket  *websocket.Conn
	writes  sync.Mutex
	mu      sync.Mutex
	streams map[uint32]*stream
}

type stream struct {
	ctx    context.Context
	cancel context.CancelFunc
	input  chan []byte
}

func serveRelay(origin string) http.HandlerFunc {
	clients := make(chan struct{}, 8)
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == origin
	}}
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case clients <- struct{}{}:
			defer func() { <-clients }()
		default:
			http.Error(w, "Too many relay connections", http.StatusServiceUnavailable)
			return
		}
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer socket.Close()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		s := &session{ctx: ctx, socket: socket, streams: make(map[uint32]*stream)}
		s.run()
	}
}

func (s *session) send(kind byte, id uint32, payload []byte) bool {
	packet := make([]byte, 5+len(payload))
	packet[0] = kind
	binary.LittleEndian.PutUint32(packet[1:], id)
	copy(packet[5:], payload)
	s.writes.Lock()
	defer s.writes.Unlock()
	s.socket.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := s.socket.WriteMessage(websocket.BinaryMessage, packet); err != nil {
		s.socket.Close()
		return false
	}
	return true
}

func (s *session) run() {
	s.socket.SetReadLimit(maxPacket + 5)
	if !s.send(packetContinue, 0, binary.LittleEndian.AppendUint32(nil, window)) {
		return
	}
	for {
		kind, packet, err := s.socket.ReadMessage()
		if err != nil {
			return
		}
		if kind != websocket.BinaryMessage || len(packet) < 5 {
			return
		}
		id := binary.LittleEndian.Uint32(packet[1:])
		if id == 0 {
			return
		}
		switch packet[0] {
		case packetConnect:
			if !s.connect(id, packet[5:]) {
				return
			}
		case packetData, packetClose:
			s.mu.Lock()
			st := s.streams[id]
			if st != nil {
				if packet[0] == packetClose {
					delete(s.streams, id)
					st.cancel()
				} else {
					select {
					case st.input <- packet[5:]:
					default:
						delete(s.streams, id)
						st.cancel()
						s.send(packetClose, id, []byte{closeThrottled})
					}
				}
			}
			s.mu.Unlock()
		default:
			return
		}
	}
}

func (s *session) connect(id uint32, payload []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.streams[id] != nil {
		return false
	}
	if len(payload) < 4 || len(payload) > 256 || payload[0] != 1 || binary.LittleEndian.Uint16(payload[1:]) == 0 {
		return s.send(packetClose, id, []byte{closeInvalid})
	}
	if len(s.streams) >= maxStreams {
		return s.send(packetClose, id, []byte{closeThrottled})
	}
	ctx, cancel := context.WithCancel(s.ctx)
	st := &stream{ctx: ctx, cancel: cancel, input: make(chan []byte, window)}
	s.streams[id] = st
	go func() {
		defer cancel()
		reason := s.forward(id, st, string(payload[3:]), binary.LittleEndian.Uint16(payload[1:]))
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.streams[id] == st {
			delete(s.streams, id)
			s.send(packetClose, id, []byte{reason})
		}
	}()
	return true
}

func dialPublic(ctx context.Context, host string, port uint16) (net.Conn, byte) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	if err != nil {
		return nil, closeUnreachable
	}
	dialer := net.Dialer{}
	reason := byte(closeBlocked)
	for _, ip := range ips {
		ip = ip.Unmap()
		if !publicIPv4(ip) {
			continue
		}
		// Dial the checked IP so a second DNS lookup cannot change the destination.
		conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(int(port))))
		if err == nil {
			return conn, closeNormal
		}
		reason = closeUnreachable
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		reason = closeTimeout
	}
	return nil, reason
}

func (s *session) forward(id uint32, st *stream, host string, port uint16) byte {
	conn, reason := dialPublic(st.ctx, host, port)
	if conn == nil {
		return reason
	}
	defer conn.Close()
	stop := context.AfterFunc(st.ctx, func() { conn.Close() })
	defer stop()

	go func() {
		// Replenish one full window after writing the last packet in the batch.
		// The client has exhausted its credit by then.
		for written := 0; ; {
			select {
			case <-st.ctx.Done():
				return
			case data := <-st.input:
				conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if _, err := conn.Write(data); err != nil {
					conn.Close()
					return
				}
				written++
				if written == window {
					if !s.streamSend(id, st, packetContinue, binary.LittleEndian.AppendUint32(nil, window)) {
						return
					}
					written = 0
				}
			}
		}
	}()

	buf := make([]byte, 32<<10)
	for {
		n, err := conn.Read(buf)
		if n > 0 && !s.streamSend(id, st, packetData, buf[:n]) {
			return closeNetwork
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return closeNormal
			}
			return closeNetwork
		}
	}
}

func (s *session) streamSend(id uint32, st *stream, kind byte, payload []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id] == st && s.send(kind, id, payload)
}
