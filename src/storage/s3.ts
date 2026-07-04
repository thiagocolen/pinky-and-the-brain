import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { Readable } from "stream";
import { logger } from "../utils/logger.js";

export class S3Wrapper {
  private s3?: S3Client;
  private useMock = false;
  private mockStore = new Map<string, any>();

  constructor() {
    // If we don't have AWS credentials in environment, default to mock mode
    const isAwsEnv = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) || !!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    
    if (!isAwsEnv) {
      this.useMock = true;
      logger.warn("[STORAGE] AWS credentials not found. S3 storage will use local in-memory fallback.");
    } else {
      try {
        this.s3 = new S3Client({ region: config.awsRegion });
      } catch (e: any) {
        this.useMock = true;
        logger.warn("[STORAGE] Failed to initialize AWS S3 Client. Falling back to mock: " + e.message);
      }
    }
  }

  public async uploadState(key: string, data: any): Promise<void> {
    if (this.useMock || !this.s3) {
      this.mockStore.set(key, data);
      return;
    }
    const payload = JSON.stringify(data);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: payload,
        ContentType: "application/json",
      })
    );
  }

  public async downloadState(key: string): Promise<any> {
    if (this.useMock || !this.s3) {
      return this.mockStore.get(key) || null;
    }
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: config.bucketName,
        Key: key,
      })
    );

    const streamToString = (stream: Readable): Promise<string> =>
      new Promise((resolve, reject) => {
        const chunks: any[] = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });

    const bodyString = await streamToString(response.Body as Readable);
    return JSON.parse(bodyString);
  }

  public async deleteState(key: string): Promise<void> {
    if (this.useMock || !this.s3) {
      this.mockStore.delete(key);
      return;
    }
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: config.bucketName,
        Key: key,
      })
    );
  }
}
