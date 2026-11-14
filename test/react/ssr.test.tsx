// Server rendering, in plain Node (no DOM): the component renders its loading state and asks the server for nothing.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../../src/react";

describe("<ChatThread> on the server", () => {
  it("renders the loading state without a window or a request", () => {
    expect(typeof window).toBe("undefined");
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const html = renderToString(<ChatThread endpoint="/api/chat" token="any.token" fetch={counting} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the conversation…");
    expect(html).toContain('class="cc-thread"');
    expect(calls).toBe(0);
  });

  it("renders the loading state with no token, since the fragment is only read in the browser", () => {
    const html = renderToString(<ChatThread endpoint="/api/chat" />);
    expect(html).toContain("Loading the conversation…");
  });
});
