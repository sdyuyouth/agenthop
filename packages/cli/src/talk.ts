export type SessionFile = { name: string; mediaType: string; path: string };
export type Side = "host" | "peer";
export type SessionEventName = "queued" | "current" | "supplement" | "said" | "done";

export type SessionEvent = {
  seq: number;
  at: string;
  event: SessionEventName;
  id: string;
  kind: "say" | "ask" | "supplement" | "result";
  from: Side;
  text: string;
  files: SessionFile[];
  current: string | null;
  pending: string[];
};

type Item = {
  id: string;
  kind: "say" | "ask";
  from: Side;
  text: string;
  files: SessionFile[];
  state: "pending" | "current" | "done";
  result?: { text: string; files: SessionFile[]; from: Side };
};

/** One ordered queue. Only the head ask is in progress. Later messages wait behind it. */
export class Talk {
  private readonly items: Item[] = [];
  private readonly events: SessionEvent[] = [];
  private seq = 0;

  snapshot(): { current: string | null; pending: string[] } {
    return {
      current: this.items.find((item) => item.state === "current")?.id ?? null,
      pending: this.items.filter((item) => item.state === "pending").map((item) => item.id),
    };
  }

  since(seq: number): SessionEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  item(id: string): { state: Item["state"]; result?: Item["result"] } | undefined {
    const found = this.items.find((item) => item.id === id);
    if (!found) return undefined;
    return { state: found.state, result: found.result };
  }

  push(input: { id: string; kind: "say" | "ask"; from: Side; text: string; files: SessionFile[] }): SessionEvent {
    const blocking = this.items.some((item) => item.state === "current");
    this.items.push({ ...input, state: "pending" });
    if (blocking) return this.emit("queued", input);
    const delivered = this.drain();
    return delivered[delivered.length - 1]!;
  }

  supplement(input: { id: string; from: Side; text: string; files: SessionFile[] }): SessionEvent {
    const current = this.items.find((item) => item.state === "current");
    if (!current || current.kind !== "ask") throw new Error("no current task");
    return this.emit("supplement", { ...input, kind: "supplement" });
  }

  answer(id: string, result: { from: Side; text: string; files: SessionFile[] }): SessionEvent {
    const current = this.items.find((item) => item.state === "current");
    if (!current || current.kind !== "ask" || current.id !== id) throw new Error(`not the current task ${id}`);
    current.state = "done";
    current.result = result;
    const done = this.emit("done", { id, kind: "result", from: result.from, text: result.text, files: result.files });
    this.drain();
    return done;
  }

  private drain(): SessionEvent[] {
    const delivered: SessionEvent[] = [];
    for (const item of this.items) {
      if (item.state !== "pending") continue;
      if (item.kind === "say") {
        item.state = "done";
        delivered.push(this.emit("said", item));
        continue;
      }
      item.state = "current";
      delivered.push(this.emit("current", item));
      break;
    }
    return delivered;
  }

  private emit(
    event: SessionEventName,
    item: { id: string; kind: SessionEvent["kind"]; from: Side; text: string; files: SessionFile[] },
  ): SessionEvent {
    const row: SessionEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      event,
      id: item.id,
      kind: item.kind,
      from: item.from,
      text: item.text,
      files: item.files,
      ...this.snapshot(),
    };
    this.events.push(row);
    return row;
  }
}
