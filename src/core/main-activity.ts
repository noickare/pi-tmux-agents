import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export type MainActivityPhase =
  | "ready"
  | "starting"
  | "reasoning"
  | "responding"
  | "tool"
  | "waiting"
  | "compacting"
  | "continuing"
  | "attention";

export type MainActivityKind =
  | "run"
  | "turn"
  | "reasoning"
  | "response"
  | "tool"
  | "prompt"
  | "compaction"
  | "diagnostic";

export type MainActivityState = "active" | "complete" | "error";

export interface MainActivityEvent {
  id: string;
  at: string;
  kind: MainActivityKind;
  label: string;
  text: string;
  state: MainActivityState;
}

export interface MainActiveTool {
  id: string;
  name: string;
  args: string;
  startedAt: string;
  updatedAt: string;
}

export interface MainPromptActivity {
  kind: "select" | "confirm" | "input" | "editor" | "custom";
  title?: string;
  startedAt: string;
}

export interface MainCompactionActivity {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  startedAt: string;
}

export interface MainActivitySnapshot {
  phase: MainActivityPhase;
  phaseLabel: string;
  current: string;
  startedAt?: string;
  turnIndex?: number;
  activeTools: readonly MainActiveTool[];
  prompt?: MainPromptActivity;
  compaction?: MainCompactionActivity;
  timeline: readonly MainActivityEvent[];
}

interface MutableActivityEvent extends MainActivityEvent {}

const TIMELINE_LIMIT = 80;
const BLOCK_TEXT_LIMIT = 4_000;

export class MainActivityTracker {
  private sequence = 0;
  private agentActive = false;
  private runStartedAt: string | undefined;
  private turnIndex: number | undefined;
  private readonly streamingContent = new Map<string, "reasoning" | "response">();
  private currentDetail = "Pi is ready";
  private attention: string | undefined;
  private prompt: MainPromptActivity | undefined;
  private compaction: MainCompactionActivity | undefined;
  private readonly tools = new Map<string, MainActiveTool>();
  private readonly events: MutableActivityEvent[] = [];
  private readonly contentEvents = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  reset(reason = "session ready"): void {
    this.agentActive = false;
    this.runStartedAt = undefined;
    this.turnIndex = undefined;
    this.streamingContent.clear();
    this.currentDetail = "Pi is ready";
    this.attention = undefined;
    this.prompt = undefined;
    this.compaction = undefined;
    this.tools.clear();
    this.contentEvents.clear();
    this.events.splice(0);
    this.append("run", "session", reason, "complete");
  }

  agentStarted(): void {
    const at = this.timestamp();
    this.agentActive = true;
    this.runStartedAt ??= at;
    this.streamingContent.clear();
    this.attention = undefined;
    this.currentDetail = "Agent run started";
    this.append("run", "agent_start", "Agent run started", "active", at);
  }

  agentEnded(): void {
    this.streamingContent.clear();
    this.currentDetail = "Run ended; waiting for Pi to settle or continue";
    this.append("run", "agent_end", this.currentDetail, "complete");
  }

  agentSettled(): void {
    this.agentActive = false;
    this.runStartedAt = undefined;
    this.turnIndex = undefined;
    this.streamingContent.clear();
    this.attention = undefined;
    this.prompt = undefined;
    this.compaction = undefined;
    this.tools.clear();
    this.contentEvents.clear();
    this.currentDetail = "Pi is ready";
    this.append("run", "agent_settled", "No automatic continuation remains", "complete");
  }

  turnStarted(turnIndex: number, timestamp?: number): void {
    this.turnIndex = turnIndex;
    this.streamingContent.clear();
    this.attention = undefined;
    this.contentEvents.clear();
    this.currentDetail = `Turn ${turnIndex} started`;
    this.append("turn", "turn_start", this.currentDetail, "active", timestamp === undefined ? undefined : new Date(timestamp).toISOString());
  }

  turnEnded(turnIndex: number): void {
    this.streamingContent.clear();
    this.currentDetail = `Turn ${turnIndex} ended`;
    this.append("turn", "turn_end", this.currentDetail, "complete");
  }

