import { memoryStore } from "../../src/store/memory";
import { storeConformance } from "./conformance";

storeConformance("memoryStore", async () => {
  let now = new Date("2026-03-01T12:00:00.000Z").getTime();
  return {
    store: memoryStore({ clock: () => new Date(now) }),
    async advance(ms) {
      now += ms;
    },
  };
});
