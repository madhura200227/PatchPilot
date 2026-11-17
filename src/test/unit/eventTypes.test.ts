import assert from "node:assert";
import { classifyTurnEvent } from "../../trueforge/eventTypes";

describe("Unit: Stream Event Classification", () => {
  it("should classify turn.created event and extract turnId", () => {
    const raw = {
      type: "turn.created",
      id: "01m7event001",
      turnId: "01m7turn12345",
      createdAt: "2026-11-17T12:00:00Z",
    };

    const classified = classifyTurnEvent(raw);
    assert.strictEqual(classified.type, "turn.created");
    assert.strictEqual(classified.turnId, "01m7turn12345");
    assert.strictEqual(classified.id, "01m7event001");
    assert.strictEqual(classified.isUnsupportedInM0, false);
  });

  it("should classify model.message.delta event and extract incremental content", () => {
    const raw = {
      type: "model.message.delta",
      id: "01m7delta001",
      threadId: "01m7thread01",
      content: "Hello world delta",
    };

    const classified = classifyTurnEvent(raw);
    assert.strictEqual(classified.type, "model.message.delta");
    assert.strictEqual(classified.deltaText, "Hello world delta");
    assert.strictEqual(classified.isUnsupportedInM0, false);
  });

  it("should classify model.message event with string content", () => {
    const raw = {
      type: "model.message",
      id: "01m7msg001",
      threadId: "01m7thread01",
      content: "Full complete message",
    };

    const classified = classifyTurnEvent(raw);
    assert.strictEqual(classified.type, "model.message");
    assert.strictEqual(classified.messageText, "Full complete message");
  });

  it("should classify turn.done event with terminal status and reason", () => {
    const raw = {
      type: "turn.done",
      id: "01m7done001",
      state: {
        status: "done",
        reason: "completed_successfully",
      },
    };

    const classified = classifyTurnEvent(raw);
    assert.strictEqual(classified.type, "turn.done");
    assert.strictEqual(classified.terminalStatus, "done");
    assert.strictEqual(classified.terminalReason, "completed_successfully");
  });

  it("should detect and flag unsupported interactive events in Milestone 0", () => {
    const approvalEvent = {
      type: "tool.approval_required",
      id: "01m7appr001",
      toolName: "run_pytest",
    };

    const classified = classifyTurnEvent(approvalEvent);
    assert.strictEqual(classified.isUnsupportedInM0, true);
    assert.ok(classified.unsupportedReason?.includes("Milestone 0"));

    const responseRequired = {
      type: "tool.response_required",
      id: "01m7resp001",
    };
    const classifiedResp = classifyTurnEvent(responseRequired);
    assert.strictEqual(classifiedResp.isUnsupportedInM0, true);

    const mcpAuth = {
      type: "mcp.auth_required",
      id: "01m7auth001",
    };
    const classifiedAuth = classifyTurnEvent(mcpAuth);
    assert.strictEqual(classifiedAuth.isUnsupportedInM0, true);
  });
});
