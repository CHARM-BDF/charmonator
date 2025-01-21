// transcript-utils.mjs
// Server-side utility functions for working with transcripts and attachments

import { ImageAttachment, DocumentAttachment } from './transcript.mjs';
import { promises as fs } from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import path from 'path';

/**
 * Creates an appropriate attachment from a file
 */
export async function createAttachmentFromFile(filePath) {
  const fileData = await fs.readFile(filePath);
  const fileType = await fileTypeFromBuffer(fileData);
  
  // Handle images
  if (fileType?.mime?.startsWith('image/')) {
    const base64Data = fileData.toString('base64');
    const dataUrl = `data:${fileType.mime};base64,${base64Data}`;
    return new ImageAttachment(dataUrl);
  }
  
  // Handle text files
  const textExtensions = ['.txt', '.md', '.py', '.js', '.json', '.csv'];
  const ext = path.extname(filePath).toLowerCase();
  
  if (textExtensions.includes(ext)) {
    const content = fileData.toString('utf8');
    const filename = path.basename(filePath);
    return new DocumentAttachment(filename, content);
  }
  
  throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * Converts an image to a data URL
 */
export async function imageToDataUrl(imagePath) {
  const fileData = await fs.readFile(imagePath);
  const fileType = await fileTypeFromBuffer(fileData);
  
  if (!fileType?.mime?.startsWith('image/')) {
    throw new Error('Not a valid image file');
  }
  
  const base64Data = fileData.toString('base64');
  return `data:${fileType.mime};base64,${base64Data}`;
}

/**
 * Creates an image attachment from a data URL string
 */
export function imageAttachmentFromDataUrl(dataUrl) {
  return new ImageAttachment(dataUrl);
}

/**
 * Creates a document attachment from a text file
 */
export async function documentAttachmentFromFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const filename = path.basename(filePath);
  return new DocumentAttachment(filename, content);
}

/**
 * Parse a markdown file into a document attachment
 */
export async function documentAttachmentFromMarkdown(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const filename = path.basename(filePath);
  return new DocumentAttachment(filename, content);
}

/**
 * Write a document attachment to a file
 */
export async function writeDocumentAttachment(attachment, outputPath) {
  await fs.writeFile(outputPath, attachment.markdownContent);
}

/**
 * Write an image attachment to a file
 */
export async function writeImageAttachment(attachment, outputPath) {
  const match = attachment.imageUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL');
  }
  
  const data = Buffer.from(match[2], 'base64');
  await fs.writeFile(outputPath, data);
}