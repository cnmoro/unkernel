// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fetchDistro(name) for Node: a named distro image (distros.json) as a
// local file path that createKernel({ distro }) takes. In a source
// checkout it is the build's vendor/build/distro/<name>.erofs and nothing
// is downloaded; in an installed package it is downloaded once from the
// GitHub release of the package's version into a cache directory, checked
// against that release's distros.json (size and SHA-256), and reused from
// there while it still matches. Nothing here runs unless called: the SDK
// itself never goes to the network for a distro.
//
// The package root (for package.json's version and the checkout's
// vendor/build/distro) is passed in by the entry (node.ts, cli.ts), so that
// `new URL(..., import.meta.url)` stays in the entry module.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DistroIndex, DistroIndexEntry } from "../core/distro.ts";

/** The GitHub repository whose releases carry the distro images. */
export const RELEASE_REPO = "cnmoro/unkernel";

/** What fetchDistro() is doing, for a progress display. */
export interface FetchDistroProgress {
	/** "index": reading distros.json; "download": bytes arriving (loaded of total); "verify": checking a cached file; "done". */
	stage: "index" | "download" | "verify" | "done";
	name: string;
	/** The image's file name (once the index is read). */
	file?: string;
	/** Where it comes from (the release directory URL). */
	url?: string;
	/** Where it goes (the local file). */
	path?: string;
	loaded?: number;
	total?: number;
	/** "done": whether it came from the cache (true) or was downloaded now. */
	cached?: boolean;
}

export interface FetchDistroOptions {
	/**
	 * The release directory holding distros.json and the images, as a URL
	 * (ending in "/" or not). Default: $UNKERNEL_RELEASE_URL, else
	 * https://github.com/cnmoro/unkernel/releases/download/v<version>/ for
	 * the package's version.
	 */
	releaseUrl?: string;
	/**
	 * Where downloads are kept: a directory per release under it. Default:
	 * $UNKERNEL_CACHE_DIR, else $XDG_CACHE_HOME/unkernel, else
	 * ~/.cache/unkernel, else <os.tmpdir()>/unkernel-cache.
	 */
	cacheDir?: string;
	/**
	 * In a source checkout, use its build (vendor/build/distro/) and never
	 * download (default true). false: download even there.
	 */
	local?: boolean;
	onProgress?: (p: FetchDistroProgress) => void;
	signal?: AbortSignal;
}

/** fetchDistro() could not produce the image: `offline` when the network failed and nothing usable was cached. */
export class DistroFetchError extends Error {
	readonly offline: boolean;
	constructor(message: string, { offline = false, cause }: { offline?: boolean; cause?: unknown } = {}) {
		super(message, { cause });
		this.name = "DistroFetchError";
		this.offline = offline;
	}
}

/** Is `root` a source checkout (as opposed to an installed package)? */
export function isCheckout(root: string): boolean {
	return existsSync(path.join(root, "kernel/build.sh"));
}

/** The default cache directory (see FetchDistroOptions.cacheDir). */
export function defaultCacheDir(): string {
	if (process.env.UNKERNEL_CACHE_DIR) return path.resolve(process.env.UNKERNEL_CACHE_DIR);
	if (process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME)) return path.join(process.env.XDG_CACHE_HOME, "unkernel");
	let home = "";
	try { home = homedir(); } catch {}
	return home ? path.join(home, ".cache", "unkernel") : path.join(tmpdir(), "unkernel-cache");
}

/** The package's version (package.json next to the package root). */
function packageVersion(root: string): string {
	const v = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }).version;
	if (typeof v !== "string") throw new DistroFetchError(`no version in ${path.join(root, "package.json")}`);
	return v;
}

const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;

/** A cached file that matches the entry (size, then SHA-256). */
function verified(file: string, e: DistroIndexEntry): boolean {
	try {
		return statSync(file).size === e.size && sha256File(file) === e.sha256;
	} catch {
		return false;
	}
}

/** The index as it must look; throws on anything else. */
function checkIndex(j: unknown, where: string): DistroIndex {
	const ix = j as DistroIndex;
	const ok = ix && Array.isArray(ix.distros) && ix.distros.every((d) =>
		d && typeof d.name === "string" && /^[a-z0-9]+$/.test(d.name) && typeof d.file === "string" && /^[a-z0-9]+\.(erofs|ext4)$/.test(d.file) &&
		Number.isSafeInteger(d.size) && typeof d.sha256 === "string" && /^[0-9a-f]{64}$/.test(d.sha256));
	if (!ok) throw new DistroFetchError(`${where} is not a distros.json index`);
	return ix;
}

/**
 * The distro `name` as a local image file (see the top). `root` is the
 * package root (the directory with package.json).
 */
