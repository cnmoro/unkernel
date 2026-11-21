// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The distro image (createKernel({ distro })): a read-only file system
// labelled kwroot (erofs or ext4) that the base initramfs of a distroless
// kernel bundle (unkernel.wasm) mounts as the lower layer of the root
// overlay. The host attaches it as the first disk (/dev/wda), before the
// `disks` option's, and never writes it.
//
// DistroDisk wraps any BlockDevice (a read-only FileDisk on Node, a
// BaseDisk over an HttpBase read lazily with Range requests, or the
// caller's own), refuses writes, and gives it a content identity for
// machine snapshots: the file system type, size, superblock UUID and label,
// and a hash of the first 64 KiB (superblock and the metadata after it),
// read once at open. The underlying disk's stamp (a file's size and mtime,
// an HTTP image's URL, size and ETag) is checked too, so a snapshot is
// refused on restore with another image, or the same file rebuilt.
//
// The distro header: guest/lib/image.sh writes one into the first 1024
// bytes of an erofs image, which erofs (and ext4) leave unused (the
// superblock is at 1024, and its checksum starts there), so the image
// tells how to fetch it with no manifest. 128 or 136 bytes, little-endian:
//    0  "KWDISTRO"     magic
//    8  u32 1          version (another one: no header)
//   12  u32 128|136    header length (at least 128; readers skip what they
//                      do not know)
//   16  u64 size       the image's size (served at another size: no header)
//   24  u64 prefetch   bytes from the start that a boot reads: the image
//                      size means "fetch it whole", 0 "no hint"
//   32  char[32]       the distro's name (/usr/lib/kw-distro), NUL-padded
//   64  char[64]       the image id (/usr/lib/kw-image), NUL-padded
//  128  u64 background (length 136) the end of the warm set: what the first
//                      commands after the boot read, [prefetch, background),
//                      worth fetching once the boot is done; not past
//                      prefetch: none
// The image id is a hash of the tree (guest/tools/mktree.py), so writing
// the header does not change it. HttpBase (an image over HTTP) honours
// `prefetch` and `background` (HttpBaseOptions); a file ignores them. An image
// without a header is read lazily, as before. The header is part of the
// first 64 KiB, so it is part of the identity.

import { F_RO, readDistroHeader, type BlockDevice, type DiskSnapshotState, type HttpBaseStats, type MaybePromise } from "./block.ts";
import { DEVICE_SPEC_VERSION, isDiskSpec, type DeviceContext, type DeviceRegistry, type DiskSpec } from "./devices.ts";
import { BootError } from "./load.ts";

/**
 * distros.json: the index of the distro images that go with a base bundle
 * (unkernel.wasm), next to them in a release and in a build's
 * vendor/build/distro/ (guest/tools/distros-json.mjs writes it).
 */
export interface DistroIndex {
	/** KW_ABI_VERSION of the bundle's kwemu (null if unknown). */
	abi: number | null;
	/** The base id of the bundle's initramfs (`base-<hash>`, /kw/layer/usr/lib/kw-base; null if unknown). */
	base: string | null;
	/** Alpine first, then by name. */
	distros: DistroIndexEntry[];
}

/** One image in distros.json. */
export interface DistroIndexEntry {
	/** The distro's name (`[a-z0-9]+`), what /usr/lib/kw-distro says. */
	name: string;
	/** The image's file name, next to distros.json (`<name>.erofs`). */
	file: string;
	/** Its size in bytes. */
	size: number;
	/** Its SHA-256, hex. */
	sha256: string;
	/** The image id, /usr/lib/kw-image (`<name>-<version>-<hash>`). */
	image: string;
}

/** A distro image: a path or URL (Node: a file path, a file: URL or an http(s) URL; browsers: a URL, relative to the page), a disk spec, or a BlockDevice. */
export type DistroSource = string | URL | DiskSpec | BlockDevice;

