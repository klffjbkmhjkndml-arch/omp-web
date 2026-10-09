import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Anchored floating panel. Opens above the anchor when there is more room
 * there (composer menus), otherwise below; clamps to the viewport. Closes on
 * outside pointer-down and Escape.
 */
export function Popover({
	anchor,
	onClose,
	children,
	width,
	align = "start",
	prefer = "auto",
}: {
	anchor: RefObject<HTMLElement | null>;
	onClose: () => void;
	children: ReactNode;
	width?: number;
	align?: "start" | "end";
	prefer?: "auto" | "above" | "below";
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>();

	useLayoutEffect(() => {
		const a = anchor.current?.getBoundingClientRect();
		const el = ref.current;
		if (!a || !el) return;
		const w = width ?? el.offsetWidth;
		const gap = 8;
		const above = a.top;
		const below = window.innerHeight - a.bottom;
		const placeAbove = prefer === "above" || (prefer === "auto" && above > below);
		let left = align === "end" ? a.right - w : a.left;
		left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
		setPos(
			placeAbove
				? { left, bottom: window.innerHeight - a.top + gap, maxHeight: above - gap - 12 }
				: { left, top: a.bottom + gap, maxHeight: below - gap - 12 },
		);
	}, [anchor, width, align, prefer]);

	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
			onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [anchor, onClose]);

	return createPortal(
		<div
			ref={ref}
			className="pop"
			style={{
				width,
				left: pos?.left ?? -9999,
				top: pos?.top,
				bottom: pos?.bottom,
				maxHeight: pos?.maxHeight,
				overflowY: "auto",
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{children}
		</div>,
		document.body,
	);
}

export function Dialog({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		<div className="scrim" onPointerDown={e => e.target === e.currentTarget && onClose()}>
			<div className="dialog" role="dialog" aria-modal="true">
				<div className="dialog-head">{title}</div>
				<div className="dialog-body">{children}</div>
				{footer && <div className="dialog-foot">{footer}</div>}
			</div>
		</div>,
		document.body,
	);
}
