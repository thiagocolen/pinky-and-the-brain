import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointTuple,
  CheckpointMetadata,
  CheckpointListOptions,
  ChannelVersions,
  PendingWrite
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger.js";
import { projectRoot } from "../config.js";

export class SQLiteCheckpointer extends BaseCheckpointSaver {
  private db: sqlite3.Database;
  private isReady: Promise<void>;

  constructor(dbPath: string = process.env.SQLITE_DB_PATH || "state.db") {
    super();

    // Ensure the directory for the DB file exists
    let absoluteDbPath = path.resolve(dbPath);
    if (!path.isAbsolute(dbPath)) {
      absoluteDbPath = path.join(projectRoot, dbPath);
    }
    const dbDir = path.dirname(absoluteDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    logger.info(`[SQLITE-CHECKPOINTER] Initializing database at: ${absoluteDbPath}`);

    this.db = new sqlite3.Database(absoluteDbPath);
    this.isReady = this.initDb();
  }

  private initDb(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Run performance optimization PRAGMAs
        this.db.run("PRAGMA journal_mode = WAL;");
        this.db.run("PRAGMA synchronous = OFF;");
        this.db.run("PRAGMA temp_store = MEMORY;");

        // checkpoints table
        this.db.run(
          `CREATE TABLE IF NOT EXISTS checkpoints (
            thread_id TEXT NOT NULL,
            checkpoint_id TEXT NOT NULL,
            parent_checkpoint_id TEXT,
            checkpoint TEXT NOT NULL,
            metadata TEXT,
            PRIMARY KEY (thread_id, checkpoint_id)
          )`,
          (err) => {
            if (err) {
              logger.error("[SQLITE-CHECKPOINTER] Error creating checkpoints table:", err);
              reject(err);
              return;
            }
          }
        );

        // checkpoint_writes table for pending writes
        this.db.run(
          `CREATE TABLE IF NOT EXISTS checkpoint_writes (
            thread_id TEXT NOT NULL,
            checkpoint_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            idx INTEGER NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (thread_id, checkpoint_id, task_id, idx)
          )`,
          (err) => {
            if (err) {
              logger.error("[SQLITE-CHECKPOINTER] Error creating checkpoint_writes table:", err);
              reject(err);
              return;
            }
            resolve();
          }
        );
      });
    });
  }

  public async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.isReady;

    const threadId = config.configurable?.thread_id;
    let checkpointId = config.configurable?.checkpoint_id;

    logger.debug(`[SQLITE-CHECKPOINTER] getTuple for thread: ${threadId}, checkpoint: ${checkpointId || "latest"}`);

    if (!threadId) {
      return undefined;
    }

    try {
      let row: any;

      if (!checkpointId || checkpointId === "latest") {
        row = await new Promise((resolve, reject) => {
          this.db.get(
            `SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata 
             FROM checkpoints 
             WHERE thread_id = ? 
             ORDER BY checkpoint_id DESC 
             LIMIT 1`,
            [threadId],
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            }
          );
        });
      } else {
        row = await new Promise((resolve, reject) => {
          this.db.get(
            `SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata 
             FROM checkpoints 
             WHERE thread_id = ? AND checkpoint_id = ?`,
            [threadId, checkpointId],
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            }
          );
        });
      }

      if (!row) {
        return undefined;
      }

      const checkpoint = JSON.parse(row.checkpoint) as Checkpoint;
      const metadata = row.metadata ? JSON.parse(row.metadata) as CheckpointMetadata : undefined;
      const parentCheckpointId = row.parent_checkpoint_id || undefined;

      // Get pending writes for this checkpoint
      const writeRows = await new Promise<any[]>((resolve, reject) => {
        this.db.all(
          `SELECT task_id, channel, value 
           FROM checkpoint_writes 
           WHERE thread_id = ? AND checkpoint_id = ?
           ORDER BY idx ASC`,
          [threadId, row.checkpoint_id],
          (err, results) => {
            if (err) reject(err);
            else resolve(results || []);
          }
        );
      });

      const pendingWrites: [string, string, any][] = writeRows.map((wr) => {
        return [wr.task_id, wr.channel, JSON.parse(wr.value)];
      });

      const parentConfig = parentCheckpointId
        ? { configurable: { thread_id: threadId, checkpoint_id: parentCheckpointId } }
        : undefined;

      return {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: row.checkpoint_id
          }
        },
        checkpoint,
        metadata,
        pendingWrites,
        parentConfig
      };
    } catch (e: any) {
      logger.error(`[SQLITE-CHECKPOINTER] getTuple failed: ${e.message}`);
      return undefined;
    }
  }

  public async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.isReady;

    const threadId = config.configurable?.thread_id;
    const checkpointId = checkpoint.id;
    const parentCheckpointId = config.configurable?.checkpoint_id || null;

    logger.debug(`[SQLITE-CHECKPOINTER] put checkpoint for thread: ${threadId}, checkpoint: ${checkpointId}`);

    if (!threadId) {
      throw new Error("Missing thread_id in config.");
    }

    try {
      const serializedCheckpoint = JSON.stringify(checkpoint);
      const serializedMetadata = JSON.stringify(metadata);

      await new Promise<void>((resolve, reject) => {
        this.db.run(
          `INSERT OR REPLACE INTO checkpoints 
           (thread_id, checkpoint_id, parent_checkpoint_id, checkpoint, metadata) 
           VALUES (?, ?, ?, ?, ?)`,
          [threadId, checkpointId, parentCheckpointId, serializedCheckpoint, serializedMetadata],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (e: any) {
      logger.error(`[SQLITE-CHECKPOINTER] put failed: ${e.message}`);
      throw e;
    }

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_id: checkpointId
      }
    };
  }

  public async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    await this.isReady;

    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      return;
    }

    const limit = options?.limit;
    const before = options?.before;

    try {
      let query = `SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata 
                   FROM checkpoints 
                   WHERE thread_id = ?`;
      const params: any[] = [threadId];

      if (before?.configurable?.checkpoint_id) {
        query += ` AND checkpoint_id < ?`;
        params.push(before.configurable.checkpoint_id);
      }

      query += ` ORDER BY checkpoint_id DESC`;

      if (limit !== undefined) {
        query += ` LIMIT ?`;
        params.push(limit);
      }

      const rows = await new Promise<any[]>((resolve, reject) => {
        this.db.all(query, params, (err, results) => {
          if (err) reject(err);
          else resolve(results || []);
        });
      });

      for (const row of rows) {
        const checkpoint = JSON.parse(row.checkpoint) as Checkpoint;
        const metadata = row.metadata ? JSON.parse(row.metadata) as CheckpointMetadata : undefined;
        const parentCheckpointId = row.parent_checkpoint_id || undefined;

        // Retrieve writes
        const writeRows = await new Promise<any[]>((resolve, reject) => {
          this.db.all(
            `SELECT task_id, channel, value 
             FROM checkpoint_writes 
             WHERE thread_id = ? AND checkpoint_id = ?
             ORDER BY idx ASC`,
            [threadId, row.checkpoint_id],
            (err, results) => {
              if (err) reject(err);
              else resolve(results || []);
            }
          );
        });

        const pendingWrites: [string, string, any][] = writeRows.map((wr) => {
          return [wr.task_id, wr.channel, JSON.parse(wr.value)];
        });

        const parentConfig = parentCheckpointId
          ? { configurable: { thread_id: threadId, checkpoint_id: parentCheckpointId } }
          : undefined;

        yield {
          config: {
            configurable: {
              thread_id: threadId,
              checkpoint_id: row.checkpoint_id
            }
          },
          checkpoint,
          metadata,
          pendingWrites,
          parentConfig
        };
      }
    } catch (e: any) {
      logger.error(`[SQLITE-CHECKPOINTER] list failed: ${e.message}`);
    }
  }

  public async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await this.isReady;

    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;

    logger.debug(`[SQLITE-CHECKPOINTER] putWrites for thread: ${threadId}, checkpoint: ${checkpointId}, task: ${taskId}`);

    if (!threadId || !checkpointId) {
      return;
    }

    try {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO checkpoint_writes 
         (thread_id, checkpoint_id, task_id, channel, idx, value) 
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      await new Promise<void>((resolve, reject) => {
        this.db.serialize(() => {
          writes.forEach(([channel, value], idx) => {
            const serializedValue = JSON.stringify(value);
            stmt.run([threadId, checkpointId, taskId, channel, idx, serializedValue], (err) => {
              if (err) {
                logger.error("[SQLITE-CHECKPOINTER] Error in stmt.run for putWrites:", err);
              }
            });
          });

          stmt.finalize((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    } catch (e: any) {
      logger.error(`[SQLITE-CHECKPOINTER] putWrites failed: ${e.message}`);
      throw e;
    }
  }

  public async deleteThread(threadId: string): Promise<void> {
    await this.isReady;

    logger.info(`[SQLITE-CHECKPOINTER] deleteThread state for thread: ${threadId}`);

    try {
      await new Promise<void>((resolve, reject) => {
        this.db.run(`DELETE FROM checkpoints WHERE thread_id = ?`, [threadId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      await new Promise<void>((resolve, reject) => {
        this.db.run(`DELETE FROM checkpoint_writes WHERE thread_id = ?`, [threadId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (e: any) {
      logger.error(`[SQLITE-CHECKPOINTER] deleteThread failed: ${e.message}`);
    }
  }

  public async close(): Promise<void> {
    await this.isReady;
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
