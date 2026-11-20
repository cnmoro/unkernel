// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page: the stage (the terminal, the splash card) with the guest preview
// panel docked right of it, the key bar, the status line at the bottom, the
// guest's display over the stage (or over all of them, rotated), and over them the
// dialog, the paste dialog and the toast. Also the page-wide behaviour: the keyboard
// shortcuts (shortcuts.ts), following the visual viewport (the on-screen
// keyboard), when the key bar shows, and the pinch that sets the font size
// on phones.
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { trackBottom } from "../bottom.ts";
import { setStage } from "../display.ts";
import { KW } from "../kw.ts";
import { installShortcuts } from "../shortcuts.ts";
import { ui$, useStore } from "../store.ts";
import { Bar } from "./Bar.tsx";
import { Desktop } from "./Desktop.tsx";
import { Display } from "./Display.tsx";
import { Keys } from "./Keys.tsx";
import { Launchpad } from "./Launcher.tsx";
import { Confirm, PasteDialog, ResumeCard, Splash, Toast } from "./Overlays.tsx";
import { Panel } from "./Panel.tsx";
import { Preview } from "./Preview.tsx";

/**
 * The terminals' hosts. #term is window 0's (boot.ts): wterm renders the
 * rows as DOM text in it, which is also the scroll container, and sets its
 * own class. windows.ts adds the other windows to #terms, each over the
 * same box. React renders these once and never touches them again.
 */
const TermHost = memo(() => <div id="terms" className="relative h-full w-full"><div id="term" /></div>);

export function App() {
	const cfg = KW.config;
	const state = useStore((s) => s.state);
	const app = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<boolean>();
	const desktop = view ?? !!KW.startDesktop;
	const toggleDesktop = () => {
		setView(!desktop);
		if (desktop) KW.term?.focus();
	};
	const [stage, setStageEl] = useState<HTMLElement | null>(null);

	useEffect(() => setStage(stage), [stage]);
	useViewport(app);
	useKeyBar(cfg.mobile);
	usePinchFont(cfg.mobile);
	// Before boot.ts adds display.ts's key listener, so the prefix comes first.
	useEffect(installShortcuts, []);

	return (
		<>
			<div id="app" ref={app} data-state={state} className={`fixed inset-x-0 top-0 flex h-dvh flex-col ${cfg.mobile ? "mobile" : ""}`}>
				{/* The stage, and the preview docked right of it (it takes part of the stage's width). */}
				<div className="relative flex min-h-0 flex-1">
					<main id="stage" ref={setStageEl} className="relative min-h-0 min-w-0 flex-1 pt-[max(8px,var(--st))] pr-[max(12px,var(--sr))] pb-1 pl-[max(12px,var(--sl))]">
						<TermHost />
						<Splash />
						<ResumeCard />
						{desktop && state === "running" && <Desktop />}
					</main>
					<Preview />
				</div>
				<Keys />
				<Bar desktop={desktop} onDesktop={cfg.guest === "debian" && state === "running" ? toggleDesktop : undefined} />
				{/* Over the stage, or rotated over the whole page (status line included). */}
				<Display stage={stage} />
			</div>
			<Panel />
			<Launchpad />
			<PasteDialog />
			<Confirm />
			<Toast />
		</>
	);
}

/**
 * The on-screen keyboard: with interactive-widget=resizes-content Chrome
 * shrinks the layout viewport itself; elsewhere (iOS, older Chrome) follow
 * the visual viewport.
 *
 * And keep window 0's terminal at its bottom when it gets shorter (the
 * keyboard, the key bar): bottom.ts, set up here at mount, before boot.ts
 * makes wterm, and run synchronously in the viewport events. windows.ts
 * does the same for the other windows.
 */
function useViewport(app: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		const el = app.current!, bottom = trackBottom(document.getElementById("term")!), vv = visualViewport;
		const apply = () => {
			// The on-screen keyboard is up (not a pinch zoom, which also shrinks the visual viewport): style.css hides the status line.
			document.documentElement.classList.toggle("kb", !!vv && Math.abs(vv.scale - 1) <= 0.01 && vv.height < document.documentElement.clientHeight - 120);
			if (!vv || Math.abs(vv.scale - 1) > 0.01) { el.style.height = ""; el.style.top = ""; }
			else {
				// Whole px, rounded down, so the page never runs past the screen's bottom edge.
				const full = standaloneHeight(vv.height);
				el.style.height = `${Math.floor(full ?? vv.height)}px`;
				el.style.top = `${full ? 0 : Math.floor(vv.offsetTop)}px`;
			}
			bottom.keep();
		};
		const rotate = () => setTimeout(apply, 250);
		// The keyboard going away with the focus (standaloneHeight() asks for it).
		const blur = () => setTimeout(apply, 0);
		vv?.addEventListener("resize", apply);
		vv?.addEventListener("scroll", apply);
		addEventListener("resize", bottom.keep);
		addEventListener("orientationchange", rotate);
		document.addEventListener("focusout", blur);
		apply();
		return () => {
			bottom.dispose();
			vv?.removeEventListener("resize", apply);
			vv?.removeEventListener("scroll", apply);
			removeEventListener("resize", bottom.keep);
			removeEventListener("orientationchange", rotate);
			document.removeEventListener("focusout", blur);
		};
	}, [app]);
}