/** What the host read off the distro image (structured-cloneable). */
export interface DistroInfo {
	/** Its path or URL (for messages). */
	name: string;
	/** The file system, from its superblock. */
	fs: "erofs" | "ext4";
	/** The volume label (the base looks for "kwroot"). */
	label: string;
	/** The file system UUID, hex. */
	uuid: string;
	/** Size in bytes. */
	size: number;
	/** The content identity a snapshot records (see DistroDisk). */
	identity: string;
	/** From its distro header (see the file comment), if it has one: the distro's name, the image id and the prefetch size. */
	distro?: string;
	image?: string;
	prefetch?: number;
}

const SB = 1024, HEAD = 65536;
const EROFS_MAGIC = 0xe0f5e1e2, EXT4_MAGIC = 0xef53;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const label = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));

/** cyrb53 (a 53-bit non-cryptographic hash; crypto.subtle needs a secure context, which a page on plain http is not), hex. */
function hash53(b: Uint8Array): string {
	let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
	for (let i = 0; i < b.length; i++) {
		const c = b[i]!;
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The file system in the first bytes of an image, or null. */
export function probeDistro(head: Uint8Array): { fs: DistroInfo["fs"]; label: string; uuid: string } | null {
	if (head.length < SB + 136) return null;
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	// struct erofs_super_block: magic @0, uuid[16] @48, volume_name[16] @64.
	if (dv.getUint32(SB, true) === EROFS_MAGIC)
		return { fs: "erofs", uuid: hex(head.subarray(SB + 48, SB + 64)), label: label(head.subarray(SB + 64, SB + 80)) };
	// struct ext4_super_block: s_magic @0x38, s_uuid[16] @0x68, s_volume_name[16] @0x78.
	if (dv.getUint16(SB + 0x38, true) === EXT4_MAGIC)
		return { fs: "ext4", uuid: hex(head.subarray(SB + 0x68, SB + 0x78)), label: label(head.subarray(SB + 0x78, SB + 0x88)) };
	return null;
}

/**
 * The distro image as a disk: read-only whatever the underlying disk
 * allows, with a content identity for snapshots (see the file comment).
 * open() reads its first 64 KiB and rejects an image that is neither erofs
 * nor ext4.
 */
export class DistroDisk implements BlockDevice {
	readonly inner: BlockDevice;
	readonly info: DistroInfo;
	readonly size: number;
	readonly readOnly = true;
	readonly flags = F_RO;
	readonly blockSize?: number;

	/** @internal Use DistroDisk.open(). */
	constructor(inner: BlockDevice, info: DistroInfo) {
		this.inner = inner;
		this.info = info;
		this.size = inner.size;
		if (inner.blockSize) this.blockSize = inner.blockSize;
	}

	/** Wrap `inner` (a DistroDisk is returned as it is). `name` is for messages (default: what its snapshot state says). */
	static async open(inner: BlockDevice, { name, log }: { name?: string; log?: (msg: string) => void } = {}): Promise<DistroDisk> {
		if (inner instanceof DistroDisk) return inner;
		name ??= stampOf(inner)?.name ?? "the distro image";
		const head = new Uint8Array(Math.min(HEAD, inner.size));
		const r = inner.read(0, [head]);
		if (r instanceof Promise) await r;
		const fs = probeDistro(head);
		if (!fs) throw new Error(`${name} is neither an erofs nor an ext4 image`);
		if (fs.label !== "kwroot")
			(log ?? ((m: string) => console.warn(m)))(`[host] distro: ${name} is labelled "${fs.label}", not "kwroot": the base initramfs will not find it`);
		const identity = `distro ${fs.fs} size=${inner.size} uuid=${fs.uuid} label=${fs.label} head=${hash53(head)}`;
		const h = readDistroHeader(head, inner.size);
		const hint = h ? { distro: h.distro, image: h.image, prefetch: h.prefetch } : {};
		return new DistroDisk(inner, { name, ...fs, size: inner.size, identity, ...hint });
	}

	/** What an image over HTTP fetched (requests, bytes, the prefetch: HttpBaseStats); undefined for a file. */
	get stats(): HttpBaseStats | undefined {
		return (this.inner as { stats?: HttpBaseStats }).stats;
	}

	read(off: number, views: Uint8Array[]): MaybePromise<void> {
		return this.inner.read(off, views);
	}

	write(): never {
		throw new Error("the distro image is read-only");
	}

	snapshotState(): DiskSnapshotState {
		return { name: this.info.name, identity: this.info.identity, gen: 0, stamp: stampOf(this.inner)?.stamp };
	}

	snapshotSeal(): { state: DiskSnapshotState; done: Promise<void> } {
		return { state: this.snapshotState(), done: Promise.resolve() };
	}

	/** Close the underlying disk (a FileDisk's descriptor), if it can be. */
	close(): void {
		(this.inner as { close?: () => void }).close?.();
	}
}

/** The underlying disk's name and stamp: a file's size and mtime, or a base's identity (an HTTP image's URL, size and ETag). */
function stampOf(d: BlockDevice): { name: string; stamp?: string } | undefined {
	try {
		const s = d.snapshotState?.();
		return s && { name: s.name, stamp: s.stamp ?? s.identity };
	} catch {
		return undefined;
	}
}

/** A path or URL as a read-only disk spec: the platform's way (Platform.distroSpec), else an http(s) URL. */
export function distroSpecOf(src: string | URL, toSpec?: (src: string | URL) => DiskSpec): DiskSpec {
	if (toSpec) return toSpec(src);
	const url = String(src);
	if (!/^https?:/i.test(url)) throw new BootError("boot", `distro: ${url}: this platform opens only http(s) URLs`);
	return { kind: "http", url, readOnly: true };
}

/** A distro spec forced read-only (no overlay, nothing written). */
export function readOnlySpec(spec: DiskSpec): DiskSpec {
	if (spec.kind === "data") throw new BootError("boot", 'distro: a "data" disk spec cannot be a distro image (use a "file" or "http" spec)');
	const out = { ...spec, readOnly: true } as DiskSpec & { snapshot?: boolean };
	delete out.snapshot;
	return out;
}

/**
 * Open the distro option as a DistroDisk. `owned`: built here (from a
 * path, URL or spec), so the instance closes it at exit.
 */
export async function openDistro(src: DistroSource, registry: DeviceRegistry | undefined, ctx: Omit<DeviceContext, "index">,
	toSpec?: (src: string | URL) => DiskSpec): Promise<{ disk: DistroDisk; owned: boolean }> {
	const item = typeof src === "string" || src instanceof URL ? distroSpecOf(src, toSpec) : isDiskSpec(src) ? readOnlySpec(src) : src;
	const owned = isDiskSpec(item);
	const name = owned ? ((item as { path?: string; url?: string }).path ?? (item as { url?: string }).url) : undefined;
	let dev: BlockDevice;
	try {
		if (owned) {
			const spec = item as DiskSpec;
			if (spec.v !== undefined && spec.v !== DEVICE_SPEC_VERSION)
				throw new BootError("support", `disk kind "${spec.kind}": spec version ${spec.v}, this SDK reads ${DEVICE_SPEC_VERSION}`);
			const make = registry?.disks[spec.kind] as ((s: DiskSpec, c: DeviceContext) => Promise<BlockDevice> | BlockDevice) | undefined;
			if (!make) throw new BootError("support", `disk kind "${spec.kind}" is not available on this platform`);
			dev = await make(spec, { ...ctx, index: -1 });
		} else dev = item as BlockDevice;
	} catch (e) {
		throw e instanceof BootError ? new BootError(e.stage, `distro: ${e.message}`, { cause: e }) : new BootError("boot", `distro: ${(e as Error)?.message ?? e}`, { cause: e });
	}
	try {
		return { disk: await DistroDisk.open(dev, { name, log: ctx.log }), owned };
	} catch (e) {
		if (owned) try { (dev as { close?: () => void }).close?.(); } catch {}
		throw new BootError("boot", `distro: ${(e as Error)?.message ?? e}`, { cause: e });
	}
}
