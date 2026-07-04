import "../dist/config.js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

async function main() {
  console.log("Starting trace test...");
  console.log("LANGCHAIN_TRACING_V2:", process.env.LANGCHAIN_TRACING_V2);
  console.log("LANGCHAIN_PROJECT:", process.env.LANGCHAIN_PROJECT);
  console.log("LANGCHAIN_API_KEY:", process.env.LANGCHAIN_API_KEY ? "Present (Starts with " + process.env.LANGCHAIN_API_KEY.substring(0, 8) + ")" : "Not Present");
  console.log("LANGSMITH_TRACING:", process.env.LANGSMITH_TRACING);
  console.log("LANGSMITH_API_KEY:", process.env.LANGSMITH_API_KEY ? "Present (Starts with " + process.env.LANGSMITH_API_KEY.substring(0, 8) + ")" : "Not Present");

  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in environment!");
    process.exit(1);
  }

  const model = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
  });

  console.log("Invoking model...");
  const res = await model.invoke([new HumanMessage("Hello LangSmith Tracing!")]);
  console.log("Response:", res.content);
  console.log("Trace test completed successfully!");
}

main().catch(err => {
  console.error("Error running trace test:", err);
});
