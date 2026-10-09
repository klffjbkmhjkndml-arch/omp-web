// End-to-end gateway check: create session → attach → prompt → wait for prompt_result → reopen from index.
const base = `http://127.0.0.1:${process.env.OMP_WEB_PORT ?? 30191}`;
const cwd = `${import.meta.dir}/../.data/sandbox`;
const created = await (await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ cwd }) })).json();
console.log("created", created);
const ws = new WebSocket(base.replace("http", "ws") + "/ws");
const seen: Record<string, number> = {};
let done!: () => void;
const finished = new Promise<void>(r => (done = r));
ws.onmessage = ev => {
  const m = JSON.parse(String(ev.data));
  const k = m.t === "frame" ? `frame:${m.frame.type}` : m.t;
  seen[k] = (seen[k] ?? 0) + 1;
  if (m.t === "snapshot") {
    console.log("snapshot msgs", m.messages.length, "model", m.state.model?.id, "file", m.state.sessionFile);
    ws.send(JSON.stringify({ t: "rpc", key: created.key, rid: "r1", cmd: { type: "prompt", message: "只回复两个字：你好" } }));
  }
  if (m.t === "rpc_res") console.log("rpc_res", m);
  if (m.t === "frame" && m.frame.type === "message_update" && seen[k] === 1) console.log("delta sample", JSON.stringify(m.frame).slice(0, 300));
  if (m.t === "frame" && m.frame.type === "prompt_result") setTimeout(done, 800);
};
ws.onopen = () => ws.send(JSON.stringify({ t: "attach", key: created.key }));
setTimeout(() => { console.log("TIMEOUT"); done(); }, 60000);
await finished;
console.log("seen", seen);
const index = await (await fetch(`${base}/api/index`)).json();
console.log("projects", index.projects.map((p: any) => `${p.name}:${p.sessionCount}`).join(", "));
console.log("sessions", index.sessions.slice(0, 3).map((s: any) => `${s.title} [${s.live}]`));
ws.close();
