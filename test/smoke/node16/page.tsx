// Part of `npm run smoke:pack`: type-checked, never run. The React entry, from a CommonJS and from an ESM package.

import { ChatThread, DEFAULT_LABELS, useChatThread, type ChatLabels } from "chaperone-chat/react";

const labels: Partial<ChatLabels> = { send: "Envoyer", talkingWith: (a) => `Avec ${a.join(", ")}` };

export function Page() {
  return <ChatThread endpoint="/api/chat" labels={labels} className="mine" />;
}
export function Custom() {
  const { state, send } = useChatThread({ endpoint: "/api/chat", pollMs: 5_000 });
  return <button onClick={() => void send("hi")}>{state.status === "ready" ? DEFAULT_LABELS.send : "…"}</button>;
}
