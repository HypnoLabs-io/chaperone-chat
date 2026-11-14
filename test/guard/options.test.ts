import { describe, expect, it } from "vitest";
import {
  APP_GROUPS,
  CONTACT_KINDS,
  createGuard,
  createRules,
  isChaperoneError,
  kindsOf,
  type Locale,
  type Region,
} from "../../src/guard";

const kinds = (rules: ReturnType<typeof createRules>, text: string) => kindsOf(rules.find(text));

describe("kinds", () => {
  it.each(CONTACT_KINDS)("turning %s off drops it and nothing else", (kind) => {
    const samples: Record<string, string> = {
      email: "dana@gmail.com",
      phone: "312-555-0142",
      link: "danadesigns.com",
      handle: "@dana.designs",
      address: "123 Main St",
      app: "I take venmo",
      ask: "text me",
    };
    const off = createRules({ kinds: { [kind]: false } });
    for (const [k, text] of Object.entries(samples)) {
      expect(kinds(off, text)).toEqual(k === kind ? [] : [k]);
    }
  });
});

describe("app groups", () => {
  const byGroup: Record<(typeof APP_GROUPS)[number], string> = {
    messaging: "message me on WhatsApp",
    payments: "Cash or Venmo is fine.",
    scheduling: "Book a slot on my Calendly.",
    marketplaces: "I'm also on Thumbtack.",
    meetings: "Google Meet is easiest for me.",
  };

  it.each(APP_GROUPS)("turning %s off passes its names and keeps the others", (group) => {
    const rules = createRules({ apps: { groups: { [group]: false } }, kinds: { ask: false } });
    for (const [g, text] of Object.entries(byGroup)) {
      expect(kinds(rules, text)).toEqual(g === group ? [] : ["app"]);
    }
  });

  it("refuses the host's extra names, whole words only", () => {
    const rules = createRules({ apps: { extra: ["Acme Pay", "Quickchat"] } });
    expect(kinds(rules, "Send it on acme  pay.")).toEqual(["app"]);
    expect(kinds(rules, "quickchat?")).toEqual(["app"]);
    expect(rules.find("The quickchatter is here.")).toEqual([]);
  });

  it("passes an allowed name wherever it appears, in an app or an ask", () => {
    const rules = createRules({ apps: { allow: ["Venmo"] } });
    expect(rules.find("Cash or Venmo is fine.")).toEqual([]);
    expect(rules.find("venmo me")).toEqual([]);
    expect(kinds(rules, "zelle works")).toEqual(["app"]);
    expect(kinds(rules, "text me")).toEqual(["ask"]);
  });
});

describe("domains", () => {
  it("passes a link to the host's own domain or a subdomain of it, and nothing else", () => {
    const rules = createRules({ domains: { allow: ["acme.com"] } });
    for (const text of ["https://acme.com/listing/42", "www.acme.com", "shop.acme.com/item", "acme dot com"]) {
      expect(rules.find(text)).toEqual([]);
    }
    for (const text of ["notacme.com", "acme.com.evil.io", "danadesigns.com"]) expect(kinds(rules, text)).toEqual(["link"]);
  });

  it("still refuses an email at the host's domain", () => {
    expect(kinds(createRules({ domains: { allow: ["acme.com"] } }), "dana@acme.com")).toContain("email");
  });

  it("reads extra top-level domains", () => {
    expect(createRules().find("danadesigns.dev")).toEqual([]);
    expect(kinds(createRules({ domains: { extraTlds: [".dev"] } }), "danadesigns.dev")).toEqual(["link"]);
  });
});

describe("platform names", () => {
  it("make moving off the host an ask, like moving off the app", () => {
    const plain = createRules();
    const named = createRules({ platformNames: ["Acme Market"] });
    expect(plain.find("Easier to just talk off Acme Market.")).toEqual([]);
    expect(kinds(named, "Easier to just talk off Acme Market.")).toEqual(["ask"]);
    expect(kinds(named, "Hablemos fuera de acme market.")).toEqual(["ask"]);
    expect(kinds(plain, "can we talk outside the app")).toEqual(["ask"]);
  });

  it("are escaped: a name with regex characters is matched as written", () => {
    const named = createRules({ platformNames: ["A+B (beta)"] });
    expect(kinds(named, "let's go off A+B (beta)")).toEqual(["ask"]);
    expect(named.find("let's go off AAB beta")).toEqual([]);
  });
});

