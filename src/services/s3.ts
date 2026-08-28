/** @format */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

/**
 * Member photos in S3.
 *
 * The bucket is private. Nothing here ever produces a URL that works without a
 * signature, and the database never stores one.
 *
 * That is a deliberate reversal. The first version of this uploaded with
 * public-read caching headers and saved
 * `https://bucket.s3.region.amazonaws.com/photos/<id>/<uuid>.jpg` on the row —
 * so a member's face was readable by anyone who had ever seen the link, forever,
 * with no login and no way to revoke it. A photograph of a person is personal
 * data; the uuid in the path is obscurity, not access control, and it leaks
 * through browser history, referrer headers, and anything that proxies or caches
 * the image.
 *
 * What replaces it: the row keeps only `photoKey`, and a URL is minted per
 * response with a short expiry. A link that escapes stops working within
 * minutes, and revoking access is just declining to sign the next one.
 */

/**
 * How long a signed photo URL stays valid.
 *
 * Long enough that a roster of faces finishes loading and a page can be left
 * open briefly; short enough that a URL copied out of devtools is useless by the
 * time it is used. It bounds the damage of a leaked link, so it is not a knob
 * worth turning up for convenience.
 */
const SIGNED_URL_TTL_SECONDS = 300;

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
 * Whether a photo may be stored inline on the row when S3 is absent.
 *
 * Only outside production. The `Member.photo` column holds a base64 data-URL —
 * up to a couple of megabytes of image sitting in a row that every member list,
 * every search and every backup then carries. It exists so a developer can work
 * without AWS credentials, and that is the whole of its remit.
 *
 * In production the same code path is a trap rather than a convenience: forget
 * one of the four AWS variables on a deploy and nothing fails, nothing is
 * logged, and the gym quietly starts writing photographs into Postgres. By the
 * time anyone notices — a slow roster, a backup that will not fit — the rows are
 * already there, and getting them out means a migration rather than a config
 * change.
 *
 * So production refuses the upload instead. A rejected photo is a message an
 * operator can act on; a silently fattening database is not.
 */
export const canStorePhotoInline = (): boolean =>
  process.env.NODE_ENV !== "production";

/**
 * Why a photo could not be stored, for the one case the caller must explain.
 *
 * Deliberately not thrown from `uploadPhoto`: this is a deployment fault, not a
 * failed upload, and the two deserve different words at the front desk.
 */
export const photoStorageUnavailable =
  "Photo storage is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, " +
  "AWS_REGION and S3_BUCKET_NAME, or save the member without a photo.";

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
}

/**
 * Uploads a photo and returns its key.
 *
 * Only the key — there is deliberately no URL in the result. A URL that is
 * worth storing is a URL that works without a signature, which is the thing
 * this service exists to avoid. Callers persist the key and ask for a signed
 * URL at read time.
 *
 * @param buffer Image buffer (base64 decoded or binary)
 * @param filename Original filename or generated name
 * @param memberId Member ID for organizing photos
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
        // `private`, not `public`: the signed URL that serves this is unique
        // per request, so a shared cache keyed on it would either never hit or
        // hand one member's face to whoever asked next. The browser may hold it
        // for the life of the signature and no longer.
        CacheControl: `private, max-age=${SIGNED_URL_TTL_SECONDS}`,
      }),
    );

    return { key };
  } catch (error) {
    console.error("Photo upload failed:", error);
    throw new Error("Failed to upload photo to S3");
  }
};

/**
 * A short-lived URL for one stored photo.
 *
 * Returns null rather than throwing when there is nothing to sign or S3 is not
 * configured: a missing face must degrade to the initials placeholder the UI
 * already draws, never to a failed member list.
 */
export const getPhotoUrl = async (
  photoKey: string | null | undefined,
): Promise<string | null> => {
  if (!photoKey || !isS3Configured()) return null;

  try {
    return await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: photoKey,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
  } catch (error) {
    console.error("Could not sign photo URL:", error);
    return null;
  }
};

/**
 * Signs a batch of photos at once.
 *
 * A roster page holds fifty members, and signing is local computation — an
 * HMAC, no network call — so this is a loop rather than anything cleverer. It
 * exists so callers cannot accidentally await fifty signatures in series inside
 * a `.map`, and so one unsignable key cannot fail the whole page.
 */
export const signPhotoUrls = async (
  keys: readonly (string | null | undefined)[],
): Promise<(string | null)[]> => Promise.all(keys.map(getPhotoUrl));

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
