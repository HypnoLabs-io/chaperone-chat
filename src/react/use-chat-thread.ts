/**
 * The conversation as React state: a browser client (`chaperone-chat/client`) made once on the client side, polling
 * while the page is visible, read through `useSyncExternalStore`. Server rendering sees the loading state, so the
 * first render in the browser matches it.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createChatClient,
  type ChatClient,
  type ClientState,
  type ResolveOutcome,
  type SendOutcome,
} from "../client";

export interface UseChatThreadOptions {
  /** The handler's URL. Not needed with `client`. */
  endpoint?: string;
  /** The participant's token. Default: from the URL fragment, then session storage. */
  token?: string | null;
  storageKey?: string;
  pollMs?: number;
  fetch?: typeof fetch;
  /** A client you made yourself; the hook then uses it as is. */
  client?: ChatClient;
}

export interface ChatThreadApi {
  state: ClientState;
  send(text: string): Promise<SendOutcome>;
  appeal(text: string): Promise<SendOutcome>;
  resolve(outcome: string): Promise<ResolveOutcome>;
  refresh(full?: boolean): Promise<void>;
}

const LOADING: ClientState = {
  status: "idle",
  conversation: null,
  you: null,
  participants: [],
  messages: [],
  hasOlder: false,
  maxChars: null,
  outcomes: [],
  voted: [],
  error: null,
};

const noClient = (): Promise<never> => Promise.reject(new Error("the conversation hasn't loaded yet"));

export function useChatThread(options: UseChatThreadOptions): ChatThreadApi {
  const [client, setClient] = useState<ChatClient | null>(options.client ?? null);
  // A fetch passed inline is a new function each render: read it through a ref so it doesn't remake the client.
  const fetchRef = useRef(options.fetch);
  fetchRef.current = options.fetch;

  useEffect(() => {
    if (options.client) {
      setClient(options.client);
      return;
    }
    if (!options.endpoint) return;
    const made = createChatClient({
      endpoint: options.endpoint,
      ...(options.token !== undefined ? { token: options.token } : {}),
      storageKey: options.storageKey,
      pollMs: options.pollMs,
      fetch: (input, init) => (fetchRef.current ?? globalThis.fetch)(input, init),
    });
    setClient(made);
    return () => made.stop();
  }, [options.client, options.endpoint, options.token, options.storageKey, options.pollMs]);

  const subscribe = useCallback((onChange: () => void) => (client ? client.subscribe(() => onChange()) : () => {}), [client]);
  const state = useSyncExternalStore(
    subscribe,
    () => client?.getState() ?? LOADING,
    () => LOADING,
  );

  return {
    state,
    send: (text) => (client ? client.send(text) : noClient()),
    appeal: (text) => (client ? client.appeal(text) : noClient()),
    resolve: (outcome) => (client ? client.resolve(outcome) : noClient()),
    refresh: (full) => (client ? client.refresh(full) : Promise.resolve()),
  };
}
