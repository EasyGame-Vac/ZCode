import { describe, expect, it } from "vitest";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { deriveLogicalUiInstances } from "@/plugin-ui/domain/pluginUiInstancePolicy.js";

function row(id: number, turnId: string): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    turnId,
    createdAt: id,
    createdAtSeq: id,
    toolCallId: `call-${id}`,
    toolName: "mcp__fixture__edit",
    status: "success",
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "fixture",
      toolName: "edit",
      ui: {
        pluginId: "fixture",
        resourceUri: "ui://fixture",
        surface: "panel",
        preferredDisplayMode: "fullscreen",
        showInline: true,
      },
    },
  };
}

describe("deriveLogicalUiInstances turn order", () => {
  it("dedupes repeated turn ids without changing last-N auto-expand semantics", () => {
    const rows = [row(1, "turn-a"), row(2, "turn-b"), row(3, "turn-a"), row(4, "turn-c")];

    const derivation = deriveLogicalUiInstances(rows, { autoExpandTurns: 2 });

    expect(derivation.byToolCallId["call-1"]?.autoExpand).toBe(false);
    expect(derivation.byToolCallId["call-2"]?.autoExpand).toBe(true);
    expect(derivation.byToolCallId["call-3"]?.autoExpand).toBe(false);
    expect(derivation.byToolCallId["call-4"]?.autoExpand).toBe(true);
  });
});
