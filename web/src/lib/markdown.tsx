import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { memo, useMemo } from "react";

const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		code({ text, lang }) {
			const language = (lang ?? "").trim().split(/\s+/)[0];
			const html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
			const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
			return `<div class="code-block"><div class="code-head">${label}<button class="code-copy" type="button" data-copy>复制</button></div><pre><code class="hljs">${html}</code></pre></div>`;
		},
		link({ href, text }) {
			return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${text}</a>`;
		},
	},
});

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const EXT_LANGUAGES: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	jsonc: "json",
	md: "markdown",
	markdown: "markdown",
	css: "css",
	scss: "scss",
	less: "less",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	yml: "yaml",
	yaml: "yaml",
	py: "python",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	rb: "ruby",
	php: "php",
	sql: "sql",
	toml: "ini",
	ini: "ini",
	diff: "diff",
	patch: "diff",
};

/** highlight.js language for a file path, by extension. */
export function languageForFile(file: string): string | undefined {
	const ext = file.split(".").pop()?.toLowerCase();
	return ext ? EXT_LANGUAGES[ext] : undefined;
}

/** Highlight a whole file body; unknown languages fall back to escaped text. */
export function highlightCode(text: string, language?: string): string {
	return language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
}

export function renderMarkdown(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ADD_ATTR: ["target", "data-copy"] });
}

function onClick(e: React.MouseEvent<HTMLDivElement>): void {
	const btn = (e.target as HTMLElement).closest("[data-copy]");
	if (!btn) return;
	const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
	void navigator.clipboard.writeText(code).then(() => {
		btn.textContent = "已复制";
		setTimeout(() => (btn.textContent = "复制"), 1200);
	});
}

export const Markdown = memo(function Markdown({ text, className, live }: { text: string; className?: string; live?: boolean }) {
	// While streaming, text changes every frame; the full pipeline costs tens of
	// ms per run, so live steps render escaped text and settle into markdown after.
	const html = useMemo(() => (live ? escapeHtml(text).replace(/\n/g, "<br>") : renderMarkdown(text)), [text, live]);
	return <div className={`md ${className ?? ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
