// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import assert from "node:assert/strict";
import test from "node:test";
import { encodeKwsparse } from "../js/core/kwsparse.ts";
import { compactFolderDisk, folderDiskSize, openFolderDisk } from "../js/web/folder-disk.ts";

const bs = 4096, diskSize = 4 * 1024 ** 3;
const filled = (value: number) => new Uint8Array(bs).fill(value);
const template = encodeKwsparse({ size: diskSize, blocks: [[0, filled(7)], [1, filled(8)]] });

function fixture() {
	const files = new Map<string, File>();
	const writers = new Set<string>();
	const faults = { write: "", remove: false };
	async function getFileHandle(name: string, { create = false } = {}) {
		if (!files.has(name)) {
			if (!create) throw new DOMException("Missing file", "NotFoundError");
			files.set(name, new File([], name));
		}
		return {
			kind: "file",
			getFile: async () => files.get(name)!,
			async createWritable() {
				if (writers.has(name)) throw new DOMException("Locked file", "NoModificationAllowedError");
				writers.add(name);
				let staged: File | undefined;
				return {
					async write(content: Blob | string) { staged = new File([content], name); },
					async close() {
						if (faults.write === name) throw new DOMException("Disk full", "QuotaExceededError");
						files.set(name, staged!);
						writers.delete(name);
					},
					async abort() { writers.delete(name); },
				};
			},
		};
	}
	const disk = {
		name: "unkernel-data",
		getFileHandle,
		async *entries() {
			for (const name of [...files.keys()]) yield [name, await getFileHandle(name)];
		},
		async removeEntry(name: string) {
			if (faults.remove) throw new DOMException("Permission denied", "NotAllowedError");
			files.delete(name);
		},
	};
	const folder = { name: "test", getDirectoryHandle: async () => disk } as unknown as FileSystemDirectoryHandle;
	return { folder, files, faults };
}

async function legacyFolder() {
	const f = fixture();
	const disk = await openFolderDisk(f.folder, template);
	await disk.write(0, [filled(33)]);
	await disk.discard(bs, bs);
	await disk.flush();
	await disk.store!.close!();
	const { uid } = JSON.parse(await f.files.get("disk.json")!.text());
	f.files.set("disk.json", new File([JSON.stringify({ identity: `unkernel-folder-v1 size=${diskSize} bs=4096`, uid })], "disk.json"));
	return { ...f, uid };
}

async function readDisk(folder: FileSystemDirectoryHandle, offset = 0) {
	const disk = await openFolderDisk(folder, template);
	const data = new Uint8Array(2 * bs);
	await disk.read(offset, [data]);
	await disk.store!.close!();
	return data;
}

test("compacts a legacy folder, preserves latest and discarded blocks, and grows in place", async () => {
	const { folder, files, uid } = await legacyFolder();
	const before = await readDisk(folder);
	const result = await compactFolderDisk(folder, true);
	assert.equal(result?.transactions, 2);
	assert.equal(result?.checkpointFiles, 1);
	assert.equal([...files.keys()].filter((name) => name.endsWith(".kwd")).length, 0);
	assert.deepEqual(await readDisk(folder), before);
	assert.deepEqual(before.subarray(bs), new Uint8Array(bs));

	const grown = await openFolderDisk(folder, template, undefined, diskSize * 2);
	assert.equal(grown.size, diskSize * 2);
	assert.equal(await folderDiskSize(folder), diskSize * 2);
	await grown.write(diskSize, [filled(42)]);
	await grown.flush();
	await grown.store!.close!();
	assert.equal(JSON.parse(await files.get("disk.json")!.text()).uid, uid);
	assert.deepEqual(await readDisk(folder), before);
	assert.deepEqual((await readDisk(folder, diskSize)).subarray(0, bs), filled(42));
	await assert.rejects(openFolderDisk(folder, template, undefined, diskSize), /at least as large/);
});

test("failed checkpoint publication preserves v1; failed cleanup can retry on reopen", async () => {
	const { folder, files, faults } = await legacyFolder();
	const before = await readDisk(folder);
	faults.write = "disk.json";
	await assert.rejects(compactFolderDisk(folder, true), { name: "QuotaExceededError" });
	assert.equal([...files.keys()].filter((name) => name.endsWith(".kwd")).length, 2);
	assert.deepEqual(await readDisk(folder), before);
	assert.equal([...files.keys()].filter((name) => name.endsWith(".kwc")).length, 0);

	faults.write = "";
	faults.remove = true;
	await compactFolderDisk(folder, true);
	assert.equal([...files.keys()].filter((name) => name.endsWith(".kwd")).length, 2);
	assert.deepEqual(await readDisk(folder), before);
	faults.remove = false;
	assert.deepEqual(await readDisk(folder), before);
	assert.equal([...files.keys()].filter((name) => name.endsWith(".kwd")).length, 0);
});

test("automatically checkpoints a long transaction tail and retains its latest write", async () => {
	const { folder, files } = fixture();
	const disk = await openFolderDisk(folder, template);
	for (let i = 0; i < 260; i++) {
		await disk.write(0, [filled((i % 255) + 1)]);
		await disk.flush();
	}
	await assert.rejects(compactFolderDisk(folder), { name: "NoModificationAllowedError" });
	await disk.store!.close!();
	const count = files.size;
	const result = await compactFolderDisk(folder);
	assert.equal(result?.transactions, 261);
	assert.ok(files.size < count / 20);
	assert.equal((await readDisk(folder))[0], 5);
	assert.equal(await compactFolderDisk(folder), null);
});
