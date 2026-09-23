export type SessionFile = { name: string; mediaType: string; path: string };
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

  push(input: { id: string; from: Side; text: string; files: SessionFile[] }): SessionEvent {
    const row: SessionEvent = { seq: ++this.seq, at: new Date().toISOString(), ...input };
    this.events.push(row);
    return row;
  }
}
