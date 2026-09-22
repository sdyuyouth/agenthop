import {
  TaskState,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { messageFromParts, type HopMessage } from "./message.js";

export type Incoming = {
  id: string;
  contextId: string;
  message: HopMessage;
};

/** Records the incoming message and leaves the task working until the local agent answers. */
export class HopExecutor implements AgentExecutor {
  constructor(private readonly onIncoming: (incoming: Incoming) => Promise<void> | void) {}

  cancelTask = async (): Promise<void> => undefined;

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    await this.onIncoming({
      id: taskId,
      contextId,
      message: messageFromParts(requestContext.userMessage.parts),
    });
    const task: Task = {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_WORKING,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: {},
    };
    eventBus.publish(AgentEvent.task(task));
  }
}

export function textOf(message: Message): string {
  return messageFromParts(message.parts).text;
}