export async function fetchDistroFrom(root: string, name: string, opts: FetchDistroOptions = {}): Promise<string> {
	if (!/^[a-z0-9]+$/.test(name)) throw new DistroFetchError(`not a distro name: ${JSON.stringify(name)} (a name is [a-z0-9]+)`);
	const progress = opts.onProgress ?? (() => {});
	if ((opts.local ?? true) && isCheckout(root)) {
		const dir = path.join(root, "vendor/build/distro");
		const found = [`${name}.erofs`, `${name}.ext4`].map((f) => path.join(dir, f)).find((f) => existsSync(f));
		if (!found) throw new DistroFetchError(`no ${path.join(dir, `${name}.erofs`)} in this source checkout: build it with kernel/build.sh distro ${name}`);
		progress({ stage: "done", name, path: found, cached: true });
		return found;
	}
	const envUrl = process.env.UNKERNEL_RELEASE_URL;
	let base = opts.releaseUrl ?? envUrl, tag: string;
	if (base) {
		tag = `url-${createHash("sha256").update(base.replace(/\/*$/, "/")).digest("hex").slice(0, 12)}`;
	} else {
		tag = `v${packageVersion(root)}`;
		base = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/`;
	}
	base = base.replace(/\/*$/, "/");
	const dir = path.join(opts.cacheDir ? path.resolve(opts.cacheDir) : defaultCacheDir(), tag);
	const offlineHelp = `unkernel downloads distro images on first use from ${base} and keeps them in ${dir}; ` +
		"connect to the network and try again, or use an image file you have";

	// The index: from the release, else the copy kept from an earlier download.
	progress({ stage: "index", name, url: base });
	const indexFile = path.join(dir, "distros.json");
	let index: DistroIndex;
	try {
		const r = await fetch(new URL("distros.json", base), { signal: opts.signal });
		if (!r.ok) throw new DistroFetchError(`GET ${new URL("distros.json", base)}: ${r.status} ${r.statusText}`.trim());
		const text = await r.text();
		index = checkIndex(JSON.parse(text), `${new URL("distros.json", base)}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${indexFile}.tmp`, text);
		renameSync(`${indexFile}.tmp`, indexFile);
	} catch (e) {
		if (opts.signal?.aborted) throw e;
		if (!existsSync(indexFile)) {
			const http = e instanceof DistroFetchError;
			throw new DistroFetchError(http ? `${(e as Error).message}: no distro images for this release at ${base}`
				: `cannot read ${new URL("distros.json", base)}: ${(e as Error).message}; ${offlineHelp}`, { offline: !http, cause: e });
		}
		index = checkIndex(JSON.parse(readFileSync(indexFile, "utf8")), indexFile);
	}
	const entry = index.distros.find((d) => d.name === name);
	if (!entry) throw new DistroFetchError(`no distro "${name}" in ${new URL("distros.json", base)} (it has: ${index.distros.map((d) => d.name).join(", ") || "none"})`);
	const file = path.join(dir, entry.file), url = new URL(entry.file, base).href;

	if (existsSync(file)) {
		progress({ stage: "verify", name, file: entry.file, url, path: file });
		if (verified(file, entry)) {
			progress({ stage: "done", name, file: entry.file, url, path: file, cached: true });
			return file;
		}
		rmSync(file, { force: true });
	}

	// Download into a part file, hashing on the way, then check and rename.
	mkdirSync(dir, { recursive: true });
	const part = `${file}.part-${process.pid}`;
	try {
		let r: Response;
		try {
			r = await fetch(url, { signal: opts.signal });
		} catch (e) {
			if (opts.signal?.aborted) throw e;
			throw new DistroFetchError(`cannot download ${url}: ${(e as Error).message}; ${offlineHelp}`, { offline: true, cause: e });
		}
		if (!r.ok || !r.body) throw new DistroFetchError(`GET ${url}: ${r.status} ${r.statusText}`.trim());
		const hash = createHash("sha256"), out = createWriteStream(part);
		let loaded = 0;
		progress({ stage: "download", name, file: entry.file, url, path: file, loaded, total: entry.size });
		try {
			for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
				hash.update(chunk);
				loaded += chunk.length;
				if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
				progress({ stage: "download", name, file: entry.file, url, path: file, loaded, total: entry.size });
			}
		} catch (e) {
			if (opts.signal?.aborted) throw e;
			throw new DistroFetchError(`download of ${url} broke off after ${mib(loaded)}: ${(e as Error).message}; ${offlineHelp}`, { offline: true, cause: e });
		} finally {
			await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
		}
		const sum = hash.digest("hex");
		if (loaded !== entry.size || sum !== entry.sha256)
			throw new DistroFetchError(`${url}: got ${loaded} bytes with SHA-256 ${sum}, distros.json says ${entry.size} bytes, ${entry.sha256}`);
		renameSync(part, file);
	} finally {
		rmSync(part, { force: true });
	}
	progress({ stage: "done", name, file: entry.file, url, path: file, cached: false });
	return file;
}

/** fetchDistroFrom() for the package at the `root` URL (an entry's `new URL("..", import.meta.url)`). */
export function distroFetcher(root: URL): (name: string, opts?: FetchDistroOptions) => Promise<string> {
	const dir = fileURLToPath(root);
	return (name, opts) => fetchDistroFrom(dir, name, opts);
}
