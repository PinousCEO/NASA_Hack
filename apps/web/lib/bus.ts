/** Hand-off between panels that are not mounted at the same time. */
type Listener = (value: unknown) => void;
const last = new Map<string, unknown>();
const listeners = new Map<string, Set<Listener>>();

export const bus = {
  /** Publish a value; it is also kept for a panel that mounts later. */
  send(topic: string, value: unknown): void {
    last.set(topic, value);
    for (const l of listeners.get(topic) ?? []) l(value);
  },
  /** Take the kept value (once) and listen for new ones. Returns the unsubscribe function. */
  listen(topic: string, listener: Listener): () => void {
    if (last.has(topic)) {
      listener(last.get(topic));
      last.delete(topic);
    }
    let set = listeners.get(topic);
    if (!set) listeners.set(topic, (set = new Set()));
    set.add(listener);
    return () => void set!.delete(listener);
  },
};
