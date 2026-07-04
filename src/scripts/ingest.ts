import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Wrapper } from "../storage/s3.js";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root is 2 directories up from dist/scripts/ingest.js or src/scripts/ingest.ts
const rootDir = path.resolve(__dirname, "../../");

function parseAndCollectFiles(dir: string, baseDirName: string, db: { content: string; area: string }[]) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Exclude raw roadmaps folder because they are too large and formatted ones are sufficient
      if (item === "raw") {
        continue;
      }
      parseAndCollectFiles(fullPath, baseDirName, db);
    } else if (stat.isFile()) {
      if (item.endsWith(".txt") || item.endsWith(".md")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Split by paragraphs to keep semantic blocks together
        const paragraphs = content.split(/\n\s*\n/);
        for (const p of paragraphs) {
          const cleanP = p.trim();
          if (cleanP.length > 20) {
            db.push({
              content: cleanP,
              area: baseDirName,
            });
          }
        }
      } else if (item.endsWith(".json") && (fullPath.includes("roadmaps") || item.startsWith("formatted-"))) {
        try {
          const fileContent = fs.readFileSync(fullPath, "utf-8");
          const parsed = JSON.parse(fileContent);
          if (parsed.title && parsed.topics) {
            const role = parsed.title;
            db.push({
              content: `Role: ${role} - Description: ${parsed.description || ""}`,
              area: baseDirName,
            });
            for (const topic of parsed.topics) {
              if (topic.label && (topic.type === "topic" || topic.type === "subtopic" || topic.type === "title")) {
                db.push({
                  content: `Role: ${role} - Topic: ${topic.label}${topic.level ? ` (${topic.level})` : ""}`,
                  area: baseDirName,
                });
              }
            }
          }
        } catch (e: any) {
          logger.error(`Error parsing JSON file ${fullPath}: ${e.message}`);
        }
      }
    }
  }
}

async function main() {
  let curatedDir = path.join(rootDir, "..", "patb-rag-curated-content");
  if (!fs.existsSync(curatedDir)) {
    curatedDir = path.join(rootDir, "..", "agent-project", "patb-rag-curated-content");
  }
  if (!fs.existsSync(curatedDir)) {
    curatedDir = "D:\\_code-projects\\langchainjs-project-01\\agent-project\\patb-rag-curated-content";
  }
  logger.info(`Starting ingestion from ${curatedDir}`);

  if (!fs.existsSync(curatedDir)) {
    logger.error(`Curated content directory does not exist: ${curatedDir}`);
    process.exit(1);
  }

  const db: { content: string; area: string }[] = [];

  const items = fs.readdirSync(curatedDir);
  for (const item of items) {
    const itemPath = path.join(curatedDir, item);
    if (!fs.statSync(itemPath).isDirectory()) {
      continue;
    }

    // Curated content areas: aws-tutor, cellular-automata, english-certification-instructor, job-techinical-interview
    const area = item;
    logger.info(`Traversing content for specialist area: ${area}`);
    parseAndCollectFiles(itemPath, area, db);
  }

  logger.info(`Ingested ${db.length} chunks.`);

  // Write locally to src/storage/vector-store.json
  const srcStorageDir = path.join(rootDir, "src", "storage");
  const srcDest = path.join(srcStorageDir, "vector-store.json");
  fs.mkdirSync(srcStorageDir, { recursive: true });
  fs.writeFileSync(srcDest, JSON.stringify(db, null, 2), "utf-8");
  logger.info(`Saved locally to ${srcDest}`);

  // Write locally to dist/storage/vector-store.json if dist directory exists
  const distStorageDir = path.join(rootDir, "dist", "storage");
  if (fs.existsSync(path.join(rootDir, "dist"))) {
    fs.mkdirSync(distStorageDir, { recursive: true });
    const distDest = path.join(distStorageDir, "vector-store.json");
    fs.writeFileSync(distDest, JSON.stringify(db, null, 2), "utf-8");
    logger.info(`Saved to compiled output: ${distDest}`);
  }

  // Upload the database file to S3
  const s3 = new S3Wrapper();
  try {
    logger.info("Uploading vector store to S3...");
    await s3.uploadState("vector-store.json", db);
    logger.info("Successfully uploaded database to S3!");
  } catch (error: any) {
    logger.warn(`Failed to upload to S3 (maybe offline/no credentials): ${error.message}`);
  }
}

main().catch((err) => {
  logger.error("Ingestion failed: " + err.message);
  process.exit(1);
});