describe("streets", () => {
  it("read named streets after a house number only when listed", () => {
    expect(createRules().find("1600 Broadway")).toEqual([]);
    expect(kinds(createRules({ streets: { named: ["Broadway"] } }), "1600 Broadway")).toEqual(["address"]);
  });
});

describe("custom detectors", () => {
  it("run with the built-in ones, with their own check", () => {
    const rules = createRules({
      custom: [{ kind: "handle", pattern: /\bmember-\d{3,8}\b/i, keep: (m) => !m[0].endsWith("000") }],
    });
    expect(kinds(rules, "I'm member-4821 there.")).toEqual(["handle"]);
    expect(rules.find("member-1000 is the demo account.")).toEqual([]);
    const spans = rules.find("I'm member-4821 there.");
    expect(spans[0]).toEqual({ kind: "handle", start: 4, end: 15 });
  });

  it("refuse an unknown kind", () => {
    let error: unknown;
    try {
      createRules({ custom: [{ kind: "fax" as never, pattern: /x/ }] });
    } catch (e) {
      error = e;
    }
    expect(isChaperoneError(error, "invalid_option")).toBe(true);
  });
});

describe("locales and regions", () => {
  it("read only the languages chosen", () => {
    const en = createRules({ locales: ["en"] });
    expect(en.find("llámame")).toEqual([]);
    expect(kinds(en, "call me tomorrow")).toEqual(["ask"]);
    const es = createRules({ locales: ["es"] });
    expect(es.find("call me tomorrow")).toEqual([]);
    expect(kinds(es, "llámame")).toEqual(["ask"]);
    expect(kinds(es, "tres uno dos cinco cinco cinco cero uno cuatro dos")).toEqual(["phone"]);
    expect(es.find("three one two five five five zero one four two")).toEqual([]);
  });

  it("take a locale of your own", () => {
    const fr: Locale = {
      id: "fr",
      digitWords: { zéro: "0", un: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six: "6", sept: "7", huit: "8", neuf: "9" },
      atWords: ["arobase"],
      dotWords: ["point"],
      asks: () => [/\bappelle[\s-]{1,3}moi\b/gi],
    };
    const rules = createRules({ locales: ["en", fr] });
    expect(kinds(rules, "dana arobase gmail point com")[0]).toBe("email");
    expect(kinds(rules, "appelle-moi")).toEqual(["ask"]);
  });

  it("drop the US formats with no region, keeping international and long numbers", () => {
    const none = createRules({ region: null });
    expect(none.find("555-0142")).toEqual([]);
    expect(none.find("123 Main St")).toEqual([]);
    expect(kinds(none, "+44 20 7946 0958")).toEqual(["phone"]);
    expect(kinds(none, "3125550142")).toEqual(["phone"]);
  });

  it("take a region of your own, with its own idea of a full phone", () => {
    const uk: Region = {
      id: "uk",
      detectors: [{ kind: "phone", re: /(?<!\d)0\d{4}\s{0,3}\d{6}(?!\d)/g }],
      isFullPhone: (m) => m.replace(/\D/g, "").length >= 11,
    };
    const rules = createRules({ region: uk });
    expect(kinds(rules, "Ring 01632 960983.")[0]).toBe("phone");
    const guard = createGuard({ region: uk });
    expect(guard.windowKinds(["01632"], "960983")).toEqual(["phone"]);
  });

  it("refuse an unknown built-in name", () => {
    for (const options of [{ locales: ["xx" as never] }, { region: "zz" as never }]) {
      let error: unknown;
      try {
        createRules(options);
      } catch (e) {
        error = e;
      }
      expect(isChaperoneError(error, "invalid_option")).toBe(true);
    }
  });
});

describe("reasons", () => {
  it("say what was found, in the host's words when given", async () => {
    expect((await createGuard().block("text me"))?.reason).toBe("That asks to move the conversation elsewhere.");
    const guard = createGuard({ reasons: { ask: "Keep it in the chat, please." } });
    expect(await guard.block("text me")).toEqual({ kind: "ask", reason: "Keep it in the chat, please.", scrubberId: "rules" });
  });
});
