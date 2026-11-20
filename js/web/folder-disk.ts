// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { CowDisk, ZeroBase, type OverlayStore, type StoreIndex } from "../core/block.ts";
import { decodeKwsparse, gunzipIfNeeded } from "../core/kwsparse.ts";

const BLOCK = 4096;
const MAGIC = 0x3144574b; // KWD1
const HEADER = 16;
const TX = /^([0-9]{10})\.kwd$/;
const EXCLUSIVE = { mode: "exclusive", keepExistingData: false } as const;

interface BlockLocation {
	file: File;
	offset: number;
}

class FolderStore implements OverlayStore {
	readonly name: string;
	readonly dir: FileSystemDirectoryHandle;
	readonly totalBlocks: number;
	readonly blocks = new Map<number, BlockLocation>();
	#lock: FileSystemWritableFileStream | undefined;
	#seq = 0;
	#gen = 0;

	constructor(dir: FileSystemDirectoryHandle, totalBlocks: number) {
		this.dir = dir;
		this.totalBlocks = totalBlocks;
		this.name = dir.name;
	}

	async open(identity: string): Promise<StoreIndex> {
		// Keep a writable open for the lifetime of the store. The lock file
		// itself stays empty, including across a browser crash.
		const lock = await this.dir.getFileHandle("writer.lock", { create: true });
		this.#lock = await lock.createWritable(EXCLUSIVE);
		const manifest = await this.dir.getFileHandle("disk.json", { create: true });
		const previous = await manifest.getFile();
		let uid: string;
		if (previous.size) {
			const meta = JSON.parse(await previous.text()) as { identity?: string; uid?: string };
			if (meta.identity !== identity || typeof meta.uid !== "string" || !meta.uid)
				throw new Error("This folder contains a data disk with an incompatible format or size");
			uid = meta.uid;
		} else {
			uid = crypto.randomUUID();
		}
		const transactions: [string, FileSystemFileHandle][] = [];
		for await (const [name, handle] of this.dir.entries()) {
			if (TX.test(name) && handle.kind === "file") transactions.push([name, handle]);
		}
		transactions.sort(([a], [b]) => a.localeCompare(b));
		if (!previous.size && transactions.length) throw new Error("The saved disk manifest is missing");
		for (const [name, handle] of transactions) {
			if (Number(name.slice(0, 10)) !== this.#seq) throw new Error(`Missing disk transaction before ${name}`);
			const file = await handle.getFile();
			// getFileHandle(create) can leave an empty last file if interrupted
			// before the atomic close. The next flush can replace it.
			if (!file.size && name === transactions.at(-1)?.[0]) break;
			await this.#index(file);
			this.#seq++;
		}
		if (!previous.size) {
			const writer = await manifest.createWritable(EXCLUSIVE);
			try {
				await writer.write(JSON.stringify({ identity, uid }));
				await writer.close();
			} catch (error) {
				await writer.abort().catch(() => {});
				throw error;
			}
		}
		return { keys: new Set(this.blocks.keys()), initialized: this.#seq > 0, gen: this.#gen, uid };
	}

	async #index(file: File): Promise<void> {
		if (file.size < HEADER) throw new Error(`Truncated disk transaction ${file.name}`);
		const header = new DataView(await file.slice(0, HEADER).arrayBuffer());
		const puts = header.getUint32(4, true), dels = header.getUint32(8, true);
		const data = HEADER + 4 * (puts + dels);
		if (header.getUint32(0, true) !== MAGIC || puts + dels > this.totalBlocks || file.size !== data + puts * BLOCK)
			throw new Error(`Invalid disk transaction ${file.name}`);
		const numbers = new DataView(await file.slice(HEADER, data).arrayBuffer());
		for (let i = 0; i < puts + dels; i++) {
			const block = numbers.getUint32(i * 4, true);
			if (block >= this.totalBlocks) throw new Error(`Invalid block in disk transaction ${file.name}`);
			if (i < puts) this.blocks.set(block, { file, offset: data + i * BLOCK });
			else this.blocks.delete(block);
		}
		this.#gen = header.getUint32(12, true);
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
		const header = new DataView(new ArrayBuffer(HEADER + 4 * (puts.length + dels.length)));
		header.setUint32(0, MAGIC, true);
		header.setUint32(4, puts.length, true);
		header.setUint32(8, dels.length, true);
		header.setUint32(12, gen, true);
		for (const [i, [block]] of puts.entries()) header.setUint32(HEADER + 4 * i, block, true);
		for (const [i, block] of dels.entries()) header.setUint32(HEADER + 4 * (puts.length + i), block, true);
		const file = await this.dir.getFileHandle(`${String(this.#seq).padStart(10, "0")}.kwd`, { create: true });
		if ((await file.getFile()).size) throw new Error("The folder disk changed while it was open");
		const writer = await file.createWritable(EXCLUSIVE);
		try {
			const parts: BlobPart[] = [header.buffer as ArrayBuffer];
			for (const [, bytes] of puts) parts.push(bytes.slice());
			await writer.write(new Blob(parts));
			await writer.close();
		} catch (error) {
			await writer.abort().catch(() => {});
			throw error;
		}
		const saved = await file.getFile();
		for (const [i, [block]] of puts.entries()) this.blocks.set(block, { file: saved, offset: header.byteLength + i * BLOCK });
		for (const block of dels) this.blocks.delete(block);
		this.#seq++;
		this.#gen = gen;
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

/** Open the guest's ext4 disk in a user-selected directory. */
export async function openFolderDisk(folder: FileSystemDirectoryHandle, template: Uint8Array, onError?: (e: unknown) => void): Promise<CowDisk> {
	const tpl = decodeKwsparse(await gunzipIfNeeded(template));
	if (tpl.blockSize !== BLOCK || tpl.size % BLOCK) throw new Error("Invalid data disk template");
	const dir = await folder.getDirectoryHandle("unkernel-data", { create: true });
	const identity = `unkernel-folder-v1 size=${tpl.size} bs=${BLOCK}`;
	const store = new FolderStore(dir, tpl.size / BLOCK);
	try {
		const st = await store.open(identity);
		if (!st.initialized) {
			await store.save(tpl.indices.map((block, i) => [block, tpl.block(i)]), []);
			st.keys = new Set(tpl.indices);
		}
		const disk = new CowDisk(new ZeroBase(tpl.size), { store, onError });
		disk.adoptStore(st, identity);
		disk.seeded = !st.initialized;
		disk.identity = identity;
		return disk;
	} catch (e) {
		await store.close().catch(() => {});
		throw e;
	}
}
