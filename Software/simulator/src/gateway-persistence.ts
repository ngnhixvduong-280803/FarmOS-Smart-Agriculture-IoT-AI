import fs from "node:fs";
import path from "node:path";

export type OutboundKind = "telemetry" | "status" | "ack";

export interface OutboundMessage {
  id: string;
  kind: OutboundKind;
  topic: string;
  payload: string;
  qos: 1;
  retain: boolean;
  createdAt: string;
  attempts: number;
}

export interface CompletedCommand {
  commandId: string;
  zoneId: string;
  status: "COMPLETED" | "FAILED";
  measuredFlowLiters: number;
  errorCode: number;
  completedAt: string;
}

export interface InterruptedCommand {
  commandId: string;
  zoneId: string;
}

interface PersistedGatewayState {
  version: 1;
  outbox: OutboundMessage[];
  completedCommands: CompletedCommand[];
  interruptedCommands: InterruptedCommand[];
}

const EMPTY_STATE: PersistedGatewayState = {
  version: 1,
  outbox: [],
  completedCommands: [],
  interruptedCommands: [],
};

/**
 * A small file-backed model of the ESP32 NVS/flash outbox.
 *
 * The file is intentionally local to the simulator and contains delivery state,
 * never passwords or certificate material. Atomic writes make a process reset
 * behave like an ESP32 reboot: an unacknowledged MQTT message remains queued.
 */
export class GatewayPersistence {
  private state: PersistedGatewayState;

  constructor(
    private readonly filePath: string,
    private readonly maxQueuedMessages: number,
    private readonly maxCompletedCommands = 256,
  ) {
    this.state = this.load();
  }

  get outboxDepth(): number {
    return this.state.outbox.length;
  }

  getInterruptedCommands(): InterruptedCommand[] {
    const commands = [...this.state.interruptedCommands];
    if (commands.length > 0) {
      this.state.interruptedCommands = [];
      this.persist();
    }
    return commands;
  }

  markCommandExecuting(commandId: string, zoneId: string): void {
    if (!this.state.interruptedCommands.some((command) => command.commandId === commandId)) {
      this.state.interruptedCommands.push({ commandId, zoneId });
      this.persist();
    }
  }

  getCompletedCommand(commandId: string): CompletedCommand | undefined {
    return this.state.completedCommands.find((command) => command.commandId === commandId);
  }

  completeCommand(command: CompletedCommand): void {
    this.state.interruptedCommands = this.state.interruptedCommands.filter((entry) => entry.commandId !== command.commandId);
    this.state.completedCommands = [
      command,
      ...this.state.completedCommands.filter((entry) => entry.commandId !== command.commandId),
    ].slice(0, this.maxCompletedCommands);
    this.persist();
  }

  enqueue(message: OutboundMessage): { accepted: boolean; dropped?: OutboundKind } {
    const removable = this.findRemovableMessage(message.kind);
    if (this.state.outbox.length >= this.maxQueuedMessages && removable === -1) {
      // ACKs are the only class which may exceed the normal telemetry budget.
      // They close a server-side safety command and must not be silently lost.
      if (message.kind !== "ack") return { accepted: false };
    } else if (removable >= 0 && this.state.outbox.length >= this.maxQueuedMessages) {
      const [dropped] = this.state.outbox.splice(removable, 1);
      this.state.outbox.push(message);
      this.persist();
      return { accepted: true, dropped: dropped.kind };
    }

    this.state.outbox.push(message);
    this.persist();
    return { accepted: true };
  }

  peek(): OutboundMessage | undefined {
    return this.state.outbox[0];
  }

  acknowledge(messageId: string): void {
    if (this.state.outbox[0]?.id === messageId) {
      this.state.outbox.shift();
    } else {
      this.state.outbox = this.state.outbox.filter((message) => message.id !== messageId);
    }
    this.persist();
  }

  markAttempt(messageId: string): void {
    const message = this.state.outbox.find((entry) => entry.id === messageId);
    if (message) {
      message.attempts += 1;
      this.persist();
    }
  }

  private findRemovableMessage(incomingKind: OutboundKind): number {
    if (incomingKind === "telemetry") {
      return this.state.outbox.findIndex((message) => message.kind === "telemetry");
    }

    const telemetry = this.state.outbox.findIndex((message) => message.kind === "telemetry");
    if (telemetry >= 0) return telemetry;
    if (incomingKind === "status") {
      return this.state.outbox.findIndex((message) => message.kind === "status");
    }
    return this.state.outbox.findIndex((message) => message.kind === "status");
  }

  private load(): PersistedGatewayState {
    try {
      if (!fs.existsSync(this.filePath)) return structuredClone(EMPTY_STATE);
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.outbox) || !Array.isArray(parsed.completedCommands)) {
        throw new Error("invalid state shape");
      }
      return {
        version: 1,
        outbox: parsed.outbox,
        completedCommands: parsed.completedCommands,
        interruptedCommands: Array.isArray(parsed.interruptedCommands)
          ? parsed.interruptedCommands.filter((entry: unknown): entry is InterruptedCommand =>
              Boolean(entry) && typeof entry === "object" &&
              typeof (entry as InterruptedCommand).commandId === "string" &&
              typeof (entry as InterruptedCommand).zoneId === "string",
            )
          : [],
      };
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        // The state will start empty if the corrupt file cannot be renamed.
      }
      console.warn("[GATEWAY OUTBOX] State file was invalid; started an empty queue:", error);
      return structuredClone(EMPTY_STATE);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}
