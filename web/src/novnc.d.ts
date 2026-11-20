// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
declare module "@novnc/novnc" {
	interface RfbChannel {
		binaryType: string;
		protocol: string;
		readyState: string;
		onopen: () => void;
		onclose: (event: CloseEvent) => void;
		onerror: (event: Event) => void;
		onmessage: (event: MessageEvent<ArrayBuffer>) => void;
		send(bytes: Uint8Array): void;
		close(): void;
	}
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, channel: RfbChannel);
		scaleViewport: boolean;
		disconnect(): void;
	}
}
