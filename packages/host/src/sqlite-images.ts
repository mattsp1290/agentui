import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ConversationScope } from '@agentui/contracts';
import { IMAGE_HOST_MAX_BYTES, IMAGE_HOST_MAX_COUNT, IMAGE_MAX_AXIS, IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, parseImageAttachment, parseImageId } from '@agentui/contracts/image';
import type { ImageAttachment, ImageId, UploadId } from '@agentui/contracts/image';
import { ImageInputError } from './image-input.js';
import type { verifyImageUpload } from './image-input.js';

export function migrateImages(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 4) {
    for (const table of ['images', 'command_images']) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) throw new Error(`Incomplete database schema version 4: missing ${table}`);
    }
    return;
  }
  if (version !== 2 && version !== 3) throw new Error('Unsupported database version');
  db.exec(`CREATE TABLE images (
    id TEXT PRIMARY KEY NOT NULL,
    host TEXT NOT NULL, conversation TEXT NOT NULL, uploader TEXT NOT NULL, upload TEXT NOT NULL,
    name TEXT NOT NULL, media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg')),
    byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND ${IMAGE_MAX_BYTES}),
    width INTEGER NOT NULL CHECK(width BETWEEN 1 AND ${IMAGE_MAX_AXIS}),
    height INTEGER NOT NULL CHECK(height BETWEEN 1 AND ${IMAGE_MAX_AXIS} AND width*height<=${IMAGE_MAX_PIXELS}),
    digest TEXT NOT NULL CHECK(length(digest)=64), payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=byte_length),
    UNIQUE(host,conversation,uploader,upload),
    FOREIGN KEY(host,conversation) REFERENCES conversations(host,conversation));
    CREATE TRIGGER images_no_update BEFORE UPDATE ON images BEGIN SELECT RAISE(ABORT,'Images are immutable'); END;
    CREATE TRIGGER images_no_delete BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT,'Images are retained'); END;
    CREATE TABLE command_images (
    host TEXT NOT NULL, conversation TEXT NOT NULL, command TEXT NOT NULL, image TEXT NOT NULL,
    PRIMARY KEY(host,conversation,command),
    FOREIGN KEY(host,conversation,command) REFERENCES commands(host,conversation,id),
    FOREIGN KEY(image) REFERENCES images(id));
    PRAGMA user_version=4;`);
}

function requireScope(db: DatabaseSync, scope: ConversationScope): void {
  if (!db.prepare('SELECT 1 FROM conversations WHERE host=? AND conversation=?').get(scope.hostId, scope.conversationId)) {
    throw new ImageInputError('image-scope', 'Image conversation is unavailable');
  }
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='service_identity'").get() &&
    db.prepare('SELECT host FROM service_identity WHERE singleton=1').get()?.host !== scope.hostId) {
    throw new ImageInputError('image-scope', 'Image host is unavailable');
  }
}

function storedImage(row: Record<string, SQLOutputValue>): { attachment: ImageAttachment; bytes: Buffer } {
  try {
    const attachment = parseImageAttachment({ imageId: row.id, name: row.name, mediaType: row.media_type,
      byteLength: row.byte_length, width: row.width, height: row.height });
    if (!(row.payload instanceof Uint8Array) || row.payload.byteLength !== attachment.byteLength ||
      createHash('sha256').update(row.payload).digest('hex') !== row.digest) throw new Error('Integrity mismatch');
    return { attachment, bytes: Buffer.from(row.payload) };
  } catch {
    throw new ImageInputError('image-integrity', 'Stored image failed its integrity check');
  }
}

export function insertImage(db: DatabaseSync, scope: ConversationScope, uploader: string, upload: UploadId,
  verified: ReturnType<typeof verifyImageUpload>): ImageAttachment {
  requireScope(db, scope);
  const existing = db.prepare('SELECT * FROM images WHERE host=? AND conversation=? AND uploader=? AND upload=?')
    .get(scope.hostId, scope.conversationId, uploader, upload);
  if (existing) {
    const stored = storedImage(existing);
    if (stored.attachment.name !== verified.metadata.name || !stored.bytes.equals(verified.bytes)) {
      throw new ImageInputError('image-upload-conflict', 'This upload identity already belongs to a different image');
    }
    return stored.attachment;
  }
  const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(byte_length),0) AS bytes FROM images WHERE host=?').get(scope.hostId);
  if (!totals || typeof totals.count !== 'number' || typeof totals.bytes !== 'number') throw new ImageInputError('image-integrity', 'Image storage totals are unavailable');
  if (totals.count >= IMAGE_HOST_MAX_COUNT || totals.bytes + verified.bytes.length > IMAGE_HOST_MAX_BYTES) {
    throw new ImageInputError('image-capacity', 'This host has reached its retained image storage limit');
  }
  const attachment = { imageId: parseImageId(randomUUID()), ...verified.metadata };
  db.prepare('INSERT INTO images(id,host,conversation,uploader,upload,name,media_type,byte_length,width,height,digest,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(attachment.imageId, scope.hostId, scope.conversationId, uploader, upload, attachment.name, attachment.mediaType,
      attachment.byteLength, attachment.width, attachment.height, verified.digest, verified.bytes);
  return attachment;
}

export function readImage(db: DatabaseSync, scope: ConversationScope, imageId: ImageId): { attachment: ImageAttachment; bytes: Buffer } {
  requireScope(db, scope);
  const row = db.prepare('SELECT * FROM images WHERE host=? AND conversation=? AND id=?').get(scope.hostId, scope.conversationId, imageId);
  if (!row) throw new ImageInputError('image-scope', 'Image is unavailable in this conversation');
  return storedImage(row);
}

export function hasImage(db: DatabaseSync, scope: ConversationScope, imageId: ImageId): boolean {
  return !!db.prepare('SELECT 1 FROM images WHERE host=? AND conversation=? AND id=?').get(scope.hostId, scope.conversationId, imageId);
}
