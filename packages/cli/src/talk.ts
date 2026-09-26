/**
 * A file as the log knows it. `data` is only there on a file this side sends: the sealed bytes,
 * base64, which is how they reach the joining side — it reads the room over the relay and has
 * no other way to fetch them.
 */
export type SessionFile = { name: string; mediaType: string; path: string; data?: string };
export type Side = "host" | "peer";

export type SessionEvent = {
  seq: number;
  at: string;
  id: string;
  from: Side;
  text: string;
  files: SessionFile[];
};

/** One ordered log of what both sides said. The joining side reads it back over the relay. */
export class Talk {
  private readonly events: SessionEvent[] = [];
  private seq = 0;

  since(seq: number): SessionEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  /** The seq of the newest line, or 0. */
  latest(): number {
    return this.seq;
  }

  push(input: { id: string; from: Side; text: string; files: SessionFile[] }): SessionEvent {
    const row: SessionEvent = { seq: ++this.seq, at: new Date().toISOString(), ...input };
    this.events.push(row);
    return row;
  }
}
