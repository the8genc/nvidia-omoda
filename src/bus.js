// The platform event bus: what the demo app watches.
//
// Three topics, deliberately few:
//   frame        raw video frames relayed from COCO's rgb-stream
//   observation  COCO descriptions plus OMODA's judgment of each
//   agent        every ledgered action: broker admits and refusals, judge
//                verdicts, escalations, decisions, gateway calls
//
// Subscribers are synchronous and isolated: one slow or throwing subscriber
// never stalls the publisher, because the publisher IS the live platform.

export const TOPICS = Object.freeze(["frame", "observation", "agent"]);

export function createBus() {
  const subs = new Map(TOPICS.map((t) => [t, new Set()]));
  let published = 0;

  return {
    publish(topic, event) {
      const set = subs.get(topic);
      if (!set) throw new Error(`unknown bus topic "${topic}"`);
      published += 1;
      const enveloped = { topic, at: new Date().toISOString(), ...event };
      for (const fn of set) {
        try { fn(enveloped); } catch { /* a broken subscriber is its own problem */ }
      }
      return enveloped;
    },
    subscribe(topic, fn) {
      const set = subs.get(topic);
      if (!set) throw new Error(`unknown bus topic "${topic}"`);
      set.add(fn);
      return () => set.delete(fn);
    },
    stats() {
      return { published, subscribers: Object.fromEntries(TOPICS.map((t) => [t, subs.get(t).size])) };
    },
  };
}
