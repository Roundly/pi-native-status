/**
 * Offline mock provider for the SDK smoke test only.
 *
 * It emits a canned response with usage, delays the first delta and the end so
 * TTFT/TPS can be observed, and never opens a socket or reads a credential.
 * This file is a development fixture and is NOT installed with the extension.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const usage = {
  input: 1000,
  output: 3,
  cacheRead: 9000,
  cacheWrite: 0,
  totalTokens: 10003,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageWith(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("mock", {
    name: "Offline Mock",
    baseUrl: "http://127.0.0.1:9/unused",
    apiKey: "offline-test-only",
    api: "mock-chat",
    models: [
      {
        id: "mock-chat",
        name: "Mock Chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, _context: TranscriptContext, options?: SimpleStreamOptions) {
      const stream = createAssistantMessageEventStream();
      const text = "离线 mock 回复：状态栏计时正常。";
      let ended = false;
      let firstTimer: ReturnType<typeof setTimeout> | undefined;
      let doneTimer: ReturnType<typeof setTimeout> | undefined;

      const close = () => {
        ended = true;
        if (firstTimer) clearTimeout(firstTimer);
        if (doneTimer) clearTimeout(doneTimer);
      };

      stream.push({ type: "start", partial: messageWith(model, "", "pending") });
      options?.signal?.addEventListener(
        "abort",
        () => {
          if (ended) return;
          close();
          stream.push({
            type: "error",
            reason: "aborted",
            error: messageWith(model, "", "aborted"),
          });
        },
        { once: true },
      );

      firstTimer = setTimeout(() => {
        if (ended) return;
        stream.push({ type: "text_start", contentIndex: 0, partial: messageWith(model, "", "pending") });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: messageWith(model, text, "pending"),
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: messageWith(model, text, "pending"),
        });
      }, 150);

      doneTimer = setTimeout(() => {
        if (ended) return;
        close();
        stream.push({
          type: "done",
          reason: "stop",
          message: messageWith(model, text, "stop"),
        });
      }, 650);

      return stream;
    },
  });
}