  messageUpdated(update: AssistantMessageEvent): void {
    if (update.type === "start") {
      this.streamingContent.clear();
      this.contentEvents.clear();
      return;
    }
    if (update.type === "thinking_start") {
      this.startStreaming("reasoning", update.contentIndex);
      this.attention = undefined;
      this.currentDetail = "Provider reasoning summary is streaming";
      this.startContentEvent("reasoning", update.contentIndex, "reasoning summary");
      return;
    }
    if (update.type === "thinking_delta") {
      this.startStreaming("reasoning", update.contentIndex);
      this.attention = undefined;
      this.currentDetail = "Provider reasoning summary is streaming";
      this.appendContent("reasoning", update.contentIndex, update.delta);
      return;
    }
    if (update.type === "thinking_end") {
      this.finishContent("reasoning", update.contentIndex, update.content);
      this.finishStreaming("reasoning", update.contentIndex, "Reasoning summary completed");
      return;
    }
    if (update.type === "text_start") {
      this.startStreaming("response", update.contentIndex);
      this.attention = undefined;
      this.currentDetail = "Assistant response is streaming";
      this.startContentEvent("response", update.contentIndex, "assistant response");
      return;
    }
    if (update.type === "text_delta") {
      this.startStreaming("response", update.contentIndex);
      this.attention = undefined;
      this.currentDetail = "Assistant response is streaming";
      this.appendContent("response", update.contentIndex, update.delta);
      return;
    }
    if (update.type === "text_end") {
      this.finishContent("response", update.contentIndex, update.content);
      this.finishStreaming("response", update.contentIndex, "Assistant response completed");
    }
  }

  messageEnded(stopReason?: string, errorMessage?: string): void {
    this.streamingContent.clear();
    this.contentEvents.clear();
    if (stopReason === "error") {
      this.attention = errorMessage || "Assistant message ended with an error";
      this.currentDetail = this.attention;
      this.append("diagnostic", "message_error", this.attention, "error");
    }
  }

  toolStarted(id: string, name: string, args: unknown): void {
    const at = this.timestamp();
    const tool = { id, name, args: compactValue(args), startedAt: at, updatedAt: at };
    this.tools.set(id, tool);
    this.streamingContent.clear();
    this.attention = undefined;
    this.currentDetail = `${name} is running`;
    this.append("tool", name, tool.args || "tool started", "active", at, `tool:${id}:start`);
  }

