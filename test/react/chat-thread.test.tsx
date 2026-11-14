// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChat, memoryStore, type Chat } from "../../src";
import { createChatClient } from "../../src/client";
import { createChatHandler } from "../../src/http";
import { ChatThread, useChatThread } from "../../src/react";

const SECRET = "test-secret-0123456789-0123456789";

let chat: Chat;
let tokens: [string, string];

/** Jev's network: 0.3 (the review band of the built-in policy) for one sentence, 0.05 for anything else. */
const fakeJev = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const latest = body.state.conversation.at(-1).text as string;
  const p = latest === "Shall we move to the photo app?" ? 0.3 : 0.05;
  const answers = Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: "noul", noul: p }]));
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers }));
}) as typeof fetch;

/** The component's fetch, answered by the real handler. */
function fetchFor(c: Chat) {
  const handle = createChatHandler(c);
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handle(new Request(new URL(String(input), "http://chat.test"), init))) as typeof fetch;
}

beforeEach(async () => {
  chat = createChat({ secret: SECRET, store: memoryStore(), jev: { apiKey: "k", fetch: fakeJev } });
  const opened = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
  tokens = [opened.links[0]!.token, opened.links[1]!.token];
});

afterEach(() => cleanup());

const thread = (token: string, extra: Partial<Parameters<typeof ChatThread>[0]> = {}) => (
  <ChatThread endpoint="/api/chat" token={token} fetch={fetchFor(chat)} {...extra} />
);

