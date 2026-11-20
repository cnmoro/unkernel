// SPDX-License-Identifier: MIT
// Copyright (C) 2026 unkernel contributors
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { KW } from "../kw.ts";

type FolderPicker = (options: { mode: "readwrite"; id: string }) => Promise<FileSystemDirectoryHandle>;

function StorageChoices({ pick, done }: { pick: FolderPicker; done: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function chooseFolder() {
		setBusy(true);
		setError("");
		try {
			KW.dataFolder = await pick({ mode: "readwrite", id: "unkernel-data" });
			done();
		} catch (e) {
			if ((e as Error).name !== "AbortError") setError((e as Error).message);
			setBusy(false);
		}
	}
	return (
		<div aria-labelledby="storage-title" className="w-[min(440px,calc(100vw-32px))] border border-line-strong bg-bg p-5 text-fg">
			<h1 id="storage-title" className="mb-2 text-base font-medium">Where should this system save its files?</h1>
			<p className="mb-4 text-sm text-muted">Choose a local folder to reopen your files and installed packages from another browser.</p>
			<div className="flex flex-wrap gap-2">
				<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void chooseFolder()}>Choose folder</button>
				<button type="button" className="btn" disabled={busy} onClick={done}>Use browser storage</button>
				<button type="button" className="btn" disabled={busy} onClick={() => { KW.config.data = false; done(); }}>Temporary session</button>
			</div>
			{error && <p role="alert" className="mt-3 text-sm text-err">{error}</p>}
		</div>
	);
}

export async function chooseBootStorage(): Promise<void> {
	const pick = (window as Window & { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
	if (!KW.config.data || !pick || new URLSearchParams(location.search).get("storage") === "browser") return;
	const dialog = document.createElement("dialog");
	dialog.setAttribute("aria-labelledby", "storage-title");
	dialog.className = "fixed m-auto bg-transparent backdrop:bg-black/65";
	dialog.addEventListener("cancel", (e) => e.preventDefault());
	document.body.append(dialog);
	const root = createRoot(dialog);
	try {
		await new Promise<void>((resolve) => {
			root.render(<StorageChoices pick={pick.bind(window)} done={resolve} />);
			dialog.showModal();
		});
	} finally {
		root.unmount();
		dialog.remove();
	}
}
