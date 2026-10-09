import { useEffect } from "react";
import { Home } from "./components/Home.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { app, useApp } from "./lib/app-store.ts";
import { Icon } from "./lib/icons.tsx";
import { useSession } from "./lib/app-store.ts";
import { gateway } from "./lib/ws.ts";

gateway.connect();
void app.refreshIndex();

export function App() {
	const a = useApp();
	useEffect(() => {
		const t = setInterval(() => void app.refreshIndex(), 30_000);
		return () => clearInterval(t);
	}, []);
	return (
		<div className={`app ${a.prefs.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
			<Sidebar />
			{a.route ? <SessionView key={a.route} sessionKey={a.route} /> : <Home />}
			{a.route && <Toasts sessionKey={a.route} />}
			<AppToasts />
			<SettingsDialog />
		</div>
	);
}

/** Toasts for actions that are not tied to a session (rename, export, trash). */
function AppToasts() {
	const a = useApp();
	if (a.notices.length === 0) return null;
	return (
		<div className="toasts">
			{a.notices.map(n => (
				<div key={n.id} className={`toast ${n.level}`}>
					<span>{n.text}</span>
					<button className="icon-btn" onClick={() => app.dismiss(n.id)}>
						<Icon name="x" size={13} />
					</button>
				</div>
			))}
		</div>
	);
}

function Toasts({ sessionKey }: { sessionKey: string }) {
	const store = useSession(app.store(sessionKey));
	if (store.notices.length === 0) return null;
	return (
		<div className="toasts">
			{store.notices.map(n => (
				<div key={n.id} className={`toast ${n.level}`}>
					<span>{n.text}</span>
					<button className="icon-btn" onClick={() => store.dismiss(n.id)}>
						<Icon name="x" size={13} />
					</button>
				</div>
			))}
		</div>
	);
}
