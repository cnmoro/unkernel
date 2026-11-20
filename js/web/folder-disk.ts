// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { CowDisk, ZeroBase, type OverlayStore, type StoreIndex } from "../core/block.ts";
import { readKwsparse } from "../core/kwsparse.ts";

const BLOCK = 4096;
const MAGIC = 0x3144574b; // KWD1
const HEADER = 16;
const GIB = 1024 ** 3;
const TX = /^([0-9]{10})\.kwd$/;
const PART = /^checkpoint-[0-9a-f-]{36}-[0-9]+\.kwc$/;
const EXCLUSIVE = { mode: "exclusive", keepExistingData: false } as const;
const SHARD_BLOCKS = 8192; // 32 MiB of data per checkpoint file
const COMPACT_TRANSACTIONS = 256;
const COMPACT_RECLAIM = 64 * 1024 ** 2;

export const DEFAULT_FOLDER_DISK_GIB = 4;
export const MAX_FOLDER_DISK_GIB = 1024;

interface Checkpoint {
	id: string;
	next: number;
	parts: number;
	gen: number;
}

interface Manifest {
	version: 1 | 2;
	size: number;
	uid: string;
	checkpoint?: Checkpoint;
}

interface BlockLocation {
	file: File;
	offset: number;
}

function validSize(size: number): boolean {
	return Number.isSafeInteger(size) && size >= BLOCK && size <= MAX_FOLDER_DISK_GIB * GIB && size % BLOCK === 0;
}

function identity(version: 1 | 2, size: number): string {
	return `unkernel-folder-v${version} size=${size} bs=${BLOCK}`;
}

function parseManifest(text: string): Manifest {
	const raw = JSON.parse(text) as {
		identity?: string; uid?: string; version?: number; size?: number; checkpoint?: Checkpoint;
	} | null;
	const legacy = /^unkernel-folder-v1 size=(\d+) bs=4096$/.exec(raw?.identity ?? "");
	if (legacy && raw && raw.version === undefined && typeof raw.uid === "string" && raw.uid && validSize(Number(legacy[1]))) {
		return { version: 1, size: Number(legacy[1]), uid: raw.uid };
	}
	if (raw?.version !== 2 || typeof raw.uid !== "string" || !raw.uid || typeof raw.size !== "number" ||
		!validSize(raw.size) || raw.identity !== identity(2, raw.size)) {
		throw new Error("This folder contains a data disk with an unsupported format or size");
	}
	const checkpoint = raw.checkpoint;
	if (checkpoint !== undefined && (!checkpoint || !/^[0-9a-f-]{36}$/.test(checkpoint.id) ||
		!Number.isSafeInteger(checkpoint.next) || checkpoint.next < 1 || checkpoint.next > 9_999_999_999 ||
		!Number.isSafeInteger(checkpoint.parts) || checkpoint.parts < 0 ||
		checkpoint.parts > Math.ceil(raw.size / BLOCK / SHARD_BLOCKS) ||
		!Number.isSafeInteger(checkpoint.gen) || checkpoint.gen < 0 || checkpoint.gen > 0xffffffff)) {
		throw new Error("Invalid folder disk checkpoint");
	}
	return { version: 2, size: raw.size, uid: raw.uid, checkpoint };
}

async function writeFile(file: FileSystemFileHandle, content: string | Blob): Promise<void> {
	const writer = await file.createWritable(EXCLUSIVE);
	try {
		await writer.write(content);
		await writer.close();
	} catch (e) {
		await writer.abort().catch(() => {});
		throw e;
	}
}

function batchHeader(puts: number[], dels: number[], gen: number): ArrayBuffer {
	const header = new ArrayBuffer(HEADER + 4 * (puts.length + dels.length));
	const view = new DataView(header);
	view.setUint32(0, MAGIC, true);
	view.setUint32(4, puts.length, true);
	view.setUint32(8, dels.length, true);
	view.setUint32(12, gen, true);
	for (const [i, block] of puts.entries()) view.setUint32(HEADER + 4 * i, block, true);
	for (const [i, block] of dels.entries()) view.setUint32(HEADER + 4 * (puts.length + i), block, true);
	return header;
}