function typeAndSend(text: string) {
  fireEvent.change(screen.getByLabelText("Your message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("<ChatThread>", () => {
  it("shows that it's loading, then who you're talking with and the time left", async () => {
    render(thread(tokens[0]));
    expect(screen.getByRole("status").textContent).toBe("Loading the conversation…");
    expect(await screen.findByText("Talking with Seller")).toBeTruthy();
    expect(screen.getByText("7 days left.")).toBeTruthy();
    expect(screen.getByText("No messages yet. Say hello.")).toBeTruthy();
  });

  it("sends a message and shows it as yours", async () => {
    render(thread(tokens[0]));
    await screen.findByText("Talking with Seller");
    typeAndSend("Is the desk still available?");
    // A controlled textarea carries its value as text too, so look in the list, not the whole page.
    const list = await screen.findByRole("list", { name: "Messages" });
    const sent = within(list).getByText("Is the desk still available?");
    expect(sent.closest("li")!.className).toContain("cc-message--mine");
    expect(sent.closest("li")!.textContent).toContain("You:");
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("");
  });

  it("sends with Ctrl+Enter", async () => {
    render(thread(tokens[0]));
    await screen.findByText("Talking with Seller");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Quick one." } });
    fireEvent.keyDown(screen.getByLabelText("Your message"), { key: "Enter", ctrlKey: true });
    expect(await screen.findByText("Quick one.")).toBeTruthy();
  });

  it("says why a message was refused, keeping the text to fix", async () => {
    render(thread(tokens[0]));
    await screen.findByText("Talking with Seller");
    typeAndSend("call me on 312 555 0142");
    expect((await screen.findByRole("alert")).textContent).toContain("That looks like a phone number.");
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("call me on 312 555 0142");
    expect(screen.queryByRole("button", { name: /quick check/ })).toBeNull();
  });

  it("offers a review for an appealable refusal, and shows the held message with its note", async () => {
    render(thread(tokens[0]));
    await screen.findByText("Talking with Seller");
    typeAndSend("Shall we move to the photo app?");
    expect((await screen.findByRole("alert")).textContent).toContain("That looks like a way to get in touch outside this chat.");
    fireEvent.click(screen.getByRole("button", { name: /send it for a quick check/ }));
    expect(await screen.findByText("Sent for a quick check. It goes through once it passes.")).toBeTruthy();
    const held = screen.getByText("Shall we move to the photo app?").closest("li")!;
    expect(held.className).toContain("cc-message--pending");
    expect(held.textContent).toContain("Waiting for a quick check before it's sent.");
  });

  it("asks before choosing an outcome, then shows the conversation closed", async () => {
    render(thread(tokens[0]));
    await screen.findByText("Talking with Seller");
    fireEvent.click(screen.getByRole("button", { name: "End the conversation" }));
    expect(screen.getByText("End this conversation for everyone?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(screen.queryByText("End this conversation for everyone?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "End the conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, end it" }));
    expect(await screen.findByText("This conversation has closed.")).toBeTruthy();
    expect(screen.queryByLabelText("Your message")).toBeNull();
  });

  it("shows the other side's messages under their alias", async () => {
    await chat.send((await chat.verify(tokens[1]).then((v) => (v.ok ? v.participantId : ""))) as string, "Yes, still here.");
    render(thread(tokens[0]));
    const theirs = await screen.findByText("Yes, still here.");
    const li = theirs.closest("li")!;
    expect(li.className).not.toContain("cc-message--mine");
    expect(li.textContent).toContain("Seller ·");
  });

  it("takes every word from labels", async () => {
    render(
      thread(tokens[0], {
        labels: {
          loading: "Chargement…",
          talkingWith: (a) => `Avec ${a.join(", ")}`,
          send: "Envoyer",
          messageLabel: "Votre message",
          timeLeft: () => "bientôt",
        },
      }),
    );
    expect(screen.getByRole("status").textContent).toBe("Chargement…");
    expect(await screen.findByText("Avec Seller")).toBeTruthy();
    expect(screen.getByText("bientôt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Envoyer" })).toBeTruthy();
    expect(screen.getByLabelText("Votre message")).toBeTruthy();
  });

  it("says why when the link doesn't work", async () => {
    render(thread("not-a-real.token"));
    expect((await screen.findByRole("alert")).textContent).toBe("This link doesn't work.");
  });

  it("says the link doesn't work when there's no token at all, without asking the server", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch;
    render(<ChatThread endpoint="/api/chat" token={null} fetch={counting} />);
    expect((await screen.findByRole("alert")).textContent).toBe("This link doesn't work.");
    expect(calls).toBe(0);
  });

  it("waits for everyone on an outcome that needs all of them, and won't take the same choice twice", async () => {
    chat = createChat({ secret: SECRET, store: memoryStore(), jev: false, outcomes: { agreed: { by: "*", requires: "all" } } });
    const opened = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
    render(thread(opened.links[0]!.token));
    await screen.findByText("Talking with Seller");
    fireEvent.click(screen.getByRole("button", { name: "agreed" }));
    expect(screen.getByText('Choose "agreed"?')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(await screen.findByText("Waiting for Seller to choose it too.")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "agreed" }) as HTMLButtonElement).disabled).toBe(true));
    // Still open: the composer stays.
    expect(screen.getByLabelText("Your message")).toBeTruthy();
  });
});

describe("useChatThread", () => {
  function Probe({ token }: { token: string }) {
    const { state, send } = useChatThread({ endpoint: "/api/chat", token, fetch: fetchFor(chat) });
    return (
      <div>
        <p data-testid="status">{state.status}</p>
        <p data-testid="count">{state.messages.length}</p>
        <button type="button" onClick={() => void send("From the hook.")}>
          go
        </button>
      </div>
    );
  }

  it("gives the conversation as state, and sends", async () => {
    render(<Probe token={tokens[0]} />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "go" }));
    });
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
  });

  it("uses a client you made yourself", async () => {
    const client = createChatClient({ endpoint: "/api/chat", token: tokens[0], fetch: fetchFor(chat) });
    render(<ChatThread client={client} />);
    expect(await screen.findByText("Talking with Seller")).toBeTruthy();
    expect(client.getState().status).toBe("ready");
    client.stop();
  });
});
