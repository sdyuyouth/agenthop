import { randomUUID } from "node:crypto";
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { collectAnswer } from "./files.js";

export class HopExecutor implements AgentExecutor {
  constructor(private readonly root?: string) {}

  cancelTask = async (): Promise<void> => undefined;

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const userText = textOf(requestContext.userMessage);
    const answer = await collectAnswer(this.root, userText);
    const [first, second] = split(answer);
    const task: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: {},
    };
    eventBus.publish(AgentEvent.task(task));
    eventBus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_WORKING, first)));
    if (second) eventBus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_WORKING, second)));
    eventBus.publish(AgentEvent.artifactUpdate(artifact(taskId, contextId, answer)));
    eventBus.publish(AgentEvent.statusUpdate(status(taskId, contextId, TaskState.TASK_STATE_COMPLETED)));
  }
}

export function textOf(message: Message): string {
  const parts = message.parts ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    const content = part.content as { $case?: string; value?: string } | undefined;
    if (content?.$case === "text" && content.value) chunks.push(content.value);
  }
  return chunks.join("");
}

function split(text: string): [string, string] {
  if (text.length < 2) return [text, ""];
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

function textPart(value: string): NonNullable<Message["parts"]>[number] {
  return {
    content: { $case: "text", value },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

function status(taskId: string, contextId: string, state: TaskState, text?: string): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId,
    metadata: {},
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: text
        ? {
            role: Role.ROLE_AGENT,
            messageId: randomUUID(),
            taskId,
            contextId,
            parts: [textPart(text)],
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          }
        : undefined,
    },
  };
}

function artifact(taskId: string, contextId: string, text: string): TaskArtifactUpdateEvent {
  const body: Artifact = {
    artifactId: randomUUID(),
    name: "Result",
    description: "",
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
  };
  return { taskId, contextId, artifact: body, append: false, lastChunk: true, metadata: {} };
}
