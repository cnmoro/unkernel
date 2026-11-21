// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { useState } from "react";
import { KW } from "../kw.ts";
import type { Mount } from "../sdk.ts";
import { directoryPicker, sharedFolder } from "../shared-folder.ts";
import { useStore } from "../store.ts";

type LocalDirectory = FileSystemDirectoryHandle & {
	queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
	requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
};

interface Share {
	folder: FileSystemDirectoryHandle;
	mount: Mount;
	writable: boolean;
}

async function overlaps(a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle): Promise<boolean> {
	return await a.resolve(b) !== null || await b.resolve(a) !== null;
}

export function SharedFolders() {
	const state = useStore((s) => s.state);
	const [shares, setShares] = useState<Share[]>([]);
	const [writable, setWritable] = useState(false);
	const [pending, setPending] = useState<LocalDirectory>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const pick = directoryPicker();
	if (!pick) return <p className="text-muted">Folder sharing requires a browser with a local folder picker.</p>;
	const disabled = busy || state !== "running";
	const active = shares.filter((share) => share.mount.mounted);

	async function add(grant?: LocalDirectory) {
		setBusy(true);
		setError("");
		try {
			// Some Chromium versions keep an existing read grant even when
			// the same folder is selected again in the read/write picker.
			const permission = { mode: "readwrite" } as const;
			if (!grant) setPending(undefined);
			const folder: LocalDirectory = grant ?? await pick!({ id: "unkernel-share", mode: writable ? "readwrite" : "read" });
			if (grant) {
				if ((await grant.requestPermission?.(permission)) !== "granted") throw new Error("The browser did not grant write access.");
				setPending(undefined);
			} else if (writable && folder.queryPermission && await folder.queryPermission(permission) !== "granted") {
				setPending(folder);
				return;
			}
			const vm = await KW.ready!();
			if (KW.dataFolder && await overlaps(KW.dataFolder, folder)) {
				throw new Error("Choose a folder outside the VM’s persistent storage folder.");
			}
			for (const share of active) {
				if (await overlaps(share.folder, folder)) {
					throw new Error(`This folder overlaps the share at ${share.mount.path}.`);
				}
			}

			const name = folder.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "folder";
			const base = `/mnt/shared-${name}`;
			for (let i = 1; i <= 100; i++) {
				const path = i === 1 ? base : `${base}-${i}`;
				// kw9p accepts an existing directory. Skip it here so a share
				// never hides the guest's own files or an unrelated mount.
				const exists = await vm.exec("sh", ["-c", 'test -e "$1" || test -L "$1"', "sh", path], { user: "root" });
				if (exists.exitCode === 0) continue;
				if (exists.exitCode !== 1) throw new Error(exists.stderr || "Could not check the guest mount path.");
				const mount = await vm.mount(path, sharedFolder(folder, !writable), { readOnly: !writable });
				setShares((prev) => [...prev.filter((s) => s.mount.mounted), { folder, mount, writable }]);
				return;
			}
			throw new Error("No free guest path for this folder.");
		} catch (e) {
			if ((e as Error).name !== "AbortError") setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function unmount(share: Share) {
		setBusy(true);
		setError("");
		try {
			await share.mount.unmount();
			setShares((prev) => prev.filter((s) => s.mount.mounted));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<p className="text-muted">Make host files available under <code>/mnt</code> for this session.</p>
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void add()}>Share folder…</button>
				{pending && <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void add(pending)}>Grant write access…</button>}
				<label className="flex items-center gap-1.5 text-muted">
					<input type="checkbox" checked={writable} disabled={disabled} onChange={(e) => { setPending(undefined); setError(""); setWritable(e.currentTarget.checked); }} />
					Allow guest changes
				</label>
			</div>
			{pending && <p className="mt-2 text-faint">Grant the browser write access to {pending.name} to mount it read/write.</p>}
			{writable && <p className="mt-2 text-faint">The guest can edit and delete host files. The browser limits renames and Linux file metadata.</p>}
			{state === "running" && active.length > 0 && <ul className="mt-3 space-y-2" aria-label="Shared folders">
				{active.map((share) => <li className="flex items-center gap-2" key={share.mount.path}>
					<span className="min-w-0 flex-1 break-all">{share.folder.name} → <code>{share.mount.path}</code> <span className="text-faint">({share.writable ? "read/write" : "read only"})</span></span>
					<button type="button" className="btn btn-sm shrink-0" disabled={disabled} aria-label={`Unmount ${share.mount.path}`} onClick={() => void unmount(share)}>Unmount</button>
				</li>)}
			</ul>}
			{error && <p role="alert" className="mt-2 text-err">{error}</p>}
		</>
	);
}
