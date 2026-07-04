import readline from "readline";
import { runGraphWorkflow } from "./agents/graph.js";
import { isAIMessage, getMessageContent } from "./utils/messages.js";
import { validateConfig } from "./config.js";

try {
  validateConfig();
} catch (e: any) {
  console.error("Configuration validation failed:", e.message);
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const threadId = `cli-session-${Math.random().toString(36).substring(7)}`;

console.log("==================================================");
console.log("🧠 Pinky and the Brain - Interactive Agent CLI REPL");
console.log(`🧵 Session Thread ID: ${threadId}`);
console.log("Type your message to prompt the agent workflow.");
console.log("Type 'exit' or 'quit' to end the session.");
console.log("==================================================\n");

function askQuestion() {
  rl.question("\n👤 You: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      askQuestion();
      return;
    }

    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
      console.log("\n👋 Exiting CLI. Goodbye!");
      rl.close();
      process.exit(0);
    }

    console.log("\n🤖 Agent executing...\n");

    try {
      const result = await runGraphWorkflow(
        "supervisor",
        trimmed,
        threadId,
        (progress) => {
          // Log progress to stderr so that stdout is clean if redirected
          process.stderr.write(`🔄 [${progress.node}] ${progress.status}\n`);
        },
      );

      console.log("\n--------------------------------------------------");
      console.log("🤖 Response:");

      let responseText = "";
      if (result.instructorState?.explanation) {
        responseText = result.instructorState.explanation;
      } else {
        const aiMsgs = (result.messages || [])
          .filter(isAIMessage)
          .map(getMessageContent);
        if (aiMsgs.length > 0) {
          responseText = aiMsgs.join("\n\n");
        } else {
          responseText =
            "Workflow execution complete, but no output content was returned.";
        }
      }

      console.log(responseText);
      console.log("--------------------------------------------------");
    } catch (err: any) {
      console.error(`\n❌ Error executing workflow: ${err.message}`);
    }

    askQuestion();
  });
}

askQuestion();
