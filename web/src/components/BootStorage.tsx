// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { KW } from "../kw.ts";
import { directoryPicker } from "../shared-folder.ts";
import { DEFAULT_FOLDER_DISK_GIB, MAX_FOLDER_DISK_GIB, folderDiskSize } from "../sdk.ts";

const GiB = 1024 ** 3;

function BootChoices({ pick, askView, done }: { pick?: ReturnType<typeof directoryPicker>; askView: boolean; done: () => void }) {
	const [desktop, setDesktop] = useState(!!KW.startDesktop);
	const [folder, setFolder] = useState<FileSystemDirectoryHandle>();
	const [current, setCurrent] = useState<number>();
	const [gib, setGib] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const minimum = Math.ceil((current ?? DEFAULT_FOLDER_DISK_GIB * GiB) / GiB);
	const size = Number(gib);
	const valid = Number.isInteger(size) && size >= minimum && size <= MAX_FOLDER_DISK_GIB;
	const canGrow = KW.config.guest === "debian";

	function finish(data: "browser" | "temporary" | "folder") {
		KW.startDesktop = desktop;
		if (data === "temporary") KW.config.data = false;
		if (data === "folder") {
			KW.dataFolder = folder;
			if (canGrow && valid && size * GiB > (current ?? DEFAULT_FOLDER_DISK_GIB * GiB)) KW.folderSize = size * GiB;
		}
		done();
	}

	async function chooseFolder() {
		setBusy(true);
		setError("");
		try {
			const selected = await pick!({ mode: "readwrite", id: "unkernel-data" });
			const bytes = await folderDiskSize(selected);
			setFolder(selected);
			setCurrent(bytes);
			setGib(String(Math.ceil((bytes ?? DEFAULT_FOLDER_DISK_GIB * GiB) / GiB)));
		} catch (e) {
			if ((e as Error).name !== "AbortError") setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="w-[min(460px,calc(100vw-32px))] border border-line-strong bg-bg p-5 text-fg">
			<h1 id="startup-title" className="mb-4 text-base font-medium">Start {KW.config.guest === "debian" ? "Debian" : "unkernel"}</h1>
			{askView && <fieldset className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
				<legend className="mb-2 text-muted">Start the graphical desktop?</legend>
				<label className="flex items-center gap-2"><input type="radio" name="boot-view" checked={!desktop} onChange={() => setDesktop(false)} /> Start in Terminal</label>
				<label className="flex items-center gap-2"><input type="radio" name="boot-view" checked={desktop} onChange={() => setDesktop(true)} /> Start in Desktop</label>
			</fieldset>}
			{pick && <div className="mb-4 space-y-3 text-sm">
				<p className="text-muted">Choose a folder to keep installed packages, settings, and files across browsers.</p>
				<button type="button" className="btn" disabled={busy} onClick={() => void chooseFolder()}>{folder ? "Change folder" : "Choose folder"}</button>
				{folder && <p className="break-all">{folder.name}/unkernel-data</p>}
				{folder && canGrow && <div>
					<label className="flex flex-wrap items-center gap-2">
						{current ? "Grow disk" : "Virtual disk capacity"}
						<input className="field w-24" type="number" min={minimum} max={MAX_FOLDER_DISK_GIB} step="1" value={gib} onChange={(e) => setGib(e.target.value)} /> GiB
					</label>
					<p className="mt-1 text-muted">{current ? `Current capacity ${current / GiB} GiB. ` : ""}The folder uses host space as Debian writes data.</p>
				</div>}
			</div>}
			<div className="flex flex-wrap gap-2">
				{folder && <button type="button" className="btn btn-primary" disabled={busy || (canGrow && !valid)} onClick={() => finish("folder")}>Boot with folder</button>}
				<button type="button" className={folder ? "btn" : "btn btn-primary"} disabled={busy} onClick={() => finish("browser")}>{pick ? "Use browser storage" : "Boot"}</button>
				{pick && <button type="button" className="btn" disabled={busy} onClick={() => finish("temporary")}>Temporary session</button>}
			</div>
			{error && <p role="alert" className="mt-3 text-sm text-err">{error}</p>}
		</div>
	);
}

export async function chooseBootStorage(): Promise<void> {
	const query = new URLSearchParams(location.search);
	const pick = KW.config.data && query.get("storage") !== "browser"
		? directoryPicker()
		: undefined;
	const view = query.get("view");
	KW.startDesktop = KW.config.guest === "debian" && view === "desktop";
	const askView = KW.config.guest === "debian" && view !== "terminal" && view !== "desktop";
	if (!pick && !askView) return;
	const dialog = document.createElement("dialog");
	dialog.setAttribute("aria-labelledby", "startup-title");
	dialog.className = "fixed m-auto bg-transparent backdrop:bg-black/65";
	dialog.addEventListener("cancel", (e) => e.preventDefault());
	document.body.append(dialog);
	const root = createRoot(dialog);
	try {
		await new Promise<void>((resolve) => {
			root.render(<BootChoices pick={pick} askView={askView} done={resolve} />);
			dialog.showModal();
		});
	} finally {
		root.unmount();
		dialog.remove();
	}
}
