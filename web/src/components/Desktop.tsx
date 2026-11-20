// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { useEffect, useRef, useState } from "react";
import { KW } from "../kw.ts";
import type { GuestSocket } from "../sdk.ts";

/** noVNC consumes a WebSocket-shaped transport; here the bytes stay on vsock. */
function desktopChannel(socket: GuestSocket) {
	const reader = socket.readable.getReader();
	const writer = socket.writable.getWriter();
	let closed = false;
	const channel = {
		binaryType: "arraybuffer",
		protocol: "",
		readyState: "open",
		onopen: () => {},
		onclose: (_e: CloseEvent) => {},
		onerror: (_e: Event) => {},
		onmessage: (_e: MessageEvent<ArrayBuffer>) => {},
		send(bytes: Uint8Array) {
			if (!closed) void writer.write(bytes.slice()).catch(() => finish(false));
		},
		close() { finish(true); },
	};
	function finish(clean: boolean) {
		if (closed) return;
		closed = true;
		channel.readyState = "closed";
		void socket.close().catch(() => {});
		queueMicrotask(() => channel.onclose(new CloseEvent("close", { wasClean: clean })));
	}
	async function read() {
		try {
			while (!closed) {
				const { value, done } = await reader.read();
				if (done) break;
				channel.onmessage(new MessageEvent("message", { data: value.slice().buffer }));
			}
			finish(true);
		} catch {
			finish(false);
		} finally {
			reader.releaseLock();
			writer.releaseLock();
		}
	}
	return { channel, read };
}

export function Desktop({ onClose }: { onClose: () => void }) {
	const screen = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState("Starting Xfce…");
	useEffect(() => {
		const abort = new AbortController();
		let close: (() => void) | undefined;
		async function start() {
			try {
				const vm = await KW.ready!();
				const { default: RFB } = await import("@novnc/novnc");
				if (abort.signal.aborted) return;
				const result = await vm.exec("systemctl", ["start", "kw-desktop.service"], { user: "root", timeout: 20000 });
				if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "The desktop service failed");
				let socket: GuestSocket | undefined;
				for (let attempt = 0; attempt < 40 && !abort.signal.aborted; attempt++) {
					try {
						socket = await vm.connect(5901, { timeout: 2000, signal: abort.signal });
						break;
					} catch (e) {
						if (attempt === 39) throw e;
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
				if (!socket || abort.signal.aborted) { await socket?.close(); return; }
				const { channel, read } = desktopChannel(socket);
				close = () => channel.close();
				const rfb = new RFB(screen.current!, channel);
				close = () => { rfb.disconnect(); channel.close(); };
				rfb.scaleViewport = true;
				rfb.resizeSession = true;
				rfb.addEventListener("connect", () => setStatus(""));
				rfb.addEventListener("disconnect", () => {
					if (!abort.signal.aborted) setStatus("Desktop disconnected. Close this view to try again.");
				});
				void read();
			} catch (e) {
				close?.();
				if (!abort.signal.aborted) setStatus((e as Error).message);
			}
		}
		void start();
		return () => { abort.abort(); close?.(); };
	}, []);

	return (
		<section aria-label="Debian desktop" className="absolute inset-0 z-2 flex flex-col bg-bg">
			<div className="flex items-center justify-between border-b border-line px-3 py-1">
				<span className="text-sm text-muted">Xfce desktop</span>
				<button type="button" className="btn btn-sm" onClick={onClose}>Back to terminal</button>
			</div>
			<div className="relative min-h-0 flex-1">
				<div id="desktop-screen" ref={screen} className="absolute inset-0" />
				{status && <div role="status" className="absolute inset-0 grid place-items-center p-5 text-sm text-muted">{status}</div>}
			</div>
		</section>
	);
}
