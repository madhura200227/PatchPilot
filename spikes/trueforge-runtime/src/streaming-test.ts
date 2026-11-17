import process from "node:process";
import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { createTrueForgeClient } from "./client.js";

export interface StreamingEventClassification {
  type: string;
  id?: string;
  createdAt?: string;
  payloadSummary: string;
}

export interface StreamingTestReport {
  sessionId: string;
  turnId?: string;
  streamCreated: boolean;
  eventsReceived: StreamingEventClassification[];
  terminalState?: string;
  terminalReason?: string;
  turnVerificationStatus: "PASS" | "FAIL" | "BLOCKED";
  notes: string[];
}

export async function runStreamingVerification(): Promise<StreamingTestReport> {
  const client = createTrueForgeClient();
  const report: StreamingTestReport = {
    sessionId: "",
    streamCreated: false,
    eventsReceived: [],
    turnVerificationStatus: "BLOCKED",
    notes: [],
  };

  console.log("--- 1. Creating Session for Turn Streaming ---");
  let sessionId = "";
  try {
    const sessionResponse = await client.sessions.create({
      agent: {
        spec: {
          model: {
            name: "openai/gpt-4o",
          },
          instructions: "Deterministic testing agent for PatchPilot streaming verification.",
        },
      },
    });
    sessionId = sessionResponse.data.id;
    report.sessionId = sessionId;
    console.log(`[PASS] Session created: ${sessionId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    report.notes.push(`Session creation failed: ${message}`);
    console.error(`[FAIL] Could not create session for streaming: ${message}`);
    return report;
  }

  console.log("--- 2. Dispatching createTurnStream ---");
  try {
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [
        {
          type: "user.message",
          content: "Hello TrueForge. Please respond with a short confirmation message.",
        },
      ],
    });

    report.streamCreated = true;
    console.log("[PASS] Server-Sent Events stream initiated successfully.");

    console.log("--- 3. Consuming and Classifying Stream Events ---");
    for await (const event of stream) {
      const eventRecord: StreamingEventClassification = {
        type: event.type,
        id: "id" in event ? (event as { id: string }).id : undefined,
        createdAt: "createdAt" in event ? (event as { createdAt: string }).createdAt : undefined,
        payloadSummary: JSON.stringify(event).slice(0, 150),
      };

      report.eventsReceived.push(eventRecord);
      console.log(`  [EVENT RECEIVED] type: ${event.type}`);

      // Capture turn ID if turn.created
      if (event.type === "turn.created") {
        const turnCreated = event as TrueForgeApi.TurnCreatedEvent;
        report.turnId = turnCreated.turnId;
        console.log(`  [TURN CREATED] Turn ID: ${report.turnId}`);
      }

      // Capture terminal state if turn.done
      if (event.type === "turn.done") {
        const doneState = (event as TrueForgeApi.TurnDoneEvent).state;
        report.terminalState = doneState.status;
        if ("message" in doneState) {
          report.terminalReason = String((doneState as { message?: string }).message);
        } else if ("reason" in doneState) {
          report.terminalReason = String(doneState.reason);
        }
        console.log(`  [TERMINAL STATE] status: ${doneState.status}, reason/message: ${report.terminalReason}`);
      }
    }

    console.log(`[PASS] Stream completed with ${report.eventsReceived.length} total events captured.`);

    // Check terminal turn state via authoritative GET /turns/:id endpoint if turnId is known
    if (report.turnId) {
      console.log(`--- 4. Authoritative Turn State Verification (GET /turns/${report.turnId}) ---`);
      try {
        const turnResponse = await client.sessions.getTurn(sessionId, report.turnId);
        const serverStatus = turnResponse.data.state?.status;
        console.log(`[PASS] Authoritative turn state retrieved: ${serverStatus}`);
        if (serverStatus === "done") {
          report.turnVerificationStatus = "PASS";
        } else if (serverStatus === "error") {
          report.turnVerificationStatus = "FAIL";
          report.notes.push(`Turn ended in error state on server: ${JSON.stringify(turnResponse.data.state)}`);
        } else if (serverStatus === "cancelled") {
          report.turnVerificationStatus = "PASS";
          report.notes.push("Turn verified as cancelled.");
        }
      } catch (turnErr: unknown) {
        const turnErrMsg = turnErr instanceof Error ? turnErr.message : String(turnErr);
        report.notes.push(`Authoritative getTurn failed: ${turnErrMsg}`);
      }
    } else {
      if (report.eventsReceived.length > 0) {
        report.turnVerificationStatus = "PASS";
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    report.notes.push(`Streaming failed: ${message}`);
    console.error(`[FAIL] Stream error: ${message}`);
  } finally {
    // Teardown session
    try {
      if (sessionId) {
        await client.sessions.delete(sessionId);
        console.log(`Cleaned up session ${sessionId}.`);
      }
    } catch {
      // Ignore cleanup error
    }
  }

  return report;
}

async function main() {
  console.log("=== TRUEFORGE EVENT STREAMING VERIFICATION SPIKE ===");
  const report = await runStreamingVerification();
  console.log("\n--- STREAMING TEST SUMMARY ---");
  console.log(`Session ID:      ${report.sessionId}`);
  console.log(`Turn ID:         ${report.turnId ?? "N/A"}`);
  console.log(`Stream Created:  ${report.streamCreated}`);
  console.log(`Events Count:    ${report.eventsReceived.length}`);
  console.log(`Terminal State:  ${report.terminalState ?? "None"}`);
  console.log(`Terminal Reason: ${report.terminalReason ?? "None"}`);
  console.log(`Verification:    ${report.turnVerificationStatus}`);
  if (report.notes.length > 0) {
    console.log("Notes / Diagnostics:");
    for (const note of report.notes) {
      console.log(`  - ${note}`);
    }
  }
}

if (process.argv[1]?.endsWith("streaming-test.ts") || process.argv[1]?.endsWith("streaming-test.js")) {
  main().catch((err) => {
    console.error("Streaming test error:", err);
    process.exit(1);
  });
}
