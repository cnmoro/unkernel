// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// /distros/<file>: how a distro image is answered, shared by the dev
// server's middleware (vite.config.ts serveDistros()) and the built Node
// server's handler (server/distros.ts). The SDK (js/core/block.ts HttpBase,
// strict) opens an image with one revalidating Range request for its first
// 256 KiB (`cache: "no-cache"`), then reads the prefetch its distro header
// asks for (a whole small image: one plain GET; else one Range request), its
// background tier once the boot is quiet (4 MiB Range requests, one at a
// time), read-ahead and lazy 256 KiB-aligned ranges, all with `cache: "force-cache"`: from the
// browser's HTTP cache without asking again, each response's ETag compared
// with the opening one's (a mismatch is fetched again with `cache:
// "reload"`). So: the file as it is (erofs compresses inside; never
// content-encoded, so a 200's Content-Length is the image's size), one range
// per request (206 with Content-Range; a malformed or multi-range header
// gets the whole file, which the RFC allows), 416 for a range past the end,
// the same strong ETag on every response for an image, 200 and 206 alike
// (the SDK refuses a response whose ETag or total size differs from the
// opening one's, instead of mixing two images), caching allowed (never
// no-store), If-None-Match before Range (RFC 9110 13.2.2: a cached range
// revalidates with a 304), If-Range, the isolation headers the
// cross-origin-isolated page needs, and 404 for anything that is not an
// image there.
//
// Two kinds of names (scripts/kernel.ts):
//   - <name>-<16 hex digits of its sha256>.erofs, a build's: the name says
//     the content, so it is immutable (cached for a year, never
//     revalidated), and the ETag is that hash with the size, the same on
//     every server and deploy.
//   - <name>.erofs, the dev server's: a local image is rebuilt in place, so
//     `no-cache` and an ETag from size and mtime, which a rebuild changes:
//     the SDK's opening request revalidates (a 304 while the image is
//     unchanged), and its cached ranges of an older build fail the ETag
//     check and are fetched again.
import { statSync } from "node:fs";
import path from "node:path";

/** The file names served: what scripts/kernel.ts names the images. */
export const DISTRO_FILE_RE = /^[a-z0-9]+(?:-([0-9a-f]{16}))?\.(?:erofs|ext4)$/;

/** Cache-Control for an image whose name holds its hash. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

export interface DistroReply {
	status: number;
	headers: Record<string, string>;
	/** The bytes to send: `start`..`end` (inclusive) of `file`, or a short text; none for HEAD and 304. */
	body?: { file: string; start: number; end: number } | string;
}

/** The file for `name` in `dir`, or null when `name` is not an image's name. */
export function imageFile(dir: string, name: string): string | null {
	return dir && DISTRO_FILE_RE.test(name) ? path.join(dir, name) : null;
}

/** Whether an If-None-Match value names `etag` (or is `*`). */
const matches = (v: string, etag: string) => v.trim() === "*" || v.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);

/**
 * The answer to a `method` request for the image `name` (the path after
 * /distros/), stored in `file` (null: none), with request headers from
 * `header` (lower-case names). `missing` is the 404's text.
 */
export function distroReply(file: string | null, name: string, method: string, header: (name: string) => string | null | undefined, missing = `no distro image ${name}`): DistroReply {
	const headers: Record<string, string> = {
		"cross-origin-opener-policy": "same-origin",
		"cross-origin-embedder-policy": "require-corp",
		"cross-origin-resource-policy": "same-origin",
	};
	const fail = (status: number, text: string, extra: Record<string, string> = {}): DistroReply => ({
		status,
		headers: { ...headers, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...extra },
		body: method === "HEAD" ? undefined : `${text}\n`,
	});
	const hash = DISTRO_FILE_RE.exec(name)?.[1];
	let size = -1, mtime = new Date(0);
	if (file && DISTRO_FILE_RE.test(name)) {
		try {
			const st = statSync(file);
			if (st.isFile()) ({ size, mtime } = st);
		} catch {}
	}
	if (size < 0) return fail(404, missing);
	if (method !== "GET" && method !== "HEAD") return fail(405, "GET or HEAD only", { allow: "GET, HEAD" });
	const etag = hash ? `"${hash}-${size.toString(16)}"` : `"${size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}"`;
	Object.assign(headers, {
		"accept-ranges": "bytes",
		etag,
		"last-modified": mtime.toUTCString(),
		"content-type": "application/octet-stream",
		"cache-control": hash ? IMMUTABLE : "no-cache",
	});
	const inm = header("if-none-match");
	if (inm && matches(inm, etag)) return { status: 304, headers };
	let status = 200, start = 0, end = size - 1;
	const range = header("range"), ifRange = header("if-range");
	if (range && (!ifRange || ifRange.trim() === etag)) {
		const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		if (m && (m[1] || m[2])) {
			if (m[1]) {
				start = Number(m[1]);
				end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
			} else {
				start = Math.max(0, size - Number(m[2]));
				if (Number(m[2]) === 0) start = size; // bytes=-0: nothing
			}
			if (start > end || start >= size) return fail(416, "range not satisfiable", { "content-range": `bytes */${size}` });
			status = 206;
			headers["content-range"] = `bytes ${start}-${end}/${size}`;
		}
	}
	headers["content-length"] = String(end - start + 1);
	return { status, headers, body: method === "HEAD" || size === 0 ? undefined : { file, start, end } as { file: string; start: number; end: number } };
}