const partName = (id: string, i: number) => `checkpoint-${id}-${i}.kwc`;

export interface FolderCompaction {
	reclaimedBytes: number;
	transactions: number;
	checkpointFiles: number;
	elapsedMs: number;
}

class FolderStore implements OverlayStore {
	readonly name: string;
	readonly dir: FileSystemDirectoryHandle;
	readonly blocks = new Map<number, BlockLocation>();
	#lock?: FileSystemWritableFileStream;
	#file?: FileSystemFileHandle;
	#manifest?: Manifest;
	#seq = 0;
	#gen = 0;
	#bytes = 0;
	#transactionCount = 0;

	constructor(dir: FileSystemDirectoryHandle) {
		this.dir = dir;
		this.name = dir.name;
	}

	get size(): number {
		return this.#manifest!.size;
	}

	get diskIdentity(): string {
		return identity(this.#manifest!.version, this.size);
	}

	open(): Promise<StoreIndex> { return this.attach(); }

	async attach(initialSize?: number): Promise<StoreIndex> {
		// Keep the writable open for the lifetime of this writer.
		const lock = await this.dir.getFileHandle("writer.lock", { create: true });
		this.#lock = await lock.createWritable(EXCLUSIVE);
		this.#file = await this.dir.getFileHandle("disk.json", { create: initialSize !== undefined });
		const previous = await this.#file.getFile();
		const entries: [string, FileSystemFileHandle][] = [];
		for await (const [name, handle] of this.dir.entries()) {
			if (handle.kind === "file" && (TX.test(name) || PART.test(name))) entries.push([name, handle]);
		}
		if (previous.size) this.#manifest = parseManifest(await previous.text());
		else {
			if (entries.length || initialSize === undefined) throw new Error("The saved disk manifest is missing");
			await this.#publish({ version: 2, size: initialSize, uid: crypto.randomUUID() });
		}

		const checkpoint = this.#manifest!.checkpoint;
		const active = new Set<string>();
		if (checkpoint) {
			const files = new Map(entries);
			for (let i = 0; i < checkpoint.parts; i++) {
				const name = partName(checkpoint.id, i);
				const handle = files.get(name);
				if (!handle) throw new Error(`Missing disk checkpoint file ${name}`);
				const file = await handle.getFile();
				await this.#index(file, this.blocks, checkpoint.gen);
				this.#bytes += file.size;
				active.add(name);
			}
			this.#seq = checkpoint.next;
			this.#gen = checkpoint.gen;
		}
		const transactions = entries.filter(([name]) => TX.test(name) && Number(name.slice(0, 10)) >= this.#seq);
		transactions.sort(([a], [b]) => a.localeCompare(b));
		for (const [name, handle] of transactions) {
			if (Number(name.slice(0, 10)) !== this.#seq) throw new Error(`Missing disk transaction before ${name}`);
			const file = await handle.getFile();
			// An interrupted create can leave an empty final file.
			if (!file.size && name === transactions.at(-1)?.[0]) break;
			this.#gen = await this.#index(file, this.blocks);
			this.#bytes += file.size;
			this.#transactionCount++;
			this.#seq++;
		}
		// Only prune after verifying the checkpoint and its entire active tail.
		for (const [name] of entries) {
			if ((PART.test(name) && !active.has(name)) ||
				(checkpoint && TX.test(name) && Number(name.slice(0, 10)) < checkpoint.next)) {
				await this.dir.removeEntry(name).catch(() => {}); // retry on the next open
			}
		}
		return { keys: new Set(this.blocks.keys()), initialized: this.#seq > 0, gen: this.#gen, uid: this.#manifest!.uid };
	}

	async #publish(manifest: Manifest): Promise<void> {
		await writeFile(this.#file!, JSON.stringify({ ...manifest, identity: identity(manifest.version, manifest.size) }));
		this.#manifest = manifest;
	}

	async grow(size: number): Promise<void> {
		if (!validSize(size) || size < this.size) throw new Error("Choose a valid disk size at least as large as the current disk");
		if (size > this.size) await this.#publish({ ...this.#manifest!, version: 2, size });
	}

	async #index(file: File, index: Map<number, BlockLocation>, checkpointGen?: number): Promise<number> {
		if (file.size < HEADER) throw new Error(`Truncated disk transaction ${file.name}`);
		const header = new DataView(await file.slice(0, HEADER).arrayBuffer());
		const puts = header.getUint32(4, true), dels = header.getUint32(8, true), gen = header.getUint32(12, true);
		const data = HEADER + 4 * (puts + dels);
		const limit = this.size / BLOCK;
		if (header.getUint32(0, true) !== MAGIC || puts + dels > limit || file.size !== data + puts * BLOCK ||
			(checkpointGen !== undefined && (dels || gen !== checkpointGen || !puts || puts > SHARD_BLOCKS))) {
			throw new Error(`Invalid disk transaction ${file.name}`);
		}
		const numbers = new DataView(await file.slice(HEADER, data).arrayBuffer());
		for (let i = 0; i < puts + dels; i++) {
			const block = numbers.getUint32(i * 4, true);
			if (block >= limit || (checkpointGen !== undefined && index.has(block))) throw new Error(`Invalid block in ${file.name}`);
			if (i < puts) index.set(block, { file, offset: data + i * BLOCK });
			else index.delete(block);
		}
		return gen;
	}

	async getBlocks(blocks: number[]): Promise<Map<number, Uint8Array>> {
		const out = new Map<number, Uint8Array>();
		await Promise.all(blocks.map(async (block) => {
			const loc = this.blocks.get(block);
			if (loc) out.set(block, new Uint8Array(await loc.file.slice(loc.offset, loc.offset + BLOCK).arrayBuffer()));
		}));
		return out;
	}

	async save(puts: Array<[number, Uint8Array]>, dels: number[], meta?: { gen: number }): Promise<void> {
		if (!this.#lock) throw new Error("The folder disk is closed");
		const gen = meta?.gen ?? this.#gen;
		const header = batchHeader(puts.map(([block]) => block), dels, gen);
		const file = await this.dir.getFileHandle(`${String(this.#seq).padStart(10, "0")}.kwd`, { create: true });
		if ((await file.getFile()).size) throw new Error("The folder disk changed while it was open");
		const parts: BlobPart[] = [header];
		for (const [, bytes] of puts) parts.push(bytes.slice());
		await writeFile(file, new Blob(parts));
		const saved = await file.getFile();
		for (const [i, [block]] of puts.entries()) this.blocks.set(block, { file: saved, offset: header.byteLength + i * BLOCK });
		for (const block of dels) this.blocks.delete(block);
		this.#seq++;
		this.#gen = gen;
		this.#bytes += saved.size;
		this.#transactionCount++;
	}

	async compact(force: boolean, onStart?: () => void): Promise<FolderCompaction | null> {
		if (!this.#transactionCount) return null;
		const parts = Math.ceil(this.blocks.size / SHARD_BLOCKS);
		const compactBytes = this.blocks.size * (BLOCK + 4) + parts * HEADER;
		if (!force && this.#transactionCount < COMPACT_TRANSACTIONS && this.#bytes - compactBytes < COMPACT_RECLAIM) return null;
		onStart?.();
		const started = performance.now();
		const id = crypto.randomUUID();
		const checkpoint: Checkpoint = { id, next: this.#seq, parts, gen: this.#gen };
		const keys = [...this.blocks.keys()].sort((a, b) => a - b);
		for (let i = 0; i < parts; i++) {
			const shard = keys.slice(i * SHARD_BLOCKS, (i + 1) * SHARD_BLOCKS);
			const content: BlobPart[] = [batchHeader(shard, [], this.#gen)];
			// Group adjacent ranges from a transaction into a single Blob slice.
			for (let j = 0; j < shard.length;) {
				const loc = this.blocks.get(shard[j++]!)!;
				let end = loc.offset + BLOCK;
				while (j < shard.length) {
					const next = this.blocks.get(shard[j]!)!;
					if (next.file !== loc.file || next.offset !== end) break;
					end += BLOCK;
					j++;
				}
				content.push(loc.file.slice(loc.offset, end));
			}
			const handle = await this.dir.getFileHandle(partName(id, i), { create: true });
			await writeFile(handle, new Blob(content));
			const verified = new Map<number, BlockLocation>();
			await this.#index(await handle.getFile(), verified, this.#gen);
			if (verified.size !== shard.length || shard.some((key) => !verified.has(key))) {
				throw new Error("Checkpoint verification failed");
			}
		}

		const old = this.#manifest!.checkpoint;
		// The atomic manifest replacement is the only commit point.
		await this.#publish({ ...this.#manifest!, version: 2, checkpoint });
		for await (const [name, handle] of this.dir.entries()) {
			if (handle.kind === "file" && ((TX.test(name) && Number(name.slice(0, 10)) < checkpoint.next) ||
				(old && name.startsWith(`checkpoint-${old.id}-`) && PART.test(name)))) {
				await this.dir.removeEntry(name).catch(() => {});
			}
		}
		return { reclaimedBytes: Math.max(0, this.#bytes - compactBytes), transactions: this.#transactionCount,
			checkpointFiles: parts, elapsedMs: performance.now() - started };
	}

	async clear(): Promise<void> {
		throw new Error("Use a different folder to start with a fresh disk");
	}

	async close(): Promise<void> {
		const lock = this.#lock;
		this.#lock = undefined;
		await lock?.abort();
	}
}

/** Read only the manifest, so the boot picker can show the current capacity. */
export async function folderDiskSize(folder: FileSystemDirectoryHandle): Promise<number | undefined> {
	try {
		const dir = await folder.getDirectoryHandle("unkernel-data");
		const file = await (await dir.getFileHandle("disk.json")).getFile();
		return file.size ? parseManifest(await file.text()).size : undefined;
	} catch (e) {
		if ((e as Error).name !== "NotFoundError") throw e;
		return undefined;
	}
}

/** Compact a stopped folder disk while holding its writer lock. */
export async function compactFolderDisk(folder: FileSystemDirectoryHandle, force = false, onStart?: () => void): Promise<FolderCompaction | null> {
	const store = new FolderStore(await folder.getDirectoryHandle("unkernel-data"));
	try {
		await store.open();
		return await store.compact(force, onStart);
	} finally {
		await store.close().catch(() => {});
	}
}

/** Open the guest's ext4 disk in a user-selected directory. */
export async function openFolderDisk(
	folder: FileSystemDirectoryHandle, template: Uint8Array, onError?: (e: unknown) => void, requestedSize?: number,
): Promise<CowDisk> {
	const tpl = await readKwsparse(template);
	if (tpl.blockSize !== BLOCK || !validSize(tpl.size)) throw new Error("Invalid data disk template");
	if (requestedSize !== undefined && (!validSize(requestedSize) || requestedSize < tpl.size))
		throw new Error("Invalid requested folder disk size");
	const dir = await folder.getDirectoryHandle("unkernel-data", { create: true });
	const store = new FolderStore(dir);
	try {
		const st = await store.attach(requestedSize ?? tpl.size);
		if (requestedSize !== undefined) await store.grow(requestedSize);
		if (!st.initialized) {
			if (store.size < tpl.size) throw new Error("The folder disk is smaller than its template");
			await store.save(tpl.indices.map((block, i) => [block, tpl.block(i)]), []);
			st.keys = new Set(tpl.indices);
		}
		const disk = new CowDisk(new ZeroBase(store.size), { store, onError });
		disk.adoptStore(st, store.diskIdentity);
		disk.seeded = !st.initialized;
		disk.identity = store.diskIdentity;
		return disk;
	} catch (e) {
		await store.close().catch(() => {});
		throw e;
	}
}
