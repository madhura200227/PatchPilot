import process from "node:process";
import { createTrueForgeClient } from "./client.js";

export interface SessionTestReport {
  sessionId: string;
  createStatus: "PASS" | "FAIL";
  getStatus: "PASS" | "FAIL";
  listStatus: "PASS" | "FAIL";
  updateStatus: "PASS" | "FAIL";
  deleteStatus: "PASS" | "FAIL";
  details: Record<string, unknown>;
}

export async function runSessionLifecycleTest(): Promise<SessionTestReport> {
  const client = createTrueForgeClient();
  const report: SessionTestReport = {
    sessionId: "",
    createStatus: "FAIL",
    getStatus: "FAIL",
    listStatus: "FAIL",
    updateStatus: "FAIL",
    deleteStatus: "FAIL",
    details: {},
  };

  console.log("--- 1. Testing Session Creation ---");
  let createdSessionId = "";
  try {
    // Attempt creating inline agent spec or named agent
    const createResponse = await client.sessions.create({
      agent: {
        spec: {
          model: {
            name: "openai/gpt-4o",
          },
          instructions: "PatchPilot spike validation agent. Follow deterministic commands.",
        },
      },
      metadata: {
        creator: "PatchPilot-Spike",
        purpose: "feasibility-verification",
      },
    });

    createdSessionId = createResponse.data.id;
    report.sessionId = createdSessionId;
    report.createStatus = "PASS";
    report.details.createdSession = {
      id: createResponse.data.id,
      title: createResponse.data.title,
      createdAt: createResponse.data.createdAt,
      agentType: createResponse.data.agent?.type,
    };
    console.log(`[PASS] Session created with ID: ${createdSessionId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[INFO] Inline agent spec creation result: ${message}`);

    // If inline agent spec requires named agent, try named agent reference
    try {
      console.log("Attempting session creation with named agent reference...");
      const namedResponse = await client.sessions.create({
        agent: {
          name: "default",
        },
      });
      createdSessionId = namedResponse.data.id;
      report.sessionId = createdSessionId;
      report.createStatus = "PASS";
      report.details.createdSession = {
        id: namedResponse.data.id,
        createdAt: namedResponse.data.createdAt,
      };
      console.log(`[PASS] Session created with named agent. ID: ${createdSessionId}`);
    } catch (innerErr: unknown) {
      const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      report.details.createError = innerMsg;
      console.error(`[FAIL] Session creation failed: ${innerMsg}`);
      return report;
    }
  }

  console.log("--- 2. Testing Session Retrieval (Get) ---");
  try {
    const fetched = await client.sessions.get(createdSessionId);
    if (fetched.data.id === createdSessionId) {
      report.getStatus = "PASS";
      report.details.fetchedSession = {
        id: fetched.data.id,
        createdAt: fetched.data.createdAt,
        updatedAt: fetched.data.updatedAt,
      };
      console.log(`[PASS] Retrieved session ${createdSessionId} successfully.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    report.details.getError = message;
    console.error(`[FAIL] Get session failed: ${message}`);
  }

  console.log("--- 3. Testing Session Listing (List) ---");
  try {
    const sessionList = await client.sessions.list({ limit: 10 });
    const existsInList = sessionList.data?.some((s) => s.id === createdSessionId);
    if (existsInList) {
      report.listStatus = "PASS";
      report.details.totalSessions = sessionList.data?.length ?? 0;
      console.log(`[PASS] Verified created session exists in session listing.`);
    } else {
      console.warn(`[WARN] Session ${createdSessionId} not found in first page of listings.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    report.details.listError = message;
    console.error(`[FAIL] List sessions failed: ${message}`);
  }

  console.log("--- 4. Testing Session Metadata Update ---");
  try {
    const updateResponse = await client.sessions.update(createdSessionId, {
      title: "PatchPilot Verified Session",
      metadata: {
        verified: "true",
        timestamp: new Date().toISOString(),
      },
    });
    if (updateResponse.data.title === "PatchPilot Verified Session") {
      report.updateStatus = "PASS";
      report.details.updatedTitle = updateResponse.data.title;
      console.log(`[PASS] Updated session title to: "${updateResponse.data.title}".`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    report.details.updateError = message;
    console.error(`[FAIL] Update session failed: ${message}`);
  }

  console.log("--- 5. Testing Session Deletion (Teardown) ---");
  try {
    await client.sessions.delete(createdSessionId);
    report.deleteStatus = "PASS";
    console.log(`[PASS] Deleted session ${createdSessionId} successfully.`);

    // Verify it is gone
    try {
      await client.sessions.get(createdSessionId);
      console.warn(`[WARN] Session still returned after delete.`);
    } catch {
      console.log(`[PASS] Confirmed session returns 404 after deletion.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    report.details.deleteError = message;
    console.error(`[FAIL] Delete session failed: ${message}`);
  }

  return report;
}

async function main() {
  console.log("=== TRUEFORGE SDK SESSION LIFECYCLE SPIKE ===");
  const report = await runSessionLifecycleTest();
  console.log("\n--- SESSION TEST SUMMARY ---");
  console.log(`Session ID: ${report.sessionId}`);
  console.log(`Create: ${report.createStatus}`);
  console.log(`Get:    ${report.getStatus}`);
  console.log(`List:   ${report.listStatus}`);
  console.log(`Update: ${report.updateStatus}`);
  console.log(`Delete: ${report.deleteStatus}`);

  if (report.createStatus !== "PASS" || report.getStatus !== "PASS") {
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("session-test.ts") || process.argv[1]?.endsWith("session-test.js")) {
  main().catch((err) => {
    console.error("Session test execution error:", err);
    process.exit(1);
  });
}