/**
 * The key bar: phones only, and only while the on-screen keyboard is up: the
 * terminal has the focus and the visual viewport is well below the tallest
 * seen at this width (the keyboard takes that space; a hardware keyboard
 * takes none, and then the bar is not needed). A rotation starts the
 * measuring over.
 */
function useKeyBar(mobile: boolean) {
	useEffect(() => {
		if (!mobile) return;
		let tallest = 0, tallestW = 0;
		const update = () => {
			const h = visualViewport?.height ?? innerHeight;
			if (innerWidth !== tallestW) { tallest = 0; tallestW = innerWidth; }
			tallest = Math.max(tallest, h);
			const on = h < tallest - 120 && !!document.activeElement?.closest("#terms");
			if (ui$().get().keysOn !== on) ui$().set({ keysOn: on });
		};
		const later = () => setTimeout(update, 0); // after focus lands elsewhere
		update();
		visualViewport?.addEventListener("resize", update);
		addEventListener("resize", update);
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", later);
		return () => {
			visualViewport?.removeEventListener("resize", update);
			removeEventListener("resize", update);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", later);
		};
	}, [mobile]);
}

/**
 * The page's height in an iOS home screen app (standalone): the layout
 * viewport's (what a fixed element with inset 0 fills), unless the on-screen
 * keyboard is up. The visual viewport can stay short after the keyboard
 * closed, which would leave a dead strip at the bottom. Not the screen's
 * height: the viewport can be shorter (index.html's status bar style), and
 * what is past it is not shown. Undefined elsewhere.
 */
function standaloneHeight(vvHeight: number): number | undefined {
	if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return;
	const full = document.documentElement.clientHeight;
	// Only a focused field can have the keyboard up, and it takes well over 120 px.
	const el = document.activeElement as HTMLElement | null;
	const editable = !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
	if (editable && vvHeight < full - 120) return;
	return full;
}

/**
 * Phones: a pinch on the terminal sets the font size (whole px, 9 to 24,
 * kept like the Font size option) and never zooms the page. iOS ignores
 * user-scalable=no: cancelling Safari's gesture events and every two-finger
 * touchmove is what stops its zoom. Linear and damped: 1 px of font per
 * PINCH_STEP px the fingers move apart or together (a ratio of finger
 * distances swings straight to the limits). The start is taken when the
 * second finger lands, not at the first move.
 */
function usePinchFont(mobile: boolean) {
	useEffect(() => {
		if (!mobile) return;
		const PINCH_STEP = 30;
		const span = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
		let pinch: { d: number; size: number; on: boolean } | null = null;
		const startPinch = (e: TouchEvent) => {
			// Not over the guest's display or its touch controls (a d-pad and a button held at once).
			const onDisplay = [...e.touches].some((t) => !!(t.target as Element | null)?.closest?.("#fb-layer"));
			pinch = { d: span(e.touches), size: ui$().get().fontSize, on: !onDisplay && !!(e.target as Element | null)?.closest?.("#stage") };
		};
		const start = (e: TouchEvent) => { if (e.touches.length === 2) startPinch(e); };
		const move = (e: TouchEvent) => {
			if (e.touches.length < 2) return;
			if (e.cancelable) e.preventDefault(); // no page zoom
			if (!pinch) startPinch(e);
			if (!pinch!.on) return;
			const n = Math.min(24, Math.max(9, Math.round(pinch!.size + (span(e.touches) - pinch!.d) / PINCH_STEP)));
			if (n !== ui$().get().fontSize) KW.ui!.setFont(String(n));
		};
		const end = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
		const gesture = (e: Event) => e.preventDefault();
		document.addEventListener("touchstart", start, { passive: true });
		document.addEventListener("touchmove", move, { passive: false });
		document.addEventListener("touchend", end);
		document.addEventListener("touchcancel", end);
		for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, gesture, { passive: false });
		return () => {
			document.removeEventListener("touchstart", start);
			document.removeEventListener("touchmove", move);
			document.removeEventListener("touchend", end);
			document.removeEventListener("touchcancel", end);
			for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.removeEventListener(type, gesture);
		};
	}, [mobile]);
}