  toolUpdated(id: string): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.set(id, { ...tool, updatedAt: this.timestamp() });
  }

  toolEnded(id: string, name: string, isError: boolean): void {
    this.tools.delete(id);
    if (isError) this.attention = `${name} failed`;
    const activeTool = [...this.tools.values()].at(-1);
    this.currentDetail = activeTool
      ? `${activeTool.name} is running${this.attention ? ` · ${this.attention}` : ""}`
      : this.attention ?? `${name} completed`;
    this.append("tool", name, isError ? "Tool failed" : "Tool completed", isError ? "error" : "complete", undefined, `tool:${id}:end`);
  }

  promptStarted(kind: MainPromptActivity["kind"], title?: string): void {
    const at = this.timestamp();
    this.prompt = { kind, ...(title ? { title } : {}), startedAt: at };
    this.currentDetail = title ? `Waiting for you: ${title}` : `Waiting for a ${kind} response`;
    this.append("prompt", "ui_prompt_start", this.currentDetail, "active", at);
  }

  promptEnded(kind: MainPromptActivity["kind"], title?: string): void {
    this.prompt = undefined;
    const closed = title ? `${title} closed` : `${kind} prompt closed`;
    this.append("prompt", "ui_prompt_end", closed, "complete");
    const activeTool = [...this.tools.values()].at(-1);
    this.currentDetail = activeTool ? `${activeTool.name} is running` : closed;
  }

  compactionStarted(reason: MainCompactionActivity["reason"], willRetry: boolean): void {
    const at = this.timestamp();
    this.compaction = { reason, willRetry, startedAt: at };
    this.currentDetail = `Compacting context · ${reason}${willRetry ? " · run will continue" : ""}`;
    this.append("compaction", "session_before_compact", this.currentDetail, "active", at);
  }

  compactionFinished(reason: MainCompactionActivity["reason"], willRetry: boolean): void {
    this.compaction = undefined;
    this.currentDetail = `Context compacted · ${reason}${willRetry ? " · continuing" : ""}`;
    this.append("compaction", "session_compact", this.currentDetail, "complete");
  }

  compactionFailed(reason: MainCompactionActivity["reason"], aborted: boolean, errorMessage?: string): void {
    this.compaction = undefined;
    this.attention = aborted ? `Compaction aborted · ${reason}` : `Compaction failed · ${errorMessage || reason}`;
    this.currentDetail = this.attention;
    this.append("compaction", "session_compact_failed", this.attention, "error");
  }

  snapshot(): MainActivitySnapshot {
    const phase = this.phase();
    return {
      phase,
      phaseLabel: phaseLabel(phase),
      current: this.currentDetail,
      ...(this.runStartedAt ? { startedAt: this.runStartedAt } : {}),
      ...(this.turnIndex === undefined ? {} : { turnIndex: this.turnIndex }),
      activeTools: [...this.tools.values()],
      ...(this.prompt ? { prompt: { ...this.prompt } } : {}),
      ...(this.compaction ? { compaction: { ...this.compaction } } : {}),
      timeline: this.events.map((event) => ({ ...event })),
    };
  }

  private phase(): MainActivityPhase {
    if (this.compaction) return "compacting";
    if (this.prompt) return "waiting";
    if (this.attention) return "attention";
    if (this.tools.size) return "tool";
    const streaming = this.currentStreaming();
    if (streaming === "reasoning") return "reasoning";
    if (streaming === "response") return "responding";
    if (this.agentActive && this.turnIndex === undefined) return "starting";
    if (this.agentActive) return "continuing";
    return "ready";
  }

  private startStreaming(kind: "reasoning" | "response", contentIndex: number): void {
    const key = `${kind}:${contentIndex}`;
    this.streamingContent.delete(key);
    this.streamingContent.set(key, kind);
  }

  private finishStreaming(kind: "reasoning" | "response", contentIndex: number, fallback: string): void {
    this.streamingContent.delete(`${kind}:${contentIndex}`);
    const streaming = this.currentStreaming();
    this.currentDetail = streaming === "reasoning"
      ? "Provider reasoning summary is streaming"
      : streaming === "response"
        ? "Assistant response is streaming"
        : fallback;
  }

  private currentStreaming(): "reasoning" | "response" | undefined {
    return [...this.streamingContent.values()].at(-1);
  }

  private startContentEvent(kind: "reasoning" | "response", contentIndex: number, label: string): string {
    const key = this.contentKey(kind, contentIndex);
    const existing = this.contentEvents.get(key);
    if (existing) return existing;
    const id = this.append(kind, label, "", "active");
    this.contentEvents.set(key, id);
    return id;
  }

  private appendContent(kind: "reasoning" | "response", contentIndex: number, delta: string): void {
    const id = this.startContentEvent(kind, contentIndex, kind === "reasoning" ? "reasoning summary" : "assistant response");
    const event = this.events.find((candidate) => candidate.id === id);
    if (event) event.text = capText(event.text + delta);
  }

  private finishContent(kind: "reasoning" | "response", contentIndex: number, content: string): void {
    const id = this.startContentEvent(kind, contentIndex, kind === "reasoning" ? "reasoning summary" : "assistant response");
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event) return;
    event.text = capText(content || event.text);
    event.state = "complete";
  }

  private contentKey(kind: "reasoning" | "response", contentIndex: number): string {
    return `${this.turnIndex ?? "run"}:${kind}:${contentIndex}`;
  }

  private append(
    kind: MainActivityKind,
    label: string,
    text: string,
    state: MainActivityState,
    at = this.timestamp(),
    id = `main-${++this.sequence}`,
  ): string {
    this.events.push({ id, at, kind, label, text: capText(text), state });
    if (this.events.length > TIMELINE_LIMIT) {
      const removed = this.events.splice(0, this.events.length - TIMELINE_LIMIT);
      const removedIds = new Set(removed.map((event) => event.id));
      for (const [key, eventId] of this.contentEvents) if (removedIds.has(eventId)) this.contentEvents.delete(key);
    }
    return id;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function emptyMainActivitySnapshot(): MainActivitySnapshot {
  return {
    phase: "ready",
    phaseLabel: "ready",
    current: "Pi is ready",
    activeTools: [],
    timeline: [],
  };
}

function phaseLabel(phase: MainActivityPhase): string {
  if (phase === "tool") return "tool running";
  if (phase === "waiting") return "waiting for you";
  return phase;
}

function compactValue(value: unknown): string {
  if (value === undefined) return "";
  try {
    return capText(JSON.stringify(value).replace(/\s+/g, " "), 240);
  } catch {
    return "arguments unavailable";
  }
}

function capText(value: string, maximum = BLOCK_TEXT_LIMIT): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}
