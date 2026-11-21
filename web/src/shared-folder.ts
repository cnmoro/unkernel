// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { FsError, type Fs, type FsAttr, type FsDirEntry, type FsFile, type FsSetAttr } from "./sdk.ts";

type FolderPicker = (options: { mode: "read" | "readwrite"; id: string }) => Promise<FileSystemDirectoryHandle>;
type Entry = FileSystemDirectoryHandle | FileSystemFileHandle;

export function directoryPicker(): FolderPicker | undefined {
	return (window as Window & { showDirectoryPicker?: FolderPicker }).showDirectoryPicker?.bind(window);
}

const errors: Record<string, string> = {
	NotFoundError: "ENOENT", NotAllowedError: "EACCES", SecurityError: "EACCES", TypeMismatchError: "ENOTDIR",
	InvalidModificationError: "ENOTEMPTY", NoModificationAllowedError: "EBUSY", QuotaExceededError: "ENOSPC",
	AbortError: "EIO",
};

async function local<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op();
	} catch (e) {
		const err = e as Error;
		if (e instanceof DOMException && errors[err.name]) throw new FsError(errors[err.name]!, err.message);
		throw e;
	}
}

/** A live 9p view of the directory the browser granted access to. */
export function sharedFolder(root: FileSystemDirectoryHandle, readOnly: boolean): Fs {
	let tail = Promise.resolve();
	const openFiles = new Map<string, Set<{ removed: boolean }>>();

	// Different 9p fids can write to the same file. Commit one browser write
	// before opening the next writable stream, so their replacements compose.
	function ordered<T>(op: () => Promise<T>): Promise<T> {
		const result = tail.then(() => local(op));
		tail = result.then(() => {}, () => {});
		return result;
	}

	function mutate<T>(op: () => Promise<T>): Promise<T> {
		return readOnly ? Promise.reject(new FsError("EROFS")) : ordered(op);
	}

	async function parent(path: string) {
		const parts = path.slice(1).split("/");
		const name = parts.pop()!;
		let dir = root;
		for (const part of parts) dir = await dir.getDirectoryHandle(part);
		return { dir, name };
	}

	async function child(dir: FileSystemDirectoryHandle, name: string): Promise<Entry> {
		try {
			return await dir.getFileHandle(name);
		} catch (e) {
			if ((e as Error).name !== "TypeMismatchError") throw e;
			return dir.getDirectoryHandle(name);
		}
	}

	async function entry(path: string): Promise<Entry> {
		if (path === "/") return root;
		const { dir, name } = await parent(path);
		return child(dir, name);
	}

	async function absent(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
		try {
			await child(dir, name);
		} catch (e) {
			if ((e as Error).name === "NotFoundError") return;
			throw e;
		}
		throw new FsError("EEXIST");
	}

	async function attrs(handle: Entry): Promise<FsAttr> {
		if (handle.kind === "directory") return { type: "dir", mode: readOnly ? 0o555 : 0o755 };
		const file = await handle.getFile();
		return { type: "file", mode: readOnly ? 0o444 : 0o644, size: file.size, mtimeMs: file.lastModified, version: 0 };
	}

	async function change(file: FileSystemFileHandle, command: FileSystemWriteChunkType): Promise<void> {
		const options = { keepExistingData: true, mode: "exclusive" } as const;
		const writer = await file.createWritable(options);
		try {
			await writer.write(command);
			await writer.close();
		} catch (e) {
			await writer.abort().catch(() => {});
			throw e;
		}
	}

	async function setattr(file: FileSystemFileHandle, attr: FsSetAttr): Promise<void> {
		if (attr.size === undefined)
			throw new FsError("EOPNOTSUPP", "the browser cannot change file ownership, mode or timestamps");
		await change(file, { type: "truncate", size: attr.size });
	}

	function openFile(path: string, file: FileSystemFileHandle, write: boolean, append: boolean): FsFile {
		const opens = openFiles.get(path) ?? new Set();
		openFiles.set(path, opens);
		const handle = { removed: false };
		opens.add(handle);
		const check = () => { if (handle.removed) throw new FsError("ESTALE"); };
		return {
			read: (pos, size) => ordered(async () => {
				check();
				const data = await file.getFile();
				return new Uint8Array(await data.slice(pos, pos + size).arrayBuffer());
			}),
			getattr: () => local(() => { check(); return attrs(file); }),
			write: write && !readOnly ? (pos, data) => {
				const bytes = data.slice();
				return mutate(async () => {
					check();
					const position = append ? (await file.getFile()).size : pos;
					await change(file, { type: "write", position, data: bytes });
					return bytes.length;
				});
			} : undefined,
			setattr: (attr) => mutate(() => { check(); return setattr(file, attr); }),
			close() {
				opens.delete(handle);
				if (!opens.size && openFiles.get(path) === opens) openFiles.delete(path);
			},
		};
	}

	return {
		getattr: (path) => local(async () => attrs(await entry(path))),
		readdir: (path) => local(async () => {
			const dir = await entry(path);
			if (dir.kind !== "directory") throw new FsError("ENOTDIR");
			const entries: FsDirEntry[] = [];
			for await (const [name, handle] of dir.entries()) entries.push({ name, type: handle.kind === "file" ? "file" : "dir" });
			return entries;
		}),
		open: (path, flags) => local(async () => {
			if (flags.write && readOnly) throw new FsError("EROFS");
			const open = async () => {
				const file = await entry(path);
				if (file.kind !== "file") throw new FsError("EISDIR");
				if (flags.truncate) await change(file, { type: "truncate", size: 0 });
				return openFile(path, file, flags.write, flags.append);
			};
			return flags.truncate ? mutate(open) : ordered(open);
		}),
		create: (path) => mutate(async () => {
			const { dir, name } = await parent(path);
			await absent(dir, name);
			return openFile(path, await dir.getFileHandle(name, { create: true }), true, false);
		}),
		mkdir: (path) => mutate(async () => {
			const { dir, name } = await parent(path);
			await absent(dir, name);
			await dir.getDirectoryHandle(name, { create: true });
		}),
		remove: (path, directory) => mutate(async () => {
			const { dir, name } = await parent(path);
			const current = await child(dir, name);
			if ((current.kind === "directory") !== directory) throw new FsError(directory ? "ENOTDIR" : "EISDIR");
			await dir.removeEntry(name);
			for (const handle of openFiles.get(path) ?? []) handle.removed = true;
			openFiles.delete(path);
		}),
		setattr: (path, attr) => mutate(async () => {
			const file = await entry(path);
			if (file.kind !== "file") throw new FsError("EISDIR");
			await setattr(file, attr);
		}),
		rename: () => { throw new FsError("EOPNOTSUPP", "the browser cannot safely rename local files"); },
	};
}
