import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatMessageMetadata = {
  chat: {
    messages: {
      viaSource: "via {source}",
      sourceKinds: { web: "Web", cli: "CLI", terminal: "TUI", app: "App", rpc: "RPC" },
      forwardedFrom: "From",
      forwardedFromAgent: "Forwarded from {agentId}",
      forwardedMessage: "Forwarded message",
      fullContentLoadExhausted: "Could not load the full message.",
      duplicatesCollapsed: "{count} consecutive identical messages collapsed",
      contextFor: "Message context for {timestamp}",
    },
  },
} satisfies TranslationMap;

export const registerChatMessageMetadataEnglish = Object.assign(
  () => Object.assign(en.chat.messages, enChatMessageMetadata.chat.messages),
  { catalog: enChatMessageMetadata },
);
