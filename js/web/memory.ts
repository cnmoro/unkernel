// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// How much memory to give the kernel in a browser.

/** The wasm32 kernel used by the browser can address 4 GiB. */
export const MAX_BROWSER_MEMORY_MIB = 4096;

/**
 * Sizes createKernel() tries, in order, when the requested memory cannot be
 * allocated (phones often lack the address space for 512 MiB).
 */
export const DEFAULT_MEMORY_FALLBACK_MIB: readonly number[] = Object.freeze([
	3584, 3072, 2560, 2048, 1536, 1024, 768, 512, 384, 256, 192, 128, 96, 64,
]);

/** A phone or tablet: a coarse pointer (touch) or a mobile user agent (the old page's rule). */
export function isMobile(): boolean {
	const nav = globalThis.navigator as Navigator | undefined;
	if (!nav) return false;
	const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	return coarse || /Android|iPhone|iPad|Mobi/i.test(nav.userAgent ?? "");
}

/**
 * A memory size for this device: from navigator.deviceMemory (secure
 * contexts only) when known, else 256 MiB on phones and 512 MiB otherwise.
 */
export function autoMemoryMiB(opts: { mobile?: boolean } = {}): { mib: number; why: string } {
	const devMem = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;
	if (devMem) return { mib: devMem <= 1 ? 96 : devMem <= 2 ? 128 : devMem <= 4 ? 256 : 512, why: `auto: device reports ${devMem} GB` };
	if (opts.mobile ?? isMobile()) return { mib: 256, why: "auto: mobile device" };
	return { mib: 512, why: "auto" };
}
