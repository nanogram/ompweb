import { isMessageOverflowing } from "../message-overflow";

type Measurement = { element: HTMLElement; publish: (overflow: boolean) => void; active: boolean };
const pending = new Map<HTMLElement, Measurement>();
let frame: number | null = null;

/** One read phase for all capped messages, then publish updates without reflow. */
export function scheduleMessageOverflow(element: HTMLElement, publish: (overflow: boolean) => void): () => void {
  const measurement = { element, publish, active: true };
  const previous = pending.get(element);
  if (previous) previous.active = false;
  pending.set(element, measurement);
  if (frame === null) {
    frame = requestAnimationFrame(() => {
      frame = null;
      const batch = Array.from(pending.values());
      pending.clear();
      const values = batch.map(({ element }) => element.isConnected && isMessageOverflowing(element));
      batch.forEach((entry, index) => {
        if (entry.active && entry.element.isConnected) entry.publish(values[index]);
      });
    });
  }
  return () => {
    measurement.active = false;
    if (pending.get(element) === measurement) pending.delete(element);
    if (pending.size === 0 && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
