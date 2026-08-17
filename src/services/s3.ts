/** @format */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

/**
 * S3 service for storing and managing member photos
 * Supports uploads, deletions, and generates signed URLs
 */

let s3Client: S3Client | null = null;

const getS3Client = (): S3Client => {
  if (s3Client) return s3Client;

  if (
    !process.env.AWS_ACCESS_KEY_ID ||
    !process.env.AWS_SECRET_ACCESS_KEY ||
    !process.env.AWS_REGION
  ) {
    throw new Error(
      "AWS credentials not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION",
    );
  }

  s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  return s3Client;
};

export const isS3Configured = (): boolean => {
  return !!(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_REGION &&
    process.env.S3_BUCKET_NAME
  );
};

/**
 * Verify S3 bucket exists and is accessible
 */
export const verifyS3Bucket = async (): Promise<boolean> => {
  if (!isS3Configured()) return false;

  try {
    const client = getS3Client();
    await client.send(
      new HeadBucketCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
      }),
    );
    return true;
  } catch (error) {
    console.error("S3 bucket verification failed:", error);
    return false;
  }
};

export interface UploadPhotoResult {
  key: string;
  url: string;
}

/**
 * Upload a photo to S3
 * @param buffer Image buffer (base64 decoded or binary)
 * @param filename Original filename or generated name
 * @param memberId Member ID for organizing photos
 * @returns S3 key and public URL
 */
export const uploadPhoto = async (
  buffer: Buffer,
  filename: string,
  memberId: string,
): Promise<UploadPhotoResult> => {
  if (!isS3Configured()) {
    throw new Error("S3 is not configured");
  }

  const client = getS3Client();
  const fileExt = filename.split(".").pop() || "jpg";
  const key = `photos/${memberId}/${uuidv4()}.${fileExt}`;

  // Determine content type
  const contentTypeMap: { [key: string]: string } = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  const contentType = contentTypeMap[fileExt.toLowerCase()] || "image/jpeg";

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // Optional: Add caching headers for public photos
        CacheControl: "public, max-age=31536000", // 1 year
      }),
    );

    // Generate public URL (assuming bucket is public or using CloudFront)
    const baseUrl =
      process.env.S3_BASE_URL ||
      `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    const url = `${baseUrl}/${key}`;

    return { key, url };
  } catch (error) {
    console.error("Photo upload failed:", error);
    throw new Error("Failed to upload photo to S3");
  }
};

/**
 * Delete a photo from S3
 * @param photoKey S3 key of the photo to delete
 */
export const deletePhoto = async (photoKey: string): Promise<void> => {
  if (!isS3Configured() || !photoKey) {
    return;
  }

  try {
    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: photoKey,
      }),
    );
  } catch (error) {
    console.error("Photo deletion failed:", error);
    // Don't throw - photo deletion failures shouldn't break the app
  }
};

/**
 * Convert base64 data URL to Buffer
 * Handles data:image/jpeg;base64,... format
 */
export const base64ToBuffer = (dataUrl: string): Buffer => {
  const parts = dataUrl.split(",");
  if (parts.length !== 2) {
    throw new Error("Invalid data URL format");
  }
  return Buffer.from(parts[1], "base64");
};

/**
 * Extract filename from data URL or generate one
 */
export const extractFilename = (
  dataUrl: string,
  defaultName: string = "photo",
): string => {
  const match = dataUrl.match(/image\/(jpeg|png|gif|webp)/);
  const ext = match ? match[1] : "jpg";
  return `${defaultName}.${ext}`;
};
