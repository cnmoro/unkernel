// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// window.KW: state shared by the inline bootstrap (index.html), the shell
// (ui.ts, main.ts) and the boot module (boot.ts), and the hooks the browser
// tests (web/test/*.mjs) read: KW.config, KW.ui.state()/stageState(),
// KW.errors, KW.screenText(), KW.memActualMiB, KW.term, KW.vm (the SDK's KernelInstance, or with
// ?worker=1 a WorkerKernel, which has no low-level kernel; KW.vm.stats(), KW.vm.evdev,
// KW.vm.frame() in both),
// KW.jitStats() (kwemu's JIT counters), the data disk (KW.dataDisk, KW.sync(),
// KW.exportData(), KW.importData(), KW.resetData()), KW.suspend() (session.ts), the terminal windows (KW.windows:
// list(), open(), select(), close(), text(), send(); windows.ts), the guest preview (KW.preview: open(), close(), url();
// preview.ts); KW.kernel and globalThis.kernel (the
// low-level Kernel, with sendInput(); not in worker mode) and globalThis.term (the wterm WTerm).
import type { Config } from "./config.ts";
import type { CowDisk, JitStats, KernelHandle } from "./sdk.ts";
import type { Ui } from "./ui.ts";

export interface KWError {
	t: number;
	kind: string;
	message: string;
	detail: string;
	fatal: boolean;
	hint?: string;
	title?: string;
}

export interface TermApi {
	focus(): void;
	paste(text: string): void;
	send(data: string | Uint8Array): void;
	setFontSize(px: number): void;
	appCursor(): boolean;
	notice(msg: string): void;
}

/** A terminal window as KW.windows.list() gives it. */
export interface WindowInfo {
	/** 0: the console (hvc0); 1 to 9: a terminal session over vsock. */
	n: number;
	name: string;
	/** Window 0 is always "open". */
	state: "opening" | "open" | "ended";
	current: boolean;
	/** The shell's pid and pty number in the guest, once open (not for window 0). */
	pid?: number;
	pts?: number;
	/** Why it ended, or what it waits for. */
	note?: string;
}

/** The terminal windows (windows.ts), for the shortcuts, the status line and the browser tests. */
export interface WindowsApi {
	list(): WindowInfo[];
	/**
	 * Open a window (the lowest free number) and switch to it unless
	 * select is false; name labels it in the status line (default "sh"),
	 * and file and args run in place of the login shell. Resolves once its shell runs; rejects with why it
	 * could not (the window then stays, showing that, until closed).
	 */
	open(opts?: { select?: boolean; name?: string; file?: string; args?: string[] }): Promise<WindowInfo>;
	/** Show window n and give it the keyboard focus (false: there is no such window). */
	select(n: number): boolean;
	/** Close window n (1 to 9): its shell is hung up. Resolves once it is gone. */
	close(n: number): Promise<void>;
	/** Window n's history and screen as text, a line per row. */
	text(n: number): string;
	/** Type into window n (as its terminal does: no Ctrl-key latching). */
	send(n: number, data: string | Uint8Array): void;
}

export interface KWGlobal {
	t0: number;
	errors: KWError[];
	ui: Ui | null;
	started: boolean;
	early(e: KWError): void;
	report(kind: string, message: string, detail?: string, fatal?: boolean): KWError;
	config: Config;
	term?: TermApi;
	screenText?: () => string;
	memActualMiB?: number;
	jitStats?: () => JitStats;
	/** The data disk, once attached (null: none). */
	dataFolder?: FileSystemDirectoryHandle;
	folderSize?: number;
	startDesktop?: boolean;
	poweroff?: () => Promise<void>;
	compactData?: () => Promise<void>;
	dataDisk?: CowDisk | null;
	/** Ask the guest to sync its file systems to the persistent disks; true once confirmed. */
	sync?: (opts?: { timeout?: number }) => Promise<boolean>;
	/** Run by Reboot before the page reloads (a sync, at most 3 s). */
	beforeReboot?: () => Promise<unknown>;
	exportData?: () => Promise<{ name: string; blocks: number; bytes: number }>;
	importData?: (file: Blob | Uint8Array) => Promise<{ size: number; blocks: number }>;
	resetData?: () => Promise<void>;
	/** Save the running machine in this browser and stop it (session.ts); the next load offers to resume it. */
	suspend?: () => Promise<{ bytes: number; ms: number }>;
	/** The running showcase (showcase.ts): skip the current step, pause and resume between steps. */
	showcase?: { skip(): void; pause(): void; resume(): void };
	/** The kernel once user space runs (rejects if it never does), once the boot module runs. */
	ready?: () => Promise<KernelHandle>;
	vm?: KernelHandle;
	/** The terminal windows, once the boot module runs. */
	windows?: WindowsApi;
	/** The guest preview panel (preview.ts): open(port) (false: not a port), close(), and the /vm/ URL of a guest port. */
	preview?: { open(port?: number | string): boolean; close(): void; url(port: number, path?: string): string };
	[key: string]: unknown;
}

declare global {
	interface Window {
		KW: KWGlobal;
	}
}

export const KW: KWGlobal = window.KW;
